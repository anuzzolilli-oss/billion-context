#requires -Version 7.2
<#
.SYNOPSIS
Deploys a tested candidate build as the live proxy release, following the documented procedure.

.DESCRIPTION
Automates steps 2, 4-6, the receipt rewrite of step 7, the deploy-time rollback of step 8 and the
supervision check of step 9 in reference/cindy-project.md ("Deploy only with an explicit request").
The functional checks of step 7 stay manual and run after this script reports "deployed".

The supervisor, not this script, starts the new release. Every failure after the hold begins ends
either with the previous release healthy under supervision, or with the hold back in place.

Exit codes: 0 deployed, 2 refused (nothing changed), 3 rolled back, 4 rollback failed (hold in
place), 5 deployed but a receipt was not updated, 6 error before the hold (nothing changed).
Any other exit code means the state is unknown: read deploy-record.json in the backup folder.

.EXAMPLE
pwsh -NoProfile -NonInteractive -File Deploy-LiveProxy.ps1 -RuntimeRoot "<runtime root>" -Port <port> -TaskName "<task name>" -CandidateRoot "<candidate folder>" -ReleaseName "<release name>" -CandidateVersion "<version from the isolated test>" -CandidateCommit "<commit from the isolated test>" -CandidateSourceCommit "<full source SHA>" -CandidateBundleSha256 "<bundle hash recorded at build>" -ExpectedConfigSha256 "<config hash verified in step 2>" -PreflightOnly
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$RuntimeRoot,
    [Parameter(Mandatory)] [int]$Port,
    [Parameter(Mandatory)] [string]$TaskName,
    [Parameter(Mandatory)] [string]$CandidateRoot,
    [Parameter(Mandatory)] [string]$ReleaseName,
    [Parameter(Mandatory)] [string]$CandidateVersion,
    [Parameter(Mandatory)] [string]$CandidateCommit,
    [Parameter(Mandatory)] [string]$CandidateSourceCommit,
    [Parameter(Mandatory)] [string]$CandidateBundleSha256,
    [Parameter(Mandatory)] [string]$ExpectedConfigSha256,
    [string]$ToolingDir,
    [int]$HealthWaitSeconds = 90,
    [int]$StopWaitSeconds = 20,
    [string]$TestTaskDriver,
    [switch]$PreflightOnly
)
. (Join-Path $PSScriptRoot 'LiveProxy.Common.ps1')

