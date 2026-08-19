param(
    [string]$OutFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\instagram-latest.json',
    [string]$PageIdFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\meta-page-ids.json',
    [int]$MediaLimit = 25,
    [switch]$SelfTest
)
# Instagram accounts reached through their linked Facebook Pages.
# /me/accounts returns nothing for this token, so pages are addressed by id.
# The token currently carries instagram_basic only - profile and media counts are
# available, insight metrics (reach, views, profile views) are not.
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
    if (Test-Path $PageIdFile) {
        $ids = Get-Content $PageIdFile -Raw | ConvertFrom-Json
        foreach ($p in $ids.PSObject.Properties) { "    $($p.Name) -> $($p.Value)  [$($labelFor[$p.Name])]" }
    }
    'SelfTestPassed=true'
    return
}
if (-not $tok) { 'RESULT=NO_TOKEN'; exit 1 }

$hdr = @{ Authorization = "Bearer $tok" }
$ids = Get-Content $PageIdFile -Raw | ConvertFrom-Json

# What the token is actually allowed to do - recorded so the report can be honest.
$granted = @()
try { $granted = @((Invoke-RestMethod -Headers $hdr -Uri "$base/me/permissions").data | Where-Object { $_.status -eq 'granted' } | ForEach-Object { $_.permission }) } catch {}
$hasInsights = $granted -contains 'instagram_manage_insights'
"PERMISSIONS granted = $($granted -join ', ')"
"INSIGHTS_AVAILABLE  = $hasInsights"

$out = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    source = 'Meta Graph API via linked Facebook Pages'
    granted_permissions = $granted
    insights_available = $hasInsights
    note = 'instagram_basic 범위로 수집했습니다. 도달·조회·프로필 조회 등 인사이트 지표는 instagram_manage_insights 권한이 있어야 조회됩니다.'
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
        $rec.pageFollowers = [double]$r.followers_count
        $ig = $r.instagram_business_account
        if (-not $ig) { $rec.status = 'NO_IG'; $out.accounts += $rec; '   (IG 연결 없음)'; continue }

        $rec.ig = @{
            id = $ig.id; username = $ig.username; name = $ig.name
            biography = $ig.biography; website = $ig.website
            followers = [double]$ig.followers_count
            follows = [double]$ig.follows_count
            media_count = [double]$ig.media_count
        }

        # Recent media: engagement we can compute without the insights permission.
        try {
            $m = Invoke-RestMethod -Headers $hdr -TimeoutSec 40 -Uri "$base/$($ig.id)/media?limit=$MediaLimit&fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count"
            $rec.media = @($m.data | ForEach-Object {
                @{ id=$_.id; type=$_.media_type; product=$_.media_product_type; permalink=$_.permalink
                   timestamp=$_.timestamp; likes=[double]$_.like_count; comments=[double]$_.comments_count
                   caption=$(if ($_.caption) { $_.caption.Substring(0, [Math]::Min(90, $_.caption.Length)) } else { '' }) }
            })
            $likes = 0.0; $comments = 0.0
            foreach ($x in $rec.media) { $likes += $x.likes; $comments += $x.comments }
            $rec.recent = @{
                count = @($rec.media).Count; likes = $likes; comments = $comments
                engagement = $likes + $comments
                avgEngagement = $(if (@($rec.media).Count) { ($likes + $comments) / @($rec.media).Count } else { 0 })
            }
        } catch { $rec.media_error = $_.Exception.Message }

        if ($hasInsights) {
            try {
                $ins = Invoke-RestMethod -Headers $hdr -TimeoutSec 40 -Uri "$base/$($ig.id)/insights?metric=reach,profile_views,website_clicks&period=days_28"
                $rec.insights = @($ins.data | ForEach-Object { @{ name=$_.name; value=[double]$_.values[0].value } })
            } catch { $rec.insights_error = $_.Exception.Message }
        }

        "   @{0,-24} followers={1,-7} media={2,-5} recent{3}: likes={4} comments={5}" -f `
            $ig.username, $ig.followers_count, $ig.media_count, @($rec.media).Count, $rec.recent.likes, $rec.recent.comments
    } catch {
        $rec.status = 'FAILED'
        $rec.error = $_.Exception.Message
        if ($_.ErrorDetails.Message) { $rec.error_detail = ($_.ErrorDetails.Message -replace '\s+', ' ') }
        "   FAILED $($_.Exception.Message)"
    }
    $out.accounts += $rec
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$out | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
"SAVED=$OutFile"
