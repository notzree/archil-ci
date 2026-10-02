import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { cleanupNative, provisionNative, waitForRunner, watchNative } from "../src/controller.mjs";
import { WorkloadFailure } from "../src/sdk.mjs";

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "archil-controller-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    prefix: "native-1-2", repository: "example/web", runId: "1", attempt: "2", sha: "abc",
    baseImage: "base", vcpuCount: 4, memSizeMiB: 8192,
    requestTimeoutMs: 100, lifecycleTimeoutMs: 100, pollIntervalMs: 1,
    cancellationGraceMs: 100, commandTimeoutSeconds: 1, cleanupAttempts: 1,
    maxTtlSeconds: 7200, queueTimeoutMs: 2, watchdogTimeoutMs: 100, watchdogPollMs: 1,
    nativeJobName: "Browser tests", workspace: "/workspace/actions/web/web", cacheRoot: "/workspace/cache",
    runnerRoot: "/opt/archil-actions-runner", archivePath: join(directory, "source.tar"),
    guestScriptPath: join(directory, "helper.sh"), outputDirectory: directory, outputPath: join(directory, "outputs"),
    bootstrapCommand: "npm ci", warmCommand: "npm run build",
    guestEnv: { NPM_CONFIG_CACHE: "/workspace/cache/npm", HOME: "/root" },
    expectedRunnerName: "native-1-2-012345abcdef", expectedRunnerLabel: "native-1-2-012345abcdef",
    // Controller must not copy unrelated host configuration into the guest.
    apiKey: "archil-host-secret", adminToken: "github-admin-secret",
    ...overrides,
  };
  await writeFile(config.archivePath, "consumer-source-only");
  await writeFile(config.guestScriptPath, "reusable-helper");
  const events = [];
  const commands = [];
  const uploads = [];
  const runners = [];
  const sandboxes = [];
  const downloads = [];
  let result = { status: "completed", exitCode: 0 };
  let cleanupFailure = false;
  const sandbox = (stage) => {
    const item = {
      id: stage, name: `${config.prefix}-${stage}`, status: "running",
      vcpuCount: config.vcpuCount, memSizeMiB: config.memSizeMiB, baseImage: config.baseImage,
      idleTtlSeconds: 0, maxConcurrentExecs: 1, maxTtlSeconds: config.maxTtlSeconds,
      marker: undefined, registered: false,
      refresh: async () => { events.push(`refresh:${stage}`); },
      stop: async () => { events.push(`stop:${stage}`); item.status = "stopped"; },
      delete: async () => {
        events.push(`delete:${stage}`);
        if (cleanupFailure) throw new Error("cleanup failed");
        item.status = "deleted";
      },
      fork: async ({ name }) => {
        assert.equal(item.status, "stopped");
        assert.equal(item.registered, false);
        assert.equal(name, `${config.prefix}-runner`);
        events.push("fork");
        const child = sandbox("runner");
        child.marker = item.marker;
        sandboxes.push(child);
        return child;
      },
      files: { uploadFile: async (source, remote, options) => {
        let contents = "";
        if (Buffer.isBuffer(source)) contents = source.toString("utf8");
        else for await (const chunk of source) contents += chunk;
        uploads.push({ stage, remote, contents, options });
        if (remote === "/workspace/archil-ci-template.json") item.marker = Buffer.from(contents);
      },
      downloadFile: async (remote, writer) => {
        assert.equal(item.status, "running");
        assert.equal(stage, "runner");
        assert.equal(remote, "/workspace/archil-ci-template.json");
        events.push("read-marker");
        downloads.push(remote);
        if (!item.marker) throw new Error("Missing template marker");
        for (let offset = 0; offset < item.marker.length; offset += 1024) {
          await writer(item.marker.subarray(offset, offset + 1024));
        }
      } },
      processes: { start: async (command, options) => {
        events.push(`command:${stage}:${command}`);
        commands.push({ stage, command, ...options });
        if (command.endsWith(" register")) {
          if (item.registered) throw new Error("Guest already registered");
          item.registered = true;
          const name = options.env.ARCHIL_CI_RUNNER_NAME;
          runners.push({
            id: 5, name, status: "online", busy: false, ephemeral: true,
            labels: [name, "self-hosted", "linux", "x64"].map((name) => ({ name })),
          });
        }
        return {
          id: "listener", wait: async () => result,
          kill: async () => events.push("kill"),
          disconnect: async () => events.push("disconnect"),
        };
      } },
    };
    return item;
  };
  const client = { sandboxes: {
    create: async (options) => {
      events.push("create");
      assert.equal(options.name, `${config.prefix}-${config.retainTemplate ? "retained-template" : "template"}`);
      const template = sandbox("template");
      template.name = options.name;
      sandboxes.push(template);
      return template;
    },
    get: async (id) => {
      events.push("get-template");
      const item = sandboxes.find((item) => item.id === id);
      if (!item) throw new Error("Template not found");
      return item;
    },
    list: async () => { events.push("list-sandboxes"); return sandboxes; },
  } };
  const github = {
    listRunners: async () => { events.push("list-runners"); return runners; },
    createRegistrationToken: async () => { events.push("token"); return "short-lived-registration-secret"; },
    deleteRunner: async (id) => {
      events.push(`delete-github:${id}`);
      const index = runners.findIndex((runner) => String(runner.id) === id);
      if (index >= 0) runners.splice(index, 1);
    },
  };
  return { config, client, github, events, commands, uploads, downloads, runners, sandboxes, sandbox,
    failWorkload: () => { result = { status: "completed", exitCode: 23 }; },
    failCleanup: () => { cleanupFailure = true; },
  };
}

