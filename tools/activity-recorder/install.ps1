# activity-recorder / install.ps1
# Registers the scheduled task "ActivityRecorder" (run at logon of the current
# user, auto restart on failure, no elevation). ASCII only / PowerShell 5.1.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   ... -NoStart        register only, do not start it now
#
# Primary path : Register-ScheduledTask (ScheduledTasks module, needs write
#                access to the task store).
# Fallback     : schtasks /Create /SC ONLOGON (works for a normal user without
#                admin). The /SC form cannot express restart-on-failure, so an
#                extra Set-ScheduledTask is attempted afterwards to add it.

param(
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ActivityRecorder'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Recorder = Join-Path $Here 'recorder.ps1'
$DataDir = Join-Path $env:LOCALAPPDATA 'activity-log'

if (-not (Test-Path -LiteralPath $Recorder)) {
    throw ('recorder.ps1 not found next to install.ps1: ' + $Recorder)
}

$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PsExe)) {
    throw ('powershell.exe not found: ' + $PsExe)
}

$ArgLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Recorder + '"'
$FullCmd = '"' + $PsExe + '" ' + $ArgLine
$User = [string]$env:USERNAME
$UserDomain = [string]$env:USERDOMAIN
$UserId = $UserDomain + '\' + $User

Write-Host '=== ActivityRecorder install ==='
Write-Host ('task name   : ' + $TaskName)
Write-Host ('recorder    : ' + $Recorder)
Write-Host ('powershell  : ' + $PsExe)
Write-Host ('argument    : ' + $ArgLine)
Write-Host ('data dir    : ' + $DataDir)
Write-Host ('user        : ' + $UserId)
Write-Host ''

# ------------------------------------------------------------ remove old
$existing = $null
try { $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $existing = $null }
if ($existing -ne $null) {
    Write-Host 'existing task found, removing it first'
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host '  removed via Unregister-ScheduledTask'
    } catch {
        Write-Host ('  Unregister-ScheduledTask failed: ' + $_.Exception.Message)
    }
}
try {
    $null = & schtasks /Query /TN $TaskName 2>&1
    if ($LASTEXITCODE -eq 0) {
        $null = & schtasks /Delete /TN $TaskName /F 2>&1
        Write-Host ('  removed via schtasks (exit ' + $LASTEXITCODE + ')')
    }
} catch { }

# ------------------------------------------------------------ primary path
$Method = ''
$SettingsObj = $null
try {
    $action = New-ScheduledTaskAction -Execute $PsExe -Argument $ArgLine
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    $SettingsObj = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $SettingsObj -Description 'Foreground window activity recorder, 72h rolling jsonl log' -ErrorAction Stop | Out-Null
    $Method = 'Register-ScheduledTask'
} catch {
    Write-Host ('Register-ScheduledTask failed: ' + $_.Exception.Message)
    Write-Host 'falling back to schtasks /Create /SC ONLOGON'
    $tr = '"' + $FullCmd + '"'
    $out = & schtasks /Create /SC ONLOGON /TN $TaskName /TR $tr /RL LIMITED /F 2>&1
    $code = $LASTEXITCODE
    foreach ($o in $out) { Write-Host ('  ' + [string]$o) }
    if ($code -ne 0) {
        throw ('schtasks fallback failed with exit code ' + $code)
    }
    $Method = 'schtasks /Create /SC ONLOGON'
    # try to add the restart-on-failure policy that /SC cannot express
    try {
        if ($SettingsObj -eq $null) {
            $SettingsObj = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
        }
        Set-ScheduledTask -TaskName $TaskName -Settings $SettingsObj -ErrorAction Stop | Out-Null
        Write-Host '  restart-on-failure settings applied via Set-ScheduledTask'
    } catch {
        Write-Host ('  could not apply restart settings: ' + $_.Exception.Message)
    }
}

Write-Host ''
Write-Host ('registered via : ' + $Method)

# ------------------------------------------------------------ verify
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host ('state          : ' + $task.State)
Write-Host ('actions        : ' + (($task.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join ' | '))
Write-Host ('triggers       : ' + (($task.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '))
Write-Host ('principal      : ' + $task.Principal.UserId + ' runlevel=' + $task.Principal.RunLevel + ' logontype=' + $task.Principal.LogonType)
Write-Host ('settings       : execTimeLimit=' + $task.Settings.ExecutionTimeLimit + ' restartCount=' + $task.Settings.RestartCount + ' restartInterval=' + $task.Settings.RestartInterval + ' multiInstance=' + $task.Settings.MultipleInstances)
Write-Host ('                 disallowStartIfOnBatteries=' + $task.Settings.DisallowStartIfOnBatteries + ' stopIfGoingOnBatteries=' + $task.Settings.StopIfGoingOnBatteries)
Write-Host ''

if ($NoStart) {
    Write-Host 'start skipped (-NoStart)'
    exit 0
}

Write-Host 'starting task...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 20

$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ('LastRunTime    : ' + $info.LastRunTime)
Write-Host ('LastTaskResult : ' + $info.LastTaskResult)
Write-Host ('NumberOfMissedRuns : ' + $info.NumberOfMissedRuns)
Write-Host ''

$procs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*recorder.ps1*' }
if ($procs) {
    foreach ($p in $procs) {
        Write-Host ('running pid=' + $p.ProcessId + ' cmd=' + $p.CommandLine)
    }
} else {
    Write-Host 'no running recorder process found'
}

if (Test-Path -LiteralPath $DataDir) {
    Write-Host ''
    Write-Host 'data dir contents:'
    Get-ChildItem -LiteralPath $DataDir | ForEach-Object {
        Write-Host ('  ' + $_.Name + '  ' + $_.Length + ' bytes')
    }
} else {
    Write-Host ('data dir missing: ' + $DataDir)
}
