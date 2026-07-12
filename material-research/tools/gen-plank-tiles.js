// 플랭크 규격 기반 마루 시멀리스 배치 생성기
// 원칙: 플랭크 1장 = 연속 결 조각 정확히 1개 (스플라이스 없음, 패턴 단절 없음)
//  - 원본 제품컷에서 행 그리드(피치·위상)를 직접 검출해 스케일(px/mm) 자동 교정
//  - 행 밴드 → 조인트(어두운 선 + 급격한 톤 스텝)에서 결 조각 추출 (행 롤 원통 랩 지원)
//  - 저해상도 소스는 조각 사전 정화(내부 톤 급변점 재귀 분할) + 출력 플랭크 균일성 가드
//  - 실측 플랭크 격자(랜덤 스태거 25~75%) + 셀 랩 배치 = 상하좌우 시멀리스
//  - 이웃 플랭크 밝기 대비 최소 보장, 1px 조인트는 대비 강화
// 사용: node tools/gen-plank-tiles.js [--codes WD-0001,WD-0002] [--force] [--dry]
// 결과: data/textures/wood/<id>.plank.jpg + wood-library.json 항목에 plank 메타
//       (조각 확보 실패 자재는 plank_status="unsupported" — 기존 스와치 방식 유지)
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const ROOT = path.join(__dirname, '..');
const WOOD_DIR = path.join(ROOT, 'data', 'textures', 'wood');
const LIB_FILE = path.join(ROOT, 'data', 'wood-library.json');

const MAX_SINGLE_STRETCH = 2.6;   // 조각 1개 통스트레치 상한 (초과 필요 시 그 조각은 사용 불가)
const LOWRES_PPM = 0.6;           // 이 미만이면 quality="low" (UI 저해상도 표시)
const OUT_PPM_CAP = 1.2;          // 출력 해상도 상한 px/mm (SketchUp 실사용 기준, 용량 관리)
const OUT_MAX_PX = 4096;          // 출력 최장변 상한

/* ---------- 기본 유틸 ---------- */
function loadJpg(p) {
  const d = jpeg.decode(fs.readFileSync(p), { useTArray: true, maxMemoryUsageInMB: 2048 });
  return { w: d.width, h: d.height, data: d.data };
}
function saveJpg(img, p, q = 90) {
  fs.writeFileSync(p, jpeg.encode({ width: img.w, height: img.h, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) }, q).data);
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
const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function movingMedian(arr, win) {
  const half = win >> 1, n = arr.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) a.push(arr[j]);
    a.sort((x, y) => x - y);
    out[i] = a[(a.length / 2) | 0];
  }
  return out;
}

