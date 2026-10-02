import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { bounded, cleanupSandboxes, execute, waitForStatus, WorkloadFailure } from "../src/sdk.mjs";

const config = {
  requestTimeoutMs: 20,
  lifecycleTimeoutMs: 40,
  pollIntervalMs: 1,
  cancellationGraceMs: 10,
  commandTimeoutSeconds: 0.01,
  cleanupAttempts: 2,
};
const never = () => new Promise(() => {});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function processSandbox(handle, start = async () => handle) {
  return { processes: { start } };
}

test("bounded returns results and propagates synchronous and asynchronous failures", async () => {
  assert.equal(await bounded(() => 42, 100), 42);
  const error = new Error("SDK failure");
  await assert.rejects(bounded(() => { throw error; }, 100), (caught) => caught === error);
  await assert.rejects(bounded(() => Promise.reject(error), 100), (caught) => caught === error);
});

test("bounded rejects invalid timeouts without invoking the operation", async () => {
  for (const timeout of [0, -1, NaN, Infinity]) {
    await assert.rejects(bounded(() => assert.fail("must not start"), timeout), /Invalid timeout/);
  }
});

test("bounded times out hanging calls and accepts a late rejection", async () => {
  const operation = deferred();
  await assert.rejects(bounded(() => operation.promise, 10, { label: "Request" }), /Request timed out/);
  operation.reject(new Error("late SDK rejection"));
  await sleep(0);
});

test("bounded honors pre-aborted and in-flight cancellation", async () => {
  const cancellation = new AbortController();
  const reason = new Error("cancelled");
  const started = deferred();
  const pending = bounded(() => { started.resolve(); return never(); }, 1000, { signal: cancellation.signal });
  await started.promise;
  cancellation.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(
    bounded(() => assert.fail("must not start"), 100, { signal: cancellation.signal }),
    (error) => error === reason,
  );
});

test("waitForStatus polls transitional states and rejects unexpected states", async () => {
  const sandbox = { id: "s", status: "pending", async refresh() { this.status = "running"; } };
  assert.equal(await waitForStatus(sandbox, ["running"], config), sandbox);
  await assert.rejects(waitForStatus(sandbox, ["stopped"], config), /expected stopped, got running/);
});

test("waitForStatus bounds hanging refresh and unchanged status", async () => {
  await assert.rejects(
    waitForStatus({ id: "s", status: "pending", refresh: never }, ["running"], config),
    /Refresh s timed out/,
  );
  await assert.rejects(
    waitForStatus({ id: "s", status: "pending", async refresh() {} }, ["running"], config),
    /timed out/,
  );
});

test("waitForStatus bounds polling sleep by lifecycle deadline", async () => {
  const sandbox = { id: "s", status: "pending", async refresh() {} };
  await assert.rejects(
    bounded(() => waitForStatus(sandbox, ["running"], { ...config, pollIntervalMs: 1000 }), 300),
    /Sandbox s timed out waiting/,
  );
});

test("waitForStatus cancels polling, hanging refresh, and already completed status", async () => {
  for (const status of ["pending", "running"]) {
    const cancellation = new AbortController();
    cancellation.abort(new Error("stop"));
    await assert.rejects(
      waitForStatus({ id: "s", status, refresh: never }, ["running"], config, cancellation.signal),
      /stop/,
    );
  }
  for (const polling of [true, false]) {
    const cancellation = new AbortController();
    const refreshing = deferred();
    const pending = waitForStatus({
      id: "s", status: "pending", refresh() { refreshing.resolve(); return never(); },
    }, ["running"], { ...config, pollIntervalMs: polling ? 1000 : 1 }, cancellation.signal);
    if (!polling) await refreshing.promise;
    cancellation.abort(new Error("stop"));
    await assert.rejects(pending, /stop|aborted/);
  }
});

test("cleanup stops before deleting and preserves supplied child-first order", async () => {
  const events = [];
  const sandboxes = ["child", "parent"].map((id) => ({
    id, status: "running",
    async refresh() { events.push(`refresh ${id}`); if (this.status === "stopping") this.status = "stopped"; },
    async stop(options) { assert.deepEqual(options, { wait: false }); events.push(`stop ${id}`); this.status = "stopping"; },
    async delete() { events.push(`delete ${id}`); },
  }));
  const reports = [];
  await cleanupSandboxes(sandboxes, config, (message) => reports.push(message));
  assert.deepEqual(events, [
    "refresh child", "stop child", "refresh child", "delete child",
    "refresh parent", "stop parent", "refresh parent", "delete parent",
  ]);
  assert.deepEqual(reports, ["Deleted child", "Deleted parent"]);
});

test("cleanup retries failures and continues after exhausted failures", async () => {
  const reports = [];
  let attempts = 0;
  let deleted = false;
  await assert.rejects(cleanupSandboxes([
    { id: "failed", refresh() { attempts += 1; throw Object.assign(new Error("denied"), { status: 403 }); } },
    { id: "next", status: "stopped", async refresh() {}, async delete() { deleted = true; } },
  ], config, (message) => reports.push(message)), /Cleanup incomplete; retry cleanup for: failed/);
  assert.equal(attempts, 2);
  assert.equal(deleted, true);
  assert.deepEqual(reports, ["Cleanup failed for failed: HTTP 403", "Deleted next"]);
  let retries = 0;
  await cleanupSandboxes([{
    id: "retry", status: "failed", async refresh() {},
    async delete() { if (++retries === 1) throw new Error("temporary"); },
  }], config);
  assert.equal(retries, 2);
});

