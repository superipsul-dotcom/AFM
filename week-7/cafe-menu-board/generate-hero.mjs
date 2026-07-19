#!/usr/bin/env node
// 카페 안도 메뉴판 — 시그니처 「흑임자 크림라떼」 히어로 컷을 fal.ai(flux/dev)로 생성.
// 블랙 배경 제품사진(애플 광고 스타일)이라 다크 메뉴판에 그대로 얹는다.
// 키는 week-3/class/my-midjourney/.env 재사용 (youtube-thumbnail 패턴).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, '../../week-3/class/my-midjourney/.env');
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, 'utf8').split('\n')
    .map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].trim()])
);

const PROMPT = [
  'Premium commercial product photography of an iced black sesame cream latte',
  'in a tall minimal straight-walled clear glass,',
  'two clean layers: deep charcoal-grey black sesame milk below,',
  'a thick silky off-white cream cloud floating on top,',
  'fine black sesame powder dusted over the cream,',
  'glass standing on a dark matte stone surface with a faint soft reflection,',
  'pure black studio background, dramatic soft rim light from behind,',
  'gentle warm key light, subtle condensation droplets on the glass,',
  'Apple advertisement aesthetic, centered composition, lots of negative space above,',
  'hyper detailed, sharp focus, 8k food photography',
].join(' ');

async function falRun(model, body) {
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fal ${model} ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log('saved', file, fs.statSync(file).size, 'bytes');
}

async function viaFal() {
  console.log('[fal] flux/dev 흑임자 크림라떼 히어로 4컷 생성...');
  const gen = await falRun('fal-ai/flux/dev', {
    prompt: PROMPT,
    image_size: { width: 1024, height: 1280 },
    num_images: 4,
    num_inference_steps: 32,
    guidance_scale: 3.5,
    enable_safety_checker: true,
  });
  for (let i = 0; i < gen.images.length; i++) {
    await download(gen.images[i].url, path.join(HERE, 'assets', `hero-${i + 1}.png`));
  }
  return 'fal';
}

// fal 잔액 소진 시 폴백 (2026-07-19 실측: 403 Exhausted balance).
// 잔액 충전 후 이 스크립트를 다시 돌리면 fal 컷으로 교체된다.
async function viaOpenAI() {
  console.log('[openai] gpt-image-1 폴백 (2컷)...');
  for (let i = 1; i <= 2; i++) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: PROMPT, size: '1024x1536', quality: 'high', n: 1 }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const data = await res.json();
    fs.writeFileSync(path.join(HERE, 'assets', `hero-${i}.png`), Buffer.from(data.data[0].b64_json, 'base64'));
    console.log('saved', `assets/hero-${i}.png`);
  }
  return 'openai';
}

fs.mkdirSync(path.join(HERE, 'assets'), { recursive: true });
try {
  console.log('DONE engine =', await viaFal());
} catch (e) {
  console.error('fal 실패:', e.message);
  console.log('DONE engine =', await viaOpenAI());
}
console.log('assets/hero-*.png 중 베스트 컷을 골라 menu.html에서 사용');
