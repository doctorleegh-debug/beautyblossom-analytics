param(
    [string]$OutFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\instagram-latest.json',
    [string]$HistFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\instagram-history.json',
    [string]$PageIdFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\meta-page-ids.json',
    [int]$Days = 30,
    [switch]$SelfTest
)
# Instagram accounts reached through their linked Facebook Pages.
# /me/accounts returns nothing for this token, so pages are addressed by id.
#
# The token carries instagram_basic only: profile counts and per-post likes and
# comments are available, view/reach/impression fields come back empty. Period
# comparison is therefore built from post timestamps - posts published in the
# window versus the window before it - which needs no insight permission.
# Follower counts are point-in-time, so each run appends a snapshot to the
# history file; once two runs exist the report can show follower growth too.
$ErrorActionPreference = 'Stop'

$envPath = 'C:\Users\metic\Desktop\paseo\project(1)\.env.local'
$cfg = @{}
foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
$tok = $cfg['META_USER_TOKEN']
$base = 'https://graph.facebook.com/v23.0'

$labelFor = @{
    'BeautyblossomKorea'    = 'KR'
    'BeautyblossomJapan'    = 'JP'
    'BeautyblossomTaiwan'   = 'TW'
    'BeautyblossomThailand' = 'TH'
    'BeautyblossomGlobal'   = 'EN'
}

if ($SelfTest) {
    'SelfTest'
    "  token_present = $([bool]$tok)  len=$(if($tok){$tok.Length}else{0})"
    "  pageid_file   = $(Test-Path $PageIdFile)"
    "  history_file  = $(Test-Path $HistFile)"
    "  Days          = $Days"
    'SelfTestPassed=true'
    return
}
if (-not $tok) { 'RESULT=NO_TOKEN'; exit 1 }

$hdr = @{ Authorization = "Bearer $tok" }
$ids = Get-Content $PageIdFile -Raw | ConvertFrom-Json

$granted = @()
try { $granted = @((Invoke-RestMethod -Headers $hdr -Uri "$base/me/permissions").data | Where-Object { $_.status -eq 'granted' } | ForEach-Object { $_.permission }) } catch {}
$hasInsights = $granted -contains 'instagram_manage_insights'
"PERMISSIONS = $($granted -join ', ')"
"INSIGHTS    = $hasInsights"

$now       = Get-Date
$curStart  = $now.AddDays(-$Days)
$prevStart = $now.AddDays(-($Days * 2))
$fmt = 'yyyy-MM-dd'
"WINDOW  current $($curStart.ToString($fmt)) ~ $($now.ToString($fmt))   previous $($prevStart.ToString($fmt)) ~ $($curStart.ToString($fmt))"

$out = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source = 'Meta Graph API via linked Facebook Pages'
    granted_permissions = $granted
    insights_available = $hasInsights
    range = @{ start = $curStart.ToString($fmt); end = $now.ToString($fmt); days = $Days }
    prev_range = @{ start = $prevStart.ToString($fmt); end = $curStart.ToString($fmt) }
    note = 'instagram_basic 범위로 수집했습니다. 기간 비교는 게시물 발행일 기준이며, 도달·조회·저장은 instagram_manage_insights 권한이 있어야 조회됩니다.'
    accounts = @()
}

foreach ($prop in $ids.PSObject.Properties) {
    $pageName = $prop.Name
    $pageId   = $prop.Value
    $label    = $labelFor[$pageName]
    Write-Host "-- $label $pageName"
    $rec = @{ page = $pageName; pageId = $pageId; label = $label; status = 'OK' }
    try {
        $fields = 'id,name,followers_count,instagram_business_account{id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url}'
        $r = Invoke-RestMethod -Headers $hdr -TimeoutSec 40 -Uri "$base/$pageId`?fields=$fields"
        $ig = $r.instagram_business_account
        if (-not $ig) { $rec.status = 'NO_IG'; $out.accounts += $rec; '   (IG 연결 없음)'; continue }

        $rec.ig = @{
            id = $ig.id; username = $ig.username; name = $ig.name
            biography = $ig.biography; website = $ig.website
            followers = [double]$ig.followers_count
            follows = [double]$ig.follows_count
            media_count = [double]$ig.media_count
        }

        # Walk media back far enough to cover both windows.
        $all = @()
        $uri = "$base/$($ig.id)/media?limit=100&fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count"
        $guard = 0
        while ($uri -and $guard -lt 12) {
            $guard++
            $page = Invoke-RestMethod -Headers $hdr -TimeoutSec 45 -Uri $uri
            $rows = @($page.data)
            if ($rows.Count -eq 0) { break }
            $all += $rows
            $oldest = [datetime]::Parse($rows[-1].timestamp)
            if ($oldest -lt $prevStart) { break }
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

        $rec.media = @($cur | Sort-Object { [double]($_.like_count + $_.comments_count) } -Descending | Select-Object -First 15 | ForEach-Object {
            @{ id=$_.id; type=$_.media_type; product=$_.media_product_type; permalink=$_.permalink
               timestamp=$_.timestamp; likes=[double]$_.like_count; comments=[double]$_.comments_count
               caption=$(if ($_.caption) { $_.caption.Substring(0, [Math]::Min(90, $_.caption.Length)) } else { '' }) }
        })

        "   @{0,-24} followers={1,-7} 30일: 게시물 {2,-3} 좋아요 {3,-5} (직전 {4} / {5})" -f `
            $ig.username, $ig.followers_count, $rec.current.posts, $rec.current.likes, $rec.previous.posts, $rec.previous.likes
    } catch {
        $rec.status = 'FAILED'
        $rec.error = $_.Exception.Message
        if ($_.ErrorDetails.Message) { $rec.error_detail = ($_.ErrorDetails.Message -replace '\s+', ' ') }
        "   FAILED $($_.Exception.Message)"
    }
    $out.accounts += $rec
}

# Follower history: one snapshot per run, so growth becomes measurable from here on.
$hist = @()
if (Test-Path $HistFile) {
    try { $hist = @((Get-Content $HistFile -Raw | ConvertFrom-Json)) } catch { $hist = @() }
}
$snapshot = @{
    date = $now.ToString($fmt)
    at_utc = (Get-Date).ToUniversalTime().ToString('o')
    accounts = @($out.accounts | Where-Object { $_.ig } | ForEach-Object {
        @{ username = $_.ig.username; label = $_.label; followers = $_.ig.followers; media_count = $_.ig.media_count }
    })
}
$hist = @($hist | Where-Object { $_.date -ne $snapshot.date }) + $snapshot
$hist | ConvertTo-Json -Depth 8 | Set-Content -Path $HistFile -Encoding utf8
"HISTORY snapshots=$(@($hist).Count)"

# Attach follower deltas when an earlier snapshot exists.
$older = @($hist | Where-Object { $_.date -ne $snapshot.date } | Sort-Object date -Descending) | Select-Object -First 1
if ($older) {
    $out.follower_baseline = @{ date = $older.date }
    foreach ($a in $out.accounts) {
        if (-not $a.ig) { continue }
        $b = @($older.accounts | Where-Object { $_.username -eq $a.ig.username }) | Select-Object -First 1
        if ($b) { $a.followers_prev = [double]$b.followers; $a.media_prev = [double]$b.media_count }
    }
    "BASELINE date=$($older.date)"
} else {
    "BASELINE 없음 - 이번이 첫 스냅샷입니다 (다음 수집부터 팔로워 증감 표시)"
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
