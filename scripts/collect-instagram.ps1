param(
    [string]$OutFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\instagram-latest.json',
    [string]$HistFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\instagram-history.json',
    [int]$Days = 30,
    [switch]$SelfTest
)
# Instagram accounts reached through their linked Facebook Pages.
#
# Uses META_SYSTEM_TOKEN (system user, never expires) which carries
# instagram_manage_insights, so views / reach / saves / profile views are all
# available. Account-level metrics need metric_type=total_value; per-media
# metrics do not take that parameter.
#
# Post-level likes and comments still drive the period comparison, because
# account insights only reach ~30 days back and cannot be split into two
# windows in one call.
$ErrorActionPreference = 'Stop'

$envPath = 'C:\Users\metic\Desktop\paseo\project(1)\.env.local'
$cfg = @{}
foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
$tok = $cfg['META_SYSTEM_TOKEN']
$base = 'https://graph.facebook.com/v23.0'

$labelFor = @{
    'BeautyblossomKorea'    = 'KR'
    'BeautyblossomJapan'    = 'JP'
    'BeautyblossomTaiwan'   = 'TW'
    'BeautyblossomThailand' = 'TH'
    'BeautyblossomGlobal'   = 'EN'
}
$ACCOUNT_METRICS = @('views', 'reach', 'profile_views', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'accounts_engaged')
$MEDIA_METRICS   = @('views', 'reach', 'saved', 'shares', 'total_interactions')

if ($SelfTest) {
    'SelfTest'
    "  system_token = $([bool]$tok)  len=$(if($tok){$tok.Length}else{0})"
    "  history_file = $(Test-Path $HistFile)"
    "  Days         = $Days"
    'SelfTestPassed=true'
    return
}
if (-not $tok) { 'RESULT=NO_SYSTEM_TOKEN'; exit 1 }

$hdr = @{ Authorization = "Bearer $tok" }

$granted = @()
try { $granted = @((Invoke-RestMethod -Headers $hdr -Uri "$base/me/permissions").data | Where-Object { $_.status -eq 'granted' } | ForEach-Object { $_.permission }) } catch {}
$hasInsights = $granted -contains 'instagram_manage_insights'
"PERMISSIONS = $($granted -join ', ')"
"INSIGHTS    = $hasInsights"

$now       = Get-Date
$curStart  = $now.AddDays(-$Days)
$prevStart = $now.AddDays(-($Days * 2))
$fmt = 'yyyy-MM-dd'
$since = [int]$curStart.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalSeconds
$until = [int]$now.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalSeconds
"WINDOW  current $($curStart.ToString($fmt)) ~ $($now.ToString($fmt))   previous $($prevStart.ToString($fmt)) ~ $($curStart.ToString($fmt))"

$out = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source = 'Meta Graph API (system user token) via linked Facebook Pages'
    granted_permissions = $granted
    insights_available = $hasInsights
    range = @{ start = $curStart.ToString($fmt); end = $now.ToString($fmt); days = $Days }
    prev_range = @{ start = $prevStart.ToString($fmt); end = $curStart.ToString($fmt) }
    note = '조회수·도달·저장·프로필 조회는 계정 인사이트 값이고, 게시물 수·좋아요·댓글의 전월 대비는 게시물 발행일로 기간을 나눠 계산했습니다.'
    accounts = @()
}

$pages = @()
try {
    $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 45 -Uri "$base/me/accounts?limit=100&fields=id,name,followers_count,instagram_business_account{id,username,name,biography,website,followers_count,follows_count,media_count}"
    $pages = @($r.data | Where-Object { $_.instagram_business_account })
} catch { "PAGES_FAILED $($_.Exception.Message)"; exit 1 }
"PAGES with IG = $($pages.Count)"

function Get-AccountInsight($igId, $metric) {
    try {
        $u = "$base/$igId/insights?metric=$metric&metric_type=total_value&period=day&since=$since&until=$until"
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 35 -Uri $u
        return [double]$r.data[0].total_value.value
    } catch { return $null }
}
function Get-MediaInsight($mediaId, $metric) {
    try {
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 30 -Uri "$base/$mediaId/insights?metric=$metric"
        return [double]$r.data[0].values[0].value
    } catch { return $null }
}

