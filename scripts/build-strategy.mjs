// Builds the monthly marketing strategy report.
//   node scripts/build-strategy.mjs --month=2026-10 --monthly=data/monthly-2026-09-28.json
//
// This is the layer above the performance reports. Those state what happened; this states what to
// do in the execution month (--month) and why, based on the month before it. The output is one
// file per month and is never regenerated afterwards, so the following month can check whether the
// judgement was right. That check is section S0: it reads last month's report file itself for the
// targets it set, rather than a copy that could drift.
//
// Every number is derived from the collected JSON rather than typed in, so a re-collection
// regenerates a consistent report instead of leaving stale figures in the prose. The September
// 2026 edition was built by an earlier revision of this file from 30-day rolling data; from
// October the basis is calendar months (collect-monthly.mjs + collect-strategy-inputs.mjs).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MONTH = arg('month');
const MONTHLY = arg('monthly');
if (!/^\d{4}-\d{2}$/.test(MONTH || '') || !MONTHLY) {
  console.error('필수: --month=yyyy-mm --monthly=data/monthly-<end>.json'); process.exit(1);
}
const pad = (n) => String(n).padStart(2, '0');
const shift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const BASE = shift(MONTH, -1), COMPARE = shift(MONTH, -2), NEXT = shift(MONTH, 1);
const mLabel = (ym) => `${+ym.slice(5, 7)}월`;
const M = { exec: mLabel(MONTH), base: mLabel(BASE), compare: mLabel(COMPARE), next: mLabel(NEXT), year: MONTH.slice(0, 4) };
const OUT = join(ROOT, 'report', `strategy-${MONTH}.html`);
const PREV_REPORT = join(ROOT, 'report', `strategy-${BASE}.html`);

// PowerShell writes UTF-8 with a BOM; JSON.parse chokes on it.
const readPath = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) : null);
const read = (f) => readPath(join(DATA, f));
const need = (v, what) => { if (!v) { console.error('missing', what); process.exit(1); } return v; };

const monthly = need(readPath(join(ROOT, MONTHLY)), MONTHLY);
const inputs = need(read(`strategy-inputs-${MONTH}.json`), `strategy-inputs-${MONTH}.json`);
const comp = read(`competitors-${MONTH}.json`);
const compPrev = read(`competitors-${BASE}.json`);
// Last month's inputs, for what changed on the sites since then (sitemaps).
const prevInputs = read(`strategy-inputs-${BASE}.json`);
const serp = read(`serp-${MONTH}.json`);
const serpPrev = read(`serp-${BASE}.json`);
// Location and multilingual setup are not in the ad library; they were read off each clinic's own
// site and carry their source URLs.
const profiles = read('competitor-profiles.json');
// What the clinic actually offers, taken from the internal price sheet (names only). Without this a
// "competitors advertise X and we don't rank for it" finding cannot tell a missed opportunity from
// a treatment the clinic does not perform.
const offered = read('treatments-offered.json');

// Last month's report is a frozen HTML file with its data embedded. Its targets are read from it
// directly so the check below cannot drift from what was actually published.
function prevPayload() {
  if (!existsSync(PREV_REPORT)) return null;
  const h = readFileSync(PREV_REPORT, 'utf8');
  const i = h.indexOf('{"meta":');
  if (i < 0) return null;
  let depth = 0, e = i;
  for (; e < h.length; e++) { if (h[e] === '{') depth++; else if (h[e] === '}' && !--depth) break; }
  return JSON.parse(h.slice(i, e + 1));
}
const prev = prevPayload();

