#!/usr/bin/env node
// 월간 성과보고서 빌드 — data/monthly-<end>.json → r/<발행일>/index.html + data.json
//   node scripts/build-monthly.mjs --data=data/monthly-2026-09-28.json --publish=2026-09-29
// 증감은 "일평균(합계 ÷ 일수)" 기준 전월 대비. 고유 수(사용자·도달·참여 계정)는 일평균 환산을 하지 않는다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DATA = arg('data');
const PUB = arg('publish');
if (!DATA || !PUB) { console.error('필수: --data=<json> --publish=yyyy-mm-dd'); process.exit(1); }
const D = JSON.parse(readFileSync(join(ROOT, DATA), 'utf8'));
const P = D.periods;                      // [{key,start,end,days}]
const MK = P.map((p) => p.key);
const MN = (k) => `${Number(k.slice(5))}월`;
const S = D.sources;

// ---------- 포맷 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const dur = (s) => (s == null ? '—' : `${Math.floor(s / 60)}분 ${String(Math.round(s % 60)).padStart(2, '0')}초`);
function badge(cur, prev, mode = 'ratio') {
  if (cur == null || prev == null) return '';
  let t, dir;
  if (mode === 'ratio') { if (!prev) return ''; const r = cur / prev - 1; dir = Math.abs(r) < 0.0005 ? 0 : Math.sign(r); t = `${Math.abs(r * 100).toFixed(1)}%`; }
  else if (mode === 'pp') { const r = (cur - prev) * 100; dir = Math.abs(r) < 0.05 ? 0 : Math.sign(r); t = `${Math.abs(r).toFixed(1)}%p`; }
  else if (mode === 'perday') { const r = cur - prev; dir = Math.abs(r) < 0.05 ? 0 : Math.sign(r); t = `일 ${Math.abs(r).toFixed(1)}`; }
  else { const r = cur - prev; dir = Math.abs(r) < 0.05 ? 0 : Math.sign(r); t = `${Math.abs(r).toFixed(1)}`; }
  const sym = dir > 0 ? '▲' : dir < 0 ? '▼' : '–';
  return ` <span class="dl ${dir > 0 ? 'up' : dir < 0 ? 'dn' : 'eq'}">${sym} ${t}</span>`;
}
const sumDays = (src, k) => src?.[k] ?? P.find((p) => p.key === k).days;

