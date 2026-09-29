#!/usr/bin/env node
// 루트 index.html = 보고서 회차 목록. r/<yyyy-mm-dd>/index.html 을 모두 읽어 최신순으로 나열한다.
//   node scripts/build-report-index.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isoWeek = (d) => { const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const y = t.getUTCFullYear(); const w1 = new Date(Date.UTC(y, 0, 4)); return `${y}-W${String(1 + Math.round(((t - w1) / 86400000 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`; };

const items = readdirSync(join(ROOT, 'r'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && existsSync(join(ROOT, 'r', e.name, 'index.html')))
  .map((e) => {
    const h = readFileSync(join(ROOT, 'r', e.name, 'index.html'), 'utf8');
    const title = (h.match(/<title>([^<]*)<\/title>/) || [])[1] || '보고서';
    // 부제: 페이지의 meta description 우선, 없으면 원자료(data.json)의 집계 기간.
    let sub = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    if (!sub && existsSync(join(ROOT, 'r', e.name, 'data.json'))) {
      try { const d = JSON.parse(readFileSync(join(ROOT, 'r', e.name, 'data.json'), 'utf8')); const r = d.ga4?.range || d.range; if (r?.start) sub = `집계 기간 ${r.start} ~ ${r.end}${r.days ? ` (${r.days}일)` : ''}`; } catch { /* 부제 없이 표시 */ }
    }
    return { date: e.name, title, sub, data: existsSync(join(ROOT, 'r', e.name, 'data.json')) };
  })
  .sort((a, b) => b.date.localeCompare(a.date));

const rows = items.map((x, i) => `<a class="row${i === 0 ? ' latest' : ''}" href="r/${x.date}/"><div><div class="t">${esc(x.title)}${i === 0 ? ' <span class="new">최신</span>' : ''}</div><div class="s">${esc(x.sub)}</div></div><div class="d">${x.date}<small>${isoWeek(x.date)}</small></div></a>`).join('');

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>뷰티블라썸 성과보고서 목록</title><meta name="robots" content="noindex">
<style>
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--ring:rgba(11,11,11,.10);--acc:#2a78d6}
@media (prefers-color-scheme:dark){:root{--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--ring:rgba(255,255,255,.10);--acc:#3987e5}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;font-size:14px;line-height:1.6}
.wrap{max-width:760px;margin:0 auto;padding:40px 20px 80px}h1{font-size:24px;margin:0}.lead{color:var(--ink2);margin:4px 0 24px}
.row{display:flex;justify-content:space-between;gap:16px;align-items:center;background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 18px;margin:10px 0;text-decoration:none;color:inherit}
.row:hover{border-color:var(--acc)}.row.latest{border-width:2px;border-color:var(--acc)}.t{font-weight:650}.s{font-size:12px;color:var(--ink2)}
.d{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.d small{display:block;font-size:11px;color:var(--muted)}
.new{font-size:11px;font-weight:600;color:var(--acc);border:1px solid var(--acc);border-radius:999px;padding:0 7px;margin-left:6px}
footer{margin-top:28px;font-size:12px;color:var(--muted)}
</style></head><body><div class="wrap">
<h1>뷰티블라썸 성과보고서</h1><p class="lead">발행일마다 별도 주소로 보관합니다. 지난 회차는 수정하지 않습니다.</p>
${rows}
<footer>각 회차 폴더에 원자료 data.json 이 함께 있습니다. 총 ${items.length}개 회차.</footer>
</div></body></html>`;
writeFileSync(join(ROOT, 'index.html'), html, 'utf8');
console.log(`WROTE index.html  회차 ${items.length}개: ${items.map((x) => x.date).join(', ')}`);
