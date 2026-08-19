param(
    [string]$OutFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\naver-latest.json',
    [int]$MaxPages = 3,
    [string[]]$Only,
    [switch]$SelfTest
)
# Scrapes the Naver Search Advisor "content exposure/click" console for each site:
# headline totals, the search-keyword TOP 30 table and the web-document TOP 30 table.
# Naver publishes no performance API, so this reads the logged-in console via UIAutomation.
# Headline totals are abbreviated on screen; the table rows are exact.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$sites = @(
    @{ url='https://beautyblossom.kr';        label='KR' }
    @{ url='https://cn.beautyblossom.kr';     label='CN' }
    @{ url='https://en.beautyblossom.kr';     label='EN' }
    @{ url='https://jp.beautyblossom.kr';     label='JP' }
    @{ url='https://tw.beautyblossom.kr';     label='TW' }
    @{ url='https://www.beautyblossomth.kr';  label='TH' }
)
if ($Only) { $sites = @($sites | Where-Object { $Only -contains $_.label }) }

if ($SelfTest) { 'SelfTest'; $sites | ForEach-Object { "  $($_.label)  $($_.url)" }; "MaxPages=$MaxPages"; 'SelfTestPassed=true'; return }

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

$L_CLICKS = "최근 총 클릭"
$L_IMPR   = "최근 총 노출"
$L_CTR    = "평균 CTR"
$L_30D    = "최근 30일"
$L_UPD    = "^최근 업데이트"
$L_NEXT   = "다음 페이지"
$NOTE     = "헤드라인 합계는 네이버가 화면에 축약 표기한 값이라 근사치입니다. 키워드·웹문서 표의 수치는 원값입니다."

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
# Chrome hands out a window handle before its UIA tree exists, so FromHandle can throw
# ElementNotAvailableException. Return null and let the caller's wait loop retry.
function AllOf($handle) {
    try {
        $r = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
        if (-not $r) { return $null }
        return $r.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    } catch { return $null }
}
function TypeOf($e) { return ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.','') }
function TextsOf($all) { return @($all | Where-Object { (TypeOf $_) -eq 'Text' } | ForEach-Object { $_.Current.Name }) }

function Parse-Abbrev([string]$s) {
    if (-not $s) { return $null }
    $t = $s.Trim() -replace ',',''
    $u_eok = [char]0xC5B5; $u_man = [char]0xB9CC; $u_cheon = [char]0xCC9C; $u_baek = [char]0xBC31
    if ($t -match "^-?([\d\.]+)\s*$u_eok")   { return [double]$Matches[1] * 100000000 }
    if ($t -match "^-?([\d\.]+)\s*$u_man")   { return [double]$Matches[1] * 10000 }
    if ($t -match "^-?([\d\.]+)\s*$u_cheon") { return [double]$Matches[1] * 1000 }
    if ($t -match "^-?([\d\.]+)\s*$u_baek")  { return [double]$Matches[1] * 100 }
    if ($t -match '^(-?[\d\.]+)\s*%$')       { return [double]$Matches[1] }
    if ($t -match '^-?[\d\.]+$')             { return [double]$t }
    return $null
}
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

# Rows arrive as flat cell names. The No column runs 1..N in order, so a new row is
# only recognised when the integer equals the next expected rank - otherwise a click
# count like "81" would be mistaken for a row number.
function Parse-Table($tableEl, [int]$startRank = 1) {
    $kids = $tableEl.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $names = @($kids | ForEach-Object { $_.Current.Name } | Where-Object { $_ -ne $null -and $_.Trim() -ne '' })
    $rows = @(); $cur = $null; $expect = $startRank
    foreach ($n in $names) {
        $t = $n.Trim()
        if ($t -match '^\d{1,3}$' -and [int]$t -eq $expect -and ($cur -eq $null -or $cur.cells.Count -ge 4)) {
            if ($cur -and $cur.cells.Count -ge 3) { $rows += ,$cur }
            $cur = @{ no = [int]$t; cells = @() }
            $expect++
            continue
        }
        if ($cur -ne $null) { $cur.cells += $t }
    }
    if ($cur -and $cur.cells.Count -ge 3) { $rows += ,$cur }

    $out = @()
    foreach ($r in $rows) {
        $cells = @($r.cells)
        $nums = @($cells | Where-Object { $_ -match '^[\d,\.]+$' })
        if ($nums.Count -lt 3) { continue }
        $label = @($cells | Where-Object { $_ -notmatch '^[\d,\.]+$' } | Select-Object -First 1)
        if (-not $label) { $label = $cells[0] }
        $tail = $nums[($nums.Count-3)..($nums.Count-1)]
        $out += @{
            rank = $r.no
            label = [string]$label
            clicks = [double]($tail[0] -replace ',','')
            impressions = [double]($tail[1] -replace ',','')
            ctr = [double]($tail[2] -replace ',','')
        }
    }
    return $out
}

# The page-number ListItems expose no interaction pattern at all - only the
# "다음 페이지" button does - so paging walks forward one step at a time.
# The pager sits ~50px under its own table, which is what tells the keyword
# pager apart from the web-document one.
function Next-Page($all, $tableEl) {
    $ty = $null
    try {
        $r = $tableEl.Current.BoundingRectangle
        if (-not [double]::IsInfinity($r.Y)) { $ty = $r.Y + $r.Height }
    } catch { return $false }
    if ($null -eq $ty) { return $false }
    foreach ($c in $all) {
        try {
            if ((TypeOf $c) -ne 'Button') { continue }
            if ($c.Current.Name.Trim() -ne $L_NEXT) { continue }
            $r = $c.Current.BoundingRectangle
            if ([double]::IsInfinity($r.Y)) { continue }
            if ($r.Y -lt ($ty - 40) -or $r.Y -gt ($ty + 200)) { continue }
            # A disabled pager arrow drops out of the focus order; that is the last page.
            if (-not $c.Current.IsKeyboardFocusable) { return $false }
            $c.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Start-Sleep -Milliseconds 2600
            return $true
        } catch { continue }
    }
    return $false
}

function Collect-Table($handle, [int]$tableIndex, [int]$maxPages) {
    $acc = @{}
    for ($p = 1; $p -le $maxPages; $p++) {
        # Re-query after every page: the click re-renders the grid and the
        # previously held elements go stale.
        $all = AllOf $handle
        if (-not $all) { break }
        $tables = @($all | Where-Object { (TypeOf $_) -eq 'Table' })
        if ($tables.Count -le $tableIndex) { break }
        $before = $acc.Count
        foreach ($row in (Parse-Table $tables[$tableIndex] ((($p - 1) * 10) + 1))) { $acc[[string]$row.rank] = $row }
        if ($acc.Count -eq $before) { break }
        if ($p -lt $maxPages) {
            if (-not (Next-Page $all $tables[$tableIndex])) { break }
        }
    }
    return @($acc.Values | Sort-Object { $_.rank })
}

$out = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source = 'Naver Search Advisor console (UI scrape)'
    note   = $NOTE
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

    $d2 = (Get-Date).AddSeconds(70); $txt = @(); $ready = $false
    while ((Get-Date) -lt $d2) {
        $all = AllOf $new
        if ($all) { $txt = TextsOf $all; if ($txt -contains $L_CLICKS) { $ready = $true; break } }
        Start-Sleep -Milliseconds 1500
    }

    if (-not $ready) {
        $out.sites += @{ url=$s.url; label=$s.label; status='NO_DATA'; screen=@($txt | Select-Object -Unique -First 12) }
    } else {
      # A stale UIA element throws mid-scrape; keep whatever the other sites produced.
      try {
        Start-Sleep -Milliseconds 2500
        $keywords = Collect-Table $new 0 $MaxPages
        $docs     = Collect-Table $new 1 $MaxPages

        $out.sites += @{
            url=$s.url; label=$s.label; status='OK'
            period = $(if ($txt -contains $L_30D) { $L_30D } else { '' })
            updated = @($txt | Where-Object { $_ -match $L_UPD }) | Select-Object -First 1
            clicks_raw=(After $txt $L_CLICKS);      clicks=(Parse-Abbrev (After $txt $L_CLICKS));      clicks_delta=(After $txt $L_CLICKS 2)
            impressions_raw=(After $txt $L_IMPR);   impressions=(Parse-Abbrev (After $txt $L_IMPR));   impressions_delta=(After $txt $L_IMPR 2)
            ctr_raw=(After $txt $L_CTR);            ctr=(Parse-Abbrev (After $txt $L_CTR));            ctr_delta=(After $txt $L_CTR 2)
            keywords = $keywords
            documents = $docs
        }
        "   clicks=$(After $txt $L_CLICKS)  impressions=$(After $txt $L_IMPR)  keywords=$($keywords.Count)  docs=$($docs.Count)"
      } catch {
        $out.sites += @{ url=$s.url; label=$s.label; status='PARTIAL'; error=$_.Exception.Message }
        "   PARTIAL $($_.Exception.Message)"
      }
    }
    [void][NVW]::PostMessage([IntPtr]$new, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 2000
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
