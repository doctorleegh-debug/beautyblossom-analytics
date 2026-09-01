// Emits the report as a single self-contained page for publishing as an Artifact.
//
// The published page is served under a CSP that blocks every external host except
// Google Fonts, so every creative has to travel inside the file as a data URI.
// Banners come off Google's ad archive at full print size, so each one is
// downscaled through ffmpeg first - inlining them raw would push the page past the
// size limit for no readable gain.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '..', 'reports', 'ad-intel-mapo');
const ASSETS = join(SRC, 'assets');
const SMALL = join(ROOT, '.cache', 'artifact-img');
const OUT = join(SRC, 'artifact.html');
const REPORT_DATE = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '';

const meta = JSON.parse(readFileSync(join(ROOT, 'data', 'ads-overseas-mapo.json'), 'utf8'));
const gdnPath = join(ROOT, 'data', 'gdn-mapo.json');
const gdn = existsSync(gdnPath) ? JSON.parse(readFileSync(gdnPath, 'utf8')) : null;
const vPath = join(ROOT, 'data', 'gdn-creative-verdicts.json');
const verdicts = existsSync(vPath) ? JSON.parse(readFileSync(vPath, 'utf8')) : {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Validated categorical palette - the dataviz validator passes it against both the
// light and the dark surface, so one set serves both themes.
const CAT = ['#D4536F', '#3383CC', '#B08420', '#1BA073', '#A87BE0', '#CC6630'];

mkdirSync(SMALL, { recursive: true });
let inlined = 0, skipped = 0;
function dataUri(relPath, maxW) {
  const src = join(SRC, relPath);
  if (!existsSync(src)) { skipped++; return null; }
  const small = join(SMALL, `${maxW}-${relPath.replace(/[^\w.-]+/g, '_')}.jpg`);
  if (!existsSync(small)) {
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src,
        '-vf', `scale='min(${maxW},iw)':-2`, '-q:v', '6', small], { stdio: 'ignore' });
    } catch { skipped++; return null; }
  }
  try {
    const b = readFileSync(small);
    inlined++;
    return `data:image/jpeg;base64,${b.toString('base64')}`;
  } catch { skipped++; return null; }
}

// Display creatives come straight from Google's ad archive rather than the mirrored
// folder: the archive links are unsigned and stable, so the artifact build does not
// depend on an earlier HTML build having run.
async function remoteDataUri(url, maxW) {
  const id = (url.match(/(\d+)$/) || [])[1] || String(Math.abs([...url].reduce((h, ch) => h * 31 + ch.charCodeAt(0) | 0, 7)));
  const small = join(SMALL, `g${maxW}-${id}.jpg`);
  if (!existsSync(small)) {
    const raw = small + '.raw';
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(45000) });
      if (!res.ok) { skipped++; return null; }
      writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw,
        '-vf', `scale='min(${maxW},iw)':-2`, '-q:v', '6', small], { stdio: 'ignore' });
    } catch { skipped++; return null; }
  }
  try { inlined++; return `data:image/jpeg;base64,${readFileSync(small).toString('base64')}`; }
  catch { skipped++; return null; }
}

