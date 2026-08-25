param(
    [int]$Days = 30,
    [string]$OutFile = "$PSScriptRoot\..\data\ga4-latest.json"
)
# Collects GA4 metrics for the six Beauty Blossom properties.
# Excludes "Beauty Blossom - Link" (549949719) by design.
$ErrorActionPreference = 'Stop'

$props = @(
    @{ id = '526090588'; label = 'KR'; name = 'Beauty Blossom Korea' }
    @{ id = '534097409'; label = 'JP'; name = 'Beauty Blossom JP' }
    @{ id = '534099303'; label = 'CN'; name = 'Beauty Blossom CN' }
    @{ id = '534100156'; label = 'EN'; name = 'Beauty Blossom EN' }
    @{ id = '534131940'; label = 'TW'; name = 'Beauty Blossom TW' }
    @{ id = '537583229'; label = 'TH'; name = 'Beauty Blossom Thailand' }
)

$cfgPath = "$PSScriptRoot\..\.secrets\google-oauth.local.json"
$tokPath = "$PSScriptRoot\..\.secrets\google-oauth-token.local.json"
$cfg = (Get-Content $cfgPath -Raw | ConvertFrom-Json).web
$tok = Get-Content $tokPath -Raw | ConvertFrom-Json

$refresh = Invoke-RestMethod -Method Post -Uri $cfg.token_uri -ContentType 'application/x-www-form-urlencoded' -Body @{
    client_id = $cfg.client_id; client_secret = $cfg.client_secret
    refresh_token = $tok.refresh_token; grant_type = 'refresh_token'
}
$hdr = @{ Authorization = "Bearer $($refresh.access_token)" }
"AUTH=OK token_len=$($refresh.access_token.Length)"

$end      = (Get-Date).AddDays(-1)
$start    = $end.AddDays(-($Days - 1))
$prevEnd  = $start.AddDays(-1)
$prevStart= $prevEnd.AddDays(-($Days - 1))
$fmt = 'yyyy-MM-dd'
"RANGE=$($start.ToString($fmt)) ~ $($end.ToString($fmt))  (prev: $($prevStart.ToString($fmt)) ~ $($prevEnd.ToString($fmt)))"

function Run-Report($propId, $body) {
    $uri = "https://analyticsdata.googleapis.com/v1beta/properties/$propId`:runReport"
    return Invoke-RestMethod -Method Post -Uri $uri -Headers $hdr -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8)
}

$result = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    range = @{ start = $start.ToString($fmt); end = $end.ToString($fmt); days = $Days }
    prev_range = @{ start = $prevStart.ToString($fmt); end = $prevEnd.ToString($fmt) }
    properties = @()
}

