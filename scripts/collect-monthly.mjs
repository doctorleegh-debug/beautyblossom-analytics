#!/usr/bin/env node
// 월간 성과보고서용 수집기 — 달력 월 단위 고정 기간을 소스별로 모은다.
//   node scripts/collect-monthly.mjs --months=2026-07,2026-08,2026-09 --end=2026-09-28
// 마지막 달은 --end 까지. YouTube·Search Console 처럼 집계가 늦은 소스는 실제로 받은 마지막 날까지만 쓰고
// 그 날짜를 기록한다. 실패·미제공 값은 0 으로 채우지 않고 null + errors 에 남긴다. 토큰 값은 출력하지 않는다.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEC = join(ROOT, '.secrets');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const MONTHS = arg('months', '2026-07,2026-08,2026-09').split(',');
const END = arg('end');
const OUT = arg('out', join(ROOT, 'data', `monthly-${END}.json`));
if (!END) { console.error('필수: --end=yyyy-mm-dd'); process.exit(1); }

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const PERIODS = MONTHS.map((ym, i) => ({ key: ym, start: `${ym}-01`, end: i === MONTHS.length - 1 && END < lastDay(ym) ? END : lastDay(ym) }));
const START = PERIODS[0].start;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const kstTs = (d, endOfDay = false) => Math.floor(Date.parse(`${d}T${endOfDay ? '23:59:59' : '00:00:00'}+09:00`) / 1000);

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
    throw new Error(msg.replace(/access_token=[^&\s]+/g, 'access_token=***'));
  }
}
const inPeriod = (d) => PERIODS.find((p) => d >= p.start && d <= p.end)?.key;

// ---------------- GA4 ----------------
const GA4_PROPS = [
  { id: '526090588', label: 'KR' }, { id: '534100156', label: 'EN' }, { id: '534097409', label: 'JP' },
  { id: '534099303', label: 'CN' }, { id: '534131940', label: 'TW' }, { id: '537583229', label: 'TH' },
];
const GA4_METRICS = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'keyEvents', 'averageSessionDuration', 'bounceRate', 'engagementRate'];
async function ga4() {
  console.log('-- GA4');
  const tok = await gtoken('google-oauth-token.local.json');
  const run = (id, body) => getJson(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ranges = PERIODS.map((p) => ({ startDate: p.start, endDate: p.end, name: p.key }));
  const out = [];
  for (const p of GA4_PROPS) {
    const rec = { label: p.label, id: p.id, months: {}, channels: {}, daily: [], key_events_from: null };
    try {
      const tot = await run(p.id, { dateRanges: ranges, metrics: GA4_METRICS.map((name) => ({ name })) });
      for (const row of tot.rows || []) {
        const k = row.dimensionValues[0].value;
        rec.months[k] = Object.fromEntries(GA4_METRICS.map((m, i) => [m, Number(row.metricValues[i].value)]));
      }
      const ch = await run(p.id, { dateRanges: ranges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }, { name: 'keyEvents' }], limit: 200 });
      for (const row of ch.rows || []) {
        const [name, k] = [row.dimensionValues[0].value, row.dimensionValues[1].value];
        (rec.channels[k] ??= {})[name] = { sessions: Number(row.metricValues[0].value), keyEvents: Number(row.metricValues[1].value) };
      }
      const dy = await run(p.id, { dateRanges: [{ startDate: START, endDate: END }], dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 });
      rec.daily = (dy.rows || []).map((r) => { const d = r.dimensionValues[0].value; return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, sessions: +r.metricValues[0].value, activeUsers: +r.metricValues[1].value, keyEvents: +r.metricValues[2].value }; });
      rec.key_events_from = rec.daily.find((d) => d.keyEvents > 0)?.date ?? null;
      rec.last_date = rec.daily.at(-1)?.date ?? null;
      console.log(`   ${p.label} ok  sessions ${PERIODS.map((q) => rec.months[q.key]?.sessions ?? '-').join(' / ')}  keyEvents_from=${rec.key_events_from}`);
    } catch (e) { rec.error = e.message; err(`GA4 ${p.label}`, e.message); }
    out.push(rec);
  }
  return out;
}

