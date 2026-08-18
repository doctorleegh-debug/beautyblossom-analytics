param(
    [string]$EnvFile = 'C:\Users\metic\Desktop\paseo\project(1)\.env.local',
    [string]$GraphVersion = 'v23.0',
    [switch]$SelfTest
)

# Enumerates every Facebook Page and linked Instagram account reachable by the
# Meta system-user token. Never prints the token itself.
$ErrorActionPreference = 'Stop'

$envMap = @{}
foreach ($line in Get-Content $EnvFile) {
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
}

$token = $envMap['META_SYSTEM_TOKEN']
$bizId = $envMap['META_BUSINESS_ID']
$appId = $envMap['META_APP_ID']

if ($SelfTest) {
    'SelfTest'
    "  META_SYSTEM_TOKEN present = $([bool]$token)  len=$(if($token){$token.Length}else{0})"
    "  META_BUSINESS_ID = $bizId"
    "  META_APP_ID      = $appId"
    'SelfTestPassed=true'
    return
}
if (-not $token) { 'RESULT=NO_TOKEN  .env.local 에 META_SYSTEM_TOKEN 이 없습니다.'; exit 1 }

$base = "https://graph.facebook.com/$GraphVersion"
$hdr = @{ Authorization = "Bearer $token" }

function Show-Err($e, [string]$label) {
    "  $label=FAILED  $($e.Exception.Message)"
    if ($e.ErrorDetails.Message) { '    ' + ($e.ErrorDetails.Message -replace '\s+', ' ').Substring(0, [Math]::Min(300, $e.ErrorDetails.Message.Length)) }
}

'=== 1. 토큰 신원 ==='
try {
    $me = Invoke-RestMethod -Headers $hdr -Uri "$base/me?fields=id,name"
    "  id=$($me.id)  name=$($me.name)"
} catch { Show-Err $_ 'ME' }

'=== 2. 부여된 권한 ==='
try {
    $perm = Invoke-RestMethod -Headers $hdr -Uri "$base/me/permissions"
    $g = @($perm.data | Where-Object { $_.status -eq 'granted' } | ForEach-Object { $_.permission })
    "  granted($($g.Count)) = $($g -join ', ')"
} catch { Show-Err $_ 'PERMISSIONS' }

'=== 3. 접근 가능한 페이지 + 연결된 Instagram ==='
$pages = @()
try {
    $r = Invoke-RestMethod -Headers $hdr -Uri "$base/me/accounts?limit=100&fields=name,id,instagram_business_account{id,username,name,followers_count,media_count},connected_instagram_account{id,username}"
    $pages = @($r.data)
    "  pages_found = $($pages.Count)"
    foreach ($p in $pages) {
        "  PAGE '$($p.name)'  id=$($p.id)"
        if ($p.instagram_business_account) {
            $ig = $p.instagram_business_account
            "     IG(business) @$($ig.username)  id=$($ig.id)  followers=$($ig.followers_count)  media=$($ig.media_count)"
        } elseif ($p.connected_instagram_account) {
            "     IG(connected) @$($p.connected_instagram_account.username)  id=$($p.connected_instagram_account.id)  -- business 연결 아님"
        } else {
            '     IG 연결 없음'
        }
    }
} catch { Show-Err $_ 'PAGES' }

'=== 4. 포트폴리오 소유 자산 ==='
if ($bizId) {
    foreach ($edge in @('owned_pages', 'owned_instagram_accounts', 'client_pages')) {
        try {
            $r = Invoke-RestMethod -Headers $hdr -Uri "$base/$bizId/$edge`?limit=100"
            "  $edge = $(@($r.data).Count)"
            foreach ($a in $r.data) { "     $($a.name)$(if($a.username){" @$($a.username)"})  id=$($a.id)" }
        } catch { Show-Err $_ $edge }
    }
} else { '  META_BUSINESS_ID 없음 - 건너뜀' }

'=== 5. 목표 계정 대조 ==='
$targets = @(
    @{ handle = 'beautyblossom_clinic'; lang = 'KR'; ga4 = '526090588' }
    @{ handle = 'beautyblossom_jp';     lang = 'JP'; ga4 = '534097409' }
    @{ handle = 'beutyblossom_cn';      lang = 'CN'; ga4 = '534099303' }
    @{ handle = 'beautyblossom_global'; lang = 'EN'; ga4 = '534100156' }
    @{ handle = 'beautyblossom_tw';     lang = 'TW'; ga4 = '534131940' }
    @{ handle = 'beautyblossom_th';     lang = 'TH'; ga4 = '537583229' }
)
$reachable = @()
foreach ($p in $pages) {
    if ($p.instagram_business_account) { $reachable += $p.instagram_business_account.username }
    if ($p.connected_instagram_account) { $reachable += $p.connected_instagram_account.username }
}
foreach ($t in $targets) {
    $ok = $reachable -contains $t.handle
    "  [{0}] {1,-22} @{2,-22} GA4={3}" -f $(if ($ok) { 'OK ' } else { 'MISS' }), $t.lang, $t.handle, $t.ga4
}
"  reachable_total = $(@($reachable).Count) / 6"
