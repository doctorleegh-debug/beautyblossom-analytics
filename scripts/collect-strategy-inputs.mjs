#!/usr/bin/env node
// 월간 전략 리포트용 보조 수집기 — collect-monthly.mjs 가 모으지 않는 것만 달력 월 단위로 받는다.
//   node scripts/collect-strategy-inputs.mjs --month=2026-10 --end=2026-09-28
// --month 는 리포트가 다루는 실행 월이고, 근거는 그 전월(base)과 전전월(compare)이다.
//
// 월간 데이터에는 사이트당 상위 10개 검색어만 있어 "병원 이름이 아닌 검색어"의 순위·노출을 볼 수 없고,
// GA4 는 나라별 접속과 어떤 행동이 문의로 집계됐는지(이벤트 이름)가 없다. 문의 이벤트 정의가 바뀌면
// 전환율이 실제 변화 없이 튀므로, 이벤트 이름별 수치를 함께 받아 두어야 비교가 성립한다.
// 실패·미제공 값은 0 으로 채우지 않고 null + errors 에 남긴다. 토큰 값은 출력하지 않는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEC = join(ROOT, '.secrets');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MONTH = arg('month');
const END = arg('end');
if (!/^\d{4}-\d{2}$/.test(MONTH || '') || !/^\d{4}-\d{2}-\d{2}$/.test(END || '')) {
  console.error('필수: --month=yyyy-mm --end=yyyy-mm-dd'); process.exit(1);
}
const OUT = arg('out', join(ROOT, 'data', `strategy-inputs-${MONTH}.json`));

const pad = (n) => String(n).padStart(2, '0');
const shift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const BASE = shift(MONTH, -1), COMPARE = shift(MONTH, -2);
const PERIODS = [
  { key: COMPARE, start: `${COMPARE}-01`, end: lastDay(COMPARE) },
  { key: BASE, start: `${BASE}-01`, end: END < lastDay(BASE) ? END : lastDay(BASE) },
];
if (!END.startsWith(BASE)) { console.error(`--end 는 근거 월(${BASE}) 안의 날짜여야 합니다`); process.exit(1); }
// Last month's report set its targets on a rolling window, not a calendar month. Checking those
// targets on the same definition needs that exact window, which differs per source because Search
// Console lags GA4 by two to three days. --baseline-ga4=yyyy-mm-dd:yyyy-mm-dd, --baseline-gsc=same.
const baseline = (k) => {
  const v = arg(k); if (!v) return [];
  const [start, end] = v.split(':');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) { console.error(`--${k}=yyyy-mm-dd:yyyy-mm-dd`); process.exit(1); }
  return [{ key: 'baseline', start, end }];
};
const GA4_PERIODS = [...baseline('baseline-ga4'), ...PERIODS];
const GSC_PERIODS = [...baseline('baseline-gsc'), ...PERIODS];

const readJson = (f) => JSON.parse(readFileSync(join(SEC, f), 'utf8').replace(/^﻿/, ''));
const client = readJson('google-oauth.local.json').web;
const errors = [];
const err = (src, msg) => { errors.push({ source: src, message: msg }); console.log(`   ! ${src}: ${msg}`); };

async function gtoken(file) {
  const t = readJson(file);
  const r = await fetch(client.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`토큰 갱신 실패 ${file}: ${j.error ?? r.status}`);
  return j.access_token;
}
async function getJson(url, init = {}, tries = 3) {
  for (let i = 1; ; i++) {
    const r = await fetch(url, init);
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const msg = `HTTP ${r.status} ${j.error?.code ?? ''} ${(j.error?.message || '').slice(0, 160)}`.trim();
    if (i < tries && (r.status >= 500 || r.status === 429)) { await new Promise((s) => setTimeout(s, 1500 * i)); continue; }
    throw new Error(msg);
  }
}

