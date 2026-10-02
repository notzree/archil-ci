import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function integer(env, name, fallback, minimum, maximum) {
  const text = env[name] || String(fallback);
  const value = Number(text);
  if (!/^\d+$/.test(text) || text !== text.trim() || !Number.isSafeInteger(value) ||
      value < minimum || value > maximum) {
    throw new Error(`Invalid ${name}: expected ${minimum}..${maximum}`);
  }
  return value;
}

function identifier(env, name) {
  const value = env[name];
  if (!value || value !== value.trim() || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return value;
}

function environment(text = "{}") {
  let values;
  try {
    values = JSON.parse(text);
  } catch {
    throw new Error("environment must be a JSON object of non-secret string values");
  }
  if (!values || Array.isArray(values) || typeof values !== "object") {
    throw new Error("environment must be a JSON object");
  }
  for (const [key, value] of Object.entries(values)) {
    const reserved = [
      "ARCHIL_CI_WORKSPACE", "ARCHIL_CI_CACHE_ROOT", "ARCHIL_CI_GUEST_ROOT",
      "ARCHIL_CI_RUNNER_NAME", "ARCHIL_CI_RUNNER_LABEL",
    ];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key !== key.trim() ||
        typeof value !== "string" || value.includes("\0") ||
        /TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTHORIZATION/i.test(key) ||
        reserved.includes(key) || key.startsWith("GITHUB_")) {
      throw new Error("environment contains a reserved, credential-like, or invalid entry");
    }
  }
  return values;
}

