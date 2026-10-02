# Archil CI

An experimental GitHub Actions integration that runs a **real ephemeral Actions
runner inside an Archil sandbox**, using an isolated fork of a prepared filesystem.

This repository owns runner provisioning, registration, cache-template reuse,
watchdog, and cleanup. A consumer repository owns its setup/build/test commands.
It is not a cache-only action on an existing GitHub/Depot runner.

## Execution model

```text
GitHub-hosted provision job
  → prepare a credential-free template, or select a stopped retained template
  → fork a writable child
  → register a new unprivileged ephemeral Actions runner in the child

GitHub routes the native job to that runner's unique label
  → checkout, actions, build, tests, and artifact uploads run inside Archil

GitHub-hosted watchdog and cleanup
  → remove the GitHub registration and child sandbox
  → delete the per-run template unless explicitly retained
```

The filesystem source is stopped before forking, so this is cache reuse without
preserving a running VM's RAM. No registered runner is snapshotted into the source.
The Archil API key and runner-administration credential stay on hosted controller
jobs. Only a one-hour registration token enters the fresh child.

Supported initial guest: public Ubuntu 24.04-compatible Linux x86-64 images. The
library installs GitHub runner **2.337.0** from a checksum-pinned public release and
its dependencies. Consumer commands prepare language-specific tools.

## Credentials

Supply credentials through repository/environment secrets, never committed files:

| Input | Required permission |
| --- | --- |
| `api-key` | Regional Archil sandbox API access; outbound networking and sufficient CPU/memory quota. Prefer a dedicated CI account/organization. |
| `runner-admin-token` | Repository-scoped GitHub Administration read/write, for registration-token creation and runner listing/deletion. |
| `actions-token` | Ordinary workflow `GITHUB_TOKEN`: Actions read for pre-provision/stale-resource reconciliation, Actions write for watchdog cancellation. Defaults to `github.token`. |

Ordinary `GITHUB_TOKEN` cannot register self-hosted runners. A short-lived,
repo-restricted fine-grained PAT is sufficient for the pilot; a GitHub App
installation token is preferable for maintained automation. Mint App tokens
separately for each hosted controller job rather than storing a one-hour token as a
permanent repository secret.

Run this only on trusted branches/code. Do not expose controller credentials to
fork PRs or a `pull_request_target` checkout of untrusted code. The native job should
have only the permissions/secrets its workload needs.

## Consumer workflow

Replace every `<PINNED_COMMIT>` with the integration's reviewed full Git commit.
The action is hosted in public `notzree/archil-ci`; consumers do not need a private
repository read token to download it. Pilot development is on the feature branch,
not `main`.

```yaml
permissions:
  contents: read

concurrency:
  group: archil-native-ci
  cancel-in-progress: false

jobs:
  provision:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: read
    outputs:
      label: ${{ steps.runner.outputs.runner-label }}
      name: ${{ steps.runner.outputs.runner-name }}
      template_retained: ${{ steps.runner.outputs.template-retained }}
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: notzree/archil-ci@<PINNED_COMMIT>
        id: runner
        with:
          operation: provision
          api-key: ${{ secrets.ARCHIL_API_KEY }}
          runner-admin-token: ${{ secrets.GH_RUNNER_ADMIN_TOKEN }}
          bootstrap-command: bash ci/setup.sh
          warm-command: bash ci/warm-cache.sh
          cache-root: /workspace/cache
          environment: '{"BUILD_CACHE":"/workspace/cache/build"}'
          template-id: ${{ vars.ARCHIL_CI_TEMPLATE_ID }}
          retain-template: false

  native:
    name: Archil native CI
    needs: provision
    runs-on: [self-hosted, linux, x64, "${{ needs.provision.outputs.label }}"]
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - run: bash ci/test.sh

  watchdog:
    needs: provision
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    permissions:
      contents: read
      actions: write
    steps:
      - uses: notzree/archil-ci@<PINNED_COMMIT>
        with:
          operation: watch
          api-key: ${{ secrets.ARCHIL_API_KEY }}
          runner-admin-token: ${{ secrets.GH_RUNNER_ADMIN_TOKEN }}
          runner-name: ${{ needs.provision.outputs.name }}
          runner-label: ${{ needs.provision.outputs.label }}
          job-name: Archil native CI
          retain-template: ${{ needs.provision.outputs.template_retained || 'false' }}

  cleanup:
    needs: [provision, native, watchdog]
    if: always()
    runs-on: ubuntu-24.04
    steps:
      - uses: notzree/archil-ci@<PINNED_COMMIT>
        with:
          operation: cleanup
          api-key: ${{ secrets.ARCHIL_API_KEY }}
          runner-admin-token: ${{ secrets.GH_RUNNER_ADMIN_TOKEN }}
          retain-template: ${{ needs.provision.outputs.template_retained || 'false' }}
```

