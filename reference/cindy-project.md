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

1. Pin the human-merged, reviewed source SHA and check the exact-head CI/review results. Build a separate candidate artifact with the recipe in step 3 and record its hash and any local runtime wrapper. Test that exact artifact in an isolated process using generated data and a loopback upstream: the kept `iso-test.mjs` checks boot, identity and forwarding, and the kept `fold-test.mjs` checks folding and retrieval. Both start the bundle on their own port with a copy of the live config and never use the live port.
2. Verify the existing supervisor, configuration hash, listener PID/process identity and idle state. Prepare a new release directory and back up the supervisor and deployment receipt. Preserve authentication, settings, originals and the scheduled task's sign-in/recovery ownership.
3. Build the live bundle from the small local start-up wrapper `live-entry.ts` with the kept esbuild script `build.mjs`, not from the standard CLI entry; building the standard CLI alone does not capture this deployment's runtime policy. Neither file is in the repository: both are in the kept tooling directory named below. Copy the wrapper to `src/live-entry.ts` in a checkout of the pinned source SHA and run `build.mjs` from that checkout's root with the full source SHA as its argument; do not commit the copied files. The wrapper requires an explicit `--port` (it rejects a non-integer value and ports below 1024 or above 65535), then calls `startServer({ ...loadOptions(), host: "127.0.0.1", port, passthrough: false, autoUpdate: false, autoRestartOnUpdate: false }, { boundedMaintenance: { timeoutMs: 15000, maxTokens: 1024 } })` and logs the enabled bounded maintenance. `build.mjs` bundles `src/live-entry.ts` → `out/dist/index.mjs` (bundle/esm/node20, alias `@earendil-works/pi-coding-agent` → `src/agent/pi-host-stub.ts`, external `jimp, mysql2, mysql2/promise, bufferutil, utf-8-validate`, createRequire banner) and writes `out/dist/build-info.json` with `sourceCommit`, `bundleSha256`, `commit` (the first 8 chars plus `-live`) and `localPatchSha256`; record those hashes in the receipt. The candidate folder handed to the cutover holds `dist\index.mjs`, `dist\build-info.json`, `package.json` and `LICENSE`.
4. Hold supervision before editing the launcher, in this order: create `maintenance.inhibit` in the runtime root, which suppresses supervisor adoption, start and restart; disable the scheduled task, whose repeating trigger would otherwise relaunch the supervisor; then stop the supervisor. A monitored child is left running while inhibited, so the old proxy keeps serving: confirm it is still healthy. Editing launcher defaults under a live supervisor is unsafe: adoption is by PID plus process creation time, rechecked after a handle is held, and one supervisor per installation is held by an OS-exclusive lock on `supervisor.lock`, so a second launch exits 0 immediately. The hold is temporary: step 6 lifts it at cutover, and step 8 lifts it again after a rollback.
5. Change only the launcher defaults that identify the release, and nothing else in the launcher: `ProxyPath` and `ExpectedCommit`, plus `ExpectedVersion` when the version changes. They must match the new release, otherwise the supervisor fails closed. Take the new values from the candidate, not from this page: `ProxyPath` is `dist\index.mjs` in the new release directory, `ExpectedCommit` is `commit` in the candidate's `dist\build-info.json`, and `ExpectedVersion` is the version its health endpoint reported in the step 1 isolated test. The values of the release being replaced are the launcher's current defaults; the receipts record the same release in `releaseRoot` and `build` of `tuned-deployment.json` and in `masterDeploy.proxyRelease` of `supervision-receipt.json`, which also carries the version. `Deploy-LiveProxy.ps1` takes the candidate's version, commit, source commit and bundle hash as parameters and refuses a candidate that does not match them; it rewrites only those of the three lines whose value changes and stops before the hold if its edit would touch any other line. The other defaults stay as they are: `Port` = `8787`, `NodePath` = `C:\Program Files\nodejs\node.exe`, `RestartDelaySeconds` 5, `PollSeconds` 5, `HeartbeatSeconds` 15 and a `-ReportOnly` switch.
6. Cut over only when idle: if any client connection to the live port is open, stand down instead of waiting for requests to drain. The script counts a loopback connection as a client unless its owning process is the script itself or the supervisor, whose health probes are not clients. Stop only the old proxy, wait for the port to be released, then remove `maintenance.inhibit`, enable the scheduled task and start it. The supervisor then starts the new release itself, because no matching proxy exists and nothing listens on the port; do not start a proxy by hand. With supervision running, expect the supervisor to fail closed on a foreign or unverified listener, unreadable/booting/mismatched health, a matching process that is not listening, missing executables, and inspection errors or timeouts: nothing is killed and nothing is started, and state is rechecked every `PollSeconds` and logged only when it changes. The cutover has succeeded only when health reports the expected version and commit from the single listener's PID, with exactly one proxy process of the new release and exactly one supervisor; `Deploy-LiveProxy.ps1` waits up to `-HealthWaitSeconds` (90 by default) for all of this together with the supervisor's own report described in step 9. Otherwise take the rollback branch in step 8.
7. With supervision running, check the manifest's source identity, single-listener ownership and unchanged configuration hash. Exercise request forwarding, actual folding, exact original text/image retrieval and session-scoped checker logs. Use one small authenticated provider request when authorized. `Deploy-LiveProxy.ps1` checks only the success test of step 6 and the supervision state of step 9, then rewrites the receipts and reports `deployed`, so these checks run after it has finished, and a failure here is rolled back with `Rollback-LiveProxy.ps1`, with the receipts already rewritten.
8. If the cutover or these checks fail, roll back under a new hold: create `maintenance.inhibit`, disable the scheduled task, stop the supervisor and then the candidate proxy if one was started. Restore the saved launcher, and restore both receipts if they were already rewritten: a failure inside the cutover leaves the receipts untouched, a failure in step 7 after the deploy script has finished does not, and `Rollback-LiveProxy.ps1`, given that deployment's backup folder, restores all three files. Editing or restoring the launcher under a live supervisor is unsafe for the same reason as in step 4. Then lift the hold as in step 6, so that the supervisor starts the previous release, and repeat the step 6 success test and the step 7 checks against it. If the restored release fails them too, the rollback has failed: put the hold back (inhibit set, task disabled, supervisor stopped), make no further start, restore or edit attempt, and report to the owner with the evidence: the failed checks, `supervisor.log`, `bili.log` and what, if anything, holds the port. The live proxy then stays unsupervised or down until the owner decides; that is the intended end state, so that nothing restarts a failing proxy in a loop. Both scripts apply it themselves, leave any proxy process as it is, save the evidence in the backup folder and exit with code 4.
9. Confirm that maintenance has ended, on the success path and the rollback path alike: `maintenance.inhibit` is absent, the scheduled task is enabled and exactly one supervisor is running. While that file exists the supervisor refuses adoption, start and restart, so a deployment that leaves it behind has no automatic adoption or restart even when every check passed. Verify the supervisor is monitoring the release now live, candidate or restored: `supervisor-status.json` shows a monitored child with `healthMatch` true and no inhibit, its `childPid` is the single listener's PID, and the health endpoint reports the expected version and commit from that PID. The only exception is the failed rollback in step 8, which deliberately ends with the hold in place.
10. On the success path, finalize the deployment receipt and report the deployed SHA, results and rollback location. On the rollback path nothing was deployed: confirm the receipts describe the restored release, and report the failure, the release left live and the backup location. After a failed rollback, report that no release is confirmed live and that the hold is in place. A local proxy deployment does not publish npm packages or update the hosting Cindy application.

