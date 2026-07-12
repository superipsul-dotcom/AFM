// 타일 라이브러리 임포터 — data/tile-source.json(수집 원본) → data/tile-library.json(항목 메타)
// 텍스처는 만들지 않는다(서버가 요청 시 생성·캐시). 실측 커버리지는 격자 수학으로 미리 계산.
// 항목 = 컬러웨이 × 규격. 멱등(id 기준 upsert, mat_code 보존).
// 사용: node tools/import-tile-library.js
const fs = require('fs');
const path = require('path');
const { gridFor } = require('./tile-texture-lib');

const ROOT = path.join(__dirname, '..');
const SRC_FILE = path.join(ROOT, 'data', 'tile-source.json');
const LIB_FILE = path.join(ROOT, 'data', 'tile-library.json');
const SRC_DIR = path.join(ROOT, 'data', 'textures', 'tile', 'src');

function normKind(material, concepts) {
  const m = String(material || '').toUpperCase();
  if (/PORCELAIN|자기/.test(m)) return '포세린';
  if (/TERRACOTTA|COTTO/.test(m)) return '테라코타';
  if (/CERAMIC|도기/.test(m)) return '세라믹';
  if (/GLASS/.test(m)) return '유리 모자이크';
  if (/MOSAIC/.test(m)) return '모자이크';
  if (/MARBLE|STONE|천연/.test(m)) return '천연석';
  if ((concepts || []).includes('MOSAIC')) return '모자이크';
  // MATT/POLISHED/3D 등은 마감 표기일 뿐 재질이 아님 → 수입타일 기본 재질인 포세린으로
  return '포세린';
}
const PATTERN_PRIORITY = ['MARBLE', 'STONE', 'WOOD', 'TERRAZZO', 'CONCRETE', 'BRICK', 'PATTERN', 'COLOR', 'FABRIC', '3D TILE', 'MOSAIC', 'HANDMADE', 'DESIGNER', 'BIG SLAB', 'ETC'];
function primaryConcept(concepts) {
  for (const p of PATTERN_PRIORITY) if ((concepts || []).includes(p)) return p;
  return (concepts || [])[0] || 'ETC';
}

function main() {
  const srcCat = JSON.parse(fs.readFileSync(SRC_FILE, 'utf8'));
  let lib = { tiles: [] };
  if (fs.existsSync(LIB_FILE)) { try { lib = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch (_) {} }
  if (!Array.isArray(lib.tiles)) lib.tiles = [];
  const byId = new Map(lib.tiles.map(t => [t.id, t]));

  let made = 0, updated = 0, noSize = 0, noFile = 0;
  for (const p of srcCat.products) {
    for (const cw of p.colorways) {
      if (!fs.existsSync(path.join(SRC_DIR, cw.file))) { noFile++; continue; }
      if (!cw.sizes || !cw.sizes.length) { noSize++; continue; }
      for (const [a, b] of cw.sizes) {
        const id = `yh-${p.idx}-${cw.k}-${a}x${b}`;
        const g = gridFor(a, b);
        const existing = byId.get(id);
        const rec = {
          id,
          vendor: '윤현상재',
          brand: p.brand || '윤현상재',
          line: primaryConcept(p.concepts),
          concepts: p.concepts || [],
          name: cw.name || p.title,
          product: p.title,
          code: '',
          kind: normKind(p.material, p.concepts),
          spec: { w: a, l: b },                        // 타일 1장 실측
          size_mm: { w: g.mmW, h: g.mmH },             // 텍스처 커버리지(격자) 실측
          grid: `${g.cols}x${g.rows}`,
          grout_mm: 2,
          avg: existing ? existing.avg : { r: 205, g: 200, b: 195 }, // 생성 시 실측값으로 갱신
          src_file: cw.file,                            // 원판면(생성 소스)
          file: `${id}.jpg`,                            // 생성 캐시 파일명
          image_url: `/api/tile/${id}/texture`,         // on-demand 생성 엔드포인트
          thumb_url: '/data/textures/tile/src/' + cw.file, // 카드 썸네일 = 원판면
          source_url: p.url,
          country: p.country || '',
          application: p.application || '',
          note: `윤현상재 수입타일 · ${p.brand || ''}${p.country ? ' · ' + p.country : ''} · ${g.cols}×${g.rows} 격자+줄눈 2mm`,
          created_at: existing ? existing.created_at : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (existing) { rec.mat_code = existing.mat_code; Object.assign(existing, rec); updated++; }
        else { lib.tiles.push(rec); byId.set(id, rec); made++; }
      }
    }
  }
  fs.writeFileSync(LIB_FILE, JSON.stringify(lib, null, 2));
  console.log(`완료: 신규 ${made} · 갱신 ${updated} · 규격없음(스킵) ${noSize} · 원판면없음 ${noFile} → tiles ${lib.tiles.length}건`);
}
main();