/* ---------- 플랭크 경계 검출: 어두운 세로선(조인트) + 톤 스텝(플랭크 간 색차) ---------- */
// 톤 스텝은 "급경사" 조건 필수 — 캐시드럴 결의 완만한 명암 변화(수십 px 램프)는 배제
function detectButtJoints(img, y0, y1, ppm) {
  const col = new Float64Array(img.w);
  for (let x = 0; x < img.w; x++) {
    let s = 0;
    for (let y = y0; y < y1; y++) s += luma(img.data, (y * img.w + x) * 4);
    col[x] = s / (y1 - y0);
  }
  // (1) 어두운 선
  const med = movingMedian(col, 61);
  const score = new Float64Array(img.w);
  for (let x = 0; x < img.w; x++) score[x] = med[x] - col[x];
  const sorted = [...score].sort((a, b) => a - b);
  const m = sorted[(sorted.length / 2) | 0];
  const mad = [...score.map(v => Math.abs(v - m))].sort((a, b) => a - b)[(score.length / 2) | 0] || 1;
  const lowRes = ppm < 1.0; // 저해상도: 경계가 뭉개져 약하게 나타남 → 공격적 검출(과분할이 누출보다 안전)
  const thr = lowRes ? Math.max(3, m + 3.5 * mad) : Math.max(4, m + 4.5 * mad);
  const peaks = [];
  for (let x = 4; x < img.w - 4; x++) {
    if (score[x] > thr && score[x] >= score[x - 1] && score[x] >= score[x + 1]) {
      if (peaks.length && x - peaks[peaks.length - 1].x < 30) {
        if (score[x] > peaks[peaks.length - 1].s) peaks[peaks.length - 1] = { x, s: score[x] };
      } else peaks.push({ x, s: score[x] });
    }
  }
  // (2) 톤 스텝: 좌우 창 평균차 + 경계가 좁은 폭(1~2mm)에서 급변해야 인정
  const STEP_W = 24, STEP_GAP = 3;
  const STEP_THR = lowRes ? 3.5 : 6.5;
  const SHARP_THR = lowRes ? 2.5 : 5;
  const sharpD = Math.max(2, Math.round(1.5 * ppm));
  const step = new Float64Array(img.w);
  for (let x = STEP_W + STEP_GAP; x < img.w - STEP_W - STEP_GAP; x++) {
    let l = 0, r = 0;
    for (let k = STEP_GAP; k < STEP_GAP + STEP_W; k++) { l += col[x - k]; r += col[x + k]; }
    step[x] = Math.abs(r - l) / STEP_W;
  }
  const stepPeaks = [];
  for (let x = sharpD; x < img.w - sharpD; x++) {
    if (step[x] > STEP_THR && step[x] >= step[x - 1] && step[x] >= step[x + 1]) {
      const sharp = Math.abs(col[x + sharpD] - col[x - sharpD]);
      if (sharp < SHARP_THR) continue;
      if (stepPeaks.length && x - stepPeaks[stepPeaks.length - 1] < 30) continue;
      stepPeaks.push(x);
    }
  }
  const all = [...peaks.map(p => p.x), ...stepPeaks].sort((a, b) => a - b);
  const joints = [];
  for (const x of all) {
    if (!joints.length || x - joints[joints.length - 1] > 12) joints.push(x);
  }
  // 강제 분할용 경계 점수(정규화 max)
  const bScore = new Float64Array(img.w);
  for (let x = 0; x < img.w; x++) bScore[x] = Math.max(score[x] / thr, (step[x] || 0) / STEP_THR);
  // 조인트 명암비 샘플(어두운 선 피크에서만)
  let ratio = null;
  if (peaks.length) {
    let rj = 0, rn = 0, cnt = 0;
    for (const p of peaks) {
      const nb = [];
      for (const dx of [-12, -9, -6, 6, 9, 12]) if (col[p.x + dx] !== undefined) nb.push(col[p.x + dx]);
      if (nb.length) { rj += col[p.x]; rn += nb.reduce((a, b) => a + b) / nb.length; cnt++; }
    }
    if (cnt) ratio = (rj / cnt) / (rn / cnt);
  }
  return { joints, ratio, bScore };
}

