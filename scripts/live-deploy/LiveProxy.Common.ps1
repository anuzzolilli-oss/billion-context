# Shared functions for Deploy-LiveProxy.ps1 and Rollback-LiveProxy.ps1 (dot-sourced; PowerShell 7).
# Procedure: reference/cindy-project.md, "Deploy only with an explicit request".
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:LpUtf8 = [System.Text.UTF8Encoding]::new($false)
$script:LpPollMs = 500
$script:LpSeam = $false
$script:LpRoot = $null
$script:LpStages = @('prepared', 'aborted', 'holding', 'held', 'cut', 'healthy', 'receipts-written', 'rolling-back', 'rolled-back', 'rollback-failed')
$script:LpForwardStages = @('prepared', 'holding', 'held', 'cut', 'healthy', 'receipts-written')
$script:LpPatterns = @{
    Version      = '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$'
    Commit       = '^[0-9a-f]{7,12}(-[a-z0-9]+)?$'
    SourceCommit = '^[0-9a-f]{40}$'
    Sha256       = '^[0-9A-Fa-f]{64}$'
    ReleaseName  = '^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$'
}

# A planned stop: carries the exit code, result name, optional reason and the NEXT line.
class LpStop : System.Exception {
    [int]$Code
    [string]$Name
    [string]$Reason
    [string]$Next
    LpStop([int]$code, [string]$name, [string]$message, [string]$reason, [string]$next) : base($message) {
        $this.Code = $code; $this.Name = $name; $this.Reason = $reason; $this.Next = $next
    }
}

function Write-LpEvent([string]$Kind, [string]$Text) {
    Write-Host ("{0} {1} {2}" -f (Get-Date).ToString('o'), $Kind, $Text)
}

# ---- paths -------------------------------------------------------------------------------------

if (-not ('LpNative' -as [type])) {
    Add-Type -Namespace '' -Name 'LpNative' -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern uint GetLongPathName(string shortPath, System.Text.StringBuilder longPath, uint bufferLength);
'@
}

# Absolute, long-form spelling of an existing path. One string, used everywhere afterwards.
function Resolve-LpPath([string]$Path) {
    if (-not [System.IO.Path]::IsPathRooted($Path)) { throw "path is not absolute: $Path" }
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $full)) { throw "path does not exist: $Path" }
    $sb = [System.Text.StringBuilder]::new(1024)
    $n = [LpNative]::GetLongPathName($full, $sb, [uint32]$sb.Capacity)
    if ($n -gt 0 -and $n -lt $sb.Capacity) { $full = $sb.ToString().TrimEnd('\') }
    return $full
}

# True when the path itself or any parent folder is a junction, symbolic link or other reparse point.
function Test-LpReparseInPath([string]$Path) {
    $p = $Path
    while ($p) {
        if (Test-Path -LiteralPath $p) {
            $item = Get-Item -LiteralPath $p -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $true }
        }
        $parent = [System.IO.Path]::GetDirectoryName($p)
        if (-not $parent -or $parent -eq $p) { break }
        $p = $parent
    }
    return $false
}

