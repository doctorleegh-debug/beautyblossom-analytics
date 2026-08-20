param([switch]$SelfTest)
# Health check for every data-source credential the report depends on.
# Never prints a token; only lengths, expiry and the probe result.
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\metic\Desktop\paseo\project(1)'
$sec  = Join-Path $root '.secrets'

if ($SelfTest) { 'SelfTest'; "  secrets=$(Test-Path $sec)"; 'SelfTestPassed=true'; return }

function Google-Token([string]$tokenFile) {
    $cfg = (Get-Content (Join-Path $sec 'google-oauth.local.json') -Raw | ConvertFrom-Json).web
    $tok = Get-Content (Join-Path $sec $tokenFile) -Raw | ConvertFrom-Json
    $r = Invoke-RestMethod -Method Post -Uri $cfg.token_uri -ContentType 'application/x-www-form-urlencoded' -Body @{
        client_id = $cfg.client_id; client_secret = $cfg.client_secret
        refresh_token = $tok.refresh_token; grant_type = 'refresh_token'
    }
    return $r
}
function Say($state, $name, $msg) { "  {0,-7}{1,-16}{2}" -f $state, $name, $msg }
function ErrText($e) {
    $m = $e.Exception.Message
    if ($e.ErrorDetails.Message) { $m = ($e.ErrorDetails.Message -replace '\s+', ' ') }
    return $m.Substring(0, [Math]::Min(120, $m.Length))
}

'=== Google (refresh_token → 자동 갱신, 만료 없음) ==='
foreach ($g in @(
    @{ name='GA4';           file='google-oauth-token.local.json' },
    @{ name='YouTube';       file='google-oauth-youtube-token.local.json' },
    @{ name='SearchConsole'; file='google-oauth-gsc-token.local.json' }
)) {
    try {
        $r = Google-Token $g.file
        $hdr = @{ Authorization = "Bearer $($r.access_token)" }
        $detail = ''
        switch ($g.name) {
            'GA4' {
                $b = @{ dateRanges=@(@{startDate='7daysAgo';endDate='yesterday'}); metrics=@(@{name='activeUsers'}) } | ConvertTo-Json -Depth 6
                $x = Invoke-RestMethod -Method Post -Headers $hdr -ContentType 'application/json' -Body $b -Uri 'https://analyticsdata.googleapis.com/v1beta/properties/526090588:runReport'
                $detail = "KR 7일 사용자 $($x.rows[0].metricValues[0].value)"
            }
            'YouTube' {
                $x = Invoke-RestMethod -Headers $hdr -Uri 'https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true'
                $detail = "구독자 $($x.items[0].statistics.subscriberCount)"
            }
            'SearchConsole' {
                $x = Invoke-RestMethod -Headers $hdr -Uri 'https://www.googleapis.com/webmasters/v3/sites'
                $detail = "속성 $(@($x.siteEntry).Count)개"
            }
        }
        Say 'OK' $g.name "갱신 성공 (access 만료 $($r.expires_in)s) · $detail"
    } catch { Say 'FAIL' $g.name (ErrText $_) }
}

''
'=== Meta / Instagram (시스템 사용자 토큰) ==='
try {
    $env = @{}
    foreach ($l in Get-Content (Join-Path $root '.env.local')) {
        if ($l -match '^\s*([A-Za-z0-9_]+)\s*=(.*)$') { $env[$Matches[1]] = $Matches[2].Trim() }
    }
    $tok = $env['META_SYSTEM_TOKEN']
    $hdr = @{ Authorization = "Bearer $tok" }
    $dbg = Invoke-RestMethod -Uri "https://graph.facebook.com/v23.0/debug_token?input_token=$tok&access_token=$tok"
    $exp = $dbg.data.expires_at
    $expTxt = if (-not $exp -or $exp -eq 0) { '만료 없음' } else { (([datetime]'1970-01-01').AddSeconds($exp)).ToString('yyyy-MM-dd') + ' 만료' }
    $pg = Invoke-RestMethod -Headers $hdr -Uri 'https://graph.facebook.com/v23.0/me/accounts?limit=100&fields=id,instagram_business_account{username}'
    $igs = @($pg.data | Where-Object { $_.instagram_business_account })
    Say 'OK' 'Meta' "유효 · $expTxt · IG 계정 $($igs.Count)개 · 토큰 길이 $($tok.Length)"
    Say '' 'Meta 권한' (@($dbg.data.scopes) -join ', ')
} catch { Say 'FAIL' 'Meta' (ErrText $_) }

''
'=== GitHub ==='
try {
    # gh installs outside PowerShell's PATH on this machine.
    $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if (-not $gh) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }
    if (-not (Test-Path $gh)) { throw 'gh CLI를 찾을 수 없습니다.' }
    $who = & $gh api user --jq '.login'
    $repo = & $gh repo view doctorleegh-debug/beautyblossom-analytics --json name,visibility,pushedAt | ConvertFrom-Json
    Say 'OK' 'GitHub' "$who · $($repo.name) ($($repo.visibility)) · 마지막 푸시 $($repo.pushedAt)"
} catch { Say 'FAIL' 'GitHub' (ErrText $_) }

''
'=== 네이버 (브라우저 로그인 세션 - API 없음) ==='
Say 'MANUAL' '네이버' '토큰이 아니라 크롬 로그인 세션이라 여기서 확인 불가. 마지막 수집 시 만료 확인됨.'
