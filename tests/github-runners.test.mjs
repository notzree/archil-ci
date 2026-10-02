import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { GitHubRunners } from "../src/github-runners.mjs";

const token = "secret-admin-token";
const registrationToken = "secret-registration-token";
const response = (body, status = 200) => ({ status, json: async () => body });
const page = (key, length) => ({ [key]: Array.from({ length }, (_, id) => ({ id: id + 1 })) });

function mock(responses, options = {}) {
  const calls = [];
  const api = new GitHubRunners({
    repository: "archil/archil",
    token,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      assert.ok(responses.length, "Unexpected request");
      const next = responses.shift();
      return typeof next === "function" ? next(url, init) : next;
    },
    ...options,
  });
  return { api, calls };
}

test("methods use exact repository URLs, methods, auth and version headers", async () => {
  const metadata = { run_attempt: 2, status: "in_progress", extra: "preserved" };
  const { api, calls } = mock([
    response({ token: registrationToken }), response({ runners: [] }),
    response(undefined, 204), response({ jobs: [] }), response(metadata),
    response(undefined, 202),
  ]);
  assert.equal(await api.createRegistrationToken(), registrationToken);
  assert.deepEqual(await api.listRunners(), []);
  assert.equal(await api.deleteRunner("123"), undefined);
  assert.deepEqual(await api.listRunJobs("456", "2"), []);
  assert.equal(await api.getRun("456"), metadata);
  assert.equal(await api.cancelRun("456"), undefined);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["POST", "https://api.github.com/repos/archil/archil/actions/runners/registration-token"],
    ["GET", "https://api.github.com/repos/archil/archil/actions/runners?per_page=100&page=1"],
    ["DELETE", "https://api.github.com/repos/archil/archil/actions/runners/123"],
    ["GET", "https://api.github.com/repos/archil/archil/actions/runs/456/attempts/2/jobs?per_page=100&page=1"],
    ["GET", "https://api.github.com/repos/archil/archil/actions/runs/456"],
    ["POST", "https://api.github.com/repos/archil/archil/actions/runs/456/cancel"],
  ]);
  for (const call of calls) {
    assert.deepEqual(call.headers, {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    });
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.redirect, "error");
  }
  assert.ok(!inspect(api).includes(token));
  assert.ok(!inspect(api).includes(registrationToken));
});

test("rejects repository injection and invalid configuration without echoing inputs", () => {
  for (const repository of ["", "owner", "a/b/c", "a/..", "a/.", "../b", "a/b?x", "a/b#x",
    "a/b%2f..", "https://evil.test/a", "a\\b/c", "a/b\n", undefined]) {
    assert.throws(() => new GitHubRunners({ repository, token }), /repository must be owner\/name/);
  }
  for (const invalidToken of ["", " ", undefined, 123, `${token}\r\n`]) {
    assert.throws(() => new GitHubRunners({ repository: "a/b", token: invalidToken }), /token must be nonempty/);
  }
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { maxPages: 0 }, { maxPages: Infinity },
    { fetchImpl: null }]) {
    assert.throws(() => new GitHubRunners({ repository: "a/b", token, ...options }));
  }
});

test("rejects unsafe IDs on every method before fetching", async () => {
  const { api, calls } = mock([]);
  for (const id of ["0", "-1", "1.5", "01", "1e3", "1/../2", "1?x", "1#x", "1%2f2", "1\n", "", 1, undefined]) {
    for (const operation of [
      () => api.deleteRunner(id), () => api.getRun(id), () => api.cancelRun(id),
      () => api.listRunJobs(id, "1"), () => api.listRunJobs("1", id),
    ]) {
      await assert.rejects(async () => operation(), /positive decimal string/);
    }
  }
  assert.equal(calls.length, 0);
});

test("runners and exact-attempt jobs paginate and fail closed at the cap", async () => {
  for (const key of ["runners", "jobs"]) {
    const list = (api) => key === "runners" ? api.listRunners() : api.listRunJobs("42", "3");
    const { api, calls } = mock([response(page(key, 100)), response(page(key, 2))]);
    assert.equal((await list(api)).length, 102);
    assert.match(calls[1].url, /per_page=100&page=2$/);
    const capped = mock([response(page(key, 100)), response(page(key, 100))], { maxPages: 2 });
    await assert.rejects(list(capped.api), /pagination limit exceeded/);
    assert.equal(capped.calls.length, 2);
    const empty = mock([response(page(key, 100)), response(page(key, 0))], { maxPages: 2 });
    assert.equal((await list(empty.api)).length, 100);
  }
});

test("rejects malformed response shapes without exposing the response", async () => {
  for (const key of ["runners", "jobs"]) {
    for (const body of [null, [], {}, { [key]: token }, { [key]: [null] }, page(key, 101)]) {
      const { api } = mock([response(body)]);
      await assert.rejects(key === "runners" ? api.listRunners() : api.listRunJobs("1", "2"), /invalid response/);
    }
  }
  for (const body of [null, {}, { token: "" }, { token: 123 }, { token: " " }]) {
    await assert.rejects(mock([response(body)]).api.createRegistrationToken(), /invalid response/);
  }
  for (const body of [null, [], token]) {
    await assert.rejects(mock([response(body)]).api.getRun("1"), /invalid response/);
  }
});

test("delete 404 is idempotent, but other endpoints preserve permission/rate-limit statuses", async () => {
  const operations = [
    (api) => api.createRegistrationToken(), (api) => api.listRunners(),
    (api) => api.deleteRunner("1"), (api) => api.listRunJobs("1", "2"),
    (api) => api.getRun("1"), (api) => api.cancelRun("1"),
  ];
  await mock([{ status: 404, json: () => assert.fail("must not read body") }]).api.deleteRunner("1");
  for (const status of [401, 403, 429, 500]) {
    for (const operation of operations) {
      const { api } = mock([{ status, json: () => assert.fail("must not read body") }]);
      await assert.rejects(operation(api), (error) => {
        assert.equal(error.status, status);
        assert.match(error.message, new RegExp(`HTTP ${status}$`));
        assert.ok(!inspect(error).includes(token));
        return true;
      });
    }
  }
  await assert.rejects(mock([response({ message: token }, 404)]).api.cancelRun("1"), /HTTP 404/);
});

test("fetch/parse errors cannot leak either token or raw headers/body", async () => {
  for (const result of [
    () => { throw new Error(`${token} ${registrationToken} Authorization`); },
    { status: 200, json: async () => { throw new Error(`${token} ${registrationToken}`); } },
  ]) {
    await assert.rejects(mock([result]).api.createRegistrationToken(), (error) => {
      assert.ok(!inspect(error).includes(token));
      assert.ok(!inspect(error).includes(registrationToken));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("one deadline bounds both fetch and hung body parsing, even if mocks ignore abort", async () => {
  // AbortSignal.timeout is unref'ed; retain the test process while the mocked I/O hangs.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const result of [
      () => new Promise(() => {}),
      { status: 200, json: () => new Promise(() => {}) },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: 200, json: () => new Promise(() => {}) };
      },
    ]) {
      const { api, calls } = mock([result], { timeoutMs: 50 });
      const start = performance.now();
      await assert.rejects(api.createRegistrationToken(), /timeout/);
      assert.ok(performance.now() - start < 500);
      assert.ok(calls[0].signal.aborted);
    }
  } finally {
    clearInterval(keepAlive);
  }
});
