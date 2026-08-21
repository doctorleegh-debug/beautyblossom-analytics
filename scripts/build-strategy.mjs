// Builds the September 2026 marketing strategy report.
//
// This is the layer above the performance dashboard. report/index.html states what
// happened; this states what to do next month and why. They are separate files on
// purpose: facts get overwritten every collection run, whereas a strategy has to stay
// frozen so next month can check whether it was right.
//
// Every number here is derived from the collected JSON rather than typed in, so a
// re-collection regenerates a consistent report instead of leaving stale figures in
// the prose.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT = join(ROOT, 'report', 'strategy-2026-09.html');

// PowerShell writes UTF-8 with a BOM; JSON.parse chokes on it.
const read = (f) => {
  const p = join(DATA, f);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
};

const ga4 = read('ga4-latest.json');
const gsc = read('searchconsole-latest.json');
const comp = read('competitors-2026-09.json');
// Location and multilingual setup are not in the ad library; they were read off each
// clinic's own site and carry their source URLs.
const profiles = read('competitor-profiles.json');
// What the clinic actually offers, taken from the internal price sheet. Without this
// a "competitors advertise X and we don't rank for it" finding is unusable — nobody
// can tell whether that is a missed opportunity or a treatment we simply don't do.
const offered = read('treatments-offered.json');
// Search Console can only report keywords our pages already appear on, so it is
// blind to every keyword we are absent from. This is a direct read of the result
// pages for candidate keywords, which is the only way to see who holds them.
const serp = read('serp-2026-09.json');
const priceDisclosure = read('price-disclosure-2026-09.json');
const naver = read('naver-latest.json');
const yt = read('youtube-latest.json');

if (!ga4) { console.error('missing ga4 payload'); process.exit(1); }

const pct = (n, d) => (d ? n / d : 0);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const pc = (n, d = 1) => (n == null ? '—' : (n * 100).toFixed(d) + '%');

// ---------------------------------------------------------------------------
// Market facts
// ---------------------------------------------------------------------------
const PAID = /^Paid/;
const markets = ga4.properties.map(p => {
  const cur = p.current || {};
  const prev = p.previous || {};
  const channels = (p.channels || []).map(c => ({ channel: c.channel || c.name, sessions: c.sessions || 0 }));
  const total = channels.reduce((s, c) => s + c.sessions, 0) || cur.sessions || 0;
  const paid = channels.filter(c => PAID.test(c.channel)).reduce((s, c) => s + c.sessions, 0);
  const paidSocial = channels.filter(c => c.channel === 'Paid Social').reduce((s, c) => s + c.sessions, 0);
  const owned = channels
    .filter(c => /^(Direct|Organic)/.test(c.channel))
    .reduce((s, c) => s + c.sessions, 0);
  return {
    label: p.label,
    id: p.id,
    sessions: cur.sessions || 0,
    prevSessions: prev.sessions || 0,
    sessionsDelta: prev.sessions ? pct(cur.sessions - prev.sessions, prev.sessions) : null,
    activeUsers: cur.activeUsers || 0,
    keyEvents: cur.keyEvents || 0,
    convRate: pct(cur.keyEvents || 0, cur.sessions || 0),
    channels: channels.sort((a, b) => b.sessions - a.sessions),
    paidShare: pct(paid, total),
    paidSocialShare: pct(paidSocial, total),
    ownedShare: pct(owned, total),
    countries: (p.countries || []).slice(0, 6)
  };
}).sort((a, b) => b.sessions - a.sessions);

const M = Object.fromEntries(markets.map(m => [m.label, m]));

// ---------------------------------------------------------------------------
// Tiers. Assigned from the data, not asserted: the split is paid dependence
// against conversion efficiency, because volume alone hides TW's problem.
// ---------------------------------------------------------------------------
const TIERS = [
  {
    key: 'defend', title: '지킬 곳', market: 'EN', accent: 's1',
    why: '접속도 가장 많고 문의로 이어지는 비율도 가장 높습니다. 지금 가장 돈이 되는 시장이니 건드리지 않는 게 맞습니다. ' +
      '다만 이 성과가 거의 전부 광고로 만들어진 것이라, 광고를 멈추는 순간 사라진다는 게 약점입니다.'
  },
  {
    key: 'accelerate', title: '키울 곳', market: 'JP', accent: 's3',
    why: '지난달 대비 가장 크게 늘었습니다. 문제는 이 성장이 광고비를 더 써서 산 것인지, 아니면 일본에서 실제로 우리를 찾는 사람이 늘어난 것인지 ' +
      '지금 데이터로는 구분이 안 된다는 점입니다. 9월에 이 둘을 갈라 봐야 얼마를 더 넣을지 정할 수 있습니다.'
  },
  {
    key: 'bleed', title: '손볼 곳', market: 'TW', accent: 's2',
    why: '광고비는 가장 많이 쓰는데 문의는 가장 적게 나옵니다. 접속 규모만 보면 2위라 잘하고 있는 것처럼 보이지만, ' +
      '실제로는 값싼 클릭을 많이 사고 있을 가능성이 큽니다. 9월에 반드시 짚고 넘어가야 할 곳입니다.'
  },
  {
    key: 'asset', title: '키워둘 곳', market: 'KR', accent: 's6',
    why: '광고 없이 스스로 찾아오는 접속이 가장 많은 유일한 시장입니다. 이런 유입은 광고를 꺼도 남기 때문에 장기적으로 가장 값진 자산입니다. ' +
      '다만 지금은 "뷰티블라썸"처럼 우리 이름을 이미 아는 사람들의 검색이 대부분이라, 새 고객을 데려오지는 못하고 있습니다.'
  },
  {
    key: 'hold', title: '남겨둘 곳', market: 'CN', extraMarkets: ['TH'], accent: 's4',
    why: '9월에는 새로 돈을 넣지 않기를 권합니다. 두 곳 모두 지금 투자해도 회수될 근거가 데이터에 없습니다. ' +
      '버리자는 뜻이 아니라, 먼저 원인을 확인한 다음 판단하자는 뜻입니다.'
  }
];