test("non-Rust consumer provisions from separate source/helper with env and one unregistered snapshot", async (t) => {
  const f = await fixture(t);
  const masks = [];
  const state = await provisionNative(f.client, f.github, f.config, { mask: (token) => masks.push(token) });
  assert.equal(state.mode, "warm");
  assert.equal(state.runnerLabel, state.runnerName);
  assert.deepEqual(f.uploads.slice(0, 2).map(({ remote, contents }) => [remote, contents]), [
    ["/workspace/native-source.tar", "consumer-source-only"], ["/workspace/archil-ci-guest.sh", "reusable-helper"],
  ]);
  assert.deepEqual(JSON.parse(f.uploads[2].contents), {
    schemaVersion: 1, repository: f.config.repository, cacheRoot: f.config.cacheRoot,
    workspace: f.config.workspace, cacheMode: "warm",
  });
  assert.ok(f.events.indexOf("read-marker") < f.events.indexOf("token"));
  assert.equal(f.events.filter((event) => event === "fork").length, 1);
  assert.ok(f.events.indexOf("stop:template") < f.events.indexOf("fork"));
  assert.ok(f.events.indexOf("fork") < f.events.indexOf("token"));
  const bootstrap = f.commands.find(({ command }) => command.includes("npm ci"));
  const warm = f.commands.find(({ command }) => command.includes("npm run build"));
  assert.equal(bootstrap.stage, "template");
  assert.ok(f.commands.findIndex(({ command }) => command.endsWith(" install")) < f.commands.indexOf(bootstrap));
  assert.ok(f.commands.indexOf(warm) < f.commands.findIndex(({ command }) => command.startsWith("chown")));
  assert.equal(bootstrap.command, "cd '/workspace/actions/web/web' && bash -lc 'npm ci'");
  assert.ok(f.commands.some(({ stage, command }) => stage === "template" && command === "bash /workspace/archil-ci-guest.sh install"));
  const registration = f.commands.find(({ command }) => command.endsWith(" register"));
  const listener = f.commands.find(({ command }) => command.endsWith(" start"));
  assert.equal(registration.stage, "runner");
  assert.match(registration.command, /^runuser --user runner --preserve-environment -- bash '\/opt\/archil-actions-runner\/runner-guest.sh' register$/);
  assert.equal(listener.env.HOME, "/home/runner");
  assert.equal(registration.env.HOME, "/home/runner");
  assert.equal(registration.env.GH_RUNNER_REGISTRATION_TOKEN, masks[0]);
  assert.deepEqual(masks, ["short-lived-registration-secret"]);
  for (const entry of f.commands) {
    assert.equal(entry.env.NPM_CONFIG_CACHE, f.config.guestEnv.NPM_CONFIG_CACHE);
    assert.equal(entry.env.ARCHIL_CI_CACHE_ROOT, f.config.cacheRoot);
    assert.equal(entry.env.ARCHIL_CI_WORKSPACE, f.config.workspace);
    assert.equal(entry.env.ARCHIL_API_KEY, undefined);
    assert.equal(entry.env.GH_RUNNER_ADMIN_TOKEN, undefined);
    assert.equal(entry.env.CARGO_HOME, undefined);
    assert.equal(entry.env.RUSTUP_HOME, undefined);
    assert.equal(entry.env.PATH, undefined);
    if (entry !== registration) assert.equal(entry.env.GH_RUNNER_REGISTRATION_TOKEN, undefined);
  }
  const metadata = await readFile(join(f.config.outputDirectory, "native-provision.json"), "utf8");
  for (const value of ["secret", "npm ci", "npm run build", "NPM_CONFIG_CACHE"]) assert.ok(!metadata.includes(value));
  const outputs = await readFile(f.config.outputPath, "utf8");
  assert.match(outputs, /cache_mode=warm/);
  assert.ok(outputs.includes(`cache_root=${f.config.cacheRoot}`));
  assert.ok(outputs.includes(`workspace=${f.config.workspace}`));
  assert.ok(!f.events.some((event) => event.startsWith("delete:")));
});

