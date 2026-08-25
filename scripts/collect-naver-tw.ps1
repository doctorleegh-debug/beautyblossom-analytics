param(
    [string]$OutFile = "$PSScriptRoot\..\data\naver-tw.json",
    [switch]$SelfTest
)
# Scrapes Naver Search Advisor "content exposure/click" report for each site.
# Naver exposes no public performance API, so this reads the logged-in console UI
# through UIAutomation. Values on screen are abbreviated (1.9천 / 27.9만) - both the
# raw string and a parsed number are recorded so the report can show the caveat.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$sites = @(
    @{ url='https://tw.beautyblossom.kr'; label='TW' }
)

if ($SelfTest) { 'SelfTest'; $sites | ForEach-Object { "  $($_.label)  $($_.url)" }; 'SelfTestPassed=true'; return }

Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class NVW {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@

function ChromeHandles() {
    $script:hs = New-Object System.Collections.ArrayList
    $cb = [NVW+EnumWindowsProc]{ param($h,$l)
        if ([NVW]::IsWindowVisible($h)) {
            $c = New-Object System.Text.StringBuilder 256; [void][NVW]::GetClassName($h,$c,256)
            if ($c.ToString() -like 'Chrome*') { [void]$script:hs.Add([int64]$h) }
        }; return $true }
    [void][NVW]::EnumWindows($cb,[IntPtr]::Zero)
    return $script:hs
}

function Texts($handle) {
    $r = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
    if (-not $r) { return @() }
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text)
    return @($r.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c) | ForEach-Object { $_.Current.Name } | Where-Object { $_ -ne $null })
}

function Parse-Abbrev([string]$s) {
    if (-not $s) { return $null }
    $t = $s.Trim() -replace ',',''
    if ($t -match '^([\d\.]+)\s*억') { return [double]$Matches[1] * 100000000 }
    if ($t -match '^([\d\.]+)\s*만') { return [double]$Matches[1] * 10000 }
    if ($t -match '^([\d\.]+)\s*천') { return [double]$Matches[1] * 1000 }
    if ($t -match '^([\d\.]+)\s*%$') { return [double]$Matches[1] }
    if ($t -match '^-?[\d\.]+$')     { return [double]$t }
    return $null
}

# value that follows a label, skipping blanks
function After([string[]]$arr, [string]$label, [int]$skip = 0) {
    for ($i = 0; $i -lt $arr.Count; $i++) {
        if ($arr[$i] -and $arr[$i].Trim() -eq $label) {
            $seen = 0
            for ($j = $i + 1; $j -lt [Math]::Min($i + 8, $arr.Count); $j++) {
                if (-not $arr[$j] -or -not $arr[$j].Trim()) { continue }
                if ($seen -eq $skip) { return $arr[$j].Trim() }
                $seen++
            }
        }
    }
    return $null
}

$out = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source = 'Naver Search Advisor console (UI scrape)'
    note   = 'Totals are shown abbreviated by Naver (e.g. 1.9천). parsed_* are approximations of the displayed strings.'
    sites  = @()
}

foreach ($s in $sites) {
    Write-Host "-- $($s.label) $($s.url)"
    $enc = [uri]::EscapeDataString($s.url)
    $target = "https://searchadvisor.naver.com/console/site/report/expose?site=$enc"
    $before = @(ChromeHandles)
    Start-Process chrome.exe -ArgumentList '--new-window', $target
    $deadline = (Get-Date).AddSeconds(45); $new = $null
    while ((Get-Date) -lt $deadline -and -not $new) {
        Start-Sleep -Milliseconds 1200
        foreach ($h in ChromeHandles) { if ($before -notcontains $h) { $new = $h } }
    }
    if (-not $new) { $out.sites += @{ url=$s.url; label=$s.label; status='WINDOW_NOT_FOUND' }; continue }

    $d2 = (Get-Date).AddSeconds(60); $txt = @(); $ready = $false
    while ((Get-Date) -lt $d2) {
        $txt = Texts $new
        if ($txt -contains '최근 총 클릭') { $ready = $true; break }
        Start-Sleep -Milliseconds 1500
    }

    if (-not $ready) {
        $out.sites += @{ url=$s.url; label=$s.label; status='NO_DATA'; screen=@($txt | Select-Object -Unique -First 12) }
    } else {
        $clicks     = After $txt '최근 총 클릭'
        $clicksDelta= After $txt '최근 총 클릭' 2
        $impr       = After $txt '최근 총 노출'
        $imprDelta  = After $txt '최근 총 노출' 2
        $ctr        = After $txt '평균 CTR'
        $ctrDelta   = After $txt '평균 CTR' 2
        $period     = if ($txt -contains '최근 30일') { '최근 30일' } else { '' }
        $updated    = @($txt | Where-Object { $_ -match '^최근 업데이트' }) | Select-Object -First 1

        $out.sites += @{
            url=$s.url; label=$s.label; status='OK'; period=$period; updated=$updated
            clicks_raw=$clicks;      clicks=(Parse-Abbrev $clicks);      clicks_delta=$clicksDelta
            impressions_raw=$impr;   impressions=(Parse-Abbrev $impr);   impressions_delta=$imprDelta
            ctr_raw=$ctr;            ctr=(Parse-Abbrev $ctr);            ctr_delta=$ctrDelta
        }
        "   clicks=$clicks ($clicksDelta)  impressions=$impr ($imprDelta)  ctr=$ctr ($ctrDelta)"
    }
    [void][NVW]::PostMessage([IntPtr]$new, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 2000
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out | ConvertTo-Json -Depth 8 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"

