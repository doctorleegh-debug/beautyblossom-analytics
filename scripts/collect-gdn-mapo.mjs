// Finds which Mapo-gu / Hongdae clinics run Google Display (GDN) ads that show the
// clinic's own name, and mirrors the creatives so the ad content can be read.
//
// The Ads Transparency Center only resolves an advertiser from a domain - typing a
// clinic name into it returns nothing readable over HTTP - so each clinic's website
// is resolved first and the domain is what drives the lookup.
//
// Format matters for this question: Google labels search text ads TEXT and display
// banners IMAGE/VIDEO. Only the latter are GDN, so each advertiser is queried per
// format rather than in aggregate, and the TEXT count is kept only to show the split.
//
// Responses are cached under .cache/atc so re-runs cost no requests.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'atc');
const OUT = join(ROOT, 'data', 'gdn-mapo.json');
const REGION = 'KR';
const SLEEP_MS = 2000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Clinics that surfaced as Hongdae/Hapjeong advertisers on Meta, plus the competitor
// set already tracked here. Domains that came straight off a Meta ad landing are
// pre-filled; the rest are resolved from the clinic's site.
// Addresses are the Mapo-gu evidence, taken from each clinic's own site rather than
// inferred from the ad, so an advertiser is never called local without a source.
const CLINICS = [
  { name: '셀레나의원', domain: 'selenaskin.com', addr: '마포구 양화로 162, 9층 (동교동)' },
  { name: '포레나의원', domain: 'forenaclinic.com', addr: '마포구 (홍대)' },
  { name: '샤인빔의원 홍대', domain: 'shinebeam.co.kr', addr: '마포구 (홍대)' },
  { name: '쁨의원', domain: 'ppeum16.com', addr: '마포구 (홍대)' },
  { name: '뷰티블라썸의원', domain: 'beautyblossom.kr', addr: '마포구 (홍대·합정) — 자사' },
  { name: '클레오르의원 홍대점', domain: 'cleorclinic.com', addr: '마포구 양화로 165, 4층' },
  { name: '클림의원', domain: 'kleam.kr', addr: '마포구 양화로 141, L7홍대 3층' },
  { name: '아르스킨의원 홍대', domain: 'arskinclinic.co.kr', addr: '마포구 (홍대)' },
  { name: '블리비의원(Velyb)', domain: 'velyb.kr', addr: '마포구 양화로 161, 4층 (동교동)' },
  { name: '홍대 톡스앤필의원', domain: 'toxnfill50.com', addr: '마포구 (홍대)' },
  { name: '프로젝트유의원', domain: 'projectuclinic.com', addr: '마포구 양화로 162, 6층' },
  { name: '에스리본의원', domain: 's-reborn.com', addr: '마포구 양화로 162, 8층 (동교동)' },
  { name: '닥터에버스의원 홍대', domain: 'evers12.co.kr', addr: '마포구 (홍대)' },
  { name: '유픽의원 홍대', domain: 'upicclinic.com', addr: '마포구 양화로 140, H-CUBE 9층' },
  { name: '엔봄의원', domain: null, addr: '마포구 (홍대) — 홈페이지 미확인' },
  { name: '데이뷰의원', domain: null, addr: '마포구 양화로 165, 4층 — 네이버예약만 운영, 자체 도메인 없음' }
];

const MAPO = /마포구|홍대|합정|서교동|동교동|연남|망원|상수동|Mapo|Hongdae|Hapjeong/i;

function cached(key, body) {
  const f = join(CACHE, key.replace(/[^\w.-]+/g, '_') + '.md');
  if (body === undefined) return existsSync(f) ? readFileSync(f, 'utf8') : null;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body, 'utf8');
  return body;
}

async function jina(url, key) {
  const hit = cached(key);
  if (hit) return { body: hit, cached: true };
  let body = '';
  try {
    const res = await fetch('https://r.jina.ai/' + url, {
      headers: { 'x-timeout': '50', accept: 'text/plain' },
      signal: AbortSignal.timeout(190000)
    });
    body = await res.text();
  } catch (err) {
    return { body: '', error: String(err.message || err) };
  }
  // A response that never rendered the app carries none of the page furniture the
  // real page always has. Caching it would freeze a failure in as if it were data.
  if (!/Ads In|advertiser|No ads|ads$/im.test(body)) return { body, unrendered: true };
  cached(key, body);
  return { body };
}

// The count has to come from the domain view, not the advertiser view. Several of
// these clinics are advertised through an agency account that also runs ads for
// other hospitals, so the advertiser's own totals are the agency's whole book -
// attributing those to one clinic overstates it by an order of magnitude
// (toxnfill50.com read 773 display ads that way; the domain view says 10).
const atcDomain = (d, fmt) =>
  `https://adstransparency.google.com/?region=${REGION}&domain=${d}` + (fmt ? `&format=${fmt}` : '');