test("setup quoting preserves apostrophes and shell metacharacters without adding a workload", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "archil-quote-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, {
    workspace: directory, bootstrapCommand: "printf '%s' \"consumer's $TEST_VALUE\"",
    warmCommand: "", guestEnv: { TEST_VALUE: "value; not a command" },
  });
  const state = await provisionNative(f.client, f.github, f.config);
  const setup = f.commands.find(({ command }) => command.includes("bash -lc"));
  assert.equal(execFileSync("bash", ["-c", setup.command], { env: { ...process.env, ...setup.env }, encoding: "utf8" }),
    "consumer's value; not a command");
  assert.equal(state.mode, "tools");
  assert.equal(f.commands.filter(({ command }) => command.includes("bash -lc")).length, 1);
});

function reusableSource(f, marker = {}) {
  const source = f.sandbox("external");
  source.id = f.config.reuseTemplateId;
  source.name = "native-previous-attempt-template";
  source.status = "stopped";
  source.marker = Buffer.from(JSON.stringify({
    schemaVersion: 1, repository: f.config.repository, cacheRoot: f.config.cacheRoot,
    workspace: f.config.workspace, cacheMode: "tools", ...marker,
  }));
  f.sandboxes.push(source);
  return source;
}

test("reuse rejects incompatible inherited resource and lifetime settings before fork", async (t) => {
  for (const [key, value] of [
    ["vcpuCount", 1], ["memSizeMiB", 256], ["idleTtlSeconds", 60],
    ["maxConcurrentExecs", 2], ["maxTtlSeconds", 0],
  ]) {
    const f = await fixture(t, { reuseTemplateId: `external-${key}` });
    const source = reusableSource(f);
    source[key] = value;
    await assert.rejects(provisionNative(f.client, f.github, f.config), /requested shape|policy is incompatible/);
    assert.ok(!f.events.includes("fork"));
    assert.equal(source.status, "stopped");
    assert.ok(!f.events.some((event) => event === "stop:external" || event === "delete:external"));
  }
});

test("retained template stays stopped and unregistered after normal cleanup", async (t) => {
  const f = await fixture(t, { retainTemplate: true });
  const state = await provisionNative(f.client, f.github, f.config);
  await cleanupNative(f.client, f.github, f.config);
  const source = f.sandboxes[0];
  assert.equal(source.status, "stopped");
  assert.equal(source.registered, false);
  assert.equal(f.sandboxes[1].status, "deleted");
  assert.equal(f.runners.length, 0);
  assert.equal(state.templateRetained, true);
  assert.equal(state.templateReused, false);
  assert.match(await readFile(f.config.outputPath, "utf8"), /template_retained=true/);
  assert.ok(f.events.indexOf("stop:template") < f.events.indexOf("fork"));
});

