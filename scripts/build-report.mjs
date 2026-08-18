// Builds a self-contained HTML dashboard from the collected JSON payloads.
// Data is embedded inline so the page works from file:// and GitHub Pages alike.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = 'C:/Users/metic/Desktop/paseo/project(1)';
const DATA = join(ROOT, 'data');
const OUT  = join(ROOT, 'report', 'index.html');

// PowerShell writes UTF-8 with a BOM; JSON.parse chokes on it.
const read = (f) => {
  const p = join(DATA, f);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
};

const ga4   = read('ga4-latest.json');
const yt    = read('youtube-latest.json');
const ig    = read('instagram-public.json');
const naver = read('naver-latest.json');
const gsc   = read('searchconsole-latest.json');

if (!ga4 || !yt) { console.error('missing ga4 or youtube payload'); process.exit(1); }

const payload = {
  ga4, yt, ig, naver, gsc,
  meta: {
    builtAt: new Date().toISOString(),
    naver: {
      status: naver ? 'partial' : 'pending',
      reason: 'Naver publishes no performance API; figures are read from the logged-in Search Advisor console.'
    },
    instagram: {
      status: 'blocked',
      reason: '계정 5개와 파트너 자산 공유(인사이트 권한)는 설정이 끝났지만, Meta 앱이 신원 확인 대기로 비활성화되어 Graph API 호출이 차단된 상태입니다. 앱이 재활성화되면 추가 설정 없이 바로 수집됩니다.',
      accounts: ['beautyblossom_clinic', 'beautyblossom_jp', 'beautyblossom_tw', 'beautyblossom_th', 'beautyblossom_global']
    },
    threads: {
      status: 'pending',
      reason: 'Threads 프로필 5개가 포트폴리오에 있고 Instagram과 동일한 접근 권한을 갖지만, 수집에는 앱에 Threads API 제품 추가가 필요합니다. 다음 기간에 진행합니다.',
      accounts: ['beautyblossom_clinic', 'beautyblossom_jp', 'beautyblossom_tw', 'beautyblossom_th', 'beautyblossom_global']
    }
  }
};

const tpl = readFileSync(join(ROOT, 'scripts', 'report-template.html'), 'utf8');
const html = tpl.replace('/*__PAYLOAD__*/null', JSON.stringify(payload));
if (html === tpl) { console.error('payload placeholder not found'); process.exit(1); }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log('WROTE', OUT, (html.length / 1024).toFixed(1) + ' KB');