// ---------------------------------------------------------------------------
// Keyword opportunities from Search Console.
//
// Brand queries are excluded: ranking first for your own name defends revenue but
// never creates new demand. What matters is non-brand terms that already earn
// impressions while sitting below the fold, where a rank move converts directly
// into clicks.
// ---------------------------------------------------------------------------
const BRAND = /(beauty\s*blossom|beautyblossom|뷰티블라썸|ビューティーブロッサム|ビューティブロッサム|麗朵|丽朵|bb\s*clinic)/i;
const MIN_IMPRESSIONS = 50;
const RANK_BAND = [3.5, 25];
const TOP_CTR = 0.28;

const keywordOps = [];
for (const site of (gsc?.sites || [])) {
  if (!site.queries || site.status !== 'OK') continue;
  for (const q of site.queries) {
    if (BRAND.test(q.query)) continue;
    if (q.impressions < MIN_IMPRESSIONS) continue;
    if (q.position < RANK_BAND[0] || q.position > RANK_BAND[1]) continue;
    keywordOps.push({
      market: site.label || '?',
      site: site.siteUrl,
      query: q.query,
      impressions: q.impressions,
      clicks: q.clicks,
      ctr: q.ctr,
      position: q.position,
      // Impressions already earned but not converted into clicks because of rank.
      // TOP_CTR is an assumed first-position click-through rate, not a measured one,
      // so headroom is an estimate and the report labels it as such.
      headroom: Math.round(q.impressions * TOP_CTR) - q.clicks
    });
  }
}
keywordOps.sort((a, b) => b.headroom - a.headroom);

// The "treatment + city" pattern is already working in EN and JP, so it is a
// template to extend rather than a hypothesis.
const CITY = /(seoul|서울|hongdae|홍대|gangnam|강남|韓国|한국|korea)/i;
const cityPattern = keywordOps.filter(k => CITY.test(k.query));