foreach ($p in $props) {
    Write-Host "-- $($p.label) $($p.id)"
    # keyEvents is what the clinic actually cares about: kakao/whatsapp/line/wechat taps,
    # form submits and phone taps are all registered as key events on every property.
    $metrics = @(
        @{ name='activeUsers' }, @{ name='newUsers' }, @{ name='sessions' },
        @{ name='screenPageViews' }, @{ name='eventCount' },
        @{ name='averageSessionDuration' }, @{ name='bounceRate' }, @{ name='keyEvents' }
    )

    $cur = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt) })
        metrics = $metrics
    }
    $prev = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$prevStart.ToString($fmt); endDate=$prevEnd.ToString($fmt) })
        metrics = $metrics
    }
    $daily = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt) })
        dimensions = @(@{ name='date' })
        metrics = @(@{ name='activeUsers' }, @{ name='sessions' }, @{ name='keyEvents' })
        orderBys = @(@{ dimension = @{ dimensionName='date' } })
    }
    # Key events were only registered part-way through the history, so a month-over-month
    # comparison is meaningless until the previous window is fully covered. Record the
    # first day that ever reported one and let the report decide whether a delta is valid.
    $firstKe = Run-Report $p.id @{
        dateRanges = @(@{ startDate='2024-01-01'; endDate=$end.ToString($fmt) })
        dimensions = @(@{ name='date' })
        metrics = @(@{ name='keyEvents' })
        metricFilter = @{ filter = @{ fieldName='keyEvents'; numericFilter = @{ operation='GREATER_THAN'; value = @{ int64Value='0' } } } }
        orderBys = @(@{ dimension = @{ dimensionName='date' } })
        limit = 1
    }
    $chan = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt) })
        dimensions = @(@{ name='sessionDefaultChannelGroup' })
        metrics = @(@{ name='sessions' }, @{ name='keyEvents' }, @{ name='bounceRate' })
        orderBys = @(@{ metric = @{ metricName='sessions' }; desc=$true })
        limit = 10
    }
    $chanPrev = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$prevStart.ToString($fmt); endDate=$prevEnd.ToString($fmt) })
        dimensions = @(@{ name='sessionDefaultChannelGroup' })
        metrics = @(@{ name='sessions' }, @{ name='keyEvents' })
        limit = 20
    }
    # Every event, not just the key ones: naver_booking_click is a real booking intent
    # but is not registered as a key event, so it would otherwise vanish from the report.
    $ev = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt) })
        dimensions = @(@{ name='eventName' })
        metrics = @(@{ name='eventCount' }, @{ name='keyEvents' })
        orderBys = @(@{ metric = @{ metricName='eventCount' }; desc=$true })
        limit = 40
    }
    $evPrev = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$prevStart.ToString($fmt); endDate=$prevEnd.ToString($fmt) })
        dimensions = @(@{ name='eventName' })
        metrics = @(@{ name='eventCount' }, @{ name='keyEvents' })
        limit = 40
    }
    $geo = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt) })
        dimensions = @(@{ name='country' })
        metrics = @(@{ name='activeUsers' })
        orderBys = @(@{ metric = @{ metricName='activeUsers' }; desc=$true })
        limit = 8
    }
    $dev = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt) })
        dimensions = @(@{ name='deviceCategory' })
        metrics = @(@{ name='sessions' })
        orderBys = @(@{ metric = @{ metricName='sessions' }; desc=$true })
    }

    function Vals($r) { if ($r.rows) { return $r.rows[0].metricValues | ForEach-Object { $_.value } } else { return @(0,0,0,0,0,0,0,0) } }
    $c = Vals $cur; $v = Vals $prev

    $chanPrevMap = @{}
    foreach ($r in $chanPrev.rows) { $chanPrevMap[$r.dimensionValues[0].value] = @{ sessions=[double]$r.metricValues[0].value; keyEvents=[double]$r.metricValues[1].value } }
    $evPrevMap = @{}
    foreach ($r in $evPrev.rows) { $evPrevMap[$r.dimensionValues[0].value] = [double]$r.metricValues[0].value }

    $result.properties += @{
        id = $p.id; label = $p.label; name = $p.name
        current = @{
            activeUsers=[double]$c[0]; newUsers=[double]$c[1]; sessions=[double]$c[2]
            pageViews=[double]$c[3]; eventCount=[double]$c[4]
            avgSessionDuration=[double]$c[5]; bounceRate=[double]$c[6]; keyEvents=[double]$c[7]
        }
        previous = @{
            activeUsers=[double]$v[0]; newUsers=[double]$v[1]; sessions=[double]$v[2]
            pageViews=[double]$v[3]; eventCount=[double]$v[4]
            avgSessionDuration=[double]$v[5]; bounceRate=[double]$v[6]; keyEvents=[double]$v[7]
        }
        key_events_from = $(if ($firstKe.rows) { $firstKe.rows[0].dimensionValues[0].value } else { $null })
        daily = @($daily.rows | ForEach-Object { @{ date=$_.dimensionValues[0].value; activeUsers=[double]$_.metricValues[0].value; sessions=[double]$_.metricValues[1].value; keyEvents=[double]$_.metricValues[2].value } })
        channels = @($chan.rows | ForEach-Object {
            $n = $_.dimensionValues[0].value; $pv = $chanPrevMap[$n]
            @{ channel=$n; sessions=[double]$_.metricValues[0].value; keyEvents=[double]$_.metricValues[1].value
               bounceRate=[double]$_.metricValues[2].value
               prevSessions=$(if ($pv) { $pv.sessions } else { 0 }); prevKeyEvents=$(if ($pv) { $pv.keyEvents } else { 0 }) } })
        events = @($ev.rows | ForEach-Object {
            $n = $_.dimensionValues[0].value
            @{ name=$n; count=[double]$_.metricValues[0].value; keyEvents=[double]$_.metricValues[1].value
               prevCount=$(if ($evPrevMap.ContainsKey($n)) { $evPrevMap[$n] } else { 0 }) } })
        countries = @($geo.rows | ForEach-Object { @{ country=$_.dimensionValues[0].value; activeUsers=[double]$_.metricValues[0].value } })
        devices = @($dev.rows | ForEach-Object { @{ device=$_.dimensionValues[0].value; sessions=[double]$_.metricValues[0].value } })
    }
    $cvr = $(if ([double]$c[0]) { [double]$c[7] / [double]$c[0] * 100 } else { 0 })
    $kf = $(if ($firstKe.rows) { $firstKe.rows[0].dimensionValues[0].value } else { '없음' })
    "   users=$($c[0]) sessions=$($c[2]) 문의=$($c[7]) 전환율=$([Math]::Round($cvr,2))%  측정시작=$kf"
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$result | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
