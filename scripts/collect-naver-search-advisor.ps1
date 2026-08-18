[CmdletBinding()]
param(
    [string]$OutputPath,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Convert-DisplayNumber {
    param([Parameter(Mandatory)][string]$Value)

    $clean = $Value.Trim().Replace(',', '')
    $multiplier = 1
    if ($clean.EndsWith([string][char]0xCC9C)) {
        $multiplier = 1000
        $clean = $clean.Substring(0, $clean.Length - 1)
    }
    elseif ($clean.EndsWith([string][char]0xB9CC)) {
        $multiplier = 10000
        $clean = $clean.Substring(0, $clean.Length - 1)
    }

    $number = 0.0
    if (-not [double]::TryParse(
        $clean,
        [System.Globalization.NumberStyles]::Float,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [ref]$number
    )) {
        throw "Unsupported numeric display value: $Value"
    }

    return [int64][math]::Round($number * $multiplier)
}

function Convert-Percent {
    param([Parameter(Mandatory)][string]$Value)

    $clean = $Value.Trim().TrimEnd('%')
    $number = 0.0
    if (-not [double]::TryParse(
        $clean,
        [System.Globalization.NumberStyles]::Float,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [ref]$number
    )) {
        throw "Unsupported percentage display value: $Value"
    }

    return $number
}

if ($SelfTest) {
    $checks = @(
        @{ Actual = Convert-DisplayNumber ('1.9' + ([string][char]0xCC9C)); Expected = 1900 },
        @{ Actual = Convert-DisplayNumber ('27.9' + ([string][char]0xB9CC)); Expected = 279000 },
        @{ Actual = Convert-DisplayNumber '4,184'; Expected = 4184 },
        @{ Actual = Convert-Percent ' -13.4%'; Expected = -13.4 }
    )
    foreach ($check in $checks) {
        if ($check.Actual -ne $check.Expected) {
            throw "Self-test failed: expected $($check.Expected), got $($check.Actual)"
        }
    }
    'SelfTestPassed=true'
    exit 0
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $scriptRoot
$labelsPath = Join-Path $scriptRoot 'naver-search-advisor-ui-labels.json'
$labels = Get-Content -LiteralPath $labelsPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $workspaceRoot 'data\naver-search-advisor-latest.json'
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (-not $OutputPath.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output path must remain inside the workspace: $OutputPath"
}

$sites = @(
    @{ Code = 'KR'; Url = 'https://beautyblossom.kr' },
    @{ Code = 'CN'; Url = 'https://cn.beautyblossom.kr' },
    @{ Code = 'EN'; Url = 'https://en.beautyblossom.kr' },
    @{ Code = 'JP'; Url = 'https://jp.beautyblossom.kr' },
    @{ Code = 'TW'; Url = 'https://tw.beautyblossom.kr' },
    @{ Code = 'TH'; Url = 'https://www.beautyblossomth.kr' }
)

function Get-BrowserProcess {
    $candidates = @(Get-Process chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 })
    if ($candidates.Count -eq 1) {
        return $candidates[0]
    }
    foreach ($candidate in $candidates) {
        if ($candidate.MainWindowTitle -match [regex]::Escape($labels.windowTitle)) {
            return $candidate
        }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($candidate.MainWindowHandle)
        $searchAdvisorLink = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::NameProperty,
                'Search Advisor '
            ))
        )
        if ($searchAdvisorLink) {
            return $candidate
        }
    }
    $titles = @($candidates | ForEach-Object { $_.MainWindowTitle }) -join ' | '
    throw "Logged-in Naver Search Advisor Chrome window was not found. Candidates=$($candidates.Count); Titles=$titles"
}

