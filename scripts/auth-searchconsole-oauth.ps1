param(
    [int]$Port = 53682,
    [string]$ClientFile = "$PSScriptRoot\..\.secrets\google-oauth.local.json",
    [string]$OutFile    = "$PSScriptRoot\..\.secrets\google-oauth-gsc-token.local.json",
    [int]$TimeoutSec = 300,
    [switch]$SelfTest
)

# Google Search Console OAuth (loopback redirect), reusing the existing web client.
# Never prints the token; only lengths and derived data.
$ErrorActionPreference = 'Stop'

$Scopes = @('https://www.googleapis.com/auth/webmasters.readonly')
$redirect = "http://localhost:$Port/"

if ($SelfTest) {
    'SelfTest'
    "  ClientFile_exists = $(Test-Path $ClientFile)"
    "  OutFile_exists    = $(Test-Path $OutFile)"
    "  Redirect          = $redirect"
    "  Scopes            = $($Scopes -join ' ')"
    'SelfTestPassed=true'
    return
}

$cfg = (Get-Content $ClientFile -Raw | ConvertFrom-Json).web
$state = [guid]::NewGuid().ToString('N')

$authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + (@(
    'client_id='    + [uri]::EscapeDataString($cfg.client_id)
    'redirect_uri=' + [uri]::EscapeDataString($redirect)
    'response_type=code'
    'scope='        + [uri]::EscapeDataString(($Scopes -join ' '))
    'access_type=offline'
    'prompt=consent'
    'state='        + $state
) -join '&')

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
"LISTENER=STARTED port=$Port"

Start-Process chrome.exe -ArgumentList '--new-window', $authUrl
'BROWSER=OPENED -> pick the account, then Allow'

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
        $msg = if ($code) { '<h2>Authorized.</h2><p>You can close this window.</p>' }
               else       { '<h2>Authorization failed.</h2><p>Check the terminal output.</p>' }
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

if ($oauthErr) { "RESULT=OAUTH_ERROR  $oauthErr"; exit 1 }
if (-not $code) { 'RESULT=TIMEOUT'; exit 1 }
if ($gotState -ne $state) { 'RESULT=STATE_MISMATCH'; exit 1 }
'CALLBACK=RECEIVED state_verified=true'

$tok = Invoke-RestMethod -Method Post -Uri $cfg.token_uri -ContentType 'application/x-www-form-urlencoded' -Body @{
    code = $code; client_id = $cfg.client_id; client_secret = $cfg.client_secret
    redirect_uri = $redirect; grant_type = 'authorization_code'
}
if (-not $tok.refresh_token) { 'RESULT=NO_REFRESH_TOKEN'; exit 1 }

[ordered]@{
    token_type    = $tok.token_type
    scope         = $tok.scope
    expires_in    = $tok.expires_in
    access_token  = $tok.access_token
    refresh_token = $tok.refresh_token
    issued_at_utc = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding utf8

"TOKEN=SAVED  refresh_len=$($tok.refresh_token.Length)  scope=$($tok.scope)"

$hdr = @{ Authorization = "Bearer $($tok.access_token)" }
'--- VERIFY: Search Console sites ---'
try {
    $sites = Invoke-RestMethod -Headers $hdr -Uri 'https://www.googleapis.com/webmasters/v3/sites'
    "  sites_found = $(@($sites.siteEntry).Count)"
    foreach ($s in $sites.siteEntry) { "   $($s.permissionLevel.PadRight(16)) $($s.siteUrl)" }
} catch {
    "  SITES=FAILED  $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { '  ' + ($_.ErrorDetails.Message -replace '\s+',' ').Substring(0, [Math]::Min(300, $_.ErrorDetails.Message.Length)) }
}
