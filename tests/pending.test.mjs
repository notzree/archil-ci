import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPendingOperations } from "../src/sdk.mjs";

test("drain waits for late resource cleanup and does not hang on unresolved operations", async () => {
  const pending = createPendingOperations();
  let deleted = false;
  const response = new Promise((resolve) => setTimeout(() => resolve("late-resource"), 5));
  pending.track(response);
  pending.track(response.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    deleted = true;
  }));
  assert.deepEqual(await pending.drain(100), { pending: 0, timedOut: false });
  assert.equal(deleted, true);
  pending.track(new Promise(() => {}));
  assert.deepEqual(await pending.drain(5), { pending: 1, timedOut: true });
});

test("actual subprocess waits for tracked cleanup before explicit CLI-style exit", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createPendingOperations } from "./src/sdk.mjs";
    const pending = createPendingOperations();
    const response = new Promise(resolve => setTimeout(resolve, 10));
    pending.track(response.then(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      console.log("late resource deleted");
    }));
    const state = await pending.drain(100);
    process.stdout.write(JSON.stringify(state) + "\\n", () => process.exit(0));
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 2000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /late resource deleted/);
  assert.match(result.stdout, /"pending":0/);
});
