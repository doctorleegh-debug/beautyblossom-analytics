param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$TitleMatch,
    [string[]]$TextFilter = @(),
    [int]$TimeoutSec = 60,
    [int]$MaxText = 40
)

# Opens $Url in a new Chrome window, brings it to the foreground, and reads its
# UIAutomation text/button tree. Used to lead the user through console setup screens.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class OAR {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
}
'@

function Get-ChromeWindows {
    $script:acc = New-Object System.Collections.ArrayList
    $cb = [OAR+EnumWindowsProc] {
        param($h, $l)
        if ([OAR]::IsWindowVisible($h)) {
            $t = New-Object System.Text.StringBuilder 512; [void][OAR]::GetWindowText($h, $t, 512)
            $c = New-Object System.Text.StringBuilder 256; [void][OAR]::GetClassName($h, $c, 256)
            if ($c.ToString() -like 'Chrome*' -and $t.Length -gt 0) {
                [void]$script:acc.Add([pscustomobject]@{ H = [int64]$h; T = $t.ToString() })
            }
        }
        return $true
    }
    [void][OAR]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:acc
}

$before = @(Get-ChromeWindows | ForEach-Object { $_.H })
Start-Process chrome.exe -ArgumentList '--new-window', $Url

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$target = $null
while ((Get-Date) -lt $deadline -and -not $target) {
    $now = Get-ChromeWindows
    # Prefer a window that did not exist before the launch.
    $fresh = @($now | Where-Object { $before -notcontains $_.H -and $_.T -match $TitleMatch })
    if ($fresh.Count -gt 0) { $target = $fresh[-1]; break }
    $any = @($now | Where-Object { $_.T -match $TitleMatch })
    if ($any.Count -gt 0) { $target = $any[-1] }
    Start-Sleep -Milliseconds 300
}
if (-not $target) { "WINDOW=NOT_FOUND  (title match: $TitleMatch)"; exit 1 }

$h = [IntPtr]$target.H
$fg = [OAR]::GetForegroundWindow()
$t1 = [OAR]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$t2 = [OAR]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
[void][OAR]::AttachThreadInput($t1, $t2, $true)
[void][OAR]::ShowWindow($h, 9)
[void][OAR]::BringWindowToTop($h)
[void][OAR]::SetForegroundWindow($h)
[void][OAR]::AttachThreadInput($t1, $t2, $false)

"HANDLE=$($target.H)"
"TITLE=$($target.T)"
"FOREGROUND=$([OAR]::GetForegroundWindow() -eq $h)"

$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$types = @(
    [System.Windows.Automation.ControlType]::Text
    [System.Windows.Automation.ControlType]::Button
    [System.Windows.Automation.ControlType]::Hyperlink
    [System.Windows.Automation.ControlType]::ListItem
    [System.Windows.Automation.ControlType]::Edit
)

$d2 = (Get-Date).AddSeconds([Math]::Min(30, $TimeoutSec))
$snap = $null
while ((Get-Date) -lt $d2) {
    $bag = [ordered]@{}
    foreach ($ct in $types) {
        $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
        $bag[$ct.ProgrammaticName] = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c) |
            ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_.Trim() })
    }
    if ($bag['ControlType.Text'].Count -gt 5) { $snap = $bag; break }
    Start-Sleep -Milliseconds 400
}
if (-not $snap) { 'PAGE=NOT_LOADED'; exit 1 }

foreach ($k in $snap.Keys) {
    $short = $k -replace 'ControlType\.', ''
    $vals = @($snap[$k] | Select-Object -Unique)
    if ($TextFilter.Count -gt 0 -and $short -eq 'Text') {
        $hit = @($vals | Where-Object { $v = $_; ($TextFilter | Where-Object { $v -match $_ }).Count -gt 0 })
        "--- $short (filtered $($hit.Count)/$($vals.Count)) ---"
        ($hit | Select-Object -First $MaxText) | ForEach-Object { '  ' + $_ }
    } else {
        "--- $short ($($vals.Count)) ---"
        ($vals | Select-Object -First $MaxText) | ForEach-Object { '  ' + $_ }
    }
}