$ctx = $null
$script:checkFailures = 0
function Add-Check([string]$Label, [scriptblock]$Test) {
    # The test returns $null (or nothing) on success, otherwise a short "expected ..., observed ..." text.
    $problem = $null
    try { $problem = & $Test } catch { $problem = "could not be checked ($($_.Exception.Message))" }
    if ($null -eq $problem -or $problem -eq '') { Write-LpEvent 'CHECK' "PASS $Label" }
    else { Write-LpEvent 'CHECK' "FAIL ${Label}: $problem"; $script:checkFailures++ }
}
function Stop-IfChecksFailed([string]$What) {
    if ($script:checkFailures -gt 0) { throw [LpStop]::new(2, 'refused', "$What refused: $script:checkFailures check(s) failed; nothing was changed", '', 'fix the failing checks listed above and run again') }
}
function Remove-CreatedRelease([string]$ReleaseDir) {
    if (-not (Test-Path -LiteralPath $ReleaseDir)) { return }
    $link = Join-Path $ReleaseDir 'node_modules'
    if (Test-Path -LiteralPath $link) {
        if (-not (Test-LpReparsePoint $link)) { throw 'node_modules in the new release is not a link; the release directory was left in place' }
        [System.IO.Directory]::Delete($link)   # removes the link itself, never its target
    }
    Remove-Item -LiteralPath $ReleaseDir -Recurse -Force
}
# Receipts are edited as JSON trees so that fields this script does not own keep their exact text.
function Set-JsonProp($Object, [string]$Key, $Value) {
    $Object.set_Item($Key, [System.Text.Json.Nodes.JsonNode]::Parse((ConvertTo-Json -InputObject $Value -Compress -Depth 6)))
}
function Copy-JsonProp($Object, [string]$To, [string]$From) {
    $source = $Object.get_Item($From)
    if ($null -eq $source) { $Object.set_Item($To, [System.Text.Json.Nodes.JsonNode]$null) }
    else { $Object.set_Item($To, [System.Text.Json.Nodes.JsonNode]::Parse($source.ToJsonString())) }
}
function ConvertTo-JsonBytes($Node) {
    $opt = [System.Text.Json.JsonSerializerOptions]::new()
    $opt.WriteIndented = $true
    $opt.Encoder = [System.Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping
    return $script:LpUtf8.GetBytes($Node.ToJsonString($opt))
}

try {
    # ---- input validation: nothing is read from the runtime root before this passes ----------------
    Add-Check 'candidate version format' { if ($CandidateVersion -notmatch $script:LpPatterns.Version) { 'expected <major>.<minor>.<patch>' } }
    Add-Check 'candidate commit format' { if ($CandidateCommit -cnotmatch $script:LpPatterns.Commit) { 'expected 7-12 lower-case hex characters with an optional -suffix' } }
    Add-Check 'candidate source commit format' { if ($CandidateSourceCommit -cnotmatch $script:LpPatterns.SourceCommit) { 'expected 40 lower-case hex characters' } }
    Add-Check 'candidate bundle hash format' { if ($CandidateBundleSha256 -notmatch $script:LpPatterns.Sha256) { 'expected 64 hex characters' } }
    Add-Check 'expected config hash format' { if ($ExpectedConfigSha256 -notmatch $script:LpPatterns.Sha256) { 'expected 64 hex characters' } }
    Add-Check 'release name' {
        if ($ReleaseName -notmatch $script:LpPatterns.ReleaseName -or $ReleaseName.Length -gt 64) { return 'expected letters, digits, dot, dash and underscore, at most 64 characters' }
        if ($ReleaseName -match '^(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') { return 'reserved device name' }
    }
    Add-Check 'task name' { if ($TaskName -match '[*?\[\]]') { 'wildcard characters are not allowed' } }
    Add-Check 'port' { if ($Port -lt 1 -or $Port -gt 65535) { 'expected 1-65535' } }
    Add-Check 'no quote, backtick, dollar sign, control or non-ASCII character in any value' {
        foreach ($v in @($RuntimeRoot, $CandidateRoot, $ReleaseName, $TaskName, $CandidateVersion, $CandidateCommit, $ToolingDir)) { if ($v -and -not (Test-LpSafeText $v)) { return 'a value contains a forbidden character' } }
    }
    $root = $null; $candidateRootPath = $null
    Add-Check 'runtime root' {
        $script:root = Resolve-LpPath $RuntimeRoot
        if (-not (Test-LpSafeText $script:root)) { return 'the resolved path contains a forbidden character' }
        if (Test-LpReparseInPath $script:root) { return 'a folder in the path is a link' }
    }
    Add-Check 'candidate folder' {
        $script:candidateRootPath = Resolve-LpPath $CandidateRoot
        if (Test-LpReparseInPath $script:candidateRootPath) { return 'a folder in the path is a link' }
        if ($script:root -and (Test-LpPathWithin $script:candidateRootPath $script:root)) { return 'the candidate folder is inside the runtime root' }
    }
    Stop-IfChecksFailed 'input'
    $root = $script:root; $candidateRootPath = $script:candidateRootPath
    $script:LpRoot = $root

    $driver = $null
    Add-Check 'task driver allowed for this runtime root' { $script:driverPath = Resolve-LpTaskDriver $RuntimeRoot $root $TestTaskDriver; $null }
    Stop-IfChecksFailed 'input'
    if ($script:driverPath) { . $script:driverPath; Write-LpEvent 'STEP' 'TEST SEAM ACTIVE: scheduled-task operations go to the test driver' }

    $releasesDir = Join-Path $root 'releases'
    $newRoot = Join-Path $releasesDir $ReleaseName
    $newProxyPath = Join-Path $newRoot 'dist\index.mjs'
    Add-Check 'release directory location' { if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($newRoot)) -ne $releasesDir) { 'the release name does not resolve to a folder directly under releases' } }
    Stop-IfChecksFailed 'input'

    $ctx = @{
        Root = $root; Port = $Port; TaskName = $TaskName; HealthWait = $HealthWaitSeconds; StopWait = $StopWaitSeconds
        LauncherPath = Join-Path $root 'Start-BillionContextProxy.ps1'; InhibitPath = Join-Path $root 'maintenance.inhibit'
        LockPath = Join-Path $root 'supervisor.lock'; StatusPath = Join-Path $root 'supervisor-status.json'
        ConfigPath = Join-Path $root 'config\billion-context\billion-context.json'; ConfigSha = $ExpectedConfigSha256
        Previous = $null; Candidate = [ordered]@{ releaseName = $ReleaseName; proxyPath = $newProxyPath; version = $CandidateVersion; commit = $CandidateCommit; sourceCommit = $CandidateSourceCommit }
        BackupRoot = $null; DeploymentId = $null; Record = @{ stage = 'none' }; RecordPath = $null; LiftAt = [datetime]::MinValue; TaskBaseline = $null
    }
    $tunedPath = Join-Path $root 'tuned-deployment.json'
    $supervisionPath = Join-Path $root 'supervision-receipt.json'

    # A full run takes the operation lock before it looks at anything; -PreflightOnly creates no file at all.
    if (-not $PreflightOnly) { Enter-LpOperation $root }

    # ---- preflight: read-only, every check runs ----------------------------------------------------
    $candidateFiles = [ordered]@{ 'index.mjs' = 'dist\index.mjs'; 'build-info.json' = 'dist\build-info.json'; 'package.json' = 'package.json'; 'LICENSE' = 'LICENSE' }
    $candidateBytes = @{}; $candidateSha = [ordered]@{}
    Add-Check 'candidate files and identity' {
        foreach ($name in $candidateFiles.Keys) {
            $p = Join-Path $candidateRootPath $candidateFiles[$name]
            if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return "$($candidateFiles[$name]) is missing" }
            if (Test-LpReparsePoint $p) { return "$($candidateFiles[$name]) is a link" }
            $candidateBytes[$name] = [System.IO.File]::ReadAllBytes($p)
            $candidateSha[$name] = Get-LpSha256OfBytes $candidateBytes[$name]
        }
        $info = $script:LpUtf8.GetString($candidateBytes['build-info.json']) | ConvertFrom-Json -AsHashtable
        if ([string]$info['commit'] -cne $CandidateCommit) { return "expected commit $CandidateCommit, the candidate reports $($info['commit'])" }
        if ([string]$info['sourceCommit'] -cne $CandidateSourceCommit) { return 'the candidate reports a different source commit' }
        if ($info.ContainsKey('bundleSha256') -and -not (Test-LpSameHash ([string]$info['bundleSha256']) $CandidateBundleSha256)) { return 'the bundle hash in build-info.json differs from the expected one' }
        $pkg = $script:LpUtf8.GetString($candidateBytes['package.json']) | ConvertFrom-Json -AsHashtable
        if ([string]$pkg['version'] -cne $CandidateVersion) { return "expected version $CandidateVersion, the candidate package says $($pkg['version'])" }
        if (-not (Test-LpSameHash $candidateSha['index.mjs'] $CandidateBundleSha256)) { return 'the bundle hash differs from the expected one' }
    }
    $launcherBytes = $null; $launcherText = $null; $edit = $null; $editedBytes = $null; $prevReleaseDir = $null
    Add-Check 'launcher identity lines' {
        $script:launcherBytes = [System.IO.File]::ReadAllBytes($ctx.LauncherPath)
        if (-not (Test-LpPlainAscii $script:launcherBytes)) { return 'the launcher is not plain ASCII without a byte-order mark' }
        $script:launcherText = [System.Text.Encoding]::ASCII.GetString($script:launcherBytes)
        $id = Read-LpLauncherIdentity $script:launcherText
        $ctx.Previous = [ordered]@{ proxyPath = $id.ProxyPath.Value; version = $id.ExpectedVersion.Value; commit = $id.ExpectedCommit.Value }
        $script:launcherPort = [int]$id.Port.Value
        $script:prevReleaseDir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($ctx.Previous.proxyPath))
        if ([System.IO.Path]::GetDirectoryName($script:prevReleaseDir) -ne $releasesDir -or [System.IO.Path]::GetFileName($ctx.Previous.proxyPath) -ne 'index.mjs') { return 'the current release path is not <runtime root>\releases\<name>\dist\index.mjs' }
        if (-not (Test-Path -LiteralPath $ctx.Previous.proxyPath -PathType Leaf)) { return 'the current release bundle is missing' }
    }
    $launcherBytes = $script:launcherBytes; $launcherText = $script:launcherText; $prevReleaseDir = $script:prevReleaseDir
    if ($null -eq $ctx.Previous) { Stop-IfChecksFailed 'preflight' }
    Add-Check 'port matches the launcher' { if ($script:launcherPort -ne $Port) { "the launcher uses another port than -Port $Port" } }
    Add-Check 'scheduled task runs this launcher' {
        $t = Get-LiveProxyTaskInfo $TaskName
        if ($t.Count -ne 1) { return "expected exactly one task with this name, found $($t.Count)" }
        if (-not $t.Enabled) { return 'the task is disabled' }
        $actionGap = Get-LpTaskActionGap $t $ctx.LauncherPath
        if ($actionGap) { return $actionGap }
        $ctx.TaskBaseline = $t
    }
    Add-Check 'configuration hash' { if (-not (Test-LpSameHash (Get-LpSha256 $ctx.ConfigPath) $ExpectedConfigSha256)) { 'the configuration file differs from -ExpectedConfigSha256' } }
    $listenerProcess = $null
    Add-Check 'current release healthy from the single listener' {
        $l = @(Get-LpListenerPids $Port)
        if ($l.Count -ne 1) { return "expected one listener, found $($l.Count)" }
        $h = Get-LpHealth $Port
        if (-not $h.ok -or $h.version -cne $ctx.Previous.version -or $h.commit -cne $ctx.Previous.commit -or $h.pid -ne [string]$l[0]) { return "expected version=$($ctx.Previous.version) commit=$($ctx.Previous.commit) from pid $($l[0]), observed $(Format-LpHealth $h)" }
        $p = @(Get-LpProxies $ctx.Previous.proxyPath)
        if ($p.Count -ne 1 -or [string]$p[0].ProcessId -ne [string]$l[0]) { return 'the listener is not the single process running the current release' }
        $script:listenerProcess = $p[0]
    }
    $supervisorProcess = $null
    Add-Check 'exactly one supervisor holding the lock' {
        $s = @(Get-LpSupervisors $ctx)
        if ($s.Count -ne 1) { return "expected one supervisor, found $($s.Count)" }
        if (-not (Test-LpLockHeld $ctx.LockPath)) { return 'the installation lock is not held' }
        $script:supervisorProcess = $s[0]
    }
    Add-Check 'no maintenance in progress' { if (Test-Path -LiteralPath $ctx.InhibitPath) { 'maintenance.inhibit is present' } }
    Add-Check 'new release directory is absent' { if (Test-Path -LiteralPath $newRoot) { "releases\$ReleaseName already exists; choose another -ReleaseName" } }
    $nodeModules = $null
    Add-Check 'current release node_modules link' {
        $nm = Get-Item -LiteralPath (Join-Path $prevReleaseDir 'node_modules') -Force
        if (@('Junction', 'SymbolicLink') -notcontains [string]$nm.LinkType) { return 'node_modules of the current release is not a junction or symbolic link' }
        $target = [string]@($nm.Target)[0]
        if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path $prevReleaseDir $target }
        if (-not (Test-Path -LiteralPath $target -PathType Container)) { return 'the node_modules link target is not an existing folder' }
        $script:nodeModules = [ordered]@{ linkType = [string]$nm.LinkType; target = [System.IO.Path]::GetFullPath($target) }
    }
    Add-Check 'launcher edit touches only the release identity lines' {
        if (-not (Test-LpSafeText $newProxyPath)) { return 'the new release path contains a forbidden character' }
        $script:edit = New-LpEditedLauncher $launcherText $newProxyPath $CandidateCommit $CandidateVersion
        if ($script:edit.Changed -notcontains 'ProxyPath') { return 'the release path would not change' }
        $script:editedBytes = [System.Text.Encoding]::ASCII.GetBytes($script:edit.Text)
    }
    $edit = $script:edit; $editedBytes = $script:editedBytes
    Add-Check 'edited launcher parses and reports a decision under Windows PowerShell' {
        if ($null -eq $editedBytes) { return 'the edited launcher could not be built' }
        $r = Invoke-LpLauncherDryRun $editedBytes $root
        if ($r.ExitCode -ne 0 -or -not $r.Action) { return "exit code $($r.ExitCode), decision '$($r.Action)'" }
    }
    $toolingPath = $null
    if ($ToolingDir) {
        Add-Check 'tooling folder' {
            $script:toolingPath = Resolve-LpPath $ToolingDir
            if (Test-LpReparseInPath $script:toolingPath) { return 'a folder in the path is a link' }
            if (Test-LpPathWithin $script:toolingPath $releasesDir) { return 'the tooling folder is inside releases' }
            foreach ($f in (Get-ChildItem -LiteralPath $script:toolingPath -File -Force)) { if (Test-LpReparsePoint $f.FullName) { return "$($f.Name) is a link" } }
        }
        $toolingPath = $script:toolingPath
    }
    $clients = -1
    Add-Check 'idle (no client connection)' {
        $script:clients = Get-LpClientCount $ctx
        if ($script:clients -gt 0 -and -not $PreflightOnly) { return "$script:clients client connection(s) open; not idle" }
    }
    $clients = $script:clients
    Stop-IfChecksFailed 'preflight'
    $listenerProcess = $script:listenerProcess; $supervisorProcess = $script:supervisorProcess; $nodeModules = $script:nodeModules

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $deploymentId = "before-deploy-$stamp-$ReleaseName"
    $backupRoot = Join-Path (Join-Path $root 'backups') $deploymentId
    Write-LpEvent 'STEP' "plan: replace $($ctx.Previous.version), $($ctx.Previous.commit) ($(Get-LpRelative $prevReleaseDir)) with $CandidateVersion, $CandidateCommit (releases\$ReleaseName)"
    Write-LpEvent 'STEP' "plan: launcher defaults to change: $($edit.Changed -join ', '); backup folder backups\$deploymentId; open client connections now: $clients"
    if ($PreflightOnly) { throw [LpStop]::new(0, 'preflight-ok', 'preflight passed; nothing was changed', '', 'run again without -PreflightOnly when the proxy is idle') }
} catch [LpStop] {
    Complete-Lp $null $_.Exception $null
} catch {
    Complete-Lp $null ([LpStop]::new(2, 'refused', "refused: $($_.Exception.Message); nothing was changed", '', 'fix the problem above and run again')) $null
}

