// Collects competitor advertising intelligence from the Meta Ad Library.
//
// Meta publishes no spend figure for medical ads (only issues/elections/politics ads
// disclose spend), so "who spends big" has to be inferred from observable proxies:
// how many active ads a page runs, how long they have been running, how many creative
// versions each ad carries, and how many countries the ads surface in. All four come
// out of the public Ad Library, which needs no login.
//
// The library is a JS app, so it is read through Jina Reader over plain HTTP rather
// than a browser. That keeps the collection off the user's machine entirely - no
// Chrome profile, no window, no mouse - which the logged-in OpenCLI channels cannot do.
//
// Jina sometimes snapshots before the app finishes rendering. A page that merely failed
// to render looks exactly like a page with no results, and mistaking one for the other
// would wrongly conclude a competitor does not target that country. Every response is
// therefore classified against explicit markers and retried until it is conclusive.
//
// Raw responses are cached so re-runs cost no requests.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'adlib');
const OUT = join(ROOT, 'data', 'competitors-2026-09.json');

// Discovery matrix. Countries are the markets Beauty Blossom actually draws traffic
// from (GA4 2026-07-21~08-19) plus the home market; queries are in the language the
// ads for that market are written in, because the library matches ad text.
const EN = ['Korea skin clinic', 'Korean dermatology', 'Seoul clinic', 'Gangnam clinic'];
const MATRIX = [
  { country: 'KR', queries: ['홍대 피부과', '강남 피부과', '피부과 이벤트'] },
  { country: 'PH', queries: EN },
  { country: 'ID', queries: EN },
  { country: 'AE', queries: EN },
  { country: 'IN', queries: EN },
  { country: 'SG', queries: EN },
  { country: 'VN', queries: EN },
  { country: 'TW', queries: ['韓國 醫美', '韓國 皮膚科', '首爾 醫美', ...EN] },
  { country: 'JP', queries: ['韓国 皮膚科', '韓国 美容医療', ...EN] },
  { country: 'TH', queries: EN }
];

// Response classification markers. Order matters: CAPTCHA can appear alongside chrome.
const M_CAPTCHA = 'requiring CAPTCHA';
const M_EMPTY = 'No ads match your search criteria';
const M_AD = 'Library ID:';

const SLEEP_MS = 3000;
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const libUrl = (id) => `https://www.facebook.com/ads/library/?id=${id}`;

// keyword_unordered matches the ad body; page matches the advertiser. Discovery needs
// the first, a per-advertiser sweep needs the second - searching an advertiser's name
// as body text misses every ad that does not spell the clinic's name out, which made
// advertisers look absent from countries they actively run ads in.
const searchUrl = (country, query, mode = 'keyword_unordered') =>
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all' +
  `&country=${country}&q=${encodeURIComponent(query)}&search_type=${mode}`;

// The mode belongs in the key: the same country+query means different things under
// each mode, and omitting it would serve keyword-mode HTML to a page-mode request.
const cacheKey = (country, query, mode) =>
  join(CACHE, `${mode === 'page' ? 'page__' : ''}${country}__${query.replace(/[^\p{L}\p{N}]+/gu, '_')}.md`);

// One fetch attempt. Returns the classified outcome rather than throwing, so the
// caller can distinguish "no ads exist" from "we failed to read the page".
async function attempt(country, query, mode) {
  const url = 'https://r.jina.ai/' + searchUrl(country, query, mode);
  let body;
  try {
    const res = await fetch(url, {
      headers: { 'x-timeout': '30', 'accept': 'text/plain' },
      signal: AbortSignal.timeout(150000)
    });
    body = await res.text();
  } catch (err) {
    return { status: 'error', reason: String(err.message || err), body: '' };
  }
  if (body.includes(M_AD)) return { status: 'ok', body };
  if (body.includes(M_EMPTY)) return { status: 'empty', body };
  if (body.includes(M_CAPTCHA)) return { status: 'captcha', body };
  return { status: 'unrendered', body };
}

