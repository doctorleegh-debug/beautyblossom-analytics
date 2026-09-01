// Finds which Mapo-gu / Hongdae clinics advertise to foreign patients on Meta,
// which keywords they buy, and how the ad copy is written.
//
// KR keyword search returns nothing by Meta policy (ad-body keyword search outside
// the EU is limited to social-issue/political ads), so the overseas markets are the
// only place these ads are observable. Every country that returns ads is recorded;
// a country that returns none is recorded as such, never silently dropped.
//
// Reuses the Ad Library reading method already in use here: Jina Reader over plain
// HTTP, responses cached under .cache/adlib so re-runs cost no requests.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'adlib');
const OUT = join(ROOT, 'data', 'ads-overseas-mapo.json');

const M_CAPTCHA = 'requiring CAPTCHA';
const M_EMPTY = 'No ads match your search criteria';
const M_AD = 'Library ID:';
const SLEEP_MS = 2500;
const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const libUrl = (id) => `https://www.facebook.com/ads/library/?id=${id}`;

// Keywords a Hongdae/Mapo clinic would buy to reach foreign patients, in the
// language of the market that would type them. Korean is included because Korean
// ads also run in markets with large Korean-speaking populations.
const EN = ['Hongdae dermatology', 'Hongdae skin clinic', 'Hapjeong clinic', 'Hongdae clinic Seoul'];
const KO = ['홍대 피부과', '합정 피부과', '홍대 성형외과', '마포 피부과'];
const MATRIX = [
  { country: 'SG', queries: EN },
  { country: 'PH', queries: EN },
  { country: 'ID', queries: EN },
  { country: 'AE', queries: EN },
  { country: 'TH', queries: [...EN, 'คลินิก เกาหลี ฮงแด'] },
  { country: 'JP', queries: ['弘大 皮膚科', 'ホンデ 皮膚科', '合井 クリニック', '韓国 美容皮膚科', ...KO] },
  { country: 'TW', queries: ['弘大 皮膚科', '弘大 醫美', '合井 醫美'] },
  { country: 'KR', queries: KO },
  // Country coverage sweep. The first pass showed which keywords actually surface
  // these clinics; those are re-run across the rest of the markets a Seoul clinic
  // would court, so "which countries is this clinic advertising in" is measured
  // rather than inferred from the handful of countries the first pass happened to
  // cover. Countries with no Meta presence (CN) are left out.
  ...['VN', 'MY', 'HK', 'US', 'IN', 'AU', 'GB', 'CA', 'SA', 'MN', 'KZ', 'RU'].map(country => ({
    country, queries: ['Hongdae skin clinic', 'Hapjeong clinic', 'Hongdae clinic Seoul']
  }))
];

const searchUrl = (country, query) =>
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all' +
  `&country=${country}&q=${encodeURIComponent(query)}&search_type=keyword_unordered`;

const cacheKey = (country, query) =>
  join(CACHE, `${country}__${query.replace(/[^\p{L}\p{N}]+/gu, '_')}.md`);

