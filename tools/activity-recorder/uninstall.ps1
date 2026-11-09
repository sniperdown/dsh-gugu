# activity-recorder / uninstall.ps1
# Removes the scheduled task and stops a running recorder. Data is kept unless
# -PurgeData is given. ASCII only / PowerShell 5.1.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#   ... -PurgeData

param(
    [switch]$PurgeData
)

$ErrorActionPreference = 'Continue'
$TaskName = 'ActivityRecorder'
$DataDir = Join-Path $env:LOCALAPPDATA 'activity-log'

Write-Host '=== ActivityRecorder uninstall ==='

# ------------------------------------------------------------ stop processes
$procs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*recorder.ps1*' }
if ($procs) {
    foreach ($p in $procs) {
        Write-Host ('stopping pid=' + $p.ProcessId)
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {
            Write-Host ('  stop failed: ' + $_.Exception.Message)
        }
    }
    Start-Sleep -Seconds 2
} else {
    Write-Host 'no running recorder process'
}

# ------------------------------------------------------------ remove task
$found = $false
try {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $found = $true
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host 'task removed via Unregister-ScheduledTask'
    } catch {
        Write-Host ('Unregister-ScheduledTask failed: ' + $_.Exception.Message)
    }
} catch {
    Write-Host 'task not found in the task store'
}
if (-not $found) {
    $null = & schtasks /Delete /TN $TaskName /F 2>&1
}

$null = & schtasks /Query /TN $TaskName 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host 'WARNING: task still present after removal attempts'
} else {
    Write-Host 'verified: task is gone'
}

# ------------------------------------------------------------ data
if ($PurgeData) {
    if (Test-Path -LiteralPath $DataDir) {
        Write-Host ('purging data dir: ' + $DataDir)
        Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $DataDir) {
        Write-Host 'WARNING: data dir still exists'
    } else {
        Write-Host 'verified: data dir removed'
    }
} else {
    Write-Host ('data kept at: ' + $DataDir + '  (use -PurgeData to delete)')
}

# ------------------------------------------------------------ mutex note
Write-Host 'note: the named mutex Local\activity-recorder disappears with the last process.'
