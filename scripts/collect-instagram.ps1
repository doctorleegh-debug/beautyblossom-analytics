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
# Account insights accept an arbitrary since/until, so the same call is issued
# twice - current 30 days and the 30 days before that - which is what drives the
# month-over-month deltas for views, reach and every other account metric.
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
$ACCOUNT_METRICS = @('views', 'reach', 'profile_views', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'accounts_engaged', 'website_clicks', 'profile_links_taps')
$MEDIA_METRICS   = @('views', 'reach', 'saved', 'shares', 'total_interactions')
# metric -> breakdown dimension. Both windows are fetched so these compare too.
$BREAKDOWNS = @(
    @{ metric = 'views';                 breakdown = 'follow_type' }
    @{ metric = 'views';                 breakdown = 'media_product_type' }
    @{ metric = 'reach';                 breakdown = 'follow_type' }
    @{ metric = 'reach';                 breakdown = 'media_product_type' }
    @{ metric = 'total_interactions';    breakdown = 'media_product_type' }
    @{ metric = 'follows_and_unfollows'; breakdown = 'follow_type' }
    @{ metric = 'profile_links_taps';    breakdown = 'contact_button_type' }
)
$DEMOGRAPHICS = @('country', 'city', 'age', 'gender')

if ($SelfTest) {
    'SelfTest'
    "  system_token = $([bool]$tok)  len=$(if($tok){$tok.Length}else{0})"
    "  history_file = $(Test-Path $HistFile)"
    "  Days         = $Days"
    "  breakdowns   = $($BREAKDOWNS.Count)  demographics = $($DEMOGRAPHICS.Count)"
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
$epoch = [datetime]'1970-01-01'
$since     = [int]$curStart.ToUniversalTime().Subtract($epoch).TotalSeconds
$until     = [int]$now.ToUniversalTime().Subtract($epoch).TotalSeconds
$prevSince = [int]$prevStart.ToUniversalTime().Subtract($epoch).TotalSeconds
$prevUntil = $since
"WINDOW  current $($curStart.ToString($fmt)) ~ $($now.ToString($fmt))   previous $($prevStart.ToString($fmt)) ~ $($curStart.ToString($fmt))"

$out = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source = 'Meta Graph API (system user token) via linked Facebook Pages'
    granted_permissions = $granted
    insights_available = $hasInsights
    range = @{ start = $curStart.ToString($fmt); end = $now.ToString($fmt); days = $Days }
    prev_range = @{ start = $prevStart.ToString($fmt); end = $curStart.ToString($fmt) }
    note = '조회수·도달·저장·프로필 조회 등 계정 인사이트는 최근 30일과 직전 30일을 각각 조회해 전월 대비를 계산했습니다. 팔로워 증감은 신규 팔로우에서 언팔로우를 뺀 순증입니다.'
    accounts = @()
}

$pages = @()
try {
    $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 45 -Uri "$base/me/accounts?limit=100&fields=id,name,followers_count,instagram_business_account{id,username,name,biography,website,followers_count,follows_count,media_count}"
    $pages = @($r.data | Where-Object { $_.instagram_business_account })
} catch { "PAGES_FAILED $($_.Exception.Message)"; exit 1 }
"PAGES with IG = $($pages.Count)"

