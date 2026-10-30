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
const nf = (v, d = 0) => (v == null || Number.isNaN(v) ? '-' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null ? '-' : `${(v * 100).toFixed(d)}%`);
const dur = (s) => (s == null ? '-' : `${Math.floor(s / 60)}분 ${String(Math.round(s % 60)).padStart(2, '0')}초`);
function badge(cur, prev, mode = 'ratio') {
  if (cur == null || prev == null) return '';
  let t, dir;
  if (mode === 'ratio') { if (!prev) return ''; const r = cur / prev - 1; dir = Math.abs(r) < 0.0005 ? 0 : Math.sign(r); t = `${Math.abs(r * 100).toFixed(1)}%`; }
  else if (mode === 'pp') { const r = (cur - prev) * 100; dir = Math.abs(r) < 0.05 ? 0 : Math.sign(r); t = `${Math.abs(r).toFixed(1)}%p`; }
  else if (mode === 'perday') { const r = cur - prev; dir = Math.abs(r) < 0.05 ? 0 : Math.sign(r); t = `일 ${Math.abs(r).toFixed(1)}`; }
  else { const r = cur - prev; dir = Math.abs(r) < 0.05 ? 0 : Math.sign(r); t = `${Math.abs(r).toFixed(1)}`; }
  const sym = dir > 0 ? '▲' : dir < 0 ? '▼' : '-';
  return ` <span class="dl ${dir > 0 ? 'up' : dir < 0 ? 'dn' : 'eq'}">${sym} ${t}</span>`;
}
const sumDays = (src, k) => src?.[k] ?? P.find((p) => p.key === k).days;

// 한 행 = 한 지표/한 대상. kind: sum(일평균 비교) | uniq(원값 비교) | rate(%p) | pos(차이) | dur(초, 원값 비교)

// 지표 × 국가 표: 칸마다 이번 달 값과 전월 대비(비교 규칙은 아래 delta). 3개월 값은 data.json 에 있다.
const fmtK = (kind, v) => (kind === 'rate' ? pct(v) : kind === 'pos' ? nf(v, 1) : kind === 'dur' ? dur(v) : nf(v));
// 전월 대비: 합계는 일평균 비율, 순증은 일평균 차이, 고유 수·시간은 원값 비율, 비율은 %p, 순위는 숫자 차이
function delta(kind, vals, days) {
  const v = vals[c], pv = vals[b];
  if (v == null || pv == null) return '';
  if (kind === 'sum') return badge(days[c] ? v / days[c] : null, days[b] ? pv / days[b] : null, 'ratio');
  if (kind === 'net') return badge(days[c] ? v / days[c] : null, days[b] ? pv / days[b] : null, 'perday');
  if (kind === 'uniq' || kind === 'dur') return badge(v, pv, 'ratio');
  if (kind === 'rate') return badge(v, pv, 'pp');
  if (kind === 'pos') return badge(v, pv, 'diff');
  return '';
}
function cellC(vals, days, kind, na) {
  const v = vals[c];
  if (v == null) return `<td class="na">${na?.[c] ?? '-'}</td>`;
  return `<td>${fmtK(kind, v)}${delta(kind, vals, days)}</td>`;
}
const matrix = (ents, rows) => `<div class="tw"><table class="mx"><thead><tr><th>지표</th>${ents.map((e) => `<th>${esc(e.label)}${e.sub ? `<small>${esc(e.sub)}</small>` : ''}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><td><b>${r.label}</b>${r.desc ? `<span class="ds">${r.desc}</span>` : ''}</td>${ents.map((e) => cellC(r.v(e.x), r.d(e.x), r.kind, r.na?.(e.x))).join('')}</tr>`).join('')}</tbody></table></div>`;
const mxHead = (title) => `<h3>${title} <span class="muted">· ${MCd()} 값 · 아래 표시는 ${MB} 대비</span></h3>`;
// 검색어 카드: 막대 = 클릭 수, 카드마다 1위 검색어를 기준 길이로 둔다. 마우스를 올리면 노출·클릭률·순위.
const qCard = (title, sub, rows) => {
  const mx = Math.max(...rows.map((r) => r.clicks), 1);
  return `<div class="qc"><div class="qh"><b>${esc(title)}</b><span class="muted">${esc(sub)}</span></div><div class="qr qk"><span>검색어</span><span></span><span>클릭</span><span>순위</span></div>${rows.length ? rows.map((r) => `<div class="qr" data-tt="${esc(`<b>${esc(r.query)}</b><br>클릭 ${nf(r.clicks)} · 노출 ${nf(r.impressions)}<br>클릭률 ${r.ctr} · 평균 순위 ${nf(r.rank, 1)}`)}"><span class="qt">${esc(r.query)}</span><span class="qb"><i style="width:${(r.clicks / mx * 100).toFixed(1)}%"></i></span><span class="qv">${nf(r.clicks)}</span><span class="qp">${nf(r.rank, 1)}</span></div>`).join('') : '<div class="qr"><span class="qt muted">검색어 없음</span></div>'}</div>`;
};

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
      if (v == null) { s += `<text x="${x + bw / 2}" y="${H - B - 4}" class="ax" text-anchor="middle">-</text>`; return; }
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
// 월 이름: 첫 달(MA)·전월(MB)·이번 달(MC). 이번 달이 말일 전에 끝나면 "10월(1~29일)"처럼 붙인다.
const [MA, MB, MC] = [a, b, c].map((i) => MN(MK[i]));
const monthEnd = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5), 0)).getUTCDate();
const MCd = (last = P[c].end) => { const e = Number((last < P[c].end ? last : P[c].end).slice(8)); return e === monthEnd(MK[c]) ? MC : `${MC}(1~${e}일)`; };
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

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
// 속성이 기간 중간에 생긴 국가는 첫 데이터일부터 일수를 센다(합계 행은 각 달 전체 일수).
const gaFirst = (x) => x.daily?.[0]?.date;
const gaDays = (x) => P.map((p, i) => { const f = gaFirst(x); if (!f || f <= p.start) return DAYS[i]; if (f > p.end) return 0; return Math.round((Date.parse(p.end) - Date.parse(f)) / 86400000) + 1; });
const gaNa = (x) => gaDays(x).map((d) => (d ? null : '수집 전'));
const gaLate = G.filter((x) => gaFirst(x) > P[a].start);
const keFrom = G.map((r) => r.key_events_from).filter(Boolean).sort().at(-1);
// 문의는 2026-07-14(JP·CN 7/15)부터 측정됐다. 첫 달이 그 날짜에 걸치면 첫 달 문의는 부분 측정이라 첫 달→둘째 달 증감을 숨긴다.
const KE_START = '2026-07-14';
const kePartial = P[a].start < KE_START && P[a].end >= KE_START;

