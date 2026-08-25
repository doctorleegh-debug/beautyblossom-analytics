param(
    [int]$Port = 53682,
    [string]$AppId = '1393578062743171',
    [string]$OutFile = "$PSScriptRoot\..\.secrets\meta-token.local.json",
    [string]$GraphVersion = 'v23.0',
    [int]$TimeoutSec = 300,
    [switch]$SelfTest
)

# Facebook OAuth (implicit flow) via loopback.
# Facebook returns the token in the URL *fragment*, which browsers never send to the
# server. The callback page therefore re-sends it as a query string via JS.
# Never prints the token; only lengths and derived data.
$ErrorActionPreference = 'Stop'

$Scopes = @(
    'pages_show_list'
    'pages_read_engagement'
    'instagram_basic'
    'instagram_manage_insights'
)
$redirect = "http://localhost:$Port/"

if ($SelfTest) {
    'SelfTest'
    "  AppId     = $AppId"
    "  Redirect  = $redirect"
    "  Scopes    = $($Scopes -join ',')"
    "  OutFile   = $OutFile (exists=$(Test-Path $OutFile))"
    'SelfTestPassed=true'
    return
}

$authUrl = "https://www.facebook.com/$GraphVersion/dialog/oauth?" + (@(
    "client_id=$AppId"
    'redirect_uri=' + [uri]::EscapeDataString($redirect)
    'response_type=token'
    'scope=' + [uri]::EscapeDataString(($Scopes -join ','))
) -join '&')

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
"LISTENER=STARTED port=$Port"

Start-Process chrome.exe -ArgumentList '--new-window', $authUrl
'BROWSER=OPENED -> 계정/페이지 선택 후 [계속] / [허용] 클릭'

# The bounce page: reads location.hash and replays it as a query string.
$bounceJs = @'
<!doctype html><html><head><meta charset="utf-8"></head><body>
<p style="font-family:sans-serif;padding:32px">Processing...</p>
<script>
var h = window.location.hash ? window.location.hash.substring(1) : '';
var q = window.location.search ? window.location.search.substring(1) : '';
window.location.replace('/capture?' + (h || q));
</script></body></html>
'@

function Send-Http($stream, [string]$html, [int]$code = 200) {
    $body = [Text.Encoding]::UTF8.GetBytes($html)
    $status = if ($code -eq 200) { '200 OK' } else { '404 Not Found' }
    $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
    $stream.Write($head, 0, $head.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$token = $null; $oauthErr = $null; $expiresIn = $null

while ((Get-Date) -lt $deadline -and -not $token -and -not $oauthErr) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 200; continue }
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $buf = New-Object byte[] 32768
    $n = $stream.Read($buf, 0, $buf.Length)
    $reqLine = ([Text.Encoding]::UTF8.GetString($buf, 0, $n) -split "`r`n")[0]

    $path = ''
    if ($reqLine -match '^GET\s+(\S+)') { $path = $Matches[1] }

    if ($path -like '/capture*') {
        if ($path -match '[?&]access_token=([^&\s]+)')     { $token = [uri]::UnescapeDataString($Matches[1]) }
        if ($path -match '[?&]expires_in=([^&\s]+)')       { $expiresIn = $Matches[1] }
        if ($path -match '[?&]error_description=([^&\s]+)'){ $oauthErr = [uri]::UnescapeDataString($Matches[1]) -replace '\+',' ' }
        elseif ($path -match '[?&]error=([^&\s]+)')        { $oauthErr = [uri]::UnescapeDataString($Matches[1]) }
        $msg = if ($token) { '<h2>Authorized.</h2><p>You can close this window.</p>' } else { '<h2>Authorization failed.</h2><p>Check the terminal output.</p>' }
        Send-Http $stream "<!doctype html><html><head><meta charset='utf-8'></head><body style='font-family:sans-serif;padding:48px'>$msg</body></html>"
    } elseif ($path -eq '/' -or $path -like '/?*') {
        Send-Http $stream $bounceJs
    } else {
        Send-Http $stream '' 404
    }
    $client.Close()
}
$listener.Stop()

if ($oauthErr) { "RESULT=OAUTH_ERROR  $oauthErr"; exit 1 }
if (-not $token) { 'RESULT=TIMEOUT  콜백을 받지 못했습니다.'; exit 1 }

"TOKEN=RECEIVED  len=$($token.Length)  expires_in=$expiresIn"

$out = [ordered]@{
    app_id        = $AppId
    graph_version = $GraphVersion
    token_type    = 'user_access_token_short_lived'
    scopes        = $Scopes
    access_token  = $token
    expires_in    = $expiresIn
    issued_at_utc = (Get-Date).ToUniversalTime().ToString('o')
}
$out | ConvertTo-Json -Depth 4 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"

$base = "https://graph.facebook.com/$GraphVersion"

'--- VERIFY 1: 부여된 권한 ---'
try {
    $perm = Invoke-RestMethod "$base/me/permissions?access_token=$token"
    $granted = @($perm.data | Where-Object { $_.status -eq 'granted' } | ForEach-Object { $_.permission })
    $declined = @($perm.data | Where-Object { $_.status -ne 'granted' } | ForEach-Object { $_.permission })
    "  granted  = $($granted -join ', ')"
    "  declined = $(if ($declined) { $declined -join ', ' } else { '(없음)' })"
} catch { "  PERMISSIONS=FAILED  $($_.Exception.Message)" }

'--- VERIFY 2: 접근 가능한 페이지 + 연결된 Instagram 계정 ---'
try {
    $pages = Invoke-RestMethod "$base/me/accounts?fields=name,id,instagram_business_account{id,username,name,followers_count,media_count}&limit=100&access_token=$token"
    $rows = @($pages.data)
    "  pages_found = $($rows.Count)"
    foreach ($p in $rows) {
        $ig = $p.instagram_business_account
        if ($ig) {
            "    PAGE '$($p.name)' (id=$($p.id))"
            "      └ IG @$($ig.username)  id=$($ig.id)  followers=$($ig.followers_count)  media=$($ig.media_count)"
        } else {
            "    PAGE '$($p.name)' (id=$($p.id))  -- 연결된 Instagram 없음"
        }
    }
    if ($rows.Count -eq 0) { '    (이 계정으로 접근 가능한 페이지가 없습니다)' }
} catch {
    "  PAGES=FAILED  $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { '  ' + $_.ErrorDetails.Message.Substring(0, [Math]::Min(400, $_.ErrorDetails.Message.Length)) }
}

'--- VERIFY 3: Business 포트폴리오 ---'
try {
    $biz = Invoke-RestMethod "$base/me/businesses?fields=id,name&limit=50&access_token=$token"
    "  businesses = $(@($biz.data).Count)"
    foreach ($b in $biz.data) { "    $($b.name)  id=$($b.id)" }
} catch { "  BUSINESSES=FAILED  $($_.Exception.Message)" }
