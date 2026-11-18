#requires -Version 7.0
<#
.SYNOPSIS
Rolls one live proxy deployment back to the release it replaced, from that deployment's backup folder.

.DESCRIPTION
Undoes a deployment made by Deploy-LiveProxy.ps1 (step 8 of "Deploy only with an explicit request" in
reference/cindy-project.md): holds supervision, stops the deployed release, restores the launcher and
the receipts from the backup folder, lets the supervisor start the previous release and checks it.
Everything it needs except the two paths comes from deploy-record.json in the backup folder.

If the previous release does not come up healthy, the hold is put back and nothing further is started.

Exit codes: 0 restored (or preflight passed), 2 refused (nothing changed), 4 rollback failed (hold in
place). Any other exit code means the state is unknown: run again with -PreflightOnly.

.EXAMPLE
pwsh -NoProfile -NonInteractive -File Rollback-LiveProxy.ps1 -RuntimeRoot "<runtime root>" -BackupRoot "<runtime root>\backups\<backup folder>" -PreflightOnly
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$RuntimeRoot,
    [Parameter(Mandatory)] [string]$BackupRoot,
    [int]$HealthWaitSeconds = 90,
    [int]$StopWaitSeconds = 20,
    [string]$TestTaskDriver,
    [switch]$PreflightOnly
)
. (Join-Path $PSScriptRoot 'LiveProxy.Common.ps1')

function Stop-Refused([string]$Why) { throw [LpStop]::new(2, 'refused', "refused: $Why; nothing was changed", '', 'see the reason above') }

# Strict shape check of the deployment record: exact keys, expected formats.
function Assert-RecordShape($Rec) {
    $keys = @('schema', 'deploymentId', 'createdAt', 'runtimeRoot', 'port', 'taskName', 'previous', 'candidate', 'nodeModules', 'configSha256', 'launcherSha256Before', 'launcherSha256After', 'deployProcess', 'created', 'stage', 'reachedStage')
    $sub = @{
        previous = @('proxyPath', 'version', 'commit'); candidate = @('releaseName', 'proxyPath', 'version', 'commit', 'sourceCommit', 'sha256')
        nodeModules = @('linkType', 'target'); deployProcess = @('pid', 'created'); created = @('releaseDir', 'backupDir')
    }
    $same = { param($have, $want) (@($have | Sort-Object) -join ',') -ceq (@($want | Sort-Object) -join ',') }
    if (-not ($Rec -is [System.Collections.IDictionary]) -or -not (& $same $Rec.Keys $keys)) { throw 'unexpected or missing fields' }
    foreach ($k in $sub.Keys) { if (-not ($Rec[$k] -is [System.Collections.IDictionary]) -or -not (& $same $Rec[$k].Keys $sub[$k])) { throw "unexpected or missing fields in $k" } }
    if ($Rec.schema -ne 1) { throw 'unknown schema version' }
    if ($script:LpStages -notcontains [string]$Rec.stage -or $script:LpForwardStages -notcontains [string]$Rec.reachedStage) { throw 'unknown stage' }
    foreach ($side in 'previous', 'candidate') {
        if ([string]$Rec[$side].version -notmatch $script:LpPatterns.Version -or [string]$Rec[$side].commit -cnotmatch $script:LpPatterns.Commit) { throw "malformed $side identity" }
        if (-not (Test-LpSafeText ([string]$Rec[$side].proxyPath))) { throw "malformed $side path" }
    }
    if ([string]$Rec.candidate.releaseName -notmatch $script:LpPatterns.ReleaseName) { throw 'malformed release name' }
    foreach ($h in 'launcherSha256Before', 'launcherSha256After', 'configSha256') { if ([string]$Rec[$h] -notmatch $script:LpPatterns.Sha256) { throw "malformed $h" } }
    if (-not ($Rec.port -is [int] -or $Rec.port -is [long]) -or $Rec.port -lt 1 -or $Rec.port -gt 65535) { throw 'malformed port' }
    if (-not (Test-LpSafeText ([string]$Rec.taskName)) -or [string]$Rec.taskName -match '[*?\[\]]') { throw 'malformed task name' }
}

