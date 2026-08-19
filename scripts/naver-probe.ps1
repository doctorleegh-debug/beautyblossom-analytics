param([string]$Url = 'https://beautyblossom.kr')
# Diagnostic only: dumps the table + pager structure of one Search Advisor page
# so the paging logic in collect-naver.ps1 can target the right elements.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class NPB {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
function ChromeHandles() {
    $script:hs = New-Object System.Collections.ArrayList
    $cb = [NPB+EnumWindowsProc]{ param($h,$l)
        if ([NPB]::IsWindowVisible($h)) {
            $c = New-Object System.Text.StringBuilder 256; [void][NPB]::GetClassName($h,$c,256)
            if ($c.ToString() -like 'Chrome*') { [void]$script:hs.Add([int64]$h) }
        }; return $true }
    [void][NPB]::EnumWindows($cb,[IntPtr]::Zero)
    return $script:hs
}
function TypeOf($e) { return ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.','') }

$enc = [uri]::EscapeDataString($Url)
$target = "https://searchadvisor.naver.com/console/site/report/expose?site=$enc"
$before = @(ChromeHandles)
Start-Process chrome.exe -ArgumentList '--new-window', $target
$deadline = (Get-Date).AddSeconds(45); $new = $null
while ((Get-Date) -lt $deadline -and -not $new) {
    Start-Sleep -Milliseconds 1200
    foreach ($h in ChromeHandles) { if ($before -notcontains $h) { $new = $h } }
}
if (-not $new) { 'WINDOW_NOT_FOUND'; return }

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$new)
$d2 = (Get-Date).AddSeconds(70); $all = $null
while ((Get-Date) -lt $d2) {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $names = @($all | ForEach-Object { $_.Current.Name })
    if ($names -contains '최근 총 클릭') { break }
    Start-Sleep -Milliseconds 1500
}
Start-Sleep -Milliseconds 3000
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)

'--- 화면 전체 텍스트 ---'
@($all | Where-Object { (TypeOf $_) -eq 'Text' } | ForEach-Object { $_.Current.Name } |
  Where-Object { $_ -and $_.Trim() }) | ForEach-Object { "  $_" }
''
$tables = @($all | Where-Object { (TypeOf $_) -eq 'Table' })
"TABLES=$($tables.Count)"
for ($i = 0; $i -lt $tables.Count; $i++) {
    $r = $tables[$i].Current.BoundingRectangle
    "  table[$i]  Y=$([Math]::Round($r.Y))  H=$([Math]::Round($r.Height))  bottom=$([Math]::Round($r.Y + $r.Height))"
    $kids = $tables[$i].FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    "     descendants=$($kids.Count)  rows-ish=$(@($kids | ForEach-Object { $_.Current.Name } | Where-Object { $_ -match '^\d{1,3}$' }).Count)"
}

''
'--- 숫자 라벨을 가진 클릭 가능 요소 (페이저 후보) ---'
foreach ($e in $all) {
    $n = $e.Current.Name
    if (-not $n) { continue }
    if ($n.Trim() -notmatch '^(\d{1,3}|다음|이전|다음 페이지|이전 페이지|>|<)$') { continue }
    $t = TypeOf $e
    if ($t -notin @('Button','ListItem','Hyperlink','DataItem','Text','Custom','Group')) { continue }
    $r = $e.Current.BoundingRectangle
    if ([double]::IsInfinity($r.Y)) { continue }
    $pats = @()
    foreach ($pp in @('Invoke','SelectionItem','LegacyIAccessible')) {
        try {
            $pat = switch ($pp) {
                'Invoke' { [System.Windows.Automation.InvokePattern]::Pattern }
                'SelectionItem' { [System.Windows.Automation.SelectionItemPattern]::Pattern }
                'LegacyIAccessible' { [System.Windows.Automation.AutomationPattern]::LookupById('10018') }
            }
            if ($e.GetCurrentPattern($pat)) { $pats += $pp }
        } catch {}
    }
    "  '{0}'  type={1}  Y={2}  X={3}  clickable={4}  patterns={5}" -f `
        $n.Trim(), $t, [Math]::Round($r.Y), [Math]::Round($r.X), $e.Current.IsKeyboardFocusable, ($pats -join ',')
}
[void][NPB]::PostMessage([IntPtr]$new, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
'PROBE_DONE'