# ---- preparation: release directory, backup, record (additive; nothing running is touched) --------
$createdRelease = $false
try {
    New-Item -ItemType Directory -Path $newRoot | Out-Null
    $createdRelease = $true
    New-Item -ItemType Directory -Path (Join-Path $newRoot 'dist') | Out-Null
    foreach ($name in $candidateFiles.Keys) {
        $dest = Join-Path $newRoot $candidateFiles[$name]
        [System.IO.File]::WriteAllBytes($dest, $candidateBytes[$name])
        if (-not (Test-LpSameHash (Get-LpSha256 $dest) $candidateSha[$name])) { throw "the copied $name does not match the candidate" }
    }
    New-Item -ItemType $nodeModules.linkType -Path (Join-Path $newRoot 'node_modules') -Target $nodeModules.target | Out-Null
    New-Item -ItemType Directory -Path $backupRoot | Out-Null
    $ctx.BackupRoot = $backupRoot; $ctx.DeploymentId = $deploymentId; $ctx.RecordPath = Join-Path $backupRoot 'deploy-record.json'
    foreach ($f in 'Start-BillionContextProxy.ps1', 'tuned-deployment.json', 'supervision-receipt.json') { Copy-Item -LiteralPath (Join-Path $root $f) -Destination $backupRoot }
    foreach ($f in 'proxy.identity.json', 'supervisor-status.json') { if (Test-Path -LiteralPath (Join-Path $root $f)) { Copy-Item -LiteralPath (Join-Path $root $f) -Destination $backupRoot } }
    if ($toolingPath) {
        $toolDest = Join-Path $backupRoot 'tooling'
        New-Item -ItemType Directory -Path $toolDest | Out-Null
        Get-ChildItem -LiteralPath $toolingPath -File -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $toolDest }
    } else { Write-LpEvent 'STEP' 'no -ToolingDir given: this backup holds no tooling folder' }
    if (-not (Test-LpSameHash (Get-LpSha256 (Join-Path $backupRoot 'Start-BillionContextProxy.ps1')) (Get-LpSha256OfBytes $launcherBytes))) { throw 'the launcher changed while it was being backed up' }
    $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $ctx.Record = [ordered]@{
        schema = 1; deploymentId = $deploymentId; createdAt = (Get-Date).ToString('o'); runtimeRoot = $root; port = $Port; taskName = $TaskName
        previous = $ctx.Previous
        candidate = [ordered]@{ releaseName = $ReleaseName; proxyPath = $newProxyPath; version = $CandidateVersion; commit = $CandidateCommit; sourceCommit = $CandidateSourceCommit; sha256 = $candidateSha }
        nodeModules = $nodeModules; configSha256 = $ExpectedConfigSha256.ToUpperInvariant()
        launcherSha256Before = Get-LpSha256OfBytes $launcherBytes; launcherSha256After = Get-LpSha256OfBytes $editedBytes
        deployProcess = [ordered]@{ pid = $PID; created = $self.CreationDate.ToString('o') }
        created = [ordered]@{ releaseDir = $true; backupDir = $true }; stage = 'prepared'; reachedStage = 'prepared'
    }
    Save-LpRecord $ctx
    Write-LpEvent 'BACKUP' $backupRoot
    $r = Invoke-LpLauncherDryRun $editedBytes $root
    if ($r.ExitCode -ne 0 -or $r.Action -ne 'conflict') { throw "with the new release in place the edited launcher decided '$($r.Action)' (exit $($r.ExitCode)); expected 'conflict' while the current release is still serving" }
    if (-not (Test-LpSameTask (Get-LiveProxyTaskInfo $TaskName) $ctx.TaskBaseline)) { throw 'the scheduled task was changed after preflight' }
    Set-LpStage $ctx 'holding'
    try { New-LpInhibit $ctx 'deploy' } catch { throw "maintenance.inhibit could not be created ($($_.Exception.Message)); other maintenance may have started" }
} catch {
    $note = ''
    try { if ($ctx.RecordPath -and (Test-Path -LiteralPath $ctx.RecordPath)) { Set-LpStage $ctx 'aborted' } } catch { $note = ' The deployment record could not be marked aborted.' }
    try { if ($createdRelease) { Remove-CreatedRelease $newRoot } } catch { $note += " $($_.Exception.Message)." }
    Complete-Lp $ctx ([LpStop]::new(6, 'error-before-hold', "stopped before the hold: $($_.Exception.Message). Nothing running was changed.$note", '', 'fix the problem and run again; the backup folder was kept for the record')) 'result.json'
}