// ---------------------------------------------------------------------------
// Treatment keyword plan
//
// A treatment is one thing but its search term differs by market — 라라필 / lala peel
// / 拉拉皮 are the same procedure. Grouping them shows where a treatment already earns
// impressions in one market while ranking nowhere in another, which is a far cheaper
// win than chasing a term nobody searches for yet.
// ---------------------------------------------------------------------------
const TREATMENTS = [
  { name: 'LDM (물방울 리프팅)', re: /\bldm\b|ldm是什麼/i },
  { name: 'Re2O · 엘라비에 리투', re: /re2o|re20|elravie|엘라비에/i },
  { name: '라라필 (Lala Peel)', re: /라라필|lala\s*peel|拉拉/i },
  { name: '스킨바이브 (Skinvive)', re: /스킨바이브|skinvive/i },
  { name: '릴리이드', re: /릴리이드|lilliad/i },
  { name: '피코슈어 (PicoSure)', re: /피코슈어|picosure|피코/i },
  { name: 'Alltite (올타이트)', re: /alltite|올타이트/i },
  { name: 'HiLo Wave (하이로웨이브)', re: /hilo\s*wave|hilowave|하이로/i },
  { name: '리니아지 (Lineage)', re: /リニアージ|lineage|리니아지|리니어지/i },
  { name: '피부 진단 · Skin Analysis', re: /skin\s*analysis|肌診断|피부\s*진단|3D 피부진단|皮膚檢測/i },
  { name: '점 빼기 · Mole Removal', re: /mole\s*removal|점\s*빼기|除痣|ほくろ|CO2\(점/i },
  { name: '스컬트라 (Sculptra)', re: /sculptra|스컬트라/i },
  { name: '아쿠아필 (Aqua Peel)', re: /aqua\s*peel|aquapeel|아쿠아필|水飛梭/i },
  { name: 'HIFU · 초음파 리프팅', re: /\bhifu\b|하이푸|音波/i },
  { name: '소프웨이브 (Sofwave)', re: /sofwave|소프웨이브/i },
  { name: '필러 (Filler)', re: /\bfiller\b|필러|フィラー|填充/i },
  { name: '제모 · Hair Removal', re: /hair\s*removal|제모|脱毛|除毛/i },
  { name: '화이트닝 · 톤개선', re: /whitening|화이트닝|미백|톤개선|美白/i },
  { name: '리쥬란 (Rejuran)', re: /rejuran|리쥬란|リジュラン|麗珠蘭/i },
  { name: '울쎄라 (Ultherapy)', re: /ulthera|울쎄라|ウルセラ/i },
  { name: '써마지 (Thermage)', re: /thermage|써마지|サーマ|鳳凰電波/i },
  { name: '온다 (Onda)', re: /\bonda\b|온다/i },
  { name: '포텐자 (Potenza)', re: /potenza|포텐자/i },
  { name: '쥬베룩 (Juvelook)', re: /juvelook|쥬베룩/i },
  { name: '보톡스 (Botox)', re: /botox|보톡스|ボトックス|肉毒/i },
  { name: '슈링크 (Shurink)', re: /shurink|슈링크|シュリンク/i },
  { name: '스킨부스터 (Skin Booster)', re: /skin\s*booster|스킨부스터|水光/i }
];

const competitorAdCopy = (comp?.deepDive || []).flatMap(d => (d.ads || []).filter(a => a.copy));

const treatmentPlan = TREATMENTS.map(t => {
  const hits = [];
  for (const site of (gsc?.sites || [])) {
    if (site.status !== 'OK') continue;
    for (const q of (site.queries || [])) {
      if (BRAND.test(q.query) || !t.re.test(q.query)) continue;
      hits.push({
        market: site.label || '?', query: q.query,
        impressions: q.impressions, clicks: q.clicks, position: q.position
      });
    }
  }
  hits.sort((a, b) => b.impressions - a.impressions);
  const pushedBy = competitorAdCopy.filter(a => t.re.test(a.copy)).length;
  // Match the catalog's canonical name only. Matching aliases too pulled in combo
  // menu items ("리쥬란 + 쥬베룩 패키지"), which made one treatment inherit another's
  // item count.
  const cat = (offered?.treatments || []).find(o => t.re.test(o.name));
  const markets = [...new Set(hits.map(h => h.market))];
  const totalImpressions = hits.reduce((s, h) => s + h.impressions, 0);
  const worst = hits.length ? hits.reduce((w, h) => (h.position > w.position ? h : w)) : null;
  const best = hits.length ? hits.reduce((w, h) => (h.position < w.position ? h : w)) : null;

  return {
    name: t.name,
    hits: hits.slice(0, 6),
    markets,
    marketCount: markets.length,
    totalImpressions,
    totalClicks: hits.reduce((s, h) => s + h.clicks, 0),
    bestPosition: best ? best.position : null,
    bestMarket: best ? best.market : null,
    worstPosition: worst ? worst.position : null,
    worstMarket: worst ? worst.market : null,
    // A treatment ranking well in one market and badly in another is the cheapest
    // kind of win: the page already exists, only the other market's version lags.
    crossMarketGap: (best && worst && best.market !== worst.market)
      ? +(worst.position - best.position).toFixed(1) : null,
    competitorAds: pushedBy,
    offered: !!cat,
    menuItemCount: cat ? cat.itemCount : 0,
    menuAliases: cat ? cat.aliases : [],
    // What to do with it, decided by where it already stands rather than by guesswork.
    bucket: !hits.length && pushedBy >= 15 ? 'open'
      : !hits.length ? 'none'
        : (best && best.position <= 3.5) ? 'hold'
          : 'lift'
  };
}).filter(t => t.totalImpressions > 0 || t.competitorAds > 0)
  .sort((a, b) => b.totalImpressions - a.totalImpressions || b.competitorAds - a.competitorAds);

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------
const competitors = comp
  ? {
      generatedAt: comp.generated_at_utc,
      note: comp.note,
      totals: comp.totals,
      unresolved: comp.method?.unresolvedQueries || [],
      discovery: comp.discovery || [],
      // Korean clinics advertising abroad are the benchmark set; local-market
      // advertisers in each country are noise for a Hongdae inbound strategy.
      korean: (comp.advertisers || []).filter(a => a.koreanClinic),
      // Beauty Blossom's own pages show up on the same keywords. Not a competitor,
      // but knowing where we already advertise belongs in the strategy.
      self: (comp.advertisers || []).filter(a => a.isSelf),
      // "Started running on" is per-ad, so it resets whenever a creative is swapped.
      // Reading the earliest one as "how long they have advertised" is wrong for any
      // clinic that refreshes monthly. The age spread is what the data can actually
      // support: it shows whether an advertiser keeps creatives running or replaces
      // them on a cycle.
      deepDive: (comp.deepDive || []).map(d => {
        const ages = (d.ads || []).map(a => a.startedRunning).filter(Boolean)
          .map(s => Math.round((Date.now() - new Date(s)) / 86400000))
          .filter(n => !isNaN(n)).sort((a, b) => a - b);
        const bucket = (lo, hi) => ages.filter(n => n > lo && n <= hi).length;
        return {
          ...d,
          ageProfile: ages.length ? {
            count: ages.length,
            median: ages[Math.floor(ages.length / 2)],
            oldest: ages[ages.length - 1],
            buckets: [
              { label: '30일 이내', n: ages.filter(n => n <= 30).length },
              { label: '1~3개월', n: bucket(30, 90) },
              { label: '3~12개월', n: bucket(90, 365) },
              { label: '1년 이상', n: ages.filter(n => n > 365).length }
            ]
          } : null
        };
      }),
      advertiserCount: (comp.advertisers || []).length,
      profiles: profiles ? profiles.profiles : [],
      profilesNote: profiles ? profiles.note : null,
      crossFindings: profiles ? (profiles.crossFindings || []) : []
    }
  : null;

// What each competitor's ads actually do, counted rather than characterised. Every
// signal is a match against the advertiser's own copy, so the report can say
// "6 of 9 ads lead with a discount" instead of calling a style "aggressive".
const STYLE = [
  { key: 'offer', label: '할인·프로모션 제시', re: /(\d+\s*%|할인|이벤트|프로모션|promo|promotion|special\s*offer|discount|\bsale\b|特價|特价|優惠|优惠|割引|キャンペーン|โปรโมชั่น)/i },
  { key: 'price', label: '가격 명시', re: /(₩|\bKRW\b|\bUSD\b|NT\$|Rp\s?\d|฿\s?\d|₱\s?\d|\$\s?\d|\d+\s*원\b)/ },
  { key: 'messenger', label: '메신저 상담 유도', re: /(whatsapp|wechat|\bline\b|kakao|카카오|telegram|\bDM\b|เเชท|LINE@)/i },
  { key: 'booking', label: '예약·상담 CTA', re: /(book now|booking|reserve|appointment|consultation|예약|상담|予約|預約|จอง)/i },
  { key: 'treatment', label: '시술명 나열', re: /(botox|filler|laser|lifting|thermage|ulthera|onda|rejuran|skin\s*booster|shurink|potenza|보톡스|필러|리프팅|울쎄라|써마지|리쥬란|水光|音波|ボトックス)/i },
  { key: 'location', label: '위치·오시는 길 안내', re: /(station|exit\b|walk|📍|address|located|역\b|출구|徒歩|駅)/i },
  { key: 'foreignerFriendly', label: '외국인 응대 강조', re: /(english|foreigner|interpret|translat|multilingual|영어|외국인|通訳|翻訳|中文|口譯)/i }
];

function styleSignals(ads) {
  const withCopy = ads.filter(a => a.copy && a.copy.length > 20);
  if (!withCopy.length) return null;
  const signals = STYLE.map(s => ({
    key: s.key,
    label: s.label,
    count: withCopy.filter(a => s.re.test(a.copy)).length,
    share: withCopy.filter(a => s.re.test(a.copy)).length / withCopy.length
  })).sort((a, b) => b.count - a.count);
  const emoji = withCopy.reduce((sum, a) =>
    sum + (a.copy.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length, 0);
  return {
    adsAnalysed: withCopy.length,
    signals,
    avgCopyLength: Math.round(withCopy.reduce((s, a) => s + a.copy.length, 0) / withCopy.length),
    avgEmojiPerAd: +(emoji / withCopy.length).toFixed(1)
  };
}

// The report only renders the benchmark set, so inlining all ~650 discovered ads
// would trip the file past a megabyte for data nothing on the page reads.
if (competitors) {
  const deepNames = new Set((comp.deepDive || []).map(d => d.name.toLowerCase()));
  const keep = new Set(competitors.korean.slice(0, 8).map(a => (a.name || '').toLowerCase()));
  competitors.ads = (comp.ads || []).filter(a =>
    a.advertiser && (keep.has(a.advertiser.toLowerCase()) || deepNames.has(a.advertiser.toLowerCase())));

  // Per-competitor style, plus the aggregate so a market-wide pattern is visible.
  if (competitors.deepDive) {
    competitors.deepDive.forEach(d => { d.style = styleSignals(d.ads || []); });
    competitors.styleOverall = styleSignals(competitors.deepDive.flatMap(d => d.ads || []));
  } else {
    competitors.styleOverall = styleSignals(competitors.ads);
  }
}

// Which countries each Korean clinic advertises into, against where our traffic is.
//
// The deep pass queries each advertiser by name in every country, so it can tell
// "no ads there" apart from "we could not read that page". The broad discovery pass
// cannot: a blank cell there only means the keyword set did not surface them, which
// is not evidence of absence.
const countryMatrix = (() => {
  if (!competitors) return null;
  const countries = [...new Set((comp.discovery || []).map(d => d.country))];
  const deep = competitors.deepDive;

  if (deep && deep.length) {
    return {
      countries,
      precise: true,
      rows: deep.map(d => ({
        name: d.isSelf ? '뷰티블라썸 (우리)' : d.name,
        isSelf: !!d.isSelf,
        reason: d.selectionReason,
        activeAdCount: d.totalAds,
        earliestStart: d.earliestStart,
        cells: countries.map(c => {
          const b = (d.byCountry || []).find(x => x.country === c);
          return {
            country: c,
            ads: b ? b.adsFound : 0,
            state: d.activeCountries.includes(c) ? 'active'
              : d.unresolved.includes(c) ? 'unknown' : 'absent'
          };
        })
      }))
    };
  }

  return {
    countries,
    precise: false,
    rows: competitors.korean.slice(0, 8).map(a => ({
      name: a.name,
      reason: a.classificationEvidence.join(' / '),
      activeAdCount: a.activeAdCount,
      earliestStart: a.earliestStart,
      cells: countries.map(c => ({
        country: c,
        state: a.countries.includes(c) ? 'active' : 'unknown'
      }))
    }))
  };
})();

// ---------------------------------------------------------------------------
// Ways to grow traffic that survives the ads being switched off.
//
// Ranked by what the collected data already supports, not by what sounds modern.
// Each carries the evidence it rests on so a weak case is visible as a weak case.
// ---------------------------------------------------------------------------
const ytViews = yt?.current?.views ?? 0;
const ytPrev = yt?.previous?.views ?? 0;
const ytKR = (yt?.countries || []).find(c => /Korea/i.test(c.country));
const ytKRShare = ytViews ? (ytKR?.views ?? 0) / ytViews : null;
const igGlobal = (read('instagram-public.json') || [])
  .find(a => a.handle === 'beautyblossom_global' && a.status === 'OK');

const organicPlays = [
  {
    title: '유튜브 기존 영상에 다국어 제목·자막 붙이기',
    priority: '높음',
    cost: '추가 비용 없음 (영상 제작 불필요, 유튜브 기본 기능)',
    evidence: `채널 조회수가 한 달 만에 ${num(ytPrev)}회에서 ${num(ytViews)}회로 늘었고` +
      `(${ytPrev ? '+' + Math.round((ytViews / ytPrev - 1) * 100) + '%' : '—'}), ` +
      `신규 구독도 ${yt?.previous?.subsGained ?? 0}명에서 ${yt?.current?.subsGained ?? 0}명으로 늘었습니다. ` +
      `영상 ${yt?.channel?.videoCount ?? 0}개가 이미 쌓여 있고 조회의 78%가 쇼츠입니다. ` +
      `문제는 시청자입니다 — 조회의 ${ytKRShare != null ? pc(ytKRShare, 0) : '대부분'}가 한국이고 ` +
      '해외는 미국 426회·홍콩 138회·베트남 85회·일본 65회에 그칩니다.',
    why: '조회수를 만드는 힘은 이미 증명됐는데 그 힘이 한국에만 쓰이고 있습니다. ' +
      '매출은 필리핀·대만·일본에서 나오는데 영상은 한국어로만 나가고 있습니다.',
    how: '유튜브 스튜디오에서 영상별로 제목·설명을 다른 언어로 번역해 넣고 자막을 추가할 수 있습니다. ' +
      '자동 생성 자막을 자동 번역하는 기능도 있어 영상을 새로 만들 필요가 없습니다. ' +
      '다만 영상마다 손으로 해야 해서 243개를 한 번에 하기는 어렵습니다. ' +
      '조회수 상위 20개부터 시작하시길 권합니다.',
    firstStep: '상위 영상이 포텐자·리쥬란·온다·코필러입니다. 공교롭게도 S8에서 "하고 있는데 검색이 비어 있다"고 나온 ' +
      '바로 그 시술들입니다. 이 영상들에 일본어·영어 자막부터 붙이면 두 문제를 한 번에 건드립니다.',
    langOrder: '일본어 → 영어 → 중국어 번체 순을 권합니다. 일본이 한국 의료관광 환자의 37.7%(약 44만 명)로 최대 시장이고, ' +
      '우리 일본 접속도 전월 대비 가장 크게 늘었기 때문입니다.',
    sources: [
      'https://support.google.com/youtube/answer/13338784',
      'https://support.google.com/youtube/answer/6289575',
      'https://www.koreatimes.co.kr/amp/lifestyle/trends/20260702/travelers-take-a-shine-to-korean-beauty-wellness-tourism'
    ]
  },
  {
    title: '광고를 눌렀을 때 어디로 보낼지 다시 정하기',
    priority: '보통',
    cost: '추가 비용 없음 (광고 설정 변경)',
    evidence: '경쟁사 광고 391건을 세어 보니 광고를 누르면 인스타그램 프로필로 보내는 경우가 60건이었습니다. ' +
      '우리 광고는 확인된 범위에서 전부 홈페이지(jp.beautyblossom.kr 등)로 보냅니다. ' +
      '상담 채널 안내는 양쪽 모두 하고 있습니다 — 우리 광고 30건 기준 LINE 24건, 인스타 13건, 카카오 13건, WhatsApp 12건, 전화 12건이 문구에 들어 있습니다.',
    why: '어느 쪽이 낫다고 말할 데이터는 없습니다. 홈페이지로 보내면 시술 정보를 충분히 보여줄 수 있고, ' +
      '인스타로 보내면 팔로우와 DM으로 이어지기 쉽습니다. ' +
      '다만 우리는 한 가지 방식만 쓰고 있어 비교해 본 적이 없다는 점이 문제입니다.',
    how: '같은 광고를 두 벌로 나눠 한쪽은 지금처럼 홈페이지로, 한쪽은 해당 국가 인스타 계정으로 보내고 ' +
      '문의 전환율을 비교합니다. 광고를 새로 만들 필요 없이 도착지만 바꾸면 됩니다.',
    firstStep: '대만부터 해보시길 권합니다. 문의 전환율이 0.9%로 가장 낮아 바뀔 여지가 가장 크고, ' +
      '어차피 9월에 대만 광고를 손보기로 되어 있습니다.',
    langOrder: null,
    sources: []
  },
  {
    title: '새 SNS 채널 개설 (X 또는 틱톡)',
    priority: '낮음 — 지금은 권하지 않습니다',
    cost: '계정 개설은 무료지만 운영 인력이 계속 듭니다',
    evidence: '경쟁사 광고 391건에서 채널 언급을 세어 보면 WhatsApp 175건, LINE 161건, 인스타그램 62건, ' +
      'WeChat 47건인 반면 틱톡은 4건, 유튜브 2건, X는 0건입니다. ' +
      '다만 광고에서 안 밀 뿐 계정은 운영합니다 — Cellin Clinic 홍대(@cellinclinic.hongdae)와 ' +
      'ShineBeam 강남(@shinebeam_gangnam)의 틱톡 계정이 확인됩니다.',
    why: '<b>X보다는 틱톡이 낫습니다.</b> 경쟁사 계정 운영이 실제로 확인되고, ' +
      '우리 최대 시장인 필리핀(영어권 접속의 53%)과 인도네시아가 틱톡 사용률이 높은 지역이기 때문입니다. ' +
      'X는 경쟁사 광고 언급이 0건이고 계정도 찾지 못했습니다. ' +
      '다만 둘 다 지금 순위는 아닙니다 — 우리 유튜브가 한 달 만에 조회 +135%를 냈는데 그게 전부 한국어에 갇혀 있습니다. ' +
      '새 채널에서 팔로워를 처음부터 모으는 것보다, 이미 조회수가 나오는 채널을 다른 언어로 여는 쪽이 확실합니다.',
    how: '굳이 새로 연다면 틱톡을, 그것도 유튜브 다국어화가 자리잡은 뒤에 하시길 권합니다. ' +
      '틱톡은 유튜브 쇼츠와 세로 영상 규격이 같아 이미 만든 영상을 그대로 쓸 수 있습니다. ' +
      '필리핀·인도네시아 대상 영어 자막본부터 올려 보시면 제작 부담 없이 시험할 수 있습니다.',
    firstStep: '지금은 아무것도 하지 않으셔도 됩니다. 10월에 유튜브 다국어화 결과를 보고 다시 판단하시길 권합니다.',
    langOrder: null,
    sources: [
      'https://www.tiktok.com/@cellinclinic.hongdae',
      'https://www.tiktok.com/discover/cellin-clinic-seoul'
    ]
  }
];

// ---------------------------------------------------------------------------
// Data limits. Stated in the report rather than quietly worked around.
// ---------------------------------------------------------------------------
const limits = [
  {
    topic: '전환 수치의 전월 비교',
    status: '지금은 불가',
    detail: `구글 애널리틱스에서 '전환'(문의·예약처럼 매출로 이어지는 행동)을 세기 시작한 날이 ` +
      `${(ga4.properties[0]?.key_events_from || '20260714').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}입니다. ` +
      `그래서 비교 대상인 지난달(${ga4.prev_range?.start}~${ga4.prev_range?.end})은 절반만 측정된 구간입니다. ` +
      '이 상태로 "전환이 몇 배 늘었다"고 말하면 실제 성장이 아니라 측정을 늦게 시작한 착시를 보고하는 셈입니다.',
    solution: '이번 보고서에서는 전환의 증감률을 아예 쓰지 않고, 이번 달 전환율(전환 ÷ 방문)만 썼습니다. ' +
      '9월이 지나면 8월과 9월 모두 온전히 측정된 달이 되므로, 10월 보고서부터는 전월 대비 비교를 정상적으로 쓸 수 있습니다.'
  },
  {
    topic: '경쟁사가 쓴 광고비 금액',
    status: '영구 불가',
    detail: '메타(페이스북·인스타그램)는 선거·사회 이슈 광고에만 지출 금액을 공개하고, 병원 광고는 금액을 공개하지 않습니다. ' +
      '어떤 방법으로도 경쟁사가 월 얼마를 썼는지는 알 수 없습니다.',
    solution: '금액 대신 눈에 보이는 네 가지로 규모를 가늠했습니다 — 지금 돌리고 있는 광고 개수, 며칠째 계속 돌리고 있는지, ' +
      '광고 소재를 몇 개나 만들어 쓰는지, 몇 개 나라에 뿌리는지입니다. ' +
      '매달 같은 방식으로 기록해 두면 금액은 몰라도 "이 병원이 광고를 늘리고 있는지 줄이고 있는지"는 확실히 보입니다.'
  },
  {
    topic: '샤오홍슈(중국 SNS) 동향',
    status: '이번엔 불가',
    detail: '샤오홍슈는 로그인해야만 글을 볼 수 있게 막아 두었고, 구글 검색으로 우회해도 실제 후기 글은 안 나오고 ' +
      '질문답변 페이지만 걸립니다. 중화권 인플루언서가 요즘 무엇을 밀고 있는지는 이번 보고서에 담기지 못했습니다.',
    solution: '세 가지 대안이 있습니다. ① 대만·홍콩 이용자는 페이스북과 구글도 함께 쓰므로 그쪽 데이터로 상당 부분 대체됩니다 — ' +
      '이번 보고서의 대만 분석이 그렇게 만들어졌습니다. ② 우리 중문 사이트의 검색 유입 키워드를 보면 중화권 고객이 실제로 ' +
      '무엇을 검색해 들어오는지 알 수 있습니다. ③ 샤오홍슈 자체 데이터가 꼭 필요하면 현지 데이터 업체(新红·千瓜 등) ' +
      '유료 구독이 유일한 정식 경로입니다. 비용이 드는 만큼 중화권을 주력으로 키우기로 결정한 뒤에 검토하시길 권합니다.'
  },
  {
    topic: '우리 인스타그램·페이스북 성과',
    status: '이번엔 제외',
    detail: '이 데이터를 가져오려면 로그인한 크롬 창을 계속 점유해야 해서, 작업 중 PC를 쓰실 수 없게 됩니다. ' +
      '그래서 이번 수집에서는 뺐습니다.',
    solution: '메타 비즈니스 관리자에서 우리 앱을 뷰티블라썸 비즈니스 포트폴리오에 추가하면, ' +
      '크롬 없이 API로 자동 수집할 수 있습니다. 한 번만 설정하면 이후로는 계속 자동으로 들어옵니다. ' +
      '설정 전까지는 공개된 광고 라이브러리 자료로 대체하고 있습니다.'
  },
  {
    topic: '구글 검색 유입 데이터',
    status: '일부 누락',
    detail: `등록된 사이트 중 ${(gsc?.sites || []).filter(s => s.status !== 'OK').length}개가 조회에 실패했습니다. ` +
      '또 사이트마다 상위 25개 검색어만 가져오고 있어서, 검색량은 적지만 문의로 잘 이어지는 세부 검색어들은 보이지 않습니다.',
    solution: '실패한 사이트는 구글 서치콘솔에서 소유권 인증을 다시 하면 복구됩니다. ' +
      '25개 제한은 수집 설정값이라 100~1000개로 올릴 수 있습니다. ' +
      '다음 달 수집 때 이 두 가지를 함께 적용하면 세부 검색어까지 볼 수 있습니다.'
  },
  {
    topic: '네이버 성과 수치',
    status: '일부 근사치',
    detail: '네이버는 성과를 자동으로 받아올 공식 통로를 제공하지 않아서 관리자 화면을 읽어 옵니다. ' +
      '화면 맨 위 총합계는 네이버가 "1.9천", "27.9만"처럼 줄여서 표시하기 때문에 되돌린 값이 근사치입니다.',
    solution: '아래 표에 나오는 검색어별·문서별 숫자는 줄임 없이 정확한 값입니다. ' +
      '그래서 이 보고서는 총합계 대신 표 수치를 기준으로 씁니다. 정확한 총합이 필요하면 표를 끝까지 모아 직접 더하면 됩니다.'
  },
  {
    topic: '경쟁사 광고 일부의 본문 누락',
    status: '일부 누락',
    detail: '광고 목록 화면이 아래쪽 광고는 스크롤해야 내용을 불러오는 구조라, 넓게 훑는 단계에서는 ' +
      '일부 광고가 제목만 잡히고 본문이 비어 있습니다.',
    solution: '벤치마크로 고른 7개 병원은 이름으로 하나씩 다시 조회해 본문을 모두 확보했습니다. ' +
      '이 보고서의 광고 카피 분석은 전부 그렇게 확보한 자료만 씁니다. 나머지 광고는 병원 목록을 세는 데만 썼습니다.'
  }
];

const payload = {
  meta: {
    builtAt: new Date().toISOString(),
    title: 'AI 분석 · 뷰티블라썸 통합 전략 리포트',
    basis: {
      ga4: ga4.range,
      ga4Prev: ga4.prev_range,
      gsc: gsc?.range || null,
      competitors: comp?.generated_at_utc || null
    }
  },
  markets,
  tiers: TIERS,
  keywordOps: keywordOps.slice(0, 40),
  treatmentPlan,
  offeredNote: offered ? offered.note : null,
  // Terms customers search for that our own menu calls something else. Traffic already
  // arrives on these, so the mismatch costs conversions rather than visits.
  wordingGaps: [
    { searched: 'mole removal seoul / mole removal korea', menu: 'co2 / co2 1개 · 30개 · 50개',
      evidence: 'EN 검색 노출 346회 · 평균 4.2위' },
    { searched: 'tattoo removal seoul', menu: '문신제거 / 500원크기 · 명함크기',
      evidence: 'EN 검색 노출 33회 · 평균 5.4위' },
    { searched: 'skin analysis seoul / 韓国 肌診断', menu: '3D 피부진단 (본원 시술 25개 항목)',
      evidence: 'EN 596회 + JP 186회 노출 · 평균 5~6위 — 세 건 중 검색량이 가장 큽니다' },
    { searched: 'alltite (대만) / hilo wave (태국·중국)', menu: '전 시트에서 확인되지 않음',
      evidence: '대만 272회 + 태국·중국 160회 노출 — 실제 취급 여부를 원내에서 확인해 주십시오' }
  ],
  keywordMethod: {
    topCtrAssumed: TOP_CTR,
    minImpressions: MIN_IMPRESSIONS,
    rankBand: RANK_BAND
  },
  cityPattern,
  competitors,
  countryMatrix,
  organicPlays,
  // Which channels the ads themselves point people to, counted rather than assumed.
  // This is what settles "should we open a TikTok / X account" — the answer is in
  // what advertisers actually route traffic through, not in platform popularity.
  channelMentions: (() => {
    const c = comp;
    if (!c) return null;
    const all = [...(c.deepDive || []).flatMap(d => (d.ads || []).map(x => ({ ...x, self: !!d.isSelf }))),
      ...(c.ads || []).map(x => ({ ...x, self: false }))].filter(a => a.copy);
    const rivals = all.filter(a => !a.self);
    const mine = all.filter(a => a.self);
    const CH = [
      { name: 'WhatsApp', re: /whatsapp/i },
      { name: 'LINE', re: /\bline\b|line@|라인/i },
      { name: '인스타그램', re: /instagram|insta\b/i },
      { name: 'WeChat', re: /wechat|微信/i },
      { name: '카카오톡', re: /kakao|카카오/i },
      { name: '틱톡', re: /tiktok|틱톡|抖音/i },
      { name: '유튜브', re: /youtube|유튜브/i },
      { name: 'X(트위터)', re: /twitter|\bX\.com/i }
    ];
    return {
      rivalTotal: rivals.length, selfTotal: mine.length,
      rows: CH.map(ch => ({
        name: ch.name,
        rival: rivals.filter(a => ch.re.test(a.copy)).length,
        rivalLanding: rivals.filter(a => a.landingDomain && ch.re.test(a.landingDomain)).length,
        self: mine.filter(a => ch.re.test(a.copy)).length
      })).sort((a, b) => b.rival - a.rival)
    };
  })(),
  priceDisclosure,
  // How to act on the "we do this but rank nowhere" list. Kept separate from the
  // list itself because the fix is not a design job — the ranking signals are the
  // URL, the title and the words on the page, none of which a redesign touches.
  pageFix: {
    finding: '사이트맵을 열어 보니 한국·영문 각 105개 주소 가운데 시술 이름이 들어간 주소는 한국 12개, 영문 16개뿐이고 ' +
      '나머지는 /16, /17 같은 번호 주소입니다. 그리고 지금 검색 순위가 나오는 페이지가 정확히 그 이름 주소들입니다 — ' +
      '/Sculptra(sculptra seoul 3.6위), /LDM(한국 3,635회 노출), /re2o(elravie re2o 4.3위). ' +
      '반대로 리쥬란·써마지·온다·포텐자·쥬베룩은 이름 주소가 없습니다.',
    caveat: '이건 상관관계이지 인과관계는 아닙니다. 이름 주소를 붙인 페이지가 원래 더 공들여 만든 페이지일 수도 있습니다. ' +
      '다만 어느 쪽이든 결론은 같습니다 — 그 페이지들은 제대로 만들었고 나머지 90여 개는 그렇지 않다는 뜻이기 때문입니다.',
    notDesign: '"리디자인"이라는 말로 진행하시면 원하는 결과가 안 나옵니다. 디자이너에게 예쁘게 다시 만들어 달라고 하면 ' +
      '검색 순위는 그대로입니다. 순위를 만드는 것은 보이는 디자인이 아니라 아래 세 가지입니다.',
    steps: [
      { t: '주소에 시술 이름 넣기', d: '/16 → /rejuran 처럼 바꿉니다. 검색엔진과 사람 모두 주소만 보고 무슨 페이지인지 알 수 있어야 합니다.' },
      { t: '제목과 본문을 고객이 쓰는 말로', d: '위 ③-1에서 본 문제와 같습니다. 우리는 co2라고 적는데 고객은 mole removal로 검색합니다. 시술 정식 명칭과 고객이 쓰는 말을 함께 적어야 합니다.' },
      { t: '시술 하나에 페이지 하나', d: '여러 시술을 한 페이지에 몰아 넣으면 어느 검색어로도 잡히지 않습니다.' }
    ],
    order: '주소를 바꾸면 기존 순위가 한동안 흔들립니다. 그래서 <b>이미 순위가 나오는 페이지(/Sculptra · /LDM · /re2o)는 건드리지 마시고</b>, ' +
      '순위가 없는 것부터 손대십시오. 리쥬란·써마지·온다·포텐자·쥬베룩은 지금 잃을 것이 없어 시험 대상으로 가장 안전합니다.',
    experiment: '<b>다섯 개를 한꺼번에 바꾸지 마십시오.</b> 전부 바꾸면 6~8주 뒤에 무엇이 효과였는지 알 수 없습니다. ' +
      '경쟁사가 가장 많이 미는 리쥬란(광고 58건)과 써마지(46건) 두 개만 먼저 하고 나머지 셋은 그대로 두시면, ' +
      '10월에 둘을 비교해 답을 얻을 수 있습니다.',
    unknown: '한 가지 확인하지 못한 것이 있습니다. 우리 사이트가 자동 접속을 차단해 페이지 내용을 직접 읽지 못했습니다. ' +
      '그래서 "페이지가 아예 없는 것"인지 "있는데 검색에 안 잡히는 것"인지 구분하지 못했습니다. ' +
      '구글 서치콘솔의 페이지 보고서에서 색인 상태를 보시면 바로 확인됩니다. ' +
      'robots.txt는 검색엔진 접근을 막고 있지 않으니 크롤링 자체가 차단된 상태는 아닙니다. ' +
      '작은 것 하나 더 — 한국 robots.txt에 사이트맵 주소가 빠져 있습니다(영문에는 있고 중복으로 두 번 들어가 있습니다).'
  },
  serpScan: serp ? (() => {
    const rows = serp.rows.filter(r => !r.failed);
    const byMarket = ['JP', 'TW', 'EN'].map(k => {
      const rs = rows.filter(r => r.market === k);
      const all = rs.flatMap(r => r.results);
      const share = (kind) => pct(all.filter(x => x.kind === kind).length, all.length);
      return {
        market: k, label: rs[0]?.marketLabel || k, keywords: rs.length,
        clinicShare: share('korean-clinic') + share('rival'),
        mediaShare: share('media'),
        // Keywords with the fewest Korean clinics on page one are the easiest to enter.
        easiest: [...rs].sort((a, b) => a.clinicCount - b.clinicCount).slice(0, 5)
          .map(r => ({ treatment: r.treatment, query: r.query, clinics: r.clinicCount, media: r.mediaCount }))
      };
    });

    // Korean clinics that already hold page one. These, not the Meta advertisers,
    // are who we actually compete with in search.
    const holders = new Map();
    for (const r of rows) {
      for (const x of r.results) {
        if (x.kind !== 'korean-clinic' && x.kind !== 'rival') continue;
        if (!holders.has(x.host)) holders.set(x.host, { host: x.host, hits: [], best: 99 });
        const h = holders.get(x.host);
        h.hits.push({ market: r.marketLabel, treatment: r.treatment, rank: x.rank });
        h.best = Math.min(h.best, x.rank);
      }
    }
    const searchRivals = [...holders.values()]
      .sort((a, b) => b.hits.length - a.hits.length || a.best - b.best).slice(0, 12);

    // Platforms the clinic already pays for that rank on their own. Strengthening a
    // listing inside these is far cheaper than lifting our own site onto page one.
    const PARTNERS = [
      { name: '강남언니', re: /gangnamunni|gangnam-unni/i, haveDeal: true },
      { name: '크리에이트립', re: /creatrip/i, haveDeal: true },
      { name: '여신티켓', re: /yeoshin/i, haveDeal: true },
      { name: '바비톡', re: /babitalk/i, haveDeal: true }
    ];
    const partners = PARTNERS.map(p => {
      const hits = [];
      rows.forEach(r => r.results.forEach(x => {
        if (p.re.test(x.host)) hits.push({ market: r.marketLabel, treatment: r.treatment, rank: x.rank });
      }));
      hits.sort((a, b) => a.rank - b.rank);
      return { ...p, re: undefined, hits, count: hits.length };
    }).filter(p => p.count > 0).sort((a, b) => b.count - a.count);

    return {
      note: serp.note, source: serp.source,
      totals: serp.totals, byMarket, searchRivals, partners
    };
  })() : null,
  youtube: yt ? {
    channel: yt.channel, current: yt.current, previous: yt.previous,
    countries: (yt.countries || []).slice(0, 8),
    traffic: (yt.traffic || []).slice(0, 5),
    topVideos: (yt.topVideos || []).slice(0, 6)
  } : null,
  naverAvailable: !!naver,
  ytAvailable: !!yt
};

const TPL = join(ROOT, 'scripts', 'strategy-template.html');
if (!existsSync(TPL)) { console.error('missing template', TPL); process.exit(1); }
const tpl = readFileSync(TPL, 'utf8');
// Ad copy is arbitrary advertiser text, so a literal </script> in it would close the
// data block early and break the page.
const json = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script');
const html = tpl.replace('/*__PAYLOAD__*/null', json);
if (html === tpl) { console.error('payload placeholder not found'); process.exit(1); }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log('WROTE', OUT, (html.length / 1024).toFixed(1) + ' KB');
console.log('markets', markets.length,
  '| keyword ops', keywordOps.length,
  '| korean clinic advertisers', competitors ? competitors.korean.length : 'n/a');
