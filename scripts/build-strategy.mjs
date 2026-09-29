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
const num = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pc = (n, d = 1) => (n == null ? '—' : (n * 100).toFixed(d) + '%');
const sign = (n, d = 0) => (n == null ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + '%');
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
const LABELS = ['EN', 'TW', 'KR', 'JP', 'CN', 'TH'];
const ga4In = Object.fromEntries(inputs.sources.ga4.map((g) => [g.label, g]));
const ga4M = Object.fromEntries(monthly.sources.ga4.map((g) => [g.label, g]));

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
  const perDay = cur.sessions / baseDays, perDayPrev = pre.sessions / compareDays;
  const paidPerDay = sum(ch.filter((c) => PAID.test(c.channel)), 'sessions') / baseDays;
  const paidPerDayPrev = sum(chPrev.filter((c) => PAID.test(c.channel)), 'sessions') / compareDays;
  return {
    label, days: baseDays,
    sessions: cur.sessions, sessionsPerDay: perDay, sessionsDelta: pct(perDay - perDayPrev, perDayPrev),
    keyEvents: cur.keyEvents, convRate: pct(cur.keyEvents, cur.sessions),
    channels: ch,
    paidShare: share(ch, PAID, total), paidSocialShare: pct(sum(ch.filter((c) => c.channel === 'Paid Social'), 'sessions'), total),
    ownedShare: share(ch, OWNED, total), ownedSharePrev: share(chPrev, OWNED, totalPrev),
    paidPerDay, paidDelta: pct(paidPerDay - paidPerDayPrev, paidPerDayPrev),
    local: L, localPrev: Lp, localBaseline: Lb,
    localRate: L?.rate ?? null, localRatePrev: Lp?.rate ?? null,
    inquiryPerDay: L ? L.inquirySessions / baseDays : null,
    inquiryPerDayPrev: Lp ? Lp.inquirySessions / compareDays : null,
    inquiryDelta: L && Lp ? pct(L.inquirySessions / baseDays - Lp.inquirySessions / compareDays, Lp.inquirySessions / compareDays) : null,
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
    evidence: gapStat(/alltite|올타이트|hilo\s*wave|hilowave|하이로/i).text + ' — 두 자료가 서로 다르니 실제 운영 여부를 원내에서 확인해 주십시오' }
];