export function configuration(env) {
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || repository !== repository.trim() ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
    throw new Error("Missing or invalid GITHUB_REPOSITORY");
  }
  const repositoryId = identifier(env, "GITHUB_REPOSITORY_ID");
  const runId = identifier(env, "GITHUB_RUN_ID");
  const attempt = identifier(env, "GITHUB_RUN_ATTEMPT");
  const prefix = `archil-native-${repositoryId}-${runId}-${attempt}`;
  if (prefix.length + 13 > 64) throw new Error("Run identity exceeds runner name limit");
  const region = env.ARCHIL_CI_REGION || "aws-us-east-1";
  if (!["aws-us-east-1", "aws-us-west-2", "aws-eu-west-1"].includes(region)) {
    throw new Error("region must be a supported AWS sandbox region");
  }
  const apiBaseUrl = env.ARCHIL_CI_API_BASE_URL;
  if (apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    if (url.username || url.password ||
        !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
      throw new Error("API endpoint override requires HTTPS or loopback HTTP");
    }
  }
  const cacheRoot = env.ARCHIL_CI_CACHE_ROOT || "/workspace/cache";
  if (!/^\/workspace\/[A-Za-z0-9_./-]+$/.test(cacheRoot) || cacheRoot !== cacheRoot.trim() ||
      cacheRoot.length > 512 || cacheRoot.endsWith("/") || cacheRoot.includes("//") ||
      cacheRoot.split("/").some((part) => part === "." || part === "..") ||
      cacheRoot === "/workspace/actions" || cacheRoot.startsWith("/workspace/actions/")) {
    throw new Error("cache-root must be canonical under /workspace, outside the runner work directory");
  }
  const reuseTemplateId = env.ARCHIL_CI_TEMPLATE_ID || undefined;
  if (reuseTemplateId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(reuseTemplateId)) {
    throw new Error("template-id must be a sandbox UUID");
  }
  const retention = env.ARCHIL_CI_RETAIN_TEMPLATE || "false";
  if (!["true", "false"].includes(retention)) throw new Error("retain-template must be true or false");
  const repoName = repository.split("/")[1];
  const bootstrapCommand = env.ARCHIL_CI_BOOTSTRAP_COMMAND || "";
  const warmCommand = env.ARCHIL_CI_WARM_COMMAND || "";
  if ([bootstrapCommand, warmCommand].some((command) => command.includes("\0") || command.length > 16384)) {
    throw new Error("Bootstrap/warm commands contain invalid or excessive data");
  }
  const nativeJobName = env.ARCHIL_CI_JOB_NAME || "Archil native CI";
  if (nativeJobName !== nativeJobName.trim() || /[\r\n]/.test(nativeJobName) || nativeJobName.length > 128) {
    throw new Error("job-name must be a single nonempty line");
  }
  return {
    repository, repositoryId, runId, attempt, prefix, region, apiBaseUrl, cacheRoot, reuseTemplateId,
    retainTemplate: retention === "true",
    sha: env.ARCHIL_CI_SOURCE_SHA || env.GITHUB_SHA, archivePath: env.ARCHIL_CI_ARCHIVE,
    workspace: `/workspace/actions/${repoName}/${repoName}`,
    runnerRoot: "/opt/archil-actions-runner",
    guestScriptPath: fileURLToPath(new URL("../scripts/runner-guest.sh", import.meta.url)),
    baseImage: env.ARCHIL_CI_BASE_IMAGE || "ubuntu:24.04",
    guestEnv: environment(env.ARCHIL_CI_GUEST_ENV),
    bootstrapCommand, warmCommand, nativeJobName,
    outputDirectory: resolve(env.ARCHIL_CI_OUTPUT || `${env.RUNNER_TEMP || "."}/archil-ci-results`),
    outputPath: env.GITHUB_OUTPUT,
    vcpuCount: integer(env, "ARCHIL_CI_VCPUS", 8, 1, 32),
    memSizeMiB: integer(env, "ARCHIL_CI_MEMORY_MIB", 32768, 256, 65536),
    commandTimeoutSeconds: integer(env, "ARCHIL_CI_COMMAND_TIMEOUT_SECONDS", 2700, 60, 3600),
    lifecycleTimeoutMs: integer(env, "ARCHIL_CI_LIFECYCLE_TIMEOUT_SECONDS", 600, 1, 900) * 1000,
    requestTimeoutMs: integer(env, "ARCHIL_CI_REQUEST_TIMEOUT_SECONDS", 30, 1, 120) * 1000,
    cancellationGraceMs: integer(env, "ARCHIL_CI_CANCELLATION_GRACE_SECONDS", 5, 1, 30) * 1000,
    shutdownGraceMs: integer(env, "ARCHIL_CI_SHUTDOWN_GRACE_SECONDS", 5, 1, 30) * 1000,
    pollIntervalMs: 1000,
    cleanupAttempts: 3,
    maxTtlSeconds: integer(env, "ARCHIL_CI_MAX_TTL_SECONDS", 7200, 3600, 86400),
    queueTimeoutMs: integer(env, "ARCHIL_CI_RUNNER_QUEUE_TIMEOUT_SECONDS", 300, 1, 900) * 1000,
    watchdogTimeoutMs: integer(env, "ARCHIL_CI_WATCHDOG_SECONDS", 3300, 1, 3600) * 1000,
    watchdogPollMs: integer(env, "ARCHIL_CI_WATCHDOG_POLL_SECONDS", 15, 1, 60) * 1000,
    reconcileMinAgeMs: integer(env, "ARCHIL_CI_RECONCILE_MIN_AGE_SECONDS", 300, 300, 86400) * 1000,
    reconcileMaxResources: integer(env, "ARCHIL_CI_RECONCILE_MAX_RESOURCES", 100, 1, 1000),
    expectedRunnerLabel: env.ARCHIL_CI_EXPECTED_RUNNER_LABEL,
    expectedRunnerName: env.ARCHIL_CI_EXPECTED_RUNNER_NAME,
  };
}

export function validateProvision(config) {
  if (!config.archivePath || !/^[a-f0-9]{40,64}$/i.test(config.sha || "") ||
      config.sha !== config.sha.trim()) {
    throw new Error("provision requires a source archive and exact commit SHA");
  }
}

export function validateWatch(config) {
  const pattern = new RegExp(`^${config.prefix}-[a-f0-9]{12}$`);
  if (!pattern.test(config.expectedRunnerName || "") ||
      config.expectedRunnerName !== config.expectedRunnerLabel ||
      config.expectedRunnerName !== config.expectedRunnerName.trim()) {
    throw new Error("watch requires this attempt's exact provisioned runner name and label");
  }
}