for (const retainTemplate of [false, true]) {
  test(`reuse never mutates source and honors marker cache mode (retain=${retainTemplate})`, async (t) => {
    const f = await fixture(t, { reuseTemplateId: "external-id", retainTemplate });
    const source = reusableSource(f);
    const state = await provisionNative(f.client, f.github, f.config);
    await cleanupNative(f.client, f.github, f.config);
    assert.equal(source.status, "stopped");
    assert.equal(source.registered, false);
    assert.equal(f.sandboxes[1].status, "deleted");
    assert.equal(f.runners.length, 0);
    assert.equal(f.uploads.length, 0);
    assert.ok(f.commands.every(({ stage }) => stage === "runner"));
    assert.ok(!f.events.includes("create"));
    assert.ok(!f.events.includes("stop:external"));
    assert.ok(!f.events.includes("delete:external"));
    assert.equal(state.mode, "tools");
    assert.equal(state.templateReused, true);
    assert.equal(state.templateRetained, true);
    assert.match(await readFile(f.config.outputPath, "utf8"), /cache_mode=tools/);
  });
}

for (const status of ["running", "pending", "stopping"]) {
  test(`reuse rejects ${status} source without touching it`, async (t) => {
    const f = await fixture(t, { reuseTemplateId: "external-id" });
    const source = reusableSource(f);
    source.status = status;
    await assert.rejects(provisionNative(f.client, f.github, f.config), /must be stopped/);
    assert.equal(source.status, status);
    assert.ok(!f.events.includes("fork"));
    assert.ok(!f.events.includes("stop:external"));
    assert.ok(!f.events.includes("delete:external"));
  });
}

for (const [name, marker] of [
  ["foreign repository", { repository: "foreign/repo" }],
  ["foreign cache root", { cacheRoot: "/foreign" }],
  ["foreign workspace", { workspace: "/foreign" }],
  ["unsupported schema", { schemaVersion: 2 }],
  ["invalid cache mode", { cacheMode: "unknown" }],
  ["null", null], ["corrupt", "not json"], ["oversized", Buffer.alloc(4097)],
  ["missing", undefined],
]) {
  test(`reuse rejects ${name} marker before registration and preserves source`, async (t) => {
    const f = await fixture(t, { reuseTemplateId: "external-id" });
    const source = reusableSource(f, typeof marker === "object" ? marker : {});
    if (marker === null) source.marker = Buffer.from("null");
    if (typeof marker === "string" || Buffer.isBuffer(marker)) source.marker = Buffer.from(marker);
    if (marker === undefined) source.marker = undefined;
    await assert.rejects(provisionNative(f.client, f.github, f.config), /marker/i);
    assert.equal(source.status, "stopped");
    assert.equal(f.sandboxes[1].status, "deleted");
    assert.ok(!f.events.includes("token"));
    assert.ok(!f.events.includes("delete:external"));
  });
}

test("marker limit allows exactly 4 KiB", async (t) => {
  const f = await fixture(t, { reuseTemplateId: "external-id" });
  const source = reusableSource(f);
  source.marker = Buffer.from(source.marker.toString().padEnd(4096));
  await provisionNative(f.client, f.github, f.config);
});

for (const phase of ["bootstrap", "marker", "stop"]) {
  test(`incomplete new template is deleted despite retention on ${phase} failure`, async (t) => {
    const f = await fixture(t, { retainTemplate: true });
    const create = f.client.sandboxes.create;
    f.client.sandboxes.create = async (...args) => {
      const source = await create(...args);
      if (phase === "bootstrap") f.failWorkload();
      if (phase === "marker") {
        const upload = source.files.uploadFile;
        source.files.uploadFile = async (bytes, remote, options) => {
          if (remote === "/workspace/archil-ci-template.json") throw new Error("marker transfer failed");
          await upload(bytes, remote, options);
        };
      }
      if (phase === "stop") {
        const stop = source.stop;
        let calls = 0;
        source.stop = async () => {
          if (calls++ === 0) throw new Error("stop failed");
          await stop();
        };
      }
      return source;
    };
    await assert.rejects(provisionNative(f.client, f.github, f.config));
    assert.equal(f.sandboxes[0].status, "deleted");
    assert.ok(!f.events.includes("fork"));
  });
}