const gaSessions = gTot('sessions'), gaKe = gTot('keyEvents');
const gaRate = MK.map((k, i) => (gaSessions[i] ? gaKe[i] / gaSessions[i] : null));
const gaSent = [];
{
  const r = chg(perDay(gaSessions[c], DAYS[c]), perDay(gaSessions[b], DAYS[b]));
  gaSent.push(`${MCd()} ${G.length}개국 홈페이지 접속 횟수는 ${nf(gaSessions[c])}회(일평균 ${nf(gaSessions[c] / DAYS[c])}회)이며 ${MB} 일평균 ${nf(gaSessions[b] / DAYS[b])}회 대비 ${say(r)}입니다.`);
  const byC = G.map((x) => ({ l: x.label, r: chg(perDay(x.months[MK[c]]?.sessions, gaDays(x)[c]), perDay(x.months[MK[b]]?.sessions, gaDays(x)[b])) })).filter((x) => x.r != null).sort((p, q) => q.r - p.r);
  if (byC.length) gaSent.push(`일평균 접속 증감 폭은 ${byC[0].l}(${say(byC[0].r)})가 가장 크게 늘었고 ${byC.at(-1).l}(${say(byC.at(-1).r)})가 ${byC.at(-1).r < 0 ? '가장 크게 줄었습니다' : '가장 적게 늘었습니다'}.`);
  const rk = chg(perDay(gaKe[c], DAYS[c]), perDay(gaKe[b], DAYS[b]));
  gaSent.push(`${MCd()} 문의는 ${nf(gaKe[c])}건(일평균 ${nf(gaKe[c] / DAYS[c], 1)}건)으로 ${MB} 일평균 대비 ${say(rk)}입니다. 문의 전환율은 ${MB} ${pct(gaRate[b])}, ${MC} ${pct(gaRate[c])}입니다.`);
}
const gaChart = bars(G.map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.sessions, gaDays(x)[i])) })), '일평균 접속 횟수(회)');
// 첫 달이 부분 측정이면 그 달 문의 일평균은 측정 시작일부터의 일수로 나눈다(31일로 나누면 낮게 보인다).
const keDays = (from) => P.map((p, i) => (kePartial && from && from > p.start && from <= p.end ? Math.round((Date.parse(p.end) - Date.parse(from)) / 86400000) + 1 : DAYS[i]));
// 첫 달이 부분 측정이면 그 달 전환율은 표시하지 않는다.
const rateNa = kePartial ? { na: ['부분 측정', null, null] } : {};
const gaDetail = `${mxHead('국가별 상세 지표')}${matrix(G.map((x) => ({ label: x.label, sub: gaFirst(x) > P[a].start ? `${md(gaFirst(x))}부터` : '', x })), [
  { label: '접속 횟수', desc: '홈페이지에 들어와 머문 방문 1회 단위', kind: 'sum', v: (x) => gv(x, 'sessions'), d: gaDays, na: gaNa },
  { label: '사용자', desc: '한 번 이상 들어온 사람 수 · 원값 비교', kind: 'uniq', v: (x) => gv(x, 'activeUsers'), d: gaDays, na: gaNa },
  { label: '신규 사용자', desc: '처음 들어온 사람 수 · 원값 비교', kind: 'uniq', v: (x) => gv(x, 'newUsers'), d: gaDays, na: gaNa },
  { label: '페이지 조회', desc: '열어 본 페이지 수', kind: 'sum', v: (x) => gv(x, 'screenPageViews'), d: gaDays, na: gaNa },
  { label: '문의', desc: '예약·상담 등 GA4 핵심 이벤트', kind: 'sum', v: (x) => gv(x, 'keyEvents'), d: gaDays, na: gaNa },
  { label: '문의 전환율', desc: '문의 ÷ 접속 횟수', kind: 'rate', v: (x) => MK.map((k) => (x.months[k]?.sessions ? x.months[k].keyEvents / x.months[k].sessions : null)), d: gaDays, na: gaNa },
  { label: '참여율', desc: '10초 이상 머물거나 2페이지 이상 본 접속 비율', kind: 'rate', v: (x) => gv(x, 'engagementRate'), d: gaDays, na: gaNa },
  { label: '이탈률', desc: '참여 없이 나간 접속 비율', kind: 'rate', v: (x) => gv(x, 'bounceRate'), d: gaDays, na: gaNa },
  { label: '평균 체류 시간', desc: '접속 1회당 머문 시간', kind: 'dur', v: (x) => gv(x, 'averageSessionDuration'), d: gaDays, na: gaNa },
])}`;
// 유입 경로 (국가 합)
const chAgg = {};
for (const x of G) for (const k of MK) for (const [n, v] of Object.entries(x.channels[k] || {})) { chAgg[n] ??= {}; chAgg[n][k] ??= { sessions: 0, keyEvents: 0 }; chAgg[n][k].sessions += v.sessions; chAgg[n][k].keyEvents += v.keyEvents; }

// ================= Search Console =================
const GS = S.searchconsole;
const gscLast = GS.map((x) => x.last_date).filter(Boolean).sort()[0];
const GD = lastDays(gscLast);
const gsv = (x, m) => MK.map((k) => (x.error ? null : x.months[k]?.[m] ?? null));
const homes = GS.filter((x) => x.group === 'home'), blogs = GS.filter((x) => x.group === 'blog');
const homeClicks = MK.map((k) => sumBy(homes.filter((x) => !x.error), (x) => x.months[k]?.clicks));
const homeImpr = MK.map((k) => sumBy(homes.filter((x) => !x.error), (x) => x.months[k]?.impressions));
const gscSent = [`${MCd(gscLast)} 홈페이지 7곳의 구글 검색 클릭은 ${nf(homeClicks[c])}회로 ${MB} 일평균 대비 ${say(chg(homeClicks[c] / GD[c], homeClicks[b] / GD[b]))}, 노출은 ${nf(homeImpr[c])}회로 ${say(chg(homeImpr[c] / GD[c], homeImpr[b] / GD[b]))}입니다.`];
const gscChart = bars(homes.filter((x) => !x.error).map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.clicks, GD[i])) })), '일평균 검색 클릭(회)');
const gscDetail = `${mxHead('사이트별 클릭·노출·클릭률·순위')}${matrix(homes.filter((x) => !x.error).map((x) => ({ label: x.label, x })), [
  { label: '클릭', desc: '검색 결과에서 눌러 들어온 수', kind: 'sum', v: (x) => gsv(x, 'clicks'), d: () => GD },
  { label: '노출', desc: '검색 결과에 보인 횟수', kind: 'sum', v: (x) => gsv(x, 'impressions'), d: () => GD },
  { label: '클릭률', desc: '노출 대비 클릭 비율', kind: 'rate', v: (x) => gsv(x, 'ctr'), d: () => GD },
  { label: '평균 순위', desc: '작을수록 상단 · 증감은 순위 숫자 변화', kind: 'pos', v: (x) => gsv(x, 'position'), d: () => GD },
])}`;
const gscQueries = `<div class="qg">${homes.filter((x) => !x.error).map((x) => qCard(x.label, `${MCd(gscLast)} 상위 ${x.top_queries.length}개`, x.top_queries.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: pct(q.ctr), rank: q.position })))).join('')}</div>`;

// ================= 네이버 =================
const NV = S.naver || [];
const NO = NV.filter((x) => x.status === 'OK');
const nvv = (x, m) => MK.map((k) => x.months?.[k]?.[m] ?? null);
const nvKR = NO.find((x) => x.label === 'KR');
const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const nvSent = nvKR ? [`${MCd()} 한국 사이트 네이버 검색 클릭은 ${nf(nvKR.months[MK[c]].clicks)}회로 ${MB} 일평균 대비 ${say(chg(nvKR.months[MK[c]].clicks / DAYS[c], nvKR.months[MK[b]].clicks / DAYS[b]))}, 노출은 ${nf(nvKR.months[MK[c]].impressions)}회로 ${say(chg(nvKR.months[MK[c]].impressions / DAYS[c], nvKR.months[MK[b]].impressions / DAYS[b]))}입니다.`,
  `해외 사이트(${NO.filter((x) => x.label !== 'KR').map((x) => x.label).join('·')})의 네이버 노출은 월 ${nf(Math.max(...NO.filter((x) => x.label !== 'KR').flatMap((x) => nvv(x, 'impressions'))))}회 이하입니다.`] : [];