const atcAdv = (id, fmt) =>
  `https://adstransparency.google.com/advertiser/${id}?region=${REGION}` + (fmt ? `&format=${fmt}` : '');

// "32 ads" / "1 ad" is how the centre states the count for the current filter.
function adCount(md) {
  const m = md.match(/(\d[\d,]*)\s+ads?\b/i);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}
const advertiserIds = (md) => [...new Set((md.match(/AR\d{15,}/g) || []))];
const creatives = (md) => [...new Set((md.match(/https:\/\/tpc\.googlesyndication\.com\/archive\/simgad\/\d+/g) || []))];
const creativePages = (md) => [...new Set((md.match(/https:\/\/adstransparency\.google\.com\/advertiser\/AR\d+\/creative\/CR\d+[^)\s]*/g) || []))];

// The advertiser name sits on the line under each creative thumbnail, followed by
// the verification badge. Taking the most frequent one avoids picking up a
// neighbouring account when a domain hosts several.
function advertiserName(md) {
  const names = [...md.matchAll(/\n\s*([^\n[\]()]{2,40})\s*\n\s*\n\s*Verified\s*\n/g)].map(m => m[1].trim());
  if (!names.length) return null;
  const tally = {};
  for (const n of names) tally[n] = (tally[n] || 0) + 1;
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const md = '\nAds In South Korea\n\n32 ads\n\n[![Image 1](https://tpc.googlesyndication.com/archive/simgad/123)](https://adstransparency.google.com/advertiser/AR13216553679139635201/creative/CR999?region=KR)\n\n포레나의원\n\nVerified\n';
    console.log('SelfTest');
    console.log('  count=' + adCount(md));
    console.log('  advertiser=' + advertiserIds(md)[0]);
    console.log('  name=' + advertiserName(md));
    console.log('  creatives=' + creatives(md).length);
    const pass = adCount(md) === 32 && advertiserIds(md).length === 1 && advertiserName(md) === '포레나의원' && creatives(md).length === 1;
    console.log('SelfTestPassed=' + pass);
    return;
  }

  const results = [];
  for (const c of CLINICS) {
    if (!c.domain) {
      results.push({ ...c, status: 'NOT COLLECTED - domain unresolved' });
      console.log(`  ${c.name}: domain unresolved, skipped`);
      continue;
    }
    const dom = await jina(atcDomain(c.domain), `dom__${c.domain}`);
    if (dom.error || dom.unrendered) {
      results.push({ ...c, status: 'NOT COLLECTED - ' + (dom.error ? 'fetch error' : 'unrendered') });
      console.log(`  ${c.name} (${c.domain}): NOT COLLECTED`);
      await sleep(SLEEP_MS);
      continue;
    }
    const ids = advertiserIds(dom.body);
    const entry = {
      ...c,
      status: 'collected',
      atcDomainUrl: atcDomain(c.domain),
      totalAds: adCount(dom.body),
      // Whether the clinic buys under its own name or through an agency is itself
      // part of the answer, so the account is recorded even though its counts are
      // not used for the clinic's totals.
      accounts: ids.map(id => ({ advertiserId: id, atcUrl: atcAdv(id) })),
      accountName: advertiserName(dom.body),
      formats: {}
    };
    // Search text ads are out of scope; only display formats are collected.
    for (const fmt of ['IMAGE', 'VIDEO']) {
      const r = await jina(atcDomain(c.domain, fmt), `dom__${c.domain}__${fmt}`);
      if (r.error || r.unrendered) entry.formats[fmt] = { status: 'NOT COLLECTED' };
      else entry.formats[fmt] = {
        status: 'collected',
        ads: adCount(r.body),
        url: atcDomain(c.domain, fmt),
        creativeImages: creatives(r.body).slice(0, 12),
        creativePages: creativePages(r.body).slice(0, 12)
      };
      if (!r.cached) await sleep(SLEEP_MS);
    }
    entry.gdnAds = (entry.formats.IMAGE?.ads || 0) + (entry.formats.VIDEO?.ads || 0);
    results.push(entry);
    console.log(`  ${c.name} (${c.domain}): total ${entry.totalAds} · GDN ${entry.gdnAds} · 계정 ${entry.accountName || '?'}`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    method: 'Google Ads Transparency Center, region KR, read through Jina Reader; per-advertiser format filter separates display (IMAGE/VIDEO = GDN) from search text ads (TEXT)',
    limitation: 'Prices in display ads are drawn inside the banner image, so a price cannot be read from the page text. Creatives are mirrored for visual confirmation instead of being asserted.',
    region: REGION,
    clinics: results
  }, null, 2), 'utf8');

  const withGdn = results.filter(r => r.gdnAds > 0);
  console.log(`\nGDN 운영 확인: ${withGdn.length} / ${results.filter(r => r.status === 'collected').length} 수집 성공`);
  console.log(`written: ${OUT}`);
}

main();