// ---------------------------------------------------------------------------
// S0: last month's targets against this month's results
// ---------------------------------------------------------------------------
const verify = (() => {
  if (!prev) return null;
  const P = Object.fromEntries(prev.markets.map((m) => [m.label, m]));
  const pDays = prev.meta.basis.ga4.days || 30;
  const rows = [];
  const tw = P.TW, en = P.EN, jp = P.JP;
  if (tw) {
    const act = MK.TW.convRate;
    rows.push({ metric: '문의 전환율', market: 'TW', baseline: pc(tw.convRate, 2), target: pc(tw.convRate * 2, 1),
      actual: pc(act, 2), verdict: act >= tw.convRate * 2 ? '달성' : '미달',
      note: `같은 정의(문의 이벤트 수 ÷ 접속)입니다. 한국에서 접속한 문의를 뺀 현지 기준으로는 ${pc(MK.TW.localBaseline?.rate, 2)} → ${pc(MK.TW.localRate, 2)}입니다.` });
  }
  if (en) {
    const act = MK.EN.ownedShare;
    rows.push({ metric: '광고 없이 들어온 비율', market: 'EN', baseline: pc(en.ownedShare, 1), target: pc(Math.min(en.ownedShare * 1.5, 1), 0),
      actual: pc(act, 1), verdict: act >= Math.min(en.ownedShare * 1.5, 1) ? '달성' : '미달',
      note: `${M.compare}은 ${pc(MK.EN.ownedSharePrev, 1)}였습니다.` });
  }
  if (jp) {
    const basePD = jp.sessions / pDays, act = MK.JP.sessionsPerDay;
    rows.push({ metric: '하루 평균 접속 (광고비 고정)', market: 'JP', baseline: `${num(basePD)}회`, target: `${num(basePD * 1.1)}회`,
      actual: `${num(act)}회`, verdict: '판정 불가',
      note: `이 기준은 광고비를 고정했을 때만 의미가 있는데, 광고비를 고정했는지는 확인하지 못했습니다. 광고로 들어온 접속이 ${M.compare} 대비 하루 평균 ${sign(MK.JP.paidDelta)} 변했습니다.` });
  }
  const krOps = (prev.keywordOps || []).filter((k) => k.market === 'KR');
  if (krOps.length) {
    const hr = sum(krOps, (k) => Math.max(0, k.headroom));
    const bl = nonBrand('baseline'), cur = nonBrand(BASE);
    const blDays = inputs.baseline?.gsc ? Math.round((Date.parse(inputs.baseline.gsc.end) - Date.parse(inputs.baseline.gsc.start)) / 86400000) + 1 : 30;
    rows.push({ metric: '병원 이름이 아닌 검색 클릭', market: 'KR', baseline: `${num(sum(krOps, 'clicks'))}회`, target: `+${num(hr * 0.3)}회`,
      // The target was an increase over a 30-day window, so the result is expressed the same way.
      actual: bl && cur ? `${sign((cur.bandClicks / gscBaseDays - bl.bandClicks / blDays) / (bl.bandClicks / blDays))} (30일 환산 ${((cur.bandClicks / gscBaseDays - bl.bandClicks / blDays) * 30) >= 0 ? '+' : ''}${num((cur.bandClicks / gscBaseDays - bl.bandClicks / blDays) * 30)}회)` : '—',
      verdict: bl && cur && (cur.bandClicks / gscBaseDays - bl.bandClicks / blDays) * 30 >= hr * 0.3 ? '달성' : '미달',
      note: bl && cur ? `지난달 기준값 ${num(sum(krOps, 'clicks'))}회는 상위 25개 검색어만 센 값이라, 이번에 같은 조건으로 전체 검색어를 다시 세었습니다. 기준 기간 ${num(bl.bandClicks)}회(${blDays}일, 하루 ${(bl.bandClicks / blDays).toFixed(1)}회) → ${M.base} ${num(cur.bandClicks)}회(${gscBaseDays}일, 하루 ${(cur.bandClicks / gscBaseDays).toFixed(1)}회). 조건 없이 센 병원 이름 아닌 검색 클릭 전체는 하루 ${(bl.clicks / blDays).toFixed(1)}회 → ${(cur.clicks / gscBaseDays).toFixed(1)}회입니다.` : '' });
  }
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
const followups = [
  { item: '대만 광고 문구·노출 대상을 새로 짜서 비교', status: '확인하지 못했습니다',
    fact: `광고 관리자 자료를 받지 못해 실행 여부를 확인하지 못했습니다. 대만 사이트의 SNS 광고 접속은 ${M.compare} ${num(sum(channelsOf('TW', COMPARE).filter((c) => c.channel === 'Paid Social'), 'sessions'))}회 → ${M.base} ${num(sum(channelsOf('TW', BASE).filter((c) => c.channel === 'Paid Social'), 'sessions'))}회였습니다.` },
  { item: '일본 광고비를 고정하고 접속 추이 보기', status: '확인하지 못했습니다',
    fact: `광고비 자료가 없습니다. 광고로 들어온 접속은 하루 평균 ${sign(MK.JP.paidDelta)} 변했는데, 이 변화가 광고비를 바꾼 결과인지는 확인하지 못했습니다. 그래서 S0 표의 일본 항목을 판정하지 않았습니다.` },
  { item: '리쥬란·써마지 페이지에 시술 이름 주소 달기', status: '반영되지 않았습니다',
    fact: `${inputs.sources.sitemaps[0]?.fetched_at_utc?.slice(0, 10) || ''} 사이트맵 기준으로 리쥬란·써마지·온다·포텐자·쥬베룩 이름이 들어간 주소는 5개 사이트 어디에도 없습니다.` },
  { item: '유튜브 영상에 외국어 제목·자막 달기', status: '확인하지 못했습니다',
    fact: (() => { const a = ytShare('블라썸1호', COMPARE), b = ytShare('블라썸1호', BASE);
      return a && b ? `블라썸1호 채널의 해외 시청 비중은 ${M.compare} ${pc(a.abroadShare, 0)} → ${M.base} ${pc(b.abroadShare, 0)}로 늘지 않았습니다.` : '유튜브 국가별 자료가 없습니다.'; })() },
  { item: '광고 도착지를 홈페이지·인스타로 나눠 비교 (대만)', status: '확인하지 못했습니다',
    fact: '광고 관리자 자료가 필요합니다.' },
  // Last month's "performed but zero search presence" list came from the top 25 queries per site only.
  // With every query in hand the same treatments do show up, so the finding is corrected here rather
  // than silently dropped from S8.
  ...(() => {
    const was = (prev?.treatmentPlan || []).filter((t) => t.totalImpressions === 0 && t.competitorAds > 0).map((t) => t.name);
    const now = treatmentPlan.filter((t) => was.includes(t.name) && t.totalImpressions > 0);
    if (!now.length) return [];
    return [{ item: `S8 ③ "하고 있는데 검색 노출이 0인 시술" (${now.map((t) => t.name.split(' ')[0]).join('·')})`, status: '정정합니다',
      fact: `지난달은 사이트당 상위 25개 검색어만 받아 노출이 0으로 보였습니다. 이번에 검색어 전체를 받아 보니 ${M.base}에 ` +
        now.map((t) => `${t.name.split(' ')[0]} 노출 ${num(t.totalImpressions)}회·클릭 ${num(t.totalClicks)}회`).join(', ') +
        '이었습니다. 노출은 되지만 클릭이 거의 없는 상태라, 이번 리포트에서는 S8 ①(순위가 뒤인 시술)에 넣었습니다. 이름 주소 페이지가 없다는 사실(③-2)은 그대로입니다.' }];
  })()
];

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
    legalNote: '이 표는 관측된 사실만 담습니다. 위법 여부를 판단하지 않았고 판단할 수도 없습니다. 실제 판단은 법률 검토를 받으시기 바랍니다.',
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
const TH = MK.TH, EN = MK.EN, TW = MK.TW, JP = MK.JP, KR = MK.KR, CN = MK.CN;
const enCountry = (key, name) => (ga4In.EN.countries[key] || []).find((c) => c.country === name) || { sessions: 0, inquirySessions: 0 };
const cnChina = { now: (ga4In.CN.countries[BASE] || []).find((c) => c.country === 'China') || {}, prev: (ga4In.CN.countries[COMPARE] || []).find((c) => c.country === 'China') || {} };
const krPaidSocial = { now: ga4M.KR.channels[BASE]?.['Paid Social'] || {}, prev: ga4M.KR.channels[COMPARE]?.['Paid Social'] || {} };
const kwFor = (mk) => keywordOps.filter((k) => k.market === mk).slice(0, 3)
  .map((k) => `<code>${esc(k.query)}</code>(노출 ${num(k.impressions)}·${k.position.toFixed(1)}위)`).join(', ');
const krNB = { base: nonBrand(BASE), prev: nonBrand(COMPARE) };

const tiers = [
  { key: 'grow', title: '키울 곳', market: 'TH', accent: 's3',
    why: `${M.base}에 검색광고가 시작된 뒤 현지 문의가 발생한 접속이 ${num(TH.localPrev?.inquirySessions)}회에서 ${num(TH.local?.inquirySessions)}회로 늘었습니다. 문의가 늘어난 유일한 시장입니다. 다만 한 달치이고 규모가 작습니다.`,
    actions: [
      `<b>검색광고를 그대로 유지하시길 권합니다.</b> ${M.base} 검색광고 접속 ${num(ga4M.TH.channels[BASE]?.['Paid Search']?.sessions)}회에서 문의 이벤트 ${num(ga4M.TH.channels[BASE]?.['Paid Search']?.keyEvents)}건이 나왔고, 현지 문의 발생률은 ${pc(TH.localRate)}(${M.compare} ${pc(TH.localRatePrev)})입니다.`,
      '<b>광고비를 알려 주시면 문의 1건당 광고비를 계산할 수 있습니다.</b> 지금은 광고비 자료가 없어 다른 시장과 효율을 비교하지 못합니다. 예산을 늘릴지는 그 비교가 나온 뒤에 정하는 것이 안전합니다.',
      `태국 인스타는 ${M.base} 게시물 ${num(igPosts.find((a) => a.label === 'TH')?.count)}개의 도달 합계가 ${num(igPosts.find((a) => a.label === 'TH')?.reachSum)}회로, 다섯 계정 중 가장 작습니다. 문의는 인스타가 아니라 검색광고에서 나오고 있습니다.`
    ] },
  { key: 'defend', title: '지킬 곳', market: 'EN', accent: 's1',
    why: `현지 문의가 발생한 접속이 ${num(EN.local?.inquirySessions)}회로 여전히 가장 많습니다. 그러나 접속은 하루 평균 ${sign(EN.sessionsDelta)} 늘었는데 현지 문의 발생률은 ${pc(EN.localRatePrev)}에서 ${pc(EN.localRate)}로 내려갔습니다.`,
    actions: [
      `<b>나라 구성이 바뀌었습니다.</b> 인도네시아 문의 발생 접속이 ${num(enCountry(COMPARE, 'Indonesia').inquirySessions)}회 → ${num(enCountry(BASE, 'Indonesia').inquirySessions)}회로 줄었고, 인도가 접속 ${num(enCountry(COMPARE, 'India').sessions)} → ${num(enCountry(BASE, 'India').sessions)}회·문의 발생 ${num(enCountry(COMPARE, 'India').inquirySessions)} → ${num(enCountry(BASE, 'India').inquirySessions)}회로 늘었습니다. 필리핀은 접속 ${num(enCountry(COMPARE, 'Philippines').sessions)} → ${num(enCountry(BASE, 'Philippines').sessions)}회, 문의 발생 ${num(enCountry(COMPARE, 'Philippines').inquirySessions)} → ${num(enCountry(BASE, 'Philippines').inquirySessions)}회입니다.`,
      `<b>${M.base}에 광고 대상 국가를 바꾸셨는지 확인이 필요합니다.</b> 광고 설정 자료가 없어 이 변화가 설정 변경 때문인지 확인하지 못했습니다. 설정을 바꾸지 않았다면 인도네시아 광고 성과가 떨어진 것이므로 그쪽부터 보셔야 합니다.`,
      kwFor('EN') ? `영문 검색에서 순위만 올리면 되는 검색어 — ${kwFor('EN')}.` : ''
    ].filter(Boolean) },
  { key: 'fix', title: '손볼 곳', market: 'TW', accent: 's2',
    why: (() => { const big = markets.filter((m) => m.sessions >= 10000 && m.label !== 'CN').sort((a, b) => a.localRate - b.localRate);
      return `접속은 하루 평균 ${sign(TW.sessionsDelta)}로 거의 그대로인데, 현지 문의가 발생한 접속은 하루 ${(TW.inquiryPerDayPrev || 0).toFixed(1)}회에서 ${(TW.inquiryPerDay || 0).toFixed(1)}회로 줄었습니다. ` +
        (big[0]?.label === 'TW' ? `현지 문의 발생률 ${pc(TW.localRate, 2)}는 접속 1만 회 이상 시장 중 가장 낮습니다(판단을 보류한 중국 제외).` : `현지 문의 발생률은 ${pc(TW.localRate, 2)}입니다.`); })(),
    actions: [
      `<b>${M.base} 리포트가 정한 규칙상 대만 예산을 옮길 조건에 해당합니다.</b> 목표 문의 전환율 ${verify?.rows.find((r) => r.market === 'TW')?.target || '—'}에 대해 실적 ${verify?.rows.find((r) => r.market === 'TW')?.actual || '—'}입니다. 다만 그 규칙이 옮길 곳으로 정한 EN도 ${M.base}에 문의 발생률이 내려갔으니, 옮기기 전에 시장별 문의 1건당 광고비부터 비교하시길 권합니다.`,
      `홍콩에서 온 접속이 ${num((ga4In.TW.countries[COMPARE] || []).find((c) => c.country === 'Hong Kong')?.sessions)}회 → ${num((ga4In.TW.countries[BASE] || []).find((c) => c.country === 'Hong Kong')?.sessions)}회로 늘었고, 그중 문의가 발생한 접속은 ${num((ga4In.TW.countries[BASE] || []).find((c) => c.country === 'Hong Kong')?.inquirySessions)}회입니다. ${M.base}에 새로 잡힌 기타 유료 광고 유입 ${num(ga4M.TW.channels[BASE]?.['Paid Other']?.sessions)}회에서는 문의가 ${num(ga4M.TW.channels[BASE]?.['Paid Other']?.keyEvents)}건이었습니다.`,
      `대만 인스타는 ${M.base} 조회가 ${num(igAcc.find((a) => a.label === 'TW')?.viewsPrev)} → ${num(igAcc.find((a) => a.label === 'TW')?.views)}회로 줄었습니다.`
    ] },
  { key: 'check', title: '확인할 곳', market: 'JP', accent: 's4',
    why: `광고로 들어온 접속이 하루 평균 ${sign(JP.paidDelta)} 줄면서 전체 접속도 ${sign(JP.sessionsDelta)} 줄었습니다. 현지 문의 발생률은 ${pc(JP.localRatePrev)}에서 ${pc(JP.localRate)}로 올랐습니다.`,
    actions: [
      '<b>광고비가 줄었는지부터 확인이 필요합니다.</b> 광고비가 줄어 접속이 줄었다면, 줄어든 만큼보다 문의가 덜 줄었다는 뜻이라 광고 효율은 나빠지지 않은 것입니다. 광고비가 그대로였다면 같은 돈으로 덜 사 온 것입니다. 두 경우의 대응이 반대입니다.',
      `문의가 발생한 접속은 하루 ${(JP.inquiryPerDayPrev || 0).toFixed(1)}회 → ${(JP.inquiryPerDay || 0).toFixed(1)}회입니다.`,
      kwFor('JP') ? `일본어 검색에서 순위만 올리면 되는 검색어 — ${kwFor('JP')}.` : ''
    ].filter(Boolean) },
  { key: 'asset', title: '키워둘 곳', market: 'KR', accent: 's6',
    why: `광고 없이 들어오는 접속이 ${pc(KR.ownedShare, 0)}로 여전히 가장 높은 시장입니다. 문의가 발생한 접속은 하루 ${(KR.inquiryPerDayPrev || 0).toFixed(1)}회 → ${(KR.inquiryPerDay || 0).toFixed(1)}회입니다.`,
    actions: [
      `<b>병원 이름이 아닌 검색으로 들어온 클릭이 줄었습니다</b> — 하루 ${krNB.prev ? (krNB.prev.clicks / compareDays).toFixed(1) : '—'}회 → ${krNB.base ? (krNB.base.clicks / gscBaseDays).toFixed(1) : '—'}회. 새 고객을 데려오는 검색이 줄었다는 뜻입니다.${kwFor('KR') ? ` 우선 대상 — ${kwFor('KR')}.` : ''}`,
      `<b>SNS 광고로 들어온 접속 ${num(krPaidSocial.now.sessions)}회에서 문의는 ${num(krPaidSocial.now.keyEvents)}건이었습니다</b>(${M.compare} ${num(krPaidSocial.prev.sessions)}회에서 ${num(krPaidSocial.prev.keyEvents)}건). 국내 SNS 광고의 목적이 문의가 아니라 인지도라면 그대로 두셔도 되지만, 문의가 목적이라면 점검 대상입니다.`,
      `인스타 KR 도달은 ${num(igAcc.find((a) => a.label === 'KR')?.reachPrev)} → ${num(igAcc.find((a) => a.label === 'KR')?.reach)}회로 늘었지만, 인스타·SNS에서 홈페이지로 들어온 접속은 ${num(orgSocial('KR', COMPARE))} → ${num(orgSocial('KR', BASE))}회였습니다(S4-1 참조).`
    ] },
  { key: 'hold', title: '판단 보류', market: 'CN', accent: 's5',
    why: `접속이 ${num(ga4M.CN.months[COMPARE].sessions)}회에서 ${num(CN.sessions)}회로 늘었는데, 늘어난 몫은 거의 전부 중국에서 주소를 직접 입력한 것으로 잡힌 접속이고 문의는 늘지 않았습니다.`,
    actions: [
      `중국에서 온 접속 ${num(cnChina.prev.sessions)}회 → ${num(cnChina.now.sessions)}회, 그중 문의가 발생한 접속 ${num(cnChina.prev.inquirySessions)}회 → ${num(cnChina.now.inquirySessions)}회입니다. <b>이 접속이 어디서 오는지는 확인하지 못했습니다.</b> 원인을 확인하기 전까지는 중국 사이트 수치로 판단하지 않으시길 권합니다.`,
      `중국 사이트의 현지 문의 발생 접속은 ${num(CN.localPrev?.inquirySessions)}회 → ${num(CN.local?.inquirySessions)}회로 거의 그대로입니다.`
    ] }
];

const organicPlays = [
  (() => {
    const kr = igPosts.find((a) => a.label === 'KR'); const top = kr?.top[0];
    const same = igPosts.filter((a) => a.label !== 'KR' && a.top[0] && /fish|魚|물고기|camera|カメラ/i.test(a.top[0].caption)).map((a) => a.label);
    return { title: '인스타는 기획형 릴스가 도달을 만들고, 홈페이지로는 아직 이어지지 않습니다', priority: '높음',
      cost: '추가 비용 없음 (게시물 구성 변경)',
      evidence: top ? `KR 계정의 ${M.base} 게시물 ${kr.count}개 도달 합계 ${num(kr.reachSum)}회 가운데 ${num(top.reach)}회(${pc(top.reach / kr.reachSum, 0)})가 릴스 1개("${top.caption}")에서 나왔습니다. 두 번째로 높은 게시물은 ${num(kr.top[1]?.reach)}회입니다. 같은 영상이 ${same.join('·') || '다른 계정'}에서도 그 계정의 1위였습니다. 그런데 인스타 등 SNS에서 홈페이지로 들어온 접속은 ${num(orgSocial('KR', COMPARE))} → ${num(orgSocial('KR', BASE))}회, 프로필 링크 클릭은 ${num(igAcc.find((a) => a.label === 'KR')?.tapsPrev)} → ${num(igAcc.find((a) => a.label === 'KR')?.taps)}회였습니다.` : '게시물 자료가 없습니다.',
      why: '도달은 기획 영상이 만들고 문의는 홈페이지에서 나옵니다. 지금은 둘 사이에 연결이 없어, 많이 본 영상이 문의로 이어졌는지 확인할 길이 없습니다.',
      how: '기획형 릴스는 계속 만들되, 영상 끝이나 캡션 첫 줄에 해당 시술 한 가지와 프로필 링크를 넣고, 넣은 영상과 넣지 않은 영상의 프로필 링크 클릭 수를 비교합니다.',
      firstStep: `${M.exec}에 올리는 기획형 릴스 2개에만 시술 안내와 링크 유도를 넣고, ${M.next} 리포트에서 링크 클릭 수를 비교하시길 권합니다.`,
      langOrder: null, sources: top ? [top.permalink] : [] };
  })(),
  (() => {
    const a = yt.find((y) => y.short === '블라썸1호'), b = yt.find((y) => y.short === 'Doctor Lee');
    return { title: '해외 시청은 이미 Doctor Lee 채널에서 나오고 있습니다', priority: '보통',
      cost: '추가 비용 없음',
      evidence: `블라썸1호 채널은 ${M.base} 조회 ${num(a?.views)}회(${a?.days}일) 중 해외 비중 ${pc(a?.share?.abroadShare, 0)}(${M.compare} ${pc(a?.sharePrev?.abroadShare, 0)})입니다. Doctor Lee 채널은 ${M.base} 조회 ${num(b?.views)}회 중 해외 비중 ${pc(b?.share?.abroadShare, 0)}이고, 상위 국가는 ${(b?.share?.top || []).map((c) => `${c.country} ${num(c.views)}`).join(' · ')}회입니다.`,
      why: `${M.base} 리포트는 블라썸1호 영상에 외국어 자막을 달자고 권했는데, 실행 여부는 확인하지 못했고 해외 비중은 늘지 않았습니다. 해외 시청이 실제로 일어나고 있는 곳은 Doctor Lee 채널입니다.`,
      how: 'Doctor Lee 채널 영상 설명란과 고정 댓글에 시청 국가에 맞는 사이트 주소(en·jp·tw)를 넣습니다. 블라썸1호는 국내 시청자용으로 두고 두 채널의 역할을 나눕니다.',
      firstStep: 'Doctor Lee 채널 조회 상위 영상 5개의 설명란에 en.beautyblossom.kr 링크를 넣고, 다음 달 GA4에서 유튜브 유입을 확인합니다.',
      langOrder: null, sources: [] };
  })(),
  { title: '광고를 눌렀을 때 어디로 보낼지 나눠서 비교하기 (지난달 권고 유지)', priority: '보통',
    cost: '추가 비용 없음 (광고 설정 변경)',
    evidence: channelMentions ? `경쟁사 광고 ${num(channelMentions.rivalTotal)}건 중 인스타그램으로 보내는 광고가 ${num(channelMentions.rows.find((r) => r.name === '인스타그램')?.rivalLanding)}건입니다. ${M.base} 리포트에서 권한 이 비교는 실행 여부를 확인하지 못했습니다.` : '',
    why: '어느 쪽이 나은지는 우리 숫자로 비교해 본 적이 없습니다.',
    how: '같은 광고를 두 벌로 나눠 한쪽은 홈페이지, 한쪽은 해당 국가 인스타 계정으로 보내고 문의 발생률을 비교합니다.',
    firstStep: `문의 발생률이 가장 낮은 대만(${pc(TW.localRate, 2)})부터 시작하시길 권합니다.`,
    langOrder: null, sources: [] }
];

// S6 flow and S7 targets. Each target is the market's own most recent good level, not a forecast.
const kpi = [
  { metric: '현지 문의 발생률', market: 'TW', now: pc(TW.localRate, 2), target: pc(TW.localRatePrev, 2), use: `${M.compare} 수준입니다. 못 미치면 대만 광고 예산을 줄이고, 옮길 곳은 시장별 문의 1건당 광고비를 비교해 정합니다` },
  { metric: '하루 평균 현지 문의 발생 접속', market: 'TH', now: `${(TH.inquiryPerDay || 0).toFixed(1)}회`, target: `${(TH.inquiryPerDay || 0).toFixed(1)}회 이상`, use: '광고 첫 달 수준이 유지되는지 봅니다. 유지되면 광고비 자료와 함께 증액을 검토합니다' },
  { metric: '현지 문의 발생률', market: 'EN', now: pc(EN.localRate, 2), target: pc(EN.localRatePrev, 2), use: `${M.compare} 수준입니다. 인도·인도네시아·필리핀을 나눠 함께 기록합니다` },
  { metric: '병원 이름이 아닌 검색 클릭 (하루)', market: 'KR', now: krNB.base ? (krNB.base.clicks / gscBaseDays).toFixed(1) + '회' : '—', target: krNB.prev ? (krNB.prev.clicks / compareDays).toFixed(1) + '회' : '—', use: `${M.compare} 수준입니다. 새 고객이 검색으로 들어오는지 봅니다` },
  { metric: '해외 사이트 문의 중 한국에서 접속한 비율', market: '전체', now: pc(sum(koreaShare, (k) => k.base.korea || 0) / sum(koreaShare, (k) => k.base.inquiry || 0), 0), target: '원내 접속 제외 설정', use: '원내 PC·휴대폰 접속을 GA4에서 제외해야 모든 시장의 문의 수를 같은 기준으로 셀 수 있습니다' }
];
const flow = {
  nodes: [
    { id: 'start', col: 0, y: 40, w: 190, h: 44, t: `${M.exec} 시작`, kind: 'start' },
    { id: 'd1', col: 0, y: 118, w: 210, h: 60, t: '문의 집계 정리\n원내 접속 제외 설정', kind: 'act', c: '--ink2' },
    { id: 'th1', col: 0, y: 210, w: 210, h: 60, t: `태국 검색광고 유지\n현지 문의 ${num(TH.local?.inquirySessions)}회/월`, kind: 'act', c: '--s3' },
    { id: 'thq', col: 1, y: 210, w: 210, h: 66, t: `하루 ${(TH.inquiryPerDay || 0).toFixed(1)}회\n유지되나?`, kind: 'dec', c: '--s3' },
    { id: 'thy', col: 2, y: 210, w: 200, h: 46, t: '광고비 확인 후 증액 검토', kind: 'act', c: '--s6' },
    { id: 'tw1', col: 0, y: 305, w: 210, h: 60, t: `대만 광고 점검\n현지 문의율 ${pc(TW.localRate, 2)}`, kind: 'act', c: '--s2' },
    { id: 'twq', col: 1, y: 305, w: 210, h: 66, t: `${pc(TW.localRatePrev, 2)}로\n회복했나?`, kind: 'dec', c: '--s2' },
    { id: 'twn', col: 2, y: 305, w: 200, h: 46, t: '대만 예산 축소', kind: 'act', c: '--bad' },
    { id: 'en1', col: 0, y: 400, w: 210, h: 60, t: 'EN 광고 대상 국가 확인\n인도네시아↓ 인도↑', kind: 'act', c: '--s1' },
    { id: 'enq', col: 1, y: 400, w: 210, h: 66, t: `문의율 ${pc(EN.localRatePrev, 2)}로\n회복했나?`, kind: 'dec', c: '--s1' },
    { id: 'jp1', col: 0, y: 495, w: 210, h: 60, t: '일본 광고비 확인\n광고 접속 ' + sign(JP.paidDelta), kind: 'act', c: '--s4' },
    { id: 'jpq', col: 1, y: 495, w: 210, h: 66, t: '문의 1건당\n광고비 계산', kind: 'act', c: '--s4' },
    { id: 'end', col: 3, y: 300, w: 180, h: 62, t: `${M.next}에 되짚기\n같은 기준으로 판단`, kind: 'start' }
  ],
  edges: [['start', 'd1'], ['d1', 'th1'], ['th1', 'thq'], ['thq', 'thy', '예'], ['tw1', 'twq'], ['twq', 'twn', '아니오'],
    ['en1', 'enq'], ['jp1', 'jpq'], ['thy', 'end'], ['twn', 'end'], ['twq', 'end', '예'], ['enq', 'end'], ['jpq', 'end']]
};

// Summary: restates figures above; nothing new is asserted at the top.
const totalSessions = sum(markets, 'sessions');
const paidTotal = sum(markets, (m) => m.sessions * (m.paidShare || 0));
const foreignInq = sum(koreaShare, (k) => k.compare.form.total), foreignInqKr = sum(koreaShare, (k) => k.compare.form.korea);
const summary = {
  tiles: [
    { k: `${M.base} 홈페이지 접속`, v: num(totalSessions / baseDays), d: `하루 평균 · 6개 사이트 (${M.base} 1~${baseDays}일)` },
    { k: '광고로 온 비율', v: pc(paidTotal / totalSessions, 0), d: '광고를 멈추면 사라지는 몫' },
    { k: `${M.base} 목표 달성`, v: verify ? `${verify.met} / ${verify.judged}` : '—', d: verify ? `판정 가능한 ${verify.judged}개 기준${verify.rows.length > verify.judged ? ` · ${verify.rows.length - verify.judged}개는 판정 불가` : ''}` : '지난달 리포트 없음' },
    { k: `해외 사이트 폼 문의 중 한국 접속`, v: pc(foreignInqKr / foreignInq, 0), d: `${M.compare} ${num(foreignInq)}건 중 ${num(foreignInqKr)}건` },
    { k: '현지 문의가 는 시장', v: markets.filter((m) => m.label !== 'CN' && m.inquiryDelta > 0.1).map((m) => m.label).join(' · ') || '없음', d: `하루 평균 기준 · ${M.compare} 대비` },
    { k: '조사한 경쟁 병원', v: num((competitors?.deepDive || []).filter((d) => !d.isSelf).length), d: `이들의 광고 ${num(sum((competitors?.deepDive || []).filter((d) => !d.isSelf), 'totalAds'))}건` }
  ],
  points: [
    verify ? `<b>${M.base} 리포트가 정한 목표 ${verify.rows.length}개 중 판정 가능한 ${verify.judged}개에서 ${verify.met ? verify.met + '개를 달성했습니다' : '하나도 달성하지 못했습니다'}.</b> ${verify.rows.filter((r) => r.verdict === '미달').map((r) => `${r.market} ${r.metric}(목표 ${r.target}, 실적 ${r.actual})`).join(', ')}. ${verify.rows.some((r) => r.verdict === '판정 불가') ? verify.rows.filter((r) => r.verdict === '판정 불가').map((r) => r.market).join('·') + '은 광고비 자료가 없어 판정하지 않았습니다' : ''}(S0).` : '',
    `<b>문의 집계를 바로잡았습니다.</b> ${M.compare} 해외 사이트 폼 문의 ${num(foreignInq)}건 중 ${num(foreignInqKr)}건이 한국에서 접속한 소수 인원이 보낸 것이었습니다. 지난달 리포트의 문의 전환율은 이것을 포함한 값입니다. 이번 리포트는 모든 시장을 한국 접속을 뺀 <b>현지 기준</b>으로 판단합니다(S0).`,
    (() => { const up = markets.filter((m) => m.label !== 'CN' && m.inquiryDelta > 0.1), down = markets.filter((m) => m.label !== 'CN' && m.inquiryDelta < -0.1);
      return `<b>현지 기준으로 문의가 는 곳은 ${up.map((m) => m.label).join('·') || '없습니다'}${up.length ? '입니다' : ''}.</b> ` +
        (up.some((m) => m.label === 'TH') ? `태국은 검색광고를 시작한 ${M.base}에 문의 발생 접속이 ${num(TH.localPrev?.inquirySessions)} → ${num(TH.local?.inquirySessions)}회가 됐습니다. ` : '') +
        (down.length ? `${down.map((m) => `${m.label}(${sign(m.inquiryDelta)})`).join('·')}은 하루 평균으로 줄었습니다.` : ''); })(),
    (() => { const kr = igPosts.find((a) => a.label === 'KR'); return kr?.top[0] ? `<b>인스타 KR 도달이 ${num(igAcc.find((a) => a.label === 'KR')?.reachPrev)} → ${num(igAcc.find((a) => a.label === 'KR')?.reach)}회로 늘었는데, ${pc(kr.top[0].reach / kr.reachSum, 0)}가 릴스 1개에서 나왔습니다.</b> 같은 달 SNS에서 홈페이지로 온 접속은 오히려 줄어, 도달이 문의로 이어지는 연결을 만드는 것이 ${M.exec} 과제입니다(S4-1).` : ''; })(),
    `<b>${M.exec}에 가장 먼저 필요한 것은 시장별 광고비 자료입니다.</b> 일본·대만·EN의 판단이 모두 "문의 1건당 광고비"에 달려 있는데, 이 리포트는 광고비를 받지 못했습니다.`
  ].filter(Boolean)
};

const text = {
  preface: `이 보고서는 ${M.base} 성과 데이터와 ${M.exec} 초 경쟁 병원 광고 조사를 근거로 <b>${M.exec}에 무엇을 할지</b> 정리한 문서입니다. ` +
    `맨 앞 S0에서 <b>${M.base} 리포트의 판단이 맞았는지</b>를 같은 기준으로 먼저 확인했습니다. ` +
    '모든 숫자는 구글 애널리틱스·구글 검색·유튜브·인스타그램·메타 광고 라이브러리에서 직접 받아 온 실측값입니다. ' +
    '확인하지 못한 것은 추측으로 채우지 않고 그 자리에 밝혀 두었습니다. 전문 용어는 처음 나올 때 풀어 썼습니다.',
  chNote: `<b>막대 옆의 "현지 문의율"은 한국에서 접속한 문의를 뺀 값입니다.</b> 가장 높은 곳은 태국 ${pc(TH.localRate)}, EN ${pc(EN.localRate)}이고 가장 낮은 곳은 대만 ${pc(TW.localRate, 2)}입니다. ` +
    `중국은 ${M.base}에 중국발 직접 접속이 크게 늘어 문의율이 낮아졌습니다 — 이 접속의 출처는 확인하지 못했습니다(S4 판단 보류).`,
  marketNote: '<b>홈페이지 접속 횟수</b>는 사람 수가 아니라 접속한 횟수입니다. 병원에 실제로 오신 분 수와는 무관합니다. ' +
    `<b>하루 평균</b>으로 비교한 것은 ${M.base} 자료가 ${baseDays}일, ${M.compare}이 ${compareDays}일이라 길이가 다르기 때문입니다. ` +
    '<b>현지 문의 발생률</b>은 한국 밖에서 접속한 횟수 100회 중 문의(폼 제출·메신저·전화 버튼)가 한 번이라도 나온 접속이 몇 번인지입니다. ' +
    '한 사람이 버튼을 여러 번 눌러도 한 번으로 셉니다. KR 사이트는 국내 환자와 원내 접속을 구분할 수 없어 전체를 그대로 셉니다.',
  koreaNote: (() => {
    // Non-form inquiries (messenger and phone buttons) from Korea, as a share of all non-form ones.
    const nf = inputs.sources.ga4.filter((g) => g.label !== 'KR').flatMap((g) => (g.key_events_by_country?.[COMPARE] || []).filter((r) => r.event !== 'form_submit'));
    const nfKr = sum(nf.filter((r) => r.country === 'South Korea'), 'keyEvents'), nfAll = sum(nf, 'keyEvents');
    const peak = [...formDaily].sort((a, b) => b.foreign - a.foreign).slice(0, 3).map((d) => `${+d.date.slice(4, 6)}/${+d.date.slice(6)} ${d.foreign}건`).join(', ');
    return `<b>폼 문의</b>는 사이트의 문의 양식 제출이고, <b>문의 발생 접속</b>은 폼·메신저·전화 버튼 중 하나라도 누른 접속입니다. ` +
      `해외 사이트 폼 문의가 가장 많았던 날은 ${peak}입니다. ` +
      `폼이 아닌 메신저·전화 버튼 문의는 ${M.compare} ${num(nfAll)}건 중 ${num(nfKr)}건(${pc(nfKr / nfAll, 0)})만 한국에서 눌렸습니다. ` +
      '<b>원내에서 쓰는 PC·휴대폰의 인터넷 주소를 GA4에서 "내부 트래픽"으로 제외하면</b> 이런 보정 없이 바로 현지 기준 수치가 나옵니다.';
  })(),
  compChangeNote: `<b>조사 광고</b>는 병원 이름 조회와 본문 검색 조회 중 어느 쪽에서든 보인 광고를 합친 수입니다. ` +
    `이번 달은 이름 조회가 광고가 있는 병원도 "없음"으로 돌려준 경우가 있어, ${M.exec} 숫자는 <b>확인된 최소치</b>입니다. ` +
    `그래서 광고 수가 줄었거나 어느 나라에서 광고를 멈췄다고는 판단하지 않았습니다. "노출이 확인되지 않은 나라"는 ${M.base}에는 보였는데 이번에는 보이지 않은 나라이며, 멈췄다는 뜻이 아닙니다.`,
  absenceNote: (() => {
    const ex = deepNow.find((d) => !d.isSelf && d.byNameAds === 0 && d.totalAds > 0);
    return '<b>노란 칸은 "광고가 없다"는 뜻이 아닙니다.</b> 이번 달 메타 광고 라이브러리는 병원 이름이나 페이지 번호로 조회하면 ' +
      '같은 날 본문 검색에서 광고가 보이는 병원도 "광고 없음"으로 돌려줬습니다' +
      (ex ? `(예: ${esc(ex.name)}는 이름 조회 0건, 본문 검색 ${ex.totalAds}건 — ${ex.activeCountries.join('·')})` : '') + '. ' +
      '그래서 두 조회에서 실제로 보인 광고만 칠했고, 보이지 않은 칸은 판단하지 않았습니다. ' +
      `${M.base} 리포트는 같은 표의 회색 칸을 "정말 노출이 없는 것"으로 설명했는데, 이번 확인으로 그 설명은 맞다고 볼 수 없게 됐습니다.`;
  })(),
  ytNote: (() => { const a = yt.find((y) => y.short === '블라썸1호'), b = yt.find((y) => y.short === 'Doctor Lee');
    return `블라썸1호의 시청은 ${pc(1 - (a?.share?.abroadShare || 0), 0)}가 한국입니다. Doctor Lee 채널은 반대로 ${pc(b?.share?.abroadShare, 0)}가 해외입니다. ` +
      '같은 병원의 두 채널이 서로 다른 시청자를 만나고 있으니, 해외 시장용 영상 링크는 Doctor Lee 채널에 두는 것이 이미 있는 시청을 쓰는 방법입니다.'; })(),
  footer: `이 파일은 매달 하나씩 따로 보관됩니다. ${M.next} 보고서에서 S7의 기준으로 ${M.exec} 판단이 맞았는지 되짚어 보겠습니다.`
};

// Page fix (S8 ③-2): last month's recommendation, re-checked against today's sitemaps and pages.
const pageFix = (() => {
  const kr = sitemapOf('beautyblossom.kr'), en = sitemapOf('en.beautyblossom.kr');
  const pagesOf = (label) => gscIn.find((s) => s.label === label)?.pages?.[BASE] || [];
  const named = (label, re) => pagesOf(label).filter((p) => re.test(new URL(p.page).pathname)).map((p) => `${new URL(p.page).pathname}(노출 ${num(p.impressions)}·${p.position.toFixed(1)}위)`);
  return {
    finding: `${kr.fetched_at_utc?.slice(0, 10)} 사이트맵을 다시 받아 보니 한국 ${kr.urls?.length}개·영문 ${en.urls?.length}개 주소 가운데 숫자가 아닌 이름 주소는 각각 ${kr.named?.length}개·${en.named?.length}개입니다. ` +
      '<b>리쥬란·써마지·온다·포텐자·쥬베룩은 여전히 이름 주소가 없습니다</b> — 지난달 권고는 반영되지 않았습니다. ' +
      `반대로 이름 주소가 있는 페이지는 검색 노출이 잡힙니다: ${[...named('KR', /hilo|alltite|re2o/i), ...named('EN', /re2o|sculptra|ldm|hilo|alltite/i).map((s) => 'EN ' + s)].slice(0, 6).join(', ')}.`,
    caveat: '이건 상관관계이지 인과관계는 아닙니다. 이름 주소를 붙인 페이지가 원래 더 공들여 만든 페이지일 수도 있습니다.',
    notDesign: '"리디자인"으로 진행하시면 원하는 결과가 안 나옵니다. 순위를 만드는 것은 보이는 디자인이 아니라 아래 세 가지입니다.',
    steps: [
      { t: '주소에 시술 이름 넣기', d: '/16 → /rejuran 처럼 바꿉니다. 검색엔진과 사람 모두 주소만 보고 무슨 페이지인지 알 수 있어야 합니다.' },
      { t: '제목과 본문을 고객이 쓰는 말로', d: '③-1의 문제와 같습니다. 시술 정식 명칭과 고객이 쓰는 말을 함께 적어야 합니다.' },
      { t: '시술 하나에 페이지 하나', d: '여러 시술을 한 페이지에 몰아 넣으면 어느 검색어로도 잡히지 않습니다.' }
    ],
    order: '주소를 바꾸면 기존 순위가 한동안 흔들립니다. 그래서 <b>이미 순위가 나오는 이름 주소 페이지는 건드리지 마시고</b>, 순위가 없는 것부터 손대십시오.',
    experiment: '<b>다섯 개를 한꺼번에 바꾸지 마십시오.</b> 리쥬란·써마지 두 개만 먼저 하고 나머지 셋은 그대로 두시면 6~8주 뒤 둘을 비교해 답을 얻을 수 있습니다. 지난달과 같은 권고입니다.',
    unknown: '우리 사이트가 자동 접속을 차단해 페이지 내용을 직접 읽지 못했습니다. 숫자 주소 페이지 중 어느 것이 리쥬란·써마지 페이지인지는 확인하지 못했습니다.'
  };
})();

const payload = {
  meta: {
    builtAt: new Date().toISOString(), title: 'AI 분석 · 뷰티블라썸 통합 전략 리포트', month: MONTH, months: M,
    basis: { ga4: { start: PERIOD[BASE].start, end: PERIOD[BASE].end, days: baseDays }, ga4Prev: { start: PERIOD[COMPARE].start, end: PERIOD[COMPARE].end, days: compareDays },
      gsc: { start: PERIOD[BASE].start, end: gscLast, days: gscBaseDays }, competitors: comp?.generated_at_utc || null, competitorsPrev: compPrev?.generated_at_utc || null }
  },
  text, summary, verify, koreaShare, formDaily, followups,
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