test("prepared new source is deleted on child marker failure despite retention request", async (t) => {
  const f = await fixture(t, { retainTemplate: true });
  const create = f.client.sandboxes.create;
  f.client.sandboxes.create = async (...args) => {
    const source = await create(...args);
    const fork = source.fork;
    source.fork = async (...args) => {
      const child = await fork(...args);
      child.marker = Buffer.from("corrupt");
      return child;
    };
    return source;
  };
  await assert.rejects(provisionNative(f.client, f.github, f.config), /marker/);
  assert.equal(f.sandboxes[0].status, "deleted");
  assert.equal(f.sandboxes[1].status, "deleted");
  assert.ok(!f.events.includes("token"));
  assert.equal(JSON.parse(await readFile(join(f.config.outputDirectory, "native-provision.json"), "utf8")).templateRetained, false);
});

test("registration failure after preparation deletes new source despite retention request", async (t) => {
  const f = await fixture(t, { retainTemplate: true });
  f.github.createRegistrationToken = async () => {
    f.failWorkload();
    return "short-lived-registration-secret";
  };
  await assert.rejects(provisionNative(f.client, f.github, f.config), /register runner/);
  assert.ok(f.events.indexOf("stop:template") < f.events.indexOf("fork"));
  assert.ok(f.events.indexOf("delete:runner") < f.events.indexOf("delete:template"));
  assert.ok(f.sandboxes.every((item) => item.status === "deleted"));
  await assert.rejects(readFile(f.config.outputPath), { code: "ENOENT" });
});

test("external source ID is excluded even if its name matches this attempt's runner", async (t) => {
  const f = await fixture(t, { reuseTemplateId: "external-id" });
  const source = reusableSource(f);
  source.name = `${f.config.prefix}-runner`;
  await cleanupNative(f.client, f.github, f.config);
  assert.equal(source.status, "stopped");
  assert.ok(!f.events.includes("delete:external"));
});

test("marker download stops at first oversized chunk rather than buffering the file", async (t) => {
  const f = await fixture(t, { reuseTemplateId: "external-id" });
  const source = reusableSource(f);
  const fork = source.fork;
  let delivered = 0;
  source.fork = async (...args) => {
    const child = await fork(...args);
    child.files.downloadFile = async (remote, writer) => {
      for (let index = 0; index < 100; index += 1) {
        delivered += 1;
        await writer(Buffer.alloc(1024));
      }
    };
    return child;
  };
  await assert.rejects(provisionNative(f.client, f.github, f.config), /exceeds 4 KiB/);
  assert.equal(delivered, 5);
  assert.equal(source.status, "stopped");
  assert.equal(f.sandboxes[1].status, "deleted");
});

test("hung child marker download is bounded and leaves external source untouched", async (t) => {
  const f = await fixture(t, { reuseTemplateId: "external-id", requestTimeoutMs: 5 });
  const source = reusableSource(f);
  const fork = source.fork;
  source.fork = async (...args) => {
    const child = await fork(...args);
    child.files.downloadFile = () => new Promise(() => {});
    return child;
  };
  await assert.rejects(provisionNative(f.client, f.github, f.config), /Read template marker timed out/);
  assert.equal(source.status, "stopped");
  assert.equal(f.sandboxes[1].status, "deleted");
});

