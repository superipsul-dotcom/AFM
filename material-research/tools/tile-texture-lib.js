// 타일 텍스처 생성 라이브러리 — 원판면 → 규격별 시멀리스 타일 텍스처 + 줄눈
//  - 원판면을 규격 비율에 맞춤:
//    · 비율 일치: 리사이즈 / 원판이 더 김: 랜덤 윈도우 크롭(셀별 변주)
//    · 규격이 더 김(예: 600×600 원판 → 600×1200): 해당 축을 시멀리스화(1D 조명 평탄화+50% 롤+원본 중앙 힐)
//      후 랩 연속으로 확장 — "600×600 이미지를 심리스하게 600×1200으로 키워서 줄눈"
//  - 격자 배치(작은 타일은 여러 셀, 셀별 플립·밝기 변주) + 실측 2mm 줄눈, 상하좌우 랩 시멀리스
//  - server.js가 요청 시(on-demand) 생성·캐시할 때와 배치 CLI(gen-tile-textures.js)가 공용으로 사용
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const OUT_PPM = 1.0;        // 출력 해상도 상한 px/mm
const OUT_MAX_PX = 4096;    // 최장변 상한
const GROUT_MM = 2;         // 줄눈 실측 mm
const TEX_TARGET_MM = 1200; // 텍스처 목표 실측(작은 타일은 이 근처까지 격자)
const TEX_MAX_MM = 2900;    // 텍스처 실측 상한(빅슬랩 1장)

/* ---------- 이미지 IO ---------- */
function loadImage(p) {
  const buf = fs.readFileSync(p);
  if (/\.png$/i.test(p)) {
    const png = PNG.sync.read(buf);
    return { w: png.width, h: png.height, data: new Uint8ClampedArray(png.data) };
  }
  const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
  return { w: d.width, h: d.height, data: new Uint8ClampedArray(d.data) };
}
function saveJpg(img, p, q = 88) {
  fs.writeFileSync(p, jpeg.encode({ width: img.w, height: img.h, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) }, q).data);
}
function savePngFile(img, p) {
  const png = new PNG({ width: img.w, height: img.h });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length).copy(png.data);
  fs.writeFileSync(p, PNG.sync.write(png));
}
function mkImg(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { w, h, data };
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromId(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ---------- 기본 변환 ---------- */
function rotate90(img) {
  const out = mkImg(img.h, img.w);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const s = (y * img.w + x) * 4, d = (x * out.w + (out.w - 1 - y)) * 4;
    out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2];
  }
  return out;
}
// box-average 리샘플 (확대는 bilinear)
function resample(img, tw, th) {
  const out = mkImg(tw, th);
  const sx = img.w / tw, sy = img.h / th;
  const shrink = sx >= 1 || sy >= 1;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4;
      if (shrink) {
        const x0 = Math.floor(x * sx), y0 = Math.floor(y * sy);
        const x1 = Math.min(img.w, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
        const y1 = Math.min(img.h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.w + xx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
        }
        out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n;
      } else {
        const fx = (x + 0.5) * sx - 0.5, fy = (y + 0.5) * sy - 0.5;
        const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy));
        const x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1);
        const ax = fx - x0, ay = fy - y0;
        for (let c = 0; c < 3; c++) {
          const v00 = img.data[(y0 * img.w + x0) * 4 + c], v10 = img.data[(y0 * img.w + x1) * 4 + c];
          const v01 = img.data[(y1 * img.w + x0) * 4 + c], v11 = img.data[(y1 * img.w + x1) * 4 + c];
          out.data[o + c] = (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
        }
      }
    }
  }
  return out;
}