# ---- hold window: from here until the candidate is healthy, every error is rolled back ------------
$reason = 'cutover-failed'
try {
    Disable-LiveProxyTask $TaskName
    Stop-LpProcessVerified $supervisorProcess
    Assert-LpNoSupervisor $ctx 'after the hold'
    $h = Get-LpHealth $Port
    if (-not $h.ok -or $h.version -cne $ctx.Previous.version -or $h.commit -cne $ctx.Previous.commit) { throw 'the current release stopped answering after the supervisor was stopped' }
    Write-LpEvent 'STEP' 'hold applied: inhibit set, task disabled, supervisor stopped; current release still healthy'

    if (-not (Test-LpSameHash (Get-LpSha256 $ctx.LauncherPath) $ctx.Record.launcherSha256Before)) {
        Stop-LpRollbackFailed $ctx 'launcher edit: the launcher was changed by someone else after preflight; it was left as found' 'foreign-launcher-edit'
    }
    # Nothing has been changed yet: if the inhibit is no longer this run's, someone else's maintenance has begun.
    if (-not (Test-LpOwnInhibit $ctx)) { throw 'maintenance.inhibit is no longer the one this run created' }
    Set-LpStage $ctx 'held'
    Write-LpBytesAtomic $ctx.LauncherPath $editedBytes
    Write-LpEvent 'STEP' "launcher updated: $($edit.Changed -join ', ')"

    if ((Get-LpClientCount $ctx) -gt 0) { $reason = 'not-idle'; throw 'a client connected during preparation: not idle, standing down' }

    Set-LpStage $ctx 'cut'
    Stop-LpProcessVerified $listenerProcess
    if (-not (Wait-LpUntil { @(Get-LpListenerPids $Port).Count -eq 0 } $StopWaitSeconds 'waiting for the port')) { throw 'the port was not released' }
    Write-LpEvent 'STEP' 'current release stopped, port released'
    Remove-LpHold $ctx
    $gap = Test-LpSuccess $ctx $ctx.Candidate
    if ($null -ne $gap) { throw "the new release is not healthy under supervision: $gap" }
    Write-LpEvent 'STEP' "new release healthy under supervision: $CandidateVersion, $CandidateCommit"
} catch [LpStop] {
    Complete-Lp $ctx $_.Exception 'result.json'
} catch {
    $holdOnly = -not (Test-LpReached $ctx 'held')
    if ($holdOnly) { $reason = 'hold-failed' }
    Write-LpEvent 'STEP' "FAILED: $($_.Exception.Message); rolling back"
    try {
        Invoke-LpRollback $ctx $launcherBytes @{} $holdOnly
        # The previous release is live and checked from here on: a bookkeeping error must not read as a failed rollback.
        $note = ''
        try { Set-LpStage $ctx 'rolled-back' } catch { $note = ' The deployment record could not be updated.' }
        try { Remove-CreatedRelease $newRoot } catch { $note += " The release directory could not be removed: $($_.Exception.Message)." }
        $next = if ($reason -eq 'not-idle') { 'retry later with the same parameters, when no client is connected' } else { 'investigate the failure above before retrying' }
        Complete-Lp $ctx ([LpStop]::new(3, 'rolled-back', "nothing was deployed; the previous release is live under supervision.$note", $reason, $next)) 'result.json'
    } catch [LpStop] {
        Complete-Lp $ctx $_.Exception 'result.json'
    } catch {
        # Exit 4 always means the hold was re-applied and evidence was collected.
        try { Stop-LpRollbackFailed $ctx "unexpected error ($($_.Exception.Message))" 'rollback-error' } catch [LpStop] { Complete-Lp $ctx $_.Exception 'result.json' }
    }
}