foreach ($pg in $pages) {
    $ig = $pg.instagram_business_account
    $label = $labelFor[$pg.name]
    if (-not $label) { $label = '?' }
    Write-Host "-- $label $($pg.name)"
    $rec = @{
        page = $pg.name; pageId = $pg.id; label = $label; status = 'OK'
        ig = @{
            id = $ig.id; username = $ig.username; name = $ig.name
            biography = $ig.biography; website = $ig.website
            followers = [double]$ig.followers_count
            follows = [double]$ig.follows_count
            media_count = [double]$ig.media_count
        }
    }
    try {
        if ($hasInsights) {
            $ins = @{}
            foreach ($m in $ACCOUNT_METRICS) { $v = Get-AccountInsight $ig.id $m; if ($null -ne $v) { $ins[$m] = $v } }
            $rec.insights = $ins

            # Daily follower deltas: the API returns the change, not the running total.
            try {
                $fc = Invoke-RestMethod -Headers $hdr -TimeoutSec 35 -Uri "$base/$($ig.id)/insights?metric=follower_count&period=day&since=$since&until=$until"
                $vals = @($fc.data[0].values)
                $sum = 0.0; foreach ($v in $vals) { $sum += [double]$v.value }
                $rec.follower_growth = $sum
                $rec.follower_daily = @($vals | ForEach-Object { @{ date = $_.end_time.Substring(0,10); value = [double]$_.value } })
            } catch {}
        }

        # Media feed covers both comparison windows.
        $all = @()
        $uri = "$base/$($ig.id)/media?limit=100&fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count"
        $guard = 0
        while ($uri -and $guard -lt 12) {
            $guard++
            $page = Invoke-RestMethod -Headers $hdr -TimeoutSec 45 -Uri $uri
            $rows = @($page.data)
            if ($rows.Count -eq 0) { break }
            $all += $rows
            if ([datetime]::Parse($rows[-1].timestamp) -lt $prevStart) { break }
            $uri = $page.paging.next
        }

        function Bucket($items) {
            $likes = 0.0; $comments = 0.0; $reels = 0
            foreach ($m in $items) {
                $likes += [double]$m.like_count
                $comments += [double]$m.comments_count
                if ($m.media_product_type -eq 'REELS') { $reels++ }
            }
            $n = @($items).Count
            return @{
                posts = $n; reels = $reels; likes = $likes; comments = $comments
                engagement = $likes + $comments
                avgEngagement = $(if ($n) { ($likes + $comments) / $n } else { 0 })
            }
        }
        $cur  = @($all | Where-Object { [datetime]::Parse($_.timestamp) -ge $curStart })
        $prev = @($all | Where-Object { $t = [datetime]::Parse($_.timestamp); $t -ge $prevStart -and $t -lt $curStart })
        $rec.current  = Bucket $cur
        $rec.previous = Bucket $prev

        # Top posts by views when insights are available, else by engagement.
        $top = @($cur | Sort-Object { [double]($_.like_count + $_.comments_count) } -Descending | Select-Object -First 12)
        $rec.media = @($top | ForEach-Object {
            $m = @{ id=$_.id; type=$_.media_type; product=$_.media_product_type; permalink=$_.permalink
                    timestamp=$_.timestamp; likes=[double]$_.like_count; comments=[double]$_.comments_count
                    caption=$(if ($_.caption) { $_.caption.Substring(0, [Math]::Min(90, $_.caption.Length)) } else { '' }) }
            if ($hasInsights) {
                foreach ($mm in $MEDIA_METRICS) { $v = Get-MediaInsight $_.id $mm; if ($null -ne $v) { $m[$mm] = $v } }
            }
            $m
        })
        if ($hasInsights) { $rec.media = @($rec.media | Sort-Object { if ($_.views) { [double]$_.views } else { 0 } } -Descending) }

        $v = $rec.insights
        "   @{0,-22} followers={1,-6} views={2,-8} reach={3,-7} 게시물 {4}(직전 {5})" -f `
            $ig.username, $ig.followers_count, $(if($v.views){$v.views}else{'-'}), $(if($v.reach){$v.reach}else{'-'}), $rec.current.posts, $rec.previous.posts
    } catch {
        $rec.status = 'PARTIAL'; $rec.error = $_.Exception.Message
        "   PARTIAL $($_.Exception.Message)"
    }
    $out.accounts += $rec
}

# Follower snapshots make growth measurable across runs.
$hist = @()
if (Test-Path $HistFile) { try { $hist = @((Get-Content $HistFile -Raw | ConvertFrom-Json)) } catch { $hist = @() } }
$snapshot = @{
    date = $now.ToString($fmt); at_utc = (Get-Date).ToUniversalTime().ToString('o')
    accounts = @($out.accounts | Where-Object { $_.ig } | ForEach-Object {
        @{ username = $_.ig.username; label = $_.label; followers = $_.ig.followers; media_count = $_.ig.media_count } })
}
$hist = @($hist | Where-Object { $_.date -ne $snapshot.date }) + $snapshot
$hist | ConvertTo-Json -Depth 8 | Set-Content -Path $HistFile -Encoding utf8
"HISTORY snapshots=$(@($hist).Count)"

$older = @($hist | Where-Object { $_.date -ne $snapshot.date } | Sort-Object date -Descending) | Select-Object -First 1
if ($older) {
    $out.follower_baseline = @{ date = $older.date }
    foreach ($a in $out.accounts) {
        if (-not $a.ig) { continue }
        $b = @($older.accounts | Where-Object { $_.username -eq $a.ig.username }) | Select-Object -First 1
        if ($b) { $a.followers_prev = [double]$b.followers }
    }
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out | ConvertTo-Json -Depth 12 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