/* ---------- 시멀리스화 (X축): 1D 조명 평탄화 + 50% 롤 + 원본 중앙 힐 ---------- */
function makeSeamlessX(img) {
  const { w, h } = img;
  const colMean = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; s += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; }
    colMean[x] = s / h;
  }
  const R = Math.max(8, w >> 3);
  const smooth = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -R; k <= R; k++) acc += colMean[(((x + k) % w) + w) % w];
    smooth[x] = acc / (2 * R + 1);
  }
  const gMean = colMean.reduce((a, b) => a + b, 0) / w;
  const flat = mkImg(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, d = gMean - smooth[x];
    flat.data[i] = img.data[i] + d; flat.data[i + 1] = img.data[i + 1] + d; flat.data[i + 2] = img.data[i + 2] + d;
  }
  const out = mkImg(w, h);
  const half = w >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + (x + half) % w) * 4, d = (y * w + x) * 4;
    out.data[d] = flat.data[s]; out.data[d + 1] = flat.data[s + 1]; out.data[d + 2] = flat.data[s + 2];
  }
  // 롤 이음선(x = w-half) 위에 평탄화 원본을 페더 블렌드(원본 중앙부는 연속이므로 이음이 사라짐)
  const bandHalf = Math.max(10, Math.round(w * 0.09));
  const cx = w - half;
  for (let y = 0; y < h; y++) for (let k = -bandHalf; k <= bandHalf; k++) {
    const x = cx + k;
    if (x < 0 || x >= w) continue;
    const a = 0.5 * (1 + Math.cos(Math.PI * Math.abs(k) / bandHalf));
    const d = (y * w + x) * 4;
    out.data[d] = out.data[d] * (1 - a) + flat.data[d] * a;
    out.data[d + 1] = out.data[d + 1] * (1 - a) + flat.data[d + 1] * a;
    out.data[d + 2] = out.data[d + 2] * (1 - a) + flat.data[d + 2] * a;
  }
  return out;
}
const makeSeamlessY = (img) => rotate90(rotate90(rotate90(makeSeamlessX(rotate90(img)))));

/* ---------- 격자 구성(순수 수학 — 임포트 단계 실측 계산에도 사용) ---------- */
function gridFor(tileW, tileH) {
  const cols = Math.min(8, tileW >= 1000 ? 1 : Math.max(2, Math.round(TEX_TARGET_MM / tileW)));
  const rows = Math.min(8, tileH >= 1000 ? 1 : Math.max(2, Math.round(TEX_TARGET_MM / tileH)));
  return { cols, rows, mmW: Math.min(TEX_MAX_MM, cols * tileW), mmH: Math.min(TEX_MAX_MM, rows * tileH) };
}