$ctx = $null
try {
    $root = Resolve-LpPath $RuntimeRoot
    if (Test-LpReparseInPath $root) { Stop-Refused 'a folder in the runtime root path is a link' }
    $script:LpRoot = $root
    $driver = $null
    try { $driver = Resolve-LpTaskDriver $RuntimeRoot $root $TestTaskDriver } catch { Stop-Refused $_.Exception.Message }
    if ($driver) { . $driver; Write-LpEvent 'STEP' 'TEST SEAM ACTIVE: scheduled-task operations go to the test driver' }

    $backup = $null
    try { $backup = Resolve-LpPath $BackupRoot } catch { Stop-Refused 'the backup folder does not exist' }
    if ([System.IO.Path]::GetDirectoryName($backup) -ne (Join-Path $root 'backups')) { Stop-Refused 'the backup folder is not directly under <runtime root>\backups' }
    $recordPath = Join-Path $backup 'deploy-record.json'
    $restoreNames = @('Start-BillionContextProxy.ps1', 'tuned-deployment.json', 'supervision-receipt.json')
    foreach ($p in @($backup, $recordPath) + @($restoreNames | ForEach-Object { Join-Path $backup $_ })) {
        if (-not (Test-Path -LiteralPath $p)) { Stop-Refused "$(Get-LpRelative $p) is missing" }
        if (Test-LpReparsePoint $p) { Stop-Refused "$(Get-LpRelative $p) is a link" }
    }
    $rec = $null
    try { $rec = [System.IO.File]::ReadAllText($recordPath) | ConvertFrom-Json -AsHashtable; Assert-RecordShape $rec } catch { Stop-Refused "the deployment record is not valid ($($_.Exception.Message))" }
    if (-not [string]::Equals([string]$rec.runtimeRoot, $root, [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Refused 'the deployment record belongs to another runtime root' }
    if ([string]$rec.deploymentId -cne [System.IO.Path]::GetFileName($backup)) { Stop-Refused 'the deployment record does not belong to this backup folder' }
    $releasesDir = Join-Path $root 'releases'
    foreach ($side in 'previous', 'candidate') {
        $pp = [string]$rec[$side].proxyPath
        $relDir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($pp))
        if ([System.IO.Path]::GetFullPath($pp) -ne $pp -or [System.IO.Path]::GetDirectoryName($relDir) -ne $releasesDir -or [System.IO.Path]::GetFileName($pp) -ne 'index.mjs') { Stop-Refused "the $side release path in the record is not <runtime root>\releases\<name>\dist\index.mjs" }
    }
    if (-not (Test-Path -LiteralPath ([string]$rec.previous.proxyPath) -PathType Leaf)) { Stop-Refused 'the previous release bundle is missing' }

    $ctx = @{
        Root = $root; Port = [int]$rec.port; TaskName = [string]$rec.taskName; HealthWait = $HealthWaitSeconds; StopWait = $StopWaitSeconds
        LauncherPath = Join-Path $root 'Start-BillionContextProxy.ps1'; InhibitPath = Join-Path $root 'maintenance.inhibit'
        LockPath = Join-Path $root 'supervisor.lock'; StatusPath = Join-Path $root 'supervisor-status.json'
        ConfigPath = Join-Path $root 'config\billion-context\billion-context.json'; ConfigSha = $null
        Previous = [ordered]@{ proxyPath = [string]$rec.previous.proxyPath; version = [string]$rec.previous.version; commit = [string]$rec.previous.commit }
        Candidate = [ordered]@{ releaseName = [string]$rec.candidate.releaseName; proxyPath = [string]$rec.candidate.proxyPath; version = [string]$rec.candidate.version; commit = [string]$rec.candidate.commit }
        BackupRoot = $backup; DeploymentId = [string]$rec.deploymentId; Record = $rec; RecordPath = $recordPath; LiftAt = [datetime]::MinValue; TaskBaseline = $null
    }

    $backupLauncher = [System.IO.File]::ReadAllBytes((Join-Path $backup 'Start-BillionContextProxy.ps1'))
    if (-not (Test-LpSameHash (Get-LpSha256OfBytes $backupLauncher) ([string]$rec.launcherSha256Before))) { Stop-Refused 'the launcher in the backup folder is not the one this deployment saved' }
    $id = $null
    try { $id = Read-LpLauncherIdentity ([System.Text.Encoding]::ASCII.GetString($backupLauncher)) } catch { Stop-Refused "the launcher in the backup folder is not readable ($($_.Exception.Message))" }
    if ($id.ProxyPath.Value -cne $ctx.Previous.proxyPath -or $id.ExpectedVersion.Value -cne $ctx.Previous.version -or $id.ExpectedCommit.Value -cne $ctx.Previous.commit -or [int]$id.Port.Value -ne $ctx.Port) { Stop-Refused 'the launcher in the backup folder does not name the previous release recorded for this deployment' }

    $ownHold = Test-LpOwnInhibit $ctx
    if ((Test-Path -LiteralPath $ctx.InhibitPath) -and -not $ownHold) { Stop-Refused 'maintenance.inhibit is present and belongs to other maintenance' }
    $task = Get-LiveProxyTaskInfo $ctx.TaskName
    if ($task.Count -ne 1) { Stop-Refused "expected exactly one scheduled task named in the record, found $($task.Count)" }
    if ($task.ActionArguments.IndexOf($ctx.LauncherPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { Stop-Refused 'the task action does not run the launcher in this runtime root' }
    $ctx.TaskBaseline = $task

    $dp = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$rec.deployProcess.pid)" -OperationTimeoutSec 15 -ErrorAction Stop
    if ($null -ne $dp -and [Math]::Abs(($dp.CreationDate.ToUniversalTime() - ([datetime]$rec.deployProcess.created).ToUniversalTime()).TotalSeconds) -lt 1) { Stop-Refused 'the deploy script for this deployment is still running' }

    $liveSha = Get-LpSha256 $ctx.LauncherPath
    $isBefore = Test-LpSameHash $liveSha ([string]$rec.launcherSha256Before)
    $isAfter = Test-LpSameHash $liveSha ([string]$rec.launcherSha256After)
    $stage = [string]$rec.stage
    if (-not $isBefore -and -not $isAfter) { Stop-Refused 'the launcher was changed after this deployment; this is not the current deployment''s backup' }
    if ($stage -eq 'rolled-back') { Stop-Refused 'this deployment was already rolled back' }
    if (@('prepared', 'aborted') -contains $stage) { Stop-Refused "this deployment stopped at stage '$stage' and changed nothing" }

    $ctx.ConfigSha = Get-LpSha256 $ctx.ConfigPath
    $receipts = @{}
    foreach ($name in 'tuned-deployment.json', 'supervision-receipt.json') { $receipts[(Join-Path $root $name)] = [System.IO.File]::ReadAllBytes((Join-Path $backup $name)) }
    $clients = Get-LpClientCount $ctx
    Write-LpEvent 'STEP' "deployment stage '$stage'; launcher currently names the $(if ($isAfter -and -not $isBefore) { 'deployed' } else { 'previous' }) release; open client connections: $clients"
    $plan = "hold supervision, stop any process of release $($ctx.Candidate.releaseName), restore the launcher and receipts where they differ from the backup, let the supervisor start $($ctx.Previous.version), $($ctx.Previous.commit) and check it"
    if ($PreflightOnly) {
        Write-LpEvent 'STEP' "would do: $plan"
        throw [LpStop]::new(0, 'preflight-ok', 'rollback preflight passed; nothing was changed', '', 'run again without -PreflightOnly to roll back')
    }
} catch [LpStop] {
    Complete-Lp $null $_.Exception $null
} catch {
    Complete-Lp $null ([LpStop]::new(2, 'refused', "refused: $($_.Exception.Message); nothing was changed", '', 'fix the problem above and run again')) $null
}

try {
    Invoke-LpRollback $ctx $backupLauncher $receipts $false
    Set-LpStage $ctx 'rolled-back'
    Complete-Lp $ctx ([LpStop]::new(0, 'restored', "the previous release $($ctx.Previous.version), $($ctx.Previous.commit) is live under supervision; receipts describe it", '', 'report the failure, the release left live and the backup location (step 10). A later deployment needs a new -ReleaseName.')) 'rollback-result.json'
} catch [LpStop] {
    Complete-Lp $ctx $_.Exception 'rollback-result.json'
} catch {
    Complete-Lp $ctx ([LpStop]::new(4, 'rollback-failed', "rollback stopped unexpectedly: $($_.Exception.Message). Check by hand that maintenance.inhibit is present, the task is disabled and no supervisor runs.", 'rollback-error', 'report to the owner; no release is confirmed live')) 'rollback-result.json'
}