function Test-LpReparsePoint([string]$Path) {
    return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function ConvertTo-LpComparablePath([string]$Path) {
    $p = $Path -replace '/', '\'
    if ($p.StartsWith('\\?\')) { $p = $p.Substring(4) }
    return $p.TrimEnd('\')
}

# True when $Child is $Parent or lies below it. Pure string comparison on comparable forms.
function Test-LpPathWithin([string]$Child, [string]$Parent) {
    $c = ConvertTo-LpComparablePath $Child
    $p = ConvertTo-LpComparablePath $Parent
    if ($c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# Pure guard for the test seam: is this runtime root inside the live installation area?
# The caller supplies both forms of the root (as given and long form) and the roaming base.
function Test-LpLiveArea([string[]]$RootForms, [string]$RoamingBase) {
    $area = (ConvertTo-LpComparablePath $RoamingBase) + '\CindyGlobal'
    foreach ($form in $RootForms) { if (Test-LpPathWithin $form $area) { return $true } }
    return $false
}

function Get-LpRelative([string]$Path) {
    if ($script:LpRoot -and (Test-LpPathWithin $Path $script:LpRoot)) {
        $rest = (ConvertTo-LpComparablePath $Path).Substring((ConvertTo-LpComparablePath $script:LpRoot).Length).TrimStart('\')
        if ($rest) { return $rest } else { return '.' }
    }
    return $Path
}

function Test-LpSafeText([string]$Value) {
    if ($null -eq $Value) { return $false }
    foreach ($ch in $Value.ToCharArray()) {
        if ([int]$ch -gt 126 -or [int]$ch -lt 32) { return $false }
        if ($ch -eq "'" -or $ch -eq '`' -or $ch -eq '$') { return $false }
    }
    return $true
}

# ---- hashing and atomic writes -----------------------------------------------------------------

function Get-LpSha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant() }

function Get-LpSha256OfBytes([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '').ToUpperInvariant() } finally { $sha.Dispose() }
}

function Test-LpSameHash([string]$A, [string]$B) { return [string]::Equals($A, $B, [System.StringComparison]::OrdinalIgnoreCase) }

# Write to a temporary file beside the target, verify, then rename over the target.
function Write-LpBytesAtomic([string]$Path, [byte[]]$Bytes) {
    $tmp = "$Path.lp-tmp"
    [System.IO.File]::WriteAllBytes($tmp, $Bytes)
    try {
        if (-not (Test-LpSameHash (Get-LpSha256 $tmp) (Get-LpSha256OfBytes $Bytes))) { throw "temporary file for $(Get-LpRelative $Path) does not match what was written" }
        [System.IO.File]::Move($tmp, $Path, $true)
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-LpSameHash (Get-LpSha256 $Path) (Get-LpSha256OfBytes $Bytes))) { throw "$(Get-LpRelative $Path) does not match what was written" }
}

function Write-LpJsonAtomic([string]$Path, $Object) {
    Write-LpBytesAtomic $Path ($script:LpUtf8.GetBytes(($Object | ConvertTo-Json -Depth 6)))
}

# ---- launcher text -----------------------------------------------------------------------------

# Reads the release identity defaults out of the launcher text. Throws when a line is missing or repeated.
function Read-LpLauncherIdentity([string]$Text) {
    $lines = $Text -split "`n"
    $shapes = [ordered]@{
        ProxyPath       = '^(\s*)\[string\]\$ProxyPath = ''([^'']*)'',(\r?)$'
        ExpectedCommit  = '^(\s*)\[string\]\$ExpectedCommit = ''([^'']*)'',(\r?)$'
        ExpectedVersion = '^(\s*)\[string\]\$ExpectedVersion = ''([^'']*)'',(\r?)$'
        Port            = '^(\s*)\[int\]\$Port = (\d+),(\r?)$'
    }
    $found = @{}
    foreach ($name in $shapes.Keys) {
        $hits = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $shapes[$name]) { [pscustomobject]@{ Index = $i; Indent = $Matches[1]; Value = $Matches[2]; Cr = $Matches[3] } } })
        if ($hits.Count -ne 1) { throw "launcher has $($hits.Count) lines defining $name, expected exactly one" }
        $found[$name] = $hits[0]
    }
    return $found
}

# Returns the edited text and the names of the defaults that changed.
function New-LpEditedLauncher([string]$Text, [string]$ProxyPath, [string]$Commit, [string]$Version) {
    $id = Read-LpLauncherIdentity $Text
    $lines = $Text -split "`n"
    $changed = @()
    $want = [ordered]@{ ProxyPath = $ProxyPath; ExpectedCommit = $Commit; ExpectedVersion = $Version }
    foreach ($name in $want.Keys) {
        $line = $id[$name]
        if ($line.Value -ceq $want[$name]) { continue }
        $lines[$line.Index] = "$($line.Indent)[string]`$$name = '$($want[$name])',$($line.Cr)"
        $changed += $name
    }
    $new = $lines -join "`n"
    # Positional comparison: nothing but the intended lines may differ.
    $old = $Text -split "`n"
    $diff = @(for ($i = 0; $i -lt $old.Count; $i++) { if ($old[$i] -cne $lines[$i]) { $i } })
    if ($old.Count -ne $lines.Count -or $diff.Count -ne $changed.Count) { throw "launcher edit would change $($diff.Count) lines, expected $($changed.Count)" }
    return @{ Text = $new; Changed = $changed }
}

function Test-LpPlainAscii([byte[]]$Bytes) {
    foreach ($b in $Bytes) { if ($b -gt 127) { return $false } }
    return $true
}

# Runs launcher text under Windows PowerShell with -ReportOnly, from a private temporary folder.
function Invoke-LpLauncherDryRun([byte[]]$LauncherBytes, [string]$RuntimeRoot) {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("lp-dryrun-" + [System.Guid]::NewGuid().ToString('N'))
    [void][System.IO.Directory]::CreateDirectory($dir)
    try {
        $file = Join-Path $dir 'launcher-candidate.ps1'
        [System.IO.File]::WriteAllBytes($file, $LauncherBytes)
        $want = Get-LpSha256OfBytes $LauncherBytes
        if (-not (Test-LpSameHash (Get-LpSha256 $file) $want)) { throw 'dry-run copy of the launcher does not match' }
        $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $ps)) { throw 'Windows PowerShell was not found' }
        if (-not (Test-LpSameHash (Get-LpSha256 $file) $want)) { throw 'dry-run copy of the launcher changed before it ran' }
        $out = (& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $file -RuntimeRoot $RuntimeRoot -ReportOnly 2>&1 | Out-String)
        $code = $LASTEXITCODE
        $action = $null
        foreach ($line in ($out -split "`r?`n")) {
            $t = $line.Trim()
            if ($t.StartsWith('{') -and $t.EndsWith('}')) {
                try { $j = $t | ConvertFrom-Json; if ($j.PSObject.Properties['action']) { $action = [string]$j.action } } catch { }
            }
        }
        return @{ ExitCode = $code; Action = $action }
    } finally {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---- probes (inspection errors propagate; they never read as "free" or "idle") -------------------

function Get-LpConnections([int]$Port, [int]$State) {
    return @(Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "LocalPort=$Port AND State=$State" -OperationTimeoutSec 15 -ErrorAction Stop)
}
# PowerShell unrolls a one-item list on return: callers wrap these calls in @( ) before counting.
function Get-LpListenerPids([int]$Port) { return @(Get-LpConnections $Port 2 | Select-Object -ExpandProperty OwningProcess -Unique) }
# Open client connections to the port. A client is a loopback connection whose owning process is neither
# this script nor the supervisor (both only probe health); the client side of each connection names its owner.
function Get-LpClientCount($Ctx) {
    $own = @([int]$PID) + @(Get-LpSupervisors $Ctx | ForEach-Object { [int]$_.ProcessId })
    $rows = @(Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "RemotePort=$($Ctx.Port) AND State=5" -OperationTimeoutSec 15 -ErrorAction Stop)
    return @($rows | Where-Object { @('127.0.0.1', '::1') -contains [string]$_.RemoteAddress -and $own -notcontains [int]$_.OwningProcess }).Count
}

# Processes of one image whose command line contains the given text. The text names how the process was
# started, not just a path: a process that merely receives the path as an argument does not match.
function Get-LpProcesses([string]$ImageName, [string]$Needle) {
    return @(Get-CimInstance Win32_Process -Filter "Name='$ImageName'" -OperationTimeoutSec 15 -ErrorAction Stop |
        Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
}
# The supervisor is Windows PowerShell running the launcher as its -File script.
function Get-LpSupervisors($Ctx) { return @(Get-LpProcesses 'powershell.exe' ('-File "' + $Ctx.LauncherPath + '"')) }
# A proxy is node running the bundle as its entry point: "<node>" "<bundle>" start ...
function Get-LpProxies([string]$ProxyPath) {
    $needle = '" "' + $ProxyPath + '" start '
    return @(Get-LpProcesses 'node.exe' $needle | Where-Object { $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -eq $_.CommandLine.IndexOf('" "', [System.StringComparison]::Ordinal) })
}

# Stops the process that was matched. One handle is opened, its start time is compared with the matched
# process, and the same handle is used to stop it, so a PID reused in between cannot be hit.
function Stop-LpProcessVerified($Process) {
    $p = $null
    try { $p = [System.Diagnostics.Process]::GetProcessById([int]$Process.ProcessId) } catch [System.ArgumentException] { return }
    try {
        try {
            $null = $p.SafeHandle
            $started = $p.StartTime.ToUniversalTime()
        } catch {
            if ($p.HasExited) { return }
            throw
        }
        if ([Math]::Abs(($started - $Process.CreationDate.ToUniversalTime()).TotalSeconds) -ge 1) { throw "pid $($Process.ProcessId) now belongs to a different process; not stopping it" }
        try { $p.Kill() } catch { if (-not $p.HasExited) { throw } }
    } finally {
        $p.Dispose()
    }
}

function Wait-LpUntil([scriptblock]$Condition, [int]$Seconds, [string]$What) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $nextNote = 10
    while ($true) {
        if (& $Condition) { return $true }
        if ($watch.Elapsed.TotalSeconds -ge $Seconds) { return $false }
        if ($watch.Elapsed.TotalSeconds -ge $nextNote) { Write-LpEvent 'WAIT' "$What ($([int]$watch.Elapsed.TotalSeconds) of $Seconds s)"; $nextNote += 10 }
        Start-Sleep -Milliseconds $script:LpPollMs
    }
}

function Get-LpHealth([int]$Port) {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__bili/health" -TimeoutSec 5 -NoProxy -MaximumRedirection 0
        return [pscustomobject]@{ ok = ($h.ok -eq $true); version = [string]$h.version; commit = [string]$h.commit; pid = [string]$h.pid; error = $null }
    } catch {
        return [pscustomobject]@{ ok = $false; version = ''; commit = ''; pid = ''; error = $_.Exception.GetType().Name }
    }
}
function Format-LpHealth($Health) {
    if ($Health.error) { return "unreadable ($($Health.error))" }
    return "ok=$($Health.ok) version=$($Health.version) commit=$($Health.commit) pid=$($Health.pid)"
}

