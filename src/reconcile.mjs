import { bounded, cleanupSandboxes } from "./sdk.mjs";

export async function reconcileNative(client, admin, actions, config, report = () => {}) {
  const base = `archil-native-${config.repositoryId}-`;
  const sandboxPattern = new RegExp(`^${base}([1-9]\\d*)-([1-9]\\d*)-(runner|template|retained-template)$`);
  const runnerPattern = new RegExp(`^${base}([1-9]\\d*)-([1-9]\\d*)-[a-f0-9]{12}$`);
  const sandboxes = await bounded(() => client.sandboxes.list(), config.requestTimeoutMs, { label: "List reconciliation sandboxes" });
  const runners = await bounded(() => admin.listRunners(), config.requestTimeoutMs, { label: "List reconciliation runners" });
  const attempts = new Map();
  const terminal = async (runId, attempt) => {
    const key = `${runId}/${attempt}`;
    if (!attempts.has(key)) {
      attempts.set(key, bounded(() => actions.getRunAttempt(runId, attempt), config.requestTimeoutMs, {
        label: "Observe creator attempt",
      }).catch((error) => {
        if (error.status === 404) return { status: "completed", conclusion: "deleted" };
        throw error;
      }));
    }
    return attempts.get(key);
  };
  let processed = 0;
  let inspected = 0;
  for (const runner of runners) {
    const match = runnerPattern.exec(runner.name || "");
    if (!match || runner.name !== runner.name.trim() ||
        !runner.labels?.some((label) => label.name === runner.name)) continue;
    if (inspected >= config.reconcileMaxResources) break;
    inspected += 1;
    const creator = await terminal(match[1], match[2]);
    if (creator.status !== "completed") continue;
    await bounded(() => admin.deleteRunner(String(runner.id)), config.requestTimeoutMs, { label: "Delete reconciled runner" });
    processed += 1;
    report(`Reconciled GitHub runner ${runner.name}`);
  }
  const old = sandboxes.filter((sandbox) => {
    const created = new Date(sandbox.createdAt).getTime();
    return sandboxPattern.test(sandbox.name || "") && sandbox.name === sandbox.name.trim() && Number.isFinite(created) &&
      Date.now() - created >= config.reconcileMinAgeMs;
  }).sort((a, b) => Number(!a.name.endsWith("-runner")) - Number(!b.name.endsWith("-runner")));
  for (const sandbox of old) {
    if (inspected >= config.reconcileMaxResources) break;
    inspected += 1;
    const match = sandboxPattern.exec(sandbox.name);
    const creator = await terminal(match[1], match[2]);
    if (creator.status !== "completed") continue;
    if (match[3] === "retained-template" && sandbox.status === "stopped" && creator.conclusion === "success") continue;
    await cleanupSandboxes([sandbox], config, report);
    processed += 1;
  }
  return { processed, inspected };
}