/* ---------- 행 그리드 검출: 가로 조인트 딥에서 실제 피치·위상 산출 (하모닉 오류 교정) ---------- */
function detectRowGrid(img) {
  const row = new Float64Array(img.h);
  for (let y = 0; y < img.h; y++) {
    let s = 0;
    for (let x = 0; x < img.w; x++) s += luma(img.data, (y * img.w + x) * 4);
    row[y] = s / img.w;
  }
  const dips = [];
  for (let y = 2; y < img.h - 2; y++) {
    let med = 0, n = 0;
    for (let k = -15; k <= 15; k += 3) { const yy = y + k; if (yy >= 0 && yy < img.h) { med += row[yy]; n++; } }
    med /= n;
    if (med - row[y] > 2 && row[y] <= row[y - 1] && row[y] <= row[y + 1]) dips.push({ y, dip: med - row[y] });
  }
  const merged = [];
  for (const p of dips) {
    if (merged.length && p.y - merged[merged.length - 1].y < 8) {
      if (p.dip > merged[merged.length - 1].dip) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  if (merged.length < 3) return null;
  const gaps = merged.slice(1).map((p, i) => p.y - merged[i].y).sort((a, b) => a - b);
  const pitch = gaps[(gaps.length / 2) | 0];
  const ok = gaps.filter(g => Math.abs(g - pitch) <= Math.max(3, pitch * 0.2)).length / gaps.length;
  if (ok < 0.8) return null;
  return { pitch, cuts: merged.map(p => p.y) };
}

/* ---------- 결 조각 추출 (행 롤 원통 랩 + 실측 초과 조각 강제 분할) ---------- */
function extractSegments(img, rowsSrc, rowH, minSegPx, Lpx, ppm) {
  const INSET = 6;
  const segs = [];
  let ratios = [];
  for (const [ry0, ry1] of rowsSrc) {
    const { joints, ratio, bScore } = detectButtJoints(img, ry0, ry1, ppm);
    if (ratio) ratios.push(ratio);
    let edgeDiff = 0;
    for (let y = ry0; y < ry1; y++) {
      edgeDiff += Math.abs(luma(img.data, (y * img.w) * 4) - luma(img.data, (y * img.w + img.w - 1) * 4));
    }
    edgeDiff /= (ry1 - ry0);
    const cylinder = edgeDiff < 8;
    let ranges = [];
    if (cylinder && joints.length) {
      for (let c = 0; c < joints.length; c++) {
        const xa = joints[c] + INSET;
        const xb = (c + 1 < joints.length ? joints[c + 1] : joints[0] + img.w) - INSET;
        if (xb > xa) ranges.push([xa, xb]);
      }
    } else if (cylinder && !joints.length) {
      ranges.push([0, img.w]);
    } else {
      const cuts = [0, ...joints, img.w];
      for (let c = 0; c + 1 < cuts.length; c++) {
        const xa = cuts[c] + (c === 0 ? 0 : INSET);
        const xb = cuts[c + 1] - (c + 1 === cuts.length - 1 ? 0 : INSET);
        if (xb > xa) ranges.push([xa, xb]);
      }
    }
    // 플랭크 실측 길이 초과 조각 = 놓친 경계 포함 가능 → 내부 경계점수 최대점에서 강제 분할
    const MAXLEN = Math.round(1.08 * Lpx);
    let guard = 0;
    while (guard++ < 50) {
      const iLong = ranges.findIndex(([a, b]) => b - a > MAXLEN);
      if (iLong < 0) break;
      const [a, b] = ranges[iLong];
      const len = b - a;
      let best = -1, bestX = a + (len >> 1);
      for (let x = a + Math.round(len * 0.25); x < a + Math.round(len * 0.75); x++) {
        const sc = bScore[x % img.w];
        if (sc > best) { best = sc; bestX = x; }
      }
      ranges.splice(iLong, 1, [a, bestX - INSET], [bestX + INSET, b]);
    }
    for (const [xa, xb] of ranges) {
      if (xb - xa >= minSegPx) segs.push(cropResampleV(img, xa, xb, ry0, ry1, rowH));
    }
  }
  const jointRatio = ratios.length ? ratios.reduce((a, b) => a + b) / ratios.length : 0.82;
  return { segs, jointRatio: Math.min(0.92, Math.max(0.55, jointRatio)) };
}
function cropResampleV(img, xa, xb, ry0, ry1, rowH) {
  const w = xb - xa, srcH = ry1 - ry0;
  const strip = { w, h: rowH, data: new Uint8ClampedArray(w * rowH * 4) };
  for (let y = 0; y < rowH; y++) {
    const sy = ry0 + (y + 0.5) * srcH / rowH - 0.5;
    const y0 = Math.max(ry0, Math.floor(sy)), y1 = Math.min(ry1 - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = (xa + x) % img.w;
      const i0 = (y0 * img.w + sx) * 4, i1 = (y1 * img.w + sx) * 4, o = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) strip.data[o + ch] = img.data[i0 + ch] * (1 - fy) + img.data[i1 + ch] * fy;
      strip.data[o + 3] = 255;
    }
  }
  return strip;
}
function flipX(strip) {
  const out = { w: strip.w, h: strip.h, data: new Uint8ClampedArray(strip.data.length) };
  for (let y = 0; y < strip.h; y++) for (let x = 0; x < strip.w; x++) {
    const s = (y * strip.w + (strip.w - 1 - x)) * 4, d = (y * strip.w + x) * 4;
    for (let c = 0; c < 4; c++) out.data[d + c] = strip.data[s + c];
  }
  return out;
}
function flipY(strip) {
  const out = { w: strip.w, h: strip.h, data: new Uint8ClampedArray(strip.data.length) };
  for (let y = 0; y < strip.h; y++) {
    out.data.set(strip.data.subarray((strip.h - 1 - y) * strip.w * 4, (strip.h - y) * strip.w * 4), y * strip.w * 4);
  }
  return out;
}
function resampleH(strip, targetW) {
  const out = { w: targetW, h: strip.h, data: new Uint8ClampedArray(targetW * strip.h * 4) };
  for (let x = 0; x < targetW; x++) {
    const sx = (x + 0.5) * strip.w / targetW - 0.5;
    const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(strip.w - 1, x0 + 1), fx = sx - x0;
    for (let y = 0; y < strip.h; y++) {
      const i0 = (y * strip.w + x0) * 4, i1 = (y * strip.w + x1) * 4, o = (y * targetW + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = strip.data[i0 + c] * (1 - fx) + strip.data[i1 + c] * fx;
      out.data[o + 3] = 255;
    }
  }
  return out;
}
function cropWindow(strip, off, w) {
  const out = { w, h: strip.h, data: new Uint8ClampedArray(w * strip.h * 4) };
  for (let y = 0; y < strip.h; y++) {
    out.data.set(strip.data.subarray((y * strip.w + off) * 4, (y * strip.w + off + w) * 4), y * w * 4);
  }
  return out;
}

/* ---------- 조각 사전 정화 (저해상도 전용): 내부 톤 급변점에서 재귀 분할 ---------- */
function segLeak(strip, ppm) {
  const winPx = Math.max(8, Math.round(60 * ppm));
  const n = Math.floor(strip.w / winPx);
  if (n < 2) return { worst: 0, pos: 0 };
  const means = [];
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let x = i * winPx; x < (i + 1) * winPx; x += 2)
      for (let y = 0; y < strip.h; y += 3) { s += luma(strip.data, (y * strip.w + x) * 4); c++; }
    means.push(s / c);
  }
  let worst = 0, pos = 0;
  for (let i = 0; i + 1 < n; i++) {
    const d = Math.abs(means[i + 1] - means[i]);
    if (d > worst) { worst = d; pos = (i + 1) * winPx; }
  }
  return { worst, pos };
}
// 창 경계(±창폭 오차)로 잡힌 분할점을 조각 내 실제 조인트 라인(최대 딥)으로 스냅
function refineCut(strip, pos, win) {
  const a = Math.max(2, pos - win), b = Math.min(strip.w - 3, pos + win);
  const col = [];
  for (let x = a; x <= b; x++) {
    let s = 0;
    for (let y = 0; y < strip.h; y++) s += luma(strip.data, (y * strip.w + x) * 4);
    col.push(s / strip.h);
  }
  let best = pos, bestDip = -Infinity;
  for (let i = 0; i < col.length; i++) {
    let med = 0, n = 0;
    for (let k = -12; k <= 12; k += 3) { const j = i + k; if (j >= 0 && j < col.length) { med += col[j]; n++; } }
    med /= n;
    const dip = med - col[i];
    if (dip > bestDip) { bestDip = dip; best = a + i; }
  }
  return best;
}
function cleanSegments(segs, ppm, minSegPx) {
  const CLEAN_THR = 4.2, CUT_INSET = 8;
  const clean = [];
  const queue = [...segs];
  let splits = 0, dropped = 0;
  while (queue.length) {
    const s = queue.pop();
    if (s.w < minSegPx) { dropped++; continue; }
    const { worst, pos } = segLeak(s, ppm);
    if (worst <= CLEAN_THR) { clean.push(s); continue; }
    splits++;
    const winPx = Math.max(8, Math.round(60 * ppm));
    const cut = refineCut(s, Math.min(s.w - 2, Math.max(2, pos)), winPx);
    if (cut - CUT_INSET >= minSegPx) queue.push(cropWindow(s, 0, cut - CUT_INSET));
    else dropped++;
    if (s.w - (cut + CUT_INSET) >= minSegPx) queue.push(cropWindow(s, cut + CUT_INSET, s.w - (cut + CUT_INSET)));
    else dropped++;
  }
  return { clean, splits, dropped };
}

