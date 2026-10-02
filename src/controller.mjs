import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bounded, cleanupSandboxes, execute, waitForStatus, WorkloadFailure } from "./sdk.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function belongsToRun(runner, config) {
  const suffix = runner.name?.slice(config.prefix.length + 1);
  return runner.name?.startsWith(`${config.prefix}-`) && /^[a-f0-9]{12}$/.test(suffix) &&
    runner.labels?.some((label) => label.name === runner.name);
}

export async function cleanupNative(client, github, config, report = () => {}) {
  const errors = [];
  try {
    const runners = await bounded(() => github.listRunners(), config.requestTimeoutMs, { label: "List native runners" });
    for (const runner of runners.filter((item) => belongsToRun(item, config))) {
      try {
        await bounded(() => github.deleteRunner(String(runner.id)), config.requestTimeoutMs, { label: "Delete native runner" });
        report(`Removed GitHub runner ${runner.name}`);
      } catch (error) {
        if (error.status !== 404) errors.push(error);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    const sandboxes = await bounded(() => client.sandboxes.list(), config.requestTimeoutMs, { label: "List native sandboxes" });
    const stages = ["runner", "template", "retained-template"];
    const selected = stages.flatMap((stage) =>
      sandboxes.filter((sandbox) => sandbox.name === `${config.prefix}-${stage}` &&
        sandbox.id !== config.reuseTemplateId &&
        !(stage === "retained-template" && config.retainTemplate && sandbox.status === "stopped")));
    await cleanupSandboxes(selected, config, report);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new Error("Native cleanup incomplete; retry cleanup for this run attempt");
}

export async function waitForRunner(github, name, config, signal) {
  const deadline = Date.now() + config.lifecycleTimeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const runners = await bounded(() => github.listRunners(),
      Math.min(config.requestTimeoutMs, Math.max(1, deadline - Date.now())), { signal, label: "Check runner readiness" });
    const runner = runners.find((item) => item.name === name);
    if (runner?.status === "online" && !runner.busy) {
      const labels = new Set((runner.labels || []).map((label) => label.name.toLowerCase()));
      if (![name, "self-hosted", "linux", "x64"].every((label) => labels.has(label.toLowerCase()))) {
        throw new Error("Registered runner does not have the required routing labels");
      }
      if (runner.ephemeral === false) throw new Error("Runner is not ephemeral");
      return runner;
    }
    await sleep(Math.min(config.pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error("GitHub runner did not become online before the readiness deadline");
}

export async function provisionNative(client, github, config, {
  signal, onOutput = () => {}, report = () => {}, mask = () => {},
} = {}) {
  await mkdir(config.outputDirectory, { recursive: true });
  const began = performance.now();
  const mode = config.warmCommand ? "warm" : "tools";
  const state = {
    repository: config.repository, sha: config.sha, mode, prefix: config.prefix,
    runnerName: `${config.prefix}-${randomBytes(6).toString("hex")}`,
    templateId: null, sandboxId: null, timings: {},
    templateReused: Boolean(config.reuseTemplateId), templateRetained: false,
  };
  const save = () => writeFile(resolve(config.outputDirectory, "native-provision.json"), `${JSON.stringify(state, null, 2)}\n`);
  const timed = async (name, operation) => {
    signal?.throwIfAborted();
    const start = performance.now();
    try {
      return await operation();
    } finally {
      state.timings[name] = (performance.now() - start) / 1000;
      await save();
    }
  };
  const guestEnv = {
    ...config.guestEnv,
    ARCHIL_CI_WORKSPACE: config.workspace,
    ARCHIL_CI_CACHE_ROOT: config.cacheRoot,
    ARCHIL_CI_RUNNER_ROOT: config.runnerRoot,
  };
  const run = async (sandbox, phase, command, env = guestEnv, output = onOutput) => {
    const result = await execute(sandbox, command, config, { signal, onOutput: output, env });
    if (result.status !== "completed" || result.exitCode !== 0) throw new WorkloadFailure(phase, result);
  };
  const upload = async (sandbox, local, remote) => {
    const source = createReadStream(local);
    try {
      await bounded(() => sandbox.files.uploadFile(source, remote, { mode: 0o600 }),
        config.lifecycleTimeoutMs, { signal, label: "Transfer native file" });
    } finally {
      source.destroy();
    }
  };
  const create = async (operation, label) => {
    const pending = Promise.resolve().then(operation);
    config.pendingOperations?.track(pending);
    try {
      return await bounded(() => pending, config.lifecycleTimeoutMs, { signal, label });
    } catch (error) {
      // The SDK cannot abort creation; reap resources that arrive after cancellation.
      const cleanup = pending.then((sandbox) => cleanupSandboxes([sandbox], config, report)).catch(() => {});
      config.pendingOperations?.track(cleanup);
      throw error;
    }
  };
  let handedOff = false;
  let failure;
  let template;
  try {
    await save();
    if (config.reuseTemplateId) {
      template = await timed("getTemplate", () => bounded(
        () => client.sandboxes.get(config.reuseTemplateId), config.requestTimeoutMs,
        { signal, label: "Get reusable template" }));
      if (template.status !== "stopped") throw new Error("Reusable template must be stopped");
      if (template.vcpuCount !== config.vcpuCount || template.memSizeMiB !== config.memSizeMiB) {
        throw new Error("Reusable template CPU/memory does not match the requested shape");
      }
      if (template.idleTtlSeconds !== 0 || template.maxConcurrentExecs !== 1 ||
          template.maxTtlSeconds < Math.ceil(config.watchdogTimeoutMs / 1000)) {
        throw new Error("Reusable template lifetime/execution policy is incompatible");
      }
      state.templateId = template.id;
      state.templateRetained = true;
    } else {
      template = await timed("createTemplate", async () => {
        const sandbox = await create(() => client.sandboxes.create({
          name: `${config.prefix}-${config.retainTemplate ? "retained-template" : "template"}`, baseImage: config.baseImage,
          vcpuCount: config.vcpuCount, memSizeMiB: config.memSizeMiB,
          maxTtlSeconds: config.maxTtlSeconds, idleTtlSeconds: 0, maxConcurrentExecs: 1,
          network: { egress: { default: "allow" } },
        }, { wait: false }), "Create native template");
        state.templateId = sandbox.id;
        await save();
        return waitForStatus(sandbox, ["running"], config, signal);
      });
      await timed("transferSource", async () => {
        await run(template, "create workspace", `mkdir -p ${quote(config.workspace)} ${quote(config.cacheRoot)}`);
        await upload(template, config.archivePath, "/workspace/native-source.tar");
        await run(template, "unpack source",
          `tar -xf /workspace/native-source.tar -C ${quote(config.workspace)} && rm /workspace/native-source.tar`);
        await upload(template, config.guestScriptPath, "/workspace/archil-ci-guest.sh");
      });
      const setup = (command) => `cd ${quote(config.workspace)} && bash -lc ${quote(command)}`;
      await timed("installRunner", () => run(template, "install runner", "bash /workspace/archil-ci-guest.sh install"));
      if (config.bootstrapCommand) {
        await timed("bootstrap", () => run(template, "bootstrap", setup(config.bootstrapCommand)));
      }
      if (config.warmCommand) {
        await timed("warm", () => run(template, "warm", setup(config.warmCommand)));
      }
      await run(template, "cache ownership", `chown -R runner:runner -- ${quote(config.workspace)} ${quote(config.cacheRoot)}`);
      await timed("writeTemplateMarker", async () => {
        const marker = {
          schemaVersion: 1, repository: config.repository, cacheRoot: config.cacheRoot,
          workspace: config.workspace, cacheMode: mode,
        };
        await bounded(() => template.files.uploadFile(Buffer.from(JSON.stringify(marker)),
          "/workspace/archil-ci-template.json", { mode: 0o600 }),
          config.requestTimeoutMs, { signal, label: "Write template marker" });
      });
      await timed("stopTemplate", async () => {
        await bounded(() => template.stop({ wait: false }), config.requestTimeoutMs, { signal, label: "Stop native template" });
        await waitForStatus(template, ["stopped"], config, signal);
      });
    }
    const child = await timed("forkRunner", async () => {
      const sandbox = await create(() => template.fork({ name: `${config.prefix}-runner`, wait: false }), "Fork native runner");
      state.sandboxId = sandbox.id;
      await save();
      return waitForStatus(sandbox, ["running"], config, signal);
    });
    state.resourceShape = {
      vcpus: child.vcpuCount, memoryMiB: child.memSizeMiB, image: child.baseImage,
      idleTtlSeconds: child.idleTtlSeconds, maxTtlSeconds: child.maxTtlSeconds,
    };
    await timed("validateTemplateMarker", async () => {
      const contents = Buffer.alloc(4096);
      let size = 0;
      await bounded(() => child.files.downloadFile("/workspace/archil-ci-template.json", async (chunk) => {
        if (size + chunk.byteLength > contents.length) throw new Error("Template marker exceeds 4 KiB");
        contents.set(chunk, size);
        size += chunk.byteLength;
      }), config.requestTimeoutMs, { signal, label: "Read template marker" });
      let marker;
      try {
        marker = JSON.parse(contents.subarray(0, size).toString("utf8"));
      } catch {
        throw new Error("Invalid template marker");
      }
      if (!marker || marker.schemaVersion !== 1 || marker.repository !== config.repository ||
          marker.cacheRoot !== config.cacheRoot || marker.workspace !== config.workspace ||
          !["warm", "tools"].includes(marker.cacheMode)) {
        throw new Error("Incompatible template marker");
      }
      state.mode = marker.cacheMode;
    });
    const runnerCommand = (phase) =>
      `runuser --user runner --preserve-environment -- bash ${quote(`${config.runnerRoot}/runner-guest.sh`)} ${phase}`;
    await timed("registerRunner", async () => {
      const token = await bounded(() => github.createRegistrationToken(), config.requestTimeoutMs, { signal, label: "Create runner registration token" });
      mask(token);
      await run(child, "register runner", runnerCommand("register"), {
        ...guestEnv, HOME: "/home/runner", GITHUB_REPOSITORY: config.repository,
        ARCHIL_CI_RUNNER_NAME: state.runnerName, ARCHIL_CI_RUNNER_LABEL: state.runnerName,
        GH_RUNNER_REGISTRATION_TOKEN: token,
      }, () => {});
    });
    await timed("startRunner", async () => {
      const starting = Promise.resolve().then(() => child.processes.start(runnerCommand("start"), {
        env: { ...guestEnv, HOME: "/home/runner" },
        timeoutSeconds: config.maxTtlSeconds, collectOutput: false,
      }));
      config.pendingOperations?.track(starting);
      let listener;
      try {
        listener = await bounded(() => starting, config.requestTimeoutMs, { signal, label: "Start runner listener" });
      } catch (error) {
        const cleanup = starting.then(async (late) => {
          await bounded(() => late.kill(), config.cancellationGraceMs);
          await bounded(() => late.disconnect(), config.cancellationGraceMs);
        }).catch(() => {});
        config.pendingOperations?.track(cleanup);
        throw error;
      }
      state.listenerProcessId = listener.id;
      await bounded(() => listener.disconnect(), config.cancellationGraceMs, { signal, label: "Detach runner listener" });
    });
    const runner = await timed("waitForGitHub", () => waitForRunner(github, state.runnerName, config, signal));
    state.runnerId = runner.id;
    state.runnerLabel = state.runnerName;
    state.templateRetained = Boolean(config.reuseTemplateId || config.retainTemplate);
    state.totalProvisionSeconds = (performance.now() - began) / 1000;
    await save();
    if (config.outputPath) {
      await appendFile(config.outputPath, [
        `runner_label=${state.runnerLabel}`, `runner_name=${state.runnerName}`,
        `sandbox_id=${state.sandboxId}`, `template_id=${state.templateId}`, `cache_mode=${state.mode}`,
        `template_retained=${state.templateRetained}`,
        `cache_root=${config.cacheRoot}`, `workspace=${config.workspace}`, "",
      ].join("\n"));
    }
    handedOff = true;
    report(`GitHub runner online: ${state.runnerName}`);
    return state;
  } catch (error) {
    failure = error;
    state.templateRetained = Boolean(config.reuseTemplateId && state.templateId);
    state.error = error instanceof WorkloadFailure ? error.message : "Native provisioning failed; inspect workflow logs";
    await save().catch(() => {});
    throw error;
  } finally {
    if (!handedOff) {
      try {
        await cleanupNative(client, github, {
          ...config, retainTemplate: false,
        }, report);
      } catch (error) {
        state.cleanupError = error.message;
        await save().catch(() => {});
        report(error.message);
        if (!failure) throw error;
      }
    }
  }
}

export async function watchNative(client, admin, actions, config, { signal, report = () => {} } = {}) {
  const began = Date.now();
  let started = false;
  let failure;
  const call = (operation, label) => bounded(operation, config.requestTimeoutMs, { signal, label });
  try {
    while (Date.now() - began < config.watchdogTimeoutMs) {
      signal?.throwIfAborted();
      const run = await call(() => actions.getRun(config.runId), "Observe Actions run");
      if (Number(run.run_attempt) !== Number(config.attempt) || run.status === "completed") return;
      const jobs = await call(() => actions.listRunJobs(config.runId, config.attempt), "Observe Actions jobs");
      const native = jobs.find((job) => job.name === config.nativeJobName);
      if (["in_progress", "completed"].includes(native?.status) && native.conclusion !== "skipped") {
        if (!native.labels?.includes(config.expectedRunnerLabel) || native.runner_name !== config.expectedRunnerName) {
          throw new Error("Native job was routed to an unexpected runner");
        }
        if (!started) report(`Native Actions job claimed by ${native.runner_name}`);
        started = true;
      }
      if (native?.status === "completed") return;
      if (!started && Date.now() - began >= config.queueTimeoutMs) break;
      await sleep(config.watchdogPollMs, undefined, { signal });
    }
  } catch (error) {
    failure = error;
  }
  let cleanupError;
  try {
    await cleanupNative(client, admin, config, report);
  } catch (error) {
    cleanupError = error;
    report(error.message);
  }
  // GitHub cancellation has no attempt selector: this recheck narrows, but cannot eliminate, the read/cancel race.
  const run = await bounded(() => actions.getRun(config.runId), config.requestTimeoutMs, { label: "Recheck Actions attempt" });
  if (Number(run.run_attempt) !== Number(config.attempt) || run.status === "completed") return;
  await bounded(() => actions.cancelRun(config.runId), config.requestTimeoutMs, { label: "Cancel Actions run" });
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
  throw new Error(started ? "Native job exceeded watchdog deadline" : "Native runner never claimed its Actions job");
}
