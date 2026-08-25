param(
    [int]$Port = 53682,
    [string]$ClientFile = "$PSScriptRoot\..\.secrets\google-oauth.local.json",
    [string]$OutFile    = "$PSScriptRoot\..\.secrets\google-oauth-youtube-token.local.json",
    [int]$TimeoutSec = 300,
    [switch]$SelfTest
)

# YouTube OAuth (Data API v3 + Analytics API v2) via loopback redirect.
# Never prints secret values; only lengths / masked forms.
$ErrorActionPreference = 'Stop'

$Scopes = @(
    'https://www.googleapis.com/auth/youtube.readonly'
    'https://www.googleapis.com/auth/yt-analytics.readonly'
)

if ($SelfTest) {
    'SelfTest'
    "  ClientFile_exists = $(Test-Path $ClientFile)"
    "  OutFile_exists    = $(Test-Path $OutFile)"
    "  Redirect          = http://localhost:$Port/"
    "  Scopes            = $($Scopes -join ' ')"
    'SelfTestPassed=true'
    return
}

$cfg = (Get-Content $ClientFile -Raw | ConvertFrom-Json).web
$redirect = "http://localhost:$Port/"
$state = [guid]::NewGuid().ToString('N')

$authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + (@(
    'client_id='     + [uri]::EscapeDataString($cfg.client_id)
    'redirect_uri='  + [uri]::EscapeDataString($redirect)
    'response_type=code'
    'scope='         + [uri]::EscapeDataString(($Scopes -join ' '))
    'access_type=offline'
    'prompt=consent'
    'include_granted_scopes=false'
    'state='         + $state
) -join '&')

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
"LISTENER=STARTED port=$Port"

Start-Process chrome.exe -ArgumentList '--new-window', $authUrl
'BROWSER=OPENED  -> 브라우저에서 계정 선택 후 [허용] 클릭'

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$code = $null; $oauthErr = $null; $gotState = $null

while ((Get-Date) -lt $deadline -and -not $code -and -not $oauthErr) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 200; continue }

    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $buf = New-Object byte[] 16384
    $n = $stream.Read($buf, 0, $buf.Length)
    $reqLine = ([Text.Encoding]::UTF8.GetString($buf, 0, $n) -split "`r`n")[0]

    $isCallback = $false
    if ($reqLine -match '^GET\s+(\S+)') {
        $q = $Matches[1]
        if ($q -match '[?&]state=([^&\s]+)') { $gotState = $Matches[1] }
        if ($q -match '[?&]code=([^&\s]+)')  { $code = [uri]::UnescapeDataString($Matches[1]); $isCallback = $true }
        if ($q -match '[?&]error=([^&\s]+)') { $oauthErr = [uri]::UnescapeDataString($Matches[1]); $isCallback = $true }
    }

    if ($isCallback) {
        $msg = if ($code) { '<h2>&#51064;&#51613; &#50756;&#47308;</h2><p>&#52285;&#51012; &#45803;&#51004;&#49483;&#46020; &#46121;&#45768;&#45796;.</p>' }
               else       { '<h2>&#51064;&#51613; &#49892;&#54056;</h2><p>&#53552;&#48120;&#45320;&#47196; &#46028;&#50500;&#44032;&#49464;&#50836;.</p>' }
        $body = [Text.Encoding]::UTF8.GetBytes("<!doctype html><html><head><meta charset='utf-8'></head><body style='font-family:sans-serif;padding:48px'>$msg</body></html>")
        $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
    } else {
        $body = [byte[]]@()
        $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
    }
    $stream.Write($head, 0, $head.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush(); $client.Close()
}
$listener.Stop()

if ($oauthErr) { "RESULT=OAUTH_ERROR  error=$oauthErr"; exit 1 }
if (-not $code) { 'RESULT=TIMEOUT  콜백을 받지 못했습니다.'; exit 1 }
if ($gotState -ne $state) { 'RESULT=STATE_MISMATCH  CSRF 검증 실패'; exit 1 }
'CALLBACK=RECEIVED  state_verified=true'

$tok = Invoke-RestMethod -Method Post -Uri $cfg.token_uri -ContentType 'application/x-www-form-urlencoded' -Body @{
    code          = $code
    client_id     = $cfg.client_id
    client_secret = $cfg.client_secret
    redirect_uri  = $redirect
    grant_type    = 'authorization_code'
}

if (-not $tok.refresh_token) { 'RESULT=NO_REFRESH_TOKEN  (prompt=consent 필요)'; exit 1 }

$out = [ordered]@{
    token_type    = $tok.token_type
    scope         = $tok.scope
    expires_in    = $tok.expires_in
    access_token  = $tok.access_token
    refresh_token = $tok.refresh_token
    issued_at_utc = (Get-Date).ToUniversalTime().ToString('o')
}
$out | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding utf8

'TOKEN=SAVED'
"  file              = $OutFile"
"  access_token_len  = $($tok.access_token.Length)"
"  refresh_token_len = $($tok.refresh_token.Length)"
"  granted_scope     = $($tok.scope)"

$hdr = @{ Authorization = "Bearer $($tok.access_token)" }

'--- VERIFY 1: Data API v3 channels.list(mine=true) ---'
try {
    $ch = Invoke-RestMethod -Headers $hdr -Uri 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&mine=true'
    "  channels_found = $($ch.items.Count)"
    foreach ($c in $ch.items) {
        "  id=$($c.id)  title=$($c.snippet.title)  subs=$($c.statistics.subscriberCount)  videos=$($c.statistics.videoCount)  views=$($c.statistics.viewCount)"
    }
} catch {
    "  DATA_API=FAILED  $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { '  ' + $_.ErrorDetails.Message.Substring(0, [Math]::Min(300, $_.ErrorDetails.Message.Length)) }
}

'--- VERIFY 2: YouTube Analytics API v2 ---'
try {
    $end = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
    $start = (Get-Date).AddDays(-30).ToString('yyyy-MM-dd')
    $ya = Invoke-RestMethod -Headers $hdr -Uri ("https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=$start&endDate=$end&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained")
    "  range = $start ~ $end"
    "  columns = $(($ya.columnHeaders | ForEach-Object { $_.name }) -join ',')"
    "  rows    = $(($ya.rows | ForEach-Object { $_ -join ',' }) -join ' | ')"
    'ANALYTICS_API=OK'
} catch {
    "  ANALYTICS_API=FAILED  $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { '  ' + $_.ErrorDetails.Message.Substring(0, [Math]::Min(400, $_.ErrorDetails.Message.Length)) }
}
