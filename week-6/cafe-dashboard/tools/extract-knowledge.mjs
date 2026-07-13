// ========================================
// 📚 지식 추출기 (tools/extract-knowledge.mjs)
// week-6/review · week-6/influencer 폴더의 pptx/xlsx 를 텍스트로 추출해
// knowledge/*.md 스냅샷으로 저장한다. → 채팅비서(/api/chat)의 지식 베이스.
//
// pptx = zip(ppt/slides/slideN.xml, 텍스트는 <a:t>)
// xlsx = zip(xl/worksheets/sheetN.xml + xl/sharedStrings.xml)
// 재실행하면 스냅샷 갱신: node tools/extract-knowledge.mjs
// ========================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');            // cafe-dashboard/
const AFM = join(ROOT, '..', '..');            // AFM/
const OUT = join(ROOT, 'knowledge');
mkdirSync(OUT, { recursive: true });

const dec = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

// ---------- pptx: 슬라이드별 <a:p>(문단) → 줄, <a:t>(런) 이어붙임 ----------
function extractPptx(file) {
  const zip = new AdmZip(file);
  const slides = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => Number(a.entryName.match(/\d+/)[0]) - Number(b.entryName.match(/\d+/)[0]));
  const out = [];
  for (const s of slides) {
    const xml = s.getData().toString('utf8');
    const n = Number(s.entryName.match(/\d+/)[0]);
    const lines = [];
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []) {
      const runs = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => dec(m[1]));
      const line = runs.join('').trim();
      if (line) lines.push(line);
    }
    out.push(`### 슬라이드 ${n}\n${lines.map((l) => `- ${l}`).join('\n') || '- (텍스트 없음)'}`);
  }
  return out.join('\n\n');
}

// ---------- xlsx: 시트별 셀 → 마크다운 표 ----------
function colIndex(ref) { // 'BC12' → 열 번호(0-base)
  let c = 0;
  for (const ch of ref.replace(/\d+/g, '')) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

function extractXlsx(file, maxRows = 120) {
  const zip = new AdmZip(file);
  const read = (name) => zip.getEntry(name)?.getData().toString('utf8') || '';

  // 공유 문자열 (<si> 안에 <t>가 여러 개일 수 있음 — rich text)
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => dec(t[1])).join(''));

  // 시트 이름 (workbook.xml 순서 = sheet1..N 순서)
  const names = [...read('xl/workbook.xml').matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => dec(m[1]));

  const sheets = zip.getEntries()
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName))
    .sort((a, b) => Number(a.entryName.match(/\d+/)[0]) - Number(b.entryName.match(/\d+/)[0]));

  const out = [];
  sheets.forEach((s, si) => {
    const xml = s.getData().toString('utf8');
    const rows = [];
    for (const rowXml of xml.match(/<row [\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const m of rowXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
        const [, ref, attrs, inner] = m;
        let val = '';
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (/t="s"/.test(attrs)) val = shared[Number(v)] ?? '';
        else if (/t="inlineStr"/.test(attrs)) val = dec(inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || '');
        else val = v != null ? dec(v) : '';
        cells[colIndex(ref)] = String(val).trim();
      }
      if (cells.some((c) => c)) rows.push(cells);
    }
    const width = Math.max(...rows.map((r) => r.length), 1);
    const norm = rows.slice(0, maxRows).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
    const table = norm.length
      ? [`| ${norm[0].join(' | ')} |`, `|${' --- |'.repeat(width)}`,
         ...norm.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n')
      : '(빈 시트)';
    out.push(`### 시트: ${names[si] || `Sheet${si + 1}`}${rows.length > maxRows ? ` (상위 ${maxRows}행만)` : ''}\n${table}`);
  });
  return out.join('\n\n');
}

// ---------- 대상 파일 → knowledge/*.md ----------
const JOBS = [
  {
    src: join(AFM, 'week-6/review/competitors.pptx'), type: 'pptx', out: 'review-competitors-pptx.md',
    title: '경쟁 카페 분석 보고서 (competitors.pptx)',
    provenance: '⚠️ week-6/review 조사 미션 산출물 — "하버 카페"(강의 실습 데이터) 기준 분석. 카페 안도의 실제 경쟁사(메종 드 성수·컴포즈·로우키)와 다르므로 시장 인사이트·분석 방법론 참고용.',
  },
  {
    src: join(AFM, 'week-6/review/카페_VoC_분석리포트.xlsx'), type: 'xlsx', out: 'review-voc-xlsx.md',
    title: '리뷰 VoC 분석 리포트 (카페_VoC_분석리포트.xlsx)',
    provenance: '⚠️ week-6/review 조사 미션 산출물 — "하버 카페" 리뷰 실습 데이터 기반 VoC(불만 테마) 분석. 리뷰 분석 프레임(테마 분류·우선순위 도출) 참고용.',
  },
  {
    src: join(AFM, 'week-6/review/cafe_reviews.csv.xlsx'), type: 'xlsx', out: 'review-raw-reviews-xlsx.md',
    title: '리뷰 원본 데이터 (cafe_reviews.csv.xlsx)',
    provenance: '⚠️ 하버 카페 실습 리뷰 원본(2026-05월, 네이버/카카오맵/인스타). 카페 안도의 실제 리뷰는 운영 DB cafe_reviews 테이블에 있다.',
  },
  {
    src: join(AFM, 'week-6/influencer/influencers.pptx'), type: 'pptx', out: 'influencer-report-pptx.md',
    title: '카페 안도 × 인스타 인플루언서 발굴 보고서 (influencers.pptx)',
    provenance: '✅ 카페 안도 실제 보고서 (2026-07-13 실측 수집) — Top5 협업 후보 + DM 초안. 홍보 질문에 1순위로 인용할 것.',
  },
];

for (const j of JOBS) {
  if (!existsSync(j.src)) { console.log(`⏭️  없음: ${j.src}`); continue; }
  const body = j.type === 'pptx' ? extractPptx(j.src) : extractXlsx(j.src);
  const md = `# ${j.title}\n\n> 출처: \`${j.src.replace(AFM + '/', '')}\` · 추출: tools/extract-knowledge.mjs\n> ${j.provenance}\n\n${body}\n`;
  writeFileSync(join(OUT, j.out), md, 'utf8');
  console.log(`✅ ${j.out}  (${(md.length / 1024).toFixed(1)}KB) ← ${basename(j.src)}`);
}
console.log('\n완료. 채팅비서는 knowledge/*.md 를 시스템 프롬프트에 로드합니다.');