async function fetchSearch(country, query, mode = 'keyword_unordered') {
  const key = cacheKey(country, query, mode);
  if (existsSync(key)) {
    const body = readFileSync(key, 'utf8');
    const status = body.includes(M_AD) ? 'ok' : body.includes(M_EMPTY) ? 'empty' : 'stale';
    if (status !== 'stale') return { status, body, cached: true };
  }
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const r = await attempt(country, query, mode);
    if (r.status === 'ok' || r.status === 'empty') {
      mkdirSync(dirname(key), { recursive: true });
      writeFileSync(key, r.body, 'utf8');
      return { ...r, attempts: i };
    }
    // CAPTCHA means the shared Jina pool is throttled; back off harder than a
    // half-rendered page, which usually succeeds on an immediate retry.
    await sleep(r.status === 'captcha' ? 20000 * i : 5000 * i);
    if (i === MAX_ATTEMPTS) return { ...r, attempts: i };
  }
}

// Meta wraps outbound clicks in l.facebook.com/l.php?u=<encoded>. The real landing
// domain is the strongest signal of whether an advertiser is a Korean clinic.
function unwrapLanding(href) {
  try {
    const u = new URL(href);
    if (u.hostname.endsWith('facebook.com') && u.pathname === '/l.php') {
      const target = u.searchParams.get('u');
      if (target) return target;
    }
    return href;
  } catch { return href; }
}

const FB_CHROME = ['/help/', '/policies/', '/ads/', '/business/', '/privacy/', '/legal/', '/language/'];