// ---------------- GA4: 나라별 접속 · 문의 이벤트 이름 ----------------
const GA4_PROPS = [
  { id: '526090588', label: 'KR' }, { id: '534100156', label: 'EN' }, { id: '534097409', label: 'JP' },
  { id: '534099303', label: 'CN' }, { id: '534131940', label: 'TW' }, { id: '537583229', label: 'TH' },
];
async function ga4() {
  console.log('-- GA4');
  const tok = await gtoken('google-oauth-token.local.json');
  const run = (id, body) => getJson(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`,
    { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = [];
  for (const p of GA4_PROPS) {
    const rec = { ...p, countries: {}, key_events: {}, key_events_by_country: {}, session_key_event_rate: {}, key_events_daily: null };
    for (const per of GA4_PERIODS) {
      const range = [{ startDate: per.start, endDate: per.end }];
      try {
        const c = await run(p.id, { dateRanges: range, dimensions: [{ name: 'country' }],
          metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }, { name: 'sessionKeyEventRate' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 250 });
        rec.countries[per.key] = (c.rows || []).map((r) => ({ country: r.dimensionValues[0].value,
          sessions: +r.metricValues[0].value, activeUsers: +r.metricValues[1].value, keyEvents: +r.metricValues[2].value,
          // Sessions with at least one inquiry - not inflated by one visitor clicking several times.
          inquirySessions: Math.round(+r.metricValues[3].value * +r.metricValues[0].value) }));
      } catch (e) { rec.countries[per.key] = null; err(`GA4 ${p.label} countries ${per.key}`, e.message); }
      try {
        const k = await run(p.id, { dateRanges: range, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'keyEvents' }],
          orderBys: [{ metric: { metricName: 'keyEvents' }, desc: true }], limit: 50 });
        rec.key_events[per.key] = (k.rows || []).map((r) => ({ event: r.dimensionValues[0].value, keyEvents: +r.metricValues[0].value }))
          .filter((r) => r.keyEvents > 0);
      } catch (e) { rec.key_events[per.key] = null; err(`GA4 ${p.label} key_events ${per.key}`, e.message); }
      // keyEvents counts every click, so one visitor tapping WhatsApp three times is three. The share of
      // sessions that had at least one key event is not inflated that way.
      try {
        const r = await run(p.id, { dateRanges: range, metrics: [{ name: 'sessionKeyEventRate' }, { name: 'sessions' }] });
        const v = r.rows?.[0]?.metricValues;
        rec.session_key_event_rate[per.key] = v ? { rate: +v[0].value, sessions: +v[1].value } : null;
      } catch (e) { rec.session_key_event_rate[per.key] = null; err(`GA4 ${p.label} session_key_event_rate ${per.key}`, e.message); }
      // Which country each kind of inquiry came from - a site in one language can collect inquiries
      // from sessions located elsewhere, including the clinic's own country.
      try {
        const r = await run(p.id, { dateRanges: range, dimensions: [{ name: 'country' }, { name: 'eventName' }],
          metrics: [{ name: 'keyEvents' }, { name: 'totalUsers' }], limit: 300 });
        rec.key_events_by_country[per.key] = (r.rows || []).filter((x) => +x.metricValues[0].value > 0)
          .map((x) => ({ country: x.dimensionValues[0].value, event: x.dimensionValues[1].value,
            keyEvents: +x.metricValues[0].value, users: +x.metricValues[1].value }));
      } catch (e) { rec.key_events_by_country[per.key] = null; err(`GA4 ${p.label} key_events_by_country ${per.key}`, e.message); }
    }
    // Daily series per inquiry type across both months, to date any step change in one type.
    try {
      const r = await run(p.id, { dateRanges: [{ startDate: PERIODS[0].start, endDate: PERIODS.at(-1).end }],
        dimensions: [{ name: 'date' }, { name: 'eventName' }], metrics: [{ name: 'keyEvents' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 5000 });
      rec.key_events_daily = (r.rows || []).filter((x) => +x.metricValues[0].value > 0)
        .map((x) => ({ date: x.dimensionValues[0].value, event: x.dimensionValues[1].value, keyEvents: +x.metricValues[0].value }));
    } catch (e) { err(`GA4 ${p.label} key_events_daily`, e.message); }
    const top = (rec.countries[BASE] || []).slice(0, 3).map((c) => `${c.country} ${c.sessions}`).join(', ');
    console.log(`   ${p.label.padEnd(3)} ${BASE} top: ${top}  events: ${(rec.key_events[BASE] || []).map((e) => e.event).join(',')}`);
    out.push(rec);
  }
  return out;
}

// ---------------- YouTube: 나라별 조회 ----------------
// Last month's report recommended adding foreign-language titles and captions; whether viewing
// abroad moved is only visible per country.
const YT = [
  { short: '블라썸1호', token: 'google-oauth-youtube-token.local.json' },
  { short: 'Doctor Lee', token: 'google-oauth-youtube-geonhoda-token.local.json' },
];
async function youtube() {
  console.log('-- YouTube');
  const out = [];
  for (const ch of YT) {
    const rec = { short: ch.short, countries: {} };
    try {
      const tok = await gtoken(ch.token);
      for (const per of PERIODS) {
        const r = await getJson(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${per.start}&endDate=${per.end}` +
          '&metrics=views,estimatedMinutesWatched&dimensions=country&sort=-views&maxResults=50', { headers: { Authorization: `Bearer ${tok}` } });
        rec.countries[per.key] = (r.rows || []).map(([country, views, minutes]) => ({ country, views, minutes }));
      }
      console.log(`   ${ch.short.padEnd(10)} ${PERIODS.map((p) => `${p.key} ${rec.countries[p.key].slice(0, 3).map((c) => c.country + ' ' + c.views).join(',')}`).join(' | ')}`);
    } catch (e) { rec.error = e.message; err(`YouTube ${ch.short}`, e.message); }
    out.push(rec);
  }
  return out;
}

