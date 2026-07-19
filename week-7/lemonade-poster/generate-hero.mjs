#!/usr/bin/env node
// 카페 안도 신메뉴 포스터 — 「크러시드 레모네이드」 히어로 컷 생성.
// fal.ai(flux/dev) 우선 → 잔액 소진(403) 시 OpenAI gpt-image-1 폴백.
// 키는 week-3/class/my-midjourney/.env 재사용 (cafe-menu-board 패턴).
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

// A = 다이내믹 스플래시(깨부수기), B = 미니멀 정물(크러시드 아이스 질감)
const PROMPTS = [
  [
    'High-speed commercial beverage photography of an ice-cold lemonade in a tall straight glass,',
    'vivid saturated yellow lemonade packed with crushed ice,',
    'a dynamic splash bursting from the top with flying ice fragments and a lemon slice mid-air,',
    'droplets frozen in motion, heavy condensation on the glass,',
    'pure black studio background, dramatic rim lighting from both sides,',
    'high contrast, Apple advertisement aesthetic, centered composition,',
    'hyper detailed, razor sharp, 8k',
  ].join(' '),
  [
    'Premium minimal product photography of an ice-cold lemonade in a tall straight glass,',
    'vivid saturated yellow lemonade filled to the top with finely crushed ice like shaved ice,',
    'two thin lemon slices tucked inside the glass, heavy condensation droplets,',
    'glass standing on a dark matte stone surface with a faint reflection,',
    'pure black studio background, dramatic soft rim light, gentle top light,',
    'Apple advertisement aesthetic, centered composition, negative space above,',
    'hyper detailed, razor sharp, 8k',
  ].join(' '),
];

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
  for (let p = 0; p < PROMPTS.length; p++) {
    console.log(`[fal] flux/dev 레모네이드 컷 ${p + 1}/2...`);
    const gen = await falRun('fal-ai/flux/dev', {
      prompt: PROMPTS[p],
      image_size: { width: 1024, height: 1536 },
      num_images: 2,
      num_inference_steps: 32,
      guidance_scale: 3.5,
      enable_safety_checker: true,
    });
    for (let i = 0; i < gen.images.length; i++) {
      await download(gen.images[i].url, path.join(HERE, 'assets', `hero-${p * 2 + i + 1}.png`));
    }
  }
  return 'fal';
}

async function viaOpenAI() {
  console.log('[openai] gpt-image-1 폴백 (프롬프트 2종 × 1컷)...');
  for (let p = 0; p < PROMPTS.length; p++) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: PROMPTS[p], size: '1024x1536', quality: 'high', n: 1 }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const data = await res.json();
    fs.writeFileSync(path.join(HERE, 'assets', `hero-${p + 1}.png`), Buffer.from(data.data[0].b64_json, 'base64'));
    console.log('saved', `assets/hero-${p + 1}.png (프롬프트 ${p === 0 ? 'A 스플래시' : 'B 정물'})`);
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
