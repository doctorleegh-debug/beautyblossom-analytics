// Scrapes the Naver Search Advisor "content exposure/click" console for each site:
// headline totals, the search-keyword TOP 30 table and the web-document TOP 30 table.
//
// Naver publishes no performance API, so this reads the logged-in console. It attaches
// over CDP to the long-lived session browser (scripts/naver-session.mjs) whose window
// sits off-screen, so nothing appears on the user's monitor and no mouse is used.
//
// Replaces the earlier UIAutomation scrape: the console is a Vuetify SPA, so the tables
// and the pager are plain DOM, which removes the whole class of stale-element and
// unclickable-pager failures that limited the old version to page 1.
//
// Headline totals are abbreviated on screen (1.9천); the table rows are exact.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach, hide, isLoggedIn } from './naver-session.mjs';

const SITES = [
  { url: 'https://beautyblossom.kr',       label: 'KR' },
  { url: 'https://cn.beautyblossom.kr',    label: 'CN' },
  { url: 'https://en.beautyblossom.kr',    label: 'EN' },
  { url: 'https://jp.beautyblossom.kr',    label: 'JP' },
  { url: 'https://tw.beautyblossom.kr',    label: 'TW' },
  { url: 'https://www.beautyblossomth.kr', label: 'TH' }
];
const NOTE = '헤드라인 합계는 네이버가 화면에 축약 표기한 값이라 근사치입니다. 키워드·웹문서 표의 수치는 원값입니다.';
const MAX_PAGES = Number(process.env.BB_NAVER_PAGES || 3);

const argOut = process.argv.find(a => a.startsWith('--out='));
const OUT = argOut ? argOut.slice(6) : join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'naver-latest.json');
const argOnly = process.argv.find(a => a.startsWith('--only='));
const ONLY = argOnly ? argOnly.slice(7).split(',').map(s => s.trim().toUpperCase()) : null;
const sites = ONLY ? SITES.filter(s => ONLY.includes(s.label)) : SITES;

// Reads one rendered page of a table. Returned as raw strings; parsing stays in Node.
const READ_TABLES = `(() => {
  const tbs = [...document.querySelectorAll('table')];
  return tbs.map(tb => ({
    head: [...tb.querySelectorAll('thead th')].map(h => h.innerText.trim()),
    rows: [...tb.querySelectorAll('tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))
  }));
})()`;

const READ_HEADLINE = `(() => {
  const lines = (document.body.innerText || '').split('\\n').map(s => s.trim());
  const after = (label, skip) => {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== label) continue;
      let seen = 0;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        if (!lines[j]) continue;
        if (seen === skip) return lines[j];
        seen++;
      }
    }
    return null;
  };
  const updated = lines.find(l => l.indexOf('최근 업데이트') === 0) || null;
  return {
    clicks_raw: after('최근 총 클릭', 0), clicks_delta: after('최근 총 클릭', 2),
    impressions_raw: after('최근 총 노출', 0), impressions_delta: after('최근 총 노출', 2),
    ctr_raw: after('평균 CTR', 0), ctr_delta: after('평균 CTR', 2),
    period: lines.indexOf('최근 30일') >= 0 ? '최근 30일' : '',
    updated
  };
})()`;

// Click page N of the pager that belongs to table `idx`. Vuetify labels each
// page button, so the target is unambiguous without geometry.
const gotoPage = (idx, page) => `(() => {
  const pagers = [...document.querySelectorAll('ul.v-pagination')];
  const p = pagers[${idx}];
  if (!p) return 'no-pager';
  const btn = [...p.querySelectorAll('button.v-pagination__item')]
    .find(b => b.innerText.trim() === '${page}');
  if (!btn) return 'no-page';
  if (btn.getAttribute('aria-current') === 'true') return 'already';
  btn.click();
  return 'clicked';
})()`;

const firstCellOf = (idx) => `(() => {
  const tb = document.querySelectorAll('table')[${idx}];
  if (!tb) return '';
  const tr = tb.querySelector('tbody tr');
  return tr ? [...tr.querySelectorAll('td')].map(td => td.innerText.trim()).join('|') : '';
})()`;

const num = (s) => Number(String(s == null ? '' : s).replace(/[, ]/g, ''));

function parseAbbrev(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/,/g, '');
  let m;
  if ((m = t.match(/^-?([\d.]+)\s*억/))) return parseFloat(m[1]) * 1e8;
  if ((m = t.match(/^-?([\d.]+)\s*만/))) return parseFloat(m[1]) * 1e4;
  if ((m = t.match(/^-?([\d.]+)\s*천/))) return parseFloat(m[1]) * 1e3;
  if ((m = t.match(/^-?([\d.]+)\s*백/))) return parseFloat(m[1]) * 1e2;
  if ((m = t.match(/^(-?[\d.]+)\s*%$/))) return parseFloat(m[1]);
  if (/^-?[\d.]+$/.test(t)) return parseFloat(t);
  return null;
}

// Rows arrive as [No, label, clicks, impressions, ctr].
function toRows(page, startRank) {
  const out = [];
  for (const cells of page) {
    if (cells.length < 5) continue;
    const rank = parseInt(cells[0], 10);
    if (!Number.isFinite(rank)) continue;
    out.push({
      rank,
      label: cells[1],
      clicks: num(cells[2]),
      impressions: num(cells[3]),
      ctr: num(cells[4])
    });
  }
  return out;
}