# One probe of the installation lock. Opens the existing file only; never creates it.
function Test-LpLockHeld([string]$LockPath) {
    if (-not (Test-Path -LiteralPath $LockPath)) { return $false }
    try {
        $s = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $s.Dispose()
        return $false
    } catch [System.IO.IOException] {
        return $true
    }
}

# ---- scheduled task (default driver; a test driver may replace these four functions) -------------

function Get-LpTaskObjects([string]$TaskName) { return @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $TaskName }) }
function Get-LiveProxyTaskInfo([string]$TaskName) {
    $t = @(Get-LpTaskObjects $TaskName)
    if ($t.Count -ne 1) { return [pscustomobject]@{ Count = $t.Count; Enabled = $false; Execute = ''; ActionArguments = ''; TriggerCount = 0 } }
    $a = @($t[0].Actions)
    return [pscustomobject]@{
        Count = 1; Enabled = [bool]$t[0].Settings.Enabled
        Execute = [string]($a | Select-Object -First 1).Execute; ActionArguments = (($a | ForEach-Object { [string]$_.Arguments }) -join ' | ')
        TriggerCount = @($t[0].Triggers).Count
    }
}
# Reason the task cannot be the one that runs this launcher, or $null. The action must be Windows PowerShell
# with the launcher as its -File script; a path that merely starts with the launcher path does not count.
function Get-LpTaskActionGap($Task, [string]$LauncherPath) {
    if ([System.IO.Path]::GetFileName([string]$Task.Execute) -ine 'powershell.exe') { return 'the task action is not Windows PowerShell (powershell.exe)' }
    if (([string]$Task.ActionArguments).IndexOf('-File "' + $LauncherPath + '"', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return 'the task action does not run the launcher in this runtime root' }
    return $null
}
function Test-LpSameTask($A, $B) {
    return ($A.Count -eq $B.Count -and $A.Enabled -eq $B.Enabled -and $A.Execute -eq $B.Execute -and $A.ActionArguments -eq $B.ActionArguments -and $A.TriggerCount -eq $B.TriggerCount)
}
function Disable-LiveProxyTask([string]$TaskName) { Get-LpTaskObjects $TaskName | Disable-ScheduledTask -ErrorAction Stop | Out-Null }
function Enable-LiveProxyTask([string]$TaskName) { Get-LpTaskObjects $TaskName | Enable-ScheduledTask -ErrorAction Stop | Out-Null }
function Start-LiveProxyTask([string]$TaskName) { Get-LpTaskObjects $TaskName | Start-ScheduledTask -ErrorAction Stop }

# Decides which task driver may be used for this runtime root. Returns the driver path to dot-source, or $null.
function Resolve-LpTaskDriver([string]$RootAsGiven, [string]$RootResolved, [string]$TestTaskDriver) {
    $marked = Test-Path -LiteralPath (Join-Path $RootResolved 'sandbox.marker')
    if (-not $TestTaskDriver) {
        if ($marked) { throw 'this runtime root is a test sandbox (sandbox.marker is present): the real scheduled task may not be used with it' }
        return $null
    }
    if (-not $marked) { throw '-TestTaskDriver is accepted only for a test sandbox (sandbox.marker is absent)' }
    $roaming = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ApplicationData)
    if (Test-LpLiveArea @($RootAsGiven, $RootResolved) $roaming) { throw '-TestTaskDriver is refused for a runtime root inside the live installation area' }
    $driver = Resolve-LpPath $TestTaskDriver
    if ((Get-Item -LiteralPath $driver -Force).PSIsContainer -or (Test-LpReparseInPath $driver)) { throw '-TestTaskDriver must be a regular file with no link in its path' }
    $script:LpSeam = $true
    return $driver
}