test("guest registration guard rejects dirty reused child without snapshotting it", async (t) => {
  const f = await fixture(t, { reuseTemplateId: "external-id" });
  const source = reusableSource(f);
  const fork = source.fork;
  source.fork = async (...args) => {
    const child = await fork(...args);
    child.registered = true;
    return child;
  };
  await assert.rejects(provisionNative(f.client, f.github, f.config), /already registered/);
  assert.equal(f.events.filter((event) => event === "fork").length, 1);
  assert.equal(source.status, "stopped");
  assert.equal(f.sandboxes[1].status, "deleted");
  assert.ok(f.commands.every(({ stage }) => stage === "runner"));
});

test("original workload exit survives cleanup failure and no token is fetched", async (t) => {
  const f = await fixture(t);
  f.failWorkload();
  f.failCleanup();
  await assert.rejects(provisionNative(f.client, f.github, f.config), (error) => error instanceof WorkloadFailure && error.exitCode === 23);
  assert.ok(f.events.includes("delete:template"));
  assert.ok(!f.events.includes("fork"));
  assert.ok(!f.events.includes("token"));
});

test("registration failure cleans child before template even when GitHub deletion fails", async (t) => {
  const f = await fixture(t);
  const list = f.github.listRunners;
  f.github.createRegistrationToken = async () => {
    f.failWorkload();
    return "short-lived-registration-secret";
  };
  f.github.listRunners = async () => {
    const runners = await list();
    assert.equal(runners.length, 1);
    return runners;
  };
  f.github.deleteRunner = async () => { throw new Error("cannot delete GitHub runner"); };
  await assert.rejects(provisionNative(f.client, f.github, f.config), (error) =>
    error instanceof WorkloadFailure && error.exitCode === 23 && error.message.startsWith("register runner"));
  assert.ok(f.events.indexOf("delete:runner") < f.events.indexOf("delete:template"));
  assert.equal(f.events.filter((event) => event === "fork").length, 1);
});

test("aborting runner readiness triggers independent exact-resource cleanup", async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  f.github.listRunners = async () => {
    if (!abort.signal.aborted) abort.abort(new Error("stop provisioning"));
    return f.runners;
  };
  await assert.rejects(provisionNative(f.client, f.github, f.config, { signal: abort.signal }), /stop provisioning/);
  assert.ok(f.events.indexOf("delete:runner") < f.events.indexOf("delete:template"));
  assert.equal(f.sandboxes.length, 2);
  assert.ok(f.sandboxes.every((sandbox) => sandbox.status === "deleted"));
});

test("readiness deadline bounds a hung GitHub operation", async (t) => {
  const f = await fixture(t, { requestTimeoutMs: 5, lifecycleTimeoutMs: 10 });
  f.github.listRunners = () => new Promise(() => {});
  await assert.rejects(waitForRunner(f.github, f.config.expectedRunnerName, f.config), /timed out/);
});

test("cleanup is child-first, idempotent, exact-attempt scoped, and requires runner custom label", async (t) => {
  const f = await fixture(t);
  f.sandboxes.push(f.sandbox("template"), f.sandbox("runner"));
  const other = f.sandbox("runner");
  other.name = `${f.config.prefix}0-runner`;
  other.id = "other";
  f.sandboxes.push(other);
  const target = f.config.expectedRunnerName;
  f.runners.push(
    { id: 1, name: target, labels: [{ name: target }] },
    { id: 2, name: `${f.config.prefix}-fedcba987654`, labels: [{ name: "self-hosted" }] },
    { id: 3, name: `${f.config.prefix}0-012345abcdef`, labels: [{ name: `${f.config.prefix}0-012345abcdef` }] },
    { id: 4, name: `${f.config.prefix}-012345abcdef-suffix`, labels: [{ name: `${f.config.prefix}-012345abcdef-suffix` }] },
  );
  await cleanupNative(f.client, f.github, f.config);
  await cleanupNative(f.client, f.github, f.config);
  assert.ok(f.events.indexOf("delete:runner") < f.events.indexOf("delete:template"));
  assert.deepEqual(f.events.filter((event) => event.startsWith("delete-github:")), ["delete-github:1"]);
  assert.equal(f.events.filter((event) => event === "delete:runner").length, 1);
  assert.equal(other.status, "running");
});