const nvQ = nvKR ? `<h3>한국 사이트 상위 검색어 <span class="muted">· ${md(ymd(nvKR.first))}~${md(ymd(nvKR.last))} 최근 90일 누적 · 막대는 클릭 수</span></h3><div class="qg">${qCard('KR 네이버', `상위 ${nvKR.top_queries_90d.length}개`, nvKR.top_queries_90d.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: `${nf(q.ctr, 1)}%`, rank: q.rank })))}</div>` : '';

// ================= YouTube =================
const YT = S.youtube.filter((x) => !x.error);
// 채널 시작 전 날짜는 API가 0으로 돌려주므로, 첫 데이터일 이후만 일수로 센다.
const ytDays = (x) => P.map((p) => (x.daily || []).filter((d) => d.date >= p.start && d.date <= p.end && d.date >= (x.first_date || p.start)).length);
const ytv = (x, m) => { const d = ytDays(x); return MK.map((k, i) => (d[i] ? x.months[k][m] : null)); };
const ytNet = (x) => { const d = ytDays(x); return MK.map((k, i) => (d[i] ? x.months[k].gain - x.months[k].lost : null)); };
const ytLast = YT.map((x) => x.last_date).sort()[0];
const ytSent = YT.map((x) => { const d = ytDays(x); const v = ytv(x, 'views'); return `${x.short}: ${MCd(ytLast)} 조회수 ${nf(v[c])}회, ${MB} 일평균 대비 ${say(chg(perDay(v[c], d[c]), perDay(v[b], d[b])))}${x.first_date > P[0].start ? ` (채널 첫 데이터 ${md(x.first_date)})` : ''}.`; });

// ================= Instagram =================
const IG = S.instagram.filter((x) => !x.error);
const igv = (x, m) => MK.map((k) => x.months[k]?.[m] ?? null);
const igNet = (x) => MK.map((k) => (x.months[k]?.follows == null ? null : x.months[k].follows - x.months[k].unfollows));
const igPosts = (x) => MK.map((k) => x.posts?.[k]?.total ?? 0);
const igViews = MK.map((k) => sumBy(IG, (x) => x.months[k]?.views));
const igInter = MK.map((k) => sumBy(IG, (x) => x.months[k]?.total_interactions));
const igSent = [`${MCd()} 5개국 계정 합계 조회는 ${nf(igViews[c])}회로 ${MB} 일평균 대비 ${say(chg(igViews[c] / DAYS[c], igViews[b] / DAYS[b]))}, 총 상호작용은 ${nf(igInter[c])}회로 ${say(chg(igInter[c] / DAYS[c], igInter[b] / DAYS[b]))}입니다.`,
  `현재 팔로워는 ${IG.map((x) => `${x.label} ${nf(x.followers)}`).join(' · ')}명입니다.`];
const igChart = bars(IG.map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.views, DAYS[i])) })), '일평균 조회(회)');
const igTables = `${mxHead('국가별 상세 지표')}${matrix(IG.map((x) => ({ label: x.label, sub: `팔로워 ${nf(x.followers)}`, x })), [
  { label: '조회', desc: '게시물·릴스·스토리가 표시·재생된 횟수', kind: 'sum', v: (x) => igv(x, 'views'), d: () => DAYS },
  { label: '도달', desc: '콘텐츠를 본 계정 수 · 원값 비교', kind: 'uniq', v: (x) => igv(x, 'reach'), d: () => DAYS },
  { label: '참여 계정', desc: '반응한 계정 수 · 원값 비교', kind: 'uniq', v: (x) => igv(x, 'accounts_engaged'), d: () => DAYS },
  { label: '총 상호작용', desc: '좋아요+댓글+저장+공유 등', kind: 'sum', v: (x) => igv(x, 'total_interactions'), d: () => DAYS },
  { label: '좋아요', desc: '', kind: 'sum', v: (x) => igv(x, 'likes'), d: () => DAYS },
  { label: '댓글', desc: '', kind: 'sum', v: (x) => igv(x, 'comments'), d: () => DAYS },
  { label: '저장', desc: '', kind: 'sum', v: (x) => igv(x, 'saves'), d: () => DAYS },
  { label: '공유', desc: '', kind: 'sum', v: (x) => igv(x, 'shares'), d: () => DAYS },
  { label: '프로필 조회', desc: '프로필 화면을 연 횟수', kind: 'sum', v: (x) => igv(x, 'profile_views'), d: () => DAYS },
  { label: '프로필 링크 클릭', desc: '프로필의 외부 링크를 누른 횟수', kind: 'sum', v: (x) => igv(x, 'profile_links_taps'), d: () => DAYS },
  { label: '팔로우', desc: '새로 팔로우한 수', kind: 'sum', v: (x) => igv(x, 'follows'), d: () => DAYS },
  { label: '언팔로우', desc: '', kind: 'sum', v: (x) => igv(x, 'unfollows'), d: () => DAYS },
  { label: '팔로워 순증', desc: '팔로우 − 언팔로우 · 증감은 일평균 차이', kind: 'net', v: igNet, d: () => DAYS },
  { label: '게시물 수', desc: '피드·릴스(스토리 제외)', kind: 'sum', v: igPosts, d: () => DAYS },
])}`;

// ================= Threads =================
const TH = S.threads.filter((x) => !x.error);
const thv = (x, m) => MK.map((k) => x.months[k]?.[m] ?? null);
const thViews = MK.map((k) => sumBy(TH, (x) => x.months[k]?.views));
const thSent = [`${MCd()} 5개국 스레드 조회 합계는 ${nf(thViews[c])}회로 ${MB} 일평균 대비 ${say(chg(thViews[c] / DAYS[c], thViews[b] / DAYS[b]))}입니다.`,
  `현재 팔로워는 ${TH.map((x) => `${x.label} ${nf(x.followers)}`).join(' · ')}명입니다.`];
{ const kr = TH.find((x) => x.label === 'KR'); if (kr) thSent.push(`KR 계정은 직접 올린 글 외에 다른 계정 글을 리포스트한 건수가 ${MK.map((k) => `${MN(k)} ${nf(kr.posts[k]?.reposts)}건`).join(' · ')}입니다.`); }
const thChart = bars(TH.map((x) => ({ name: x.label, vals: MK.map((k, i) => perDay(x.months[k]?.views, DAYS[i])) })), '일평균 조회(회)');
const thTables = `${mxHead('국가별 상세 지표')}${matrix(TH.map((x) => ({ label: x.label, sub: `팔로워 ${nf(x.followers)}`, x })), [
  { label: '조회', desc: '게시물이 표시된 횟수', kind: 'sum', v: (x) => thv(x, 'views'), d: () => DAYS },
  { label: '좋아요', desc: '', kind: 'sum', v: (x) => thv(x, 'likes'), d: () => DAYS },
  { label: '답글', desc: '', kind: 'sum', v: (x) => thv(x, 'replies'), d: () => DAYS },
  { label: '리포스트 받음', desc: '다른 사람이 우리 글을 리포스트한 수', kind: 'sum', v: (x) => thv(x, 'reposts'), d: () => DAYS },
  { label: '인용', desc: '다른 사람이 우리 글을 인용한 수', kind: 'sum', v: (x) => thv(x, 'quotes'), d: () => DAYS },
  { label: '직접 올린 글', desc: '원글 수', kind: 'sum', v: (x) => MK.map((k) => x.posts[k]?.original ?? null), d: () => DAYS },
  { label: '리포스트한 글', desc: '우리 계정이 다른 글을 리포스트한 수', kind: 'sum', v: (x) => MK.map((k) => x.posts[k]?.reposts ?? null), d: () => DAYS },
])}`;

