# activity-recorder / recorder.ps1
# Long running foregound-window sampler. Appends JSONL events to
#   %LOCALAPPDATA%\activity-log\events-YYYY-MM-DD.jsonl
# Windows PowerShell 5.1 only. ASCII only on purpose: a BOM-less file with
# non-ASCII bytes is decoded as GBK by 5.1 and can break the parser.
#
# Runs forever until the process is killed. Single instance, enforced by a
# named mutex. No DSH / node / pwsh 7 dependency.

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- constants
$script:DataDir          = Join-Path $env:LOCALAPPDATA 'activity-log'
$script:LogPath          = Join-Path $script:DataDir 'recorder.log'
$script:PollMs           = 2000     # main loop interval
$script:IdleThresholdSec = 600      # 10 min without input => idle
$script:SnapIntervalSec  = 300      # snapshot aligned to :00/:05/:10
$script:RetentionHours   = 72       # day files older than this are removed
$script:MaxTitleLen      = 200      # focus title clamp
$script:MaxSnapTitleLen  = 120      # snapshot title clamp
$script:MaxSnapWins      = 60       # windows kept per snapshot
$script:MaxLogBytes      = 1048576  # recorder.log cap before it is recreated

# ---------------------------------------------------------------- win32 API
if (-not ('ActRec' -as [type])) {
    $src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class ActRec {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    public class WinInfo {
        public long Hwnd;
        public uint Pid;
        public string Title;
    }

    public static WinInfo Foreground() {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) return null;
        return Make(h);
    }

    static WinInfo Make(IntPtr h) {
        uint pid = 0;
        GetWindowThreadProcessId(h, out pid);
        int len = GetWindowTextLengthW(h);
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowTextW(h, sb, sb.Capacity);
        WinInfo wi = new WinInfo();
        wi.Hwnd = h.ToInt64();
        wi.Pid = pid;
        wi.Title = sb.ToString();
        return wi;
    }

    public static long IdleSeconds() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref lii)) return 0;
        uint now = unchecked((uint)Environment.TickCount);
        uint delta = unchecked(now - lii.dwTime);
        return (long)(delta / 1000);
    }

    public static ulong UptimeSeconds() { return GetTickCount64() / 1000UL; }

    public static WinInfo[] VisibleWindows() {
        List<WinInfo> list = new List<WinInfo>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLengthW(h);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowTextW(h, sb, sb.Capacity);
            if (sb.Length == 0) return true;
            uint pid = 0;
            GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return true;
            WinInfo wi = new WinInfo();
            wi.Hwnd = h.ToInt64();
            wi.Pid = pid;
            wi.Title = sb.ToString();
            list.Add(wi);
            if (list.Count >= 200) return false;
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
'@
    Add-Type -TypeDefinition $src -Language CSharp
}

# ---------------------------------------------------------------- helpers
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Writer = $null
$script:WriterDate = ''
$script:LastErrorMsg = ''
$script:State = 'active'   # 'active' | 'idle'
$script:LastHwnd = ''
$script:LastTitle = ''
$script:LastBucket = [long]-1

function Write-Log {
    param([string]$Message)
    try {
        if (-not (Test-Path -LiteralPath $script:DataDir)) {
            New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
        }
        if (Test-Path -LiteralPath $script:LogPath) {
            $fi = New-Object System.IO.FileInfo($script:LogPath)
            if ($fi.Length -gt $script:MaxLogBytes) {
                Remove-Item -LiteralPath $script:LogPath -Force -ErrorAction SilentlyContinue
            }
        }
        $line = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') + ' ' + $Message
        [System.IO.File]::AppendAllText($script:LogPath, $line + "`r`n", $script:Utf8NoBom)
    } catch { }
}

function Invoke-Retention {
    $cut = (Get-Date).AddHours(-1 * $script:RetentionHours)
    foreach ($f in (Get-ChildItem -LiteralPath $script:DataDir -Filter 'events-*.jsonl' -File -ErrorAction SilentlyContinue)) {
        $ds = $f.BaseName.Substring(7)
        $d = [datetime]::MinValue
        $ok = [datetime]::TryParseExact($ds, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$d)
        if (-not $ok) { continue }
        if ($d.Date.AddDays(1) -lt $cut) {
            try {
                Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
                Write-Log ('rotate: removed ' + $f.Name)
            } catch { }
        }
    }
}