function Get-RootElement {
    $process = Get-BrowserProcess
    return [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}

function Get-AllElements {
    return (Get-RootElement).FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
}

function Wait-ForElement {
    param(
        [Parameter(Mandatory)][System.Windows.Automation.ControlType]$ControlType,
        [Parameter(Mandatory)][string]$Name,
        [int]$TimeoutSeconds = 15
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $match = Get-AllElements | Where-Object {
            $_.Current.ControlType -eq $ControlType -and
            $_.Current.Name.Trim() -eq $Name.Trim()
        } | Select-Object -First 1
        if ($match) {
            return $match
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for element: $Name"
}

function Invoke-UiElement {
    param([Parameter(Mandatory)][System.Windows.Automation.AutomationElement]$Element)

    $patterns = @($Element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
    if ($patterns -contains 'InvokePatternIdentifiers.Pattern') {
        $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        return
    }
    throw "Element does not support InvokePattern: $($Element.Current.Name)"
}

function Open-SiteReport {
    param([Parameter(Mandatory)][string]$SiteUrl)

    $all = Get-AllElements
    $listView = $all | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink -and
        $_.Current.Name.Trim() -eq $labels.listView.Trim()
    } | Select-Object -First 1
    if ($listView) {
        Invoke-UiElement $listView
        [void](Wait-ForElement -ControlType ([System.Windows.Automation.ControlType]::Hyperlink) -Name $SiteUrl)
    }

    $siteLink = Wait-ForElement -ControlType ([System.Windows.Automation.ControlType]::Hyperlink) -Name $SiteUrl
    Invoke-UiElement $siteLink
    [void](Wait-ForElement -ControlType ([System.Windows.Automation.ControlType]::Button) -Name $labels.report)

    $reportButton = Wait-ForElement -ControlType ([System.Windows.Automation.ControlType]::Button) -Name $labels.report
    $supported = @($reportButton.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
    if ($supported -contains 'ExpandCollapsePatternIdentifiers.Pattern') {
        $expand = $reportButton.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($expand.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
            $expand.Expand()
        }
    }

    $contentReport = Wait-ForElement -ControlType ([System.Windows.Automation.ControlType]::ListItem) -Name $labels.contentExposure
    Invoke-UiElement $contentReport
    [void](Wait-ForElement -ControlType ([System.Windows.Automation.ControlType]::Text) -Name $labels.totalClicks)
}

function Get-TextNames {
    return @(Get-AllElements | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
        -not [string]::IsNullOrWhiteSpace($_.Current.Name)
    } | ForEach-Object { $_.Current.Name.Trim() })
}

function Get-ValueAfterLabel {
    param(
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$Label,
        [int]$StartIndex = 0
    )

    for ($i = $StartIndex; $i -lt $Names.Count; $i++) {
        if ($Names[$i] -eq $Label.Trim()) {
            for ($j = $i + 1; $j -lt $Names.Count; $j++) {
                if (-not [string]::IsNullOrWhiteSpace($Names[$j])) {
                    return @{ Index = $i; Value = $Names[$j] }
                }
            }
        }
    }
    throw "Summary label not found: $Label"
}

function Get-ChangeAfterMetric {
    param(
        [Parameter(Mandatory)][string[]]$Names,
        [Parameter(Mandatory)][string]$MetricLabel
    )

    $metric = Get-ValueAfterLabel -Names $Names -Label $MetricLabel
    $change = Get-ValueAfterLabel -Names $Names -Label $labels.versusPrevious -StartIndex ($metric.Index + 1)
    return $change.Value
}

function Get-TableRows {
    param([Parameter(Mandatory)][ValidateSet('keyword', 'document')][string]$Table)

    $groups = @{}
    foreach ($element in (Get-AllElements)) {
        if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::DataItem) {
            continue
        }
        $name = $element.Current.Name.Trim()
        if ([string]::IsNullOrWhiteSpace($name)) {
            continue
        }
        $rect = $element.Current.BoundingRectangle
        $key = [int][math]::Round($rect.Y)
        if (-not $groups.ContainsKey($key)) {
            $groups[$key] = @()
        }
        $groups[$key] += [pscustomobject]@{ X = $rect.X; Name = $name }
    }

    $rows = @()
    foreach ($key in ($groups.Keys | Sort-Object)) {
        $cells = @($groups[$key] | Sort-Object X | ForEach-Object { $_.Name })
        if ($cells.Count -lt 5 -or $cells[0] -notmatch '^\d+$') {
            continue
        }
        $isDocument = $cells[1] -match '^https?://'
        if (($Table -eq 'document') -ne $isDocument) {
            continue
        }
        $rows += [pscustomobject]@{
            rank        = [int]$cells[0]
            value       = $cells[1]
            clicks      = Convert-DisplayNumber $cells[2]
            impressions = Convert-DisplayNumber $cells[3]
            ctr         = Convert-Percent $cells[4]
        }
    }
    return $rows
}

function Get-TableHeaderPositions {
    $headers = Get-AllElements | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::DataItem -and
        ($_.Current.Name.Trim() -eq $labels.keywordHeader -or $_.Current.Name.Trim() -eq $labels.documentHeader)
    }
    $keyword = $headers | Where-Object { $_.Current.Name.Trim() -eq $labels.keywordHeader } | Select-Object -First 1
    $document = $headers | Where-Object { $_.Current.Name.Trim() -eq $labels.documentHeader } | Select-Object -First 1
    if (-not $keyword -or -not $document) {
        throw 'Table headers are not available in the accessibility tree.'
    }
    return @{
        Keyword = $keyword.Current.BoundingRectangle.Y
        Document = $document.Current.BoundingRectangle.Y
    }
}

function Test-ButtonBelongsToTable {
    param(
        [Parameter(Mandatory)][System.Windows.Automation.AutomationElement]$Button,
        [Parameter(Mandatory)][ValidateSet('keyword', 'document')][string]$Table,
        [Parameter(Mandatory)][hashtable]$Headers
    )

    $y = $Button.Current.BoundingRectangle.Y
    if ($Table -eq 'keyword') {
        return $y -gt $Headers.Keyword -and $y -lt $Headers.Document
    }
    return $y -gt $Headers.Document
}

function Set-TablePage {
    param(
        [Parameter(Mandatory)][ValidateSet('keyword', 'document')][string]$Table,
        [Parameter(Mandatory)][int]$Page
    )

    $headers = Get-TableHeaderPositions
    $currentName = $labels.currentPagePrefix + $Page
    $gotoName = $labels.gotoPagePrefix + $Page
    $buttons = @(Get-AllElements | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        ($_.Current.Name -eq $currentName -or $_.Current.Name -eq $gotoName)
    })

    $current = $buttons | Where-Object {
        $_.Current.Name -eq $currentName -and
        (Test-ButtonBelongsToTable -Button $_ -Table $Table -Headers $headers)
    } | Select-Object -First 1
    if ($current) {
        return $true
    }

    $target = $buttons | Where-Object {
        $_.Current.Name -eq $gotoName -and
        (Test-ButtonBelongsToTable -Button $_ -Table $Table -Headers $headers)
    } | Select-Object -First 1
    if (-not $target) {
        return $false
    }

    Invoke-UiElement $target
    Start-Sleep -Milliseconds 800
    return $true
}

