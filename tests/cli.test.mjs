import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const identity = {
  GITHUB_REPOSITORY: "example/app", GITHUB_REPOSITORY_ID: "123",
  GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40),
};

function run(mode, env = {}) {
  const result = spawnSync(process.execPath, ["src/cli.mjs", mode], {
    cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.error, undefined, result.stderr);
  return result;
}

test("public CLI loads all production modules and rejects unknown operations before network access", () => {
  const result = run("invalid");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node src\/cli.mjs provision\|cleanup\|watch\|reconcile/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/);
});

test("cleanup reports missing controller credentials without a cloud request", () => {
  const result = run("cleanup", identity);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /api-key and runner-admin-token are required/);
});

test("watch validates exact provisioned identity before credential or network access", () => {
  const result = run("watch", identity);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exact provisioned runner/);
});