function Get-EventWriter {
    $today = (Get-Date).ToString('yyyy-MM-dd')
    if ($script:Writer -ne $null -and $script:WriterDate -eq $today) { return $script:Writer }
    if ($script:Writer -ne $null) {
        try { $script:Writer.Flush(); $script:Writer.Dispose() } catch { }
        $script:Writer = $null
    }
    $path = Join-Path $script:DataDir ('events-' + $today + '.jsonl')
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $sw = New-Object System.IO.StreamWriter($fs, $script:Utf8NoBom)
    $sw.AutoFlush = $true
    $script:Writer = $sw
    $script:WriterDate = $today
    Invoke-Retention
    return $sw
}

function New-Event {
    param([string]$Kind, [hashtable]$Extra)
    $dto = [DateTimeOffset]::Now
    $h = [ordered]@{}
    $h['t'] = $dto.ToString('yyyy-MM-ddTHH:mm:sszzz')
    $h['k'] = $Kind
    $h['ms'] = $dto.ToUnixTimeMilliseconds()
    if ($Extra -ne $null) {
        foreach ($key in $Extra.Keys) { $h[$key] = $Extra[$key] }
    }
    return $h
}

function Write-Event {
    param($Event)
    $w = Get-EventWriter
    $line = $Event | ConvertTo-Json -Compress -Depth 6
    $w.WriteLine($line)
    $w.Flush()
}

function Clean-Title {
    param([string]$Text, [int]$MaxLen)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $s = $Text -replace "[`r`n`t]", ' '
    $s = $s -replace '[\x00-\x1F]', ' '
    $s = $s.Trim()
    if ($s.Length -gt $MaxLen) { $s = $s.Substring(0, $MaxLen) }
    return $s
}

function Format-Hwnd {
    param([long]$Handle)
    return ('0x{0:X}' -f $Handle)
}

function Get-ProcName {
    param([int]$ProcId)
    if ($ProcId -le 0) { return 'unknown' }
    try {
        $p = [System.Diagnostics.Process]::GetProcessById($ProcId)
        $n = $p.ProcessName
        if ([string]::IsNullOrEmpty($n)) { return 'unknown' }
        if ($n -notmatch '\.exe$') { $n = $n + '.exe' }
        return $n
    } catch {
        return 'unknown'
    }
}

function Get-SnapWindows {
    $arr = New-Object System.Collections.ArrayList
    try {
        $wins = [ActRec]::VisibleWindows()
    } catch {
        return $arr
    }
    foreach ($w in $wins) {
        if ($arr.Count -ge $script:MaxSnapWins) { break }
        $item = [ordered]@{}
        $item['proc'] = Get-ProcName ([int]$w.Pid)
        $item['pid'] = [int]$w.Pid
        $item['hwnd'] = Format-Hwnd ([long]$w.Hwnd)
        $item['title'] = Clean-Title ([string]$w.Title) $script:MaxSnapTitleLen
        [void]$arr.Add($item)
    }
    return $arr
}

function Get-SnapBucket {
    # bucket index inside the local day, so the snapshot lands on :00/:05/:10.
    # (Ticks/interval does NOT work: day boundaries are not a multiple of the
    # interval in absolute ticks, so it drifts to :02:30 style offsets.)
    $n = [DateTime]::Now
    $secOfDay = [long](($n - $n.Date).TotalSeconds)
    return [long][math]::Floor($secOfDay / $script:SnapIntervalSec)
}

# ---------------------------------------------------------------- bootstrap
if (-not (Test-Path -LiteralPath $script:DataDir)) {
    New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null
}

$script:Mutex = $null
try {
    $script:Mutex = New-Object System.Threading.Mutex($false, 'Local\activity-recorder')
} catch {
    Write-Log ('mutex create failed: ' + $_.Exception.Message)
}

if ($script:Mutex -ne $null) {
    $acquired = $false
    try { $acquired = $script:Mutex.WaitOne(0) } catch { $acquired = $false }
    if (-not $acquired) {
        Write-Log ('another recorder instance is already running (pid ' + $PID + '); exiting')
        exit 0
    }
}