The deploy and rollback scripts are in the repository, in `scripts/live-deploy/`, and are described below. The build and isolated-test tooling is not: each master cutover kept it in its own backup, in the `tooling\` directory under the backup root that the deployment receipt `tuned-deployment.json` names in `masterBackupRoot`, currently `%APPDATA%\CindyGlobal\billion-context-proxy\backups\before-master-20261114-214204`. It contains exactly `Deploy-Master.ps1`, `build.mjs`, `fold-test.mjs`, `iso-test.mjs` and `live-entry.ts`; the earlier `before-master-20261114-191918` backup holds a byte-identical copy. By step: `iso-test.mjs` and `fold-test.mjs` serve step 1, `live-entry.ts` and `build.mjs` step 3, and `Deploy-Master.ps1` is the one-off script that performed the 2026-11-14 cutovers, kept as history and superseded by `Deploy-LiveProxy.ps1`. Pass the tooling directory to the deploy script as `-ToolingDir`, so that the next backup keeps a copy. Beside `tooling\`, the backup root holds the pre-cutover `Start-BillionContextProxy.ps1`, `proxy.identity.json`, `supervision-receipt.json`, `supervisor-status.json` and `tuned-deployment.json`, and `Rollback-MasterDeploy.ps1`, the rollback text that `Deploy-Master.ps1` generated for that one completed cutover: it restores the launcher and both receipts from that backup and restarts the previous release through the scheduled task. A backup made by `Deploy-LiveProxy.ps1` holds `deploy-record.json` instead, which is what `Rollback-LiveProxy.ps1` reads; that script cannot roll back a cutover made by the old one. The live launcher is `Start-BillionContextProxy.ps1` in the runtime root. `Rollback-TunedLiveProxy.ps1` in the same root is a different, deeper rollback: it restores the configuration and the launcher from the receipt's `backupRoot`, the backup taken before the first tuned deployment on 2026-11-07, not the previous release.

Steps 4–9 follow the order the kept `Deploy-Master.ps1` implements: the supervisor, not the operator, starts the new release, and health is checked with supervision running. That order is the sanctioned one by owner decision of 2026-11-16 ([#78](https://github.com/anuzzolilli-oss/billion-context/issues/78)); the earlier wording, which started and checked the new proxy by hand under the inhibit, is superseded, and with it the question of how a hand-started proxy comes under supervision. The repository scripts implement that order, including the failed-rollback end state of step 8 ([#80](https://github.com/anuzzolilli-oss/billion-context/issues/80)). The kept `Deploy-Master.ps1` and `Rollback-MasterDeploy.ps1` do not: both remove the inhibit and start the scheduled task without requiring the previous release to be healthy (the first only reports the result, the second does not check), and they contain pinned build hashes and previous-build assumptions. Do not run `Deploy-Master.ps1` for a new deployment. If `Rollback-MasterDeploy.ps1` has to be used to undo the 2026-11-14 cutover, do the step 8 checks yourself and put the hold back by hand if they fail.

### Deploy and rollback scripts

`scripts/live-deploy/Deploy-LiveProxy.ps1` and `scripts/live-deploy/Rollback-LiveProxy.ps1` need PowerShell 7 and take every installation-specific value as a parameter; nothing about a release, the port or the task is written into them. Run them non-interactively, and run the deploy script with `-PreflightOnly` first: it performs every check, prints the plan and changes nothing.

```powershell
pwsh -NoProfile -NonInteractive -File scripts\live-deploy\Deploy-LiveProxy.ps1 `
    -RuntimeRoot "<runtime root>" -Port <port> -TaskName "<scheduled task name>" `
    -CandidateRoot "<candidate folder>" -ReleaseName "<new release directory name>" `
    -CandidateVersion "<version reported in the step 1 test>" -CandidateCommit "<commit reported in the step 1 test>" `
    -CandidateSourceCommit "<pinned source SHA>" -CandidateBundleSha256 "<bundle hash recorded at build>" `
    -ExpectedConfigSha256 "<configuration hash verified in step 2>" -ToolingDir "<kept tooling directory>" -PreflightOnly

pwsh -NoProfile -NonInteractive -File scripts\live-deploy\Rollback-LiveProxy.ps1 `
    -RuntimeRoot "<runtime root>" -BackupRoot "<runtime root>\backups\<backup folder>" -PreflightOnly