// ---------------- Instagram: 게시물별 도달 ----------------
// Account totals say reach moved; only per-post figures say which posts moved it. Per-account tokens
// (graph.instagram.com) are read fresh from analytics/.secrets on every run and never written out.
const IG_LABELS = ['KR', 'EN', 'JP', 'TW', 'TH'];
async function instagramPosts() {
  console.log('-- Instagram posts');
  const out = [];
  const base = PERIODS.at(-1);
  const since = Date.parse(`${base.start}T00:00:00+09:00`), until = Date.parse(`${base.end}T23:59:59+09:00`);
  for (const label of IG_LABELS) {
    const rec = { label, username: null, period: base.key, posts: [] };
    try {
      const t = readJson(`instagram-token-${label}.local.json`);
      const call = (path, params) => {
        const u = new URL(`https://graph.instagram.com/v23.0/${path}`);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        u.searchParams.set('access_token', t.access_token);
        return getJson(u);
      };
      const me = await call('me', { fields: 'user_id,username' });
      if (me.username !== t.username) throw new Error('username mismatch');
      rec.username = me.username;
      let page = await call(`${me.user_id}/media`, { fields: 'id,caption,media_product_type,permalink,timestamp,like_count,comments_count', limit: 100 });
      const media = [];
      for (let i = 0; i < 5 && page; i++) {
        media.push(...(page.data || []));
        const oldest = page.data?.at(-1) && Date.parse(page.data.at(-1).timestamp);
        if (!page.paging?.cursors?.after || !page.paging?.next || (oldest && oldest < since)) break;
        page = await call(`${me.user_id}/media`, { fields: 'id,caption,media_product_type,permalink,timestamp,like_count,comments_count', limit: 100, after: page.paging.cursors.after });
      }
      for (const m of media.filter((x) => { const ts = Date.parse(x.timestamp); return ts >= since && ts <= until; })) {
        const p = { id: m.id, type: m.media_product_type, permalink: m.permalink, timestamp: m.timestamp,
          caption: (m.caption || '').slice(0, 80), likes: m.like_count ?? null, comments: m.comments_count ?? null };
        try {
          const ins = await call(`${m.id}/insights`, { metric: 'reach,views,saved,shares,total_interactions' });
          for (const x of ins.data || []) p[x.name] = x.values?.[0]?.value ?? null;
        } catch (e) { p.insights_error = e.message; }
        rec.posts.push(p);
      }
      rec.posts.sort((a, b) => (b.reach ?? -1) - (a.reach ?? -1));
      console.log(`   ${label} ${rec.username} posts ${rec.posts.length}  top reach ${rec.posts.slice(0, 3).map((p) => p.reach).join(',')}`);
    } catch (e) { rec.error = e.message; err(`Instagram ${label}`, e.message); }
    out.push(rec);
  }
  return out;
}

