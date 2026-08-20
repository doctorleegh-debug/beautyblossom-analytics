// Long-lived Chrome that holds the Naver session, driven over CDP.
//
// Naver issues NID_AUT / NID_SES as session cookies, so they live in the browser
// process's memory and never reach disk - a fresh headless Chrome always starts
// logged out. Instead of fighting that, this keeps one Chrome alive: sign in once,
// the window is then parked off-screen, and every later scrape attaches over CDP. No window
// on screen, no focus stolen, no mouse used.
//
// Usage:
//   node scripts/naver-session.mjs start    한 번 로그인 (창 뜸 → 로그인 후 화면 밖으로 이동)
//   node scripts/naver-session.mjs status   로그인 상태 확인 (창 안 뜸)
//   node scripts/naver-session.mjs stop     세션 종료
//
// Cookie values are never read or printed - only name, persistence and expiry.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { waitForPort, httpJson, firstPage, Session } from './cdp.mjs';

const PROFILE = process.env.BB_NAVER_PROFILE || 'C:\\Users\\metic\\.bb-chrome-naver';
const CHROME  = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const PORT = 9335;
const PIDFILE = 'C:\\Users\\metic\\.bb-chrome-naver-session.json';
const CONSOLE_URL = 'https://searchadvisor.naver.com/console/board';
const LOGIN_RE = String.raw`/아이디 또는 전화번호|네이버 로그인/`;

export const isLoggedIn = (sess) => sess.evaluate(
  `!${LOGIN_RE}.test(document.body.innerText||'') && !/nid\\.naver\\.com/.test(location.href)`);

export async function alive() {
  try { await httpJson(PORT, '/json/version'); return true; } catch { return false; }
}

// Attach to the already-running session browser. This is what the collector calls.
export async function attach() {
  if (!(await alive())) {
    throw new Error(`네이버 세션 브라우저가 떠 있지 않습니다. 먼저 실행하세요: node scripts/naver-session.mjs start`);
  }
  const page = await firstPage(PORT);
  return Session.attach(page.webSocketDebuggerUrl);
}

async function cookieReport(sess) {
  const { cookies } = await sess.send('Network.getAllCookies');
  const out = [];
  for (const n of ['NID_AUT', 'NID_SES']) {
    const c = cookies.find(x => x.name === n && /naver\.com$/.test(x.domain.replace(/^\./, '')));
    out.push(c
      ? `  ${n.padEnd(9)} ${c.session ? '세션쿠키 (메모리 상주 - 이 크롬을 닫으면 사라집니다)' : '영구 · 만료 ' + new Date(c.expires * 1000).toISOString().slice(0, 16)}`
      : `  ${n.padEnd(9)} 없음`);
  }
  return out.join('\n');
}

// Keep the browser running but off the user's screen.
//
// Minimising is not enough: a minimised window reports visibilityState 'hidden',
// and the Search Advisor SPA then never fetches its data. Parking the window at
// far-negative coordinates keeps it 'visible' to the page while staying off every
// monitor, and focus emulation stops Chrome throttling the renderer.
export async function hide(sess) {
  try {
    const { windowId } = await sess.send('Browser.getWindowForTarget');
    await sess.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await sess.send('Browser.setWindowBounds', {
      windowId, bounds: { left: -32000, top: -32000, width: 1500, height: 2400 }
    });
    await sess.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    try { await sess.send('Page.setWebLifecycleState', { state: 'active' }); } catch {}
    return true;
  } catch { return false; }
}

// Importing this module must not run the CLI - the collector imports attach().
const { pathToFileURL } = await import('node:url');
if (import.meta.url !== pathToFileURL(process.argv[1] || '').href) {
  // imported as a library
} else {
await (async () => {

const cmd = process.argv[2] || 'status';

if (cmd === 'stop') {
  if (existsSync(PIDFILE)) {
    const { pid } = JSON.parse(readFileSync(PIDFILE, 'utf8'));
    try { process.kill(pid); console.log('STOPPED pid=' + pid); } catch { console.log('이미 종료됨'); }
    unlinkSync(PIDFILE);
  } else console.log('실행 중인 세션 없음');
  process.exit(0);
}

if (cmd === 'status') {
  if (!(await alive())) { console.log('RESULT = NOT_RUNNING  세션 브라우저가 떠 있지 않습니다.'); process.exit(2); }
  const sess = await attach();
  await sess.send('Network.enable');
  await sess.goto(CONSOLE_URL, { settleMs: 2000 });
  const ok = await isLoggedIn(sess);
  console.log('LOGGED_IN =', ok);
  console.log(await cookieReport(sess));
  await hide(sess);
  sess.close();
  console.log(ok ? 'RESULT = READY' : 'RESULT = LOGIN_REQUIRED');
  process.exit(ok ? 0 : 2);
}

if (cmd !== 'start') { console.log('usage: start | status | stop'); process.exit(1); }

// start
if (await alive()) {
  const sess = await attach();
  await sess.goto(CONSOLE_URL, { settleMs: 2000 });
  if (await isLoggedIn(sess)) {
    console.log('이미 로그인된 세션이 살아 있습니다.');
    console.log(await cookieReport(sess));
    await hide(sess);
    sess.close();
    process.exit(0);
  }
  sess.close();
  console.log('세션 브라우저는 떠 있지만 로그아웃 상태입니다. 창에서 로그인해 주세요.');
}

let child = null;
if (!(await alive())) {
  child = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1180,920',
    CONSOLE_URL
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  writeFileSync(PIDFILE, JSON.stringify({ pid: child.pid, port: PORT }), 'utf8');
  await waitForPort(PORT, 40000);
}

const sess = await attach();
await sess.send('Network.enable');
await sess.goto(CONSOLE_URL, { settleMs: 2500 });

if (!(await isLoggedIn(sess))) {
  console.log('');
  console.log('크롬 창에서 네이버 로그인해 주세요.');
  console.log('  · [IP보안] OFF 로 두세요 (IP 바뀌면 세션이 끊깁니다)');
  console.log('  · [로그인 상태 유지]는 켜면 좋지만, 안 켜도 이 방식은 동작합니다');
  console.log('');
  console.log('로그인 완료를 최대 12분 기다립니다...');
  const until = Date.now() + 12 * 60000;
  let ok = false;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 4000));
    try { if (await isLoggedIn(sess)) { ok = true; break; } } catch {}
  }
  if (!ok) { console.log('RESULT = TIMEOUT'); sess.close(); process.exit(1); }
}

await new Promise(r => setTimeout(r, 2000));
console.log('');
console.log('네이버 인증 쿠키:');
console.log(await cookieReport(sess));
const min = await hide(sess);
sess.close();
console.log('');
console.log('RESULT = READY  세션이 살아 있습니다' + (min ? ' (창은 화면 밖으로 옮겼습니다).' : '.'));
console.log('이 크롬은 켜둔 채로 두세요. 닫으면 다시 로그인해야 합니다.');
console.log('앞으로 수집은 이 세션에 붙어서 창 없이 진행합니다.');
process.exit(0);

})();
}