`ci/setup.sh`, `ci/warm-cache.sh`, and `ci/test.sh` are supplied by the consumer;
there is no built-in Rust, Python, or Node workload. Bootstrap/warm commands execute
as root in the unregistered template; the Actions job executes as `runner` without
sudo/Docker access. Configure only **non-secret** environment values. Do not put
credentials in setup commands or template caches.

## Cache lifecycle

Default: prepare a template for this run, fork the child, then delete both.
`warm-command` alone does **not** give cross-run caching: its cost is paid again
unless the source is retained and reused.

For actual reuse:

1. On a trusted seed run, set `retain-template: true` and optionally populate
   toolchain/dependency/build caches with `warm-command`.
2. Save the returned `template-id` in a consumer repository variable.
3. Save the ID only after the **whole seed workflow succeeds**. On subsequent runs,
   supply that `template-id`. The source must remain stopped;
   the controller neither starts nor mutates it. Only the new child runs the job.
4. Refresh the baseline deliberately when toolchains, runner versions, or cache
   requirements change. Remove old sources manually after their children are gone.

The marker checks format version, consumer repository, workspace, and cache root
in the running child before registration. It is bounded to 4 KiB. These checks do
not prove toolchain freshness or that an arbitrary caller-provided template is safe;
reuse only trusted sources created by this integration.

Pass the **effective `template-retained` output** to watch/cleanup, not the original
request. Failed provisioning does not retain a partially prepared template.
Durable reconciliation conservatively discards sources from failed/cancelled seed
workflows, even if preparation had succeeded; only successful seeds are reusable.

Place caches outside the checkout/work directory (`/workspace/cache` by default)
so checkout cleanup does not erase them. Configure the build tool to use that path.
Compiled artifacts may still be invalidated by source timestamps, paths, flags,
lockfiles, or toolchain changes; Cargo and similar tools decide reuse validity.
The source archive has no `.git`, so the first native checkout may invalidate
workspace-package artifacts even while dependency artifacts remain reusable.

Child writes do not update the source or sibling forks. This is not a live
multiwriter cache. Use a concurrency-safe content-addressed cache backend separately
if jobs must share newly produced entries.

Retained stopped sources consume storage. Keep a bounded set (for example one
baseline per compatible cache key); do not retain a fresh source on every push
without reusing/removing prior sources. No automatic cache eviction exists yet.
Forks inherit their source's VM shape/image. Reuse requires matching CPU/memory,
no idle expiry, a sufficient lifetime, and the expected execution limit.
Inputs describing a new image do not rebuild an existing source; rotate it instead.

## Cleanup and limitations

The unique name/label includes repository ID, workflow run ID, attempt, and a random
suffix. Cleanup matches only this attempt's registrations and sandbox names,
deletes children first, and tolerates already-removed resources.

The independent watchdog is required: an unclaimed self-hosted job otherwise can
remain queued for 24 hours, blocking its dependent cleanup job. It bounds pickup
and execution, verifies actual routing, reaps resources, and cancels the current
run when needed. It rechecks the attempt before cancellation; GitHub has no atomic
attempt-specific cancellation API, so a narrow read/cancel race remains.

SDK requests cannot be aborted at transport level. Shutdown drains tracked
resource-creating requests/late cleanup callbacks within a bounded grace period.
Anything unresolved must be caught by later reconciliation; TTL pause is not deletion.

`operation: reconcile` scans only this consumer repository's known native-runner
namespace, observes the exact creator workflow attempt, and reaps old terminal
resources and registrations. Successful stopped retained seeds are preserved.
API uncertainty does not authorize deletion. Resource count/age are bounded.
Provisioning runs this sweep first, but that alone is not durable if no later run
occurs: deploy a separate scheduled/manual consumer workflow, for example:

```yaml
on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:
permissions:
  contents: read
  actions: read
jobs:
  reconcile:
    runs-on: ubuntu-24.04
    steps:
      - uses: notzree/archil-ci@<PINNED_COMMIT>
        with:
          operation: reconcile
          api-key: ${{ secrets.ARCHIL_API_KEY }}
          runner-admin-token: ${{ secrets.GH_RUNNER_ADMIN_TOKEN }}
```

GitHub schedules run only after that workflow is on the default branch and may be
delayed. Deploy and verify reconciliation before relying on unattended operation.
Force-cancellation or simultaneous outages can still require manual cleanup;
check failed provisioning namespaces again after services recover.

Current scope: one native job per workflow attempt; Linux x64; no Docker/container
actions/service-container guarantee; manual successful-template rotation; no
production autoscaler. Sandboxes are currently preview.
The action has been tested locally against mocked boundaries, not yet through a
live native-runner workflow.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:guest
shellcheck scripts/runner-guest.sh
actionlint .github/workflows/test.yml
```

Tests invoke production helpers/controllers/guest scripts; cloud APIs and installers
are mocked and all guest filesystem writes stay in temporary roots. The repository
workflow also checks that invalid composite-action operations fail before setup or
cloud access.