// ================= 요약 타일 =================
function tile(label, desc, vals, days, fmt = (v) => nf(v), noDelta) {
  const r = noDelta ? null : chg(perDay(vals[c], days[c]), perDay(vals[b], days[b]));
  const cls = r == null ? 'eq' : Math.abs(r) < 0.0005 ? 'eq' : r > 0 ? 'up' : 'dn';
  return `<div class="tile"><div class="k">${label}</div><div class="v">${fmt(vals[c])}</div><div class="d">${desc}</div><div class="d">${MB} 일평균 대비 <span class="dl ${cls}">${r == null ? '-' : `${r > 0 ? '▲' : r < 0 ? '▼' : '-'} ${Math.abs(r * 100).toFixed(1)}%`}</span></div></div>`;
}
const ytViews = MK.map((k) => sumBy(YT, (x) => x.months[k]?.views));
const ytDaysAll = YT[0] ? ytDays(YT[0]) : DAYS;
const tiles = [
  tile('홈페이지 접속 횟수', `${G.length}개국 합계 · GA4`, gaSessions, DAYS),
  tile('문의', `예약·상담 등 핵심 이벤트 · ${G.length}개국`, gaKe, DAYS),
  tile('구글 검색 클릭', `홈페이지 7곳 · ${md(P[c].start)}~${md(gscLast)}`, homeClicks, GD),
  nvKR ? tile('네이버 검색 클릭', '한국 사이트 · 서치어드바이저', nvv(nvKR, 'clicks'), DAYS) : '',
  tile('유튜브 조회수', `2개 채널 · ${md(P[c].start)}~${md(ytLast)}`, ytViews, ytDaysAll),
  tile('인스타그램 조회', '5개국 계정 합계', igViews, DAYS),
  tile('스레드 조회', '5개국 계정 합계', thViews, DAYS),
].join('');