/* ---------- 플랭크 1장 = 결 조각 1개 (연속 패턴 보장) ---------- */
function buildPlank(pool, Lpx, rowH, rng, avoidIdx, lastGain) {
  const usable = pool.map((s, i) => ({ s, i })).filter(o => o.s.w * MAX_SINGLE_STRETCH >= Lpx);
  if (!usable.length) throw new Error('no usable segment');
  let cands = usable.filter(o => o.i !== avoidIdx);
  if (!cands.length) cands = usable;
  const weights = cands.map(o => Math.pow(Math.min(o.s.w, Lpx * 1.5), 1.5));
  let tot = weights.reduce((a, b) => a + b, 0), pick = rng() * tot, idx = 0;
  for (; idx < cands.length - 1 && (pick -= weights[idx]) > 0; idx++);
  const chosen = cands[idx];
  let st = chosen.s;
  if (rng() < 0.5) st = flipX(st);
  if (rng() < 0.5) st = flipY(st);
  let plank, usedLen;
  if (st.w >= Lpx) {
    const off = Math.floor(rng() * (st.w - Lpx + 1));
    plank = cropWindow(st, off, Lpx);
    usedLen = Lpx;
  } else {
    // 랜덤 서브윈도우 + 통스트레치 — 같은 조각에서도 위상·배율이 다른 변주 (연속성 유지)
    const minLen = Math.ceil(Lpx / MAX_SINGLE_STRETCH);
    const lo = Math.max(minLen, Math.round(st.w * 0.82));
    const len = lo >= st.w ? st.w : lo + Math.floor(rng() * (st.w - lo + 1));
    const off = Math.floor(rng() * (st.w - len + 1));
    plank = resampleH(cropWindow(st, off, len), Lpx);
    usedLen = len;
  }
  // 플랭크 전체 밝기 지터 — 직전(왼쪽) 플랭크와 최소 대비 보장(경계 무뎌짐 방지)
  let gain = 0.97 + rng() * 0.06;
  if (lastGain != null) {
    for (let t = 0; t < 6 && Math.abs(gain - lastGain) < 0.018; t++) gain = 0.97 + rng() * 0.06;
    if (Math.abs(gain - lastGain) < 0.018) gain = lastGain >= 1.0 ? lastGain - 0.022 : lastGain + 0.022;
  }
  const out = { w: plank.w, h: plank.h, data: new Uint8ClampedArray(plank.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] *= gain; out.data[i + 1] *= gain; out.data[i + 2] *= gain;
  }
  return { plank: out, first: chosen.i, stretch: Lpx / usedLen, gain };
}