test("cleanup treats HTTP 404 as idempotent at every SDK boundary", async () => {
  for (const boundary of ["refresh", "stop", "delete"]) {
    let calls = 0;
    const sandbox = { id: boundary, status: boundary === "stop" ? "running" : "stopped",
      async refresh() {}, async stop() {}, async delete() {} };
    sandbox[boundary] = async () => { calls += 1; throw Object.assign(new Error("missing"), { status: 404 }); };
    await cleanupSandboxes([sandbox], config);
    assert.equal(calls, 1);
  }
  await cleanupSandboxes([{
    id: "deleted", status: "deleted", async refresh() {},
    delete() { assert.fail("already deleted"); },
  }], config);
});

test("cleanup bounds hanging refresh, stop, delete, and lifecycle waits", async () => {
  for (const boundary of ["refresh", "stop", "delete", "lifecycle"]) {
    let stops = 0;
    const sandbox = {
      id: boundary, status: boundary === "delete" ? "stopped" : "running",
      async refresh() {}, async stop() { stops += 1; this.status = "stopping"; }, async delete() {},
    };
    if (boundary !== "lifecycle") sandbox[boundary] = never;
    await assert.rejects(cleanupSandboxes([sandbox], config), new RegExp(`retry cleanup for: ${boundary}`));
    if (boundary === "lifecycle") assert.equal(stops, 2);
  }
});

test("execute forwards command options without collecting output and explicitly disconnects", async () => {
  const events = [];
  const result = { status: "completed", exitCode: 0 };
  const onOutput = () => {};
  const env = { TEST: "value" };
  const handle = {
    async wait() { events.push("wait"); return result; },
    async disconnect() { events.push("disconnect"); },
    kill() { assert.fail("successful process must not be killed"); },
  };
  const sandbox = processSandbox(handle, async (command, options) => {
    assert.equal(command, "echo hello");
    assert.deepEqual(options, { env, onOutput, collectOutput: false, timeoutSeconds: config.commandTimeoutSeconds });
    events.push("start");
    return handle;
  });
  assert.equal(await execute(sandbox, "echo hello", config, { env, onOutput }), result);
  assert.deepEqual(events, ["start", "wait", "disconnect"]);
});

test("execute bounds hanging wait, kill, and disconnect", async () => {
  const events = [];
  const handle = {
    wait: never,
    kill() { events.push("kill"); return never(); },
    disconnect() { events.push("disconnect"); return never(); },
  };
  await assert.rejects(execute(processSandbox(handle), "hang", config), /Wait for process timed out/);
  assert.deepEqual(events, ["kill", "disconnect"]);
});

test("execute bounds disconnect after a successful wait and still kills", async () => {
  let kills = 0;
  let disconnects = 0;
  await assert.rejects(execute(processSandbox({
    async wait() { return { status: "completed", exitCode: 0 }; },
    async kill() { kills += 1; },
    disconnect() { disconnects += 1; return never(); },
  }), "command", config), /Disconnect process timed out/);
  assert.equal(kills, 1);
  assert.equal(disconnects, 2);
});

test("execute cancellation kills the remote process and disconnects", async () => {
  const cancellation = new AbortController();
  const waiting = deferred();
  const events = [];
  const pending = execute(processSandbox({
    wait() { waiting.resolve(); return never(); },
    async kill() { events.push("kill"); },
    async disconnect() { events.push("disconnect"); },
  }), "command", config, { signal: cancellation.signal });
  await waiting.promise;
  const reason = new Error("cancel command");
  cancellation.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.deepEqual(events, ["kill", "disconnect"]);
});

test("execute kills and disconnects late starts after timeout or cancellation", async () => {
  for (const cancel of [false, true]) {
    const start = deferred();
    const started = deferred();
    const disconnected = deferred();
    const cancellation = new AbortController();
    const events = [];
    const pending = execute(processSandbox(null, () => { started.resolve(); return start.promise; }),
      "command", config, { signal: cancellation.signal });
    await started.promise;
    if (cancel) cancellation.abort(new Error("cancel start"));
    await assert.rejects(pending, cancel ? /cancel start/ : /Start process timed out/);
    start.resolve({
      async kill() { events.push("kill"); },
      async disconnect() { events.push("disconnect"); disconnected.resolve(); },
      wait() { assert.fail("late process must not be awaited"); },
    });
    await bounded(() => disconnected.promise, 300);
    assert.deepEqual(events, ["kill", "disconnect"]);
  }
});

test("execute propagates start and wait failures and does not start after cancellation", async () => {
  const error = new Error("SDK failure");
  await assert.rejects(execute(processSandbox(null, () => { throw error; }), "command", config),
    (caught) => caught === error);
  const events = [];
  await assert.rejects(execute(processSandbox({
    async wait() { throw error; },
    async kill() { events.push("kill"); throw new Error("kill failed"); },
    async disconnect() { events.push("disconnect"); },
  }), "command", config), (caught) => caught === error);
  assert.deepEqual(events, ["kill", "disconnect"]);
  const cancellation = new AbortController();
  cancellation.abort(error);
  await assert.rejects(execute(processSandbox(null, () => assert.fail("must not start")),
    "command", config, { signal: cancellation.signal }), (caught) => caught === error);
});

test("WorkloadFailure preserves valid exit codes and defaults invalid or missing codes", () => {
  for (const exitCode of [1, 42, 255]) {
    const error = new WorkloadFailure("workload", { status: "failed", exitCode });
    assert.ok(error instanceof Error);
    assert.equal(error.exitCode, exitCode);
    assert.equal(error.message, `workload: failed, exit code ${exitCode}`);
  }
  for (const exitCode of [undefined, null, 0, -1, 256]) {
    assert.equal(new WorkloadFailure("workload", { status: "failed", exitCode }).exitCode, 1);
  }
});
