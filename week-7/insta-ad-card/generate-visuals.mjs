// The Row 인스타 광고 카드 — AI 비주얼 생성 (OpenAI gpt-image-1)
// 사용법: node generate-visuals.mjs            → 3장 전부 생성
//         node generate-visuals.mjs v2-texture → 지정한 것만 재생성
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);

// 키 로드: 로컬 .env → 형제 프로젝트 .env 순서로 탐색 (키는 커밋하지 않음)
const ENV_PATHS = [
  path.join(DIR, '.env'),
  path.join(DIR, '../../week-6/cafe-dashboard/.env'),
  path.join(DIR, '../../interior-cost/.env'),
];
let KEY = process.env.OPENAI_API_KEY;
for (const p of ENV_PATHS) {
  if (KEY) break;
  try {
    const m = fs.readFileSync(p, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
    if (m) KEY = m[1].trim();
  } catch {}
}
if (!KEY) {
  console.error('OPENAI_API_KEY를 찾지 못했습니다.');
  process.exit(1);
}

// 공통 스타일 접미사 — Summer 2026 캠페인 실측 톤 (BRAND.md 참조)
const STYLE =
  'Vast warm off-white seamless studio (walls and floor around #EDEAE4), soft diffused daylight, ' +
  'one faint natural shadow, enormous negative space, muted palette of ivory, greige, camel and near-black, ' +
  'subtle fine 35mm film grain, medium-format editorial photography for a quiet-luxury fashion house. ' +
  'Extremely minimal composition. No text, no logos, no watermarks.';

const VISUALS = [
  {
    name: 'v1-coat-chair',
    prompt:
      'Quiet luxury fashion campaign still photograph: a double-faced camel cashmere overcoat draped ' +
      'over a single simple pale beech-wood chair, placed small and slightly below center of frame. ' +
      'No people, no props. ' + STYLE,
  },
  {
    name: 'v2-texture',
    prompt:
      'Editorial macro still life: a neat stack of three folded double-faced cashmere garments — ivory, ' +
      'camel and charcoal — on a warm off-white linen surface. Close crop, soft directional window light ' +
      'raking across fine cashmere fibers, shallow depth of field, visible wool texture. No hands. ' + STYLE,
  },
  {
    name: 'v3-figure',
    prompt:
      'Minimal luxury fashion campaign photograph: a woman seen from behind, walking away, wearing a long ' +
      'fluid camel silk overcoat, black tailored trousers and black flat shoes, hair in a low bun. ' +
      'She appears small, centered in the frame. ' + STYLE,
  },
];

const outDir = path.join(DIR, 'assets');
fs.mkdirSync(outDir, { recursive: true });

async function gen(v) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: v.prompt, size: '1024x1024', quality: 'high', n: 1 }),
  });
  if (!res.ok) throw new Error(`${v.name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const file = path.join(outDir, `${v.name}.png`);
  fs.writeFileSync(file, Buffer.from(j.data[0].b64_json, 'base64'));
  console.log(`saved ${v.name}.png (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

const only = process.argv.slice(2);
const list = only.length ? VISUALS.filter((v) => only.includes(v.name)) : VISUALS;
if (!list.length) {
  console.error(`이름이 맞지 않습니다. 가능한 값: ${VISUALS.map((v) => v.name).join(', ')}`);
  process.exit(1);
}
const results = await Promise.allSettled(list.map(gen));
let fail = 0;
for (const r of results) if (r.status === 'rejected') { fail++; console.error(r.reason.message); }
process.exit(fail ? 1 : 0);
