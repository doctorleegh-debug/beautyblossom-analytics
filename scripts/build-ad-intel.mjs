// Builds the Mapo-gu clinic advertising report.
//
// The question this answers is narrow: which clinics run ads that show BOTH the
// clinic's own name and a price. Everything else in the report exists to qualify
// that list - where those ads run, on which keywords, and what the creative says.
//
// Written outside the analytics repo on purpose: it carries mirrored competitor
// creatives, and nothing here decides on its own that those belong in a public
// GitHub Pages repo.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = join(ROOT, '..', 'reports', 'ad-intel-mapo');
const ASSETS = join(OUTDIR, 'assets');
const REPORT_DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '';

const meta = JSON.parse(readFileSync(join(ROOT, 'data', 'ads-overseas-mapo.json'), 'utf8'));
const gdnPath = join(ROOT, 'data', 'gdn-mapo.json');
const gdn = existsSync(gdnPath) ? JSON.parse(readFileSync(gdnPath, 'utf8')) : null;
const verdictPath = join(ROOT, 'data', 'gdn-creative-verdicts.json');
// Display-ad prices are drawn inside the banner, so they cannot be read from page
// text. Each mirrored creative is inspected by eye and the verdict recorded here;
// a creative with no entry is reported as unreviewed rather than as "no price".
const verdicts = existsSync(verdictPath) ? JSON.parse(readFileSync(verdictPath, 'utf8')) : {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Validated dark categorical palette (dataviz validator, --mode dark, all checks pass).
const CAT = ['#D4536F', '#3383CC', '#B08420', '#1BA073', '#A87BE0', '#CC6630'];

async function mirror(url, name) {
  const dst = join(ASSETS, name);
  if (existsSync(dst)) return `assets/${name}`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(45000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // A signed CDN link that has expired returns a short text body, not an image.
    if (buf.length < 2000 || !(buf[0] === 0xff || buf[0] === 0x89 || buf[0] === 0x47 || buf[0] === 0x52)) return null;
    mkdirSync(ASSETS, { recursive: true });
    writeFileSync(dst, buf);
    return `assets/${name}`;
  } catch { return null; }
}

// "₩249,000" / "30,000원" / "KRW 39,000" / "1,990,000 KRW" -> 249000 / 30000 / 39000
function toKrw(s) {
  const digits = (s.match(/[\d,]{3,}/) || [])[0];
  if (!digits) return null;
  const n = Number(digits.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 1000 ? n : null;
}
const won = (n) => '₩' + n.toLocaleString('ko-KR');

function advertiserRollup(ads) {
  const map = new Map();
  for (const ad of ads) {
    const key = ad.advertiser || '(광고주명 미표기)';
    if (!map.has(key)) map.set(key, {
      name: key, url: ad.advertiserUrl, ads: [], countries: new Set(),
      queries: new Set(), domains: new Set(), withPrice: 0, prices: new Set()
    });
    const e = map.get(key);
    e.ads.push(ad);
    for (const s of ad.seenIn || []) { e.countries.add(s.country); e.queries.add(s.query); }
    if (ad.landingDomain) e.domains.add(ad.landingDomain);
    if (ad.evidence?.disclosesPrice) {
      e.withPrice++;
      for (const p of ad.evidence.priceSamples || []) { const v = toKrw(p); if (v) e.prices.add(v); }
    }
    if (!e.url && ad.advertiserUrl) e.url = ad.advertiserUrl;
  }
  return [...map.values()].sort((a, b) => b.withPrice - a.withPrice || b.ads.length - a.ads.length);
}

// ---------- charts (inline SVG, no libraries) ----------

// Price ladder. A dot plot, not bars: these are separate quoted prices, not parts
// of a total, and the range spans three orders of magnitude so the axis is log.
function priceLadder(rows) {
  const W = 900, padL = 210, padR = 30, rowH = 42, padT = 34, padB = 44;
  const H = padT + rows.length * rowH + padB;
  const all = rows.flatMap(r => r.prices);
  if (!all.length) return '';
  const lo = Math.min(...all), hi = Math.max(...all);
  const l0 = Math.log10(lo * 0.75), l1 = Math.log10(hi * 1.35);
  const x = (v) => padL + (Math.log10(v) - l0) / (l1 - l0) * (W - padL - padR);
  const ticks = [10000, 50000, 100000, 500000, 1000000, 5000000, 10000000].filter(t => t >= lo * 0.75 && t <= hi * 1.35);

  const grid = ticks.map(t => `<line x1="${x(t).toFixed(1)}" y1="${padT - 10}" x2="${x(t).toFixed(1)}" y2="${H - padB}" class="grid"/>
<text x="${x(t).toFixed(1)}" y="${H - padB + 18}" class="ax" text-anchor="middle">${t >= 1000000 ? (t / 10000) + '만' : (t / 10000) + '만'}</text>`).join('');

  const body = rows.map((r, i) => {
    const y = padT + i * rowH + rowH / 2;
    const xs = r.prices.map(x);
    const line = xs.length > 1
      ? `<line x1="${Math.min(...xs).toFixed(1)}" y1="${y}" x2="${Math.max(...xs).toFixed(1)}" y2="${y}" class="conn"/>` : '';
    const dots = r.prices.map(v => `<g class="dot"><circle cx="${x(v).toFixed(1)}" cy="${y}" r="6.5" fill="${r.color}" stroke="var(--panel)" stroke-width="2"><title>${esc(r.name)} · ${won(v)}</title></circle></g>`).join('');
    const minV = Math.min(...r.prices), maxV = Math.max(...r.prices);
    return `${line}${dots}
<text x="${padL - 14}" y="${y + 4}" class="lbl" text-anchor="end">${esc(r.short)}</text>
<text x="${(x(maxV) + 14).toFixed(1)}" y="${y + 4}" class="val">${won(maxV)}</text>
${r.prices.length > 1 ? `<text x="${(x(minV) - 14).toFixed(1)}" y="${y + 4}" class="val" text-anchor="end">${won(minV)}</text>` : ''}`;
  }).join('');

  return `<figure class="fig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="병원별 광고 노출 금액 분포">
<text x="${padL}" y="16" class="axt">광고에 표기된 금액 (로그 축)</text>${grid}${body}</svg></figure>`;
}

// Country distribution. Magnitude of one measure across one dimension -> bars,
// one hue, sorted by value.
function countryBars(pairs) {
  const W = 900, padL = 56, padR = 64, barH = 26, gap = 9, padT = 26, padB = 12;
  const H = padT + pairs.length * (barH + gap) + padB;
  const max = Math.max(...pairs.map(p => p[1]));
  const body = pairs.map(([c, n], i) => {
    const y = padT + i * (barH + gap);
    const w = Math.max(3, (n / max) * (W - padL - padR));
    return `<g class="bar"><rect x="${padL}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${CAT[1]}"><title>${esc(c)} · 광고 ${n}건</title></rect>
<text x="${padL - 12}" y="${y + barH / 2 + 4}" class="lbl" text-anchor="end">${esc(c)}</text>
<text x="${(padL + w + 10).toFixed(1)}" y="${y + barH / 2 + 4}" class="val">${n}</text></g>`;
  }).join('');
  return `<figure class="fig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="국가별 광고 건수">
<text x="${padL}" y="14" class="axt">국가별 관측 광고 수 (건)</text>${body}</svg></figure>`;
}

// Clinic x country presence. A matrix of counts -> heatmap on one sequential hue.
function matrix(rowsIn, cols) {
  const cellW = 46, cellH = 32, padL = 210, padT = 44, padR = 16, padB = 10;
  const W = padL + cols.length * cellW + padR;
  const H = padT + rowsIn.length * cellH + padB;
  const max = Math.max(1, ...rowsIn.flatMap(r => cols.map(c => r.counts[c] || 0)));
  const head = cols.map((c, j) =>
    `<text x="${padL + j * cellW + cellW / 2}" y="${padT - 14}" class="ax" text-anchor="middle">${esc(c)}</text>`).join('');
  const body = rowsIn.map((r, i) => {
    const y = padT + i * cellH;
    const cells = cols.map((c, j) => {
      const v = r.counts[c] || 0;
      const t = v / max;
      const fill = v ? `rgba(51,131,204,${(0.16 + t * 0.74).toFixed(2)})` : 'transparent';
      return `<g class="cell"><rect x="${padL + j * cellW + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="3" fill="${fill}" stroke="var(--line)" stroke-width="1"><title>${esc(r.short)} · ${esc(c)} · ${v}건</title></rect>
${v ? `<text x="${padL + j * cellW + cellW / 2}" y="${y + cellH / 2 + 4}" class="cellv" text-anchor="middle">${v}</text>` : ''}</g>`;
    }).join('');
    return `<text x="${padL - 14}" y="${y + cellH / 2 + 4}" class="lbl" text-anchor="end">${esc(r.short)}</text>${cells}`;
  }).join('');
  return `<figure class="fig scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="병원별 광고 노출 국가 매트릭스">
<text x="${padL}" y="16" class="axt">병원 × 노출 국가 (셀 = 관측 광고 수)</text>${head}${body}</svg></figure>`;
}

function keywordBars(rows) {
  const W = 900, padL = 250, padR = 64, barH = 24, gap = 8, padT = 26, padB = 12;
  const H = padT + rows.length * (barH + gap) + padB;
  const max = Math.max(...rows.map(r => r.n));
  const body = rows.map((r, i) => {
    const y = padT + i * (barH + gap);
    const w = Math.max(3, (r.n / max) * (W - padL - padR));
    return `<g class="bar"><rect x="${padL}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${CAT[3]}"><title>${esc(r.q)} · ${esc(r.countries)} · ${r.n}건</title></rect>
<text x="${padL - 12}" y="${y + barH / 2 + 4}" class="lbl" text-anchor="end">${esc(r.q)}</text>
<text x="${(padL + w + 10).toFixed(1)}" y="${y + barH / 2 + 4}" class="val">${r.n}</text></g>`;
  }).join('');
  return `<figure class="fig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="키워드별 광고 건수">
<text x="${padL}" y="14" class="axt">키워드별 관측 광고 수 (건)</text>${body}</svg></figure>`;
}

const CSS = `
:root{
--ground:#121012;--panel:#1A1A19;--sunk:#221F23;--ink:#F2EDEF;--muted:#A79DA4;
--line:#332E33;--accent:#E4879E;
--crit:#E8737F;--warn:#D9A441;--ok:#4FBF92;--info:#6BA8DC;--gap:#6E656C}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--ground);color:var(--ink);
font-family:'Gothic A1','Malgun Gothic',sans-serif;font-size:15px;line-height:1.7}
.wrap{max-width:1000px;margin:0 auto;padding:34px 20px 90px}
h1{font-size:27px;font-weight:800;margin:0 0 8px;letter-spacing:-.02em}
h2{font-size:20px;font-weight:700;margin:52px 0 14px;padding-bottom:9px;border-bottom:1px solid var(--line)}
h2 .k{color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:14px;margin-right:9px}
h3{font-size:16px;font-weight:700;margin:28px 0 10px}
.date{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);
background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:3px 9px;display:inline-block}
.note{color:var(--muted);font-size:13.5px;margin:10px 0}
.lead{font-size:16px;margin:14px 0 4px}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px;margin:22px 0 8px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:15px 17px}
.stat .n{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;
font-size:28px;font-weight:700;line-height:1.1}
.stat .l{font-size:12.5px;color:var(--muted);margin-top:5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:16px 18px;margin:12px 0}
.card.hero{border-color:#4a2b33;background:linear-gradient(180deg,#241a1e 0%,var(--panel) 60%)}
table{width:100%;border-collapse:collapse;background:var(--panel);
border:1px solid var(--line);border-radius:9px;overflow:hidden;font-size:14px}
th{background:var(--sunk);text-align:left;padding:10px 12px;font-weight:700;font-size:12.5px;
color:var(--muted);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.num{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tag{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:99px;
border:1px solid var(--line);background:var(--sunk);color:var(--muted);margin:0 3px 3px 0;white-space:nowrap}
.tag.price{border-color:#7a3a44;color:var(--crit);background:#2a1b1f}
.tag.own{border-color:#5b3a45;color:var(--accent);background:#241a1e}
.tag.gdn{border-color:#2f4a63;color:var(--info);background:#18222b}
.tag.ok{border-color:#245c46;color:var(--ok);background:#152520}
.tag.warn{border-color:#5e4a1e;color:var(--warn);background:#241f14}
a{color:var(--info)}a:hover{color:var(--accent)}
.copy{background:var(--sunk);border-left:3px solid var(--line);padding:10px 13px;
margin:9px 0;font-size:13.5px;white-space:pre-wrap;word-break:break-word;border-radius:0 5px 5px 0;color:#DCD5D9}
.cr{display:flex;flex-wrap:wrap;gap:9px;margin:11px 0}
.cr img{width:158px;height:158px;object-fit:cover;border:1px solid var(--line);border-radius:7px;background:var(--sunk)}
.cr.tall img{width:190px;height:auto;max-height:420px;object-fit:contain}
.miss{border-left:3px solid var(--warn)}
.scroll{overflow-x:auto}
.fig{margin:16px 0;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 12px}
.fig svg{width:100%;height:auto;display:block}
.grid{stroke:var(--line);stroke-width:1}
.conn{stroke:var(--line);stroke-width:2}
.ax{fill:var(--muted);font-size:11px;font-family:'JetBrains Mono',monospace}
.axt{fill:var(--muted);font-size:11.5px}
.lbl{fill:var(--ink);font-size:12.5px}
.val{fill:var(--muted);font-size:11.5px;font-family:'JetBrains Mono',monospace}
.cellv{fill:#EAF2FA;font-size:11.5px;font-family:'JetBrains Mono',monospace}
.dot circle,.bar rect,.cell rect{transition:opacity .12s}
.dot:hover circle,.bar:hover rect,.cell:hover rect{opacity:.75}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:6px 0 0;font-size:12.5px;color:var(--muted)}
.legend i{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:-1px}
details{margin:10px 0}summary{cursor:pointer;color:var(--muted);font-size:13px}
`;

function adBlock(ad, creativeMap) {
  const ev = ad.evidence || {};
  const tags = [
    ev.disclosesPrice ? `<span class="tag price">금액 ${esc((ev.priceSamples || []).slice(0, 4).join(' · '))}</span>` : '',
    ...(ev.mapoTokens || []).slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`),
    ...[...new Set((ad.seenIn || []).map(s => s.country))].map(c => `<span class="tag gdn">${esc(c)}</span>`),
    ad.startedRunning ? `<span class="tag">${esc(ad.startedRunning)} 시작</span>` : ''
  ].join('');
  const imgs = (ad.creativeUrls || []).slice(0, 3)
    .map(u => creativeMap.get(u)).filter(Boolean)
    .map(p => `<a href="${esc(p)}" target="_blank"><img src="${esc(p)}" alt="광고 소재" loading="lazy"></a>`).join('');
  return `<div class="card">
    <div><strong>${esc(ad.advertiser || '(광고주명 미표기)')}</strong>
      ${ad.advertiserUrl ? ` · <a href="${esc(ad.advertiserUrl)}" target="_blank">페이지</a>` : ''}
      ${ad.adLibraryUrl ? ` · <a href="${esc(ad.adLibraryUrl)}" target="_blank">광고 원문</a>` : ''}
      ${ad.landingUrl ? ` · <a href="${esc(ad.landingUrl)}" target="_blank">랜딩</a>` : ''}</div>
    <div style="margin-top:7px">${tags}</div>
    ${ad.copy ? `<div class="copy">${esc(ad.copy.slice(0, 640))}${ad.copy.length > 640 ? ' …' : ''}</div>` : ''}
    ${imgs ? `<div class="cr">${imgs}</div>` : ''}
  </div>`;
}

async function main() {
  mkdirSync(OUTDIR, { recursive: true });

  const ads = meta.ads || [];
  const advs = advertiserRollup(ads);
  const priced = advs.filter(a => a.withPrice > 0);
  const pricedAds = ads.filter(a => a.evidence?.disclosesPrice && a.advertiser);

  // Country presence, measured only across the countries actually queried.
  const countryCount = {};
  for (const ad of ads) for (const s of new Set((ad.seenIn || []).map(x => x.country))) countryCount[s] = (countryCount[s] || 0) + 1;
  const countryPairs = Object.entries(countryCount).sort((a, b) => b[1] - a[1]);
  const cols = countryPairs.map(p => p[0]);

  const kwMap = new Map();
  for (const ad of ads) for (const s of ad.seenIn || []) {
    if (!kwMap.has(s.query)) kwMap.set(s.query, { q: s.query, ids: new Set(), cs: new Set() });
    kwMap.get(s.query).ids.add(ad.libraryId); kwMap.get(s.query).cs.add(s.country);
  }
  const kwRows = [...kwMap.values()].map(k => ({ q: k.q, n: k.ids.size, countries: [...k.cs].join(' ') }))
    .sort((a, b) => b.n - a.n).slice(0, 14);

  const shorten = (n) => n.replace(/Beauty Skin Anti-aging Clinic in Korea/i, '').replace(/\s+/g, ' ').trim().slice(0, 26);
  const ladderRows = priced.map((a, i) => ({
    name: a.name, short: shorten(a.name), color: CAT[i % CAT.length], prices: [...a.prices].sort((x, y) => x - y)
  })).filter(r => r.prices.length);

  const matrixRows = advs.slice(0, 14).map(a => {
    const counts = {};
    for (const ad of a.ads) for (const c of new Set((ad.seenIn || []).map(s => s.country))) counts[c] = (counts[c] || 0) + 1;
    return { short: shorten(a.name), counts };
  });

  // Mirror Meta creatives for the ads shown.
  const creativeMap = new Map();
  let i = 0;
  for (const ad of [...pricedAds, ...ads].slice(0, 70)) {
    for (const u of (ad.creativeUrls || []).slice(0, 3)) {
      if (creativeMap.has(u)) continue;
      const p = await mirror(u, `meta-${ad.libraryId}-${i++}.jpg`);
      if (p) creativeMap.set(u, p);
    }
  }

  // Google display side.
  const gdnClinics = gdn ? (gdn.clinics || []).filter(c => c.status === 'collected') : [];
  const gdnMap = new Map();
  let g = 0;
  for (const c of gdnClinics) {
    for (const fmt of ['IMAGE', 'VIDEO']) {
      for (const u of (c.formats?.[fmt]?.creativeImages || []).slice(0, 8)) {
        if (gdnMap.has(u)) continue;
        const p = await mirror(u, `gdn-${g++}.png`);
        if (p) gdnMap.set(u, p);
      }
    }
  }
  const gdnMissing = gdn ? (gdn.clinics || []).filter(c => c.status !== 'collected') : [];
  const notCollected = (meta.coverage || []).filter(c => c.status !== 'ok' && c.status !== 'empty');

  const legend = (rows) => `<div class="legend">${rows.map(r =>
    `<span><i style="background:${r.color}"></i>${esc(r.short)}</span>`).join('')}</div>`;

  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>마포구 병원 광고 인텔</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gothic+A1:wght@400;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="wrap">

<h1>마포구 병원 광고 인텔</h1>
<div class="date">보고일 ${esc(REPORT_DATE)}</div>
<p class="lead">마포구(홍대·합정·동교·서교) 소재 피부과·성형외과가 해외 환자 유치를 위해 집행 중인 광고 가운데,
<strong>병원명과 금액을 함께 노출한 광고</strong>를 추린 보고입니다.</p>
<p class="note">Meta 광고 라이브러리와 Google 광고 투명성 센터의 <strong>활성 광고</strong>만 대상입니다.
Google은 검색광고(SA)를 제외하고 디스플레이(GDN·이미지/영상)만 집계했습니다.</p>

<div class="strip">
  <div class="stat"><div class="n" style="color:var(--crit)">${priced.length}</div><div class="l">병원명+금액 노출 병원</div></div>
  <div class="stat"><div class="n" style="color:var(--crit)">${pricedAds.length}</div><div class="l">해당 광고 건수</div></div>
  <div class="stat"><div class="n">${advs.length}</div><div class="l">전체 광고주</div></div>
  <div class="stat"><div class="n">${ads.length}</div><div class="l">마포·홍대 언급 광고</div></div>
  <div class="stat"><div class="n">${cols.length}</div><div class="l">노출 확인 국가</div></div>
  <div class="stat"><div class="n">${kwMap.size}</div><div class="l">적중 키워드</div></div>
</div>

<h2><span class="k">01</span>병원명과 금액을 함께 노출한 병원</h2>
<p class="note">광고 본문에 병원명이 표기되고 금액이 함께 적힌 경우입니다. 금액은 전부 원화 표기이며, 노출 시장 통화로 환산하지 않았습니다.</p>
<div class="scroll"><table><thead><tr>
<th>병원 (광고 표기명)</th><th class="num">금액노출 광고</th><th>표기 금액대</th><th>노출 국가</th></tr></thead><tbody>
${priced.map(a => {
    const ps = [...a.prices].sort((x, y) => x - y);
    return `<tr><td><strong>${a.url ? `<a href="${esc(a.url)}" target="_blank">${esc(a.name)}</a>` : esc(a.name)}</strong></td>
<td class="num" style="color:var(--crit);font-weight:700">${a.withPrice}</td>
<td class="num">${ps.length ? (ps.length > 1 ? `${won(ps[0])} ~ ${won(ps[ps.length - 1])}` : won(ps[0])) : '—'}</td>
<td>${[...a.countries].sort().map(c => `<span class="tag gdn">${esc(c)}</span>`).join('')}</td></tr>`;
  }).join('')}
</tbody></table></div>

${ladderRows.length ? `<h3>표기 금액 분포</h3>${priceLadder(ladderRows)}${legend(ladderRows)}
<p class="note">점 하나가 광고에 실제로 적힌 금액 하나입니다. 축은 로그 스케일입니다.</p>` : ''}

${pricedAds.map(a => adBlock(a, creativeMap)).join('')}

<h2><span class="k">02</span>어느 국가에 광고하고 있는가</h2>
<p class="note">아래 국가는 <strong>제가 조회한 범위 안에서</strong> 광고 노출이 확인된 시장입니다. 조회하지 않은 국가는 없다는 뜻이 아닙니다.</p>
${countryBars(countryPairs)}
<h3>병원 × 노출 국가</h3>
${matrix(matrixRows, cols)}

<h2><span class="k">03</span>어떤 키워드에 걸리는가</h2>
<p class="note">해외 환자가 실제로 입력할 만한 키워드로 검색해 광고가 노출된 결과입니다.</p>
${keywordBars(kwRows)}

<h2><span class="k">04</span>Google 디스플레이(GDN)</h2>
${gdn ? `<p class="note">검색광고(SA)는 제외했습니다. 건수는 <strong>도메인 기준</strong>으로 집계했습니다 —
여러 병원이 하나의 대행사 계정을 공유하는 경우가 있어, 계정 기준으로 세면 다른 병원 광고까지 그 병원 것으로 잡힙니다.</p>
<div class="scroll"><table><thead><tr>
<th>병원</th><th>주소 근거</th><th class="num">GDN</th><th>광고 계정</th><th>투명성 센터</th></tr></thead><tbody>
${gdnClinics.sort((a, b) => (b.gdnAds || 0) - (a.gdnAds || 0)).map(c => `<tr>
<td><strong>${esc(c.name)}</strong><br><span style="font-size:12px;color:var(--muted)">${esc(c.domain)}</span></td>
<td style="font-size:12.5px">${esc(c.addr || '')}</td>
<td class="num">${c.gdnAds ? `<span class="tag gdn">${c.gdnAds}</span>` : '0'}</td>
<td style="font-size:12.5px">${c.accountName
      ? (c.accountName.includes('의원') || c.accountName.includes('클리닉')
        ? `<span class="tag ok">병원 직접</span> ${esc(c.accountName)}`
        : `<span class="tag warn">대행사</span> ${esc(c.accountName)}`)
      : '—'}</td>
<td>${c.formats?.IMAGE?.url ? `<a href="${esc(c.formats.IMAGE.url)}" target="_blank">이미지 광고</a>` : '—'}</td></tr>`).join('')}
</tbody></table></div>
${gdnMissing.length ? `<div class="card miss"><strong>GDN 미수집</strong>
<p class="note">아래 항목은 조회하지 못했습니다. 측정된 0건이 아닙니다.</p>
<div>${gdnMissing.map(c => `<span class="tag">${esc(c.name)} — ${esc(c.status)}</span>`).join('')}</div></div>` : ''}

${gdnClinics.filter(c => c.gdnAds > 0).map(c => {
      const urls = ['IMAGE', 'VIDEO'].flatMap(f => (c.formats?.[f]?.creativeImages || []));
      const imgs = urls.map(u => gdnMap.get(u)).filter(Boolean);
      return `<h3>${esc(c.name)} — 디스플레이 소재</h3>
<div>${(verdicts[c.domain] || []).map(v => `<span class="tag ${v.price ? 'price' : ''}">${esc(v.label)}</span>`).join('')
        || '<span class="tag warn">소재 육안 판독 미완료</span>'}</div>
<div class="cr tall">${imgs.map(p => `<a href="${esc(p)}" target="_blank"><img src="${esc(p)}" alt="디스플레이 소재" loading="lazy"></a>`).join('') || '<span class="tag">소재 미러링 실패</span>'}</div>`;
    }).join('')}`
      : `<div class="card miss"><strong>수집 진행 중</strong>
<p class="note">Google 디스플레이 데이터는 아직 수집이 끝나지 않았습니다. 완료 후 갱신합니다.</p></div>`}

<h2><span class="k">05</span>수집 한계</h2>
<div class="card miss">
<p class="note"><strong>Meta의 키워드 검색 제한.</strong> Meta는 EU 외 국가에서 광고 <em>본문</em> 키워드 검색을
사회·정치 이슈 광고로만 제한합니다. 따라서 한국(KR) 대상 한국어 키워드는 구조적으로 결과가 거의 나오지 않으며,
이는 광고가 없다는 뜻이 아닙니다. 해외 시장 검색이 이 광고들을 관측할 수 있는 경로입니다.</p>
<p class="note"><strong>디스플레이 광고의 금액.</strong> GDN 배너는 금액이 이미지 안에 그려져 있어 페이지 텍스트로 판독되지 않습니다.
소재를 내려받아 육안으로 확인한 결과만 금액 노출로 표기했고, 확인하지 못한 소재는 <em>미판독</em>으로 남겼습니다.</p>
<p class="note"><strong>국가 범위.</strong> 노출 국가는 조회한 국가 목록 안에서만 측정됩니다.</p>
${notCollected.length ? `<p class="note"><strong>미수집 ${notCollected.length}건.</strong> ${notCollected.map(c => `${esc(c.country)}/${esc(c.query)}`).join(' · ')}</p>`
      : '<p class="note"><strong>미수집 0건.</strong> 조회한 모든 국가·키워드 조합에서 응답을 받았습니다.</p>'}
</div>

<details><summary>전체 수집 커버리지 보기 (${(meta.coverage || []).length}건)</summary>
<div class="scroll"><table><thead><tr><th>국가</th><th>키워드</th><th>상태</th><th class="num">광고</th></tr></thead><tbody>
${(meta.coverage || []).map(c => `<tr><td>${esc(c.country)}</td><td>${esc(c.query)}</td>
<td>${c.status === 'ok' ? '<span class="tag ok">수집</span>'
        : c.status === 'empty' ? '<span class="tag">측정된 0건</span>'
          : `<span class="tag warn">미수집 — ${esc(c.status)}</span>`}</td>
<td class="num">${c.ads}</td></tr>`).join('')}
</tbody></table></div></details>

</div></body></html>`;

  writeFileSync(join(OUTDIR, 'index.html'), html, 'utf8');
  console.log(`priced clinics: ${priced.length} · priced ads: ${pricedAds.length} · advertisers: ${advs.length}`);
  console.log(`countries: ${cols.length} · keywords: ${kwMap.size}`);
  console.log(`meta creatives: ${creativeMap.size} · gdn creatives: ${gdnMap.size}`);
  console.log(`written: ${join(OUTDIR, 'index.html')}`);
}

main();
