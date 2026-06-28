#!/usr/bin/env node
// 레시피 썸네일 카드(PNG) 생성기 — 헤드리스 Chrome 스크린샷 방식
// 한글·이모지 완벽 렌더링. 외부 네트워크/유료 API 불필요.
//
// 사용법:
//   node gen-thumbnail.mjs --title "오징어 볶음밥" --emoji "🦑" \
//     --time "15분" --difficulty "보통" --servings "1인분" \
//     --subtitle "쫄깃한 오징어와 채소를 센 불에 볶은 한 그릇" \
//     --out "week-5/my-recipe/썸네일/squid-fried-rice.png"
//
// 필수: --title, --out
// 선택: --emoji(기본 🍽️) --time --difficulty --servings --subtitle --size(기본 1200x630)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---- 인자 파싱 ----------------------------------------------------------
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1] ?? ''; i++; }
}

const title = (args.title || '').trim();
const out = (args.out || '').trim();
if (!title || !out) {
  console.error('필수 인자 누락: --title 과 --out 은 반드시 필요합니다.');
  process.exit(1);
}
const emoji = (args.emoji || '🍽️').trim();
const time = (args.time || '').trim();
const difficulty = (args.difficulty || '').trim();
const servings = (args.servings || '').trim();
const subtitle = (args.subtitle || '').trim();
const [W, H] = (args.size || '1200x630').split('x').map(n => parseInt(n, 10));

// ---- 팔레트: 제목 해시로 일관되게 선택(같은 요리=같은 색) ----------------
const PALETTES = [
  { g1: '#FFE7BA', g2: '#FFCC80', g3: '#FF9E5E', accent: '#E8590C', title: '#4A2C12' }, // amber
  { g1: '#DDF3D8', g2: '#A8E6A1', g3: '#6FCF74', accent: '#2F9E44', title: '#1B4332' }, // green
  { g1: '#FFD9D2', g2: '#FFA99A', g3: '#FF6F61', accent: '#C92A2A', title: '#5A1A14' }, // tomato
  { g1: '#D6ECFF', g2: '#A5CDF5', g3: '#6FA8E6', accent: '#1971C2', title: '#14365A' }, // blue
  { g1: '#F3D9F0', g2: '#DDA8E6', g3: '#B86FCF', accent: '#9C36B5', title: '#4A1B52' }, // berry
  { g1: '#D2F5EE', g2: '#99E6D6', g3: '#5FCFB8', accent: '#099268', title: '#14463A' }, // teal
];
let hash = 0;
for (const ch of title) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
const p = PALETTES[hash % PALETTES.length];

// ---- 제목 길이에 따른 폰트 크기 ----------------------------------------
const tlen = [...title].length;
const titleSize = tlen <= 7 ? 76 : tlen <= 10 ? 64 : tlen <= 14 ? 52 : 44;

// ---- HTML 조립 ----------------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const badges = [
  time && `⏱️ ${time}`,
  difficulty && `🔥 ${difficulty}`,
  servings && `🍽️ ${servings}`,
].filter(Boolean).map(t => `<div class="badge">${esc(t)}</div>`).join('');

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:${W}px;height:${H}px;overflow:hidden;}
body{font-family:"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif;
  background:linear-gradient(135deg,${p.g1} 0%,${p.g2} 50%,${p.g3} 100%);
  display:flex;align-items:center;justify-content:center;position:relative;}
.blob{position:absolute;border-radius:50%;opacity:.35;}
.blob.a{width:340px;height:340px;background:rgba(255,255,255,.45);top:-130px;right:-90px;}
.blob.b{width:260px;height:260px;background:rgba(255,255,255,.22);bottom:-110px;left:-70px;}
.brand{position:absolute;top:44px;left:48px;background:${p.accent};color:#fff;
  font-weight:800;font-size:24px;letter-spacing:.5px;padding:12px 22px;border-radius:999px;
  box-shadow:0 8px 20px rgba(0,0,0,.15);}
.card{display:flex;flex-direction:column;align-items:center;gap:26px;z-index:2;padding:0 60px;text-align:center;}
.plate{width:300px;height:300px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;
  box-shadow:0 30px 60px rgba(0,0,0,.20),inset 0 0 0 10px rgba(0,0,0,.03);}
.emoji{font-size:172px;line-height:1;}
.title{font-size:${titleSize}px;font-weight:900;color:${p.title};letter-spacing:-1px;text-shadow:0 2px 0 rgba(255,255,255,.3);}
.subtitle{font-size:27px;color:${p.title};opacity:.72;max-width:900px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.badges{display:flex;gap:16px;margin-top:6px;}
.badge{background:rgba(255,255,255,.92);color:${p.title};font-size:27px;font-weight:700;
  padding:14px 26px;border-radius:999px;box-shadow:0 8px 18px rgba(0,0,0,.12);}
</style></head><body>
<div class="blob a"></div><div class="blob b"></div>
<div class="brand">🍳 MY RECIPE</div>
<div class="card">
  <div class="plate"><div class="emoji">${esc(emoji)}</div></div>
  <div class="title">${esc(title)}</div>
  ${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ''}
  ${badges ? `<div class="badges">${badges}</div>` : ''}
</div></body></html>`;

// ---- 출력 경로 준비 ----------------------------------------------------
const outAbs = path.resolve(out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
const tmpHtml = outAbs.replace(/\.png$/i, '') + '.__tmp__.html';
fs.writeFileSync(tmpHtml, html, 'utf8');

// ---- Chrome 탐색 -------------------------------------------------------
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find(pp => fs.existsSync(pp)) || 'google-chrome';

// ---- 스크린샷 ----------------------------------------------------------
try {
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${W},${H}`,
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=2000',
    `--screenshot=${outAbs}`,
    pathToFileURL(tmpHtml).href,
  ], { stdio: 'ignore' });
} catch (e) {
  console.error('Chrome 스크린샷 실패:', e.message);
  console.error('CHROME 환경변수로 브라우저 경로를 지정할 수 있습니다.');
  process.exit(1);
} finally {
  try { fs.unlinkSync(tmpHtml); } catch {}
}

if (!fs.existsSync(outAbs)) {
  console.error('PNG가 생성되지 않았습니다.');
  process.exit(1);
}
const kb = (fs.statSync(outAbs).size / 1024).toFixed(0);
console.log(`✅ 썸네일 생성: ${out}  (${W}x${H} @2x, ${kb}KB, 팔레트 #${hash % PALETTES.length})`);