const pct = (n, d) => (d ? n / d : null);
const num = (n) => (n == null ? '-' : Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pc = (n, d = 1) => (n == null ? '-' : (n * 100).toFixed(d) + '%');
const sign = (n, d = 0) => (n == null ? '-' : (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + '%');
const sum = (a, f) => a.reduce((s, x) => s + (typeof f === 'function' ? f(x) : x[f] || 0), 0);

const PERIOD = Object.fromEntries(monthly.periods.map((p) => [p.key, p]));
const baseDays = PERIOD[BASE].days, compareDays = PERIOD[COMPARE].days;
const gscLast = (monthly.sources.searchconsole.find((s) => s.label === 'KR') || {}).last_date || PERIOD[BASE].end;
const gscBaseDays = Math.round((Date.parse(gscLast) - Date.parse(PERIOD[BASE].start)) / 86400000) + 1;

// ---------------------------------------------------------------------------
// Markets
//
// A foreign-language site collects inquiries from sessions located in Korea too - in August most
// form submissions on the TW, JP and CN sites came from a handful of people in Korea. Those are not
// the market's patients, so every market judgement here uses "local" figures: sessions located
// outside Korea for the foreign sites. The KR site keeps everything, since there the two cannot be
// told apart. "Inquiry sessions" are sessions with at least one inquiry event, so one visitor
// tapping WhatsApp three times counts once.
// ---------------------------------------------------------------------------
const PAID = /^Paid/;
const OWNED = /^(Direct|Organic)/;
const LABELS = ['EN', 'TW', 'KR', 'JP', 'CN', 'TH', 'HK'];
const ga4In = Object.fromEntries(inputs.sources.ga4.map((g) => [g.label, g]));
const ga4M = Object.fromEntries(monthly.sources.ga4.map((g) => [g.label, g]));
// A site that started measuring mid-month (HK from 9/14) is averaged over the days it has data.
const mDays = (label, key) => {
  const p = PERIOD[key], d = (ga4M[label]?.daily || []).find((r) => r.date >= p.start && r.date <= p.end && r.sessions > 0);
  return d ? Math.round((Date.parse(p.end) - Date.parse(d.date)) / 86400000) + 1 : p.days;
};

function local(label, key) {
  const rows = ga4In[label]?.countries?.[key];
  if (!rows) return null;
  const loc = rows.filter((c) => label === 'KR' || c.country !== 'South Korea');
  const kr = rows.find((c) => c.country === 'South Korea') || { sessions: 0, inquirySessions: 0 };
  const sessions = sum(loc, 'sessions'), inquiry = sum(loc, 'inquirySessions');
  const allInquiry = sum(rows, 'inquirySessions');
  return { sessions, inquirySessions: inquiry, rate: pct(inquiry, sessions),
    koreaInquirySessions: label === 'KR' ? null : kr.inquirySessions,
    koreaShare: label === 'KR' ? null : pct(kr.inquirySessions, allInquiry) };
}
function channelsOf(label, key) {
  return Object.entries(ga4M[label]?.channels?.[key] || {})
    .map(([channel, v]) => ({ channel, sessions: v.sessions, keyEvents: v.keyEvents }))
    .sort((a, b) => b.sessions - a.sessions);
}
const markets = LABELS.map((label) => {
  const cur = ga4M[label].months[BASE], pre = ga4M[label].months[COMPARE];
  const ch = channelsOf(label, BASE), chPrev = channelsOf(label, COMPARE);
  const total = sum(ch, 'sessions') || cur.sessions;
  const totalPrev = sum(chPrev, 'sessions') || pre.sessions;
  const share = (list, re, t) => pct(sum(list.filter((c) => re.test(c.channel)), 'sessions'), t);
  const L = local(label, BASE), Lp = local(label, COMPARE), Lb = local(label, 'baseline');
  const bD = mDays(label, BASE), cD = mDays(label, COMPARE);
  const perDay = cur.sessions / bD, perDayPrev = pre.sessions / cD;
  const paidPerDay = sum(ch.filter((c) => PAID.test(c.channel)), 'sessions') / bD;
  const paidPerDayPrev = sum(chPrev.filter((c) => PAID.test(c.channel)), 'sessions') / cD;
  return {
    label, days: bD, daysPrev: cD,
    sessions: cur.sessions, sessionsPerDay: perDay, sessionsDelta: pct(perDay - perDayPrev, perDayPrev),
    keyEvents: cur.keyEvents, convRate: pct(cur.keyEvents, cur.sessions),
    channels: ch,
    paidShare: share(ch, PAID, total), paidSocialShare: pct(sum(ch.filter((c) => c.channel === 'Paid Social'), 'sessions'), total),
    ownedShare: share(ch, OWNED, total), ownedSharePrev: share(chPrev, OWNED, totalPrev),
    paidPerDay, paidDelta: pct(paidPerDay - paidPerDayPrev, paidPerDayPrev),
    local: L, localPrev: Lp, localBaseline: Lb,
    localRate: L?.rate ?? null, localRatePrev: Lp?.rate ?? null,
    inquiryPerDay: L ? L.inquirySessions / bD : null,
    inquiryPerDayPrev: Lp ? Lp.inquirySessions / cD : null,
    inquiryDelta: L && Lp ? pct(L.inquirySessions / bD - Lp.inquirySessions / cD, Lp.inquirySessions / cD) : null,
    // Twelve so the heatmap in S3 finds every discovery country, not only each site's top few.
    countries: (ga4In[label]?.countries?.[BASE] || []).slice(0, 12)
      .map((c) => ({ country: c.country, sessions: c.sessions, activeUsers: c.activeUsers, inquirySessions: c.inquirySessions })),
    countriesPrev: (ga4In[label]?.countries?.[COMPARE] || []).slice(0, 8)
      .map((c) => ({ country: c.country, sessions: c.sessions, inquirySessions: c.inquirySessions }))
  };
});
const MK = Object.fromEntries(markets.map((m) => [m.label, m]));

// ---------------------------------------------------------------------------
// Inquiries located in Korea, per foreign site. Shown as its own table because it changes how last
// month's conversion figures should be read.
// ---------------------------------------------------------------------------
function formStats(label, key) {
  const rows = (ga4In[label]?.key_events_by_country?.[key] || []).filter((r) => r.event === 'form_submit');
  const kr = rows.filter((r) => r.country === 'South Korea');
  return { total: sum(rows, 'keyEvents'), korea: sum(kr, 'keyEvents'), koreaUsers: sum(kr, 'users') };
}
const koreaShare = markets.filter((m) => m.label !== 'KR').map((m) => ({
  label: m.label,
  base: { ...(m.local ? { inquiry: m.local.inquirySessions + m.local.koreaInquirySessions, korea: m.local.koreaInquirySessions, share: m.local.koreaShare } : {}), form: formStats(m.label, BASE) },
  compare: { ...(m.localPrev ? { inquiry: m.localPrev.inquirySessions + m.localPrev.koreaInquirySessions, korea: m.localPrev.koreaInquirySessions, share: m.localPrev.koreaShare } : {}), form: formStats(m.label, COMPARE) }
}));

// Daily form submissions, all foreign sites together, to date the late-summer spike.
const formDaily = (() => {
  const by = {};
  for (const g of inputs.sources.ga4) {
    for (const r of g.key_events_daily || []) {
      if (r.event !== 'form_submit') continue;
      by[r.date] = by[r.date] || { date: r.date, KR: 0, foreign: 0 };
      if (g.label === 'KR') by[r.date].KR += r.keyEvents; else by[r.date].foreign += r.keyEvents;
    }
  }
  return Object.values(by).sort((a, b) => a.date.localeCompare(b.date));
})();

// ---------------------------------------------------------------------------
// Search Console queries (full lists, calendar months)
// ---------------------------------------------------------------------------
const BRAND = /(beauty\s*blossom|beautyblossom|뷰티블라썸|ビューティーブロッサム|ビューティブロッサム|麗朵|丽朵|bb\s*clinic)/i;
const MIN_IMPRESSIONS = 50;
const RANK_BAND = [3.5, 25];
const TOP_CTR = 0.28;
const gscIn = inputs.sources.searchconsole;
const queriesOf = (key) => gscIn.flatMap((s) => (s.queries?.[key] || []).map((q) => ({ ...q, market: s.label, site: s.url })));
const qBase = queriesOf(BASE);

const nonBrand = (key) => {
  const rows = gscIn.find((s) => s.label === 'KR')?.queries?.[key];
  if (!rows) return null;
  const nb = rows.filter((q) => !BRAND.test(q.query));
  const band = nb.filter((q) => q.impressions >= MIN_IMPRESSIONS && q.position >= RANK_BAND[0] && q.position <= RANK_BAND[1]);
  return { clicks: sum(nb, 'clicks'), bandClicks: sum(band, 'clicks'), impressions: sum(nb, 'impressions') };
};

const keywordOps = qBase
  .filter((q) => !BRAND.test(q.query) && q.impressions >= MIN_IMPRESSIONS && q.position >= RANK_BAND[0] && q.position <= RANK_BAND[1])
  .map((q) => ({
    market: q.market, site: q.site, query: q.query, impressions: q.impressions, clicks: q.clicks, ctr: q.ctr, position: q.position,
    // Impressions already earned but not converted into clicks because of rank. TOP_CTR is an assumed
    // first-position click-through rate, not a measured one, so this is an estimate and the report says so.
    headroom: Math.round(q.impressions * TOP_CTR) - q.clicks
  }))
  .sort((a, b) => b.headroom - a.headroom);

// The "treatment + city" pattern is a template to extend rather than a hypothesis.
const CITY = /(seoul|서울|hongdae|홍대|gangnam|강남|韓国|한국|korea)/i;
const cityPattern = keywordOps.filter((k) => CITY.test(k.query));

// A treatment is one thing but its search term differs by market; grouping shows where it already
// earns impressions in one market while ranking nowhere in another.
const TREATMENTS = [
  { name: 'LDM (물방울 리프팅)', re: /\bldm\b|ldm是什麼/i },
  { name: 'Re2O · 엘라비에 리투', re: /re2o|re20|elravie|엘라비에/i },
  { name: '라라필 (Lala Peel)', re: /라라필|lala\s*peel|拉拉/i },
  { name: '스킨바이브 (Skinvive)', re: /스킨바이브|skinvive/i },
  { name: '릴리이드', re: /릴리이드|lilliad/i },
  { name: '피코슈어 (PicoSure)', re: /피코슈어|picosure|피코/i },
  { name: 'Alltite (올타이트)', re: /alltite|올타이트/i },
  { name: 'HiLo Wave (하이로웨이브)', re: /hilo\s*wave|hilowave|하이로/i },
  { name: '리니아지 (Lineage)', re: /リニアージ|lineage|리니아지|리니어지/i },
  { name: '피부 진단 · Skin Analysis', re: /skin\s*analysis|肌診断|피부\s*진단|3D 피부진단|皮膚檢測/i },
  { name: '점 빼기 · Mole Removal', re: /mole\s*removal|점\s*빼기|除痣|ほくろ|CO2\(점/i },
  { name: '스컬트라 (Sculptra)', re: /sculptra|스컬트라/i },
  { name: '아쿠아필 (Aqua Peel)', re: /aqua\s*peel|aquapeel|아쿠아필|水飛梭/i },
  { name: 'HIFU · 초음파 리프팅', re: /\bhifu\b|하이푸|音波/i },
  { name: '소프웨이브 (Sofwave)', re: /sofwave|소프웨이브/i },
  { name: '필러 (Filler)', re: /\bfiller\b|필러|フィラー|填充/i },
  { name: '제모 · Hair Removal', re: /hair\s*removal|제모|脱毛|除毛/i },
  { name: '화이트닝 · 톤개선', re: /whitening|화이트닝|미백|톤개선|美白/i },
  { name: '리쥬란 (Rejuran)', re: /rejuran|리쥬란|リジュラン|麗珠蘭/i },
  { name: '울쎄라 (Ultherapy)', re: /ulthera|울쎄라|ウルセラ/i },
  { name: '써마지 (Thermage)', re: /thermage|써마지|サーマ|鳳凰電波/i },
  { name: '온다 (Onda)', re: /\bonda\b|온다/i },
  { name: '포텐자 (Potenza)', re: /potenza|포텐자/i },
  { name: '쥬베룩 (Juvelook)', re: /juvelook|쥬베룩/i },
  { name: '보톡스 (Botox)', re: /botox|보톡스|ボトックス|肉毒/i },
  { name: '슈링크 (Shurink)', re: /shurink|슈링크|シュリンク/i },
  { name: '스킨부스터 (Skin Booster)', re: /skin\s*booster|스킨부스터|水光/i }
];
// In October the library's by-name and by-page-id lookups answered "no ads match" for clinics whose ads
// the keyword pass found in the same countries that same day (Cleor: 22 ads in TW and JP; repeated
// fresh reads gave the same answer). A "no ads" answer is therefore not evidence of absence. Each
// clinic's ads are the union of what either pass saw, and a country is either seen or not confirmed -
// never "absent". Tokens and the area filter mirror DEEP_TARGETS / OUT_OF_AREA in collect-competitors.
const DEEP_TOKEN = { 'Kleam Clinic': 'kleam', '오션클리닉': '오션', 'PRIA Clinic': 'pria', 'Selenaclinic': 'selena',
  'Cleor Clinic': 'cleor', 'Primi Clinic': 'primi', 'ShineBeam': 'shinebeam', 'Beautyblossom': 'beautyblossom' };
const OUT_OF_AREA = /(gangseo|강서|江西|bucheon|부천|incheon|인천|suwon|수원|busan|부산|daegu|대구|daejeon|대전|gwangju|광주|jeju|제주|ilsan|일산|anyang|안양)/i;
function mergedDeep(c) {
  return (c?.deepDive || []).map((d) => {
    const token = (DEEP_TOKEN[d.name] || d.name.split(/\s+/)[0]).toLowerCase();
    const seen = new Map((d.ads || []).map((a) => [a.libraryId, a]));
    for (const a of c.ads || []) {
      if (a.advertiser && a.advertiser.toLowerCase().includes(token) && !OUT_OF_AREA.test(a.advertiser) && !seen.has(a.libraryId)) seen.set(a.libraryId, a);
    }
    const ads = [...seen.values()];
    const countries = [...new Set(ads.map((a) => a.country))];
    const dates = ads.map((a) => new Date(a.startedRunning)).filter((x) => !isNaN(x)).sort((x, y) => x - y);
    return { ...d, ads, totalAds: ads.length, byNameAds: (d.ads || []).length, activeCountries: countries,
      notConfirmed: (d.byCountry || []).map((b) => b.country).filter((x) => !countries.includes(x)),
      unresolved: d.unresolved || [], confirmedAbsent: [],
      earliestStart: dates[0] ? dates[0].toISOString().slice(0, 10) : d.earliestStart,
      pages: [...new Set(ads.map((a) => a.advertiser).filter(Boolean))],
      landingDomains: [...new Set(ads.map((a) => a.landingDomain).filter(Boolean))] };
  });
}
const deepNow = mergedDeep(comp), deepPrev = mergedDeep(compPrev);
const competitorAdCopy = deepNow.filter((d) => !d.isSelf).flatMap((d) => (d.ads || []).filter((a) => a.copy));
const treatmentPlan = TREATMENTS.map((t) => {
  const hits = qBase.filter((q) => !BRAND.test(q.query) && t.re.test(q.query))
    .map((q) => ({ market: q.market, query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.position }))
    .sort((a, b) => b.impressions - a.impressions);
  const pushedBy = competitorAdCopy.filter((a) => t.re.test(a.copy)).length;
  // Match the catalog's canonical name only; aliases pulled in combo menu items.
  const cat = (offered?.treatments || []).find((o) => t.re.test(o.name));
  const mks = [...new Set(hits.map((h) => h.market))];
  // Only positions with real exposure decide best/worst; a single stray impression ranks anywhere.
  const ranked = hits.filter((h) => h.impressions >= 20);
  const worst = ranked.length ? ranked.reduce((w, h) => (h.position > w.position ? h : w)) : null;
  const best = ranked.length ? ranked.reduce((w, h) => (h.position < w.position ? h : w)) : null;
  return {
    name: t.name, hits: hits.slice(0, 6), markets: mks, marketCount: mks.length,
    totalImpressions: sum(hits, 'impressions'), totalClicks: sum(hits, 'clicks'),
    bestPosition: best ? best.position : null, bestMarket: best ? best.market : null,
    worstPosition: worst ? worst.position : null, worstMarket: worst ? worst.market : null,
    crossMarketGap: best && worst && best.market !== worst.market ? +(worst.position - best.position).toFixed(1) : null,
    competitorAds: pushedBy, offered: !!cat, menuItemCount: cat ? cat.itemCount : 0, menuAliases: cat ? cat.aliases : [],
    bucket: !hits.length && pushedBy >= 15 ? 'open' : !hits.length ? 'none' : best && best.position <= 3.5 ? 'hold' : 'lift'
  };
}).filter((t) => t.totalImpressions > 0 || t.competitorAds > 0)
  .sort((a, b) => b.totalImpressions - a.totalImpressions || b.competitorAds - a.competitorAds);

// Terms customers search for that the clinic's own menu calls something else.
const gapStat = (re, markets) => {
  const hits = qBase.filter((q) => re.test(q.query) && (!markets || markets.includes(q.market)));
  const imp = sum(hits, 'impressions');
  const pos = imp ? sum(hits, (h) => h.position * h.impressions) / imp : null;
  const byM = [...new Set(hits.map((h) => h.market))].map((mk) => `${mk} ${num(sum(hits.filter((h) => h.market === mk), 'impressions'))}회`);
  return { imp, pos, text: imp ? `${M.base} 검색 노출 ${byM.join(' + ')} · 노출 가중 평균 ${pos.toFixed(1)}위` : `${M.base} 검색 노출 없음` };
};
const sitemapOf = (host) => inputs.sources.sitemaps.find((s) => s.host === host) || {};
const namedPaths = (host) => (sitemapOf(host).named || []).map((u) => new URL(u).pathname.replace(/^\//, ''));
const wordingGaps = [
  { searched: 'mole removal seoul / mole removal korea', menu: 'co2 / co2 1개 · 30개 · 50개', evidence: gapStat(/mole\s*removal/i).text },
  { searched: 'tattoo removal seoul', menu: '문신제거 / 500원크기 · 명함크기', evidence: gapStat(/tattoo\s*removal/i).text },
  { searched: 'skin analysis seoul / 韓国 肌診断', menu: '3D 피부진단', evidence: gapStat(/skin\s*analysis|肌診断/i).text },
  { searched: 'alltite / hilo wave', menu: `홈페이지에는 전용 페이지가 있습니다(${['alltite-lifting', 'hilo-wave'].filter((p) => namedPaths('beautyblossom.kr').includes(p)).map((p) => '/' + p).join(', ')}). 내부 시술 자료 33개 시트에서는 확인되지 않았습니다.`,
    evidence: gapStat(/alltite|올타이트|hilo\s*wave|hilowave|하이로/i).text + '. 두 자료가 서로 다르니 실제 운영 여부를 원내에서 확인해 주십시오' }
];

// ---------------------------------------------------------------------------
// S0: last month's targets against this month's results
// ---------------------------------------------------------------------------
// Each target is read from last month's S7 table and its market figures, so the check uses exactly
// what was published. Rows whose outcome the data cannot show are marked so rather than guessed.
const verify = (() => {
  if (!prev?.kpi) return null;
  const P = Object.fromEntries(prev.markets.map((m) => [m.label, m]));
  const fig = (s) => parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  const kShare = (side) => pct(sum(koreaShare, (k) => k[side].korea || 0), sum(koreaShare, (k) => k[side].inquiry || 0));
  const rows = prev.kpi.map((k) => {
    const cur = MK[k.market], was = P[k.market];
    if (k.metric === '현지 문의 발생률' && cur && was) {
      const target = was.localRatePrev, act = cur.localRate;
      return { metric: k.metric, market: k.market, baseline: pc(was.localRate, 2), target: pc(target, 2), actual: pc(act, 2),
        verdict: act >= target ? '달성' : '미달',
        note: `현지 접속 ${num(cur.local?.sessions)}회 가운데 문의가 나온 접속이 ${num(cur.local?.inquirySessions)}회입니다.` };
    }
    if (k.metric.startsWith('하루 평균 현지 문의') && cur && was) {
      const target = was.inquiryPerDay, act = cur.inquiryPerDay;
      return { metric: k.metric, market: k.market, baseline: `${target.toFixed(1)}회`, target: `${target.toFixed(1)}회 이상`, actual: `${act.toFixed(1)}회`,
        verdict: act >= target ? '달성' : '미달',
        note: `${M.base} 현지 문의 발생 접속은 ${num(cur.local?.inquirySessions)}회(${cur.days}일)입니다.` };
    }
    if (k.metric.startsWith('병원 이름이 아닌 검색 클릭')) {
      const nb = nonBrand(BASE), act = nb ? nb.clicks / gscBaseDays : null, target = fig(k.target);
      return { metric: '병원 이름이 아닌 검색 클릭 (하루)', market: k.market, baseline: k.now, target: k.target, actual: act == null ? '-' : `${act.toFixed(1)}회`,
        verdict: act != null && act >= target ? '달성' : '미달',
        note: nb ? `${M.base} 1~${gscBaseDays}일 동안 ${num(nb.clicks)}회입니다. 노출은 ${num(nb.impressions)}회입니다.` : '' };
    }
    if (k.metric.startsWith('해외 사이트 문의 중 한국')) {
      const act = kShare('base');
      return { metric: k.metric, market: k.market, baseline: k.now, target: k.target, actual: pc(act, 0), verdict: '판정 불가',
        note: `GA4 관리 화면은 읽지 못해 원내 접속 제외를 설정했는지는 확인하지 못했습니다. 한국에서 접속한 문의 비율은 ${k.now}에서 ${pc(act, 0)}가 됐습니다.` };
    }
    return null;
  }).filter(Boolean);
  return { basis: prev.meta.basis, rows,
    met: rows.filter((r) => r.verdict === '달성').length, judged: rows.filter((r) => r.verdict !== '판정 불가').length };
})();

// Last month's recommendations whose follow-through is visible in the data - and the ones that are not.
const ytIn = Object.fromEntries((inputs.sources.youtube || []).map((y) => [y.short, y]));
const ytShare = (short, key) => {
  const rows = ytIn[short]?.countries?.[key]; if (!rows) return null;
  const tot = sum(rows, 'views'); const kr = sum(rows.filter((r) => r.country === 'KR'), 'views');
  return { total: tot, abroad: tot - kr, abroadShare: pct(tot - kr, tot), top: rows.filter((r) => r.country !== 'KR').slice(0, 4) };
};
// ---------------------------------------------------------------------------
// Competitors (same method as last month, so the two months are comparable)
// ---------------------------------------------------------------------------
const competitors = comp ? {
  generatedAt: comp.generated_at_utc, note: comp.note, totals: comp.totals,
  unresolved: comp.method?.unresolvedQueries || [], discovery: comp.discovery || [],
  korean: (comp.advertisers || []).filter((a) => a.koreanClinic),
  self: (comp.advertisers || []).filter((a) => a.isSelf),
  // "Started running on" is per-ad and resets whenever a creative is swapped, so the age spread is
  // what the data supports - not "how long they have advertised".
  deepDive: deepNow.map((d) => {
    const ages = (d.ads || []).map((a) => a.startedRunning).filter(Boolean)
      .map((s) => Math.round((Date.parse(comp.generated_at_utc) - new Date(s)) / 86400000))
      .filter((n) => !isNaN(n)).sort((a, b) => a - b);
    const bucket = (lo, hi) => ages.filter((n) => n > lo && n <= hi).length;
    return { ...d, ageProfile: ages.length ? { count: ages.length, median: ages[Math.floor(ages.length / 2)], oldest: ages[ages.length - 1],
      buckets: [{ label: '30일 이내', n: ages.filter((n) => n <= 30).length }, { label: '1~3개월', n: bucket(30, 90) },
        { label: '3~12개월', n: bucket(90, 365) }, { label: '1년 이상', n: ages.filter((n) => n > 365).length }] } : null };
  }),
  advertiserCount: (comp.advertisers || []).length,
  profiles: profiles ? profiles.profiles : [], profilesNote: profiles ? profiles.note : null,
  crossFindings: profiles ? (profiles.crossFindings || []) : [], profilesDate: profiles ? profiles.generated_at_utc : null
} : null;

// Month over month for the same named clinics. Because a "no ads" answer proves nothing this month,
// only what was seen is compared: this month's count is a floor, and a country missing this month is
// "not confirmed", not "stopped".
const compChange = comp && compPrev ? deepNow.map((d) => {
  const p = deepPrev.find((x) => x.name === d.name);
  const prevC = new Set(p?.activeCountries || []);
  return { name: d.isSelf ? '뷰티블라썸 (우리)' : d.name, isSelf: !!d.isSelf,
    adsNow: d.totalAds, adsPrev: p ? p.totalAds : null,
    countriesNow: d.activeCountries.length, countriesPrev: p ? p.activeCountries.length : null,
    started: d.activeCountries.filter((c) => !prevC.has(c)),
    stopped: [...prevC].filter((c) => !d.activeCountries.includes(c)),
    unresolvedNow: [] };
}) : null;

const STYLE = [
  { key: 'offer', label: '할인·프로모션 제시', re: /(\d+\s*%|할인|이벤트|프로모션|promo|promotion|special\s*offer|discount|\bsale\b|特價|特价|優惠|优惠|割引|キャンペーン|โปรโมชั่น)/i },
  { key: 'price', label: '가격 명시', re: /(₩|\bKRW\b|\bUSD\b|NT\$|Rp\s?\d|฿\s?\d|₱\s?\d|\$\s?\d|\d+\s*원\b)/ },
  { key: 'messenger', label: '메신저 상담 유도', re: /(whatsapp|wechat|\bline\b|kakao|카카오|telegram|\bDM\b|เเชท|LINE@)/i },
  { key: 'booking', label: '예약·상담 CTA', re: /(book now|booking|reserve|appointment|consultation|예약|상담|予約|預約|จอง)/i },
  { key: 'treatment', label: '시술명 나열', re: /(botox|filler|laser|lifting|thermage|ulthera|onda|rejuran|skin\s*booster|shurink|potenza|보톡스|필러|리프팅|울쎄라|써마지|리쥬란|水光|音波|ボトックス)/i },
  { key: 'location', label: '위치·오시는 길 안내', re: /(station|exit\b|walk|📍|address|located|역\b|출구|徒歩|駅)/i },
  { key: 'foreignerFriendly', label: '외국인 응대 강조', re: /(english|foreigner|interpret|translat|multilingual|영어|외국인|通訳|翻訳|中文|口譯)/i }
];
function styleSignals(ads) {
  const withCopy = ads.filter((a) => a.copy && a.copy.length > 20);
  if (!withCopy.length) return null;
  const signals = STYLE.map((s) => ({ key: s.key, label: s.label, count: withCopy.filter((a) => s.re.test(a.copy)).length,
    share: withCopy.filter((a) => s.re.test(a.copy)).length / withCopy.length })).sort((a, b) => b.count - a.count);
  const emoji = withCopy.reduce((t, a) => t + (a.copy.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length, 0);
  return { adsAnalysed: withCopy.length, signals, avgCopyLength: Math.round(withCopy.reduce((t, a) => t + a.copy.length, 0) / withCopy.length),
    avgEmojiPerAd: +(emoji / withCopy.length).toFixed(1) };
}
if (competitors) {
  const deepNames = new Set(deepNow.map((d) => d.name.toLowerCase()));
  const keep = new Set(competitors.korean.slice(0, 8).map((a) => (a.name || '').toLowerCase()));
  competitors.ads = (comp.ads || []).filter((a) => a.advertiser && (keep.has(a.advertiser.toLowerCase()) || deepNames.has(a.advertiser.toLowerCase())));
  competitors.deepDive.forEach((d) => { d.style = styleSignals(d.ads || []); });
  competitors.styleOverall = styleSignals(competitors.deepDive.filter((d) => !d.isSelf).flatMap((d) => d.ads || []));
}

// Which countries each clinic's ads were seen in, with the count seen there. Countries not seen are
// "not confirmed" (see mergedDeep) - the page never shows them as "no ads".
const countryMatrix = (() => {
  if (!competitors) return null;
  const countries = [...new Set((comp.discovery || []).map((d) => d.country))];
  return { countries, precise: false, absenceUnreliable: true, rows: competitors.deepDive.map((d) => ({
    name: d.isSelf ? '뷰티블라썸 (우리)' : d.name, isSelf: !!d.isSelf, reason: d.selectionReason,
    activeAdCount: d.totalAds, earliestStart: d.earliestStart,
    cells: countries.map((c) => {
      const n = (d.ads || []).filter((a) => a.country === c).length;
      return { country: c, ads: n, state: n > 0 ? 'active' : 'unknown' };
    })
  })) };
})();

// Ads that state a price, detected mechanically from the ad text. Observation only - no legal
// judgement is made here or anywhere in the report.
const priceDisclosure = (() => {
  if (!comp) return null;
  const PRICE = /(₩\s?[\d,]+|[\d,]+\s?KRW|NT\$\s?[\d,]+|Rp\s?[\d.,]+|฿\s?[\d,]+|₱\s?[\d,]+|USD\s?[\d,]+|\$\s?[\d,]+|[\d,]+\s?원\b|[\d,]+\s?円)/g;
  const HAS_PRICE = new RegExp(PRICE.source); // .test() on a /g regex keeps state between calls
  const DISCOUNT = /(\d+\s*%\s*(off|할인|OFF)|할인|특가|割引|OFF\b|優惠|特價|ลด)/i;
  const all = deepNow.flatMap((d) => (d.ads || []).map((a) => ({ ...a, self: !!d.isSelf, clinic: d.name })));
  const withCopy = all.filter((a) => a.copy && a.copy.length > 20);
  const rivals = withCopy.filter((a) => !a.self), mine = withCopy.filter((a) => a.self);
  const priced = rivals.map((a) => ({ a, prices: [...new Set(a.copy.match(PRICE) || [])] })).filter((x) => x.prices.length);
  const rows = priced.map(({ a, prices }) => ({ advertiser: a.advertiser || a.clinic, country: a.country, started: a.startedRunning,
    adLibraryUrl: a.adLibraryUrl, prices: prices.slice(0, 4), hasDiscount: DISCOUNT.test(a.copy), snippet: a.copy.replace(/\n+/g, ' / ').slice(0, 200) }));
  return {
    method: `메타 광고 라이브러리에서 경쟁 병원 광고로 확인된 것 중 본문이 확보된 ${rivals.length}건을 대상으로 통화 기호와 금액 표기를 기계적으로 찾았습니다.`,
    legalNote: '위법 여부는 이 표에서 판단하지 않았습니다.',
    sample: { copyCaptured: withCopy.length, clinicAds: rivals.length, priceAds: rows.length },
    self: { totalWithCopy: mine.length, totalAds: all.filter((a) => a.self).length, priceAds: mine.filter((a) => HAS_PRICE.test(a.copy)).length, discountAds: mine.filter((a) => DISCOUNT.test(a.copy)).length },
    koreaExposed: rows.filter((r) => r.country === 'KR').length, discountAds: rows.filter((r) => r.hasDiscount).length, rows
  };
})();

// Which channels the ads themselves point people to, counted rather than assumed.
const channelMentions = (() => {
  if (!comp) return null;
  const all = [...deepNow.flatMap((d) => (d.ads || []).map((x) => ({ ...x, self: !!d.isSelf })))].filter((a) => a.copy);
  const rivals = all.filter((a) => !a.self), mine = all.filter((a) => a.self);
  const CH = [
    { name: 'WhatsApp', re: /whatsapp/i }, { name: 'LINE', re: /\bline\b|line@|라인/i }, { name: '인스타그램', re: /instagram|insta\b/i },
    { name: 'WeChat', re: /wechat|微信/i }, { name: '카카오톡', re: /kakao|카카오/i }, { name: '틱톡', re: /tiktok|틱톡|抖音/i },
    { name: '유튜브', re: /youtube|유튜브/i }, { name: 'X(트위터)', re: /twitter|\bX\.com/i }
  ];
  return { rivalTotal: rivals.length, selfTotal: mine.length, rows: CH.map((ch) => ({ name: ch.name,
    rival: rivals.filter((a) => ch.re.test(a.copy)).length,
    rivalLanding: rivals.filter((a) => a.landingDomain && ch.re.test(a.landingDomain)).length,
    self: mine.filter((a) => ch.re.test(a.copy)).length })).sort((a, b) => b.rival - a.rival) };
})();

// ---------------------------------------------------------------------------
// SERP scan
// ---------------------------------------------------------------------------
function serpSummary(s) {
  if (!s) return null;
  const rows = s.rows.filter((r) => !r.failed);
  const byMarket = ['JP', 'TW', 'EN'].map((k) => {
    const rs = rows.filter((r) => r.market === k);
    const all = rs.flatMap((r) => r.results);
    const share = (kind) => pct(all.filter((x) => x.kind === kind).length, all.length) || 0;
    return { market: k, label: rs[0]?.marketLabel || k, keywords: rs.length,
      clinicShare: share('korean-clinic') + share('rival'), mediaShare: share('media'),
      easiest: [...rs].sort((a, b) => a.clinicCount - b.clinicCount).slice(0, 5)
        .map((r) => ({ treatment: r.treatment, query: r.query, clinics: r.clinicCount, media: r.mediaCount })) };
  });
  const holders = new Map();
  for (const r of rows) for (const x of r.results) {
    if (x.kind !== 'korean-clinic' && x.kind !== 'rival') continue;
    if (!holders.has(x.host)) holders.set(x.host, { host: x.host, hits: [], best: 99 });
    const h = holders.get(x.host);
    h.hits.push({ market: r.marketLabel, treatment: r.treatment, rank: x.rank }); h.best = Math.min(h.best, x.rank);
  }
  const PARTNERS = [
    { name: '강남언니', re: /gangnamunni|gangnam-unni/i }, { name: '크리에이트립', re: /creatrip/i },
    { name: '여신티켓', re: /yeoshin/i }, { name: '바비톡', re: /babitalk/i }
  ];
  const partners = PARTNERS.map((p) => {
    const hits = [];
    rows.forEach((r) => r.results.forEach((x) => { if (p.re.test(x.host)) hits.push({ market: r.marketLabel, treatment: r.treatment, rank: x.rank }); }));
    hits.sort((a, b) => a.rank - b.rank);
    return { name: p.name, hits, count: hits.length };
  }).filter((p) => p.count > 0).sort((a, b) => b.count - a.count);
  return { note: s.note, source: s.source, totals: s.totals, byMarket,
    searchRivals: [...holders.values()].sort((a, b) => b.hits.length - a.hits.length || a.best - b.best).slice(0, 12), partners };
}
const serpScan = serpSummary(serp);
const serpScanPrev = serpSummary(serpPrev);

// ---------------------------------------------------------------------------
// Owned channels
// ---------------------------------------------------------------------------
const yt = monthly.sources.youtube.map((y) => {
  const c = y.months[BASE], p = y.months[COMPARE];
  const short = y.short;
  return { short, subscribers: y.subscribers,
    viewsPerDay: c?.days ? c.views / c.days : null, viewsPerDayPrev: p?.days ? p.views / p.days : null,
    views: c?.views, days: c?.days, gain: c ? c.gain - c.lost : null, gainPrev: p ? p.gain - p.lost : null,
    share: ytShare(short, BASE), sharePrev: ytShare(short, COMPARE), countries: (ytIn[short]?.countries?.[BASE] || []).slice(0, 7) };
});
const igAcc = monthly.sources.instagram.map((g) => ({ label: g.label, username: g.username, followers: g.followers,
  reach: g.months[BASE]?.reach, reachPrev: g.months[COMPARE]?.reach, views: g.months[BASE]?.views, viewsPrev: g.months[COMPARE]?.views,
  taps: g.months[BASE]?.profile_links_taps, tapsPrev: g.months[COMPARE]?.profile_links_taps }));
const igPosts = (inputs.sources.instagram_posts || []).map((a) => ({ label: a.label, username: a.username, count: a.posts.length,
  reachSum: sum(a.posts, (p) => p.reach || 0), top: a.posts.slice(0, 3).map((p) => ({ type: p.type, date: p.timestamp.slice(0, 10),
    reach: p.reach, views: p.views, shares: p.shares, saved: p.saved, caption: p.caption.replace(/\s+/g, ' ').slice(0, 44), permalink: p.permalink })) }));
const orgSocial = (label, key) => (ga4M[label]?.channels?.[key]?.['Organic Social'] || {}).sessions ?? null;

// ---------------------------------------------------------------------------
// Judgements. Assigned from the data above; every sentence restates a figure computed here.
// ---------------------------------------------------------------------------
const TH = MK.TH, EN = MK.EN, TW = MK.TW, JP = MK.JP, KR = MK.KR, CN = MK.CN, HK = MK.HK;
// GA4 names countries in English; the report reads them in Korean.
const KO_NAME = { 'South Korea': '한국', Philippines: '필리핀', Indonesia: '인도네시아', 'United Arab Emirates': '아랍에미리트',
  Qatar: '카타르', Malaysia: '말레이시아', 'South Africa': '남아공', India: '인도', 'United States': '미국', Canada: '캐나다',
  'Hong Kong': '홍콩', Taiwan: '대만', China: '중국', Japan: '일본', Thailand: '태국', Singapore: '싱가포르', Vietnam: '베트남',
  Macao: '마카오', 'United Kingdom': '영국', Australia: '호주', 'New Zealand': '뉴질랜드', 'Saudi Arabia': '사우디아라비아' };
const koName = (c) => KO_NAME[c] || c;
const cRow = (label, key, name) => (ga4In[label]?.countries?.[key] || []).find((c) => c.country === name) || { sessions: 0, inquirySessions: 0 };
const chOf = (label, key, name) => ga4M[label]?.channels?.[key]?.[name] || { sessions: 0, keyEvents: 0 };
// Top referring rows only (25 per site and month), so a source's figure is what those rows show.
const srcOf = (label, key, re) => { const rows = (ga4In[label]?.sources?.[key] || []).filter((r) => re.test(r.source));
  return { sessions: sum(rows, 'sessions'), keyEvents: sum(rows, 'keyEvents'), inquirySessions: sum(rows, 'inquirySessions'),
    pages: [...new Set(rows.map((r) => r.landingPage).filter((p) => p && p !== '(not set)'))] }; };
const kwFor = (mk) => keywordOps.filter((k) => k.market === mk).slice(0, 3)
  .map((k) => `<code>${esc(k.query)}</code>(노출 ${num(k.impressions)}·${k.position.toFixed(1)}위)`).join(', ');
const krNB = { base: nonBrand(BASE), prev: nonBrand(COMPARE) };
const d1 = (n) => (n == null ? '-' : n.toFixed(1));
const evRate = (c) => (c.sessions ? c.keyEvents / c.sessions : null);
const P0 = Object.fromEntries((prev?.markets || []).map((m) => [m.label, m]));

// EN: countries that at least doubled to 1,000+ sessions while returning almost no inquiries.
const enLow = (ga4In.EN.countries[BASE] || []).filter((c) => c.country !== 'South Korea' && c.sessions >= 1000
  && c.sessions >= 2 * cRow('EN', COMPARE, c.country).sessions && pct(c.inquirySessions, c.sessions) < 0.003);
const enLowS = sum(enLow, 'sessions'), enLowQ = sum(enLow, 'inquirySessions');
const enPH = { now: cRow('EN', BASE, 'Philippines'), prev: cRow('EN', COMPARE, 'Philippines') };
const enID = { now: cRow('EN', BASE, 'Indonesia'), prev: cRow('EN', COMPARE, 'Indonesia') };
const enDrop = (ga4In.EN.countries[COMPARE] || []).filter((c) => c.country !== 'South Korea')
  .map((c) => ({ country: c.country, prev: c.inquirySessions, now: cRow('EN', BASE, c.country).inquirySessions }))
  .filter((d) => d.now < d.prev).sort((a, b) => (a.now - a.prev) - (b.now - b.prev)).slice(0, 2);
// HK: the same city's visitors on the HK site and on the TW site.
const hkOnHK = cRow('HK', BASE, 'Hong Kong'), hkOnTW = cRow('TW', BASE, 'Hong Kong'), hkOnTWPrev = cRow('TW', COMPARE, 'Hong Kong');
const hkThreads = srcOf('HK', BASE, /threads/i);
// TH and JP: inquiry users and the ad channel split.
const thTH = { now: cRow('TH', BASE, 'Thailand'), prev: cRow('TH', COMPARE, 'Thailand') };
const thSearch = { now: chOf('TH', BASE, 'Paid Search'), prev: chOf('TH', COMPARE, 'Paid Search') };
const jpSearch = { now: chOf('JP', BASE, 'Paid Search'), prev: chOf('JP', COMPARE, 'Paid Search') };
const jpSocial = { now: chOf('JP', BASE, 'Paid Social'), prev: chOf('JP', COMPARE, 'Paid Social') };
const cnChina = { now: cRow('CN', BASE, 'China'), prev: cRow('CN', COMPARE, 'China') };
const krPaidSocial = { now: chOf('KR', BASE, 'Paid Social'), prev: chOf('KR', COMPARE, 'Paid Social') };
const hkRank = markets.filter((m) => m.label !== 'CN' && m.localRate != null).sort((a, b) => b.localRate - a.localRate).findIndex((m) => m.label === 'HK') + 1;
const hkStart = (ga4M.HK?.daily || []).find((r) => r.sessions > 0)?.date;
const igOf = (l) => igAcc.find((a) => a.label === l) || {}, igpOf = (l) => igPosts.find((a) => a.label === l);

const tiers = [
  { key: 'grow', title: '키울 곳', market: 'HK', accent: 's3',
    why: `${M.base}에 처음으로 한 달을 다 채운 시장입니다. 현지 접속 ${num(HK.local?.sessions)}회에서 문의가 나온 접속이 ${num(HK.local?.inquirySessions)}회로 현지 문의 발생률이 ${pc(HK.localRate, 2)}입니다. 광고 없이 들어온 접속이 ${pc(HK.ownedShare, 0)}입니다.`,
    actions: [
      `<b>홍콩 사람은 HK 사이트에서 더 많이 문의합니다.</b> ${M.base}에 HK 사이트로 들어온 홍콩 접속 ${num(hkOnHK.sessions)}회에서 문의가 나온 접속은 ${num(hkOnHK.inquirySessions)}회(${pc(pct(hkOnHK.inquirySessions, hkOnHK.sessions), 1)})였습니다. 같은 달 대만 사이트로 들어온 홍콩 접속은 ${num(hkOnTWPrev.sessions)}회에서 ${num(hkOnTW.sessions)}회로 늘었는데 문의가 나온 접속은 ${num(hkOnTW.inquirySessions)}회(${pc(pct(hkOnTW.inquirySessions, hkOnTW.sessions), 1)})입니다. 대만 광고가 홍콩에도 노출되고 있다면 홍콩 대상 광고의 도착지를 HK 사이트로 바꿔 비교하시길 권합니다.`,
      hkThreads.sessions ? `<b>스레드 링크가 HK 사이트 접속의 큰 몫을 만들었습니다.</b> 스레드에서 들어온 접속이 ${num(hkThreads.sessions)}회이고 문의 이벤트는 ${num(hkThreads.keyEvents)}건입니다. 도착 페이지는 ${hkThreads.pages.map((p) => `<code>${esc(p)}</code>`).join(', ')}입니다. 어느 계정의 어떤 글에서 들어왔는지는 이 자료로 확인하지 못했습니다.` : '',
      '<b>HK 인스타그램 계정은 수집 대상에 없습니다.</b> 홍콩용 SNS 계정을 운영하고 계시면 알려 주십시오. 다음 달부터 함께 집계하겠습니다.'
    ].filter(Boolean) },
  { key: 'fix', title: '손볼 곳', market: 'EN', accent: 's1',
    why: `접속은 하루 평균 ${sign(EN.sessionsDelta)} 늘었는데 현지 문의가 나온 접속은 ${num(EN.localPrev?.inquirySessions)}회에서 ${num(EN.local?.inquirySessions)}회로 늘지 않았습니다. 그래서 현지 문의 발생률이 ${pc(EN.localRatePrev, 2)}에서 ${pc(EN.localRate, 2)}로 내려갔습니다.`,
    actions: [
      enLow.length ? `<b>늘어난 접속의 상당 부분이 문의가 거의 없는 나라에서 왔습니다.</b> ${enLow.map((c) => `${koName(c.country)} ${num(cRow('EN', COMPARE, c.country).sessions)} → ${num(c.sessions)}회`).join(', ')}입니다. 이 ${enLow.length}개 나라 접속 ${num(enLowS)}회에서 문의가 나온 접속은 ${num(enLowQ)}회입니다.` : '',
      `<b>필리핀은 접속이 늘어난 만큼 문의도 늘었습니다.</b> 접속 ${num(enPH.prev.sessions)} → ${num(enPH.now.sessions)}회, 문의가 나온 접속 ${num(enPH.prev.inquirySessions)} → ${num(enPH.now.inquirySessions)}회입니다. 인도네시아는 접속 ${num(enID.prev.sessions)} → ${num(enID.now.sessions)}회, 문의가 나온 접속 ${num(enID.prev.inquirySessions)} → ${num(enID.now.inquirySessions)}회입니다.`,
      enDrop.length ? `문의가 가장 많이 줄어든 나라는 ${enDrop.map((d) => `${koName(d.country)}(${num(d.prev)} → ${num(d.now)}회)`).join(', ')}입니다.` : '',
      `<b>${M.base}에 광고 노출 국가를 넓히셨는지 확인이 필요합니다.</b> 광고 설정과 광고비 자료가 없어 확인하지 못했습니다. 넓혔다면 위 ${enLow.length}개 나라에 들어간 광고비를 필리핀·인도네시아와 문의 1건당 비용으로 비교한 뒤 유지 여부를 정하시길 권합니다.`
    ].filter(Boolean) },
  { key: 'check', title: '확인할 곳', market: 'TH', accent: 's2',
    why: `현지 문의가 나온 접속이 ${num(TH.localPrev?.inquirySessions)}회에서 ${num(TH.local?.inquirySessions)}회로 줄었습니다. 같은 기간 검색광고 접속은 ${num(thSearch.prev.sessions)}회에서 ${num(thSearch.now.sessions)}회로 줄지 않았습니다.`,
    actions: [
      `<b>검색광고 접속은 그대로인데 문의가 줄었습니다.</b> 검색광고 접속의 문의 이벤트는 ${num(thSearch.prev.keyEvents)}건에서 ${num(thSearch.now.keyEvents)}건이 됐습니다. 태국에서 접속한 문의 발생 접속은 ${num(thTH.prev.inquirySessions)}회에서 ${num(thTH.now.inquirySessions)}회입니다.`,
      `<b>${M.base}에 검색광고의 검색어나 도착 페이지를 바꾸셨는지 확인이 필요합니다.</b> 광고 관리자 자료가 없어 확인하지 못했습니다. ${M.base}에 새로 잡힌 SNS 광고 접속은 ${num(chOf('TH', BASE, 'Paid Social').sessions)}회이고 문의 이벤트는 ${num(chOf('TH', BASE, 'Paid Social').keyEvents)}건입니다.`
    ] },
  { key: 'check2', title: '확인할 곳', market: 'JP', accent: 's4',
    why: `현지 문의 발생률이 ${pc(JP.localRatePrev, 2)}에서 ${pc(JP.localRate, 2)}로 내려갔습니다. 접속은 하루 평균 ${sign(JP.sessionsDelta)}로 비슷했습니다.`,
    actions: [
      `<b>검색광고 접속이 줄고 SNS 광고 접속이 늘었습니다.</b> 검색광고 ${num(jpSearch.prev.sessions)} → ${num(jpSearch.now.sessions)}회, SNS 광고 ${num(jpSocial.prev.sessions)} → ${num(jpSocial.now.sessions)}회입니다.`,
      `<b>접속 100회당 문의 이벤트는 검색광고가 더 많습니다.</b> ${M.base} 검색광고 ${pc(evRate(jpSearch.now), 1)}, SNS 광고 ${pc(evRate(jpSocial.now), 1)}입니다(${M.compare} ${pc(evRate(jpSearch.prev), 1)}, ${pc(evRate(jpSocial.prev), 1)}). 광고비가 검색광고에서 SNS 광고로 옮겨 갔는지 확인이 필요합니다.`,
      kwFor('JP') ? `일본어 검색에서 순위만 올리면 되는 검색어는 ${kwFor('JP')}입니다.` : ''
    ].filter(Boolean) },
  { key: 'keep', title: '이어갈 곳', market: 'TW', accent: 's2',
    why: `현지 문의 발생률이 ${pc(TW.localRatePrev, 2)}에서 ${pc(TW.localRate, 2)}로 올랐습니다. 대만에서 접속한 문의 발생 접속이 ${num(cRow('TW', COMPARE, 'Taiwan').inquirySessions)}회에서 ${num(cRow('TW', BASE, 'Taiwan').inquirySessions)}회로 늘었습니다.`,
    actions: [
      `<b>${M.base} 리포트가 정한 목표(${pc(P0.TW?.localRatePrev, 2)})에는 못 미쳤습니다.</b> ${M.compare}보다는 올랐으니 지금 광고 구성을 유지하고 한 달 더 보시길 권합니다.`,
      igpOf('TW')?.top[0] ? `대만 인스타 릴스 1개("${esc(igpOf('TW').top[0].caption)}")의 도달이 ${num(igpOf('TW').top[0].reach)}회였습니다. 같은 달 대만 사이트에 광고가 아닌 SNS로 들어온 접속은 ${num(orgSocial('TW', BASE))}회이고 문의 이벤트는 ${num(chOf('TW', BASE, 'Organic Social').keyEvents)}건입니다.` : ''
    ].filter(Boolean) },
  { key: 'asset', title: '키워둘 곳', market: 'KR', accent: 's6',
    why: `광고 없이 들어오는 접속이 ${pc(KR.ownedShare, 0)}로 가장 높은 시장입니다. 문의가 나온 접속은 하루 ${d1(KR.inquiryPerDayPrev)}회에서 ${d1(KR.inquiryPerDay)}회입니다.`,
    actions: [
      `<b>병원 이름이 아닌 검색으로 들어온 클릭은 하루 ${krNB.prev ? (krNB.prev.clicks / compareDays).toFixed(1) : '-'}회에서 ${krNB.base ? (krNB.base.clicks / gscBaseDays).toFixed(1) : '-'}회입니다.</b> 새 고객이 검색으로 들어오는 길입니다.${kwFor('KR') ? ` 우선 대상은 ${kwFor('KR')}입니다.` : ''}`,
      `<b>SNS 광고 접속 ${num(krPaidSocial.now.sessions)}회에서 문의 이벤트는 ${num(krPaidSocial.now.keyEvents)}건이었습니다</b>(${M.compare} ${num(krPaidSocial.prev.sessions)}회에서 ${num(krPaidSocial.prev.keyEvents)}건). 국내 SNS 광고의 목적이 인지도라면 그대로 두셔도 됩니다. 문의가 목적이라면 점검이 필요합니다.`
    ] },
  { key: 'hold', title: '지켜볼 곳', market: 'CN', accent: 's5',
    why: `중국에서 온 접속이 ${num(cnChina.prev.sessions)}회에서 ${num(cnChina.now.sessions)}회로 또 늘었습니다. 거의 전부 주소를 직접 입력한 것으로 잡힌 접속이고 문의는 늘지 않았습니다.`,
    actions: [
      `중국에서 접속한 문의 발생 접속은 ${num(cnChina.prev.inquirySessions)}회에서 ${num(cnChina.now.inquirySessions)}회입니다. <b>이 접속이 어디서 오는지는 이번에도 확인하지 못했습니다.</b> 출처가 확인될 때까지 중국 사이트 접속 수는 성과 판단에 쓰지 않으시길 권합니다.`
    ] }
];

const organicPlays = [
  (() => {
    const tw = igpOf('TW')?.top[0], kr = igpOf('KR');
    return { title: '인스타 도달이 크게 늘었지만 홈페이지로 오는 길은 아직 좁습니다', priority: '높음',
      cost: '추가 비용 없음 (게시물 구성 변경)',
      evidence: `${M.base} 계정 도달은 ${['KR', 'EN', 'TW'].map((l) => `${l} ${num(igOf(l).reachPrev)} → ${num(igOf(l).reach)}회`).join(', ')}입니다. ` +
        (tw ? `대만은 릴스 1개가 ${num(tw.reach)}회로 계정 도달의 ${pc(tw.reach / igOf('TW').reach, 0)}를 차지했습니다. ` : '') +
        (kr ? `KR 계정이 ${M.base}에 올린 게시물 ${kr.count}개의 도달 합계는 ${num(kr.reachSum)}회입니다. 계정 도달의 나머지가 어느 게시물에서 나왔는지는 이 자료로 확인하지 못했습니다. ` : '') +
        `프로필 링크 클릭은 ${['KR', 'EN', 'TW'].map((l) => `${l} ${num(igOf(l).tapsPrev)} → ${num(igOf(l).taps)}회`).join(', ')}입니다.`,
      why: '도달은 영상이 만들고 문의는 홈페이지에서 나옵니다. 링크 클릭이 한 자릿수라 많이 본 영상이 문의로 이어졌는지 확인할 길이 없습니다.',
      how: '도달이 큰 릴스의 캡션 첫 줄과 고정 댓글에 시술 한 가지와 해당 국가 사이트 주소를 넣고 넣은 영상과 넣지 않은 영상의 링크 클릭 수를 비교합니다.',
      firstStep: `${M.exec}에 올리는 릴스 중 2개에만 사이트 주소를 넣고 ${M.next} 리포트에서 링크 클릭 수를 비교하시길 권합니다.`,
      langOrder: null, sources: tw ? [tw.permalink] : [] };
  })(),
  { title: '스레드 링크가 HK 사이트 문의를 만들었습니다', priority: '높음', cost: '추가 비용 없음',
    evidence: hkThreads.sessions ? `${M.base}에 스레드에서 HK 사이트로 들어온 접속은 ${num(hkThreads.sessions)}회로 HK 사이트 전체 접속 ${num(HK.sessions)}회 가운데 ${pc(hkThreads.sessions / HK.sessions, 0)}입니다. 문의 이벤트는 ${num(hkThreads.keyEvents)}건입니다.` : '스레드 유입 자료가 없습니다.',
    why: '광고비 없이 들어온 접속에서 문의가 나온 사례입니다. 같은 방식이 다른 시장에서도 통하는지는 아직 확인한 적이 없습니다.',
    how: '이 링크가 걸린 스레드 글을 찾아 형식(이벤트 소개·링크 위치)을 정리하고 같은 형식으로 대만 계정에도 대만 사이트 링크를 걸어 비교합니다.',
    firstStep: `${M.exec} 첫 주에 HK 접속을 만든 스레드 글을 확인하고 같은 형식의 글을 대만 계정에 1개 올리시길 권합니다.`,
    langOrder: null, sources: [] },
  (() => {
    const b = yt.find((y) => y.short === 'Doctor Lee');
    return { title: '해외 시청은 Doctor Lee 채널에서 나오고 있습니다', priority: '보통', cost: '추가 비용 없음',
      evidence: `Doctor Lee 채널의 ${M.base} 조회는 ${num(b?.views)}회입니다. 나라가 확인된 조회 ${num(b?.share?.total)}회 가운데 해외 비중이 ${pc(b?.share?.abroadShare, 0)}이고 상위 국가는 ${(b?.share?.top || []).map((c) => `${c.country} ${num(c.views)}`).join(' · ')}회입니다.`,
      why: `${M.base} 리포트는 이 채널 영상 설명란에 해외 사이트 링크를 넣자고 권했습니다. 실행 여부는 확인하지 못했습니다.`,
      how: '조회 상위 영상의 설명란과 고정 댓글에 시청 국가에 맞는 사이트 주소(en·jp·tw)를 넣습니다.',
      firstStep: 'Doctor Lee 채널 조회 상위 영상 5개의 설명란에 en.beautyblossom.kr 링크를 넣고 다음 달 GA4에서 유튜브 유입을 확인합니다.',
      langOrder: null, sources: [] };
  })()
];

// S6 flow and S7 targets. Each target is the market's own most recent good level, not a forecast.
const kpi = [
  { metric: '하루 평균 현지 문의 발생 접속', market: 'HK', now: `${d1(HK.inquiryPerDay)}회`, target: `${d1(HK.inquiryPerDay)}회 이상`, use: '첫 달 수준이 유지되는지 봅니다. 홍콩 대상 광고의 도착지를 바꿨다면 그 효과도 함께 봅니다' },
  { metric: '현지 문의 발생률', market: 'EN', now: pc(EN.localRate, 2), target: pc(EN.localRatePrev, 2), use: `${M.compare} 수준입니다. 필리핀·인도네시아와 새로 늘어난 나라를 나눠 함께 기록합니다` },
  { metric: '하루 평균 현지 문의 발생 접속', market: 'TH', now: `${d1(TH.inquiryPerDay)}회`, target: `${d1(TH.inquiryPerDayPrev)}회`, use: `${M.compare} 수준입니다. 검색광고 변경 내역과 함께 봅니다` },
  { metric: '현지 문의 발생률', market: 'JP', now: pc(JP.localRate, 2), target: pc(JP.localRatePrev, 2), use: `${M.compare} 수준입니다. 검색광고와 SNS 광고 접속을 나눠 기록합니다` },
  { metric: '현지 문의 발생률', market: 'TW', now: pc(TW.localRate, 2), target: pc(P0.TW?.localRatePrev ?? TW.localRate, 2), use: `${M.base} 리포트가 정한 목표를 그대로 둡니다` },
  { metric: '병원 이름이 아닌 검색 클릭 (하루)', market: 'KR', now: krNB.base ? (krNB.base.clicks / gscBaseDays).toFixed(1) + '회' : '-', target: krNB.prev ? (krNB.prev.clicks / compareDays).toFixed(1) + '회' : '-', use: `${M.compare} 수준입니다. 새 고객이 검색으로 들어오는지 봅니다` }
];
const flow = {
  nodes: [
    { id: 'start', col: 0, y: 40, w: 190, h: 44, t: `${M.exec} 시작`, kind: 'start' },
    { id: 'd1', col: 0, y: 118, w: 210, h: 60, t: '나라별 광고비 자료 받기\n광고 관리자', kind: 'act', c: '--ink2' },
    { id: 'hk1', col: 0, y: 210, w: 210, h: 60, t: `홍콩 광고 도착지 HK로\n현지 문의 ${d1(HK.inquiryPerDay)}회/일`, kind: 'act', c: '--s3' },
    { id: 'hkq', col: 1, y: 210, w: 210, h: 66, t: `하루 ${d1(HK.inquiryPerDay)}회\n유지되나?`, kind: 'dec', c: '--s3' },
    { id: 'hky', col: 2, y: 210, w: 200, h: 46, t: '스레드 형식 대만에 적용', kind: 'act', c: '--s6' },
    { id: 'en1', col: 0, y: 305, w: 210, h: 60, t: `EN 늘어난 나라 점검\n문의 ${num(enLowQ)}회/${num(enLowS)}회`, kind: 'act', c: '--s1' },
    { id: 'enq', col: 1, y: 305, w: 210, h: 66, t: `문의율 ${pc(EN.localRatePrev, 2)}로\n회복했나?`, kind: 'dec', c: '--s1' },
    { id: 'enn', col: 2, y: 305, w: 200, h: 46, t: '늘어난 나라 광고 축소 검토', kind: 'act', c: '--bad' },
    { id: 'th1', col: 0, y: 400, w: 210, h: 60, t: `태국 검색광고 변경 확인\n현지 문의 ${d1(TH.inquiryPerDay)}회/일`, kind: 'act', c: '--s2' },
    { id: 'thq', col: 1, y: 400, w: 210, h: 66, t: `${d1(TH.inquiryPerDayPrev)}회로\n돌아왔나?`, kind: 'dec', c: '--s2' },
    { id: 'jp1', col: 0, y: 495, w: 210, h: 60, t: '일본 검색광고·SNS 광고\n광고비 비율 확인', kind: 'act', c: '--s4' },
    { id: 'jpq', col: 1, y: 495, w: 210, h: 66, t: '문의 1건당\n광고비 비교', kind: 'act', c: '--s4' },
    { id: 'end', col: 3, y: 300, w: 180, h: 62, t: `${M.next}에 되짚기\n같은 기준으로 판단`, kind: 'start' }
  ],
  edges: [['start', 'd1'], ['d1', 'hk1'], ['hk1', 'hkq'], ['hkq', 'hky', '예'], ['en1', 'enq'], ['enq', 'enn', '아니오'],
    ['th1', 'thq'], ['jp1', 'jpq'], ['hky', 'end'], ['enn', 'end'], ['enq', 'end', '예'], ['thq', 'end'], ['jpq', 'end']]
};

// Summary: restates figures above; nothing new is asserted at the top.
const totalSessions = sum(markets, 'sessions');
const paidTotal = sum(markets, (m) => m.sessions * (m.paidShare || 0));
const localQ = sum(markets, (m) => m.local?.inquirySessions || 0), localQPrev = sum(markets, (m) => (m.localPrev?.inquirySessions || 0));
const summary = {
  tiles: [
    { k: `${M.base} 홈페이지 접속`, v: num(totalSessions / baseDays), d: `하루 평균 · ${markets.length}개 사이트 (${M.base} 1~${baseDays}일)` },
    { k: '광고로 온 비율', v: pc(paidTotal / totalSessions, 0), d: '광고를 멈추면 사라지는 몫' },
    { k: `${M.base} 목표 달성`, v: verify ? `${verify.met} / ${verify.judged}` : '-', d: verify ? `판정 가능한 ${verify.judged}개 기준${verify.rows.length > verify.judged ? ` · ${verify.rows.length - verify.judged}개는 판정 불가` : ''}` : '지난달 리포트 없음' },
    { k: '현지 문의가 나온 접속', v: num(localQ), d: `${M.compare} ${num(localQPrev)}회 · 한국 접속 제외` },
    { k: '현지 문의가 는 시장', v: markets.filter((m) => m.label !== 'CN' && m.inquiryDelta > 0.1).map((m) => m.label).join(' · ') || '없음', d: `하루 평균 기준 · ${M.compare} 대비` },
    { k: '조사한 경쟁 병원', v: num((competitors?.deepDive || []).filter((d) => !d.isSelf).length), d: `이들의 광고 ${num(sum((competitors?.deepDive || []).filter((d) => !d.isSelf), 'totalAds'))}건` }
  ],
  points: [
    verify ? `<b>${M.base} 리포트가 정한 목표 ${verify.rows.length}개 중 판정 가능한 ${verify.judged}개에서 ${verify.met ? verify.met + '개를 달성했습니다' : '하나도 달성하지 못했습니다'}.</b> ${verify.rows.filter((r) => r.verdict === '미달').map((r) => `${r.market} ${r.metric.replace(' (하루)', '')}(목표 ${r.target}, 실적 ${r.actual})`).join(', ')}(S0).` : '',
    `<b>EN 접속은 하루 평균 ${sign(EN.sessionsDelta)} 늘었는데 현지 문의는 늘지 않았습니다.</b> 늘어난 접속 중 ${enLow.map((c) => koName(c.country)).join('·')} ${num(enLowS)}회에서 문의가 나온 접속은 ${num(enLowQ)}회입니다. 필리핀은 문의도 ${num(enPH.prev.inquirySessions)} → ${num(enPH.now.inquirySessions)}회로 늘었습니다(S4).`,
    `<b>HK의 현지 문의 발생률은 ${pc(HK.localRate, 2)}로 ${hkRank === 1 ? '중국을 뺀 여섯 시장 중 가장 높습니다' : `중국을 뺀 여섯 시장 중 ${hkRank}번째입니다`}.</b> 대만 사이트로 들어온 홍콩 접속은 문의 발생률이 ${pc(pct(hkOnTW.inquirySessions, hkOnTW.sessions), 1)}입니다. 홍콩 대상 광고는 HK 사이트로 보내 비교하시길 권합니다(S4).`,
    `<b>태국과 일본은 현지 문의가 줄었습니다.</b> 태국은 검색광고 접속이 줄지 않았는데 문의 발생 접속이 ${num(TH.localPrev?.inquirySessions)} → ${num(TH.local?.inquirySessions)}회입니다. 일본은 검색광고 접속이 ${num(jpSearch.prev.sessions)} → ${num(jpSearch.now.sessions)}회로 줄었습니다. 두 시장 모두 광고 설정 확인이 먼저입니다(S4).`,
    `<b>${M.exec}에 가장 먼저 필요한 것은 나라별 광고비 자료입니다.</b> EN·태국·일본의 판단이 모두 문의 1건당 광고비에 달려 있는데 이 리포트는 광고비를 받지 못했습니다.`
  ].filter(Boolean)
};

const text = {
  preface: `이 보고서는 ${M.base} 성과 데이터와 ${M.exec} 직전 경쟁 병원 광고 조사를 근거로 <b>${M.exec}에 무엇을 할지</b> 정리한 문서입니다. ` +
    `맨 앞 S0에서 <b>${M.base} 리포트가 정한 목표를 이뤘는지</b> 같은 기준으로 먼저 확인했습니다. ` +
    `이번 달부터 ${hkStart ? `${+hkStart.slice(5, 7)}월 ${+hkStart.slice(8, 10)}일에 ` : ''}측정을 시작한 HK 사이트를 일곱 번째 시장으로 넣었습니다. ` +
    '모든 숫자는 구글 애널리틱스·구글 검색·유튜브·인스타그램·메타 광고 라이브러리에서 직접 받아 온 값입니다. ' +
    '확인하지 못한 것은 그 자리에 확인하지 못했다고 적었습니다. 전문 용어는 처음 나올 때 풀어 썼습니다.',
  chNote: (() => { const r = markets.filter((m) => m.label !== 'CN' && m.localRate != null).sort((a, b) => b.localRate - a.localRate);
    return `<b>막대 옆의 "현지 문의율"은 한국에서 접속한 문의를 뺀 값입니다.</b> 가장 높은 곳은 ${r.slice(0, 2).map((m) => `${m.label} ${pc(m.localRate, 2)}`).join(', ')}이고 가장 낮은 곳은 ${r.at(-1).label} ${pc(r.at(-1).localRate, 2)}입니다. ` +
      `중국은 출처를 알 수 없는 직접 접속이 많아 순위에서 뺐습니다(S4 지켜볼 곳).`; })(),
  marketNote: '<b>홈페이지 접속 횟수</b>는 사람 수가 아니라 접속한 횟수입니다. 병원에 실제로 오신 분 수와는 무관합니다. ' +
    `<b>하루 평균</b>으로 비교한 것은 ${M.base}이 ${baseDays}일, ${M.compare}이 ${compareDays}일로 길이가 다르기 때문입니다. HK는 ${M.compare}에 ${HK.daysPrev}일치 자료만 있어 그 일수로 나눴습니다. ` +
    '<b>현지 문의 발생률</b>은 한국 밖에서 접속한 횟수 100회 중 문의(폼 제출·메신저·전화 버튼)가 한 번이라도 나온 접속이 몇 번인지입니다. ' +
    '한 사람이 버튼을 여러 번 눌러도 한 번으로 셉니다. KR 사이트는 국내 환자와 원내 접속을 구분할 수 없어 전체를 그대로 셉니다.',
  koreaNote: (() => {
    const nf = inputs.sources.ga4.filter((g) => g.label !== 'KR').flatMap((g) => (g.key_events_by_country?.[BASE] || []).filter((r) => r.event !== 'form_submit'));
    const nfKr = sum(nf.filter((r) => r.country === 'South Korea'), 'keyEvents'), nfAll = sum(nf, 'keyEvents');
    return `<b>폼 문의</b>는 사이트의 문의 양식 제출이고 <b>문의 발생 접속</b>은 폼·메신저·전화 버튼 중 하나라도 누른 접속입니다. ` +
      `폼이 아닌 메신저·전화 버튼 문의는 ${M.base} ${num(nfAll)}건 중 ${num(nfKr)}건(${pc(nfKr / nfAll, 0)})만 한국에서 눌렸습니다. ` +
      '<b>원내에서 쓰는 PC·휴대폰의 인터넷 주소를 GA4에서 "내부 트래픽"으로 제외하면</b> 이런 보정 없이 바로 현지 기준 수치가 나옵니다.';
  })(),
  compChangeNote: `<b>조사 광고</b>는 병원 이름 조회와 본문 검색 조회 중 어느 쪽에서든 보인 광고를 합친 수입니다. ` +
    `이름 조회가 광고가 있는 병원도 "없음"으로 돌려주는 경우가 있어 ${M.exec} 숫자는 <b>확인된 최소치</b>입니다. ` +
    `그래서 광고 수가 줄었거나 어느 나라에서 광고를 멈췄다고는 판단하지 않았습니다. "노출이 확인되지 않은 나라"는 ${M.base}에는 보였는데 이번에는 보이지 않은 나라이며 멈췄다는 뜻이 아닙니다.`,
  absenceNote: (() => {
    const ex = deepNow.find((d) => !d.isSelf && d.byNameAds === 0 && d.totalAds > 0);
    return '<b>노란 칸은 "광고가 없다"는 뜻이 아닙니다.</b> 메타 광고 라이브러리는 병원 이름이나 페이지 번호로 조회하면 ' +
      '같은 날 본문 검색에서 광고가 보이는 병원도 "광고 없음"으로 돌려주는 경우가 있습니다' +
      (ex ? `(예: ${esc(ex.name)}는 이름 조회 0건, 본문 검색 ${ex.totalAds}건)` : '') + '. ' +
      '그래서 두 조회에서 실제로 보인 광고만 칠했고 보이지 않은 칸은 판단하지 않았습니다.';
  })(),
  ytNote: (() => { const a = yt.find((y) => y.short === '블라썸1호'), b = yt.find((y) => y.short === 'Doctor Lee');
    return `블라썸1호의 시청은 ${pc(1 - (a?.share?.abroadShare || 0), 0)}가 한국입니다. Doctor Lee 채널은 반대로 ${pc(b?.share?.abroadShare, 0)}가 해외입니다. ` +
      `두 비중은 유튜브가 나라를 알려 준 조회만으로 계산했습니다(블라썸1호 ${num(a?.share?.total)}/${num(a?.views)}회, Doctor Lee ${num(b?.share?.total)}/${num(b?.views)}회). ` +
      '같은 병원의 두 채널이 서로 다른 시청자를 만나고 있으니 해외 시장용 영상 링크는 Doctor Lee 채널에 두는 것이 이미 있는 시청을 쓰는 방법입니다.'; })(),
  footer: `이 파일은 매달 하나씩 따로 보관됩니다. ${M.next} 보고서에서 S7의 기준으로 ${M.exec} 판단이 맞았는지 되짚어 보겠습니다.`
};

// Page fix (S8 ③-2): named addresses added since last month, and whether they already earn impressions.
const pageFix = (() => {
  const kr = sitemapOf('beautyblossom.kr');
  const prevNamed = new Set(((prevInputs?.sources?.sitemaps || []).find((x) => x.host === 'beautyblossom.kr')?.named || [])
    .map((u) => new URL(u).pathname.replace(/\/$/, '')));
  const pagesOf = (label) => gscIn.find((s) => s.label === label)?.pages?.[BASE] || [];
  const NAMED = /^\/[a-z][a-z0-9-]*\/?$/;
  const krNew = (kr.named || []).map((u) => new URL(u).pathname.replace(/\/$/, '')).filter((p) => !prevNamed.has(p));
  const hits = pagesOf('KR').filter((p) => { const path = new URL(p.page).pathname.replace(/\/$/, ''); return NAMED.test(path) && krNew.includes(path) && path !== '/price'; })
    .sort((a, b) => b.impressions - a.impressions);
  const missing = ['rejuran', 'thermage', 'onda', 'potenza', 'juvelook'].filter((s) => !(kr.named || []).some((u) => u.includes(s)));
  return {
    finding: `${kr.fetched_at_utc?.slice(0, 10)} 사이트맵 기준으로 한국 사이트의 이름 주소는 ${prevNamed.size ? `${prevNamed.size}개에서 ` : ''}${kr.named?.length}개가 됐습니다. ` +
      (hits.length ? `<b>새로 생긴 이름 주소 페이지는 첫 달부터 검색에 잡혔습니다.</b> ${hits.slice(0, 6).map((p) => `${new URL(p.page).pathname}(노출 ${num(p.impressions)}·클릭 ${num(p.clicks)}·${p.position.toFixed(1)}위)`).join(', ')}입니다. ` : '') +
      (missing.length ? `<b>${missing.length === 5 ? '리쥬란·써마지·온다·포텐자·쥬베룩' : missing.join('·')}은 아직 이름 주소가 없습니다.</b>` : ''),
    caveat: '새 이름 주소 페이지가 원래 더 공들여 만든 페이지일 수도 있어 주소만의 효과라고 단정할 수는 없습니다.',
    notDesign: '"리디자인"으로 진행하시면 원하는 결과가 안 나옵니다. 순위를 만드는 것은 보이는 디자인이 아니라 아래 세 가지입니다.',
    steps: [
      { t: '주소에 시술 이름 넣기', d: '/16 → /rejuran 처럼 바꿉니다. 검색엔진과 사람 모두 주소만 보고 무슨 페이지인지 알 수 있어야 합니다.' },
      { t: '제목과 본문을 고객이 쓰는 말로', d: '③-1의 문제와 같습니다. 시술 정식 명칭과 고객이 쓰는 말을 함께 적어야 합니다.' },
      { t: '시술 하나에 페이지 하나', d: '여러 시술을 한 페이지에 몰아 넣으면 어느 검색어로도 잡히지 않습니다.' }
    ],
    order: '주소를 바꾸면 기존 순위가 한동안 흔들립니다. 그래서 <b>이미 순위가 나오는 이름 주소 페이지는 건드리지 마시고</b> 순위가 없는 것부터 손대십시오.',
    experiment: `<b>${M.base}에 이름 주소를 붙인 방식 그대로</b> 리쥬란·써마지부터 같은 작업을 하시길 권합니다. 두 달째 같은 권고입니다.`,
    unknown: '우리 사이트가 자동 접속을 차단해 페이지 내용을 직접 읽지 못했습니다. 숫자 주소 페이지 중 어느 것이 리쥬란·써마지 페이지인지는 확인하지 못했습니다.'
  };
})();

const payload = {
  meta: {
    builtAt: new Date().toISOString(), title: 'AI 분석 · 뷰티블라썸 통합 전략 리포트', month: MONTH, months: M,
    basis: { ga4: { start: PERIOD[BASE].start, end: PERIOD[BASE].end, days: baseDays }, ga4Prev: { start: PERIOD[COMPARE].start, end: PERIOD[COMPARE].end, days: compareDays },
      gsc: { start: PERIOD[BASE].start, end: gscLast, days: gscBaseDays }, competitors: comp?.generated_at_utc || null, competitorsPrev: compPrev?.generated_at_utc || null }
  },
  text, summary, verify, koreaShare, formDaily,
  markets, tiers, keywordOps: keywordOps.slice(0, 40), treatmentPlan, offeredNote: offered ? offered.note : null, wordingGaps,
  keywordMethod: { topCtrAssumed: TOP_CTR, minImpressions: MIN_IMPRESSIONS, rankBand: RANK_BAND },
  cityPattern, competitors, compChange, countryMatrix, organicPlays, channelMentions, priceDisclosure, pageFix,
  serpScan, serpScanPrev: serpScanPrev ? { totals: serpScanPrev.totals, byMarket: serpScanPrev.byMarket.map((b) => ({ market: b.market, clinicShare: b.clinicShare, mediaShare: b.mediaShare })) } : null,
  youtube: yt, instagram: { accounts: igAcc, posts: igPosts }, kpi, flow
};

// Creative links carry a signed expiry a few days out from collection, so a report holding the link
// goes blank while it is still the current month's file. The collector mirrors each creative locally
// at the size the page renders it; embedding the mirror keeps the pictures for as long as the report
// is kept. Falls back to the link when no mirror is there, which is what a run without ffmpeg leaves.
const CREATIVES = join(ROOT, '.cache', 'creatives');
const inlineCreative = (u) => {
  try {
    const p = join(CREATIVES, basename(new URL(u).pathname));
    return existsSync(p) ? 'data:image/jpeg;base64,' + readFileSync(p).toString('base64') : u;
  } catch { return u; }
};

// Everything derived from the raw ads is computed above. The page renders three ads per clinic, so
// carrying every ad inline would push the file past what an artifact link accepts.
if (payload.competitors) {
  const c = payload.competitors;
  const slim = (a) => ({
    libraryId: a.libraryId, adLibraryUrl: a.adLibraryUrl, country: a.country,
    advertiser: a.advertiser, advertiserUrl: a.advertiserUrl,
    startedRunning: a.startedRunning, multipleVersions: a.multipleVersions,
    landingUrl: a.landingUrl, landingDomain: a.landingDomain,
    creativeCount: a.creativeCount,
    creativeUrls: (a.creativeUrls || []).slice(0, 3).map(inlineCreative),
    copy: a.copy
  });
  c.deepDive = c.deepDive.map((d) => ({ ...d, ads: (d.ads || []).filter((a) => a.copy && a.copy.length > 20).slice(0, 3).map(slim) }));
  c.ads = [];
  c.discovery = c.discovery.map(({ country, query, status, ads }) => ({ country, query, status, ads }));
  c.korean = c.korean.slice(0, 12).map(({ name, activeAdCount, countries, classificationEvidence, earliestStart }) => ({ name, activeAdCount, countries, classificationEvidence, earliestStart }));
}

const TPL = join(ROOT, 'scripts', 'strategy-template.html');
const tpl = readFileSync(TPL, 'utf8');
// Ad copy is arbitrary advertiser text, so a literal </script> in it would close the data block early.
const json = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script');
const html = tpl.replace('/*__PAYLOAD__*/null', json);
if (html === tpl) { console.error('payload placeholder not found'); process.exit(1); }
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log('WROTE', OUT, (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
console.log('markets', markets.length, '| keyword ops', keywordOps.length, '| verify', verify ? `${verify.met}/${verify.judged}` : 'n/a',
  '| competitors', competitors ? competitors.deepDive.length : 'n/a', '| serp', serpScan ? serpScan.totals.queries : 'n/a');