function toKrw(s) {
  const d = (s.match(/[\d,]{3,}/) || [])[0];
  if (!d) return null;
  const n = Number(d.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 1000 ? n : null;
}
const won = (n) => '₩' + n.toLocaleString('ko-KR');

function advertiserRollup(ads) {
  const map = new Map();
  for (const ad of ads) {
    const key = ad.advertiser || '(광고주명 미표기)';
    if (!map.has(key)) map.set(key, {
      name: key, url: ad.advertiserUrl, ads: [], countries: new Set(), domains: new Set(),
      withPrice: 0, prices: new Set()
    });
    const e = map.get(key);
    e.ads.push(ad);
    for (const s of ad.seenIn || []) e.countries.add(s.country);
    if (ad.landingDomain) e.domains.add(ad.landingDomain);
    if (ad.evidence?.disclosesPrice) {
      e.withPrice++;
      for (const p of ad.evidence.priceSamples || []) { const v = toKrw(p); if (v) e.prices.add(v); }
    }
    if (!e.url && ad.advertiserUrl) e.url = ad.advertiserUrl;
  }
  return [...map.values()].sort((a, b) => b.withPrice - a.withPrice || b.ads.length - a.ads.length);
}

function priceLadder(rows) {
  const W = 900, padL = 200, padR = 34, rowH = 44, padT = 32, padB = 42;
  const H = padT + rows.length * rowH + padB;
  const all = rows.flatMap(r => r.prices);
  if (!all.length) return '';
  const lo = Math.min(...all), hi = Math.max(...all);
  const l0 = Math.log10(lo * 0.7), l1 = Math.log10(hi * 1.4);
  const x = (v) => padL + (Math.log10(v) - l0) / (l1 - l0) * (W - padL - padR);
  const ticks = [10000, 50000, 100000, 500000, 1000000, 5000000, 10000000].filter(t => t >= lo * 0.7 && t <= hi * 1.4);
  const grid = ticks.map(t => `<line x1="${x(t).toFixed(1)}" y1="${padT - 8}" x2="${x(t).toFixed(1)}" y2="${H - padB}" class="grid"/><text x="${x(t).toFixed(1)}" y="${H - padB + 18}" class="ax" text-anchor="middle">${(t / 10000).toLocaleString('ko-KR')}만</text>`).join('');
  const body = rows.map((r, i) => {
    const y = padT + i * rowH + rowH / 2;
    const xs = r.prices.map(x);
    const line = xs.length > 1 ? `<line x1="${Math.min(...xs).toFixed(1)}" y1="${y}" x2="${Math.max(...xs).toFixed(1)}" y2="${y}" class="conn"/>` : '';
    const dots = r.prices.map(v => `<g class="dot"><circle cx="${x(v).toFixed(1)}" cy="${y}" r="6.5" fill="${r.color}" stroke="var(--panel)" stroke-width="2"><title>${esc(r.short)} · ${won(v)}</title></circle></g>`).join('');
    const mn = Math.min(...r.prices), mx = Math.max(...r.prices);
    return `${line}${dots}<text x="${padL - 14}" y="${y + 4}" class="lbl" text-anchor="end">${esc(r.short)}</text>
<text x="${(x(mx) + 13).toFixed(1)}" y="${y + 4}" class="val">${won(mx)}</text>
${r.prices.length > 1 ? `<text x="${(x(mn) - 13).toFixed(1)}" y="${y + 4}" class="val" text-anchor="end">${won(mn)}</text>` : ''}`;
  }).join('');
  return `<figure class="fig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="병원별 광고 표기 금액 분포"><text x="${padL}" y="15" class="axt">광고에 적힌 금액 · 로그 축</text>${grid}${body}</svg></figure>`;
}

function bars(rows, hue, title, padL) {
  const W = 900, padR = 62, barH = 25, gap = 8, padT = 24, padB = 10;
  const H = padT + rows.length * (barH + gap) + padB;
  const max = Math.max(...rows.map(r => r.n));
  const body = rows.map((r, i) => {
    const y = padT + i * (barH + gap);
    const w = Math.max(3, (r.n / max) * (W - padL - padR));
    return `<g class="bar"><rect x="${padL}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${hue}"><title>${esc(r.label)} · ${r.n}건${r.sub ? ' · ' + esc(r.sub) : ''}</title></rect>
<text x="${padL - 12}" y="${y + barH / 2 + 4}" class="lbl" text-anchor="end">${esc(r.label)}</text>
<text x="${(padL + w + 10).toFixed(1)}" y="${y + barH / 2 + 4}" class="val">${r.n}</text></g>`;
  }).join('');
  return `<figure class="fig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><text x="${padL}" y="13" class="axt">${esc(title)}</text>${body}</svg></figure>`;
}

function matrix(rowsIn, cols) {
  const cw = 46, ch = 32, padL = 200, padT = 42, padR = 14, padB = 8;
  const W = padL + cols.length * cw + padR, H = padT + rowsIn.length * ch + padB;
  const max = Math.max(1, ...rowsIn.flatMap(r => cols.map(c => r.counts[c] || 0)));
  const head = cols.map((c, j) => `<text x="${padL + j * cw + cw / 2}" y="${padT - 13}" class="ax" text-anchor="middle">${esc(c)}</text>`).join('');
  const body = rowsIn.map((r, i) => {
    const y = padT + i * ch;
    const cells = cols.map((c, j) => {
      const v = r.counts[c] || 0, t = v / max;
      const fill = v ? `rgba(51,131,204,${(0.14 + t * 0.76).toFixed(2)})` : 'transparent';
      return `<g class="cell"><rect x="${padL + j * cw + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${fill}" stroke="var(--line)"/><title>${esc(r.short)} · ${esc(c)} · ${v}건</title></rect>${v ? `<text x="${padL + j * cw + cw / 2}" y="${y + ch / 2 + 4}" class="cellv" text-anchor="middle">${v}</text>` : ''}</g>`;
    }).join('');
    return `<text x="${padL - 13}" y="${y + ch / 2 + 4}" class="lbl" text-anchor="end">${esc(r.short)}</text>${cells}`;
  }).join('');
  return `<figure class="fig scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="병원별 노출 국가 매트릭스"><text x="${padL}" y="15" class="axt">병원 × 노출 국가 · 셀 숫자는 관측 광고 수</text>${head}${body}</svg></figure>`;
}

const CSS = `
:root{
--ground:#FAF7F8;--panel:#FFFFFF;--sunk:#F3EEF0;--ink:#1A1518;--muted:#6C626A;
--line:#E6DFE3;--accent:#8E4257;--rule:#D9CFD5;
--crit:#B3261E;--warn:#8A5A00;--ok:#1F6B47;--info:#2C5578;
--critbg:#FBEEEC;--okbg:#EDF5F1;--warnbg:#F8F2E6;--infobg:#EDF2F7;--critline:#E4B5AF}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
--ground:#141117;--panel:#1C1820;--sunk:#241F28;--ink:#F0EAEE;--muted:#A2969E;
--line:#332C36;--accent:#E08AA0;--rule:#3D3542;
--crit:#E8737F;--warn:#D9A441;--ok:#4FBF92;--info:#6BA8DC;
--critbg:#2A1A1E;--okbg:#152521;--warnbg:#251F14;--infobg:#18222C;--critline:#7A3A44}}
:root[data-theme="dark"]{
--ground:#141117;--panel:#1C1820;--sunk:#241F28;--ink:#F0EAEE;--muted:#A2969E;
--line:#332C36;--accent:#E08AA0;--rule:#3D3542;
--crit:#E8737F;--warn:#D9A441;--ok:#4FBF92;--info:#6BA8DC;
--critbg:#2A1A1E;--okbg:#152521;--warnbg:#251F14;--infobg:#18222C;--critline:#7A3A44}
*{box-sizing:border-box}
.bb{background:var(--ground);color:var(--ink);font-family:'Gothic A1','Malgun Gothic',sans-serif;
font-size:15px;line-height:1.72;margin:0;padding:0}
.wrap{max-width:1040px;margin:0 auto;padding:38px 20px 96px;display:flex;flex-direction:column;gap:0}
.eyebrow{font-size:11.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);
font-weight:700;margin:0 0 8px}
h1{font-size:30px;font-weight:800;letter-spacing:-.025em;margin:0 0 10px;text-wrap:balance}
h2{font-size:20px;font-weight:800;margin:56px 0 6px;letter-spacing:-.015em;text-wrap:balance}
h2+.sub{color:var(--muted);font-size:13.5px;margin:0 0 14px}
h3{font-size:15.5px;font-weight:700;margin:30px 0 8px}
.rule{height:1px;background:var(--rule);margin:12px 0 0}
.date{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--muted);
background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:3px 9px;display:inline-block}
.lead{font-size:16.5px;margin:16px 0 6px;max-width:62ch;text-wrap:pretty}
.note{color:var(--muted);font-size:13.5px;margin:9px 0;max-width:70ch}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(156px,1fr));gap:12px;margin:24px 0 4px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px 17px}
.stat.key{border-color:var(--critline);background:var(--critbg)}
.stat .n{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;
font-size:29px;font-weight:700;line-height:1.08}
.stat.key .n{color:var(--crit)}
.stat .l{font-size:12.5px;color:var(--muted);margin-top:5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
.card.miss{border-left:3px solid var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);
border-radius:10px;overflow:hidden;font-size:14px}
th{background:var(--sunk);text-align:left;padding:10px 12px;font-weight:700;font-size:12px;
letter-spacing:.03em;color:var(--muted);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.num{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tag{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);
background:var(--sunk);color:var(--muted);margin:0 3px 3px 0;white-space:nowrap}
.tag.price{border-color:var(--critline);color:var(--crit);background:var(--critbg);font-weight:700}
.tag.ok{border-color:var(--ok);color:var(--ok);background:var(--okbg)}
.tag.warn{border-color:var(--warn);color:var(--warn);background:var(--warnbg)}
.tag.geo{border-color:var(--info);color:var(--info);background:var(--infobg)}
a{color:var(--info);text-underline-offset:2px}
a:hover{color:var(--accent)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.copy{background:var(--sunk);border-left:3px solid var(--line);padding:10px 13px;margin:9px 0;
font-size:13.5px;white-space:pre-wrap;word-break:break-word;border-radius:0 5px 5px 0}
.cr{display:flex;flex-wrap:wrap;gap:9px;margin:11px 0}
.cr img{width:150px;height:150px;object-fit:cover;border:1px solid var(--line);border-radius:7px;background:var(--sunk)}
.cr.tall img{width:186px;height:auto;max-height:400px;object-fit:contain}
.scroll{overflow-x:auto}
.fig{margin:14px 0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 12px}
.fig svg{width:100%;height:auto;display:block}
.grid{stroke:var(--line)}
.conn{stroke:var(--line);stroke-width:2}
.ax{fill:var(--muted);font-size:11px;font-family:'JetBrains Mono',monospace}
.axt{fill:var(--muted);font-size:11.5px}
.lbl{fill:var(--ink);font-size:12.5px}
.val{fill:var(--muted);font-size:11.5px;font-family:'JetBrains Mono',monospace}
.cellv{fill:#F2F7FC;font-size:11.5px;font-family:'JetBrains Mono',monospace}
.dot circle,.bar rect,.cell rect{transition:opacity .12s}
.dot:hover circle,.bar:hover rect,.cell:hover rect{opacity:.72}
.legend{display:flex;flex-wrap:wrap;gap:15px;margin:8px 2px 0;font-size:12.5px;color:var(--muted)}
.legend i{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:-1px}
details{margin:12px 0}
summary{cursor:pointer;color:var(--muted);font-size:13px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (max-width:600px){h1{font-size:25px}.wrap{padding:28px 15px 70px}.cr img{width:132px;height:132px}}
`;

function adBlock(ad, imgs) {
  const ev = ad.evidence || {};
  const tags = [
    ev.disclosesPrice ? `<span class="tag price">${esc((ev.priceSamples || []).slice(0, 4).join(' · '))}</span>` : '',
    ...[...new Set((ad.seenIn || []).map(s => s.country))].map(c => `<span class="tag geo">${esc(c)}</span>`),
    ad.startedRunning ? `<span class="tag">${esc(ad.startedRunning)} 시작</span>` : ''
  ].join('');
  return `<div class="card">
<div><strong>${esc(ad.advertiser || '(광고주명 미표기)')}</strong>${ad.adLibraryUrl ? ` · <a href="${esc(ad.adLibraryUrl)}" target="_blank" rel="noopener">광고 원문</a>` : ''}${ad.landingUrl ? ` · <a href="${esc(ad.landingUrl)}" target="_blank" rel="noopener">랜딩</a>` : ''}</div>
<div style="margin-top:7px">${tags}</div>
${ad.copy ? `<div class="copy">${esc(ad.copy.slice(0, 620))}${ad.copy.length > 620 ? ' …' : ''}</div>` : ''}
${imgs.length ? `<div class="cr">${imgs.map(u => `<img src="${u}" alt="광고 소재" loading="lazy">`).join('')}</div>` : ''}
</div>`;
}

async function main() {
  const ads = meta.ads || [];
  const advs = advertiserRollup(ads);
  const priced = advs.filter(a => a.withPrice > 0);
  const pricedAds = ads.filter(a => a.evidence?.disclosesPrice && a.advertiser);

  const cc = {};
  for (const ad of ads) for (const c of new Set((ad.seenIn || []).map(x => x.country))) cc[c] = (cc[c] || 0) + 1;
  const countryPairs = Object.entries(cc).sort((a, b) => b[1] - a[1]);

  const kwMap = new Map();
  for (const ad of ads) for (const s of ad.seenIn || []) {
    if (!kwMap.has(s.query)) kwMap.set(s.query, { ids: new Set(), cs: new Set() });
    kwMap.get(s.query).ids.add(ad.libraryId); kwMap.get(s.query).cs.add(s.country);
  }
  const kwRows = [...kwMap.entries()].map(([q, v]) => ({ label: q, n: v.ids.size, sub: [...v.cs].join(' ') }))
    .sort((a, b) => b.n - a.n).slice(0, 14);

  const shorten = (n) => n.replace(/Beauty Skin Anti-aging Clinic in Korea/i, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const ladder = priced.map((a, i) => ({
    short: shorten(a.name), color: CAT[i % CAT.length], prices: [...a.prices].sort((x, y) => x - y)
  })).filter(r => r.prices.length);

  const mRows = advs.slice(0, 13).map(a => {
    const counts = {};
    for (const ad of a.ads) for (const c of new Set((ad.seenIn || []).map(s => s.country))) counts[c] = (counts[c] || 0) + 1;
    return { short: shorten(a.name), counts };
  });

  // Which mirrored file belongs to which ad, by the naming the HTML build used.
  const files = existsSync(ASSETS) ? readdirSync(ASSETS) : [];
  const metaImgs = (id) => files.filter(f => f.startsWith(`meta-${id}-`)).slice(0, 3)
    .map(f => dataUri(`assets/${f}`, 300)).filter(Boolean);

  const gdnClinics = gdn ? (gdn.clinics || []).filter(c => c.status === 'collected') : [];
  const gdnMissing = gdn ? (gdn.clinics || []).filter(c => c.status !== 'collected') : [];
  const notCollected = (meta.coverage || []).filter(c => c.status !== 'ok' && c.status !== 'empty');

  const gdnImgs = new Map();
  for (const c of gdnClinics.filter(c => (c.gdnAds || 0) > 0)) {
    const urls = ['IMAGE', 'VIDEO'].flatMap(f => c.formats?.[f]?.creativeImages || []).slice(0, 6);
    const list = [];
    for (const u of urls) { const d = await remoteDataUri(u, 430); if (d) list.push(d); }
    gdnImgs.set(c.domain, list);
  }

  const body = `<title>마포구 병원 광고 인텔</title>
<style>${CSS}</style>
<div class="bb"><div class="wrap">

<p class="eyebrow">경쟁 광고 관측 · Meta &amp; Google</p>
<h1>병원명과 금액을 함께 내건 마포구 병원</h1>
<div class="date">보고일 ${esc(REPORT_DATE)}</div>
<p class="lead">마포구(홍대·합정·동교·서교) 피부과·성형외과가 해외 환자 유치를 위해 집행 중인 광고 가운데,
<strong>병원명과 금액을 한 광고 안에서 함께 노출한 건</strong>을 추렸습니다.</p>
<p class="note">Meta 광고 라이브러리와 Google 광고 투명성 센터의 활성 광고만 대상입니다.
Google은 검색광고를 제외하고 디스플레이(GDN)만 집계했습니다.</p>

<div class="strip">
<div class="stat key"><div class="n">${priced.length}</div><div class="l">병원명+금액 노출 병원</div></div>
<div class="stat key"><div class="n">${pricedAds.length}</div><div class="l">해당 광고</div></div>
<div class="stat"><div class="n">${advs.length}</div><div class="l">전체 광고주</div></div>
<div class="stat"><div class="n">${ads.length}</div><div class="l">마포·홍대 언급 광고</div></div>
<div class="stat"><div class="n">${countryPairs.length}</div><div class="l">노출 확인 국가</div></div>
<div class="stat"><div class="n">${kwMap.size}</div><div class="l">적중 키워드</div></div>
</div>

<h2>금액을 내건 병원</h2><div class="rule"></div>
<p class="sub">광고 본문에 병원명이 표기되고 금액이 함께 적힌 경우입니다. 표기는 전부 원화이며, 노출 시장 통화로 환산하지 않았습니다.</p>
<div class="scroll"><table><thead><tr><th>병원 (광고 표기명)</th><th class="num">금액노출</th><th class="num">전체 광고</th><th>표기 금액대</th><th>노출 국가</th></tr></thead><tbody>
${priced.map(a => {
    const ps = [...a.prices].sort((x, y) => x - y);
    return `<tr><td><strong>${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)}</strong></td>
<td class="num" style="color:var(--crit);font-weight:700">${a.withPrice}</td><td class="num">${a.ads.length}</td>
<td class="num">${ps.length > 1 ? `${won(ps[0])} ~ ${won(ps[ps.length - 1])}` : won(ps[0])}</td>
<td>${[...a.countries].sort().map(c => `<span class="tag geo">${esc(c)}</span>`).join('')}</td></tr>`;
  }).join('')}
</tbody></table></div>
${ladder.length ? priceLadder(ladder) + `<div class="legend">${ladder.map(r => `<span><i style="background:${r.color}"></i>${esc(r.short)}</span>`).join('')}</div>
<p class="note">점 하나가 광고에 실제로 적힌 금액 하나입니다.</p>` : ''}

<h2>실제 광고</h2><div class="rule"></div>
<p class="sub">병원명과 금액이 함께 들어간 ${pricedAds.length}건 전부입니다.</p>
${pricedAds.map(a => adBlock(a, metaImgs(a.libraryId))).join('')}

<h2>어느 국가에 광고하고 있는가</h2><div class="rule"></div>
<p class="sub">조회한 국가 안에서 노출이 확인된 시장입니다. 조회하지 않은 국가는 없다는 뜻이 아닙니다.</p>
${bars(countryPairs.map(([c, n]) => ({ label: c, n })), CAT[1], '국가별 관측 광고 수 (건)', 54)}
${matrix(mRows, countryPairs.map(p => p[0]))}

<h2>어떤 키워드에 걸리는가</h2><div class="rule"></div>
<p class="sub">해외 환자가 입력할 만한 키워드로 검색해 광고가 노출된 결과입니다.</p>
${bars(kwRows, CAT[3], '키워드별 관측 광고 수 (건)', 250)}

<h2>Google 디스플레이</h2><div class="rule"></div>
${gdn ? `<p class="sub">검색광고는 제외했습니다. 건수는 <strong>도메인 기준</strong>입니다 — 여러 병원이 대행사 계정 하나를 공유하는 경우가 있어, 계정 기준으로 세면 다른 병원 광고까지 그 병원 것으로 잡힙니다.</p>
<div class="scroll"><table><thead><tr><th>병원</th><th>주소 근거</th><th class="num">GDN</th><th>광고 계정</th><th>원본</th></tr></thead><tbody>
${gdnClinics.slice().sort((a, b) => (b.gdnAds || 0) - (a.gdnAds || 0)).map(c => `<tr>
<td><strong>${esc(c.name)}</strong><br><span style="font-size:12px;color:var(--muted)">${esc(c.domain)}</span></td>
<td style="font-size:12.5px">${esc(c.addr || '')}</td>
<td class="num">${c.gdnAds || 0}</td>
<td style="font-size:12.5px">${c.accountName
      ? (/의원|클리닉|clinic/i.test(c.accountName) ? `<span class="tag ok">병원 직접</span> ${esc(c.accountName)}` : `<span class="tag warn">대행사</span> ${esc(c.accountName)}`)
      : '—'}</td>
<td>${c.formats?.IMAGE?.url ? `<a href="${esc(c.formats.IMAGE.url)}" target="_blank" rel="noopener">조회</a>` : '—'}</td></tr>`).join('')}
</tbody></table></div>
${gdnMissing.length ? `<div class="card miss"><strong>GDN 미수집 ${gdnMissing.length}건</strong><p class="note">조회하지 못한 항목입니다. 측정된 0건이 아닙니다.</p><div>${gdnMissing.map(c => `<span class="tag">${esc(c.name)}</span>`).join('')}</div></div>` : ''}
${gdnClinics.filter(c => (c.gdnAds || 0) > 0).map(c => {
      const v = verdicts[c.domain];
      const imgs = gdnImgs.get(c.domain) || [];
      return `<h3>${esc(c.name)} · 디스플레이 ${c.gdnAds}건</h3>
<div>${v
        ? (v.findings || []).map(x => `<span class="tag ${x.price ? 'price' : 'ok'}">${esc(x.label)}</span>`).join('')
        : '<span class="tag warn">소재 육안 판독 미완료</span>'}</div>
${v ? `<p class="note">소재 ${v.reviewed}건을 직접 열어 확인했습니다. ${(v.findings || []).map(x => esc(x.detail)).join(' ')}</p>` : ''}
${imgs.length ? `<div class="cr tall">${imgs.map(u => `<img src="${u}" alt="${esc(c.name)} 디스플레이 소재" loading="lazy">`).join('')}</div>` : ''}
${c.formats?.IMAGE?.url ? `<p class="note"><a href="${esc(c.formats.IMAGE.url)}" target="_blank" rel="noopener">투명성 센터에서 이 병원의 디스플레이 광고 전체 보기</a></p>` : ''}`;
    }).join('')}`
      : `<div class="card miss"><strong>수집 진행 중</strong><p class="note">Google 디스플레이 데이터는 아직 수집이 끝나지 않았습니다.</p></div>`}

<h2>수집 한계</h2><div class="rule"></div>
<div class="card miss">
<p class="note"><strong>Meta의 키워드 검색 제한.</strong> Meta는 EU 외 국가에서 광고 본문 키워드 검색을 사회·정치 이슈 광고로만 제한합니다.
한국 대상 한국어 키워드가 거의 잡히지 않는 것은 광고가 없어서가 아니라 이 제한 때문이며, 해외 시장 검색이 이 광고들을 관측할 수 있는 경로입니다.</p>
<p class="note"><strong>디스플레이 광고의 금액.</strong> GDN 배너는 금액이 이미지 안에 그려져 있어 페이지 텍스트로 판독되지 않습니다.
소재를 내려받아 육안으로 확인한 것만 금액 노출로 적었고, 확인하지 못한 소재는 미판독으로 남겼습니다.</p>
<p class="note"><strong>국가 범위.</strong> 노출 국가는 조회한 국가 목록 안에서만 측정됩니다.</p>
<p class="note"><strong>미수집 ${notCollected.length}건.</strong> ${notCollected.length ? notCollected.map(c => `${esc(c.country)}/${esc(c.query)}`).join(' · ') : '조회한 모든 국가·키워드 조합에서 응답을 받았습니다.'}</p>
</div>

<details><summary>전체 수집 커버리지 (${(meta.coverage || []).length}건)</summary>
<div class="scroll"><table><thead><tr><th>국가</th><th>키워드</th><th>상태</th><th class="num">광고</th></tr></thead><tbody>
${(meta.coverage || []).map(c => `<tr><td>${esc(c.country)}</td><td>${esc(c.query)}</td>
<td>${c.status === 'ok' ? '<span class="tag ok">수집</span>' : c.status === 'empty' ? '<span class="tag">측정된 0건</span>' : `<span class="tag warn">미수집</span>`}</td>
<td class="num">${c.ads}</td></tr>`).join('')}
</tbody></table></div></details>

</div></div>`;

  writeFileSync(OUT, body, 'utf8');
  const kb = Math.round(Buffer.byteLength(body, 'utf8') / 1024);
  console.log(`priced ${priced.length} clinics / ${pricedAds.length} ads · countries ${countryPairs.length}`);
  console.log(`images inlined ${inlined}, skipped ${skipped}`);
  console.log(`written: ${OUT} (${kb} KB)`);
}

main();
