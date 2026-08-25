// Scans search results for treatment keywords we do NOT currently rank for.
//
// Search Console only reports queries our own pages already appear on, so it can
// never show a keyword we are absent from - exactly the keywords worth taking.
// This reads the actual result page for each candidate and records who holds it.
//
// Google blocks automated reads, so this uses DuckDuckGo's HTML endpoint, which
// honours a region parameter and returns localised results. Read over Jina so
// nothing runs on the user's machine.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'serp');
const OUT = join(ROOT, 'data', 'serp-2026-09.json');

// Treatments confirmed against the clinic's own menu, weighted towards the ones
// competitors advertise hardest.
const TREATMENTS = [
  { ko: '리쥬란', en: 'rejuran', ja: 'リジュラン', zh: '麗珠蘭' },
  { ko: '써마지', en: 'thermage', ja: 'サーマクール', zh: '鳳凰電波' },
  { ko: '울쎄라', en: 'ultherapy', ja: 'ウルセラ', zh: '音波拉皮' },
  { ko: '온다', en: 'onda lifting', ja: 'オンダリフト', zh: 'ONDA' },
  { ko: '포텐자', en: 'potenza', ja: 'ポテンツァ', zh: '波坦莎' },
  { ko: '쥬베룩', en: 'juvelook', ja: 'ジュベルック', zh: 'Juvelook' },
  { ko: '슈링크', en: 'shurink', ja: 'シュリンク', zh: '海芙音波' },
  { ko: '스컬트라', en: 'sculptra', ja: 'スカルプトラ', zh: '舒顏萃' },
  { ko: '피코슈어', en: 'picosure', ja: 'ピコシュア', zh: '皮秒雷射' },
  { ko: 'LDM', en: 'ldm treatment', ja: 'LDM', zh: 'LDM' },
  { ko: '인모드', en: 'inmode', ja: 'インモード', zh: 'InMode' },
  { ko: '볼뉴머', en: 'volnewmer', ja: 'ボルニューマ', zh: 'Volnewmer' }
];

// One pattern per market, using the phrasing that market actually searches in.
const MARKETS = [
  { key: 'JP', region: 'jp-jp', label: '일본', q: (t) => `韓国 ${t.ja} クリニック` },
  { key: 'TW', region: 'tw-tzh', label: '대만', q: (t) => `韓國 ${t.zh} 診所` },
  { key: 'EN', region: 'wt-wt', label: '영어권', q: (t) => `${t.en} seoul clinic` }
];

const SLEEP_MS = 2500;
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const key = (m, q) => join(CACHE, `${m}__${q.replace(/[^\p{L}\p{N}]+/gu, '_')}.md`);

async function fetchSerp(market, query) {
  const k = key(market.key, query);
  if (existsSync(k)) return { body: readFileSync(k, 'utf8'), cached: true };
  const url = 'https://r.jina.ai/' +
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${market.region}`;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'x-timeout': '25', accept: 'text/plain' },
        signal: AbortSignal.timeout(120000)
      });
      const body = await res.text();
      if (body.includes('duckduckgo.com/l/?uddg=')) {
        mkdirSync(dirname(k), { recursive: true });
        writeFileSync(k, body, 'utf8');
        return { body, cached: false };
      }
    } catch { /* retry */ }
    await sleep(4000 * i);
  }
  return { body: '', cached: false, failed: true };
}

// DuckDuckGo wraps every result in a redirect; the real URL is the uddg param.
function parseResults(md) {
  const out = [];
  const seen = new Set();
  for (const m of md.matchAll(/https:\/\/duckduckgo\.com\/l\/\?uddg=([^)&\s]+)/g)) {
    let url;
    try { url = decodeURIComponent(m[1]); } catch { continue; }
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ rank: out.length + 1, host, url });
    if (out.length >= 12) break;
  }
  return out;
}

// Who holds the result: us, a clinic we benchmark, some other Korean clinic, or a
// media/affiliate page. The last case changes the play entirely - you cannot
// outrank a review site by publishing another clinic page.
const SELF = /beautyblossom/i;
const RIVALS = /(kleam|pria|cleor|oceanclinic|shinebeam|selena|primiclinic|enprimiclinic)/i;
const KR_CLINIC = /\.kr$|\.co\.kr$|clinic|clinique|derma/i;
const AGGREGATOR = /(konest|koreaddicted|kr-life|jennie-log|minfor|kanbinavi|gangnamunni|babitalk|creatrip|trazy|klook|kkday|medicaltravelkorea|jivaka|seoulguidemedical|naver|tistory|blogspot|wordpress|reddit|quora|youtube|instagram|facebook|tiktok|pinterest|xiaohongshu|ptt|dcard|ameblo|note\.com|lipscosme|cosme|yahoo)/i;

function classify(host) {
  if (SELF.test(host)) return 'self';
  if (RIVALS.test(host)) return 'rival';
  if (AGGREGATOR.test(host)) return 'media';
  if (KR_CLINIC.test(host)) return 'korean-clinic';
  return 'other';
}

async function main() {
  if (process.argv.includes('--self-test')) {
    console.log('queries:', TREATMENTS.length * MARKETS.length);
    console.log('cache  :', CACHE);
    console.log('out    :', OUT);
    return;
  }

  const rows = [];
  for (const m of MARKETS) {
    for (const t of TREATMENTS) {
      const q = m.q(t);
      const r = await fetchSerp(m, q);
      const results = parseResults(r.body).map(x => ({ ...x, kind: classify(x.host) }));
      const holders = results.map(x => x.kind);
      rows.push({
        market: m.key, marketLabel: m.label, treatment: t.ko, query: q,
        failed: !!r.failed,
        results,
        weHold: results.find(x => x.kind === 'self')?.rank ?? null,
        rivalTop: results.find(x => x.kind === 'rival') ?? null,
        clinicTop: results.find(x => x.kind === 'korean-clinic') ?? null,
        mediaCount: holders.filter(k => k === 'media').length,
        clinicCount: holders.filter(k => k === 'korean-clinic' || k === 'rival').length
      });
      console.log(`${m.key} "${q}" -> ${r.failed ? 'FAILED' : results.length + '건'}` +
        `${r.cached ? ' [cached]' : ''}` +
        (results.find(x => x.kind === 'self') ? ' · 우리 있음' : ''));
      if (!r.cached) await sleep(SLEEP_MS);
    }
  }

  const payload = {
    generated_at_utc: new Date().toISOString(),
    source: 'DuckDuckGo 지역별 검색 결과를 Jina Reader로 조회했습니다. 브라우저나 로그인 없이 HTTP만 사용합니다.',
    note: '검색 결과는 조회 시점·지역·개인화에 따라 달라질 수 있습니다. 순위는 절대값이 아니라 ' +
      '"누가 이 키워드를 쥐고 있는가"를 보는 용도로만 쓰십시오.',
    markets: MARKETS.map(m => ({ key: m.key, label: m.label, region: m.region })),
    totals: {
      queries: rows.length,
      failed: rows.filter(r => r.failed).length,
      weHoldAny: rows.filter(r => r.weHold != null).length
    },
    rows
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('\nWROTE', OUT, '| 조회', rows.length, '| 우리 노출', payload.totals.weHoldAny, '| 실패', payload.totals.failed);
}

main().catch(e => { console.error(e); process.exit(1); });