// ---------------- Search Console ----------------
const GSC_SITES = [
  { url: 'https://beautyblossom.kr/', label: 'KR', group: 'home' }, { url: 'https://en.beautyblossom.kr/', label: 'EN', group: 'home' },
  { url: 'https://jp.beautyblossom.kr/', label: 'JP', group: 'home' }, { url: 'https://cn.beautyblossom.kr/', label: 'CN', group: 'home' },
  { url: 'https://tw.beautyblossom.kr/', label: 'TW', group: 'home' }, { url: 'https://hk.beautyblossom.kr/', label: 'HK', group: 'home' },
  { url: 'sc-domain:beautyblossomth.kr', label: 'TH', group: 'home', note: '도메인 전체(웹블로그 EN·TH 포함)' },
  { url: 'https://beautyblossomth.kr/blog/en/', label: '웹블로그 EN', group: 'blog', note: 'TH 도메인의 하위 경로' },
  { url: 'https://beautyblossomth.kr/blog/th/', label: '웹블로그 TH', group: 'blog', note: 'TH 도메인의 하위 경로' },
  { url: 'https://hongdaebeautyblossom.blogspot.com/', label: '블로그스팟 EN', group: 'blog' },
  { url: 'https://ameblo.jp/beautyblossom-clinic/', label: '아메바 JP', group: 'blog' },
  { url: 'https://note.com/beautyblossom/', label: 'note JP', group: 'blog' },
];
async function gsc() {
  console.log('-- Search Console');
  const tok = await gtoken('google-oauth-gsc-token.local.json');
  const q = (site, body) => getJson(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = [];
  for (const s of GSC_SITES) {
    const rec = { ...s, months: {}, top_queries: [], last_date: null };
    try {
      const dt = await q(s.url, { startDate: START, endDate: END, dimensions: ['date'], rowLimit: 400 });
      const rows = (dt.rows || []).map((r) => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions }));
      rec.last_date = rows.map((r) => r.date).sort().at(-1) ?? null;
      for (const p of PERIODS) {
        const t = await q(s.url, { startDate: p.start, endDate: p.end });
        const r = t.rows?.[0];
        rec.months[p.key] = r ? { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position } : { clicks: 0, impressions: 0, ctr: null, position: null, empty: true };
      }
      if (s.group === 'home') {
        const last = PERIODS.at(-1);
        const tq = await q(s.url, { startDate: last.start, endDate: last.end, dimensions: ['query'], rowLimit: 10 });
        rec.top_queries = (tq.rows || []).map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
      }
      console.log(`   ${s.label.padEnd(12)} clicks ${PERIODS.map((p) => rec.months[p.key].clicks).join(' / ')}  last=${rec.last_date}`);
    } catch (e) { rec.error = e.message; err(`GSC ${s.label}`, e.message); }
    out.push(rec);
  }
  return out;
}