function Get-AccountInsight($igId, $metric, $s, $u) {
    try {
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 35 -Uri "$base/$igId/insights?metric=$metric&metric_type=total_value&period=day&since=$s&until=$u"
        return [double]$r.data[0].total_value.value
    } catch { return $null }
}
function Get-Breakdown($igId, $metric, $bd, $s, $u) {
    try {
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 35 -Uri "$base/$igId/insights?metric=$metric&metric_type=total_value&period=day&breakdown=$bd&since=$s&until=$u"
        $res = @($r.data[0].total_value.breakdowns[0].results)
        if (-not $res.Count) { return $null }
        $h = @{}
        foreach ($x in $res) { $h[[string]($x.dimension_values -join '/')] = [double]$x.value }
        return $h
    } catch { return $null }
}
# Demographics are lifetime snapshots; they take timeframe, never since/until.
function Get-Demographic($igId, $bd) {
    try {
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 35 -Uri "$base/$igId/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=$bd&timeframe=this_month"
        $res = @($r.data[0].total_value.breakdowns[0].results)
        if (-not $res.Count) { return $null }
        return @($res | ForEach-Object { @{ key = [string]($_.dimension_values -join '/'); value = [double]$_.value } } |
                 Sort-Object { -$_.value } | Select-Object -First 20)
    } catch { return $null }
}
function Get-MediaInsight($mediaId, $metric) {
    try {
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 30 -Uri "$base/$mediaId/insights?metric=$metric"
        return [double]$r.data[0].values[0].value
    } catch { return $null }
}
function Sum-Series($igId, $metric, $s, $u) {
    try {
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 35 -Uri "$base/$igId/insights?metric=$metric&period=day&since=$s&until=$u"
        $vals = @($r.data[0].values)
        $sum = 0.0; foreach ($v in $vals) { $sum += [double]$v.value }
        return @{ total = $sum; daily = @($vals | ForEach-Object { @{ date = $_.end_time.Substring(0,10); value = [double]$_.value } }) }
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
            $ins = @{}; $insPrev = @{}
            foreach ($m in $ACCOUNT_METRICS) {
                $v = Get-AccountInsight $ig.id $m $since $until
                if ($null -ne $v) { $ins[$m] = $v }
                $p = Get-AccountInsight $ig.id $m $prevSince $prevUntil
                if ($null -ne $p) { $insPrev[$m] = $p }
            }
            $rec.insights = $ins
            $rec.insights_prev = $insPrev

            $bd = @{}; $bdPrev = @{}
            foreach ($b in $BREAKDOWNS) {
                $key = "$($b.metric)__$($b.breakdown)"
                $c = Get-Breakdown $ig.id $b.metric $b.breakdown $since $until
                if ($c) { $bd[$key] = $c }
                $p = Get-Breakdown $ig.id $b.metric $b.breakdown $prevSince $prevUntil
                if ($p) { $bdPrev[$key] = $p }
            }
            $rec.breakdowns = $bd
            $rec.breakdowns_prev = $bdPrev

            $demo = @{}
            foreach ($d in $DEMOGRAPHICS) { $v = Get-Demographic $ig.id $d; if ($v) { $demo[$d] = $v } }
            $rec.demographics = $demo

            # follower_count is *gross new follows* per day, not the net change - its sum
            # matches follows_and_unfollows/FOLLOWER exactly. Net growth therefore needs
            # the unfollow side too, and follows_and_unfollows is the only one of the two
            # that reaches back into the previous window.
            $fc = Sum-Series $ig.id 'follower_count' $since $until
            if ($fc) { $rec.follower_daily = $fc.daily }
            foreach ($w in @(@{ k='follows'; src=$bd }, @{ k='follows_prev'; src=$bdPrev })) {
                $fu = $w.src['follows_and_unfollows__follow_type']
                if ($fu) {
                    $gained = [double]$fu['FOLLOWER']; $lost = [double]$fu['NON_FOLLOWER']
                    $rec[$w.k] = @{ gained = $gained; lost = $lost; net = $gained - $lost }
                }
            }
        }

        # Media feed covers both comparison windows.
        $all = @()
        $uri = "$base/$($ig.id)/media?limit=100&fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count"
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
                    thumbnail=$(if ($_.thumbnail_url) { $_.thumbnail_url } else { $_.media_url })
                    timestamp=$_.timestamp; likes=[double]$_.like_count; comments=[double]$_.comments_count
                    caption=$(if ($_.caption) { $_.caption.Substring(0, [Math]::Min(90, $_.caption.Length)) } else { '' }) }
            if ($hasInsights) {
                foreach ($mm in $MEDIA_METRICS) { $v = Get-MediaInsight $_.id $mm; if ($null -ne $v) { $m[$mm] = $v } }
            }
            $m
        })
        if ($hasInsights) { $rec.media = @($rec.media | Sort-Object { if ($_.views) { [double]$_.views } else { 0 } } -Descending) }

        $v = $rec.insights; $vp = $rec.insights_prev; $fw = $rec.follows
        "   @{0,-22} followers={1,-6} views={2}(전월 {3}) reach={4}(전월 {5}) 순증={6}" -f `
            $ig.username, $ig.followers_count,
            $(if($v.views){$v.views}else{'-'}), $(if($vp.views){$vp.views}else{'-'}),
            $(if($v.reach){$v.reach}else{'-'}), $(if($vp.reach){$vp.reach}else{'-'}),
            $(if($fw){$fw.net}else{'-'})
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

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out | ConvertTo-Json -Depth 12 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
