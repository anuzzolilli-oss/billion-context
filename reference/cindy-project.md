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
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; do not test stale component output' }
node --import ./tests/preload-storage-baseline.mjs --import ./tests/preload-test-env.mjs --import tsx --test tests/native-fold-invariant.test.ts tests/snapshot-media-invariant.test.ts
npm run typecheck
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

1. Pin the human-merged, reviewed source SHA and check the exact-head CI/review results. Build a separate candidate artifact and record its hash and any local runtime wrapper. Test that exact artifact in an isolated process using generated data and a loopback upstream.
2. Verify the existing supervisor, configuration hash, listener PID/process identity and idle state. Prepare a new release directory and back up the supervisor and deployment receipt. Preserve authentication, settings, originals and the scheduled task's sign-in/recovery ownership.
3. Build the live bundle from the small local start-up wrapper `src/live-entry.ts` with the kept esbuild script `build.mjs`, not from the standard CLI entry; building the standard CLI alone does not capture this deployment's runtime policy. The wrapper requires an explicit `--port` (it rejects a non-integer value and ports below 1024 or above 65535), then calls `startServer({ ...loadOptions(), host: "127.0.0.1", port, passthrough: false, autoUpdate: false, autoRestartOnUpdate: false }, { boundedMaintenance: { timeoutMs: 15000, maxTokens: 1024 } })` and logs the enabled bounded maintenance. `build.mjs` bundles `src/live-entry.ts` → `out/dist/index.mjs` (bundle/esm/node20, alias `@earendil-works/pi-coding-agent` → `src/agent/pi-host-stub.ts`, external `jimp, mysql2, mysql2/promise, bufferutil, utf-8-validate`, createRequire banner) and writes `out/dist/build-info.json` with `sourceCommit`, `bundleSha256`, `commit` (the first 8 chars plus `-live`) and `localPatchSha256`; record those hashes in the receipt.
4. Stop the supervisor before editing the launcher, and create `maintenance.inhibit` in the runtime root, which suppresses supervisor adoption, start and restart; a monitored child is left running while inhibited. Editing launcher defaults under a live supervisor is unsafe: adoption is by PID plus process creation time, rechecked after a handle is held, and one supervisor per installation is held by an OS-exclusive lock on `supervisor.lock`, so a second launch exits 0 immediately. The inhibit is temporary: step 8 removes it.
5. Change only the existing proxy's release path. The launcher's `ProxyPath`, `ExpectedVersion` and `ExpectedCommit` defaults must be changed to match the new release, otherwise the supervisor fails closed. Verified defaults for the current release are `ProxyPath` = `...\releases\master-d4aad618\dist\index.mjs`, `ExpectedVersion` = `0.1.213`, `ExpectedCommit` = `d4aad618-live`, alongside `Port` = `8787`, `NodePath` = `C:\Program Files\nodejs\node.exe`, `RestartDelaySeconds` 5, `PollSeconds` 5, `HeartbeatSeconds` 15 and a `-ReportOnly` switch.
6. Expect the supervisor to fail closed on a foreign or unverified listener, unreadable/booting/mismatched health, a matching process that is not listening, missing executables, and inspection errors or timeouts: nothing is killed and nothing is started, and state is rechecked every `PollSeconds` and logged only when it changes. Restart only that proxy after active requests drain. On startup failure, restore the saved launcher/receipt and restart the previous release.
7. Check the manifest's source identity, single-listener ownership and unchanged configuration hash. Exercise request forwarding, actual folding, exact original text/image retrieval and session-scoped checker logs. Use one small authenticated provider request when authorized.
8. Leave maintenance before finalizing, on the success path and on rollback alike: remove `maintenance.inhibit` and restart the supervisor through its scheduled task. While that file exists the supervisor refuses adoption, start and restart, so a deployment that stops at the canary leaves the proxy running unsupervised — a manually started proxy can pass every check and still have no automatic adoption or restart. Verify the supervisor then reports the expected release: its `supervisor-status.json` state, the expected version and commit, and the listener PID it adopted.
9. Finalize the deployment receipt and report the deployed SHA, results and rollback location. If the canary fails, restore the previous release and report the failure. A local proxy deployment does not publish npm packages or update the hosting Cindy application.

Deployment tooling from the initial repair is kept under `%APPDATA%\CindyGlobal\billion-context-proxy\backups\before-master-20261114-191918\tooling\`, containing exactly `Deploy-Master.ps1`, `build.mjs`, `fold-test.mjs`, `iso-test.mjs` and `live-entry.ts`, with the rollback script `Rollback-MasterDeploy.ps1` beside them; that backup root also holds `Start-BillionContextProxy.ps1`, `proxy.identity.json`, `supervision-receipt.json`, `supervisor-status.json` and `tuned-deployment.json`. The live launcher is `Start-BillionContextProxy.ps1` in the runtime root, and `Rollback-TunedLiveProxy.ps1` in the same root rolls that launcher back. Inspect the kept tooling before reuse: it contains pinned build hashes and previous-build assumptions. Do not execute an old installer against a different current release without rebuilding its identity and rollback checks.
