#!/usr/bin/env node
// 레시피 썸네일 생성기 (OpenAI 이미지 API 버전)
// OpenAI gpt-image-1 으로 실제 음식 사진/일러스트 썸네일(PNG)을 만든다.
// 프로젝트 기존 패턴(week-3 my-midjourney)과 동일: images/generations, b64_json 응답.
//
// 사용법:
//   node gen-thumbnail-openai.mjs --title "오징어 볶음밥" \
//     --prompt "Professional overhead food photo of Korean squid fried rice ..." \
//     --size landscape --quality medium \
//     --out "week-5/my-recipe/썸네일/squid-fried-rice.png"
//
// 필수: --out  (그리고 --prompt 또는 --title 중 하나)
// 선택: --subtitle --style --size(landscape|square|portrait|WxH) --quality(low|medium|high)
//       --model(기본 gpt-image-1) --env(.env 경로)

import fs from 'node:fs';
import path from 'node:path';

// ---- 인자 파싱 ----------------------------------------------------------
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1] ?? ''; i++; }
}

const out = (args.out || '').trim();
const title = (args.title || '').trim();
const promptArg = (args.prompt || '').trim();
if (!out || (!promptArg && !title)) {
  console.error('필수 인자 누락: --out 과, (--prompt 또는 --title) 중 하나는 반드시 필요합니다.');
  process.exit(1);
}
const subtitle = (args.subtitle || '').trim();
const style = (args.style || '').trim();
const model = (args.model || 'gpt-image-1').trim();
const quality = (args.quality || 'medium').trim();

// 크기 별칭 → gpt-image-1 지원 사이즈
const SIZE_ALIAS = { landscape: '1536x1024', square: '1024x1024', portrait: '1024x1536', auto: 'auto' };
const size = SIZE_ALIAS[(args.size || 'landscape').trim()] || (args.size || '1536x1024').trim();

// ---- OpenAI 키 로드 (코드에 하드코딩 금지 — env/.env에서만) -------------
function loadKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const candidates = [
    args.env,                              // 명시적 지정
    path.join(path.dirname(path.resolve(out)), '.env'), // 출력 폴더 옆 .env
    'week-5/my-food/.env',                 // 프로젝트 공용 키
    '.env',
    'week-3/class/my-midjourney/.env',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(c);
        if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
      }
    } catch { /* 무시하고 다음 후보 */ }
  }
  return '';
}
const OPENAI_API_KEY = loadKey();
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY 를 찾지 못했습니다. 환경변수로 export 하거나 --env <.env경로> 로 지정하세요.');
  process.exit(1);
}

// ---- 프롬프트 조립 ------------------------------------------------------
// AI는 글자 렌더링이 약하므로 "no text" 를 명시 (제목/배지는 이미지에 넣지 않음)
const finalPrompt = promptArg || [
  `Professional food photography of ${title}`,
  subtitle ? `(${subtitle})` : '',
  'Korean home-style dish, beautifully plated, fresh garnish, warm natural lighting,',
  'shallow depth of field, appetizing, ultra detailed, food magazine style,',
  'no text, no watermark, no lettering',
  style,
].filter(Boolean).join(', ');

// ---- 호출 ---------------------------------------------------------------
const OPENAI_URL = 'https://api.openai.com/v1/images/generations';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 180000); // 180s

console.log(`🎨 OpenAI(${model}, ${size}, q=${quality}) 이미지 생성 중...`);
let resp;
try {
  resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: finalPrompt, n: 1, size, quality }),
    signal: controller.signal,
  });
} catch (e) {
  clearTimeout(timer);
  console.error(e?.name === 'AbortError' ? '시간 초과(180s)로 중단했습니다.' : `요청 실패: ${e.message}`);
  process.exit(1);
}
clearTimeout(timer);

if (!resp.ok) {
  let info = '';
  try { const b = await resp.json(); info = `${b?.error?.type || b?.error?.code || ''} ${b?.error?.message || ''}`.trim(); } catch {}
  console.error(`OpenAI API 오류 (${resp.status}): ${info}`);
  if (/insufficient_quota|billing|exceeded_quota/i.test(info)) console.error('→ OpenAI 크레딧/결제 정보를 확인하세요.');
  else if (resp.status === 401 || /invalid_api_key/i.test(info)) console.error('→ OPENAI_API_KEY 가 올바른지 확인하세요.');
  else if (/verif/i.test(info)) console.error('→ gpt-image-1 은 조직 인증이 필요할 수 있습니다. --model dall-e-3 로 재시도해 보세요.');
  else if (/content_policy|moderation|safety/i.test(info)) console.error('→ 프롬프트가 콘텐츠 정책에 걸렸습니다. 표현을 바꿔보세요.');
  process.exit(1);
}

const data = await resp.json();
const item = Array.isArray(data?.data) ? data.data[0] : null;
let buf;
if (item?.b64_json) {
  buf = Buffer.from(item.b64_json, 'base64');          // gpt-image-1 / dall-e b64
} else if (item?.url) {
  const img = await fetch(item.url);                   // dall-e-3 url 응답 대비
  buf = Buffer.from(await img.arrayBuffer());
} else {
  console.error('응답에 이미지 데이터가 없습니다:', JSON.stringify(data).slice(0, 300));
  process.exit(1);
}

const outAbs = path.resolve(out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, buf);
const kb = (buf.length / 1024).toFixed(0);
console.log(`✅ 썸네일 생성: ${out}  (${size}, ${model}, ${kb}KB)`);
if (data?.usage) console.log(`   usage: ${JSON.stringify(data.usage)}`);
