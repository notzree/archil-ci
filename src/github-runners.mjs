function positiveId(value) {
  if (typeof value !== "string" || value.trim() !== value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("GitHub ID must be a positive decimal string");
  }
  return value;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class GitHubRunners {
  #repository;
  #token;
  #fetch;
  #timeoutMs;
  #maxPages;

  constructor({ repository, token, fetchImpl = globalThis.fetch, timeoutMs = 30000, maxPages = 10 }) {
    if (typeof repository !== "string" ||
        repository.trim() !== repository ||
        !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
        [".", ".."].includes(repository.split("/")[1])) {
      throw new Error("GitHub repository must be owner/name");
    }
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) {
      throw new Error("GitHub token must be nonempty");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("GitHub fetch implementation must be a function");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
        !Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new Error("GitHub timeoutMs and maxPages must be positive safe integers");
    }
    this.#repository = repository;
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#maxPages = maxPages;
  }

  async #request(method, suffix, { json = true, allow404 = false } = {}) {
    const path = `/repos/${this.#repository}${suffix}`;
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let onAbort;
    const deadline = new Promise((_, reject) => {
      onAbort = () => reject(new Error(`${method} ${path}: timeout`));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let status;
    try {
      return await Promise.race([
        (async () => {
          const response = await this.#fetch(`https://api.github.com${path}`, {
            method,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${this.#token}`,
              "X-GitHub-Api-Version": "2026-03-10",
            },
            redirect: "error",
            signal,
          });
          status = response.status;
          if (allow404 && status === 404) return undefined;
          if (!Number.isInteger(status) || status < 200 || status >= 300) {
            throw new Error("HTTP failure");
          }
          return json ? await response.json() : undefined;
        })(),
        deadline,
      ]);
    } catch {
      // Never retain the original error/cause: fetch and JSON errors can contain secrets.
      const safeStatus = Number.isInteger(status) ? status : undefined;
      const error = new Error(`${method} ${path}: ${
        signal.aborted ? "timeout" : safeStatus === undefined ? "request failed" : `HTTP ${safeStatus}`
      }`);
      if (safeStatus !== undefined) error.status = safeStatus;
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async createRegistrationToken() {
    const path = "/actions/runners/registration-token";
    const body = await this.#request("POST", path);
    if (!object(body) || typeof body.token !== "string" || !body.token.trim()) {
      throw new Error(`POST /repos/${this.#repository}${path}: invalid response`);
    }
    return body.token;
  }

  async #list(path, key) {
    const items = [];
    for (let page = 1; page <= this.#maxPages; page++) {
      const suffix = `${path}?per_page=100&page=${page}`;
      const body = await this.#request("GET", suffix);
      if (!object(body) || !Array.isArray(body[key]) || body[key].length > 100 ||
          !body[key].every(object)) {
        throw new Error(`GET /repos/${this.#repository}${suffix}: invalid response`);
      }
      items.push(...body[key]);
      if (body[key].length < 100) return items;
    }
    throw new Error(`GET /repos/${this.#repository}${path}: pagination limit exceeded`);
  }

  listRunners() {
    return this.#list("/actions/runners", "runners");
  }

  deleteRunner(id) {
    return this.#request("DELETE", `/actions/runners/${positiveId(id)}`, { json: false, allow404: true });
  }

  listRunJobs(runId, attempt) {
    return this.#list(`/actions/runs/${positiveId(runId)}/attempts/${positiveId(attempt)}/jobs`, "jobs");
  }

  async getRun(runId) {
    const path = `/actions/runs/${positiveId(runId)}`;
    const body = await this.#request("GET", path);
    if (!object(body)) {
      throw new Error(`GET /repos/${this.#repository}${path}: invalid response`);
    }
    return body;
  }

  async getRunAttempt(runId, attempt) {
    const path = `/actions/runs/${positiveId(runId)}/attempts/${positiveId(attempt)}`;
    const body = await this.#request("GET", path);
    if (!object(body)) throw new Error(`GET /repos/${this.#repository}${path}: invalid response`);
    return body;
  }

  cancelRun(runId) {
    return this.#request("POST", `/actions/runs/${positiveId(runId)}/cancel`, { json: false });
  }
}