test("runner readiness checks identity, required labels, and ephemeral registration", async (t) => {
  const f = await fixture(t);
  const name = f.config.expectedRunnerName;
  f.runners.push({ id: 1, name, status: "online", busy: false, labels: [{ name }] });
  await assert.rejects(waitForRunner(f.github, name, f.config), /routing labels/);
  f.runners[0].labels = [name, "self-hosted", "linux", "x64"].map((name) => ({ name }));
  f.runners[0].ephemeral = false;
  await assert.rejects(waitForRunner(f.github, name, f.config), /not ephemeral/);
  f.runners[0].ephemeral = true;
  assert.equal(await waitForRunner(f.github, name, f.config), f.runners[0]);
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await assert.rejects(waitForRunner(f.github, name, f.config, abort.signal), /cancelled/);
});

function actionsFake(f, { job, rerun = false, fail = false } = {}) {
  let reads = 0;
  return {
    getRun: async (id) => {
      assert.equal(id, f.config.runId);
      f.events.push("get-run");
      reads += 1;
      return { run_attempt: rerun && reads > 1 ? 3 : 2, status: "in_progress" };
    },
    listRunJobs: async (id, attempt) => {
      assert.equal(id, f.config.runId);
      assert.equal(attempt, f.config.attempt);
      if (fail) throw new Error("GitHub unavailable");
      return job ? [job] : [];
    },
    cancelRun: async () => { f.events.push("cancel-run"); },
  };
}

test("queued watchdog cleans before cancellation and rechecks exact attempt", async (t) => {
  const f = await fixture(t, { queueTimeoutMs: 0 });
  f.sandboxes.push(f.sandbox("template"), f.sandbox("runner"));
  await assert.rejects(watchNative(f.client, f.github, actionsFake(f), f.config), /never claimed/);
  assert.ok(f.events.indexOf("delete:runner") < f.events.indexOf("delete:template"));
  assert.ok(f.events.indexOf("delete:template") < f.events.lastIndexOf("get-run"));
  assert.ok(f.events.lastIndexOf("get-run") < f.events.indexOf("cancel-run"));
});

test("watchdog does not cancel a rerun discovered after cleanup", async (t) => {
  const f = await fixture(t, { queueTimeoutMs: 0 });
  f.sandboxes.push(f.sandbox("runner"));
  await watchNative(f.client, f.github, actionsFake(f, { rerun: true }), f.config);
  assert.ok(f.events.includes("delete:runner"));
  assert.ok(!f.events.includes("cancel-run"));
});

for (const status of ["in_progress", "completed"]) {
  test(`watchdog cleans and cancels incorrect routing in ${status}`, async (t) => {
    const f = await fixture(t);
    const actions = actionsFake(f, { job: {
      name: f.config.nativeJobName, status, labels: [f.config.expectedRunnerLabel], runner_name: "wrong-runner",
    } });
    await assert.rejects(watchNative(f.client, f.github, actions, f.config), /unexpected runner/);
    assert.ok(f.events.includes("list-sandboxes"));
    assert.ok(f.events.includes("cancel-run"));
  });
}

test("watchdog cleans and cancels on observation failure, preserving original error", async (t) => {
  const f = await fixture(t);
  f.sandboxes.push(f.sandbox("runner"));
  f.failCleanup();
  await assert.rejects(watchNative(f.client, f.github, actionsFake(f, { fail: true }), f.config), /GitHub unavailable/);
  assert.ok(f.events.includes("cancel-run"));
});

test("completed correctly routed job and superseded attempt need no cancellation", async (t) => {
  const f = await fixture(t);
  await watchNative(f.client, f.github, actionsFake(f, { job: {
    name: f.config.nativeJobName, status: "completed",
    labels: [f.config.expectedRunnerLabel], runner_name: f.config.expectedRunnerName,
  } }), f.config);
  await watchNative(f.client, f.github, {
    getRun: async () => ({ run_attempt: 3, status: "in_progress" }),
  }, f.config);
  assert.ok(!f.events.includes("cancel-run"));
  assert.ok(!f.events.includes("list-sandboxes"));
});