/* ---------- 원판면 → 규격 텍스처 ---------- */
function buildTileTexture(face, tileW, tileH, rng) {
  const ar = (w, h) => w / h;
  let f = face;
  if (Math.abs(Math.log(ar(f.w, f.h) / ar(tileW, tileH))) > Math.abs(Math.log(ar(f.h, f.w) / ar(tileW, tileH)))) {
    f = rotate90(f);
  }
  const srcPpm = Math.min(f.w / tileW, f.h / tileH);
  const { cols, rows } = gridFor(tileW, tileH);
  const texW_MM = cols * tileW, texH_MM = rows * tileH;
  const ppm = Math.min(srcPpm > 0 ? srcPpm : OUT_PPM, OUT_PPM, OUT_MAX_PX / texW_MM, OUT_MAX_PX / texH_MM);
  const cellW = Math.max(8, Math.round(tileW * ppm)), cellH = Math.max(8, Math.round(tileH * ppm));
  const W = cellW * cols, H = cellH * rows;

  // 부족한 축 시멀리스 확장, 남는 축은 크롭 여지
  const faceAR = ar(f.w, f.h), cellAR = ar(cellW, cellH);
  let src = f;
  let wrapX = false, wrapY = false;
  if (faceAR / cellAR < 0.97) { src = makeSeamlessX(src); wrapX = true; }
  else if (cellAR / faceAR < 0.97) { src = makeSeamlessY(src); wrapY = true; }
  let sw, sh;
  if (wrapX) { sh = cellH; sw = Math.max(8, Math.round(src.w * (cellH / src.h))); }
  else if (wrapY) { sw = cellW; sh = Math.max(8, Math.round(src.h * (cellW / src.w))); }
  else {
    const sc = Math.max(cellW / src.w, cellH / src.h);
    sw = Math.max(cellW, Math.round(src.w * sc)); sh = Math.max(cellH, Math.round(src.h * sc));
  }
  src = resample(src, sw, sh);

  const tex = mkImg(W, H);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const fx = rng() < 0.5, fy = rng() < 0.5;
      const gain = 0.985 + rng() * 0.03;
      const offX = wrapX ? Math.floor(rng() * src.w) : Math.floor(rng() * Math.max(1, src.w - cellW + 1));
      const offY = wrapY ? Math.floor(rng() * src.h) : Math.floor(rng() * Math.max(1, src.h - cellH + 1));
      for (let y = 0; y < cellH; y++) {
        const syRaw = offY + (fy ? cellH - 1 - y : y);
        const sy = wrapY ? syRaw % src.h : Math.min(src.h - 1, syRaw);
        for (let x = 0; x < cellW; x++) {
          const sxRaw = offX + (fx ? cellW - 1 - x : x);
          const sx = wrapX ? sxRaw % src.w : Math.min(src.w - 1, sxRaw);
          const s = (sy * src.w + sx) * 4, d = ((r * cellH + y) * W + (c * cellW + x)) * 4;
          tex.data[d] = src.data[s] * gain; tex.data[d + 1] = src.data[s + 1] * gain; tex.data[d + 2] = src.data[s + 2] * gain;
        }
      }
    }
  }

  // 평균색 + 줄눈색(타일색 55% + 중성회 45%, 소폭 어둡게)
  let ar_ = 0, ag = 0, ab = 0, an = 0;
  for (let i = 0; i < tex.data.length; i += 16) { ar_ += tex.data[i]; ag += tex.data[i + 1]; ab += tex.data[i + 2]; an++; }
  const avg = { r: Math.round(ar_ / an), g: Math.round(ag / an), b: Math.round(ab / an) };
  const gr = Math.round((avg.r * 0.55 + 186 * 0.45) * 0.93);
  const gg = Math.round((avg.g * 0.55 + 184 * 0.45) * 0.93);
  const gb = Math.round((avg.b * 0.55 + 181 * 0.45) * 0.93);

  const jw = Math.max(1, Math.round(GROUT_MM * ppm));
  const noise = mulberry32(7);
  const paint = (x, y) => {
    const i = ((((y % H) + H) % H) * W + (((x % W) + W) % W)) * 4;
    const n = (noise() - 0.5) * 10;
    tex.data[i] = gr + n; tex.data[i + 1] = gg + n; tex.data[i + 2] = gb + n;
  };
  const bevel = (x, y) => {
    const i = ((((y % H) + H) % H) * W + (((x % W) + W) % W)) * 4;
    tex.data[i] *= 0.94; tex.data[i + 1] *= 0.94; tex.data[i + 2] *= 0.94;
  };
  for (let c = 0; c < cols; c++) {
    const jx = c * cellW;
    for (let k = 0; k < jw; k++) for (let y = 0; y < H; y++) paint(jx - Math.floor(jw / 2) + k, y);
    if (ppm >= 0.5) for (let y = 0; y < H; y++) { bevel(jx - Math.floor(jw / 2) - 1, y); bevel(jx - Math.floor(jw / 2) + jw, y); }
  }
  for (let r = 0; r < rows; r++) {
    const jy = r * cellH;
    for (let k = 0; k < jw; k++) for (let x = 0; x < W; x++) paint(x, jy - Math.floor(jw / 2) + k);
    if (ppm >= 0.5) for (let x = 0; x < W; x++) { bevel(x, jy - Math.floor(jw / 2) - 1); bevel(x, jy - Math.floor(jw / 2) + jw); }
  }

  return { tex, mm: { w: W / ppm, h: H / ppm }, ppm, cols, rows, avg, extended: wrapX || wrapY };
}

// 라이브러리 항목 1건의 텍스처를 (없으면) 생성해 파일로 캐시 — 갱신 메타 반환
function ensureTileTexture(entry, srcDir, outDir, { force = false } = {}) {
  const outPath = path.join(outDir, entry.file);
  if (!force && fs.existsSync(outPath)) return { cached: true, outPath, meta: null };
  const facePath = path.join(srcDir, entry.src_file);
  if (!fs.existsSync(facePath)) throw new Error('원판면 없음: ' + entry.src_file);
  const face = loadImage(facePath);
  const rng = mulberry32(seedFromId(entry.id));
  const r = buildTileTexture(face, entry.spec.w, entry.spec.l, rng);
  saveJpg(r.tex, outPath, 88);
  return {
    cached: false, outPath,
    meta: {
      size_mm: { w: Math.round(r.mm.w * 10) / 10, h: Math.round(r.mm.h * 10) / 10 },
      px: { w: r.tex.w, h: r.tex.h },
      ppm: Math.round(r.ppm * 1000) / 1000,
      grid: `${r.cols}x${r.rows}`,
      extended: r.extended,
      avg: r.avg,
    },
  };
}

module.exports = { loadImage, saveJpg, savePngFile, mkImg, mulberry32, seedFromId, buildTileTexture, gridFor, ensureTileTexture, GROUT_MM, OUT_PPM };