/* ---------- 출력 플랭크 균일성 검사 (최종 백스톱) ---------- */
function plankLeakScore(plank, ppm) {
  const winPx = Math.max(8, Math.round(60 * ppm));
  const n = Math.floor(plank.w / winPx);
  if (n < 3) return 0;
  const means = [];
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let x = i * winPx; x < (i + 1) * winPx; x += 2)
      for (let y = 0; y < plank.h; y += 3) { s += luma(plank.data, (y * plank.w + x) * 4); c++; }
    means.push(s / c);
  }
  let worst = 0;
  for (let i = 0; i + 1 < n; i++) worst = Math.max(worst, Math.abs(means[i + 1] - means[i]));
  return worst;
}

/* ---------- 타일 조립 ---------- */
function generateTile(item, img, opts = {}) {
  const rng = mulberry32(opts.seed ?? 20260712);
  let ppm = img.w / item.size_mm.w;
  let scaleFixed = false;
  const grid = detectRowGrid(img);
  let rowsSrc = [];
  if (grid) {
    const expected = item.spec.w * ppm;
    if (Math.abs(grid.pitch - expected) / expected > 0.15) {
      ppm = grid.pitch / item.spec.w;              // 줄눈주기 하모닉 오류 등 스케일 자동 교정
      scaleFixed = true;
    }
    for (let i = 0; i + 1 < grid.cuts.length; i++) {
      const a = grid.cuts[i] + 2, b = grid.cuts[i + 1] - 1;
      if (b - a >= grid.pitch * 0.7) rowsSrc.push([a, b]);
    }
  }
  const rowH = Math.round(item.spec.w * ppm);
  const Lpx = Math.round(item.spec.l * ppm);
  if (rowH < 4 || Lpx < 20) throw new Error('source too small for spec');
  if (!rowsSrc.length) {
    const nRowsSrc = Math.max(1, Math.round(img.h / (item.spec.w * ppm)));
    for (let r = 0; r < nRowsSrc; r++) {
      rowsSrc.push([Math.round(r * img.h / nRowsSrc), Math.round((r + 1) * img.h / nRowsSrc)]);
    }
  }
  const minSeg = Math.max(110, Math.ceil(Lpx / MAX_SINGLE_STRETCH));
  const { segs: rawSegs, jointRatio } = extractSegments(img, rowsSrc, rowH, minSeg, Lpx, ppm);
  const { clean: segs, splits, dropped } = ppm < 1.0
    ? cleanSegments(rawSegs, ppm, minSeg)
    : { clean: rawSegs, splits: 0, dropped: 0 };
  if (!segs.length) throw new Error(`no clean segments (raw=${rawSegs.length}, splits=${splits})`);
  if (!segs.some(s => s.w * MAX_SINGLE_STRETCH >= Lpx)) throw new Error('no usable segment (all too short)');

  // 타일 크기: 짧은 플랭크 3열×10행 / 긴 플랭크(>1200mm) 2열×8행, 픽셀 예산 초과 시 축소
  let PLANKS_X = opts.planksX ?? (item.spec.l > 1200 ? 2 : 3);
  let R = opts.rows ?? (item.spec.l > 1200 ? 8 : 10);
  while (PLANKS_X > 2 && Lpx * PLANKS_X * rowH * R > 30e6) PLANKS_X--;
  while (R > 6 && Lpx * PLANKS_X * rowH * R > 30e6) R--;
  const W = Lpx * PLANKS_X, H = rowH * R;
  const tile = mkImg(W, H);

  const offsets = [];
  let o = rng() * Lpx;
  for (let r = 0; r < R; r++) {
    if (r > 0) o = (o + Lpx * (0.25 + 0.5 * rng())) % Lpx;
    if (r > 1) {
      let d = Math.abs(o - offsets[r - 2]); d = Math.min(d, Lpx - d);
      if (d < 0.08 * Lpx) o = (o + 0.12 * Lpx) % Lpx;
    }
    offsets.push(o);
  }

  let lastFirst = null, lastGain = null;
  const stretches = [];
  let rejected = 0;
  const LEAK_THR = 5.0, TRIES = 10;
  for (let r = 0; r < R; r++) {
    const y0 = r * rowH;
    for (let c = 0; c < PLANKS_X; c++) {
      let best = null;
      for (let t = 0; t < TRIES; t++) {
        const cand = buildPlank(segs, Lpx, rowH, rng, lastFirst, lastGain);
        cand.leak = plankLeakScore(cand.plank, ppm);
        if (!best || cand.leak < best.leak) best = cand;
        if (cand.leak <= LEAK_THR) break;
        rejected++;
      }
      const { plank, first, stretch, gain } = best;
      lastFirst = first; lastGain = gain; stretches.push(stretch);
      const cx = Math.round(offsets[r]) + c * Lpx;
      for (let y = 0; y < rowH; y++) {
        for (let x = 0; x < Lpx; x++) {
          const dx = (cx + x) % W;
          const o2 = ((y0 + y) * W + dx) * 4, si = (y * Lpx + x) * 4;
          tile.data[o2] = plank.data[si]; tile.data[o2 + 1] = plank.data[si + 1]; tile.data[o2 + 2] = plank.data[si + 2];
        }
      }
    }
  }

  // 조인트 렌더 — 실측 두께(~1.2mm), 1px일 땐 대비 강화(축소·샘플링에도 살아남게)
  const jw = Math.max(1, Math.round(1.2 * ppm));
  let dark = Math.min(0.9, Math.max(0.72, jointRatio));
  if (jw === 1) dark = Math.min(dark, 0.8);
  const lite = ppm >= 1.5 ? 1.04 : 1.0;
  const mulCol = (x, y0j, y1j, f) => {
    const xx = ((x % W) + W) % W;
    for (let y = y0j; y < y1j; y++) {
      const i = (y * W + xx) * 4;
      tile.data[i] *= f; tile.data[i + 1] *= f; tile.data[i + 2] *= f;
    }
  };
  for (let r = 0; r < R; r++) {
    const y0 = r * rowH, y1 = y0 + rowH;
    for (let c = 0; c < PLANKS_X; c++) {
      const j = Math.round(offsets[r]) + c * Lpx;
      for (let k = 0; k < jw; k++) mulCol(j - Math.floor(jw / 2) + k, y0, y1, k === Math.floor(jw / 2) ? dark * 0.96 : dark);
      if (lite > 1) mulCol(j + Math.ceil(jw / 2), y0, y1, lite);
    }
  }
  const mulRow = (y, f) => {
    const yy = ((y % H) + H) % H;
    for (let x = 0; x < W; x++) {
      const i = (yy * W + x) * 4;
      tile.data[i] *= f; tile.data[i + 1] *= f; tile.data[i + 2] *= f;
    }
  };
  for (let r = 0; r < R; r++) {
    const y = r * rowH;
    for (let k = 0; k < jw; k++) mulRow(y - Math.floor(jw / 2) + k, k === Math.floor(jw / 2) ? dark * 0.96 : dark);
    if (lite > 1) mulRow(y + Math.ceil(jw / 2), lite);
  }

  const maxStretch = Math.max(...stretches), avgStretch = stretches.reduce((a, b) => a + b, 0) / stretches.length;
  // 출력 다운스케일: SketchUp 실사용 상한(ppm cap·최장변 cap) — 실측 mm는 불변
  const mmW = W / ppm, mmH = H / ppm;
  const outPpm = Math.min(ppm, OUT_PPM_CAP, OUT_MAX_PX / mmW, OUT_MAX_PX / mmH);
  let outTile = tile, outPpmFinal = ppm;
  if (outPpm < ppm * 0.98) {
    outTile = downscale(tile, Math.max(2, Math.round(mmW * outPpm)), Math.max(2, Math.round(mmH * outPpm)));
    outPpmFinal = outTile.w / mmW;
  }
  return {
    tile: outTile, ppm, outPpm: outPpmFinal, scaleFixed, rejected, splits, dropped,
    mm: { w: mmW, h: mmH },
    segCount: segs.length, maxStretch, avgStretch,
    planksX: PLANKS_X, rows: R,
  };
}

