param(
    [int]$Days = 30,
    [string]$OutFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\ga4-latest.json'
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

$cfgPath = 'C:\Users\metic\Desktop\paseo\project(1)\.secrets\google-oauth.local.json'
$tokPath = 'C:\Users\metic\Desktop\paseo\project(1)\.secrets\google-oauth-token.local.json'
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
    $metrics = @(
        @{ name='activeUsers' }, @{ name='newUsers' }, @{ name='sessions' },
        @{ name='screenPageViews' }, @{ name='eventCount' },
        @{ name='averageSessionDuration' }, @{ name='bounceRate' }
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
        metrics = @(@{ name='activeUsers' }, @{ name='sessions' })
        orderBys = @(@{ dimension = @{ dimensionName='date' } })
    }
    $chan = Run-Report $p.id @{
        dateRanges = @(@{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt) })
        dimensions = @(@{ name='sessionDefaultChannelGroup' })
        metrics = @(@{ name='sessions' })
        orderBys = @(@{ metric = @{ metricName='sessions' }; desc=$true })
        limit = 10
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

    function Vals($r) { if ($r.rows) { return $r.rows[0].metricValues | ForEach-Object { $_.value } } else { return @(0,0,0,0,0,0,0) } }
    $c = Vals $cur; $v = Vals $prev

    $result.properties += @{
        id = $p.id; label = $p.label; name = $p.name
        current = @{
            activeUsers=[double]$c[0]; newUsers=[double]$c[1]; sessions=[double]$c[2]
            pageViews=[double]$c[3]; eventCount=[double]$c[4]
            avgSessionDuration=[double]$c[5]; bounceRate=[double]$c[6]
        }
        previous = @{
            activeUsers=[double]$v[0]; newUsers=[double]$v[1]; sessions=[double]$v[2]
            pageViews=[double]$v[3]; eventCount=[double]$v[4]
            avgSessionDuration=[double]$v[5]; bounceRate=[double]$v[6]
        }
        daily = @($daily.rows | ForEach-Object { @{ date=$_.dimensionValues[0].value; activeUsers=[double]$_.metricValues[0].value; sessions=[double]$_.metricValues[1].value } })
        channels = @($chan.rows | ForEach-Object { @{ channel=$_.dimensionValues[0].value; sessions=[double]$_.metricValues[0].value } })
        countries = @($geo.rows | ForEach-Object { @{ country=$_.dimensionValues[0].value; activeUsers=[double]$_.metricValues[0].value } })
        devices = @($dev.rows | ForEach-Object { @{ device=$_.dimensionValues[0].value; sessions=[double]$_.metricValues[0].value } })
    }
    "   users=$($c[0]) sessions=$($c[2]) events=$($c[4])"
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$result | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