// ---------------- YouTube ----------------
const YT = [
  { name: '블라썸1호 | K-Beauty No.1, Beauty Blossom', short: '블라썸1호', token: 'google-oauth-youtube-token.local.json' },
  { name: 'K-Beauty Doctor Lee', short: 'Doctor Lee', token: 'google-oauth-youtube-geonhoda-token.local.json' },
];
async function youtube() {
  console.log('-- YouTube');
  const out = [];
  for (const ch of YT) {
    const rec = { name: ch.name, short: ch.short, months: {}, daily: [], last_date: null, first_date: null };
    try {
      const tok = await gtoken(ch.token);
      const r = await getJson(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE&startDate=${START}&endDate=${END}&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost&dimensions=day&sort=day`, { headers: { Authorization: `Bearer ${tok}` } });
      const rows = r.rows || [];
      while (rows.length && rows.at(-1)[1] === 0 && rows.at(-1)[2] === 0) rows.pop(); // 미처리 날짜
      rec.daily = rows.map(([date, views, mins, avd, gain, lost]) => ({ date, views, mins, avd, gain, lost }));
      rec.last_date = rows.at(-1)?.[0] ?? null;
      rec.first_date = rec.daily.find((d) => d.views > 0)?.date ?? null;
      for (const p of PERIODS) {
        const d = rec.daily.filter((x) => x.date >= p.start && x.date <= p.end);
        const views = d.reduce((a, x) => a + x.views, 0);
        rec.months[p.key] = { days: d.length, views, mins: d.reduce((a, x) => a + x.mins, 0), gain: d.reduce((a, x) => a + x.gain, 0), lost: d.reduce((a, x) => a + x.lost, 0),
          avd: views ? Math.round(d.reduce((a, x) => a + x.avd * x.views, 0) / views) : null };
      }
      const st = await getJson('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: { Authorization: `Bearer ${tok}` } });
      rec.subscribers = Number(st.items?.[0]?.statistics?.subscriberCount ?? NaN) || null;
      console.log(`   ${ch.short.padEnd(10)} views ${PERIODS.map((p) => rec.months[p.key].views).join(' / ')}  last=${rec.last_date}  first=${rec.first_date}`);
    } catch (e) { rec.error = e.message; err(`YouTube ${ch.short}`, e.message); }
    out.push(rec);
  }
  return out;
}

// ---------------- Instagram (국가별 토큰, graph.instagram.com) ----------------
const COUNTRIES = ['KR', 'EN', 'JP', 'TW', 'TH'];
const IG_METRICS = ['reach', 'views', 'profile_views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares', 'profile_links_taps'];
async function instagram() {
  console.log('-- Instagram (국가별 토큰)');
  const out = [];
  for (const L of COUNTRIES) {
    const rec = { label: L, months: {}, posts: {}, errors: [] };
    try {
      const t = readJson(`instagram-token-${L}.local.json`); const tk = t.access_token;
      const base = 'https://graph.instagram.com/v23.0';
      const me = await getJson(`${base}/me?fields=user_id,username,followers_count,media_count&access_token=${tk}`);
      Object.assign(rec, { username: me.username, followers: me.followers_count, media_count: me.media_count });
      for (const p of PERIODS) {
        const m = {};
        for (const name of IG_METRICS) {
          try {
            const r = await getJson(`${base}/me/insights?metric=${name}&period=day&metric_type=total_value&since=${kstTs(p.start)}&until=${kstTs(p.end, true) + 1}&access_token=${tk}`);
            m[name] = r.data?.[0]?.total_value?.value ?? null;
          } catch (e) { m[name] = null; rec.errors.push(`${p.key} ${name}: ${e.message.slice(0, 90)}`); }
        }
        try {
          const r = await getJson(`${base}/me/insights?metric=follows_and_unfollows&period=day&metric_type=total_value&breakdown=follow_type&since=${kstTs(p.start)}&until=${kstTs(p.end, true) + 1}&access_token=${tk}`);
          const res = r.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
          const v = (k) => res.find((x) => x.dimension_values?.[0] === k)?.value ?? 0;
          m.follows = v('FOLLOWER'); m.unfollows = v('NON_FOLLOWER');
        } catch (e) { m.follows = m.unfollows = null; rec.errors.push(`${p.key} follows_and_unfollows: ${e.message.slice(0, 90)}`); }
        rec.months[p.key] = m;
      }
      // 월별 게시물 수
      let url = `${base}/me/media?fields=id,timestamp,media_product_type&limit=100&access_token=${tk}`; const counts = {}; let guard = 0;
      while (url && guard++ < 20) {
        const r = await getJson(url);
        for (const x of r.data || []) { const d = new Date(Date.parse(x.timestamp) + 9 * 3600e3).toISOString().slice(0, 10); const k = inPeriod(d); if (k) { counts[k] ??= { total: 0 }; counts[k].total++; counts[k][x.media_product_type] = (counts[k][x.media_product_type] || 0) + 1; } }
        const oldest = r.data?.at(-1)?.timestamp; url = oldest && oldest.slice(0, 10) >= START ? r.paging?.next : null;
      }
      rec.posts = counts;
      console.log(`   ${L} @${rec.username}  reach ${PERIODS.map((p) => rec.months[p.key].reach).join(' / ')}  posts ${PERIODS.map((p) => counts[p.key]?.total ?? 0).join('/')}  err=${rec.errors.length}`);
    } catch (e) { rec.error = e.message; err(`Instagram ${L}`, e.message); }
    if (rec.errors.length) errors.push({ source: `Instagram ${L}`, message: `${rec.errors.length}개 지표 조회 실패`, detail: rec.errors });
    out.push(rec);
  }
  return out;
}

// ---------------- Threads (국가별 토큰, graph.threads.net) ----------------
async function threads() {
  console.log('-- Threads (국가별 토큰)');
  const out = [];
  for (const L of COUNTRIES) {
    const rec = { label: L, months: {}, posts: {} };
    try {
      const tk = readJson(`threads-token-${L}.local.json`).access_token;
      const base = 'https://graph.threads.net/v1.0';
      const me = await getJson(`${base}/me?fields=id,username&access_token=${tk}`);
      rec.username = me.username;
      const f = await getJson(`${base}/${me.id}/threads_insights?metric=followers_count&access_token=${tk}`);
      rec.followers = f.data?.[0]?.total_value?.value ?? null;
      for (const p of PERIODS) {
        const r = await getJson(`${base}/${me.id}/threads_insights?metric=views,likes,replies,reposts,quotes&since=${kstTs(p.start)}&until=${kstTs(p.end, true)}&access_token=${tk}`);
        const v = (n) => { const m = r.data?.find((x) => x.name === n); if (!m) return null; return m.total_value?.value ?? (m.values || []).reduce((a, x) => a + (x.value || 0), 0); };
        rec.months[p.key] = { views: v('views'), likes: v('likes'), replies: v('replies'), reposts: v('reposts'), quotes: v('quotes') };
        // /threads 에는 다른 계정 글을 리포스트한 REPOST_FACADE 가 섞여 온다. 원글과 리포스트를 나눠 센다.
        // until 은 경계가 모호하고 미래 시각은 거부되므로 — 마지막 날 다음 00:00 KST 와 현재 시각 중 이른 쪽. 날짜는 KST 기준으로 다시 거른다.
        const untilTs = Math.min(kstTs(p.end, true) + 1, Math.floor(Date.now() / 1000) - 60);
        let url = `${base}/${me.id}/threads?fields=id,timestamp,media_type&since=${kstTs(p.start)}&until=${untilTs}&limit=100&access_token=${tk}`; let guard = 0;
        const seen = new Set(); const cnt = { original: 0, reposts: 0 };
        while (url && guard++ < 30) {
          const x = await getJson(url);
          for (const y of x.data || []) {
            if (seen.has(y.id)) continue; seen.add(y.id);
            const d = new Date(Date.parse(y.timestamp) + 9 * 3600e3).toISOString().slice(0, 10);
            if (d < p.start || d > p.end) continue;
            if (y.media_type === 'REPOST_FACADE') cnt.reposts++; else cnt.original++;
          }
          url = x.paging?.next || null;
        }
        rec.posts[p.key] = cnt;
      }
      console.log(`   ${L} @${rec.username}  views ${PERIODS.map((p) => rec.months[p.key].views).join(' / ')}  원글 ${PERIODS.map((p) => rec.posts[p.key].original).join('/')}  리포스트 ${PERIODS.map((p) => rec.posts[p.key].reposts).join('/')}  followers=${rec.followers}`);
    } catch (e) { rec.error = e.message; err(`Threads ${L}`, e.message); }
    out.push(rec);
  }
  return out;
}

const result = {
  generated_at_utc: new Date().toISOString(),
  requested: { months: MONTHS, end: END },
  periods: PERIODS.map((p) => ({ ...p, days: days(p.start, p.end) })),
  sources: {},
};
result.sources.ga4 = await ga4();
result.sources.searchconsole = await gsc();
result.sources.youtube = await youtube();
result.sources.instagram = await instagram();
result.sources.threads = await threads();
result.errors = errors;
writeFileSync(OUT, JSON.stringify(result, null, 1), 'utf8');
console.log(`\nSAVED ${OUT}  errors=${errors.length}`);