// box-average 다운스케일 (조인트 1px 라인 보존을 위한 커버리지 샘플링)
function downscale(img, tw, th) {
  const out = mkImg(tw, th);
  const sx = img.w / tw, sy = img.h / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(img.h, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(img.w, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.w + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
      const o = (y * tw + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n;
    }
  }
  return out;
}

/* ---------- 메인 (배치) ---------- */
function seedFromId(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dry = args.includes('--dry');
  const codesArg = (args.find(a => a.startsWith('--codes')) || '').split('=')[1];
  const only = codesArg ? new Set(codesArg.split(',').map(s => s.trim())) : null;

  const lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'));
  const items = lib.woods || [];
  let done = 0, skipped = 0, unsupported = 0, lowres = 0, fixed = 0;
  const t00 = Date.now();
  for (const item of items) {
    if (only && !only.has(item.mat_code) && !only.has(item.id)) continue;
    if (!force && item.plank && item.plank.file && fs.existsSync(path.join(WOOD_DIR, item.plank.file))) { skipped++; continue; }
    if (!item.file || !item.size_mm || !item.spec || !(item.spec.w > 0 && item.spec.l > 0)) {
      item.plank_status = 'unsupported: 규격/이미지 정보 없음';
      delete item.plank; unsupported++; continue;
    }
    const src = path.join(WOOD_DIR, item.file);
    if (!fs.existsSync(src)) { item.plank_status = 'unsupported: 원본 없음'; delete item.plank; unsupported++; continue; }
    try {
      const img = loadJpg(src);
      const r = generateTile(item, img, { seed: seedFromId(item.id) });
      const file = item.id + '.plank.jpg';
      if (!dry) saveJpg(r.tile, path.join(WOOD_DIR, file), 88);
      item.plank = {
        file,
        image_url: '/data/textures/wood/' + file,
        size_mm: { w: Math.round(r.mm.w * 10) / 10, h: Math.round(r.mm.h * 10) / 10 },
        px: { w: r.tile.w, h: r.tile.h },
        ppm: Math.round(r.ppm * 1000) / 1000,
        quality: r.ppm < LOWRES_PPM ? 'low' : 'good',
        scale_fixed: r.scaleFixed,
        segs: r.segCount,
        layout: `${r.planksX}x${r.rows}`,
        generated_at: new Date().toISOString(),
      };
      delete item.plank_status;
      if (item.plank.quality === 'low') lowres++;
      if (r.scaleFixed) fixed++;
      done++;
      console.log(`✓ ${item.mat_code} ${item.brand} ${item.name} — ${r.tile.w}x${r.tile.h}px ${Math.round(r.mm.w)}x${Math.round(r.mm.h)}mm segs=${r.segCount} stretch~${r.avgStretch.toFixed(2)} ${r.scaleFixed ? 'ppm교정 ' : ''}${item.plank.quality === 'low' ? '저해상도' : ''}`);
    } catch (e) {
      item.plank_status = 'unsupported: ' + e.message;
      delete item.plank;
      unsupported++;
      console.log(`✗ ${item.mat_code} ${item.brand} ${item.name} — ${e.message}`);
    }
  }
  if (!dry) fs.writeFileSync(LIB_FILE, JSON.stringify(lib, null, 2));
  console.log(`\n완료: 생성 ${done} · 스킵 ${skipped} · 불가 ${unsupported} (저해상도 ${lowres} · 스케일교정 ${fixed}) — ${((Date.now() - t00) / 1000).toFixed(1)}s`);
}

main();
