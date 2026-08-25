param(
    [int]$Days = 30,
    [string]$OutFile = "$PSScriptRoot\..\data\searchconsole-latest.json",
    [int]$TopRows = 25,
    [switch]$SelfTest
)
# Google Search Console: per-property totals plus top queries / pages / countries / devices.
# Search Console data lags ~2 days, so the window ends 3 days back.
$ErrorActionPreference = 'Stop'

$cfgPath = "$PSScriptRoot\..\.secrets\google-oauth.local.json"
$tokPath = "$PSScriptRoot\..\.secrets\google-oauth-gsc-token.local.json"

if ($SelfTest) {
    'SelfTest'
    "  client_exists = $(Test-Path $cfgPath)"
    "  token_exists  = $(Test-Path $tokPath)"
    "  Days=$Days TopRows=$TopRows"
    'SelfTestPassed=true'
    return
}

$cfg = (Get-Content $cfgPath -Raw | ConvertFrom-Json).web
$tok = Get-Content $tokPath -Raw | ConvertFrom-Json
$refresh = Invoke-RestMethod -Method Post -Uri $cfg.token_uri -ContentType 'application/x-www-form-urlencoded' -Body @{
    client_id = $cfg.client_id; client_secret = $cfg.client_secret
    refresh_token = $tok.refresh_token; grant_type = 'refresh_token'
}
$hdr = @{ Authorization = "Bearer $($refresh.access_token)" }
"AUTH=OK token_len=$($refresh.access_token.Length)"

$sites = Invoke-RestMethod -Headers $hdr -Uri 'https://www.googleapis.com/webmasters/v3/sites'
$entries = @($sites.siteEntry | Where-Object { $_.permissionLevel -ne 'siteUnverifiedUser' })
"SITES=$($entries.Count)"
foreach ($s in $entries) { "   $($s.permissionLevel)  $($s.siteUrl)" }

$end   = (Get-Date).AddDays(-3)
$start = $end.AddDays(-($Days - 1))
$prevEnd = $start.AddDays(-1)
$prevStart = $prevEnd.AddDays(-($Days - 1))
$fmt = 'yyyy-MM-dd'
"RANGE=$($start.ToString($fmt)) ~ $($end.ToString($fmt))"

function Query($siteUrl, $body) {
    $u = 'https://www.googleapis.com/webmasters/v3/sites/' + [uri]::EscapeDataString($siteUrl) + '/searchAnalytics/query'
    return Invoke-RestMethod -Method Post -Uri $u -Headers $hdr -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 6)
}

# Labels mirror the GA4 / Naver property labels so the report can line them up.
function Label-For([string]$u) {
    if ($u -match 'beautyblossomth')      { return 'TH' }
    if ($u -match '//cn\.|/cn\.')         { return 'CN' }
    if ($u -match '//en\.|/en\.')         { return 'EN' }
    if ($u -match '//jp\.|/jp\.')         { return 'JP' }
    if ($u -match '//tw\.|/tw\.')         { return 'TW' }
    if ($u -match 'tistory')              { return 'BLOG' }
    if ($u -match 'beautyblossom\.kr')    { return 'KR' }
    return '?'
}

$out = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source = 'Google Search Console Search Analytics API'
    note = 'Search Console 데이터는 약 2일 지연되어 측정 종료일을 3일 전으로 잡았습니다.'
    range = @{ start = $start.ToString($fmt); end = $end.ToString($fmt); days = $Days }
    prev_range = @{ start = $prevStart.ToString($fmt); end = $prevEnd.ToString($fmt) }
    sites = @()
}

foreach ($s in $entries) {
    $u = $s.siteUrl
    $label = Label-For $u
    if ($label -eq 'BLOG') { Write-Host "-- skip $u (excluded)"; continue }
    Write-Host "-- $label $u"
    $rec = @{ siteUrl = $u; label = $label; permission = $s.permissionLevel; status = 'OK' }
    try {
        $cur = Query $u @{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt); dimensions=@() }
        $prev= Query $u @{ startDate=$prevStart.ToString($fmt); endDate=$prevEnd.ToString($fmt); dimensions=@() }
        function Tot($r) {
            if ($r.rows -and $r.rows.Count -gt 0) {
                return @{ clicks=[double]$r.rows[0].clicks; impressions=[double]$r.rows[0].impressions
                          ctr=[double]$r.rows[0].ctr; position=[double]$r.rows[0].position }
            }
            return @{ clicks=0.0; impressions=0.0; ctr=0.0; position=0.0 }
        }
        $rec.current = Tot $cur
        $rec.previous = Tot $prev

        $q = Query $u @{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt); dimensions=@('query'); rowLimit=$TopRows }
        $rec.queries = @($q.rows | ForEach-Object { @{ query=$_.keys[0]; clicks=[double]$_.clicks; impressions=[double]$_.impressions; ctr=[double]$_.ctr; position=[double]$_.position } })

        $p = Query $u @{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt); dimensions=@('page'); rowLimit=$TopRows }
        $rec.pages = @($p.rows | ForEach-Object { @{ page=$_.keys[0]; clicks=[double]$_.clicks; impressions=[double]$_.impressions; ctr=[double]$_.ctr; position=[double]$_.position } })

        $c = Query $u @{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt); dimensions=@('country'); rowLimit=10 }
        $rec.countries = @($c.rows | ForEach-Object { @{ country=$_.keys[0]; clicks=[double]$_.clicks; impressions=[double]$_.impressions } })

        $dv = Query $u @{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt); dimensions=@('device'); rowLimit=10 }
        $rec.devices = @($dv.rows | ForEach-Object { @{ device=$_.keys[0]; clicks=[double]$_.clicks; impressions=[double]$_.impressions } })

        $dt = Query $u @{ startDate=$start.ToString($fmt); endDate=$end.ToString($fmt); dimensions=@('date'); rowLimit=400 }
        $rec.daily = @($dt.rows | ForEach-Object { @{ date=$_.keys[0]; clicks=[double]$_.clicks; impressions=[double]$_.impressions } })

        "   clicks=$($rec.current.clicks) impressions=$($rec.current.impressions) queries=$($rec.queries.Count) pages=$($rec.pages.Count)"
    } catch {
        $rec.status = 'FAILED'
        $rec.error = $_.Exception.Message
        if ($_.ErrorDetails.Message) { $rec.error_detail = ($_.ErrorDetails.Message -replace '\s+',' ') }
        "   FAILED $($_.Exception.Message)"
    }
    $out.sites += $rec
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
