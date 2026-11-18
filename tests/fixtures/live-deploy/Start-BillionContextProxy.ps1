param(
    [string]$RuntimeRoot = (Split-Path -Parent $PSCommandPath),
    [string]$NodePath = '__NODE__',
    [string]$ProxyPath = '__PROXY__',
    [int]$Port = 0,
    [string]$ExpectedVersion = '__VERSION__',
    [string]$ExpectedCommit = '__COMMIT__',
    [double]$PollSeconds = 0.3,
    [double]$HeartbeatSeconds = 0.4,
    [switch]$ReportOnly
)
# TEST STAND-IN for the live proxy supervisor. Written for tests/live-deploy-scripts.test.ts only; it is
# not the real launcher and is never installed. It honours the same contract the deploy scripts rely on:
# one supervisor per runtime root (exclusive lock), maintenance.inhibit suppresses adopt/start/restart,
# adopt a verified listener, start a proxy only when none matches and the port is free, otherwise do
# nothing, and report through supervisor-status.json. Runs under Windows PowerShell.
$ErrorActionPreference = 'Stop'
$inhibitPath = Join-Path $RuntimeRoot 'maintenance.inhibit'
$lockPath = Join-Path $RuntimeRoot 'supervisor.lock'
$statusPath = Join-Path $RuntimeRoot 'supervisor-status.json'
$configPath = Join-Path $RuntimeRoot 'config\billion-context\billion-context.json'
$proxyArgs = '"' + $ProxyPath + '" start --port ' + $Port + ' --host 127.0.0.1 --config "' + $configPath + '"'
$expectedCommandLine = '"' + $NodePath + '" ' + $proxyArgs
$started = (Get-Date).ToString('o')

function Get-Owners {
    return @(Get-CimInstance -Namespace ROOT/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "LocalPort=$Port AND State=2" -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
}
function Get-Matching {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.Trim() -ieq $expectedCommandLine })
}
function Test-Health([int]$expectPid) {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/__bili/health")
        $req.Proxy = $null; $req.KeepAlive = $false; $req.Timeout = 2000
        $resp = $req.GetResponse()
        try { $h = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json } finally { $resp.Close() }
        return (($h.ok -eq $true) -and ([string]$h.version -eq $ExpectedVersion) -and ([string]$h.commit -eq $ExpectedCommit) -and ([string]$h.pid -eq [string]$expectPid))
    } catch { return $false }
}
function Resolve-Decision {
    if (Test-Path -LiteralPath $inhibitPath) { return @{ action = 'inhibited' } }
    if (!(Test-Path -LiteralPath $NodePath) -or !(Test-Path -LiteralPath $ProxyPath)) { return @{ action = 'blocked' } }
    $owners = @(Get-Owners)
    $candidates = @(Get-Matching)
    if ($owners.Count -eq 0) {
        if ($candidates.Count -eq 0) { return @{ action = 'spawn' } }
        return @{ action = 'waiting' }
    }
    if ($owners.Count -ne 1) { return @{ action = 'conflict' } }
    $owner = [int]$owners[0]
    $match = @($candidates | Where-Object { $_.ProcessId -eq $owner })
    if ($match.Count -ne 1 -or $candidates.Count -ne 1) { return @{ action = 'conflict' } }
    if (!(Test-Health $owner)) { return @{ action = 'conflict' } }
    return @{ action = 'adopt'; pid = $owner }
}
function Write-Status([hashtable]$s) {
    try {
        $s.supervisorPid = $PID; $s.supervisorStarted = $started; $s.heartbeatAt = (Get-Date).ToString('o')
        $tmp = "$statusPath.tmp"
        [System.IO.File]::WriteAllText($tmp, ($s | ConvertTo-Json -Compress))
        if (Test-Path -LiteralPath $statusPath) { [System.IO.File]::Replace($tmp, $statusPath, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $statusPath) }
    } catch { }
}
# Test control: <runtime root>\status-control.json = { "<commit>": { "healthMatch": false, "childPid": 1 } }
# overrides what this supervisor reports for that release; the proxy and its health are not affected.
function Get-StatusOverride {
    try {
        $c = [System.IO.File]::ReadAllText((Join-Path $RuntimeRoot 'status-control.json')) | ConvertFrom-Json
        return $c.$ExpectedCommit
    } catch { return $null }
}
function Watch-Child($proc, [string]$mode) {
    $created = $proc.StartTime.ToString('o')
    while (!$proc.HasExited) {
        $s = @{ state = $mode; childPid = $proc.Id; childCreated = $created; healthMatch = (Test-Health $proc.Id); inhibit = (Test-Path -LiteralPath $inhibitPath) }
        $o = Get-StatusOverride
        if ($null -ne $o) { foreach ($p in $o.PSObject.Properties) { $s[$p.Name] = $p.Value } }
        Write-Status $s
        Start-Sleep -Milliseconds ([int]($HeartbeatSeconds * 1000))
    }
}

if ($ReportOnly) {
    try { Resolve-Decision | ConvertTo-Json -Compress; exit 0 } catch { @{ action = 'error' } | ConvertTo-Json -Compress; exit 2 }
}

try { $lockStream = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') } catch { exit 0 }
Add-Content -LiteralPath (Join-Path $RuntimeRoot 'sandbox-pids.log') -Value "$PID"

while ($true) {
    try {
        $d = Resolve-Decision
        if ($d.action -eq 'adopt') {
            $proc = [System.Diagnostics.Process]::GetProcessById([int]$d.pid)
            if (!(Test-Path -LiteralPath $inhibitPath)) { Watch-Child $proc 'adopted'; continue }
        } elseif ($d.action -eq 'spawn') {
            if (!(Test-Path -LiteralPath $inhibitPath) -and @(Get-Owners).Count -eq 0 -and @(Get-Matching).Count -eq 0) {
                $proc = Start-Process -FilePath $NodePath -ArgumentList $proxyArgs -WindowStyle Hidden -PassThru -WorkingDirectory $RuntimeRoot
                $null = $proc.Handle
                Watch-Child $proc 'spawned'
                continue
            }
        }
        Write-Status @{ state = $d.action }
    } catch {
        Write-Status @{ state = 'error' }
    }
    Start-Sleep -Milliseconds ([int]($PollSeconds * 1000))
}
