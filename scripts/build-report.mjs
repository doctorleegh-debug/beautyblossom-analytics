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
      status: 'pending',
      reason: 'Meta Graph API access is not granted yet: the app is registered in a different business portfolio than the one that owns these accounts.',
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
