# activity-recorder / report.ps1
# Reads events-*.jsonl from %LOCALAPPDATA%\activity-log and prints a summary.
# Streams the files line by line: it never holds the whole history in memory.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File report.ps1
#   ... -Hours 1 -Top 10 -Timeline -Json
#
# Foreground seconds = sum of focus segments, minus the part overlapping an
# idle period. Background seconds are approximated from the 5 minute snapshots.
# ASCII only, Windows PowerShell 5.1 compatible.

param(
    [int]$Hours = 72,
    [int]$Top = 15,
    [switch]$Json,
    [switch]$Timeline
)

$ErrorActionPreference = 'Stop'
$ci = [Globalization.CultureInfo]::InvariantCulture

if ($Hours -lt 1) { $Hours = 1 }
if ($Top -lt 1) { $Top = 1 }

$DataDir = Join-Path $env:LOCALAPPDATA 'activity-log'
$Now = [DateTimeOffset]::Now
$Cutoff = $Now.AddHours(-1 * $Hours)
$IdleThresholdSec = 600
$SnapSec = 300

# ------------------------------------------------------------ file selection
$files = New-Object System.Collections.ArrayList
if (Test-Path -LiteralPath $DataDir) {
    foreach ($f in (Get-ChildItem -LiteralPath $DataDir -Filter 'events-*.jsonl' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
        $base = $f.BaseName
        if ($base.Length -lt 17) { continue }
        $ds = $base.Substring(7)
        $d = [datetime]::MinValue
        $ok = [datetime]::TryParseExact($ds, 'yyyy-MM-dd', $ci, [Globalization.DateTimeStyles]::None, [ref]$d)
        if (-not $ok) { continue }
        $dayStart = New-Object DateTimeOffset($d.Year, $d.Month, $d.Day, 0, 0, 0, $Now.Offset)
        if ($dayStart.AddDays(1) -lt $Cutoff) { continue }
        [void]$files.Add($f)
    }
}

# ------------------------------------------------------------ accumulators
$script:procStats = @{}

function Get-Stat {
    param([string]$Name)
    if ([string]::IsNullOrEmpty($Name)) { $Name = 'unknown' }
    if (-not $script:procStats.ContainsKey($Name)) {
        $script:procStats[$Name] = @{
            proc = $Name; fg = 0.0; bg = 0.0; idle = 0.0
            first = $null; last = $null
        }
    }
    return $script:procStats[$Name]
}

$eventCount = 0
$bootCount = 0
$firstT = $null
$lastT = $null
$cur = $null                # open focus segment
$idleOpenStart = $null
$idleOpenProc = $null
$idlePeriods = New-Object System.Collections.ArrayList
$tl = New-Object System.Collections.ArrayList
$maxTl = 600
$prevSnap = $null
$lastFocus = $null
$fileInfo = New-Object System.Collections.ArrayList

function Close-Segment {
    param($Seg, [DateTimeOffset]$EndAt)
    if ($Seg -eq $null) { return }
    $dur = ($EndAt - $Seg.start).TotalSeconds
    if ($dur -lt 0) { $dur = 0 }
    $idlePart = $Seg.idleInside
    if ($idleOpenStart -ne $null) {
        $a = $idleOpenStart
        if ($a -lt $Seg.start) { $a = $Seg.start }
        if ($EndAt -gt $a) { $idlePart = $idlePart + ($EndAt - $a).TotalSeconds }
    }
    $fg = $dur - $idlePart
    if ($fg -lt 0) { $fg = 0 }
    $st = Get-Stat $Seg.proc
    $st.fg = $st.fg + $fg
  }

function Flush-Snap {
    param($Snap, [DateTimeOffset]$EndAt)
    $iv = ($EndAt - $Snap.t).TotalSeconds
    if ($iv -gt $SnapSec) { $iv = $SnapSec }
    if ($iv -lt 0) { $iv = 0 }
    if ($Snap.idleSec -lt $IdleThresholdSec) {
        foreach ($pn in $Snap.procs.Keys) {
            if ($pn -eq $Snap.fgProc) { continue }
            $st = Get-Stat $pn
            $st.bg = $st.bg + $iv
        }
    }
}

# ------------------------------------------------------------ streaming pass
foreach ($f in $files) {
    $fs = $null
    $reader = $null
    $lines = 0
    try {
        $fs = New-Object System.IO.FileStream($f.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        while ($null -ne ($line = $reader.ReadLine())) {
            if ($line.Length -lt 2) { continue }
            $lines++
            $e = $null
            try { $e = $line | ConvertFrom-Json } catch { continue }
            if ($e -eq $null -or $e.t -eq $null -or $e.k -eq $null) { continue }
            $t = [DateTimeOffset]::MinValue
            $ok = [DateTimeOffset]::TryParse([string]$e.t, $ci, [Globalization.DateTimeStyles]::None, [ref]$t)
            if (-not $ok) { continue }
            if ($t -lt $Cutoff) { continue }
            if ($t -gt $Now) { continue }
            $k = [string]$e.k

            $eventCount++
            if ($firstT -eq $null -or $t -lt $firstT) { $firstT = $t }
            if ($lastT -eq $null -or $t -gt $lastT) { $lastT = $t }

            if ($k -eq 'focus') {
                $pname = [string]$e.proc
                $st = Get-Stat $pname
                if ($st.first -eq $null -or $t -lt $st.first) { $st.first = $t }
                if ($st.last -eq $null -or $t -gt $st.last) { $st.last = $t }
                $hw = [string]$e.hwnd
                $ti = [string]$e.title
                $fgPid = 0
                if ($null -ne $e.pid) { $fgPid = [int]$e.pid }
                $lastFocus = @{ t = $t; proc = $pname; pid = $fgPid; hwnd = $hw; title = $ti }
                if ($cur -ne $null -and $cur.hwnd -eq $hw) {
                    $cur.title = $ti
                    $cur.end = $t
                } else {
                    if ($cur -ne $null) { Close-Segment $cur $t }
                    $cur = @{ proc = $pname; pid = $fgPid; hwnd = $hw; title = $ti; start = $t; end = $t; idleInside = 0.0 }
                    if ($tl.Count -ge $maxTl) { $tl.RemoveAt(0) }
                    [void]$tl.Add($cur)
                }
            } elseif ($k -eq 'idle') {
                if ($idleOpenStart -eq $null) {
                    $idleOpenStart = $t
                    if ($cur -ne $null) { $idleOpenProc = $cur.proc } else { $idleOpenProc = $null }
                }
            } elseif ($k -eq 'active') {
                if ($idleOpenStart -ne $null) {
                    $dur = ($t - $idleOpenStart).TotalSeconds
                    if ($dur -lt 0) { $dur = 0 }
                    [void]$idlePeriods.Add(@{ start = $idleOpenStart; end = $t; sec = $dur })
                    if ($cur -ne $null) {
                        $a = $idleOpenStart
                        if ($a -lt $cur.start) { $a = $cur.start }
                        if ($t -gt $a) { $cur.idleInside = $cur.idleInside + ($t - $a).TotalSeconds }
                    }
                    if ($idleOpenProc) {
                        $st = Get-Stat $idleOpenProc
                        $st.idle = $st.idle + $dur
                    }
                    $idleOpenStart = $null
                    $idleOpenProc = $null
                }
            } elseif ($k -eq 'snap') {
                $snapIdle = 0
                if ($null -ne $e.idleSec) { $snapIdle = [double]$e.idleSec }
                $snapFgProc = [string]$e.proc
                $set = @{}
                if ($e.wins -ne $null) {
                    foreach ($w in $e.wins) {
                        $pn = [string]$w.proc
                        if (-not [string]::IsNullOrEmpty($pn)) { $set[$pn] = $true }
                    }
                }
                if ($prevSnap -ne $null) { Flush-Snap $prevSnap $t }
                $prevSnap = @{ t = $t; idleSec = $snapIdle; fgProc = $snapFgProc; procs = $set }
            } elseif ($k -eq 'boot') {
                $bootCount++
            }
        }
    } finally {
        if ($reader -ne $null) { try { $reader.Dispose() } catch { } }
        elseif ($fs -ne $null) { try { $fs.Dispose() } catch { } }
    }
    [void]$fileInfo.Add(@{ name = $f.Name; lines = $lines; bytes = [long]$f.Length })
}

# ------------------------------------------------------------ close the tail
$live = $false
if ($lastT -ne $null -and ($Now - $lastT).TotalSeconds -lt 120) { $live = $true }
$endT = $Now
if (-not $live -and $lastT -ne $null) { $endT = $lastT }

if ($prevSnap -ne $null) {
    Flush-Snap $prevSnap $endT
    $prevSnap = $null
}

$idleOpenSec = 0
if ($idleOpenStart -ne $null) {
    $idleOpenSec = ($endT - $idleOpenStart).TotalSeconds
    if ($idleOpenSec -lt 0) { $idleOpenSec = 0 }
    [void]$idlePeriods.Add(@{ start = $idleOpenStart; end = $null; sec = $idleOpenSec })
    if ($idleOpenProc) {
        $st = Get-Stat $idleOpenProc
        $st.idle = $st.idle + $idleOpenSec
    }
    if ($cur -ne $null) {
        $a = $idleOpenStart
        if ($a -lt $cur.start) { $a = $cur.start }
        if ($endT -gt $a) { $cur.idleInside = $cur.idleInside + ($endT - $a).TotalSeconds }
    }
}

if ($cur -ne $null) {
    Close-Segment $cur $endT
    $cur.end = $endT
}

# ------------------------------------------------------------ presentation
function Format-Dur {
    param([double]$Seconds)
    if ($Seconds -lt 0) { $Seconds = 0 }
    $s = [int][math]::Round($Seconds)
    $h = [int][math]::Floor($s / 3600)
    $m = [int][math]::Floor(($s % 3600) / 60)
    $sec = $s % 60
    return ('{0}:{1:00}:{2:00}' -f $h, $m, $sec)
}

function Format-T {
    param($Value)
    if ($Value -eq $null) { return '-' }
    return ([DateTimeOffset]$Value).ToString('yyyy-MM-dd HH:mm:ss')
}

$st = New-Object System.Collections.ArrayList
foreach ($key in $script:procStats.Keys) { [void]$st.Add($script:procStats[$key]) }
$sorted = $st | Sort-Object -Property @{ Expression = { $_.fg }; Descending = $true }, @{ Expression = { $_.bg }; Descending = $true }

$totalIdle = 0.0
foreach ($p in $idlePeriods) { $totalIdle = $totalIdle + $p.sec }

$tlCount = $Top
if ($Timeline) { $tlCount = 200 }
$tlStart = 0
if ($tl.Count -gt $tlCount) { $tlStart = $tl.Count - $tlCount }
$tlSel = New-Object System.Collections.ArrayList
for ($i = $tlStart; $i -lt $tl.Count; $i++) {
    $seg = $tl[$i]
    [void]$tlSel.Add(@{
        type = 'focus'; start = $seg.start; end = $seg.end
        sec = ($seg.end - $seg.start).TotalSeconds
        proc = $seg.proc; pid = $seg.pid; hwnd = $seg.hwnd; title = $seg.title
    })
}
$idleSel = New-Object System.Collections.ArrayList
$idleFrom = 0
$idleLimit = 50
if ($Timeline) { $idleLimit = 500 }
if ($idlePeriods.Count -gt $idleLimit) { $idleFrom = $idlePeriods.Count - $idleLimit }
for ($i = $idleFrom; $i -lt $idlePeriods.Count; $i++) {
    $p = $idlePeriods[$i]
    [void]$idleSel.Add(@{ type = 'idle'; start = $p.start; end = $p.end; sec = $p.sec })
}

$curProc = '-'
$curPid = 0
$curHwnd = '-'
$curTitle = '-'
$curAt = $null
if ($lastFocus -ne $null) {
    $curProc = $lastFocus.proc
    $curPid = $lastFocus.pid
    $curHwnd = $lastFocus.hwnd
    $curTitle = $lastFocus.title
    $curAt = $lastFocus.t
}

if ($Json) {
    $out = [ordered]@{}
    $out['generatedAt'] = $Now.ToString('yyyy-MM-ddTHH:mm:sszzz')
    $out['windowHours'] = $Hours
    $out['dataDir'] = $DataDir
    $cov = [ordered]@{}
    $cov['files'] = @($fileInfo | ForEach-Object { [ordered]@{ name = $_.name; lines = $_.lines; bytes = $_.bytes } })
    $cov['eventCount'] = $eventCount
    $cov['bootCount'] = $bootCount
    $cov['firstEvent'] = Format-T $firstT
    $cov['lastEvent'] = Format-T $lastT
    $out['coverage'] = $cov
    $curObj = [ordered]@{}
    $curObj['proc'] = $curProc
    $curObj['pid'] = $curPid
    $curObj['hwnd'] = $curHwnd
    $curObj['title'] = $curTitle
    $curObj['lastActivation'] = Format-T $curAt
    $curObj['idle'] = ($idleOpenStart -ne $null)
    $curObj['idleSince'] = Format-T $idleOpenStart
    $out['current'] = $curObj
    $arr = @()
    foreach ($p in $sorted) {
        if ($arr.Count -ge $Top) { break }
        $arr += [ordered]@{
            proc = $p.proc
            focusSec = [math]::Round($p.fg, 1)
            backgroundSec = [math]::Round($p.bg, 1)
            idleSec = [math]::Round($p.idle, 1)
            firstSeen = Format-T $p.first
            lastSeen = Format-T $p.last
        }
    }
    $out['processes'] = $arr
    $out['totalIdleSec'] = [math]::Round($totalIdle + $idleOpenSec, 1)
    $out['idlePeriods'] = @($idleSel | ForEach-Object {
            [ordered]@{ start = Format-T $_.start; end = Format-T $_.end; sec = [math]::Round($_.sec, 1) }
        })
    $out['timeline'] = @($tlSel | ForEach-Object {
            [ordered]@{
                type = $_.type; start = Format-T $_.start; end = Format-T $_.end
                sec = [math]::Round($_.sec, 1); proc = $_.proc; pid = $_.pid
                hwnd = $_.hwnd; title = $_.title
            }
        })
    $out | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host '=== ACTIVITY RECORDER REPORT ==='
Write-Host ('generated : ' + $Now.ToString('yyyy-MM-ddTHH:mm:sszzz'))
Write-Host ('window    : last ' + $Hours + ' h  (cutoff ' + $Cutoff.ToString('yyyy-MM-dd HH:mm:ss') + ')')
Write-Host ('data dir  : ' + $DataDir)
Write-Host ''

Write-Host '[1] DATA COVERAGE'
if ($fileInfo.Count -eq 0) {
    Write-Host ('  files : none found for this window')
} else {
    Write-Host ('  files : ' + $fileInfo.Count)
    foreach ($fi in $fileInfo) {
        Write-Host ('    ' + $fi.name + '   ' + $fi.lines + ' lines   ' + [math]::Round($fi.bytes / 1024, 1) + ' KB')
    }
}
Write-Host ('  events      : ' + $eventCount)
Write-Host ('  first event : ' + (Format-T $firstT))
Write-Host ('  last event  : ' + (Format-T $lastT))
if ($firstT -ne $null) {
    Write-Host ('  span        : ' + (Format-Dur (($endT - $firstT).TotalSeconds)) + '  (first event to now/last event)')
}
Write-Host ('  boots       : ' + $bootCount + '  (recorder restarts inside the window)')
Write-Host ''

Write-Host '[2] CURRENT FOREGROUND WINDOW'
Write-Host ('  proc            : ' + $curProc + ' (pid ' + $curPid + ')')
Write-Host ('  hwnd            : ' + $curHwnd)
Write-Host ('  title           : ' + $curTitle)
Write-Host ('  last activation : ' + (Format-T $curAt))
if ($idleOpenStart -ne $null) {
    Write-Host ('  state           : IDLE since ' + (Format-T $idleOpenStart) + ' (' + (Format-Dur $idleOpenSec) + ')')
} else {
    Write-Host '  state           : ACTIVE'
}
if (-not $live) {
    Write-Host '  note            : recorder looks stopped (no event in the last 2 min)'
}
Write-Host ''

Write-Host ('[3] PER-PROCESS TOTALS (top ' + $Top + ')')
Write-Host ('  ' + ('proc'.PadRight(28)) + ('foreground'.PadLeft(12)) + ('background'.PadLeft(12)) + ('idle'.PadLeft(10)) + '   first seen            last seen')
$shown = 0
foreach ($p in $sorted) {
    if ($shown -ge $Top) { break }
    $shown++
    Write-Host ('  ' + $p.proc.PadRight(28) + (Format-Dur $p.fg).PadLeft(12) + (Format-Dur $p.bg).PadLeft(12) + (Format-Dur $p.idle).PadLeft(10) + '   ' + (Format-T $p.first) + '   ' + (Format-T $p.last))
}
if ($shown -eq 0) { Write-Host '  (no data)' }
Write-Host ''
Write-Host '  background is estimated from 5 minute snapshots (max 5 min error per run).'
Write-Host '  idle is attributed to the process that was foreground when idleness began.'
Write-Host ''

Write-Host ('[4] TIMELINE (last ' + $tlSel.Count + ' focus segments, idle rows separate)')
$merged = New-Object System.Collections.ArrayList
foreach ($s in $tlSel) { [void]$merged.Add($s) }
foreach ($s in $idleSel) { [void]$merged.Add($s) }
$ordered = $merged | Sort-Object -Property @{ Expression = { $_.start } }
foreach ($s in $ordered) {
    if ($s.type -eq 'idle') {
        Write-Host ('  ' + $s.start.ToString('HH:mm:ss') + '-' + $s.end.ToString('HH:mm:ss') + '  ' + ('<IDLE ' + (Format-Dur $s.sec) + '>'))
    } else {
        $t2 = [string]$s.title
        if ($t2.Length -gt 70) { $t2 = $t2.Substring(0, 70) }
        Write-Host ('  ' + $s.start.ToString('HH:mm:ss') + '-' + $s.end.ToString('HH:mm:ss') + '  ' + $s.proc.PadRight(20) + ' ' + $t2)
    }
}
if ($ordered.Count -eq 0) { Write-Host '  (no focus events in window)' }
Write-Host ''

Write-Host '[5] IDLE PERIODS (input gap >= 600 s)'
if ($idleSel.Count -eq 0) {
    Write-Host '  (none)'
} else {
    Write-Host ('  ' + ('start'.PadRight(21)) + ('end'.PadRight(21)) + 'duration')
    foreach ($s in $idleSel) {
        $endText = '-'
        if ($s.end -ne $null) { $endText = (Format-T $s.end) }
        Write-Host ('  ' + (Format-T $s.start).PadRight(21) + $endText.PadRight(21) + (Format-Dur $s.sec))
    }
}
Write-Host ('  total idle : ' + (Format-Dur ($totalIdle + $idleOpenSec)))