```

Take the four candidate values from the record of step 1, not from the candidate folder, so that the script proves the folder holds the artifact that was tested. The expected configuration hash is the operator's too: `deployedConfigSha256` in `tuned-deployment.json` is not consulted and not rewritten.

| Step | Covered by |
|---|---|
| 1, 3 | By hand, with the kept build and test tooling |
| 2, 4, 5, 6 | `Deploy-LiveProxy.ps1` |
| 7 | Receipt rewrite: `Deploy-LiveProxy.ps1`. Functional checks: by hand, after it reports `deployed` |
| 8 | During the cutover: `Deploy-LiveProxy.ps1`. After a failed step 7: `Rollback-LiveProxy.ps1` |
| 9 | Both scripts, as part of their success test |
| 10 | Receipts and the printed result: the scripts. The report to the owner: the operator |

Each script prints one line per event and ends with a `NEXT` line and a `RESULT` line; the deploy script prints the backup folder on a `BACKUP` line and keeps `deploy-record.json` and `result.json` there.

| Exit code | Result | State left behind | What to do |
|---|---|---|---|
| 0 | `deployed` | New release healthy under supervision | Run the step 7 checks; the rollback command is on the `NEXT` line |
| 0 | `restored` (rollback script) | Previous release healthy under supervision | Report as in step 10; a later deployment needs a new release name |
| 0 | `preflight-ok` | Nothing changed | Run again without `-PreflightOnly` |
| 2 | `refused` | Nothing changed | Fix the failing checks |
| 3 | `rolled-back` | Previous release healthy under supervision; the new release directory is removed | `reason=not-idle`: retry later. `hold-failed`, `cutover-failed`: investigate first |
| 4 | `rollback-failed` | Hold in place; proxy processes as they were; no release confirmed live | Report to the owner with the evidence file and the two logs; retry with `Rollback-LiveProxy.ps1` once the cause is fixed |
| 5 | `deployed-receipts-incomplete` | New release healthy under supervision; a receipt was not replaced | Copy the pending receipt files named on the `NEXT` line, then run the step 7 checks |
| 6 | `error-before-hold` | Nothing running was changed; the new release directory is removed | Fix the problem and run again |
| other | none printed | Unknown, for example a killed script | Read `deploy-record.json`, then run `Rollback-LiveProxy.ps1 -PreflightOnly` |

The scripts are tested against a sandbox, never against the live proxy: `tests/live-deploy-scripts.test.ts` builds a temporary runtime root with a stand-in launcher and proxy and a test driver in place of the scheduled task. The scripts accept that driver only for a runtime root that carries `sandbox.marker`, refuse the real scheduled task for such a root, and refuse the driver for any root in the live installation area.
