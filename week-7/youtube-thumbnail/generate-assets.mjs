#!/usr/bin/env node
// fal.ai로 썸네일용 인물 이미지 생성 → 배경 제거(birefnet)까지 한 번에.
// 실패 시 OpenAI gpt-image-1 폴백. 키는 week-3/class/my-midjourney/.env 재사용.
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
  'Photorealistic cinematic portrait of a Korean man in his early 30s,',
  'slightly messy medium-length black hair, clean shaven,',
  'wearing a plain dark charcoal crew-neck t-shirt with a small black wireless lavalier microphone clipped near the collar,',
  'eyes wide open in shock and disbelief, eyebrows raised high, lips slightly parted,',
  'looking directly at the camera, framed from the chest up,',
  'moody dim home-office at night behind him, blurred bookshelf and monitor glow, shallow depth of field,',
  'soft warm key light from the left, teal-gray ambient fill,',
  'high detail skin texture, professional YouTube thumbnail photography style',
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
  console.log('[fal] flux/dev 인물 생성...');
  const gen = await falRun('fal-ai/flux/dev', {
    prompt: PROMPT,
    image_size: { width: 1024, height: 1280 },
    num_images: 2,
    num_inference_steps: 32,
    guidance_scale: 3.5,
    enable_safety_checker: true,
  });
  const urls = gen.images.map(i => i.url);
  for (let i = 0; i < urls.length; i++) {
    await download(urls[i], path.join(HERE, 'assets', `person-${i + 1}.png`));
  }
  console.log('[fal] birefnet 배경 제거...');
  for (let i = 0; i < urls.length; i++) {
    const cut = await falRun('fal-ai/birefnet/v2', { image_url: urls[i] });
    const cutUrl = cut.image?.url || cut.images?.[0]?.url;
    await download(cutUrl, path.join(HERE, 'assets', `person-${i + 1}-cut.png`));
  }
  return 'fal';
}

async function viaOpenAI() {
  console.log('[openai] gpt-image-1 폴백...');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: PROMPT + ' Transparent background, subject isolated.',
      size: '1024x1536',
      background: 'transparent',
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const b64 = data.data[0].b64_json;
  const file = path.join(HERE, 'assets', 'person-raw.png');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('saved', file);
  return 'openai';
}

try {
  const engine = await viaFal();
  console.log('DONE engine =', engine);
} catch (e) {
  console.error('fal 실패:', e.message);
  const engine = await viaOpenAI();
  console.log('DONE engine =', engine);
}