async function collectTable(sess, idx, maxPages) {
  const acc = new Map();
  for (let p = 1; p <= maxPages; p++) {
    if (p > 1) {
      const before = await sess.evaluate(firstCellOf(idx));
      const r = await sess.evaluate(gotoPage(idx, p));
      if (r === 'no-page' || r === 'no-pager') break;
      if (r === 'clicked') {
        // Wait for the grid to actually swap rather than sleeping a fixed amount.
        const changed = await sess.waitFor(
          `(() => { const tb = document.querySelectorAll('table')[${idx}];
             if (!tb) return false;
             const tr = tb.querySelector('tbody tr');
             const cur = tr ? [...tr.querySelectorAll('td')].map(td => td.innerText.trim()).join('|') : '';
             return cur && cur !== ${JSON.stringify(before)}; })()`,
          { timeoutMs: 15000, intervalMs: 400 });
        if (!changed) break;
      }
    }
    const tables = await sess.evaluate(READ_TABLES);
    if (!tables[idx]) break;
    const rows = toRows(tables[idx].rows, (p - 1) * 10 + 1);
    if (!rows.length) break;
    let added = 0;
    for (const r of rows) if (!acc.has(r.rank)) { acc.set(r.rank, r); added++; }
    if (!added) break;
  }
  return [...acc.values()].sort((a, b) => a.rank - b.rank);
}

const out = {
  generated_at_utc: new Date().toISOString(),
  source: 'Naver Search Advisor console (CDP/DOM, off-screen session browser)',
  note: NOTE,
  sites: []
};

let sess;
let loginDead = false;
try {
  sess = await attach();
  await hide(sess);

  for (const s of sites) {
    process.stdout.write(`-- ${s.label} ${s.url}\n`);
    const url = 'https://searchadvisor.naver.com/console/site/report/expose?site=' + encodeURIComponent(s.url);
    try {
      await sess.goto(url, { settleMs: 2500 });

      if (!(await isLoggedIn(sess))) {
        out.sites.push({ url: s.url, label: s.label, status: 'LOGIN_REQUIRED' });
        console.log('   LOGIN_REQUIRED');
        loginDead = true;
        continue;
      }

      const ready = await sess.waitFor(
        `document.body.innerText.indexOf('최근 총 클릭') >= 0 && document.querySelectorAll('table tbody tr').length > 0`,
        { timeoutMs: 60000 });
      if (!ready) {
        // Naver states this outright when a registered site simply has no exposure,
        // which is a real finding rather than a scrape failure.
        const empty = await sess.evaluate(
          `(document.body.innerText||'').indexOf('콘텐츠 노출/클릭 정보가 없습니다') >= 0`);
        const head = await sess.evaluate(
          `(document.body.innerText||'').split('\\n').filter(Boolean).slice(-6).join(' | ')`);
        out.sites.push({
          url: s.url, label: s.label,
          status: empty ? 'NO_EXPOSURE' : 'NO_DATA',
          reason: empty ? '네이버에 노출/클릭 데이터가 없습니다 (사이트는 등록됨).' : null,
          screen: head
        });
        console.log(empty ? '   NO_EXPOSURE  네이버 노출 데이터 없음' : '   NO_DATA');
        continue;
      }

      const h = await sess.evaluate(READ_HEADLINE);
      const keywords = await collectTable(sess, 0, MAX_PAGES);
      const documents = await collectTable(sess, 1, MAX_PAGES);

      out.sites.push({
        url: s.url, label: s.label, status: 'OK',
        period: h.period, updated: h.updated,
        clicks_raw: h.clicks_raw, clicks: parseAbbrev(h.clicks_raw), clicks_delta: h.clicks_delta,
        impressions_raw: h.impressions_raw, impressions: parseAbbrev(h.impressions_raw), impressions_delta: h.impressions_delta,
        ctr_raw: h.ctr_raw, ctr: parseAbbrev(h.ctr_raw), ctr_delta: h.ctr_delta,
        keywords, documents
      });
      console.log(`   clicks=${h.clicks_raw}  impressions=${h.impressions_raw}  keywords=${keywords.length}  docs=${documents.length}`);
    } catch (e) {
      out.sites.push({ url: s.url, label: s.label, status: 'PARTIAL', error: e.message });
      console.log('   PARTIAL ' + e.message);
    }
  }
} finally {
  sess?.close();
}

// Merge with whatever is already on disk: a failed scrape must not overwrite a site
// that previously produced rows, and a partial run (--only=) must not drop the sites
// it did not visit.
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8').replace(/^﻿/, ''));
    const prevBy = new Map((prev.sites || []).map(x => [x.label, x]));
    let kept = 0;
    const merged = out.sites.map(s => {
      const o = prevBy.get(s.label);
      prevBy.delete(s.label);
      if (!o) return s;
      const nk = (s.keywords || []).length, ok = (o.keywords || []).length;
      // NO_EXPOSURE is Naver's own answer, so it is a real result, not a failure.
      const failed = s.status !== 'OK' && s.status !== 'NO_EXPOSURE';
      if (failed && o.status === 'OK') { kept++; return o; }
      if (s.status === 'OK' && nk === 0 && ok > 0) { kept++; return o; }
      return s;
    });
    // Sites not visited this run keep their previous entry, in the original order.
    const order = SITES.map(x => x.label);
    out.sites = [...merged, ...prevBy.values()]
      .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
    const carried = prevBy.size;
    if (kept || carried) console.log(`기존 데이터 유지: 덮어쓰기 방지 ${kept}개 · 미수집 유지 ${carried}개`);
  } catch {}
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('SAVED=' + OUT);
if (loginDead) {
  console.log('LOGIN_REQUIRED=true  세션이 끊겼습니다: node scripts/naver-session.mjs start');
  process.exit(2);
}