# ---- receipts: the candidate is live; nothing from here on is rolled back --------------------------
$rollbackCommand = "pwsh -NoProfile -NonInteractive -File `"$(Join-Path $PSScriptRoot 'Rollback-LiveProxy.ps1')`" -RuntimeRoot `"$root`" -BackupRoot `"$backupRoot`""
$pending = [ordered]@{ $tunedPath = Join-Path $backupRoot 'tuned-deployment.pending.json'; $supervisionPath = Join-Path $backupRoot 'supervision-receipt.pending.json' }
$notReplaced = @($tunedPath, $supervisionPath)
try {
    Set-LpStage $ctx 'healthy'
    $live = Get-LpHealth $Port
    $launcherSha = Get-LpSha256 $ctx.LauncherPath
    $tuned = [System.Text.Json.Nodes.JsonNode]::Parse([System.IO.File]::ReadAllText($tunedPath)).AsObject()
    Set-JsonProp $tuned 'masterDeployedAt' ((Get-Date).ToString('o'))
    Set-JsonProp $tuned 'masterBackupRoot' $backupRoot
    Copy-JsonProp $tuned 'masterPreviousReleaseRoot' 'releaseRoot'
    Copy-JsonProp $tuned 'masterPreviousBuild' 'build'
    Copy-JsonProp $tuned 'masterPreviousBundleSha256' 'bundleSha256'
    Copy-JsonProp $tuned 'masterPreviousSourceCommit' 'sourceCommit'
    Set-JsonProp $tuned 'releaseRoot' $newRoot
    Set-JsonProp $tuned 'bundleSha256' $candidateSha['index.mjs']
    Set-JsonProp $tuned 'build' $CandidateCommit
    Set-JsonProp $tuned 'previousBuild' $ctx.Previous.commit
    Set-JsonProp $tuned 'sourceCommit' $CandidateSourceCommit
    Set-JsonProp $tuned 'livePid' ([int]$live.pid)
    Set-JsonProp $tuned 'verifiedAt' ((Get-Date).ToUniversalTime().ToString('o'))
    Set-JsonProp $tuned 'deployedSupervisorSha256' $launcherSha
    $changedText = if ($edit.Changed.Count -gt 1) { (($edit.Changed | Select-Object -SkipLast 1) -join ', ') + ' and ' + $edit.Changed[-1] } else { $edit.Changed[0] }
    $supervision = [System.Text.Json.Nodes.JsonNode]::Parse([System.IO.File]::ReadAllText($supervisionPath)).AsObject()
    $masterDeploy = [ordered]@{
        at = (Get-Date).ToString('o'); launcherSha256 = $launcherSha.ToLowerInvariant(); change = "$changedText defaults only"
        proxyRelease = "releases/$ReleaseName ($CandidateVersion, $CandidateCommit)"; backup = $backupRoot
    }
    Set-JsonProp $supervision 'masterDeploy' $masterDeploy
    $content = @{ $tunedPath = ConvertTo-JsonBytes $tuned; $supervisionPath = ConvertTo-JsonBytes $supervision }
    foreach ($path in $pending.Keys) { [System.IO.File]::WriteAllBytes($pending[$path], $content[$path]) }
    foreach ($path in @($tunedPath, $supervisionPath)) {
        Write-LpBytesAtomic $path $content[$path]
        $notReplaced = @($notReplaced | Where-Object { $_ -ne $path })
    }
    Set-LpStage $ctx 'receipts-written'
    Write-LpEvent 'STEP' 'receipts updated'
} catch {
    $names = ($notReplaced | ForEach-Object { [System.IO.Path]::GetFileName($_) }) -join ', '
    $copies = ($notReplaced | Where-Object { Test-Path -LiteralPath $pending[$_] } | ForEach-Object { "Copy-Item -LiteralPath `"$($pending[$_])`" -Destination `"$_`" -Force" }) -join '; '
    if (-not $copies) { $copies = 'the pending receipt files were not written; update the receipts by hand' }
    Complete-Lp $ctx ([LpStop]::new(5, 'deployed-receipts-incomplete', "the new release is live under supervision, but not every receipt was updated ($names): $($_.Exception.Message)", '', "finish the receipts: $copies. Then run the step 7 checks. To roll back instead: $rollbackCommand")) 'result.json'
}
Complete-Lp $ctx ([LpStop]::new(0, 'deployed', "deployed $CandidateVersion, $CandidateCommit (source $CandidateSourceCommit) as releases\$ReleaseName", '', "run the step 7 checks now. If they fail, roll back with: $rollbackCommand")) 'result.json'