$script:OwnPid = $PID
$script:ProcStart = ''
try { $script:ProcStart = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToString('yyyy-MM-ddTHH:mm:sszzz') } catch { $script:ProcStart = '' }
$script:UptimeSec = 0
try { $script:UptimeSec = [double][ActRec]::UptimeSeconds() } catch { $script:UptimeSec = 0 }
$script:BootTime = (Get-Date).AddSeconds(-1 * $script:UptimeSec).ToString('yyyy-MM-ddTHH:mm:sszzz')

Write-Log ('started pid=' + $script:OwnPid + ' powershell=' + $PSVersionTable.PSVersion.ToString() + ' data=' + $script:DataDir)

try {
    Write-Event (New-Event 'boot' @{
        pid       = $script:OwnPid
        procStart = $script:ProcStart
        uptimeSec = [long]$script:UptimeSec
        bootTime  = $script:BootTime
        host      = $env:COMPUTERNAME
    })
} catch {
    Write-Log ('boot event failed: ' + $_.Exception.Message)
}

# ---------------------------------------------------------------- main loop
# snapshot bucket = index inside the local day (see Get-SnapBucket)
$script:LastBucket = Get-SnapBucket

try {
    while ($true) {
        try {
            # --- idle seconds (single GetLastInputInfo call)
            $idleSec = 0
            try { $idleSec = [long][ActRec]::IdleSeconds() } catch { $idleSec = 0 }

            # --- foreground window (2 cheap API calls + 1 process lookup)
            $fg = $null
            try { $fg = [ActRec]::Foreground() } catch { $fg = $null }

            $fgHwnd = ''
            $fgPid = 0
            $fgProc = ''
            $fgTitle = ''

            if ($fg -ne $null) {
                $fgHwnd = Format-Hwnd ([long]$fg.Hwnd)
                $fgPid = [int]$fg.Pid
                $fgProc = Get-ProcName $fgPid
                $fgTitle = Clean-Title ([string]$fg.Title) $script:MaxTitleLen
            }

            # --- focus event: new hwnd, or same hwnd with a different title
            if ($fgHwnd -ne '' -and ($fgHwnd -ne $script:LastHwnd -or $fgTitle -ne $script:LastTitle)) {
                Write-Event (New-Event 'focus' @{
                    proc  = $fgProc
                    pid   = $fgPid
                    hwnd  = $fgHwnd
                    title = $fgTitle
                })
                $script:LastHwnd = $fgHwnd
                $script:LastTitle = $fgTitle
            }

            # --- idle state transitions
            if ($script:State -eq 'active' -and $idleSec -ge $script:IdleThresholdSec) {
                Write-Event (New-Event 'idle' @{ idleSec = $idleSec })
                $script:State = 'idle'
            } elseif ($script:State -eq 'idle' -and $idleSec -lt $script:IdleThresholdSec) {
                Write-Event (New-Event 'active' @{})
                $script:State = 'active'
            }

            # --- 5 minute snapshot, aligned to :00/:05/:10 by bucket index
            $bucket = Get-SnapBucket
            if ($bucket -ne $script:LastBucket) {
                $script:LastBucket = $bucket
                $wins = Get-SnapWindows
                Write-Event (New-Event 'snap' @{
                    proc    = $fgProc
                    pid     = $fgPid
                    hwnd    = $fgHwnd
                    title   = $fgTitle
                    idleSec = $idleSec
                    wins    = $wins
                })
            }
        } catch {
            $msg = $_.Exception.Message
            if ($msg -ne $script:LastErrorMsg) {
                Write-Log ('poll error: ' + $msg)
                $script:LastErrorMsg = $msg
            }
        }

        Start-Sleep -Milliseconds $script:PollMs
    }
} finally {
    try { Write-Event (New-Event 'stop' @{ reason = 'normal exit' }) } catch { }
    try { if ($script:Writer -ne $null) { $script:Writer.Flush(); $script:Writer.Dispose() } } catch { }
    Write-Log ('stopping pid=' + $script:OwnPid)
    if ($script:Mutex -ne $null) {
        try { $script:Mutex.ReleaseMutex() } catch { }
        try { $script:Mutex.Dispose() } catch { }
    }
}
