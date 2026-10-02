import { setTimeout as sleep } from "node:timers/promises";

export function createPendingOperations() {
  const pending = new Set();
  return {
    track(operation) {
      const promise = Promise.resolve(operation);
      pending.add(promise);
      promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    },
    get size() { return pending.size; },
    async drain(graceMs) {
      const deadline = Date.now() + graceMs;
      while (pending.size && Date.now() < deadline) {
        try {
          await bounded(() => Promise.allSettled([...pending]), Math.max(1, deadline - Date.now()), {
            label: "Drain pending SDK operations",
          });
        } catch {
          break;
        }
      }
      return { pending: pending.size, timedOut: pending.size > 0 };
    },
  };
}

export async function bounded(operation, timeoutMs, { signal, label = "SDK operation" } = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout for ${label}`);
  }
  let timer;
  let cancel;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    cancel = () => reject(signal.reason);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try {
    // The SDK has no request AbortSignal; callers must handle late resources.
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function waitForStatus(sandbox, expected, config, signal) {
  const deadline = Date.now() + config.lifecycleTimeoutMs;
  while (!expected.includes(sandbox.status)) {
    signal?.throwIfAborted();
    if (!["pending", "stopping", "pausing", "deleting"].includes(sandbox.status)) {
      throw new Error(`Sandbox ${sandbox.id}: expected ${expected.join("/")}, got ${sandbox.status}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Sandbox ${sandbox.id} timed out waiting for ${expected.join("/")}`);
    }
    await sleep(Math.min(config.pollIntervalMs, remaining), undefined, { signal });
    if (Date.now() >= deadline) {
      throw new Error(`Sandbox ${sandbox.id} timed out waiting for ${expected.join("/")}`);
    }
    await bounded(() => sandbox.refresh(), Math.min(config.requestTimeoutMs, Math.max(1, deadline - Date.now())), {
      signal, label: `Refresh ${sandbox.id}`,
    });
  }
  signal?.throwIfAborted();
  return sandbox;
}

// The caller supplies child-first order; complete each deletion before its parent.
export async function cleanupSandboxes(sandboxes, config, report = () => {}) {
  const failures = [];
  for (const sandbox of sandboxes) {
    for (let attempt = 1; attempt <= config.cleanupAttempts; attempt += 1) {
      try {
        await bounded(() => sandbox.refresh(), config.requestTimeoutMs, { label: `Refresh ${sandbox.id}` });
        if (sandbox.status !== "deleted") {
          if (!["stopped", "exited", "failed"].includes(sandbox.status)) {
            await bounded(() => sandbox.stop({ wait: false }), config.requestTimeoutMs, { label: `Stop ${sandbox.id}` });
            await waitForStatus(sandbox, ["stopped", "exited", "failed"], config);
          }
          await bounded(() => sandbox.delete(), config.requestTimeoutMs, { label: `Delete ${sandbox.id}` });
        }
        report(`Deleted ${sandbox.id}`);
        break;
      } catch (error) {
        if (error.status === 404) {
          break;
        }
        if (attempt === config.cleanupAttempts) {
          failures.push(sandbox.id);
          report(`Cleanup failed for ${sandbox.id}: HTTP ${error.status || "unknown"}`);
        } else {
          await sleep(config.pollIntervalMs);
        }
      }
    }
  }
  if (failures.length) {
    throw new Error(`Cleanup incomplete; retry cleanup for: ${failures.join(", ")}`);
  }
}

export class WorkloadFailure extends Error {
  constructor(stage, result) {
    super(`${stage}: ${result.status}, exit code ${result.exitCode ?? "unknown"}`);
    this.exitCode = result.exitCode > 0 && result.exitCode < 256 ? result.exitCode : 1;
  }
}

async function terminateProcess(handle, config) {
  await bounded(() => handle.kill(), config.cancellationGraceMs, { label: "Kill process" }).catch(() => {
    console.error("Remote kill failed; proceeding to sandbox cleanup");
  });
  await bounded(() => handle.disconnect(), config.cancellationGraceMs, { label: "Disconnect process" }).catch(() => {});
}

export async function execute(sandbox, command, config, { signal, onOutput, env } = {}) {
  signal?.throwIfAborted();
  const starting = Promise.resolve().then(() => sandbox.processes.start(command, {
    env,
    timeoutSeconds: config.commandTimeoutSeconds,
    onOutput,
    collectOutput: false,
  }));
  config.pendingOperations?.track(starting);
  let handle;
  try {
    handle = await bounded(() => starting, config.requestTimeoutMs, { signal, label: "Start process" });
  } catch (error) {
    const cleanup = starting.then((lateHandle) => terminateProcess(lateHandle, config)).catch(() => {});
    config.pendingOperations?.track(cleanup);
    throw error;
  }
  try {
    const result = await bounded(() => handle.wait(), config.commandTimeoutSeconds * 1000 + config.requestTimeoutMs, {
      signal, label: "Wait for process",
    });
    await bounded(() => handle.disconnect(), config.cancellationGraceMs, { signal, label: "Disconnect process" });
    return result;
  } catch (error) {
    // A detached SDK session leaves the command running unless explicitly killed.
    await terminateProcess(handle, config);
    throw error;
  }
}
