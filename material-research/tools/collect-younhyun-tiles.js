// 윤현상재(younhyun.com) 수입타일 카탈로그 수집기
// PRODUCT > Tile 컨셉별 목록 → 상세(idx) → 제품정보 + "Product image" 갤러리(컬러웨이별 원판면+규격)
//  - 원판면 이미지: data/textures/tile/src/yh-{idx}-{k}.jpg (커밋 대상 — 텍스처 생성의 소스)
//  - 카탈로그: data/tile-source.json (제품·컬러웨이·규격 원본 메타)
//  - 연출컷(상단 슬라이더 PNG)·카탈로그 PDF는 수집하지 않음
// 사용: node tools/collect-younhyun-tiles.js [--limit N] [--concepts MARBLE,STONE]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'data', 'textures', 'tile', 'src');
const OUT_FILE = path.join(ROOT, 'data', 'tile-source.json');
const BASE = 'https://www.younhyun.com';
const LIST = BASE + '/html/sub03/sub03_0301.php';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const CONCEPTS = ['BIG SLAB', 'STONE', 'MARBLE', 'WOOD', 'TERRAZZO', 'PATTERN', 'CONCRETE', 'BRICK', 'COLOR', '3D TILE', 'FABRIC', 'MOSAIC', 'HANDMADE', 'DESIGNER', 'ETC'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}
async function fetchBuf(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}
const unesc = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').trim();

// 상세 정보 테이블: 라벨 셀 바로 다음 셀이 값 — <p>/<div> 두 구조 모두 지원
function infoField(html, label) {
  const re = new RegExp(`>\\s*${label}\\s*</(?:p|div)>\\s*<(?:p|div)[^>]*>([^<]*)<`, 'i');
  const m = re.exec(html);
  return m ? unesc(m[1]) : '';
}
// "600 X 1200, 1200X1200" → [[600,1200],[1200,1200]]
function parseSizes(text) {
  const out = [];
  const re = /(\d{2,4})\s*[xX×*]\s*(\d{2,4})/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const a = +m[1], b = +m[2];
    if (a >= 20 && a <= 3600 && b >= 20 && b <= 3600 && !out.some(([x, y]) => x === a && y === b)) out.push([a, b]);
  }
  return out;
}
// "Product image" 갤러리: 컬러웨이별 {face, name, sizes}
function parseGallery(html) {
  const zoneM = /id="product_images_list"[^]*?(?:<\/section>)/.exec(html);
  if (!zoneM) return [];
  const zone = zoneM[0].split('확대이미지')[0]; // 모달(확대) 중복 제외
  const items = [];
  const re = /class="thum[^"]*"\s+style="background:url\('([^']+)'\)[^"]*"[^>]*><\/p>\s*<p[^>]*>([^<]*)<\/p>\s*<p[^>]*>([^<]*)<\/p>/g;
  let m;
  while ((m = re.exec(zone))) {
    items.push({ img: unesc(m[1]), name: unesc(m[2]), sizeText: unesc(m[3]) });
  }
  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = +(args.find(a => a.startsWith('--limit'))?.split('=')[1] || 0);
  const onlyConcepts = args.find(a => a.startsWith('--concepts'))?.split('=')[1]?.split(',');
  fs.mkdirSync(SRC_DIR, { recursive: true });

  // 1) 컨셉별 목록 → idx→concepts 맵
  const idxConcepts = new Map();
  for (const c of (onlyConcepts || CONCEPTS)) {
    let page = 1, seen = new Set();
    while (page <= 40) {
      const html = await fetchText(`${LIST}?concept=${encodeURIComponent(c)}&page=${page}`).catch(() => '');
      const found = [...html.matchAll(/product_type=view&idx=(\d+)/g)].map(m => m[1]);
      const fresh = found.filter(i => !seen.has(i));
      if (!fresh.length) break;
      fresh.forEach(i => seen.add(i));
      page++;
      await sleep(120);
    }
    for (const i of seen) {
      if (!idxConcepts.has(i)) idxConcepts.set(i, []);
      idxConcepts.get(i).push(c);
    }
    console.log(`${c}: ${seen.size}`);
  }
  let idxs = [...idxConcepts.keys()].sort((a, b) => +a - +b);
  if (limit) idxs = idxs.slice(0, limit);
  console.log(`고유 제품 ${idxs.length}개 상세 수집...`);

  // 2) 상세 수집
  const products = [];
  let done = 0, noFace = 0, imgs = 0;
  for (const idx of idxs) {
    try {
      const html = await fetchText(`${LIST}?product_type=view&idx=${idx}`);
      const title = unesc((/<h3[^>]*>([^<]+)<\/h3>/.exec(html) || [])[1] || '');
      const fields = {
        color: infoField(html, 'Color'),
        size: infoField(html, 'Size'),
        material: infoField(html, 'Material'),
        country: infoField(html, 'Country'),
        application: infoField(html, 'Application'),
        brand: infoField(html, 'Brand'),
      };
      const gallery = parseGallery(html);
      if (!gallery.length) { noFace++; console.log(`  idx=${idx} ${title}: 원판면 없음 — 건너뜀`); continue; }
      const colorways = [];
      for (let k = 0; k < gallery.length; k++) {
        const g = gallery[k];
        const url = g.img.startsWith('http') ? g.img : BASE + g.img;
        const ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
        const file = `yh-${idx}-${k}${ext === '.png' ? '.png' : '.jpg'}`;
        const fp = path.join(SRC_DIR, file);
        if (!fs.existsSync(fp)) {
          try {
            const buf = await fetchBuf(url);
            if (buf.length < 3000) throw new Error('too small');
            fs.writeFileSync(fp, buf);
            imgs++;
            await sleep(100);
          } catch (e) { console.log(`  idx=${idx}[${k}] 이미지 실패: ${e.message}`); continue; }
        }
        const sizes = parseSizes(g.sizeText).length ? parseSizes(g.sizeText) : parseSizes(fields.size);
        colorways.push({ k, name: g.name || title, file, sizes, size_text: g.sizeText });
      }
      if (!colorways.length) { noFace++; continue; }
      products.push({
        idx: +idx, title, ...fields,
        concepts: idxConcepts.get(idx) || [],
        colorways,
        url: `${LIST}?product_type=view&idx=${idx}`,
        collected_at: new Date().toISOString(),
      });
      done++;
      if (done % 25 === 0) console.log(`  ...${done}/${idxs.length}`);
      await sleep(120);
    } catch (e) {
      console.log(`  idx=${idx} 실패: ${e.message}`);
    }
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify({ vendor: '윤현상재', source: LIST, products }, null, 2));
  const cw = products.reduce((a, p) => a + p.colorways.length, 0);
  const sz = products.reduce((a, p) => a + p.colorways.reduce((x, c) => x + c.sizes.length, 0), 0);
  console.log(`\n완료: 제품 ${products.length} · 컬러웨이 ${cw} · 사이즈변형 ${sz} · 이미지 ${imgs}장 다운로드 · 원판면없음 ${noFace} → ${OUT_FILE}`);
}
main();