function Get-AllTableRows {
    param([Parameter(Mandatory)][ValidateSet('keyword', 'document')][string]$Table)

    $rowsByRank = @{}
    foreach ($page in 1..3) {
        if (-not (Set-TablePage -Table $Table -Page $page)) {
            continue
        }
        foreach ($row in (Get-TableRows -Table $Table)) {
            $rowsByRank[$row.rank] = $row
        }
    }
    return @($rowsByRank.Values | Sort-Object rank)
}

function Get-SiteSnapshot {
    param(
        [Parameter(Mandatory)][string]$Code,
        [Parameter(Mandatory)][string]$SiteUrl
    )

    Open-SiteReport -SiteUrl $SiteUrl
    $names = Get-TextNames
    $clicks = Get-ValueAfterLabel -Names $names -Label $labels.totalClicks
    $impressions = Get-ValueAfterLabel -Names $names -Label $labels.totalImpressions
    $ctr = Get-ValueAfterLabel -Names $names -Label $labels.averageCtr
    $updated = $names | Where-Object { $_.StartsWith($labels.updatedPrefix) } | Select-Object -First 1
    if (-not $updated) {
        throw "Update date not found for $SiteUrl"
    }

    $keywords = @(Get-AllTableRows -Table keyword)
    $documents = @(Get-AllTableRows -Table document)

    return [pscustomobject]@{
        code                          = $Code
        site_url                      = $SiteUrl
        updated_date                  = $updated.Substring($labels.updatedPrefix.Length).Trim()
        period_days                   = 30
        device                        = 'all'
        total_clicks_display          = $clicks.Value
        total_clicks_approx           = Convert-DisplayNumber $clicks.Value
        clicks_change_percent_display = Get-ChangeAfterMetric -Names $names -MetricLabel $labels.totalClicks
        clicks_change_percent         = Convert-Percent (Get-ChangeAfterMetric -Names $names -MetricLabel $labels.totalClicks)
        total_impressions_display     = $impressions.Value
        total_impressions_approx      = Convert-DisplayNumber $impressions.Value
        impressions_change_percent_display = Get-ChangeAfterMetric -Names $names -MetricLabel $labels.totalImpressions
        impressions_change_percent   = Convert-Percent (Get-ChangeAfterMetric -Names $names -MetricLabel $labels.totalImpressions)
        average_ctr_display           = $ctr.Value
        average_ctr                   = Convert-Percent $ctr.Value
        ctr_change_percent_display    = Get-ChangeAfterMetric -Names $names -MetricLabel $labels.averageCtr
        ctr_change_percent            = Convert-Percent (Get-ChangeAfterMetric -Names $names -MetricLabel $labels.averageCtr)
        keywords                      = $keywords
        documents                     = $documents
    }
}

$snapshots = @()
foreach ($site in $sites) {
    $snapshots += Get-SiteSnapshot -Code $site.Code -SiteUrl $site.Url
}

$result = [ordered]@{
    source           = 'Naver Search Advisor authenticated UI'
    collected_at_utc = [DateTime]::UtcNow.ToString('o')
    excluded_sites   = @('https://hongdae-skin.tistory.com')
    sites            = $snapshots
}

$outputDirectory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    [void](New-Item -ItemType Directory -Path $outputDirectory)
}
$json = $result | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))

"NaverSitesCollected=$($snapshots.Count)"
"KeywordRowsCollected=$((@($snapshots | ForEach-Object { $_.keywords }).Count))"
"DocumentRowsCollected=$((@($snapshots | ForEach-Object { $_.documents }).Count))"
"OutputPath=$OutputPath"