# ---- one operation at a time ---------------------------------------------------------------------

# Deploy and rollback hold this lock from before their checks until the process ends, so two runs for the
# same runtime root cannot interleave. The file is removed when the handle closes, also if the process dies.
function Enter-LpOperation([string]$Root) {
    $path = Join-Path $Root 'live-deploy.lock'
    try {
        $script:LpOperationLock = [System.IO.FileStream]::new($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose)
    } catch [System.IO.IOException] {
        throw 'another deploy or rollback is running for this runtime root'
    }
}

# ---- hold and lift -----------------------------------------------------------------------------

function Get-LpInhibitText($Ctx) {
    if (-not (Test-Path -LiteralPath $Ctx.InhibitPath)) { return $null }
    return ([System.IO.File]::ReadAllText($Ctx.InhibitPath)).Trim()
}
function Test-LpOwnInhibit($Ctx) {
    $t = Get-LpInhibitText $Ctx
    return ($null -ne $t -and ($t -ceq "deploy $($Ctx.DeploymentId)" -or $t -ceq "rollback $($Ctx.DeploymentId)"))
}

# Creates the inhibit file; fails when one exists (create-new).
function New-LpInhibit($Ctx, [string]$Verb) {
    $bytes = $script:LpUtf8.GetBytes("$Verb $($Ctx.DeploymentId)")
    $s = [System.IO.File]::Open($Ctx.InhibitPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $written = $false
    try {
        $s.Write($bytes, 0, $bytes.Length)
        $s.Flush($true)
        $written = $true
    } finally {
        $s.Dispose()
        # The file exists only because this call created it: a marker without its owner text must not stay.
        if (-not $written) { Remove-Item -LiteralPath $Ctx.InhibitPath -Force -ErrorAction SilentlyContinue }
    }
}

function Assert-LpNoSupervisor($Ctx, [string]$When) {
    $free = Wait-LpUntil { @(Get-LpSupervisors $Ctx).Count -eq 0 } $Ctx.StopWait 'waiting for the supervisor to stop'
    if (-not $free) { throw "a supervisor is still running $When" }
    if (Test-LpLockHeld $Ctx.LockPath) { throw "the installation lock is still held $When" }
}

# Hold used by rollback: tolerates zero supervisors, does not check health.
function Set-LpRollbackHold($Ctx) {
    $text = Get-LpInhibitText $Ctx
    if ($null -eq $text) { New-LpInhibit $Ctx 'rollback' }
    elseif (-not (Test-LpOwnInhibit $Ctx)) { throw 'maintenance.inhibit belongs to other maintenance' }
    Disable-LiveProxyTask $Ctx.TaskName
    foreach ($s in (Get-LpSupervisors $Ctx)) { Stop-LpProcessVerified $s }
    Assert-LpNoSupervisor $Ctx 'under the rollback hold'
    Write-LpEvent 'STEP' 'hold applied: inhibit set, task disabled, no supervisor'
}

function Remove-LpHold($Ctx) {
    Assert-LpNoSupervisor $Ctx 'before the hold is lifted'
    if (-not (Test-LpOwnInhibit $Ctx)) { throw 'maintenance.inhibit is no longer the one this run created; it was left as found' }
    Remove-Item -LiteralPath $Ctx.InhibitPath -Force
    $Ctx.LiftAt = (Get-Date).ToUniversalTime()
    Enable-LiveProxyTask $Ctx.TaskName
    Start-LiveProxyTask $Ctx.TaskName
    Write-LpEvent 'STEP' 'hold lifted: inhibit removed, task enabled and started'
}

# ---- success test (step 6 and step 9) -----------------------------------------------------------

# One evaluation. Returns $null when every condition holds, otherwise the first reason it does not.
function Get-LpSuccessGap($Ctx, $Identity) {
    $listeners = @(Get-LpListenerPids $Ctx.Port)
    if ($listeners.Count -ne 1) { return "listeners on the port: $($listeners.Count)" }
    $listener = [string]$listeners[0]
    $h = Get-LpHealth $Ctx.Port
    if (-not $h.ok -or $h.version -cne $Identity.version -or $h.commit -cne $Identity.commit -or $h.pid -ne $listener) { return "health $(Format-LpHealth $h), expected version=$($Identity.version) commit=$($Identity.commit) from pid $listener" }
    $proxies = @(Get-LpProxies $Identity.proxyPath)
    if ($proxies.Count -ne 1 -or [string]$proxies[0].ProcessId -ne $listener) { return "processes running the expected release: $($proxies.Count), listener pid $listener" }
    $sups = @(Get-LpSupervisors $Ctx)
    if ($sups.Count -ne 1) { return "supervisors: $($sups.Count)" }
    if (-not (Test-Path -LiteralPath $Ctx.StatusPath)) { return 'supervisor-status.json is absent' }
    # The supervisor rewrites this file every heartbeat; a read that lands on the rewrite is tried again.
    $st = $null
    foreach ($try in 1..5) {
        try { $st = [System.IO.File]::ReadAllText($Ctx.StatusPath) | ConvertFrom-Json -AsHashtable; break } catch { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $st) { return 'supervisor-status.json is unreadable' }
    $beat = $null
    try { $beat = ([datetime]$st['heartbeatAt']).ToUniversalTime() } catch { return 'supervisor-status.json has no heartbeat time' }
    if ($beat -le $Ctx.LiftAt) { return 'no supervisor heartbeat since the hold was lifted' }
    if ([string]$st['supervisorPid'] -ne [string]$sups[0].ProcessId) { return 'status file was written by another supervisor' }
    if (@('adopted', 'spawned') -notcontains [string]$st['state']) { return "supervisor state is $($st['state'])" }
    if ($st['healthMatch'] -ne $true) { return 'supervisor reports no health match' }
    if ($st['inhibit'] -eq $true) { return 'supervisor reports the inhibit' }
    if ([string]$st['childPid'] -ne $listener) { return 'supervisor monitors a process that is not the listener' }
    if (Test-Path -LiteralPath $Ctx.InhibitPath) { return 'maintenance.inhibit is present' }
    if (-not (Get-LiveProxyTaskInfo $Ctx.TaskName).Enabled) { return 'the task is not enabled' }
    if (-not (Test-LpSameHash (Get-LpSha256 $Ctx.ConfigPath) $Ctx.ConfigSha)) { return 'the configuration file changed' }
    return $null
}

# Polls the success test, then probes the lock once and compares the task with its baseline.
function Test-LpSuccess($Ctx, $Identity) {
    $gap = [ref]'not evaluated'
    $ok = Wait-LpUntil { $gap.Value = Get-LpSuccessGap $Ctx $Identity; $null -eq $gap.Value } $Ctx.HealthWait "waiting for $($Identity.commit) under supervision"
    if (-not $ok) { return $gap.Value }
    if (-not (Test-LpLockHeld $Ctx.LockPath)) { return 'the installation lock is not held' }
    $t = Get-LiveProxyTaskInfo $Ctx.TaskName
    $b = $Ctx.TaskBaseline
    if ($t.Count -ne 1 -or $t.Execute -ne $b.Execute -or $t.ActionArguments -ne $b.ActionArguments -or $t.TriggerCount -ne $b.TriggerCount) { return 'the scheduled task definition changed' }
    return $null
}

# ---- record, result, evidence -------------------------------------------------------------------

function Save-LpRecord($Ctx) { Write-LpJsonAtomic $Ctx.RecordPath $Ctx.Record }

function Set-LpStage($Ctx, [string]$Stage) {
    if ($script:LpForwardStages -contains $Stage) { $Ctx.Record.reachedStage = $Stage }
    $Ctx.Record.stage = $Stage
    Save-LpRecord $Ctx
}

function Test-LpReached($Ctx, [string]$Stage) {
    return ([array]::IndexOf($script:LpForwardStages, [string]$Ctx.Record.reachedStage) -ge [array]::IndexOf($script:LpForwardStages, $Stage))
}

function Write-LpEvidence($Ctx, [string]$FailingStep, [string[]]$HoldGaps) {
    $lines = [System.Collections.Generic.List[string]]::new()
    $add = { param($label, [scriptblock]$get) try { $lines.Add("${label}: $(& $get)") } catch { $lines.Add("${label}: could not be read ($($_.Exception.GetType().Name))") } }
    $lines.Add("failing step: $FailingStep")
    if ($HoldGaps.Count -gt 0) { $lines.Add("hold NOT fully in place: $($HoldGaps -join '; ')") } else { $lines.Add('hold in place: inhibit set, task disabled, no supervisor') }
    & $add 'health' { Format-LpHealth (Get-LpHealth $Ctx.Port) }
    & $add 'listener pids' { (Get-LpListenerPids $Ctx.Port) -join ',' }
    & $add 'supervisors' { ((Get-LpSupervisors $Ctx) | ForEach-Object { "pid $($_.ProcessId) created $($_.CreationDate.ToString('o'))" }) -join '; ' }
    foreach ($which in 'Previous', 'Candidate') {
        $path = $Ctx[$which].proxyPath
        & $add "$($which.ToLower()) release processes" { ((Get-LpProxies $path) | ForEach-Object { "pid $($_.ProcessId) created $($_.CreationDate.ToString('o'))" }) -join '; ' }
    }
    & $add 'inhibit' { $t = Get-LpInhibitText $Ctx; if ($null -eq $t) { 'absent' } else { "present ($t)" } }
    & $add 'task enabled' { (Get-LiveProxyTaskInfo $Ctx.TaskName).Enabled }
    & $add 'installation lock held' { Test-LpLockHeld $Ctx.LockPath }
    & $add 'launcher matches the pre-deployment launcher' { Test-LpSameHash (Get-LpSha256 $Ctx.LauncherPath) $Ctx.Record.launcherSha256Before }
    $lines.Add('logs to attach: supervisor.log, state\billion-context\bili.log')
    foreach ($l in $lines) { Write-LpEvent 'STEP' "evidence: $l" }
    try {
        $file = Join-Path $Ctx.BackupRoot ("evidence-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
        [System.IO.File]::WriteAllLines($file, $lines, $script:LpUtf8)
        return $file
    } catch { return $null }
}

# Re-applies the hold after a failed rollback and stops. Touches no proxy process.
function Stop-LpRollbackFailed($Ctx, [string]$FailingStep, [string]$Reason) {
    $gaps = @()
    try {
        $text = Get-LpInhibitText $Ctx
        if ($null -eq $text) { New-LpInhibit $Ctx 'rollback' } elseif (-not (Test-LpOwnInhibit $Ctx)) { $gaps += 'inhibit present but owned by other maintenance' }
    } catch { $gaps += 'inhibit could not be set' }
    try { Disable-LiveProxyTask $Ctx.TaskName } catch { $gaps += 'task could not be disabled' }
    try {
        foreach ($s in (Get-LpSupervisors $Ctx)) { Stop-LpProcessVerified $s }
        if (-not (Wait-LpUntil { @(Get-LpSupervisors $Ctx).Count -eq 0 } $Ctx.StopWait 'waiting for the supervisor to stop')) { $gaps += 'a supervisor is still running' }
    } catch { $gaps += 'supervisor could not be stopped' }
    try { Set-LpStage $Ctx 'rollback-failed' } catch { Write-LpEvent 'STEP' 'the deployment record could not be updated' }
    $file = Write-LpEvidence $Ctx $FailingStep $gaps
    $next = "report to the owner with $(if ($file) { $file } else { 'the evidence lines above' }); no release is confirmed live and no further start was attempted. To retry: Rollback-LiveProxy.ps1 -RuntimeRoot <root> -BackupRoot `"$($Ctx.BackupRoot)`". To lift the hold by hand if the owner judges the proxy fine: remove maintenance.inhibit, enable the task, start the task. A later deployment needs a new -ReleaseName."
    throw [LpStop]::new(4, 'rollback-failed', "rollback failed at: $FailingStep", $Reason, $next)
}

# Prints NEXT and RESULT, writes the result file, and ends the process.
function Complete-Lp($Ctx, [LpStop]$Stop, [string]$ResultFileName) {
    $seam = if ($script:LpSeam) { ' TEST SEAM ACTIVE' } else { '' }
    $reason = if ($Stop.Reason) { " reason=$($Stop.Reason)" } else { '' }
    if ($Stop.Message) { Write-LpEvent 'STEP' $Stop.Message }
    if ($Stop.Next) { Write-LpEvent 'NEXT' $Stop.Next }
    if ($Ctx -and $Ctx.BackupRoot -and $ResultFileName -and (Test-Path -LiteralPath $Ctx.BackupRoot)) {
        try {
            Write-LpJsonAtomic (Join-Path $Ctx.BackupRoot $ResultFileName) ([ordered]@{
                    result = $Stop.Name; exit = $Stop.Code; reason = $Stop.Reason; stage = $Ctx.Record.stage; backup = $Ctx.BackupRoot
                    previous = $Ctx.Previous; candidate = $Ctx.Candidate; at = (Get-Date).ToString('o')
                })
        } catch { Write-LpEvent 'STEP' 'the result file could not be written' }
    }
    Write-LpEvent 'RESULT' "$($Stop.Name) (exit $($Stop.Code))$reason$seam"
    exit $Stop.Code
}

# ---- rollback core (deploy-time and standalone) --------------------------------------------------

# $RestoreLauncherBytes: the pre-deployment launcher. $Receipts: @{ path = bytes } to restore, or empty.
# Returns normally when the previous release is healthy under supervision; otherwise throws LpStop 4.
function Invoke-LpRollback($Ctx, [byte[]]$RestoreLauncherBytes, [hashtable]$Receipts, [bool]$SkipHoldAndRestore) {
    Write-LpEvent 'ROLLBACK' "from $($Ctx.Candidate.releaseName) ($($Ctx.Candidate.version), $($Ctx.Candidate.commit)) to $($Ctx.Previous.version), $($Ctx.Previous.commit)"
    $step = 'rollback hold'
    try {
        if ($SkipHoldAndRestore) {
            $step = 'launcher check'
            if (-not (Test-LpSameHash (Get-LpSha256 $Ctx.LauncherPath) $Ctx.Record.launcherSha256Before)) { throw 'the launcher is not the pre-deployment launcher' }
        } else {
            Set-LpRollbackHold $Ctx
            $step = 'stop candidate release'
            $stopped = $false
            foreach ($p in (Get-LpProxies $Ctx.Candidate.proxyPath)) { Stop-LpProcessVerified $p; $stopped = $true }
            if ($stopped) {
                if (-not (Wait-LpUntil { @(Get-LpProxies $Ctx.Candidate.proxyPath).Count -eq 0 } $Ctx.StopWait 'waiting for the candidate release to stop')) { throw 'the candidate release did not stop' }
                if (@(Get-LpProxies $Ctx.Previous.proxyPath).Count -eq 0 -and -not (Wait-LpUntil { @(Get-LpListenerPids $Ctx.Port).Count -eq 0 } $Ctx.StopWait 'waiting for the port')) { throw 'the port was not released' }
                Write-LpEvent 'STEP' 'candidate release stopped'
            }
            $step = 'launcher restore'
            if (Test-LpSameHash (Get-LpSha256 $Ctx.LauncherPath) $Ctx.Record.launcherSha256Before) {
                Write-LpEvent 'STEP' 'launcher already is the pre-deployment launcher'
            } else {
                if (-not (Test-LpSameHash (Get-LpSha256 $Ctx.LauncherPath) $Ctx.Record.launcherSha256After)) {
                    Stop-LpRollbackFailed $Ctx 'launcher restore: the launcher is neither the saved nor the deployed one; it was changed by someone else and left as found' 'foreign-launcher-edit'
                }
                if (-not (Test-LpSameHash (Get-LpSha256OfBytes $RestoreLauncherBytes) $Ctx.Record.launcherSha256Before)) { throw 'the saved launcher does not match the deployment record' }
                Write-LpBytesAtomic $Ctx.LauncherPath $RestoreLauncherBytes
                Write-LpEvent 'STEP' 'launcher restored and verified'
            }
            $step = 'receipt restore'
            foreach ($path in $Receipts.Keys) {
                if ((Test-Path -LiteralPath $path -PathType Leaf) -and (Test-LpSameHash (Get-LpSha256 $path) (Get-LpSha256OfBytes $Receipts[$path]))) { continue }
                Write-LpBytesAtomic $path $Receipts[$path]
                Write-LpEvent 'STEP' "$(Get-LpRelative $path) restored and verified"
            }
        }
        $step = 'lift after rollback'
        if ($SkipHoldAndRestore) {
            # The hold was never completed: remove this deployment's inhibit and re-enable supervision as it was.
            if (Test-LpOwnInhibit $Ctx) { Remove-Item -LiteralPath $Ctx.InhibitPath -Force }
            $Ctx.LiftAt = (Get-Date).ToUniversalTime()
            Enable-LiveProxyTask $Ctx.TaskName
            Start-LiveProxyTask $Ctx.TaskName
            Write-LpEvent 'STEP' 'inhibit removed, task enabled and started'
        } else {
            Remove-LpHold $Ctx
        }
    } catch [LpStop] { throw } catch {
        Stop-LpRollbackFailed $Ctx "$step ($($_.Exception.Message))" 'rollback-error'
    }
    $gap = $null
    try { $gap = Test-LpSuccess $Ctx $Ctx.Previous } catch { $gap = "check failed ($($_.Exception.Message))" }
    if ($null -ne $gap) { Stop-LpRollbackFailed $Ctx "previous release check: $gap" 'previous-unhealthy' }
    Write-LpEvent 'STEP' "previous release healthy under supervision: $($Ctx.Previous.version), $($Ctx.Previous.commit)"
}