// 한 행 = 한 지표/한 대상. kind: sum(일평균 비교) | uniq(원값 비교) | rate(%p) | pos(차이) | dur(초, 원값 비교)
function cells(vals, days, kind, opt = {}) {
  return MK.map((k, i) => {
    const v = vals[i];
    if (v === undefined || v === null) return `<td class="na">${opt.na?.[i] ?? '—'}</td>`;
    let shown;
    if (kind === 'rate') shown = pct(v);
    else if (kind === 'pos') shown = nf(v, 1);
    else if (kind === 'dur') shown = dur(v);
    else shown = nf(v, opt.dec ?? 0);
    let b = '';
    if (i > 0 && !opt.noDelta?.[i]) {
      const pv = vals[i - 1];
      if (kind === 'sum') b = badge(days[i] ? v / days[i] : null, days[i - 1] && pv != null ? pv / days[i - 1] : null, 'ratio');
      // 순증처럼 음수가 나올 수 있는 값은 비율이 아니라 일평균 차이로 비교한다.
      else if (kind === 'net') b = badge(days[i] ? v / days[i] : null, days[i - 1] && pv != null ? pv / days[i - 1] : null, 'perday');
      else if (kind === 'uniq' || kind === 'dur') b = badge(v, pv, 'ratio');
      else if (kind === 'rate') b = badge(v, pv, 'pp');
      else if (kind === 'pos') b = badge(v, pv, 'diff');
    }
    const sub = (kind === 'sum' || kind === 'net') && days[i] ? `<span class="pd">일 ${nf(v / days[i], Math.abs(v / days[i]) < 10 ? 1 : 0)}</span>` : '';
    const note = opt.noDelta?.[i] ? ` <span class="dl eq" title="${esc(opt.noDelta[i])}">비교 제외</span>` : '';
    return `<td>${shown}${b}${note}${sub}</td>`;
  }).join('');
}
function table(head, rows, cls = '') {
  return `<div class="tw"><table class="${cls}"><thead><tr><th>${head}</th>${MK.map((k, i) => `<th>${MN(k)}<small>${P[i].start.slice(5).replace('-', '/')}~${P[i].end.slice(5).replace('-', '/')}</small></th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
const tr = (label, desc, vals, days, kind, opt) => `<tr><td><b>${label}</b>${desc ? `<span class="ds">${desc}</span>` : ''}</td>${cells(vals, days, kind, opt)}</tr>`;

// ---------- 차트 (묶음 막대: 대상별 × 월, 값 = 일평균) ----------
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
function niceMax(v) { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)); const n = v / e; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * e; }
function bars(groups, unit) {
  // groups: [{name, vals:[m7,m8,m9] (일평균, null 허용)}]
  const W = 1000, H = 250, L = 56, R = 10, T = 12, B = 34;
  const max = niceMax(Math.max(...groups.flatMap((g) => g.vals.filter((v) => v != null)), 0));
  const gw = (W - L - R) / groups.length, bw = Math.min(34, (gw - 18) / 3);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)}">`;
  for (const t of ticks) s += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="gl"/><text x="${L - 8}" y="${y(t) + 4}" class="ax" text-anchor="end">${nf(t, t < 10 && t % 1 ? 1 : 0)}</text>`;
  groups.forEach((g, gi) => {
    const x0 = L + gi * gw + (gw - bw * 3 - 4) / 2;
    g.vals.forEach((v, mi) => {
      const x = x0 + mi * (bw + 2);
      if (v == null) { s += `<text x="${x + bw / 2}" y="${H - B - 4}" class="ax" text-anchor="middle">–</text>`; return; }
      const top = y(v), h = Math.max(0, H - B - top), r = Math.min(4, h, bw / 2);
      const tt = `<b>${esc(g.name)} · ${MN(MK[mi])}</b><br>${esc(unit)} ${nf(v, v < 10 ? 1 : 0)}`;
      s += `<path d="M${x},${H - B} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - B} Z" fill="${COLORS[mi]}" data-tt="${esc(tt)}"/>`;
    });
    s += `<text x="${L + gi * gw + gw / 2}" y="${H - 12}" class="ax lb" text-anchor="middle">${esc(g.name)}</text>`;
  });
  s += `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="bl"/></svg>`;
  const legend = `<div class="legend">${MK.map((k, i) => `<span><i class="dot" style="background:${COLORS[i]}"></i>${MN(k)}</span>`).join('')}<span class="lu">단위: ${esc(unit)}</span></div>`;
  return `<div class="chart">${legend}${s}</div>`;
}

// ---------- 공통 계산 ----------
const perDay = (v, d) => (v == null || !d ? null : v / d);
const sumBy = (arr, f) => arr.reduce((a, x) => a + (f(x) ?? 0), 0);
const lastDays = (last) => P.map((p) => (!last ? p.days : last < p.start ? 0 : Math.round((Date.parse(last < p.end ? last : p.end) - Date.parse(p.start)) / 86400000) + 1));
const chg = (cur, prev) => (cur != null && prev ? cur / prev - 1 : null);
const say = (r) => (r == null ? '비교할 수 없습니다' : `${r >= 0 ? '▲' : '▼'} ${Math.abs(r * 100).toFixed(1)}%`);
const DAYS = P.map((p) => p.days);
const [a, b, c] = [0, 1, 2];

// ================= GA4 =================
const CH = {
  'Paid Social': ['유료 소셜 광고', '인스타그램·페이스북 등에 돈 주고 낸 광고'], 'Organic Social': ['소셜 자연 유입', '인스타 프로필·게시물 링크 등 광고가 아닌 소셜'],
  'Paid Search': ['검색 광고', '구글 등 검색 결과 상단의 유료 광고'], 'Organic Search': ['자연 검색', '구글·네이버 검색 결과에서 광고 없이 들어온 유입'],
  Direct: ['직접 유입', '주소 직접 입력·즐겨찾기, 또는 경로가 안 잡힌 재방문'], Referral: ['외부 링크', '다른 사이트에 걸린 링크를 타고 들어온 유입'],
  Email: ['이메일', '메일에 넣은 링크'], Display: ['배너 광고', '디스플레이 네트워크 배너'], Affiliates: ['제휴', '제휴 파트너 경유'],
  'Cross-network': ['교차 네트워크', '구글 P-Max처럼 여러 지면에 동시 노출된 광고'], 'Paid Other': ['기타 유료 광고', '위 분류에 안 들어가는 유료 매체'],
  'Organic Video': ['동영상 자연 유입', '유튜브 등 영상에서 광고 없이 들어온 유입'], 'AI Assistant': ['AI 챗봇', 'ChatGPT 등 AI 답변에 걸린 링크'],
  Unassigned: ['분류 안 됨', '추적 정보가 부족해 GA4가 출처를 못 가린 유입'], 'Paid Video': ['동영상 광고', '유튜브 등 영상 광고'], 'Organic Shopping': ['쇼핑 자연 유입', '쇼핑 탭 등 광고 없는 상품 노출'],
};
const G = S.ga4.filter((x) => !x.error);
const gv = (r, m) => MK.map((k) => r.months[k]?.[m] ?? null);
const gTot = (m) => MK.map((k) => sumBy(G, (r) => r.months[k]?.[m]));
const keFrom = G.map((r) => r.key_events_from).filter(Boolean).sort().at(-1);
// 7월 문의는 측정 시작(7/14) 이후만 있어 7→8월 증감을 숨긴다.
const keNo = [null, `7월 문의는 ${keFrom?.slice(5).replace('-', '/')}부터 측정돼 8월과 같은 기준이 아닙니다`, null];

const gaSessions = gTot('sessions'), gaKe = gTot('keyEvents');
const gaRate = MK.map((k, i) => (gaSessions[i] ? gaKe[i] / gaSessions[i] : null));
const gaSent = [];
{
  const r = chg(perDay(gaSessions[c], DAYS[c]), perDay(gaSessions[b], DAYS[b]));
  gaSent.push(`9월 6개국 홈페이지 접속 횟수는 ${nf(gaSessions[c])}회(일평균 ${nf(gaSessions[c] / DAYS[c])}회)이며 8월 일평균 ${nf(gaSessions[b] / DAYS[b])}회 대비 ${say(r)}입니다.`);
  const byC = G.map((x) => ({ l: x.label, r: chg(perDay(x.months[MK[c]]?.sessions, DAYS[c]), perDay(x.months[MK[b]]?.sessions, DAYS[b])) })).filter((x) => x.r != null).sort((p, q) => q.r - p.r);
  if (byC.length) gaSent.push(`일평균 접속 증감 폭은 ${byC[0].l}(${say(byC[0].r)})가 가장 크게 늘었고, ${byC.at(-1).l}(${say(byC.at(-1).r)})가 가장 크게 줄었습니다.`);
  const rk = chg(perDay(gaKe[c], DAYS[c]), perDay(gaKe[b], DAYS[b]));
  gaSent.push(`9월 문의는 ${nf(gaKe[c])}건(일평균 ${nf(gaKe[c] / DAYS[c], 1)}건)으로 8월 일평균 대비 ${say(rk)}이고, 문의 전환율은 ${pct(gaRate[b])} → ${pct(gaRate[c])}입니다.`);
}
const gaChart = bars(G.map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.sessions, DAYS[i])) })), '일평균 접속 횟수(회)');
const gaTable = table('국가', G.map((x) => tr(x.label, '', gv(x, 'sessions'), DAYS, 'sum')).concat([tr('합계', '', gaSessions, DAYS, 'sum')]));
// 7월 문의 일평균은 측정 시작일부터의 일수로 나눈다(31일로 나누면 낮게 보인다).
const keDays = (from) => P.map((p, i) => (from && from > p.start && from <= p.end ? Math.round((Date.parse(p.end) - Date.parse(from)) / 86400000) + 1 : DAYS[i]));
const gaKeTable = table('국가', G.map((x) => tr(x.label, `측정 시작 ${x.key_events_from?.slice(5).replace('-', '/') ?? '—'} · 7월 일평균은 측정일 기준`, gv(x, 'keyEvents'), keDays(x.key_events_from), 'sum', { noDelta: keNo })).concat([tr('합계', `7월 일평균은 ${G.map((x) => x.key_events_from).sort()[0]?.slice(5).replace('-', '/')}부터 기준`, gaKe, keDays(G.map((x) => x.key_events_from).sort()[0]), 'sum', { noDelta: keNo })]));
// 7월 전환율은 문의 측정이 일부 기간뿐이라 표시하지 않는다.
const rateNa = { na: ['부분 측정', null, null] };
const gaRateTable = table('국가', G.map((x) => tr(x.label, '', MK.map((k, i) => (i === 0 ? null : x.months[k]?.sessions ? x.months[k].keyEvents / x.months[k].sessions : null)), DAYS, 'rate', rateNa)).concat([tr('전체', '', gaRate.map((v, i) => (i === 0 ? null : v)), DAYS, 'rate', rateNa)]));
const gaDetail = G.map((x) => `<details><summary>${x.label} 상세 지표</summary>${table('지표', [
  tr('접속 횟수', '홈페이지에 들어와 머문 방문 1회 단위', gv(x, 'sessions'), DAYS, 'sum'),
  tr('사용자', '한 번 이상 들어온 사람 수 · 고유 수라 원값 비교', gv(x, 'activeUsers'), DAYS, 'uniq'),
  tr('신규 사용자', '처음 들어온 사람 수 · 원값 비교', gv(x, 'newUsers'), DAYS, 'uniq'),
  tr('페이지 조회', '열어 본 페이지 수', gv(x, 'screenPageViews'), DAYS, 'sum'),
  tr('문의', '예약·상담 등 GA4 핵심 이벤트', gv(x, 'keyEvents'), DAYS, 'sum', { noDelta: keNo }),
  tr('참여율', '10초 이상 머물거나 2페이지 이상 본 접속 비율', gv(x, 'engagementRate'), DAYS, 'rate'),
  tr('이탈률', '참여 없이 나간 접속 비율', gv(x, 'bounceRate'), DAYS, 'rate'),
  tr('평균 체류 시간', '접속 1회당 머문 시간', gv(x, 'averageSessionDuration'), DAYS, 'dur'),
])}</details>`).join('');
// 9월 유입 경로 (6개국 합)
const chAgg = {};
for (const x of G) for (const k of MK) for (const [n, v] of Object.entries(x.channels[k] || {})) { chAgg[n] ??= {}; chAgg[n][k] ??= { sessions: 0, keyEvents: 0 }; chAgg[n][k].sessions += v.sessions; chAgg[n][k].keyEvents += v.keyEvents; }
const chRows = Object.entries(chAgg).sort((p, q) => (q[1][MK[c]]?.sessions ?? 0) - (p[1][MK[c]]?.sessions ?? 0))
  .map(([n, m]) => tr(CH[n]?.[0] ?? n, CH[n]?.[1] ?? '', MK.map((k) => m[k]?.sessions ?? null), DAYS, 'sum'));
const gaChTable = table('유입 경로 (6개국 합)', chRows);

// ================= Search Console =================
const GS = S.searchconsole;
const gscLast = GS.map((x) => x.last_date).filter(Boolean).sort()[0];
const GD = lastDays(gscLast);
const gsv = (x, m) => MK.map((k) => (x.error ? null : x.months[k]?.[m] ?? null));
const homes = GS.filter((x) => x.group === 'home'), blogs = GS.filter((x) => x.group === 'blog');
const homeClicks = MK.map((k) => sumBy(homes.filter((x) => !x.error), (x) => x.months[k]?.clicks));
const homeImpr = MK.map((k) => sumBy(homes.filter((x) => !x.error), (x) => x.months[k]?.impressions));
const gscSent = [`9월(1~${Number(gscLast.slice(8))}일) 홈페이지 7곳의 구글 검색 클릭은 ${nf(homeClicks[c])}회로 8월 일평균 대비 ${say(chg(homeClicks[c] / GD[c], homeClicks[b] / GD[b]))}, 노출은 ${nf(homeImpr[c])}회로 ${say(chg(homeImpr[c] / GD[c], homeImpr[b] / GD[b]))}입니다.`];
const gscChart = bars(homes.filter((x) => !x.error).map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.clicks, GD[i])) })), '일평균 검색 클릭(회)');
const gscRow = (x) => [
  tr(`${x.label} 클릭`, x.note ?? '', gsv(x, 'clicks'), GD, 'sum'),
  tr(`${x.label} 노출`, '검색 결과에 보인 횟수', gsv(x, 'impressions'), GD, 'sum'),
  tr(`${x.label} 클릭률`, '노출 대비 클릭 비율', gsv(x, 'ctr'), GD, 'rate'),
  tr(`${x.label} 평균 순위`, '작을수록 상단 · 증감은 순위 숫자 변화', gsv(x, 'position'), GD, 'pos'),
];
const gscHomeTable = table('홈페이지', homes.filter((x) => !x.error).map((x) => tr(x.label, x.note ?? '', gsv(x, 'clicks'), GD, 'sum')).concat([tr('합계(클릭)', '', homeClicks, GD, 'sum')]));
const gscDetail = homes.filter((x) => !x.error).map((x) => `<details><summary>${x.label} 클릭·노출·클릭률·순위</summary>${table('지표', gscRow(x))}</details>`).join('');
const gscBlogTable = table('블로그', blogs.map((x) => (x.error ? `<tr><td><b>${x.label}</b><span class="ds">조회 권한 없음 — 확인하지 못했습니다</span></td>${MK.map(() => '<td class="na">—</td>').join('')}</tr>` : tr(x.label, x.note ?? '구글 검색 클릭', gsv(x, 'clicks'), GD, 'sum'))));
const qTable = (x) => `<div class="tw"><table><thead><tr><th>검색어 (${MN(MK[c])})</th><th>클릭</th><th>노출</th><th>클릭률</th><th>평균 순위</th></tr></thead><tbody>${x.top_queries.map((q) => `<tr><td>${esc(q.query)}</td><td>${nf(q.clicks)}</td><td>${nf(q.impressions)}</td><td>${pct(q.ctr)}</td><td>${nf(q.position, 1)}</td></tr>`).join('')}</tbody></table></div>`;
const gscQueries = homes.filter((x) => !x.error && x.top_queries?.length).map((x) => `<details${x.label === 'KR' ? ' open' : ''}><summary>${x.label} 9월 상위 검색어 10개</summary>${qTable(x)}</details>`).join('');

// ================= 네이버 =================
const NV = S.naver || [];
const NO = NV.filter((x) => x.status === 'OK');
const nvv = (x, m) => MK.map((k) => x.months?.[k]?.[m] ?? null);
const nvKR = NO.find((x) => x.label === 'KR');
const nvSent = nvKR ? [`9월(1~28일) 한국 사이트 네이버 검색 클릭은 ${nf(nvKR.months[MK[c]].clicks)}회로 8월 일평균 대비 ${say(chg(nvKR.months[MK[c]].clicks / DAYS[c], nvKR.months[MK[b]].clicks / DAYS[b]))}, 노출은 ${nf(nvKR.months[MK[c]].impressions)}회로 ${say(chg(nvKR.months[MK[c]].impressions / DAYS[c], nvKR.months[MK[b]].impressions / DAYS[b]))}입니다.`,
  `해외 사이트(EN·JP·CN·TW·TH)의 네이버 노출은 월 ${nf(Math.max(...NO.filter((x) => x.label !== 'KR').flatMap((x) => nvv(x, 'impressions'))))}회 이하입니다.`] : [];
const nvTable = table('사이트', NO.map((x) => tr(`${x.label} 클릭`, `노출 ${nvv(x, 'impressions').map((v) => nf(v)).join(' · ')}`, nvv(x, 'clicks'), DAYS, 'sum'))
  .concat(NV.filter((x) => x.status !== 'OK').map((x) => `<tr><td><b>${x.label}</b><span class="ds">${esc(x.note ?? x.message)}</span></td>${MK.map(() => '<td class="na">—</td>').join('')}</tr>`)));
const nvKrTable = nvKR ? table('한국 사이트', [tr('클릭', '', nvv(nvKR, 'clicks'), DAYS, 'sum'), tr('노출', '검색 결과에 보인 횟수', nvv(nvKR, 'impressions'), DAYS, 'sum'), tr('클릭률', '노출 대비 클릭 비율', nvv(nvKR, 'ctr'), DAYS, 'rate')]) : '';
const nvQ = nvKR ? `<details open><summary>한국 사이트 상위 검색어 10개 (7/1~9/28, 3개월 누적)</summary><div class="tw"><table><thead><tr><th>검색어</th><th>클릭</th><th>노출</th><th>클릭률</th><th>평균 순위</th></tr></thead><tbody>${nvKR.top_queries_90d.map((q) => `<tr><td>${esc(q.query)}</td><td>${nf(q.clicks)}</td><td>${nf(q.impressions)}</td><td>${nf(q.ctr, 1)}%</td><td>${nf(q.rank, 1)}</td></tr>`).join('')}</tbody></table></div></details>` : '';

// ================= YouTube =================
const YT = S.youtube.filter((x) => !x.error);
// 채널 시작 전 날짜는 API가 0으로 돌려주므로, 첫 데이터일 이후만 일수로 센다.
const ytDays = (x) => P.map((p) => (x.daily || []).filter((d) => d.date >= p.start && d.date <= p.end && d.date >= (x.first_date || p.start)).length);
const ytv = (x, m) => { const d = ytDays(x); return MK.map((k, i) => (d[i] ? x.months[k][m] : null)); };
const ytNet = (x) => { const d = ytDays(x); return MK.map((k, i) => (d[i] ? x.months[k].gain - x.months[k].lost : null)); };
const ytLast = YT.map((x) => x.last_date).sort()[0];
const ytSent = YT.map((x) => { const d = ytDays(x); const v = ytv(x, 'views'); return `${x.short}: 9월(1~${Number(ytLast.slice(8))}일) 조회수 ${nf(v[c])}회, 8월 일평균 대비 ${say(chg(perDay(v[c], d[c]), perDay(v[b], d[b])))}${x.first_date > P[0].start ? ` (채널 첫 데이터 ${x.first_date.slice(5).replace('-', '/')})` : ''}.`; });
const ytChart = bars(YT.map((x) => { const d = ytDays(x); return { name: x.short, vals: MK.map((k, i) => perDay(x.months[k]?.days ? x.months[k].views : null, d[i])) }; }), '일평균 조회수(회)');
const ytTables = YT.map((x) => { const d = ytDays(x); const na = MK.map((k, i) => (d[i] ? null : '개설 전'));
  return `<h3>${esc(x.name)} <span class="muted">· 현재 구독자 ${nf(x.subscribers)}명 · 월별 데이터 일수 ${d.join(' / ')}일</span></h3>${table('지표', [
    tr('조회수', '영상이 재생된 횟수', ytv(x, 'views'), d, 'sum', { na }),
    tr('시청 시간(분)', '시청자가 본 시간 합계', ytv(x, 'mins'), d, 'sum', { na }),
    tr('평균 시청 지속 시간', '조회 1회당 본 시간 · 원값 비교', ytv(x, 'avd'), d, 'dur', { na }),
    tr('신규 구독', '구독 버튼을 누른 수(총량)', ytv(x, 'gain'), d, 'sum', { na }),
    tr('구독 취소', '', ytv(x, 'lost'), d, 'sum', { na }),
    tr('구독 순증', '신규 구독 − 구독 취소 · 증감은 일평균 차이', ytNet(x), d, 'net', { na }),
  ])}`; }).join('');

// ================= Instagram =================
const IG = S.instagram.filter((x) => !x.error);
const igv = (x, m) => MK.map((k) => x.months[k]?.[m] ?? null);
const igNet = (x) => MK.map((k) => (x.months[k]?.follows == null ? null : x.months[k].follows - x.months[k].unfollows));
const igPosts = (x) => MK.map((k) => x.posts?.[k]?.total ?? 0);
const igViews = MK.map((k) => sumBy(IG, (x) => x.months[k]?.views));
const igInter = MK.map((k) => sumBy(IG, (x) => x.months[k]?.total_interactions));
const igSent = [`9월 5개국 계정 합계 조회는 ${nf(igViews[c])}회로 8월 일평균 대비 ${say(chg(igViews[c] / DAYS[c], igViews[b] / DAYS[b]))}, 총 상호작용은 ${nf(igInter[c])}회로 ${say(chg(igInter[c] / DAYS[c], igInter[b] / DAYS[b]))}입니다.`,
  `현재 팔로워는 ${IG.map((x) => `${x.label} ${nf(x.followers)}`).join(' · ')}명입니다.`];
const igChart = bars(IG.map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.views, DAYS[i])) })), '일평균 조회(회)');
const igTables = IG.map((x) => `<details${x.label === 'KR' ? ' open' : ''}><summary>${x.label} · @${esc(x.username)} · 현재 팔로워 ${nf(x.followers)}명</summary>${table('지표', [
  tr('조회', '게시물·릴스·스토리가 화면에 표시·재생된 횟수', igv(x, 'views'), DAYS, 'sum'),
  tr('도달', '콘텐츠를 본 계정 수 · 고유 수라 원값 비교', igv(x, 'reach'), DAYS, 'uniq'),
  tr('참여 계정', '좋아요·댓글·저장 등으로 반응한 계정 수 · 원값 비교', igv(x, 'accounts_engaged'), DAYS, 'uniq'),
  tr('총 상호작용', '좋아요+댓글+저장+공유 등 반응 합계', igv(x, 'total_interactions'), DAYS, 'sum'),
  tr('좋아요', '', igv(x, 'likes'), DAYS, 'sum'), tr('댓글', '', igv(x, 'comments'), DAYS, 'sum'),
  tr('저장', '', igv(x, 'saves'), DAYS, 'sum'), tr('공유', '', igv(x, 'shares'), DAYS, 'sum'),
  tr('프로필 조회', '프로필 화면을 연 횟수', igv(x, 'profile_views'), DAYS, 'sum'),
  tr('프로필 링크 클릭', '프로필의 외부 링크를 누른 횟수', igv(x, 'profile_links_taps'), DAYS, 'sum'),
  tr('팔로우', '새로 팔로우한 수(총량)', igv(x, 'follows'), DAYS, 'sum'), tr('언팔로우', '', igv(x, 'unfollows'), DAYS, 'sum'),
  tr('팔로워 순증', '팔로우 − 언팔로우 · 증감은 일평균 차이', igNet(x), DAYS, 'net'),
  tr('게시물 수', '피드·릴스 게시 수(스토리 제외)', igPosts(x), DAYS, 'sum'),
])}</details>`).join('');
const igSum = table('국가', IG.map((x) => tr(x.label, `@${esc(x.username)}`, igv(x, 'views'), DAYS, 'sum')).concat([tr('합계(조회)', '', igViews, DAYS, 'sum')]));

// ================= Threads =================
const TH = S.threads.filter((x) => !x.error);
const thv = (x, m) => MK.map((k) => x.months[k]?.[m] ?? null);
const thViews = MK.map((k) => sumBy(TH, (x) => x.months[k]?.views));
const thSent = [`9월 5개국 스레드 조회 합계는 ${nf(thViews[c])}회로 8월 일평균 대비 ${say(chg(thViews[c] / DAYS[c], thViews[b] / DAYS[b]))}입니다.`,
  `현재 팔로워는 ${TH.map((x) => `${x.label} ${nf(x.followers)}`).join(' · ')}명입니다.`];
{ const kr = TH.find((x) => x.label === 'KR'); if (kr) thSent.push(`KR 계정은 직접 올린 글 외에 다른 계정 글을 리포스트한 건수가 ${MK.map((k) => `${MN(k)} ${nf(kr.posts[k]?.reposts)}건`).join(' · ')}입니다.`); }
const thChart = bars(TH.map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.views, DAYS[i])) })), '일평균 조회(회)');
const thSum = table('국가', TH.map((x) => tr(x.label, `@${esc(x.username)} · 팔로워 ${nf(x.followers)}`, thv(x, 'views'), DAYS, 'sum')).concat([tr('합계(조회)', '', thViews, DAYS, 'sum')]));
const thTables = TH.map((x) => `<details${x.label === 'KR' ? ' open' : ''}><summary>${x.label} · @${esc(x.username)} · 현재 팔로워 ${nf(x.followers)}명</summary>${table('지표', [
  tr('조회', '게시물이 표시된 횟수', thv(x, 'views'), DAYS, 'sum'),
  tr('좋아요', '', thv(x, 'likes'), DAYS, 'sum'), tr('답글', '', thv(x, 'replies'), DAYS, 'sum'),
  tr('리포스트 받음', '다른 사람이 우리 글을 리포스트한 수', thv(x, 'reposts'), DAYS, 'sum'),
  tr('인용', '다른 사람이 우리 글을 인용한 수', thv(x, 'quotes'), DAYS, 'sum'),
  tr('직접 올린 글', '원글 수', MK.map((k) => x.posts[k]?.original ?? null), DAYS, 'sum'),
  tr('리포스트한 글', '우리 계정이 다른 글을 리포스트한 수', MK.map((k) => x.posts[k]?.reposts ?? null), DAYS, 'sum'),
])}</details>`).join('');

// ================= 요약 타일 =================
function tile(label, desc, vals, days, fmt = (v) => nf(v), noDelta) {
  const r = noDelta ? null : chg(perDay(vals[c], days[c]), perDay(vals[b], days[b]));
  const cls = r == null ? 'eq' : Math.abs(r) < 0.0005 ? 'eq' : r > 0 ? 'up' : 'dn';
  return `<div class="tile"><div class="k">${label}</div><div class="v">${fmt(vals[c])}</div><div class="d">${desc}</div><div class="d">8월 일평균 대비 <span class="dl ${cls}">${r == null ? '—' : `${r > 0 ? '▲' : r < 0 ? '▼' : '–'} ${Math.abs(r * 100).toFixed(1)}%`}</span></div></div>`;
}
const ytViews = MK.map((k) => sumBy(YT, (x) => x.months[k]?.views));
const ytDaysAll = YT[0] ? ytDays(YT[0]) : DAYS;
const tiles = [
  tile('홈페이지 접속 횟수', '6개국 합계 · GA4', gaSessions, DAYS),
  tile('문의', '예약·상담 등 핵심 이벤트 · 6개국', gaKe, DAYS),
  tile('구글 검색 클릭', `홈페이지 7곳 · 9/1~${gscLast.slice(5).replace('-', '/')}`, homeClicks, GD),
  nvKR ? tile('네이버 검색 클릭', '한국 사이트 · 서치어드바이저', nvv(nvKR, 'clicks'), DAYS) : '',
  tile('유튜브 조회수', `2개 채널 · 9/1~${ytLast.slice(5).replace('-', '/')}`, ytViews, ytDaysAll),
  tile('인스타그램 조회', '5개국 계정 합계', igViews, DAYS),
  tile('스레드 조회', '5개국 계정 합계', thViews, DAYS),
].join('');

// ================= 누락·주의 =================
const caveats = [
  `9월은 ${P[c].start.slice(5).replace('-', '/')}~${P[c].end.slice(5).replace('-', '/')}(${DAYS[c]}일)입니다. YouTube·Search Console은 집계가 2일 늦어 ${gscLast.slice(5).replace('-', '/')}까지(${GD[c]}일)만 반영했고, 증감은 각 소스의 실제 일수로 나눈 일평균으로 비교했습니다.`,
  `문의(GA4 핵심 이벤트)는 ${G.map((x) => `${x.label} ${x.key_events_from?.slice(5).replace('-', '/')}`).join(' · ')}부터 측정됐습니다. 7월은 일부 기간만 계측돼 7→8월 문의 증감은 표시하지 않았습니다.`,
  '사용자·도달·참여 계정처럼 사람(계정)을 한 번만 세는 지표는 날짜별로 더할 수 없어 일평균으로 바꾸지 않고 원값을 비교했습니다. 9월은 28일치라 이 지표들은 7·8월보다 낮게 나오는 방향으로 기울어 있습니다.',
  '인스타그램은 이번 회차부터 국가별 계정 토큰(graph.instagram.com)으로 집계했습니다. 지난 8/20 보고서는 다른 인증 경로를 써서 팔로워 등 일부 수치의 기준이 다르므로 두 보고서의 인스타 수치를 직접 비교하지 않습니다.',
  '홍콩(HK) 사이트는 GA4 속성과 네이버 서치어드바이저에 등록돼 있지 않아 Search Console 수치만 있습니다.',
  ...S.searchconsole.filter((x) => x.error).map((x) => `${x.label}(${x.url})은 Search Console 조회 권한이 없어 확인하지 못했습니다.`),
  '티스토리 블로그는 기존 방침대로 Search Console 집계에서 제외했습니다.',
  '네이버 수치는 로그인된 서치어드바이저 콘솔의 최근 90일(7/1~9/28) 일별 기록을 월별로 합산했습니다. 상위 검색어는 3개월 누적이며 월별로는 제공되지 않습니다.',
];
{ const en = IG.find((x) => x.label === 'EN'); if (en && en.months[MK[a]]?.reach > en.months[MK[a]]?.views) caveats.push(`EN 인스타그램 7월은 도달(${nf(en.months[MK[a]].reach)})이 조회(${nf(en.months[MK[a]].views)})보다 큽니다. API 응답을 그대로 실었고 원인은 확인하지 못했습니다.`); }
if (TH.every((x) => MK.every((k) => !x.months[k]?.quotes))) caveats.push('스레드 인용은 5개국 3개월 모두 0으로 응답했습니다. 실제 0인지 미집계인지는 확인하지 못했습니다.');

// ================= 페이지 =================
const sec = (id, title, sub, sentences, body) => `<section id="${id}"><h2>${title}</h2><p class="sub">${sub}</p>${sentences.length ? `<ul class="facts">${sentences.map((s) => `<li>${s}</li>`).join('')}</ul>` : ''}${body}</section>`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>뷰티블라썸 월간 성과보고서 · ${P[0].start.slice(0, 4)}년 ${MN(MK[0])}~${MN(MK.at(-1))}</title><meta name="robots" content="noindex">
<meta name="description" content="${P.map((p) => MN(p.key) + (p.end.slice(8) !== String(new Date(Date.UTC(+p.key.slice(0, 4), +p.key.slice(5), 0)).getUTCDate()) ? `(1~${Number(p.end.slice(8))}일)` : '')).join(' · ')} 월별 비교 · GA4·구글·네이버 검색·유튜브·인스타·스레드">
<style>
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--up:#c62828;--dn:#1f5fb4;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a}
:root[data-theme="dark"]{--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--up:#ff6b6b;--dn:#6ea8ff;--s1:#3987e5;--s2:#d95926;--s3:#199e70}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--up:#ff6b6b;--dn:#6ea8ff;--s1:#3987e5;--s2:#d95926;--s3:#199e70}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;font-size:14px;line-height:1.6}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}header{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:space-between}
h1{font-size:26px;margin:0;letter-spacing:-.01em}h2{font-size:19px;margin:44px 0 2px}h3{font-size:14px;margin:22px 0 8px;color:var(--ink)}
.sub{color:var(--ink2);font-size:13px;margin:2px 0 10px}.muted{color:var(--muted);font-weight:400}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px}nav a{font-size:12px;padding:4px 10px;border:1px solid var(--ring);border-radius:999px;text-decoration:none;color:var(--ink2)}
.read{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:12px 16px;margin-top:14px;font-size:13px;color:var(--ink2)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:16px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px}.tile .k{font-size:13px;font-weight:600}
.tile .v{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:2px}.tile .d{font-size:12px;color:var(--ink2)}
.facts{margin:6px 0 14px;padding-left:18px}.facts li{margin:3px 0}
.chart{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px;margin:10px 0}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--ink2);margin-bottom:6px}.legend span{display:inline-flex;align-items:center;gap:6px}.lu{margin-left:auto}
.dot{width:10px;height:10px;border-radius:3px;display:inline-block}
svg{display:block;width:100%;height:auto}.gl{stroke:var(--grid);stroke-width:1}.bl{stroke:var(--axis);stroke-width:1}.ax{fill:var(--muted);font-size:12px}.ax.lb{fill:var(--ink2);font-size:13px}
svg path{stroke:var(--surface);stroke-width:1}svg path:hover{opacity:.82}
.tw{overflow-x:auto;background:var(--surface);border:1px solid var(--ring);border-radius:12px;margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:right;padding:8px 12px;border-bottom:1px solid var(--grid);font-variant-numeric:tabular-nums;vertical-align:top}
th:first-child,td:first-child{text-align:left}th{color:var(--ink2);font-weight:600;font-size:12px}th small{display:block;font-weight:400;color:var(--muted)}
tbody tr:last-child td{border-bottom:0}td.na{color:var(--muted)}.ds{display:block;font-size:11px;color:var(--muted);font-weight:400}.pd{display:block;font-size:11px;color:var(--muted)}
.dl{font-size:12px;font-weight:650;white-space:nowrap}.dl.up{color:var(--up)}.dl.dn{color:var(--dn)}.dl.eq{color:var(--muted);font-weight:500}
details{margin:8px 0}summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--ink2);padding:4px 0}
.cav{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:12px 16px 12px 32px}.cav li{margin:4px 0;font-size:13px;color:var(--ink2)}
button.theme{background:var(--surface);border:1px solid var(--ring);color:var(--ink2);border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit;font-size:12px}
.tt{position:fixed;pointer-events:none;background:var(--surface);border:1px solid var(--ring);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.13);opacity:0;transition:opacity .1s;z-index:50}
a{color:inherit}footer{margin-top:40px;font-size:12px;color:var(--muted)}
</style></head><body><div class="wrap">
<header><div><h1>뷰티블라썸 월간 성과보고서</h1><p class="sub">2026년 7월 · 8월 · 9월(1~28일) 비교 · 발행 ${PUB} · <a href="../../">지난 보고서 목록</a></p></div><button class="theme" id="tg">밝게/어둡게</button></header>
<nav><a href="#home">홈페이지</a><a href="#google">구글 검색</a><a href="#naver">네이버 검색</a><a href="#youtube">유튜브</a><a href="#instagram">인스타그램</a><a href="#threads">스레드</a><a href="#notes">기준·미확인</a></nav>
<div class="read"><b>읽는 법</b> — 달마다 일수가 달라(7월 31일 · 8월 31일 · 9월 ${DAYS[c]}일) 증감은 <b>일평균(합계 ÷ 일수)</b>으로 전월과 비교했습니다. 값 옆 <span class="dl up">▲</span>는 증가, <span class="dl dn">▼</span>는 감소입니다. 표의 작은 회색 글씨 "일 N"이 그 달의 일평균입니다.</div>
<div class="tiles">${tiles}</div>
${sec('home', '홈페이지 (GA4)', '6개국 홈페이지 접속·문의. 문의 = 예약·상담 버튼 클릭 등 GA4에 핵심 이벤트로 등록된 행동', gaSent,
  `${gaChart}<h3>국가별 접속 횟수 <span class="muted">· 홈페이지에 들어와 머문 방문 1회 단위</span></h3>${gaTable}<h3>국가별 문의 <span class="muted">· 7→8월 증감은 측정 시작 효과로 비교 제외</span></h3>${gaKeTable}<h3>문의 전환율 <span class="muted">· 문의 ÷ 접속 횟수</span></h3>${gaRateTable}<h3>유입 경로 <span class="muted">· 어디를 거쳐 들어왔는지</span></h3>${gaChTable}${gaDetail}`)}
${sec('google', '구글 검색 (Search Console)', `구글 검색 결과에서의 노출·클릭. 9월은 ${gscLast.slice(5).replace('-', '/')}까지(${GD[c]}일)`, gscSent,
  `${gscChart}<h3>홈페이지 7곳 클릭</h3>${gscHomeTable}${gscDetail}<h3>블로그 클릭</h3>${gscBlogTable}<h3>상위 검색어</h3>${gscQueries}`)}
${sec('naver', '네이버 검색 (서치어드바이저)', '네이버 검색 결과에서의 노출·클릭', nvSent, `${nvTable}${nvKrTable}${nvQ}`)}
${sec('youtube', '유튜브', `YouTube Analytics 기준. 9월은 ${ytLast.slice(5).replace('-', '/')}까지(${ytDaysAll[c]}일)`, ytSent, `${ytChart}${ytTables}`)}
${sec('instagram', '인스타그램', '국가별 계정 인사이트. 이번 회차부터 새로 추가한 지표 포함(참여 계정·총 상호작용·프로필 링크 클릭 등)', igSent, `${igChart}${igSum}${igTables}`)}
${sec('threads', '스레드', '이번 회차에 새로 추가한 채널. 국가별 계정 인사이트', thSent, `${thChart}${thSum}${thTables}`)}
<section id="notes"><h2>기준·미확인 항목</h2><ul class="cav">${caveats.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
<footer>수집 ${D.generated_at_utc.slice(0, 16).replace('T', ' ')} UTC · 원자료 <a href="data.json">data.json</a> · GA4 · Search Console · 네이버 서치어드바이저 · YouTube Analytics · Instagram · Threads</footer>
</div><div class="tt" id="tt"></div>
<script>
(function(){var r=document.documentElement,k='bb-theme';try{var s=localStorage.getItem(k);if(s)r.setAttribute('data-theme',s)}catch(e){}
document.getElementById('tg').onclick=function(){var d=r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var n=d==='dark'?'light':'dark';r.setAttribute('data-theme',n);try{localStorage.setItem(k,n)}catch(e){}};
var t=document.getElementById('tt');document.addEventListener('mousemove',function(e){var el=e.target.closest&&e.target.closest('[data-tt]');if(!el){t.style.opacity=0;return}t.innerHTML=el.getAttribute('data-tt');t.style.opacity=1;var x=e.clientX+14,y=e.clientY+14;if(x+t.offsetWidth>innerWidth-8)x=e.clientX-t.offsetWidth-14;t.style.left=x+'px';t.style.top=y+'px'});})();
</script></body></html>`;

const outDir = join(ROOT, 'r', PUB);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html, 'utf8');
writeFileSync(join(outDir, 'data.json'), JSON.stringify(D, null, 1), 'utf8');
console.log(`WROTE r/${PUB}/index.html ${(html.length / 1024).toFixed(1)} KB  + data.json`);