async function attempt(country, query) {
  const url = 'https://r.jina.ai/' + searchUrl(country, query);
  let body;
  try {
    const res = await fetch(url, {
      headers: { 'x-timeout': '45', 'accept': 'text/plain' },
      signal: AbortSignal.timeout(180000)
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

async function fetchSearch(country, query) {
  const key = cacheKey(country, query);
  if (existsSync(key)) {
    const body = readFileSync(key, 'utf8');
    if (body.includes(M_AD)) return { status: 'ok', body, cached: true };
    if (body.includes(M_EMPTY)) return { status: 'empty', body, cached: true };
  }
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const r = await attempt(country, query);
    if (r.status === 'ok' || r.status === 'empty') {
      mkdirSync(dirname(key), { recursive: true });
      writeFileSync(key, r.body, 'utf8');
      return { ...r, attempts: i };
    }
    await sleep(r.status === 'captcha' ? 20000 * i : 5000 * i);
    if (i === MAX_ATTEMPTS) return { ...r, attempts: i };
  }
}

function unwrapLanding(href) {
  try {
    const u = new URL(href);
    if (u.hostname.endsWith('facebook.com') && u.pathname === '/l.php') {
      const t = u.searchParams.get('u');
      if (t) return t;
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

    const lines = chunk.split('\n').map(l => l.trim());
    const spIdx = lines.findIndex(l => /^\*{0,2}Sponsored\*{0,2}$/.test(l));
    let advertiser = null;
    if (spIdx > 0) {
      for (let i = spIdx - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l || l === '​' || l.startsWith('![')) continue;
        if (/^(Platforms|Open Dropdown|See ad details|\* \* \*|This ad has multiple versions|Library ID:.*|Started running on .*)$/.test(l)) continue;
        const asLink = l.match(/^\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
        if (asLink) advertiser = { text: asLink[1].trim(), href: asLink[2] };
        else if (!l.startsWith('[')) advertiser = { text: l, href: null };
        break;
      }
    }
    if (!advertiser) {
      const avatar = [...chunk.matchAll(/!\[Image \d+:\s*([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)]
        .find(m => m[2].includes('s60x60'));
      if (avatar) advertiser = { text: avatar[1].trim(), href: null };
    }
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
    const creatives = images.filter(i => !i.url.includes('s60x60')).map(i => i.url);

    const copy = (spIdx >= 0 ? lines.slice(spIdx + 1) : [])
      .filter(l => l && l !== '​' && !l.startsWith('[') && !l.startsWith('!['))
      .filter(l => !/^(Active|Inactive|Open Dropdown|See ad details|Platforms|\* \* \*)$/.test(l))
      .filter(l => !/^Sorry, we/.test(l))
      .join('\n').trim();

    let landingDomain = null;
    if (landings[0]) { try { landingDomain = new URL(landings[0].href).hostname; } catch {} }

    return {
      libraryId: id, adLibraryUrl: id ? libUrl(id) : null, country, query,
      advertiser: advertiser ? advertiser.text : null,
      advertiserUrl: advertiser ? advertiser.href : null,
      startedRunning: started,
      multipleVersions: chunk.includes('This ad has multiple versions'),
      landingUrl: landings[0] ? landings[0].href : null, landingDomain,
      ctaText: landings[0] ? landings[0].text : null,
      creativeCount: creatives.length, creativeUrls: creatives.slice(0, 6), copy
    };
  }).filter(a => a.libraryId);
}

// Mapo-gu evidence. Neighbourhood names are the only reliable marker: an ad that
// names Hongdae or Hapjeong is claiming that location, and the district's clinics
// are the ones that do. Recorded as evidence so the report can show why, rather
// than asserting the clinic is in Mapo.
const MAPO = [
  ['hongdae', /hongdae|hong-dae|hong dae/i], ['홍대', /홍대/], ['弘大', /弘大/],
  ['ホンデ', /ホンデ/], ['hapjeong', /hapjeong|hap-jeong/i], ['합정', /합정/],
  ['合井', /合井/], ['mapo', /\bmapo\b/i], ['마포', /마포/],
  ['sangsu', /sangsu|상수동/i], ['yeonnam', /yeonnam|연남/i], ['mangwon', /mangwon|망원/i],
  ['seogyo', /seogyo|서교동/i], ['donggyo', /donggyo|동교동/i]
];
const CLINIC = /(clinic|clinique|dermatolog|aesthetic|의원|병원|클리닉|피부과|성형|醫美|医美|皮膚科|皮肤科|整形|美容外科|クリニック)/i;
// Money written in an ad. Korean clinics quote KRW to locals and the market
// currency to foreign patients, so all the plausible forms are matched.
const PRICE = [
  ['KRW', /(?:₩|\bKRW\b)\s?[\d,]{3,}|[\d,]{3,}\s?원|\d{1,4}\s?만\s?원/],
  ['USD', /\$\s?\d[\d,.]*|\bUSD\s?\d/i],
  ['SGD', /\bS\$\s?\d|\bSGD\s?\d/i],
  ['THB', /฿\s?\d|\bTHB\s?\d|บาท/i],
  ['JPY', /[¥￥]\s?[\d,]{3,}|\d[\d,]*\s?円/],
  ['TWD', /\bNT\$\s?\d|\bTWD\s?\d/i],
  ['PHP', /₱\s?\d|\bPHP\s?\d/i],
  ['IDR', /\bRp\.?\s?[\d.]{4,}|\bIDR\s?\d/i],
  ['AED', /\bAED\s?\d/i],
  ['VND', /\bVND\s?\d/i]
];

function evidence(ad) {
  const blob = [ad.advertiser || '', ad.copy || '', ad.landingUrl || '', ad.ctaText || ''].join(' \n ');
  const mapo = MAPO.filter(([, re]) => re.test(blob)).map(([tag]) => tag);
  const currency = PRICE.filter(([, re]) => re.test(blob)).map(([tag]) => tag);
  const amounts = [];
  for (const [, re] of PRICE) {
    const g = new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g');
    for (const m of blob.matchAll(g)) { if (amounts.length < 8) amounts.push(m[0].trim()); }
  }
  return {
    mapoTokens: mapo,
    isMapo: mapo.length > 0,
    namesClinic: CLINIC.test(ad.advertiser || '') || CLINIC.test(blob),
    // The advertiser field is the clinic's own page name; an ad carrying it is an
    // ad that discloses who is advertising.
    disclosesName: Boolean(ad.advertiser),
    currencies: currency,
    priceSamples: amounts,
    disclosesPrice: amounts.length > 0
  };
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const sample = 'Library ID: 123\nStarted running on Aug 1, 2026\n**Sponsored**\n홍대 피부과 리프팅 99,000원';
    const [ad] = parseAds(sample, 'KR', 't');
    const ev = evidence({ ...ad, advertiser: 'Test Clinic' });
    console.log('SelfTest');
    console.log('  parsed=' + Boolean(ad));
    console.log('  mapo=' + ev.isMapo + ' price=' + ev.disclosesPrice + ' samples=' + JSON.stringify(ev.priceSamples));
    console.log('SelfTestPassed=' + (Boolean(ad) && ev.isMapo && ev.disclosesPrice));
    return;
  }

  const scanOnly = process.argv.includes('--scan-cache');
  const byAd = new Map();
  const coverage = [];

  // Pass 1 - every response already on disk, whatever query produced it. Free.
  const files = readdirSync(CACHE).filter(n => n.endsWith('.md'));
  for (const f of files) {
    const md = readFileSync(join(CACHE, f), 'utf8');
    const [c, q] = basename(f, '.md').replace(/^page__/, '').split('__');
    for (const ad of parseAds(md, c, (q || '').replace(/_/g, ' '))) {
      if (!byAd.has(ad.libraryId)) byAd.set(ad.libraryId, { ...ad, seenIn: [] });
      byAd.get(ad.libraryId).seenIn.push({ country: c, query: (q || '').replace(/_/g, ' '), source: 'cache' });
    }
  }
  console.log(`cache scan: ${byAd.size} distinct ads across ${files.length} cached responses`);

  // Pass 2 - the targeted Hongdae/Hapjeong keyword matrix.
  if (!scanOnly) {
    for (const { country, queries } of MATRIX) {
      for (const q of queries) {
        const r = await fetchSearch(country, q);
        const ads = r.status === 'ok' ? parseAds(r.body, country, q) : [];
        coverage.push({
          country, query: q, status: r.status,
          cached: Boolean(r.cached), ads: ads.length,
          note: r.status === 'ok' ? null
            : r.status === 'empty' ? 'measured zero'
            : 'NOT COLLECTED - ' + r.status
        });
        for (const ad of ads) {
          if (!byAd.has(ad.libraryId)) byAd.set(ad.libraryId, { ...ad, seenIn: [] });
          byAd.get(ad.libraryId).seenIn.push({ country, query: q, source: 'matrix' });
        }
        console.log(`  ${country} / ${q} -> ${r.status} ${ads.length} ads${r.cached ? ' (cached)' : ''}`);
        if (!r.cached) await sleep(SLEEP_MS);
      }
    }
  }

  const all = [...byAd.values()].map(ad => ({ ...ad, evidence: evidence(ad) }));
  const mapo = all.filter(a => a.evidence.isMapo);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    method: 'Meta Ad Library, active ads, keyword_unordered, read through Jina Reader',
    limitation: 'Meta limits ad-body keyword search outside the EU to social-issue and political ads, so KR queries return nothing. Overseas markets are where these ads are observable.',
    coverage,
    totals: {
      distinctAds: all.length,
      mapoLinked: mapo.length,
      mapoWithPrice: mapo.filter(a => a.evidence.disclosesPrice).length
    },
    ads: mapo
  }, null, 2), 'utf8');
  console.log(`\nmapo-linked ads: ${mapo.length} / ${all.length}`);
  console.log(`  disclosing a price: ${mapo.filter(a => a.evidence.disclosesPrice).length}`);
  console.log(`written: ${OUT}`);
}

main();