// ================= 이번 달 주요 성과 (담당자 확인 · data.json highlights) =================
const HL = D.highlights || [];
const hlSec = HL.length ? `<section id="highlights" data-c="${['ALL', ...new Set(HL.flatMap((h) => h.c || []))].join(' ')}"><h2>${MC} 주요 성과</h2><p class="sub">수치 표 밖에서 확인한 이번 달 성과입니다</p>${HL.map((h) => `<div class="hl" data-c="${['ALL', ...(h.c || [])].join(' ')}"><h3>${esc(h.title)}${h.date ? ` <span class="muted">· ${esc(h.date)}</span>` : ''}</h3>${(h.facts || []).length ? `<ul class="facts">${h.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}${(h.images || []).map((im) => `<figure><img src="${esc(im.src)}" alt="${esc(im.caption)}" loading="lazy"><figcaption>${esc(im.caption)}</figcaption></figure>`).join('')}</div>`).join('')}</section>` : '';

// ================= 누락·주의 =================
const caveats = [
  `${MC}은 ${md(P[c].start)}~${md(P[c].end)}(${DAYS[c]}일)입니다. YouTube·Search Console은 집계가 2일 늦어 ${md(gscLast)}까지(${GD[c]}일)만 반영했습니다. 증감은 각 소스의 실제 일수로 나눈 일평균으로 비교했습니다.`,
  kePartial
    ? `문의(GA4 핵심 이벤트)는 ${G.map((x) => `${x.label} ${x.key_events_from?.slice(5).replace('-', '/')}`).join(' · ')}부터 측정됐습니다. ${MA}은 일부 기간만 계측돼 ${MA}→${MB} 문의 증감은 표시하지 않았습니다.`
    : `문의(GA4 핵심 이벤트)는 2026년 7월 중순부터 측정돼 ${MA}~${MC} 모두 같은 기준입니다.`,
  `사용자·도달·참여 계정처럼 사람(계정)을 한 번만 세는 지표는 날짜별로 더할 수 없어 일평균으로 바꾸지 않고 원값을 비교했습니다.${DAYS[c] < monthEnd(MK[c]) ? ` ${MC}은 ${DAYS[c]}일치라 이 지표들은 ${MA}·${MB}보다 낮게 나오는 방향으로 기울어 있습니다.` : ''}`,
  '인스타그램은 국가별 계정 토큰(graph.instagram.com)으로 집계했습니다. 8/20 보고서는 인증 경로가 달라 인스타 수치를 직접 비교하지 않습니다.',
  ...gaLate.map((x) => `${x.label} 홈페이지는 GA4 수집이 ${md(gaFirst(x))}부터라 국가별 일평균을 그날부터의 일수로 나눴습니다. 합계 행은 각 달 전체 일수로 나눴습니다.`),
  G.some((x) => x.label === 'HK') ? '' : '홍콩(HK) 사이트는 GA4 수치를 수집하지 않았습니다.',
  NV.find((x) => x.label === 'HK')?.status === 'NO_DATA' ? '홍콩(HK) 사이트는 네이버 서치어드바이저에 등록돼 있으나 최근 90일 노출 기록이 없습니다.' : '',
  ...S.searchconsole.filter((x) => x.error).map((x) => `${x.label}(${x.url})은 Search Console 조회 권한이 없어 확인하지 못했습니다.`),
  '티스토리 블로그는 기존 방침대로 Search Console 집계에서 제외했습니다.',
  nvKR ? `네이버 수치는 로그인된 서치어드바이저 콘솔의 최근 90일(${md(ymd(nvKR.first))}~${md(ymd(nvKR.last))}) 일별 기록을 월별로 합산했습니다. 상위 검색어는 90일 누적이며 월별로는 제공되지 않습니다.` : '',
].filter(Boolean);
{ const en = IG.find((x) => x.label === 'EN'); if (en && en.months[MK[a]]?.reach > en.months[MK[a]]?.views) caveats.push(`EN 인스타그램 ${MA}은 도달(${nf(en.months[MK[a]].reach)})이 조회(${nf(en.months[MK[a]].views)})보다 큽니다. API 응답을 그대로 실었고 원인은 확인하지 못했습니다.`); }
if (TH.every((x) => MK.every((k) => !x.months[k]?.quotes))) caveats.push('스레드 인용은 5개국 3개월 모두 0으로 응답했습니다. 실제 0인지 미집계인지는 확인하지 못했습니다.');

// ================= 선차트 카드 =================
// 일별 기록이 있으면 일별 선, 없으면 3개월 선(합계 지표는 일평균, 나머지는 원값). 카드 머리는 이번 달 값과 전월 대비.
const DAYLIST = []; for (let t = Date.parse(P[a].start); t <= Date.parse(P[c].end); t += 86400000) DAYLIST.push(new Date(t).toISOString().slice(0, 10));
const SW = 260, SH = 96, ST = 16, SB = 18;
function dailyLine(pts, label, kind) {
  if (!pts?.length) return '<div class="mna">일별 기록 없음</div>';
  const m = new Map(pts.map((p) => [p.date, p.v])), first = pts[0].date, last = pts.at(-1).date;
  const ser = DAYLIST.map((d, i) => ({ d, i, v: d < first || d > last ? null : m.get(d) ?? 0 }));
  const hi = niceMax(Math.max(...ser.map((x) => x.v ?? 0), 0)), w = SW / DAYLIST.length;
  const x = (i) => (i + 0.5) * w, y = (v) => ST + (SH - ST - SB) * (1 - v / hi);
  let g = `<line x1="0" x2="${SW}" y1="${ST}" y2="${ST}" class="gl"/><text x="0" y="${ST - 5}" class="ax sm">${nf(hi)}</text><line x1="0" x2="${SW}" y1="${SH - SB}" y2="${SH - SB}" class="bl"/>`;
  for (const p of P) { const i = DAYLIST.indexOf(p.start); if (i > 0) g += `<line x1="${(i * w).toFixed(1)}" x2="${(i * w).toFixed(1)}" y1="${ST}" y2="${SH - SB}" class="gl"/>`; g += `<text x="${(i * w + 3).toFixed(1)}" y="${SH - 5}" class="ax sm">${MN(p.key)}</text>`; }
  const segs = []; let cur = [];
  for (const p of ser) { if (p.v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`); }
  if (cur.length) segs.push(cur);
  g += segs.map((sg) => `<polyline points="${sg.join(' ')}" class="ln"/>`).join('');
  g += ser.filter((p) => p.v != null).map((p) => `<rect x="${(p.i * w).toFixed(2)}" y="${ST}" width="${w.toFixed(2)}" height="${SH - ST - SB}" class="hit" data-tt="${esc(`<b>${md(p.d)}</b><br>${esc(label)} ${fmtK(kind, p.v)}`)}"/>`).join('');
  return `<svg viewBox="0 0 ${SW} ${SH}" class="spark" role="img" aria-label="${esc(label)} 일별 추이">${g}</svg>`;
}
const yOf = (kind, v, d) => (v == null ? null : kind === 'sum' || kind === 'net' ? (d ? v / d : null) : v);
const yTxt = (kind, v) => (kind === 'sum' || kind === 'net' ? `일 ${nf(v, Math.abs(v) < 10 ? 1 : 0)}` : fmtK(kind, v));
function monthLine(vals, days, kind, label) {
  const ys = MK.map((k, i) => yOf(kind, vals[i], days[i])), ok = ys.filter((v) => v != null);
  if (!ok.length) return '<div class="mna">기록 없음</div>';
  const hi = niceMax(Math.max(...ok, 0)), lo = Math.min(...ok) < 0 ? -niceMax(-Math.min(...ok)) : 0;
  const x = (i) => SW * (2 * i + 1) / 6, y = (v) => ST + 8 + (SH - ST - 8 - SB) * (1 - (v - lo) / (hi - lo));
  let g = `<line x1="0" x2="${SW}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="bl"/>` + MK.map((k, i) => `<text x="${x(i).toFixed(1)}" y="${SH - 5}" class="ax sm" text-anchor="middle">${MN(k)}</text>`).join('');
  const segs = []; let cur = [];
  ys.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
  if (cur.length) segs.push(cur);
  g += segs.filter((sg) => sg.length > 1).map((sg) => `<polyline points="${sg.join(' ')}" class="ln"/>`).join('');
  g += ys.map((v, i) => (v == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" class="pt"/><text x="${x(i).toFixed(1)}" y="${(y(v) - 8).toFixed(1)}" class="vl" text-anchor="middle">${yTxt(kind, v)}</text><circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="16" class="hit" data-tt="${esc(`<b>${MN(MK[i])}</b><br>${esc(label)} ${fmtK(kind, vals[i])}${kind === 'sum' || kind === 'net' ? ` · ${yTxt(kind, v)}` : ''}`)}"/>`)).join('');
  return `<svg viewBox="0 0 ${SW} ${SH}" class="spark" role="img" aria-label="${esc(label)} 월별 추이">${g}</svg>`;
}
const mcard = ({ label, desc = '', kind, vals, days, daily, na }) => `<div class="mc"><div class="mk">${label}${desc ? `<span class="ds">${desc}</span>` : ''}</div><div class="mv">${vals[c] == null ? (na?.[c] ?? '-') : fmtK(kind, vals[c])}${delta(kind, vals, days)}</div>${daily ? dailyLine(daily, label, kind) : monthLine(vals, days, kind, label)}<div class="mf">${MK.map((k, i) => `${MN(k)} ${vals[i] == null ? (na?.[i] ?? '-') : fmtK(kind, vals[i])}`).join(' · ')}</div></div>`;
const mgrid = (cards) => `<div class="mg">${cards.filter(Boolean).join('')}</div>`;
const sumDaily = (recs, key) => { const m = new Map(); for (const x of recs) for (const r of x.daily || []) m.set(r.date, (m.get(r.date) || 0) + (r[key] ?? 0)); return [...m].sort((p, q) => (p[0] < q[0] ? -1 : 1)).map(([date, v]) => ({ date, v })); };
const dl = (x, key, from) => (x.daily || []).filter((r) => !from || r.date >= from).map((r) => ({ date: r.date, v: r[key] }));
// 유입 경로 막대: 이번 달 접속 순, 오른쪽에 전월 대비
const chOf = (x) => { const o = {}; for (const k of MK) for (const [n, v] of Object.entries(x.channels?.[k] || {})) (o[n] ??= {})[k] = v; return o; };
function chBars(chs, days) {
  const rows = Object.entries(chs).map(([n, m]) => ({ n, v: MK.map((k) => m[k]?.sessions ?? null) })).filter((r) => r.v[c]).sort((p, q) => q.v[c] - p.v[c]);
  const mx = Math.max(...rows.map((r) => r.v[c]), 1);
  return `<div class="qc"><div class="qr ch qk"><span>유입 경로</span><span></span><span>${MC}</span><span>${MB} 대비</span></div>${rows.map((r) => `<div class="qr ch" data-tt="${esc(`<b>${esc(CH[r.n]?.[0] ?? r.n)}</b><br>${esc(CH[r.n]?.[1] ?? '')}<br>${MK.map((k, i) => `${MN(k)} ${nf(r.v[i])}`).join(' · ')}`)}"><span class="qt">${esc(CH[r.n]?.[0] ?? r.n)}</span><span class="qb"><i style="width:${(r.v[c] / mx * 100).toFixed(1)}%"></i></span><span class="qv">${nf(r.v[c])}</span><span class="qp">${delta('sum', r.v, days)}</span></div>`).join('')}</div>`;
}

// ================= 나라별 보기 (상단 탭) =================
const CC = ['KR', 'EN', 'JP', 'CN', 'TW', 'HK', 'TH'];
const CNAME = { KR: '한국', EN: '영어', JP: '일본', CN: '중국', TW: '대만', HK: '홍콩', TH: '태국' };
const pick = (arr, l) => arr.find((x) => x.label === l);
const noData = (t) => `<p class="mna">${t}</p>`;
const view = (all, per) => `<div data-c="ALL">${all}</div>${CC.map((l) => `<div data-c="${l}" hidden>${per(l)}</div>`).join('')}`;
const facts = (arr) => (arr.length ? `<ul class="facts">${arr.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
const gscOk = homes.filter((x) => !x.error);
const kePart0 = (v) => (kePartial ? v.map((y, i) => (i === 0 ? null : y)) : v);

const gaCards = (x) => { const d = gaDays(x), na = gaNa(x); return mgrid([
  mcard({ label: '접속 횟수', desc: '방문 1회 단위', kind: 'sum', vals: gv(x, 'sessions'), days: d, daily: dl(x, 'sessions'), na }),
  mcard({ label: '문의', desc: '예약·상담 등 핵심 이벤트', kind: 'sum', vals: gv(x, 'keyEvents'), days: kePartial ? keDays(x.key_events_from) : d, daily: dl(x, 'keyEvents'), na }),
  mcard({ label: '문의 전환율', desc: '문의 ÷ 접속', kind: 'rate', vals: kePart0(MK.map((k) => (x.months[k]?.sessions ? x.months[k].keyEvents / x.months[k].sessions : null))), days: d, na: kePartial ? rateNa.na : na }),
  mcard({ label: '사용자', desc: '고유 수 · 원값 비교', kind: 'uniq', vals: gv(x, 'activeUsers'), days: d, na }),
  mcard({ label: '신규 사용자', desc: '고유 수 · 원값 비교', kind: 'uniq', vals: gv(x, 'newUsers'), days: d, na }),
  mcard({ label: '페이지 조회', desc: '열어 본 페이지 수', kind: 'sum', vals: gv(x, 'screenPageViews'), days: d, na }),
  mcard({ label: '참여율', desc: '10초 이상 또는 2페이지 이상', kind: 'rate', vals: gv(x, 'engagementRate'), days: d, na }),
  mcard({ label: '이탈률', desc: '참여 없이 나간 접속', kind: 'rate', vals: gv(x, 'bounceRate'), days: d, na }),
  mcard({ label: '평균 체류 시간', desc: '접속 1회당', kind: 'dur', vals: gv(x, 'averageSessionDuration'), days: d, na }),
]); };
const qOne = (x) => `<div class="qg">${qCard(x.label, `${MCd(gscLast)} 상위 ${x.top_queries.length}개`, x.top_queries.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: pct(q.ctr), rank: q.position })))}</div>`;
const gscCards = (x) => mgrid([
  mcard({ label: '클릭', desc: '검색 결과에서 눌러 들어온 수', kind: 'sum', vals: gsv(x, 'clicks'), days: GD, daily: dl(x, 'clicks') }),
  mcard({ label: '노출', desc: '검색 결과에 보인 횟수', kind: 'sum', vals: gsv(x, 'impressions'), days: GD, daily: dl(x, 'impressions') }),
  mcard({ label: '클릭률', desc: '노출 대비 클릭', kind: 'rate', vals: gsv(x, 'ctr'), days: GD }),
  mcard({ label: '평균 순위', desc: '작을수록 상단', kind: 'pos', vals: gsv(x, 'position'), days: GD }),
]);
const nvCards = (x) => mgrid([
  mcard({ label: '클릭', desc: '네이버 검색에서 눌러 들어온 수', kind: 'sum', vals: nvv(x, 'clicks'), days: DAYS, daily: dl(x, 'clicks') }),
  mcard({ label: '노출', desc: '검색 결과에 보인 횟수', kind: 'sum', vals: nvv(x, 'impressions'), days: DAYS, daily: dl(x, 'impressions') }),
  mcard({ label: '클릭률', desc: '노출 대비 클릭', kind: 'rate', vals: nvv(x, 'ctr'), days: DAYS }),
]);
const ytCards = (x) => { const d = ytDays(x), na = MK.map((k, i) => (d[i] ? null : '개설 전')), f = x.first_date;
  return `<h3>${esc(x.name)} <span class="muted">· 현재 구독자 ${nf(x.subscribers)}명</span></h3>${mgrid([
    mcard({ label: '조회수', desc: '영상이 재생된 횟수', kind: 'sum', vals: ytv(x, 'views'), days: d, daily: dl(x, 'views', f), na }),
    mcard({ label: '시청 시간(분)', desc: '시청자가 본 시간 합계', kind: 'sum', vals: ytv(x, 'mins'), days: d, daily: dl(x, 'mins', f), na }),
    mcard({ label: '평균 시청 지속 시간', desc: '조회 1회당 · 원값 비교', kind: 'dur', vals: ytv(x, 'avd'), days: d, na }),
    mcard({ label: '신규 구독', desc: '구독 버튼을 누른 수', kind: 'sum', vals: ytv(x, 'gain'), days: d, daily: dl(x, 'gain', f), na }),
    mcard({ label: '구독 취소', desc: '', kind: 'sum', vals: ytv(x, 'lost'), days: d, daily: dl(x, 'lost', f), na }),
    mcard({ label: '구독 순증', desc: '신규 − 취소 · 증감은 일평균 차이', kind: 'net', vals: ytNet(x), days: d, na }),
  ])}`; };
const igCards = (x) => mgrid([
  ['조회', '표시·재생된 횟수', 'sum', igv(x, 'views')], ['도달', '본 계정 수 · 원값 비교', 'uniq', igv(x, 'reach')], ['참여 계정', '반응한 계정 수 · 원값 비교', 'uniq', igv(x, 'accounts_engaged')],
  ['총 상호작용', '좋아요+댓글+저장+공유 등', 'sum', igv(x, 'total_interactions')], ['좋아요', '', 'sum', igv(x, 'likes')], ['댓글', '', 'sum', igv(x, 'comments')],
  ['저장', '', 'sum', igv(x, 'saves')], ['공유', '', 'sum', igv(x, 'shares')], ['프로필 조회', '프로필 화면을 연 횟수', 'sum', igv(x, 'profile_views')],
  ['프로필 링크 클릭', '외부 링크를 누른 횟수', 'sum', igv(x, 'profile_links_taps')], ['팔로우', '', 'sum', igv(x, 'follows')], ['언팔로우', '', 'sum', igv(x, 'unfollows')],
  ['팔로워 순증', '팔로우 − 언팔로우', 'net', igNet(x)], ['게시물 수', '피드·릴스(스토리 제외)', 'sum', igPosts(x)],
].map(([label, desc, kind, vals]) => mcard({ label, desc, kind, vals, days: DAYS })));
const thCards = (x) => mgrid([
  ['조회', '게시물이 표시된 횟수', 'sum', thv(x, 'views')], ['좋아요', '', 'sum', thv(x, 'likes')], ['답글', '', 'sum', thv(x, 'replies')],
  ['리포스트 받음', '우리 글을 리포스트한 수', 'sum', thv(x, 'reposts')], ['인용', '', 'sum', thv(x, 'quotes')],
  ['직접 올린 글', '원글 수', 'sum', MK.map((k) => x.posts[k]?.original ?? null)], ['리포스트한 글', '다른 글을 리포스트한 수', 'sum', MK.map((k) => x.posts[k]?.reposts ?? null)],
].map(([label, desc, kind, vals]) => mcard({ label, desc, kind, vals, days: DAYS })));
const cTiles = (l) => { const g = pick(G, l), q = pick(gscOk, l), n = pick(NO, l), i = pick(IG, l), t = pick(TH, l);
  return [g && tile('홈페이지 접속', 'GA4', gv(g, 'sessions'), gaDays(g)), g && tile('문의', '예약·상담 등 핵심 이벤트', gv(g, 'keyEvents'), gaDays(g)),
    q && tile('구글 검색 클릭', `${md(P[c].start)}~${md(gscLast)}`, gsv(q, 'clicks'), GD), n && tile('네이버 검색 클릭', '서치어드바이저', nvv(n, 'clicks'), DAYS),
    i && tile('인스타그램 조회', `@${esc(i.username)}`, igv(i, 'views'), DAYS), t && tile('스레드 조회', `@${esc(t.username)}`, thv(t, 'views'), DAYS)].filter(Boolean).join(''); };

const S_TILES = view(`<div class="tiles">${tiles}</div>`, (l) => `<div class="tiles">${cTiles(l)}</div>`);
const S_HOME = view(`${facts(gaSent)}${mgrid([
    mcard({ label: '접속 횟수', desc: `${G.length}개국 합계`, kind: 'sum', vals: gaSessions, days: DAYS, daily: sumDaily(G, 'sessions') }),
    mcard({ label: '문의', desc: `${G.length}개국 합계`, kind: 'sum', vals: gaKe, days: kePartial ? keDays(G.map((x) => x.key_events_from).sort()[0]) : DAYS, daily: sumDaily(G, 'keyEvents') }),
    mcard({ label: '문의 전환율', desc: '문의 ÷ 접속', kind: 'rate', vals: kePart0(gaRate), days: DAYS, na: kePartial ? rateNa.na : null }),
  ])}<h3>국가별 일평균 접속 횟수</h3>${gaChart}${gaDetail}<h3>유입 경로 <span class="muted">· ${G.length}개국 합</span></h3>${chBars(chAgg, DAYS)}`,
  (l) => { const x = pick(G, l); return x ? `${gaCards(x)}<h3>유입 경로</h3>${chBars(chOf(x), gaDays(x))}` : noData('이 나라 홈페이지의 GA4 수치가 없습니다.'); });
const qHead = `<h3>상위 검색어 <span class="muted">· 막대는 클릭 수(카드마다 1위 검색어 기준) · 마우스를 올리면 노출·클릭률</span></h3>`;
const S_GOOGLE = view(`${facts(gscSent)}${mgrid([
    mcard({ label: '클릭', desc: `홈페이지 ${gscOk.length}곳 합계`, kind: 'sum', vals: homeClicks, days: GD, daily: sumDaily(gscOk, 'clicks') }),
    mcard({ label: '노출', desc: `홈페이지 ${gscOk.length}곳 합계`, kind: 'sum', vals: homeImpr, days: GD, daily: sumDaily(gscOk, 'impressions') }),
  ])}<h3>홈페이지별 일평균 클릭</h3>${gscChart}${gscDetail}<h3>블로그 클릭</h3>${mgrid(blogs.filter((x) => !x.error).map((x) => mcard({ label: x.label, desc: x.note ?? '', kind: 'sum', vals: gsv(x, 'clicks'), days: GD, daily: dl(x, 'clicks') })))}${qHead}${gscQueries}`,
  (l) => { const x = pick(gscOk, l); return x ? `${gscCards(x)}${qHead}${qOne(x)}` : noData('이 나라 홈페이지의 Search Console 수치가 없습니다.'); });
const S_NAVER = view(`${facts(nvSent)}${mxHead('사이트별 클릭·노출·클릭률')}${matrix(NO.map((x) => ({ label: x.label, x })), [
    { label: '클릭', desc: '네이버 검색에서 눌러 들어온 수', kind: 'sum', v: (x) => nvv(x, 'clicks'), d: () => DAYS },
    { label: '노출', desc: '검색 결과에 보인 횟수', kind: 'sum', v: (x) => nvv(x, 'impressions'), d: () => DAYS },
    { label: '클릭률', desc: '노출 대비 클릭 비율', kind: 'rate', v: (x) => nvv(x, 'ctr'), d: () => DAYS },
  ])}${facts(NV.filter((x) => x.status !== 'OK').map((x) => `${x.label}: ${esc(x.note ?? x.message)}`))}${nvQ}`,
  (l) => { const x = pick(NO, l), nx = pick(NV, l); return x ? `${nvCards(x)}${l === 'KR' ? nvQ : ''}` : noData(nx ? esc(nx.note ?? nx.message) : '네이버 서치어드바이저 수치가 없습니다.'); });
const S_YT = view(`${facts(ytSent)}${YT.map(ytCards).join('')}`, () => noData('유튜브는 나라별 채널이 아니어서 전체보기 탭에서 확인할 수 있습니다.'));
const S_IG = view(`${facts(igSent)}${mgrid([
    mcard({ label: '조회', desc: `${IG.length}개 계정 합계`, kind: 'sum', vals: igViews, days: DAYS }),
    mcard({ label: '총 상호작용', desc: `${IG.length}개 계정 합계`, kind: 'sum', vals: igInter, days: DAYS }),
  ])}<h3>국가별 일평균 조회</h3>${igChart}${igTables}`,
  (l) => { const x = pick(IG, l); return x ? `<p class="sub">@${esc(x.username)} · 현재 팔로워 ${nf(x.followers)}명</p>${igCards(x)}` : noData(`인스타그램은 ${IG.map((y) => y.label).join('·')} ${IG.length}개 계정을 집계합니다.`); });
const S_TH = view(`${facts(thSent)}${mgrid([mcard({ label: '조회', desc: `${TH.length}개 계정 합계`, kind: 'sum', vals: thViews, days: DAYS })])}<h3>국가별 일평균 조회</h3>${thChart}${thTables}`,
  (l) => { const x = pick(TH, l); return x ? `<p class="sub">@${esc(x.username)} · 현재 팔로워 ${nf(x.followers)}명</p>${thCards(x)}` : noData(`스레드는 ${TH.map((y) => y.label).join('·')} ${TH.length}개 계정을 집계합니다.`); });

// ================= 페이지 =================
const sec = (id, title, sub, body) => `<section id="${id}"><h2>${title}</h2><p class="sub">${sub}</p>${body}</section>`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>뷰티블라썸 월간 성과보고서 · ${P[0].start.slice(0, 4)}년 ${MN(MK[0])}~${MN(MK.at(-1))}</title><meta name="robots" content="noindex">
<meta name="description" content="${P.map((p) => MN(p.key) + (p.end.slice(8) !== String(new Date(Date.UTC(+p.key.slice(0, 4), +p.key.slice(5), 0)).getUTCDate()) ? `(1~${Number(p.end.slice(8))}일)` : '')).join(' · ')} 월별 비교 · GA4·구글·네이버 검색·유튜브·인스타·스레드">
<style>
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--up:#c62828;--dn:#1f5fb4;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a}
:root[data-theme="dark"]{--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--up:#ff6b6b;--dn:#6ea8ff;--s1:#3987e5;--s2:#d95926;--s3:#199e70}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--up:#ff6b6b;--dn:#6ea8ff;--s1:#3987e5;--s2:#d95926;--s3:#199e70}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;font-size:14px;line-height:1.6}
.wrap{max-width:none;margin:0;padding:28px clamp(16px,3vw,48px) 80px}header{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:space-between}
h1{font-size:26px;margin:0;letter-spacing:-.01em}h2{font-size:19px;margin:44px 0 2px}h3{font-size:14px;margin:22px 0 8px;color:var(--ink)}
.sub{color:var(--ink2);font-size:13px;margin:2px 0 10px}.muted{color:var(--muted);font-weight:400}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 4px}nav a{font-size:12px;padding:4px 10px;border:1px solid var(--ring);border-radius:999px;text-decoration:none;color:var(--ink2)}
.read{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:12px 16px;margin-top:14px;font-size:13px;color:var(--ink2)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:16px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:14px 16px}.tile .k{font-size:13px;font-weight:600}
.tile .v{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:2px}.tile .d{font-size:12px;color:var(--ink2)}
.facts{margin:6px 0 14px;padding-left:18px;overflow-wrap:anywhere}.facts li{margin:3px 0}
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
.hl{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:2px 16px 12px;margin:10px 0}.hl h3{margin-top:14px}figure{margin:10px 0}figure img{display:block;max-width:100%;height:auto;border:1px solid var(--ring);border-radius:8px}figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.mx th,.mx td{white-space:nowrap}.mx td .dl{display:block}.mx th:first-child,.mx td:first-child{position:sticky;left:0;background:var(--surface);z-index:1;white-space:normal;min-width:150px}
.qg{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr));gap:12px;margin:8px 0}.qc{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:12px 14px}
.qh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px;font-size:13px}.qh .muted{font-size:12px}
.qr{display:grid;grid-template-columns:minmax(0,1fr) 30% 44px 40px;gap:8px;align-items:center;font-size:12px;padding:3px 0}.qr.qk{color:var(--muted);font-size:11px;padding:0 0 2px}.qr.qk span:nth-child(n+3){text-align:right}
.qt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qb{height:10px}.qb i{display:block;height:100%;min-width:2px;background:var(--s1);border-radius:0 4px 4px 0}
.qv{text-align:right;font-variant-numeric:tabular-nums}.qp{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
[hidden]{display:none!important}
.ctab{position:sticky;top:0;z-index:30;display:flex;flex-wrap:wrap;gap:6px;padding:10px 0;margin-top:14px;background:var(--page);border-bottom:1px solid var(--ring)}
.ctab button{font:inherit;font-size:13px;padding:6px 14px;border-radius:999px;border:1px solid var(--ring);background:var(--surface);color:var(--ink2);cursor:pointer}
.ctab button[aria-selected="true"]{background:var(--ink);color:var(--page);border-color:var(--ink);font-weight:600}
.mg{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:12px;margin:10px 0}
.mc{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:12px 14px 10px}.mk{font-size:13px;font-weight:600}
.mv{font-size:22px;font-weight:650;letter-spacing:-.02em;margin:2px 0;font-variant-numeric:tabular-nums}.mv .dl{margin-left:6px}
.mf{font-size:11px;color:var(--muted);margin-top:2px;font-variant-numeric:tabular-nums}.mna{color:var(--muted);font-size:13px;margin:10px 0}
svg.spark{margin-top:4px}.ax.sm{font-size:10px}.ln{fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.pt{fill:var(--s1);stroke:var(--surface);stroke-width:2}.vl{fill:var(--ink2);font-size:10.5px}.hit{fill:transparent}.hit:hover{fill:var(--ring)}
.qr.ch{grid-template-columns:minmax(0,1fr) 30% 60px 84px}
.chart svg{max-height:360px}
@media (max-width:640px){
.wrap{padding:16px 12px 60px}h1{font-size:21px}h2{font-size:17px;margin-top:32px}header{align-items:flex-start}
.ctab,nav{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.ctab::-webkit-scrollbar,nav::-webkit-scrollbar{display:none}
.ctab button,nav a{flex:0 0 auto}.ctab button{padding:6px 12px}
.tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.tile{padding:10px 12px}.tile .v{font-size:20px}
.mg{gap:8px}.mc{padding:10px 12px 8px}.mv{font-size:20px}
.chart{overflow-x:auto;padding:10px}.chart svg{min-width:640px;max-height:none}.chart .ax{font-size:16px}.chart .ax.lb{font-size:17px}
th,td{padding:6px 8px}.mx th:first-child,.mx td:first-child{min-width:112px}
.qc{padding:10px 12px}.qr.ch{grid-template-columns:minmax(0,1fr) 18% 52px 72px}
}
a{color:inherit}footer{margin-top:40px;font-size:12px;color:var(--muted)}
</style></head><body><div class="wrap">
<header><div><h1>뷰티블라썸 월간 성과보고서</h1><p class="sub">${P[0].start.slice(0, 4)}년 ${MA} · ${MB} · ${MCd()} 비교 · 발행 ${PUB} · <a href="../../">지난 보고서 목록</a></p></div><button class="theme" id="tg">밝게/어둡게</button></header>
<div class="ctab" role="tablist" aria-label="나라 선택">${['ALL', ...CC].map((v) => `<button type="button" role="tab" data-v="${v}" aria-selected="${v === 'ALL'}">${v === 'ALL' ? '전체보기' : `${v} ${CNAME[v]}`}</button>`).join('')}</div>
<nav>${HL.length ? '<a href="#highlights">주요 성과</a>' : ''}<a href="#home">홈페이지</a><a href="#google">구글 검색</a><a href="#naver">네이버 검색</a><a href="#youtube">유튜브</a><a href="#instagram">인스타그램</a><a href="#threads">스레드</a><a href="#notes">기준·미확인</a></nav>
<div class="read"><b>읽는 법</b> 달마다 일수가 달라(${MA} ${DAYS[a]}일 · ${MB} ${DAYS[b]}일 · ${MC} ${DAYS[c]}일) 증감은 <b>일평균(합계 ÷ 일수)</b>으로 전월과 비교했습니다. 값 옆 <span class="dl up">▲</span>는 증가, <span class="dl dn">▼</span>는 감소입니다. 작은 회색 글씨 "일 N"은 그 달의 일평균입니다. 상단 탭에서 나라를 고르면 그 나라 수치만 보입니다. 그래프에 마우스를 올리면 날짜별·월별 값이 나옵니다.</div>
${S_TILES}
${hlSec}
${sec('home', '홈페이지 (GA4)', '접속·문의. 문의 = 예약·상담 버튼 클릭 등 GA4에 핵심 이벤트로 등록된 행동', S_HOME)}
${sec('google', '구글 검색 (Search Console)', `구글 검색 결과에서의 노출·클릭. ${MC}은 ${md(gscLast)}까지(${GD[c]}일)`, S_GOOGLE)}
${sec('naver', '네이버 검색 (서치어드바이저)', '네이버 검색 결과에서의 노출·클릭', S_NAVER)}
${sec('youtube', '유튜브', `YouTube Analytics 기준. ${MC}은 ${md(ytLast)}까지(${ytDaysAll[c]}일)`, S_YT)}
${sec('instagram', '인스타그램', '계정 인사이트', S_IG)}
${sec('threads', '스레드', '계정 인사이트', S_TH)}
<section id="notes"><h2>기준·미확인 항목</h2><ul class="cav">${caveats.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>
<footer>수집 ${D.generated_at_utc.slice(0, 16).replace('T', ' ')} UTC · 원자료 <a href="data.json">data.json</a> · GA4 · Search Console · 네이버 서치어드바이저 · YouTube Analytics · Instagram · Threads</footer>
</div><div class="tt" id="tt"></div>
<script>
(function(){var r=document.documentElement,k='bb-theme';try{var s=localStorage.getItem(k);if(s)r.setAttribute('data-theme',s)}catch(e){}
document.getElementById('tg').onclick=function(){var d=r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var n=d==='dark'?'light':'dark';r.setAttribute('data-theme',n);try{localStorage.setItem(k,n)}catch(e){}};
var t=document.getElementById('tt');var mv=function(e){var el=e.target.closest&&e.target.closest('[data-tt]');if(!el){t.style.opacity=0;return}t.innerHTML=el.getAttribute('data-tt');t.style.opacity=1;var x=e.clientX+14,y=e.clientY+14;if(x+t.offsetWidth>innerWidth-8)x=e.clientX-t.offsetWidth-14;t.style.left=x+'px';t.style.top=y+'px'};document.addEventListener('mousemove',mv);document.addEventListener('pointerdown',mv);var tb=document.querySelectorAll('.ctab button');function sv(v){document.querySelectorAll('[data-c]').forEach(function(el){el.hidden=el.getAttribute('data-c').split(' ').indexOf(v)<0});tb.forEach(function(b){b.setAttribute('aria-selected',String(b.getAttribute('data-v')===v))});try{var u=new URL(location.href);if(v==='ALL')u.searchParams.delete('c');else u.searchParams.set('c',v);history.replaceState(null,'',u)}catch(e){}}
tb.forEach(function(b){b.onclick=function(){sv(b.getAttribute('data-v'))}});var q0=new URLSearchParams(location.search).get('c');sv(q0&&document.querySelector('.ctab [data-v="'+q0+'"]')?q0:'ALL');
})();
</script></body></html>`;

const outDir = join(ROOT, 'r', PUB);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html, 'utf8');
writeFileSync(join(outDir, 'data.json'), JSON.stringify(D, null, 1), 'utf8');
console.log(`WROTE r/${PUB}/index.html ${(html.length / 1024).toFixed(1)} KB  + data.json`);