// ---------------- 사이트맵: 시술명 주소 ----------------
// The site blocks automated page reads, but its sitemaps are public. Whether a treatment has a page
// under its own name - last month's recommendation - is visible from the URL list alone.
const SITEMAPS = ['beautyblossom.kr', 'en.beautyblossom.kr', 'jp.beautyblossom.kr', 'cn.beautyblossom.kr', 'tw.beautyblossom.kr'];
async function sitemaps() {
  console.log('-- Sitemaps');
  const out = [];
  for (const host of SITEMAPS) {
    const rec = { host, fetched_at_utc: new Date().toISOString(), urls: null };
    try {
      const r = await fetch(`https://${host}/sitemap.xml`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      rec.urls = [...(await r.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
      // A path that is only digits (/16, /17) carries no treatment name.
      rec.named = rec.urls.filter((u) => !/\/\d+\/?$/.test(new URL(u).pathname) && new URL(u).pathname !== '/');
      console.log(`   ${host.padEnd(22)} urls ${rec.urls.length}  named ${rec.named.length}`);
    } catch (e) { err(`sitemap ${host}`, e.message); }
    out.push(rec);
  }
  return out;
}

// ---------------- Search Console: 검색어·페이지 전체 ----------------
// 상위 25개만 받으면 노출이 적은 검색어는 애초에 보이지 않아 "0"과 구분되지 않는다.
const GSC_SITES = [
  { url: 'https://beautyblossom.kr/', label: 'KR', group: 'home' },
  { url: 'https://en.beautyblossom.kr/', label: 'EN', group: 'home' },
  { url: 'https://jp.beautyblossom.kr/', label: 'JP', group: 'home' },
  { url: 'https://cn.beautyblossom.kr/', label: 'CN', group: 'home' },
  { url: 'https://tw.beautyblossom.kr/', label: 'TW', group: 'home' },
  { url: 'https://hk.beautyblossom.kr/', label: 'HK', group: 'home' },
  { url: 'sc-domain:beautyblossomth.kr', label: 'TH', group: 'home' },
];
const QUERY_ROWS = 25000, PAGE_ROWS = 25000; // API 한 번에 받을 수 있는 최대치
async function gsc() {
  console.log('-- Search Console');
  const tok = await gtoken('google-oauth-gsc-token.local.json');
  const q = (site, body) => getJson(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = [];
  for (const s of GSC_SITES) {
    const rec = { ...s, queries: {}, pages: {}, row_limit: { query: QUERY_ROWS, page: PAGE_ROWS } };
    for (const per of GSC_PERIODS) {
      try {
        const r = await q(s.url, { startDate: per.start, endDate: per.end, dimensions: ['query'], rowLimit: QUERY_ROWS });
        rec.queries[per.key] = (r.rows || []).map((x) => ({ query: x.keys[0], clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position }));
      } catch (e) { rec.queries[per.key] = null; err(`GSC ${s.label} queries ${per.key}`, e.message); }
      try {
        const r = await q(s.url, { startDate: per.start, endDate: per.end, dimensions: ['page'], rowLimit: PAGE_ROWS });
        rec.pages[per.key] = (r.rows || []).map((x) => ({ page: x.keys[0], clicks: x.clicks, impressions: x.impressions, position: x.position }));
      } catch (e) { rec.pages[per.key] = null; err(`GSC ${s.label} pages ${per.key}`, e.message); }
    }
    console.log(`   ${s.label.padEnd(3)} queries ${PERIODS.map((p) => rec.queries[p.key]?.length ?? 'ERR').join(' / ')}  pages ${PERIODS.map((p) => rec.pages[p.key]?.length ?? 'ERR').join(' / ')}`);
    out.push(rec);
  }
  return out;
}

const result = {
  generated_at_utc: new Date().toISOString(),
  month: MONTH, base: BASE, compare: COMPARE,
  periods: PERIODS,
  baseline: { ga4: GA4_PERIODS.find((p) => p.key === 'baseline') || null, gsc: GSC_PERIODS.find((p) => p.key === 'baseline') || null },
  note: '근거 월의 마지막 날은 --end 입니다. Search Console 은 집계가 2~3일 늦어 실제로 받은 마지막 날이 --end 보다 이를 수 있습니다.',
  sources: {},
};
result.sources.ga4 = await ga4();
result.sources.searchconsole = await gsc();
result.sources.youtube = await youtube();
result.sources.sitemaps = await sitemaps();
result.sources.instagram_posts = await instagramPosts();
result.errors = errors;
writeFileSync(OUT, JSON.stringify(result, null, 1), 'utf8');
console.log(`\nSAVED ${OUT}  errors=${errors.length}`);
