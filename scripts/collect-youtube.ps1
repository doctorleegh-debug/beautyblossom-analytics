param(
    [int]$Days = 30,
    [string]$OutFile = 'C:\Users\metic\Desktop\paseo\project(1)\data\youtube-latest.json'
)
# Collects YouTube channel + Analytics metrics for the Beauty Blossom channel.
$ErrorActionPreference = 'Stop'

$cfgPath = 'C:\Users\metic\Desktop\paseo\project(1)\.secrets\google-oauth.local.json'
$tokPath = 'C:\Users\metic\Desktop\paseo\project(1)\.secrets\google-oauth-youtube-token.local.json'
$cfg = (Get-Content $cfgPath -Raw | ConvertFrom-Json).web
$tok = Get-Content $tokPath -Raw | ConvertFrom-Json

$refresh = Invoke-RestMethod -Method Post -Uri $cfg.token_uri -ContentType 'application/x-www-form-urlencoded' -Body @{
    client_id = $cfg.client_id; client_secret = $cfg.client_secret
    refresh_token = $tok.refresh_token; grant_type = 'refresh_token'
}
$hdr = @{ Authorization = "Bearer $($refresh.access_token)" }
"AUTH=OK token_len=$($refresh.access_token.Length)"

$end   = (Get-Date).AddDays(-1)
$start = $end.AddDays(-($Days - 1))
$prevEnd = $start.AddDays(-1)
$prevStart = $prevEnd.AddDays(-($Days - 1))
$fmt = 'yyyy-MM-dd'
"RANGE=$($start.ToString($fmt)) ~ $($end.ToString($fmt))"

$ch = Invoke-RestMethod -Headers $hdr -Uri 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true'
$c0 = $ch.items[0]
"CHANNEL=$($c0.snippet.title)  subs=$($c0.statistics.subscriberCount)"

$ya = 'https://youtubeanalytics.googleapis.com/v2/reports'
function YA($metrics, $dims, $sort, $max, $s, $e) {
    $u = "$ya`?ids=channel%3D%3DMINE&startDate=$s&endDate=$e&metrics=$metrics"
    if ($dims) { $u += "&dimensions=$dims" }
    if ($sort) { $u += "&sort=$sort" }
    if ($max)  { $u += "&maxResults=$max" }
    return Invoke-RestMethod -Headers $hdr -Uri $u
}

$S = $start.ToString($fmt); $E = $end.ToString($fmt)
$PS = $prevStart.ToString($fmt); $PE = $prevEnd.ToString($fmt)
$core = 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares'

$cur  = YA $core $null $null $null $S $E
$prev = YA $core $null $null $null $PS $PE
$daily = YA 'views,estimatedMinutesWatched' 'day' 'day' $null $S $E
$traffic = YA 'views,estimatedMinutesWatched' 'insightTrafficSourceType' '-views' 15 $S $E
$geo = YA 'views' 'country' '-views' 10 $S $E
$dev = YA 'views' 'deviceType' '-views' 10 $S $E
$topv = YA 'views,estimatedMinutesWatched,averageViewDuration,likes' 'video' '-views' 10 $S $E

$vidIds = @($topv.rows | ForEach-Object { $_[0] })
$vidMeta = @{}
if ($vidIds.Count -gt 0) {
    $ids = ($vidIds -join ',')
    $vm = Invoke-RestMethod -Headers $hdr -Uri "https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=$ids"
    foreach ($v in $vm.items) { $vidMeta[$v.id] = @{ title=$v.snippet.title; publishedAt=$v.snippet.publishedAt; duration=$v.contentDetails.duration } }
}

function Row0($r) { if ($r.rows -and $r.rows.Count -gt 0) { return $r.rows[0] } else { return @(0,0,0,0,0,0,0,0,0) } }
$cv = Row0 $cur; $pv = Row0 $prev

$result = @{
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    range = @{ start=$S; end=$E; days=$Days }
    prev_range = @{ start=$PS; end=$PE }
    channel = @{
        id = $c0.id; title = $c0.snippet.title
        subscribers = [double]$c0.statistics.subscriberCount
        totalViews  = [double]$c0.statistics.viewCount
        videoCount  = [double]$c0.statistics.videoCount
    }
    current = @{
        views=[double]$cv[0]; minutesWatched=[double]$cv[1]; avgViewDuration=[double]$cv[2]
        avgViewPercentage=[double]$cv[3]; subsGained=[double]$cv[4]; subsLost=[double]$cv[5]
        likes=[double]$cv[6]; comments=[double]$cv[7]; shares=[double]$cv[8]
    }
    previous = @{
        views=[double]$pv[0]; minutesWatched=[double]$pv[1]; avgViewDuration=[double]$pv[2]
        avgViewPercentage=[double]$pv[3]; subsGained=[double]$pv[4]; subsLost=[double]$pv[5]
        likes=[double]$pv[6]; comments=[double]$pv[7]; shares=[double]$pv[8]
    }
    daily    = @($daily.rows   | ForEach-Object { @{ date=$_[0]; views=[double]$_[1]; minutes=[double]$_[2] } })
    traffic  = @($traffic.rows | ForEach-Object { @{ source=$_[0]; views=[double]$_[1]; minutes=[double]$_[2] } })
    countries= @($geo.rows     | ForEach-Object { @{ country=$_[0]; views=[double]$_[1] } })
    devices  = @($dev.rows     | ForEach-Object { @{ device=$_[0]; views=[double]$_[1] } })
    topVideos= @($topv.rows    | ForEach-Object {
        $id=$_[0]
        @{ videoId=$id; title=$(if($vidMeta[$id]){$vidMeta[$id].title}else{$id})
           duration=$(if($vidMeta[$id]){$vidMeta[$id].duration}else{''})
           publishedAt=$(if($vidMeta[$id]){$vidMeta[$id].publishedAt}else{''})
           views=[double]$_[1]; minutes=[double]$_[2]; avgViewDuration=[double]$_[3]; likes=[double]$_[4] } })
}

$dir = Split-Path $OutFile -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$result | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding utf8
"views=$($cv[0]) minutes=$($cv[1]) subsGained=$($cv[4])"
"SAVED=$OutFile"
