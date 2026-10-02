import assert from "node:assert/strict";
import test from "node:test";
import { reconcileNative } from "../src/reconcile.mjs";

function fixture(extra = {}) {
  const config = {
    repositoryId: "123", requestTimeoutMs: 50, lifecycleTimeoutMs: 50,
    pollIntervalMs: 0, cleanupAttempts: 1, reconcileMinAgeMs: 300000,
    reconcileMaxResources: 100, ...extra,
  };
  const removed = [];
  const resources = [];
  const runners = [];
  const results = new Map();
  const queries = [];
  const resource = (run, stage, status = "stopped", age = 600000) => {
    const name = `archil-native-123-${run}-1-${stage}`;
    const item = {
      id: name, name, status, createdAt: new Date(Date.now() - age),
      refresh: async () => {},
      stop: async () => { item.status = "stopped"; },
      delete: async () => { removed.push(name); },
    };
    resources.push(item);
    return item;
  };
  return {
    config, removed, resources, runners, results, queries, resource,
    client: { sandboxes: { list: async () => resources } },
    admin: {
      listRunners: async () => runners,
      deleteRunner: async (id) => { removed.push(`github:${id}`); },
    },
    actions: {
      getRunAttempt: async (run, attempt) => {
        queries.push(`${run}/${attempt}`);
        const result = results.get(run) || { status: "in_progress" };
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test("reconciliation observes exact attempts and deletes registrations/children before parent", async () => {
  const f = fixture();
  f.resource("456", "template");
  f.resource("456", "runner");
  f.runners.push({ id: 9, name: "archil-native-123-456-1-abcdefabcdef", labels: [{ name: "archil-native-123-456-1-abcdefabcdef" }] });
  f.results.set("456", { status: "completed", conclusion: "failure" });
  const result = await reconcileNative(f.client, f.admin, f.actions, f.config);
  assert.deepEqual(f.removed, [
    "github:9", "archil-native-123-456-1-runner", "archil-native-123-456-1-template",
  ]);
  assert.deepEqual(f.queries, ["456/1"]);
  assert.equal(result.processed, 3);
});

test("successful stopped retained seeds survive; failed or running retained seeds are reclaimed", async () => {
  const f = fixture();
  f.resource("1", "retained-template");
  f.resource("2", "retained-template");
  f.resource("3", "retained-template", "running");
  f.results.set("1", { status: "completed", conclusion: "success" });
  f.results.set("2", { status: "completed", conclusion: "cancelled" });
  f.results.set("3", { status: "completed", conclusion: "success" });
  await reconcileNative(f.client, f.admin, f.actions, f.config);
  assert.deepEqual(f.removed, ["archil-native-123-2-1-retained-template", "archil-native-123-3-1-retained-template"]);
});

test("active attempts, young resources, other repos, and nonmatching labels are untouched", async () => {
  const f = fixture();
  f.resource("1", "runner");
  f.resource("2", "runner", "running", 0);
  const other = f.resource("3", "runner");
  other.name = "archil-native-999-3-1-runner";
  f.runners.push({ id: 9, name: "archil-native-123-4-1-abcdefabcdef", labels: [{ name: "unrelated" }] });
  await reconcileNative(f.client, f.admin, f.actions, f.config);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.queries, ["1/1"]);
});

test("404 creator is terminal; permission errors do not authorize deletion", async () => {
  const f = fixture();
  f.resource("1", "runner");
  f.results.set("1", Object.assign(new Error("gone"), { status: 404 }));
  await reconcileNative(f.client, f.admin, f.actions, f.config);
  assert.equal(f.removed.length, 1);
  f.removed.length = 0;
  f.results.set("1", Object.assign(new Error("forbidden"), { status: 403 }));
  await assert.rejects(reconcileNative(f.client, f.admin, f.actions, f.config), /forbidden/);
  assert.deepEqual(f.removed, []);
});

test("inspection limit bounds API work even when every attempt is active", async () => {
  const f = fixture({ reconcileMaxResources: 2 });
  for (const run of ["1", "2", "3", "4"]) f.resource(run, "runner");
  const result = await reconcileNative(f.client, f.admin, f.actions, f.config);
  assert.equal(result.inspected, 2);
  assert.equal(f.queries.length, 2);
  assert.equal(result.processed, 0);
});

test("hanging observation is bounded without deleting an uncertain resource", async () => {
  const f = fixture({ requestTimeoutMs: 5 });
  f.resource("1", "runner");
  f.actions.getRunAttempt = () => new Promise(() => {});
  await assert.rejects(reconcileNative(f.client, f.admin, f.actions, f.config), /timed out/);
  assert.deepEqual(f.removed, []);
});