function parseAds(md, country, query) {
  const chunks = md.split(/(?=Library ID:\s*\d+)/g).filter(c => c.startsWith('Library ID:'));
  return chunks.map(chunk => {
    const id = (chunk.match(/Library ID:\s*(\d+)/) || [])[1];
    const started = (chunk.match(/Started running on ([A-Z][a-z]{2} \d{1,2}, \d{4})/) || [])[1] || null;

    const links = [...chunk.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)]
      .map(m => ({ text: m[1].trim(), href: m[2] }));

    // The library renders the advertiser two ways: as a link to its page, or as bare
    // text when the page is not linked. Both put it on the line directly above the
    // Sponsored marker, which is the only position that holds across both variants.
    // Keying off the link alone silently dropped half the ads.
    const lines = chunk.split('\n').map(l => l.trim());
    const spIdx = lines.findIndex(l => /^\*{0,2}Sponsored\*{0,2}$/.test(l));
    let advertiser = null;
    if (spIdx > 0) {
      for (let i = spIdx - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l || l === '​' || l.startsWith('![')) continue;
        if (/^(Platforms|Open Dropdown|See ad details|\* \* \*|This ad has multiple versions|Library ID:.*|Started running on .*)$/.test(l)) continue;
        const asLink = l.match(/^\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
        if (asLink) {
          advertiser = { text: asLink[1].trim(), href: asLink[2] };
        } else if (!l.startsWith('[')) {
          advertiser = { text: l, href: null };
        }
        break;
      }
    }
    // Third variant: some cards carry no Sponsored marker and no advertiser text at
    // all, and the only place the name survives is the alt text of the advertiser's
    // avatar thumbnail. That thumbnail is always the s60x60 crop.
    if (!advertiser) {
      const avatar = [...chunk.matchAll(/!\[Image \d+:\s*([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)]
        .find(m => m[2].includes('s60x60'));
      if (avatar) advertiser = { text: avatar[1].trim(), href: null };
    }

    // Prefer the page URL when the block also carries it as a link elsewhere.
    if (advertiser && !advertiser.href) {
      const pageLink = links.find(l =>
        /^https:\/\/(www\.)?facebook\.com\//.test(l.href) &&
        !FB_CHROME.some(p => l.href.includes(p)) && l.text === advertiser.text);
      if (pageLink) advertiser.href = pageLink.href;
    }

    const landings = links
      .map(l => ({ text: l.text, href: unwrapLanding(l.href) }))
      .filter(l => !/(^https:\/\/(www\.|l\.)?facebook\.com\/)|fbcdn\.net/.test(l.href));

    const images = [...chunk.matchAll(/!\[Image \d+(?::\s*([^\]]*))?\]\((https?:\/\/[^)\s]+)\)/g)]
      .map(m => ({ alt: (m[1] || '').trim(), url: m[2] }));

    // s60x60 thumbnails are the advertiser avatar repeated on every card; anything
    // larger is the actual ad creative.
    const creatives = images.filter(i => !i.url.includes('s60x60')).map(i => i.url);

    // Copy is everything after the Sponsored marker, minus link and footer noise.
    const copy = (spIdx >= 0 ? lines.slice(spIdx + 1) : [])
      .filter(l => l && l !== '​' && !l.startsWith('[') && !l.startsWith('!['))
      .filter(l => !/^(Active|Inactive|Open Dropdown|See ad details|Platforms|\* \* \*)$/.test(l))
      .filter(l => !/^Sorry, we're having trouble/.test(l))
      .join('\n')
      .trim();

    let landingDomain = null;
    if (landings[0]) { try { landingDomain = new URL(landings[0].href).hostname; } catch {} }

    return {
      libraryId: id,
      adLibraryUrl: id ? libUrl(id) : null,
      country,
      query,
      advertiser: advertiser ? advertiser.text : null,
      advertiserUrl: advertiser ? advertiser.href : null,
      startedRunning: started,
      multipleVersions: chunk.includes('This ad has multiple versions'),
      landingUrl: landings[0] ? landings[0].href : null,
      landingDomain,
      ctaText: landings[0] ? landings[0].text : null,
      creativeCount: creatives.length,
      creativeUrls: creatives.slice(0, 6),
      copy
    };
  }).filter(a => a.libraryId);
}

// Korean-clinic classification. Every rule records the evidence that fired so the
// report can show why an advertiser was included rather than asserting it.
const KR_TOKEN = /(korea|korean|seoul|gangnam|hongdae|myeongdong|apgujeong|cheongdam|한국|서울|강남|홍대|명동|압구정|청담|韓國|韩国|韓国|首爾|首尔)/i;
const KR_PLACE_DOMAIN = /(gangnam|hongdae|seoul|myeongdong|apgujeong|cheongdam|korea)/i;
const CLINIC = /(clinic|clinique|dermatolog|aesthetic|의원|병원|치과|클리닉|피부과|성형|醫美|医美|皮膚科|皮肤科|整形|美容外科|クリニック)/i;
const CLINIC_DOMAIN = /(clinic|clinique|derma|medical|hospital|\.kr$)/i;
// K-beauty product shops and content affiliates advertise on the same keywords but
// are not patient-acquisition competitors for a Seoul clinic.
const NOT_CLINIC = /(beauty (secrets|tips)|skincare \d|k-?beauty (shop|store)|cosmetics|review|blog|\bshop\b|\bstore\b|\bmall\b)/i;

function classify(name, domains, copyBlob) {
  const evidence = [];
  const doms = domains.filter(Boolean);

  if (doms.some(d => d.endsWith('.kr'))) evidence.push('랜딩 도메인이 .kr');
  if (doms.some(d => KR_PLACE_DOMAIN.test(d))) evidence.push('랜딩 도메인에 한국 지명');
  if (name && KR_TOKEN.test(name)) evidence.push('광고주명에 한국/지역 표기');
  // The ad body is the advertiser's own words, so a Seoul address or a Gangnam
  // branch named in the copy is direct evidence rather than an inference.
  if (copyBlob && KR_TOKEN.test(copyBlob)) evidence.push('광고 카피에 한국/지역 언급');

  const clinicName = name && CLINIC.test(name);
  const clinicDomain = doms.some(d => CLINIC_DOMAIN.test(d));
  const clinicCopy = copyBlob && CLINIC.test(copyBlob);
  if (clinicName) evidence.push('광고주명이 의료기관');
  if (clinicDomain) evidence.push('랜딩 도메인이 의료기관');

  const korean = evidence.some(e => e.startsWith('랜딩') || e.startsWith('광고주명에') || e.startsWith('광고 카피에'));
  const clinic = clinicName || clinicDomain || clinicCopy;
  const excluded = name && NOT_CLINIC.test(name) && !clinicName && !clinicDomain;
  if (excluded) evidence.push('제품·콘텐츠 제휴로 판정하여 제외');

  return {
    korean: !!(korean && clinic && !excluded),
    // Korean signal without a solid clinic signal is flagged rather than guessed.
    needsReview: !!(korean && !clinic && !excluded),
    evidence
  };
}

// Beauty Blossom's own pages surface on these keywords too. They are the subject of
// the report, not a competitor in it.
const SELF = /(beauty\s*blossom|beautyblossom|뷰티블라썸|麗朵|丽朵)/i;

function rollUp(ads) {
  const byAdvertiser = new Map();
  for (const ad of ads) {
    // Key on the name first: the same advertiser appears with and without a page
    // link depending on how the card rendered, and keying on the URL split those
    // into separate rows that then looked like two smaller advertisers.
    const key = (ad.advertiser && ad.advertiser.trim().toLowerCase())
      || ad.advertiserUrl || `unknown:${ad.libraryId}`;
    if (!byAdvertiser.has(key)) {
      byAdvertiser.set(key, {
        name: ad.advertiser, url: ad.advertiserUrl,
        libraryIds: new Set(), countries: new Set(), landingDomains: new Set(),
        startDates: [], creativeTotal: 0, multiVersionAds: 0, sampleAds: [], copy: []
      });
    }
    const a = byAdvertiser.get(key);
    a.libraryIds.add(ad.libraryId);
    a.countries.add(ad.country);
    if (ad.landingDomain) a.landingDomains.add(ad.landingDomain);
    if (ad.startedRunning) a.startDates.push(ad.startedRunning);
    a.creativeTotal += ad.creativeCount;
    if (ad.multipleVersions) a.multiVersionAds++;
    if (a.sampleAds.length < 4) a.sampleAds.push(ad.libraryId);
    if (ad.copy && a.copy.length < 6) a.copy.push(ad.copy);
  }

  return [...byAdvertiser.values()].map(a => {
    const domains = [...a.landingDomains];
    const { korean, needsReview, evidence } = classify(a.name, domains, a.copy.join('\n'));
    const dates = a.startDates.map(d => new Date(d)).filter(d => !isNaN(d)).sort((x, y) => x - y);
    const earliest = dates[0] || null;
    const runningDays = earliest ? Math.round((Date.now() - earliest) / 86400000) : null;
    return {
      name: a.name,
      url: a.url,
      isSelf: !!(a.name && SELF.test(a.name)) ||
        domains.some(d => /beautyblossom/i.test(d)),
      activeAdCount: a.libraryIds.size,
      countries: [...a.countries].sort(),
      countryCount: a.countries.size,
      landingDomains: domains,
      earliestStart: earliest ? earliest.toISOString().slice(0, 10) : null,
      runningDays,
      creativeTotal: a.creativeTotal,
      multiVersionAds: a.multiVersionAds,
      koreanClinic: korean && !(a.name && SELF.test(a.name)),
      needsReview,
      classificationEvidence: evidence,
      sampleAdLibraryUrls: a.sampleAds.map(libUrl)
    };
  }).sort((x, y) =>
    y.countryCount - x.countryCount ||
    y.activeAdCount - x.activeAdCount ||
    (y.runningDays || 0) - (x.runningDays || 0));
}

// Deep dive targets. Discovery ranks by proxy scale, but the top of that ranking also
// contains K-beauty affiliates that merely mention Korea, so the benchmark set is
// named explicitly and the reason recorded. Every name here was confirmed against its
// landing domain or ad copy in the discovery pass.
// `token` is the brand string used to keep only this advertiser's cards. It is
// deliberately short: a clinic often runs one Meta page per branch and per language
// (Cleor has separate 弘大 and 江南 pages), and all of them belong in the profile.
const DEEP_TARGETS = [
  { name: 'Kleam Clinic', token: 'kleam', reason: '소재를 갈지 않고 장기 유지하는 운영 · 노출 국가 최다' },
  { name: '오션클리닉', token: '오션', reason: '강남 소재(gangnam.oceanclinic.co.kr) · 일본어 서브도메인 운영' },
  { name: 'PRIA Clinic', token: 'pria', reason: '발견 단계 활성 광고 최다' },
  { name: 'Selenaclinic', token: 'selena', reason: '활성 광고 13건 · 홍대 표기 확인 · 동남아 집중' },
  { name: 'Cleor Clinic', token: 'cleor', reason: '강남·홍대 지점을 별도 페이지로 운영 · 시장별 브랜드명 현지화' },
  { name: 'Primi Clinic', token: 'primi', reason: '성수 소재 · 영문 전용 도메인으로 걸프까지 커버' },
  { name: 'ShineBeam', token: 'shinebeam', reason: '뷰티블라썸과 같은 홍대 양화로 상권 · 영어 랜딩으로 동남아 직접 공략' },
  // Beauty Blossom is measured the same way as the competitors on purpose: a
  // comparison only means something if both sides were counted by one method.
  { name: 'Beautyblossom', token: 'beautyblossom', reason: '자사 — 경쟁사와 같은 방식으로 수집한 비교 기준', isSelf: true }
];

// Branches outside the benchmark area. A clinic often runs one page per branch, and
// a branch in a district we do not compete in tells us nothing — Beauty Blossom is in
// Hongdae, so only Hongdae and Gangnam pages belong in the comparison.
const OUT_OF_AREA = /(gangseo|강서|江西|bucheon|부천|incheon|인천|suwon|수원|busan|부산|daegu|대구|daejeon|대전|gwangju|광주|jeju|제주|ilsan|일산|anyang|안양)/i;

// A named-advertiser query returns few cards, so the library renders all of them.
// That is what makes the deep pass recover ad copy the broad discovery pass missed.
async function deepDive(targets, countries) {
  const out = [];
  for (const t of targets) {
    const byCountry = [];
    for (const country of countries) {
      const r = await fetchSearch(country, t.name, 'page');
      const parsed = r.status === 'ok' ? parseAds(r.body, country, t.name) : [];
      // Advertiser mode still returns neighbouring pages, so keep only cards whose
      // advertiser carries the brand token.
      const mine = parsed.filter(a => a.advertiser &&
        a.advertiser.toLowerCase().includes(t.token.toLowerCase()) &&
        !OUT_OF_AREA.test(a.advertiser));
      byCountry.push({ country, status: r.status, adsFound: mine.length, ads: mine });
      console.log(`  deep ${t.name} @ ${country} -> ${r.status} (${mine.length})${r.cached ? ' [cached]' : ''}`);
      if (!r.cached) await sleep(SLEEP_MS);
    }
    const ads = byCountry.flatMap(c => c.ads);
    const dates = ads.map(a => new Date(a.startedRunning)).filter(d => !isNaN(d)).sort((x, y) => x - y);
    out.push({
      name: t.name,
      isSelf: !!t.isSelf,
      selectionReason: t.reason,
      activeCountries: byCountry.filter(c => c.adsFound > 0).map(c => c.country),
      // Countries whose query resolved cleanly but found nothing: a real absence,
      // as opposed to a country we simply failed to read.
      confirmedAbsent: byCountry.filter(c => c.adsFound === 0 && (c.status === 'ok' || c.status === 'empty')).map(c => c.country),
      unresolved: byCountry.filter(c => c.status !== 'ok' && c.status !== 'empty').map(c => c.country),
      totalAds: ads.length,
      earliestStart: dates[0] ? dates[0].toISOString().slice(0, 10) : null,
      // A clinic usually runs one page per branch and per language; listing them
      // shows how the operation is actually split.
      pages: [...new Set(ads.map(a => a.advertiser).filter(Boolean))],
      landingDomains: [...new Set(ads.map(a => a.landingDomain).filter(Boolean))],
      byCountry: byCountry.map(({ ads, ...rest }) => rest),
      ads
    });
  }
  return out;
}

async function main() {
  const selfTest = process.argv.includes('--self-test');
  if (selfTest) {
    const cached = existsSync(CACHE) ? readdirSync(CACHE).length : 0;
    console.log('matrix:', MATRIX.length, 'countries,',
      MATRIX.reduce((n, m) => n + m.queries.length, 0), 'requests');
    console.log('cache :', CACHE, `(${cached} files)`);
    console.log('out   :', OUT);
    return;
  }

  const ads = [];
  const discovery = [];
  for (const { country, queries } of MATRIX) {
    for (const query of queries) {
      const r = await fetchSearch(country, query);
      let found = 0;
      if (r.status === 'ok') {
        const parsed = parseAds(r.body, country, query);
        ads.push(...parsed);
        found = parsed.length;
      }
      discovery.push({
        country, query, status: r.status, ads: found,
        cached: !!r.cached, attempts: r.attempts || 0
      });
      console.log(`${country} "${query}" -> ${r.status} (${found} ads)${r.cached ? ' [cached]' : ''}`);
      if (!r.cached) await sleep(SLEEP_MS);
    }
  }

  const advertisers = rollUp(ads);
  const failed = discovery.filter(d => d.status !== 'ok' && d.status !== 'empty');

  let deep = null;
  if (process.argv.includes('--deep')) {
    const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
    const targets = only
      ? only.split(',').map(n => ({ name: n.trim(), reason: '수동 지정' }))
      : DEEP_TARGETS;
    console.log(`\ndeep dive: ${targets.length} advertisers x ${MATRIX.length} countries`);
    deep = await deepDive(targets, MATRIX.map(m => m.country));
  }

  const payload = {
    generated_at_utc: new Date().toISOString(),
    source: 'Meta Ad Library (public, no login) read via Jina Reader over HTTP',
    note: '메타는 병원 광고의 지출 금액을 공개하지 않습니다. 그래서 이 보고서의 "규모"는 지금 돌리는 광고 개수, ' +
          '며칠째 계속하고 있는지, 소재를 몇 개 쓰는지, 몇 개 나라에 뿌리는지로 가늠한 것이며 실제 광고비 금액이 아닙니다.',
    method: {
      matrix: MATRIX,
      markers: { hasAds: M_AD, noResults: M_EMPTY, throttled: M_CAPTCHA },
      unresolvedQueries: failed
    },
    totals: {
      requests: discovery.length,
      adsParsed: ads.length,
      advertisers: advertisers.length,
      koreanClinics: advertisers.filter(a => a.koreanClinic).length,
      needsReview: advertisers.filter(a => a.needsReview).length,
      adsWithoutAdvertiser: ads.filter(a => !a.advertiser).length
    },
    discovery,
    advertisers,
    deepDive: deep,
    ads
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log('\nWROTE', OUT);
  console.log('ads', ads.length, '| advertisers', advertisers.length,
    '| korean clinics', payload.totals.koreanClinics, '| unresolved', failed.length);
}

main().catch(err => { console.error(err); process.exit(1); });
