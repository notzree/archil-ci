import assert from "node:assert/strict";
import test from "node:test";
import { configuration, validateProvision, validateWatch } from "../src/config.mjs";

const env = {
  GITHUB_REPOSITORY: "example/web-app", GITHUB_REPOSITORY_ID: "123",
  GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40),
};

test("configuration is language-neutral and derives stable runner workspace/cache paths", () => {
  const config = configuration({
    ...env, ARCHIL_CI_BOOTSTRAP_COMMAND: "npm ci",
    ARCHIL_CI_WARM_COMMAND: "npm run build",
    ARCHIL_CI_GUEST_ENV: '{"NODE_ENV":"test"}',
  });
  assert.equal(config.workspace, "/workspace/actions/web-app/web-app");
  assert.equal(config.cacheRoot, "/workspace/cache");
  assert.deepEqual(config.guestEnv, { NODE_ENV: "test" });
  assert.equal(config.bootstrapCommand, "npm ci");
  assert.equal(config.warmCommand, "npm run build");
  assert.equal(config.package, undefined);
});

test("rejects unsafe identities, paths, timeouts and regions", () => {
  for (const [name, value] of [
    ["GITHUB_REPOSITORY", "example/app\n"], ["GITHUB_RUN_ID", "456\n"],
    ["GITHUB_RUN_ATTEMPT", "../1"], ["ARCHIL_CI_VCPUS", "0"],
    ["ARCHIL_CI_MEMORY_MIB", "65537"], ["ARCHIL_CI_REGION", "unknown"],
    ["ARCHIL_CI_CACHE_ROOT", "/etc"], ["ARCHIL_CI_CACHE_ROOT", "/workspace/actions/cache"],
    ["ARCHIL_CI_CACHE_ROOT", "/workspace/cache/../actions"],
    ["ARCHIL_CI_API_BASE_URL", "http://remote.example"],
    ["ARCHIL_CI_API_BASE_URL", "https://user:password@remote.example"],
  ]) {
    assert.throws(() => configuration({ ...env, [name]: value }));
  }
});

test("template environment rejects secrets and reserved configuration without echoing values", () => {
  for (const value of [
    "[]", "invalid", '{"TOKEN":"must-not-leak"}',
    '{"GH_RUNNER_ADMIN_TOKEN":"must-not-leak"}',
    '{"ARCHIL_CI_GUEST_ROOT":"/tmp/escape"}', '{"VALUE":false}',
  ]) {
    assert.throws(() => configuration({ ...env, ARCHIL_CI_GUEST_ENV: value }),
      (error) => !error.message.includes("must-not-leak"));
  }
  assert.deepEqual(configuration({ ...env, ARCHIL_CI_GUEST_ENV: '{"ARCHIL_CI_PACKAGE":"consumer-choice"}' }).guestEnv,
    { ARCHIL_CI_PACKAGE: "consumer-choice" });
});

test("template retention is explicit and reusable IDs are validated", () => {
  assert.equal(configuration(env).retainTemplate, false);
  assert.equal(configuration({ ...env, ARCHIL_CI_RETAIN_TEMPLATE: "true" }).retainTemplate, true);
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(configuration({ ...env, ARCHIL_CI_TEMPLATE_ID: id }).reuseTemplateId, id);
  assert.throws(() => configuration({ ...env, ARCHIL_CI_TEMPLATE_ID: `${id}\n` }));
  assert.throws(() => configuration({ ...env, ARCHIL_CI_TEMPLATE_ID: "../other" }));
  assert.throws(() => configuration({ ...env, ARCHIL_CI_RETAIN_TEMPLATE: "yes" }));
});

test("provision and watch validate source and this attempt's exact runner identity", () => {
  const config = configuration(env);
  assert.throws(() => validateProvision(config), /source archive/);
  config.archivePath = "/tmp/source.tar";
  validateProvision(config);
  assert.throws(() => validateProvision({ ...config, sha: "main" }), /exact commit/);
  config.expectedRunnerName = `${config.prefix}-abcdefabcdef`;
  config.expectedRunnerLabel = config.expectedRunnerName;
  validateWatch(config);
  assert.throws(() => validateWatch({ ...config, expectedRunnerLabel: "other" }), /exact provisioned/);
  assert.throws(() => validateWatch({ ...config, expectedRunnerName: "archil-native-123-456-2-abcdefabcdef" }));
});
