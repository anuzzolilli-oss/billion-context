# TEST DRIVER standing in for the Windows scheduled task, used only by tests/live-deploy-scripts.test.ts.
# The deploy scripts dot-source it when -TestTaskDriver is given and the runtime root is a marked sandbox.
# State lives in <runtime root>\sandbox-task.json:
#   { taskName, enabled, port, calls: { info, disable, enable, start },
#     execute, launcherSuffix,                  optional: what the task action claims to run
#     failOn: [ { op, call } ],                 the n-th call of that operation throws
#     onCall: [ { op, call, action } ] }        the n-th call first performs a fault action
# Actions: openClient, makeLauncherReadOnly, writeForeignInhibit, editLauncher, killSelf.

function Get-LpTestTaskStatePath { return (Join-Path $script:LpRoot 'sandbox-task.json') }
function Get-LpTestTaskState { return ([System.IO.File]::ReadAllText((Get-LpTestTaskStatePath)) | ConvertFrom-Json -AsHashtable) }
function Save-LpTestTaskState($State) { [System.IO.File]::WriteAllText((Get-LpTestTaskStatePath), ($State | ConvertTo-Json -Depth 6)) }
function Get-LpTestLauncher { return (Join-Path $script:LpRoot 'Start-BillionContextProxy.ps1') }
function Get-LpTestWindowsPowerShell { return (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') }

function Invoke-LpTestFault([string]$Op) {
    $s = Get-LpTestTaskState
    $s.calls[$Op] = [int]$s.calls[$Op] + 1
    Save-LpTestTaskState $s
    $n = $s.calls[$Op]
    foreach ($a in @($s.onCall)) {
        if ($null -eq $a -or $a.op -ne $Op -or [int]$a.call -ne $n) { continue }
        switch ([string]$a.action) {
            'openClient' {
                # A separate process holds a connection to the proxy port open, like a real client would.
                $cmd = "`$c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $([int]$s.port)); Start-Sleep -Seconds 120 # sandbox `"$script:LpRoot`""
                $p = Start-Process -FilePath (Get-LpTestWindowsPowerShell) -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $cmd) -WindowStyle Hidden -PassThru
                Add-Content -LiteralPath (Join-Path $script:LpRoot 'sandbox-pids.log') -Value "$($p.Id)"
                $ctxLike = @{ Port = [int]$s.port; LauncherPath = (Get-LpTestLauncher) }
                $null = Wait-LpUntil { (Get-LpClientCount $ctxLike) -gt 0 } 20 'waiting for the test client to connect'
            }
            'makeLauncherReadOnly' { Set-ItemProperty -LiteralPath (Get-LpTestLauncher) -Name IsReadOnly -Value $true }
            'writeForeignInhibit' { [System.IO.File]::WriteAllText((Join-Path $script:LpRoot 'maintenance.inhibit'), 'someone else') }
            'editLauncher' { Add-Content -LiteralPath (Get-LpTestLauncher) -Value '# foreign edit' }
            'killSelf' { Stop-Process -Id $PID -Force }
        }
    }
    foreach ($f in @($s.failOn)) {
        if ($null -ne $f -and $f.op -eq $Op -and [int]$f.call -eq $n) { throw "test driver: '$Op' refused (injected fault)" }
    }
}

function Get-LiveProxyTaskInfo([string]$TaskName) {
    Invoke-LpTestFault 'info'
    $s = Get-LpTestTaskState
    if ($TaskName -ne [string]$s.taskName) { return [pscustomobject]@{ Count = 0; Enabled = $false; Execute = ''; ActionArguments = ''; TriggerCount = 0 } }
    return [pscustomobject]@{
        Count = 1; Enabled = [bool]$s.enabled; Execute = $(if ($s['execute']) { [string]$s['execute'] } else { 'powershell.exe' })
        ActionArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Get-LpTestLauncher)$([string]$s['launcherSuffix'])`""; TriggerCount = 2
    }
}
function Disable-LiveProxyTask([string]$TaskName) {
    Invoke-LpTestFault 'disable'
    $s = Get-LpTestTaskState; $s.enabled = $false; Save-LpTestTaskState $s
}
function Enable-LiveProxyTask([string]$TaskName) {
    Invoke-LpTestFault 'enable'
    $s = Get-LpTestTaskState; $s.enabled = $true; Save-LpTestTaskState $s
}
function Start-LiveProxyTask([string]$TaskName) {
    Invoke-LpTestFault 'start'
    $s = Get-LpTestTaskState
    if (-not $s.enabled) { return }
    # The real task ignores a new start while an instance is running.
    if (Test-LpLockHeld (Join-Path $script:LpRoot 'supervisor.lock')) { return }
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Get-LpTestLauncher)`""
    Start-Process -FilePath (Get-LpTestWindowsPowerShell) -ArgumentList $arguments -WindowStyle Hidden | Out-Null
}
