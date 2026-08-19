param(
    [Parameter(Mandatory = $true)][string]$Label,
    [int]$Port = 53682,
    [string]$AppId = '1393578062743171',
    [string]$TokenDir = 'C:\Users\metic\Desktop\paseo\project(1)\.secrets',
    [int]$TimeoutSec = 300,
    [switch]$SelfTest
)
# Threads OAuth. Threads runs its own OAuth host and token endpoint and accepts
# the Facebook app id. Authorize must go to threads.com directly - threads.net
# redirects and drops the query string, which surfaces as error 4476002
# ("app id was not sent with the request").
# Each Threads profile authorises separately, so tokens are stored per label.
# Never prints the token; only lengths and derived data.
$ErrorActionPreference = 'Stop'

$Scopes = @(
    'threads_basic'
    'threads_manage_insights'
    'threads_read_replies'
    'threads_manage_replies'
    'threads_keyword_search'
    'threads_profile_discovery'
)
$redirect = "http://localhost:$Port/"
$OutFile = Join-Path $TokenDir "threads-token-$Label.local.json"

if ($SelfTest) {
    'SelfTest'
    "  AppId    = $AppId"
    "  Label    = $Label"
    "  Redirect = $redirect"
    "  Scopes   = $($Scopes -join ',')"
    "  OutFile  = $OutFile (exists=$(Test-Path $OutFile))"
    'SelfTestPassed=true'
    return
}

$authUrl = 'https://www.threads.com/oauth/authorize?' + (@(
    "client_id=$AppId"
    'redirect_uri=' + [uri]::EscapeDataString($redirect)
    'scope=' + [uri]::EscapeDataString(($Scopes -join ','))
    'response_type=code'
) -join '&')

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
"LISTENER=STARTED port=$Port  label=$Label"

Start-Process chrome.exe -ArgumentList '--new-window', $authUrl
'BROWSER=OPENED -> log in with the Instagram account for this Threads profile, then Allow'

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$code = $null; $oauthErr = $null

while ((Get-Date) -lt $deadline -and -not $code -and -not $oauthErr) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 200; continue }
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $buf = New-Object byte[] 32768
    $n = $stream.Read($buf, 0, $buf.Length)
    $reqLine = ([Text.Encoding]::UTF8.GetString($buf, 0, $n) -split "`r`n")[0]

    $isCb = $false
    if ($reqLine -match '^GET\s+(\S+)') {
        $q = $Matches[1]
        if ($q -match '[?&]code=([^&\s]+)')  { $code = [uri]::UnescapeDataString($Matches[1]); $isCb = $true }
        if ($q -match '[?&]error=([^&\s]+)') { $oauthErr = [uri]::UnescapeDataString($Matches[1]); $isCb = $true }
    }
    $msg = if ($code) { '<h2>Authorized.</h2><p>You can close this window.</p>' }
           elseif ($isCb) { '<h2>Authorization failed.</h2><p>Check the terminal output.</p>' }
           else { '<h2>Waiting.</h2>' }
    $body = [Text.Encoding]::UTF8.GetBytes("<!doctype html><html><head><meta charset='utf-8'></head><body style='font-family:sans-serif;padding:48px'>$msg</body></html>")
    $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
    $stream.Write($head, 0, $head.Length); $stream.Write($body, 0, $body.Length); $stream.Flush(); $client.Close()
}
$listener.Stop()

if ($oauthErr) { "RESULT=OAUTH_ERROR $oauthErr"; exit 1 }
if (-not $code) { 'RESULT=TIMEOUT'; exit 1 }
'CALLBACK=RECEIVED'

# Threads exchanges the code on its own graph host, and the app secret is the
# Facebook app secret of the same app.
$envPath = 'C:\Users\metic\Desktop\paseo\project(1)\.env.local'
$cfg = @{}
foreach ($line in Get-Content $envPath) { if ($line -match '^\s*([A-Za-z0-9_]+)\s*=(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() } }
$secret = $cfg['THREADS_APP_SECRET']
if (-not $secret) { $secret = $cfg['META_APP_SECRET'] }
if (-not $secret) { 'RESULT=NO_APP_SECRET  (.env.local 에 THREADS_APP_SECRET 또는 META_APP_SECRET 필요)'; exit 1 }

try {
    $short = Invoke-RestMethod -Method Post -Uri 'https://graph.threads.net/oauth/access_token' -ContentType 'application/x-www-form-urlencoded' -Body @{
        client_id = $AppId; client_secret = $secret; grant_type = 'authorization_code'
        redirect_uri = $redirect; code = $code
    }
} catch {
    $d = ''; if ($_.ErrorDetails.Message) { $d = ($_.ErrorDetails.Message -replace '\s+', ' ') }
    "RESULT=EXCHANGE_FAILED $($_.Exception.Message)"; "  $($d.Substring(0, [Math]::Min(300, $d.Length)))"; exit 1
}
"SHORT_TOKEN len=$($short.access_token.Length) user_id=$($short.user_id)"

# Trade up to the 60-day token straight away so collection is not time-boxed.
$long = $null
try {
    $long = Invoke-RestMethod -Uri ("https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=$secret&access_token=$($short.access_token)")
    "LONG_TOKEN len=$($long.access_token.Length) expires_in=$($long.expires_in) (약 $([math]::Round($long.expires_in/86400))일)"
} catch { 'LONG_EXCHANGE_FAILED - 단기 토큰으로 저장합니다' }

$tok = if ($long) { $long.access_token } else { $short.access_token }
$exp = if ($long) { $long.expires_in } else { 3600 }

if (-not (Test-Path $TokenDir)) { New-Item -ItemType Directory -Path $TokenDir | Out-Null }
[ordered]@{
    label = $Label; app_id = $AppId; user_id = $short.user_id
    access_token = $tok; expires_in = $exp
    scopes = $Scopes
    issued_at_utc = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"

'--- VERIFY ---'
try {
    $me = Invoke-RestMethod -Uri "https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url,threads_biography&access_token=$tok"
    "  @$($me.username)  id=$($me.id)"
} catch {
    $d = ''; if ($_.ErrorDetails.Message) { $d = ($_.ErrorDetails.Message -replace '\s+', ' ') }
    "  VERIFY_FAILED $($d.Substring(0, [Math]::Min(220, $d.Length)))"
}
