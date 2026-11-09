# Cindy project workflow

[中文](cindy-project.zh-CN.md) · [Project guide](../docs/cindy-project.md) · [Testing reference](testing.md)

## Open and initialize the checkout

Select **billion-context** in Cindy's project list. Its working directory is `C:\Users\anuzz\Projects\billion-context` on TheGame. Use local PowerShell for the commands below.

```powershell
Set-Location C:\Users\anuzz\Projects\billion-context
git status --short
git remote -v
git fetch --prune origin
git switch master
git pull --ff-only origin master
npm ci --ignore-scripts --no-fund --no-audit
npm run build
```

Stop before switching or pulling if there are unrelated local changes. Preserve them and determine their owner. `origin` must be `https://github.com/anuzzolilli-oss/billion-context.git`; `upstream` has a disabled push URL. Create a scoped feature branch before editing. Do not install this checkout globally as part of setup.

## Verify changes

Ordinary development uses targeted tests with hermetic data roots:

```powershell
node --import ./tests/preload-storage-baseline.mjs --import ./tests/preload-test-env.mjs --import tsx --test tests/native-fold-invariant.test.ts tests/snapshot-media-invariant.test.ts
npm run typecheck
npm run build
npm run check:unused-exports
node tools/check-architecture-docs.mjs
git diff --check
```

Choose the files relevant to the change. Follow additional component, signed-payload and real-client gates in [AGENTS.md](../AGENTS.md) and [testing.md](testing.md). Read CI and code-review findings against the exact pushed SHA. A green review check can still contain findings; inspect its actual summary and comments.

### Full local diagnostic run, only with explicit owner approval

This is an owner-requested diagnostic exception to the targeted-only local workflow, not standing permission to run the full suite. Remote CI on the exact pushed head remains the sole full-regression merge verdict; local results cannot replace it.

The unsharded Windows launch can fail with `spawn ENAMETOOLONG`: the complete host corpus's explicit file list exceeds the process command-line limit. Use the existing CI partitioner, with five sequential partitions and its normal file concurrency of four. Its deterministic, disjoint partitioning covers the same complete top-level host corpus; this does not filter away failing suites. Run one full corpus at a time.

```powershell
New-Item -ItemType Directory .tmp/project-verification -Force | Out-Null
$priorShard = $env:CI_TEST_SHARD
$failedShards = @()
try {
    foreach ($part in 1..5) {
        $env:CI_TEST_SHARD = "$part/5"
        node scripts/run-ci-tests.mjs *> ".tmp/project-verification/host-shard-$part.log"
        if ($LASTEXITCODE -ne 0) { $failedShards += $part }
    }
} finally {
    $env:CI_TEST_SHARD = $priorShard
}
if ($failedShards.Count) { throw "Host partitions failed: $failedShards" }
npm --prefix kernel test
if ($LASTEXITCODE -ne 0) { throw 'Kernel tests failed' }
npm --prefix pi-subagents test
if ($LASTEXITCODE -ne 0) { throw 'Pi-subagents tests failed' }
```

Run this as a local shell, without impersonating a GitHub merge event or enabling gated external clients. The runner's standard preloads isolate the host corpus. Retain the first attempt and any automatic retry; record pass/fail/cancelled/skip totals for each suite. A nonzero exit, cancelled tests or failed assertions prevents a green claim. Skips remain visible. MySQL, live-model, browser and external-client integration gates require their documented services, credentials or binaries; the default corpus does not prove those integrations.

An initial launcher error is a failed launch, not a passed test run. Reproduce an assertion failure in its own file before changing product code. Keep Windows cleanup/locking failures separate from history/cancellation defects. Do not weaken assertions, increase timeouts speculatively or disable isolation to obtain a green report.

## Inspect the live proxy

Development builds stay in this checkout. Live releases are separate under `%APPDATA%\CindyGlobal\billion-context-proxy`.

```powershell
$proxyRoot = Join-Path $env:APPDATA 'CindyGlobal\billion-context-proxy'
Invoke-RestMethod http://127.0.0.1:8787/__bili/plugin/manifest |
    Select-Object commit, version
Get-ScheduledTask -TaskName 'Cindy - billion-context proxy' |
    Select-Object TaskName, State
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8787 -State Listen |
    Select-Object LocalAddress, OwningProcess
Get-Content (Join-Path $proxyRoot 'tuned-deployment.json')
```

The receipt identifies the active release, prior release, bundle hash and backup. Logs live under `state\billion-context\bili.log` and `supervisor.log` in the runtime root. Filter diagnostics by the disposable test session ID; historical warnings or previous PIDs alone do not establish a new failure or two current writers. Do not copy provider secrets, encrypted credential blobs or private session contents into project docs or evidence.

## Deploy only with an explicit request

1. Pin the reviewed source SHA and check the exact-head CI/review results. Build a separate candidate artifact and record its hash and any local runtime wrapper. Test that exact artifact in an isolated process using generated data and a loopback upstream.
2. Verify the existing supervisor, configuration hash, listener PID/process identity and idle state. Prepare a new release directory and back up the supervisor and deployment receipt. Preserve authentication, settings, originals and the scheduled task's sign-in/recovery ownership.
3. Change only the existing proxy's release path. Restart only that proxy after active requests drain. On startup failure, restore the saved launcher/receipt and restart the previous release.
4. Check the manifest's source identity, single-listener ownership and unchanged configuration hash. Exercise request forwarding, actual folding, exact original text/image retrieval and session-scoped checker logs. Use one small authenticated provider request when authorized.
5. Finalize the deployment receipt and report the deployed SHA, results and rollback location. If the canary fails, restore the previous release and report the failure. A local proxy deployment does not publish npm packages or update the hosting Cindy application.

Deployment tooling and detailed historical logs from the initial repair remain in the original task's `inspection-evidence` directory. Inspect them before reuse: they contain pinned build hashes and previous-build assumptions. Do not execute an old installer against a different current release without rebuilding its identity and rollback checks.
