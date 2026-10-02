import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuration, validateProvision, validateWatch } from "./config.mjs";
import { cleanupNative, provisionNative, watchNative } from "./controller.mjs";
import { GitHubRunners } from "./github-runners.mjs";
import { reconcileNative } from "./reconcile.mjs";
import { createPendingOperations, WorkloadFailure } from "./sdk.mjs";

export async function main(argv = process.argv, env = process.env) {
  const mode = argv[2];
  if (!["provision", "cleanup", "watch", "reconcile"].includes(mode)) {
    throw new Error("Usage: node src/cli.mjs provision|cleanup|watch|reconcile");
  }
  const config = configuration(env);
  if (mode === "provision") validateProvision(config);
  if (mode === "watch") validateWatch(config);
  if (!env.ARCHIL_API_KEY || !env.GH_RUNNER_ADMIN_TOKEN) {
    throw new Error("api-key and runner-admin-token are required");
  }
  if (mode !== "cleanup" && !env.GITHUB_TOKEN) throw new Error("An Actions token is required for observing workflow attempts");
  const { Archil } = await import("disk");
  const client = new Archil({ apiKey: env.ARCHIL_API_KEY, region: config.region, baseUrl: config.apiBaseUrl });
  const admin = new GitHubRunners({
    repository: config.repository, token: env.GH_RUNNER_ADMIN_TOKEN, timeoutMs: config.requestTimeoutMs,
  });
  const cancellation = new AbortController();
  config.pendingOperations = createPendingOperations();
  for (const name of ["SIGINT", "SIGTERM"]) {
    process.once(name, () => cancellation.abort(new Error(`Controller cancelled by ${name}`)));
  }
  const report = (message) => console.log(message);
  try {
    if (mode === "cleanup") return await cleanupNative(client, admin, config, report);
    const actions = new GitHubRunners({
      repository: config.repository, token: env.GITHUB_TOKEN, timeoutMs: config.requestTimeoutMs,
    });
    if (mode === "watch") return await watchNative(client, admin, actions, config, { signal: cancellation.signal, report });
    if (mode === "reconcile") return await reconcileNative(client, admin, actions, config, report);
    await reconcileNative(client, admin, actions, config, report);
    return await provisionNative(client, admin, config, {
      signal: cancellation.signal, report,
      onOutput: ({ stream, data }) => (stream === "stderr" ? process.stderr : process.stdout).write(data),
      mask: (token) => {
        if (env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${token}`);
      },
    });
  } finally {
    const { pending } = await config.pendingOperations.drain(config.shutdownGraceMs);
    if (pending) console.warn("Unresolved SDK operations remain; run reconciliation after the service recovers");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // SDK requests cannot be aborted; close remaining transports after cleanup.
  const finish = (code) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  main().then(() => finish(0)).catch((error) => {
    console.error(error.message);
    finish(error instanceof WorkloadFailure ? error.exitCode : 1);
  });
}
