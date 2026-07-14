/**
 * 김부장 (SBS, 2026) 공식 포토갤러리 스틸컷 수집기
 * ─────────────────────────────────────────────────────────────
 * 출처: SBS 공식 프로그램 홈페이지 > 포토갤러리 (공개 배포된 홍보용 스틸)
 *   페이지  https://programs.sbs.co.kr/drama/mrkim/visualboards/89763
 *
 * ⚠️ 저작권: Copyright © SBS & SBSi. All rights reserved.
 *    SBS는 해당 이미지에 "무단 전재, 재배포 및 AI학습 이용 금지"를 명시함.
 *    → 개인 참고/습작 용도로만 사용할 것. 재배포·상업적 이용 불가.
 *
 * ─── 역공학 메모 (SBS 게시판 JSONP API) ──────────────────────
 * 페이지는 마이크로프론트엔드 SPA라 HTML엔 아무것도 없음. 대신 내부 API를 직접 호출:
 *
 *   목록  GET api.board.sbs.co.kr/bbs/V2.0/basic/board/lists
 *           ?action_type=callback&callback=cb&board_code=mrkim_pt&offset=0&limit=100
 *         → cb({notice:[], best:[], list:[{NO, TITLE, REG_DATE, FILE_CNT...}]})
 *
 *   상세  GET api.board.sbs.co.kr/bbs/V2.0/basic/board/detail/{NO}
 *           ?action_type=callback&callback=cb&board_code=mrkim_pt
 *         → cb({Response_Data_For_Detail:{CONTENT: "<img class=aba_img src=...>"}})
 *
 * GOTCHA: action_type/callback 파라미터를 빼면 200 OK로 `noParam({err_code:405})` 반환.
 *
 * ─── 해상도 규칙 ─────────────────────────────────────────────
 *   photocloud.sbs.co.kr/origin/edit/{SET}/{HASH}-p.jpg  → 1800x1200 원본 (유일하게 200)
 *   접미사 제거(.jpg) / -o / -org / -l 은 전부 403.
 *   ※ image.board.sbs.co.kr 의 `-cr.jpg` 는 573x436 목록 썸네일이므로 쓰지 말 것.
 *
 * 사용법: node collect-stills.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'stills');
const API = 'https://api.board.sbs.co.kr/bbs/V2.0/basic/board';
const BOARD_CODE = 'mrkim_pt';
const PAGE = 'https://programs.sbs.co.kr/drama/mrkim/visualboards/89763';

const H = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Referer: PAGE,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSONP 응답 → 객체 */
async function jsonp(url) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  const m = t.match(/^[^(]*\((.*)\);?\s*$/s);
  if (!m) throw new Error(`JSONP 파싱 실패: ${t.slice(0, 80)}`);
  try {
    return JSON.parse(m[1]);
  } catch {
    return eval('(' + m[1] + ')'); // 비표준 JSON(따옴표 없는 키) 폴백
  }
}

/** HTML 엔티티 디코드 (제목에 &lt;김부장&gt; 형태로 들어옴) */
function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 파일명 안전 슬러그 (한글 유지) */
function slug(s) {
  return decode(s)
    .replace(/[[\]<>:"/\\|?*★♨↗↘♥＂''&]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
}

/** JPEG 바이너리에서 해상도 파싱 */
function jpegSize(b) {
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) {
      return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0 };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  // ── 1) 게시글 목록 (offset 페이지네이션) ──────────────────
  // GOTCHA: limit은 15로 캡됨(200을 줘도 15건만 반환) → offset을 15씩 밀어야 전체 확보
  const posts = [];
  const seenNo = new Set();
  for (let offset = 0; offset < 300; offset += 15) {
    const list = await jsonp(
      `${API}/lists?action_type=callback&callback=cb&board_code=${BOARD_CODE}&offset=${offset}&limit=15`
    );
    const rows = list.list || [];
    if (!rows.length) break;
    let fresh = 0;
    for (const p of rows) {
      if (seenNo.has(p.NO)) continue;
      seenNo.add(p.NO);
      posts.push({
        no: p.NO,
        title: decode((p.TITLE || '').trim()),
        date: (p.REG_DATE || '').slice(0, 10),
        files: p.FILE_CNT || 0,
      });
      fresh++;
    }
    console.log(`  목록 offset=${String(offset).padStart(3)} → ${rows.length}건 (신규 ${fresh})`);
    if (fresh === 0) break;
    await sleep(150);
  }
  console.log(`\n📋 게시글 ${posts.length}건 (이미지 첨부 합계 ${posts.reduce((a, p) => a + p.files, 0)}장 예상)\n`);

  // ── 2) 상세 → photocloud 원본 추출 → 다운로드 ─────────────
  const manifest = [];
  const seen = new Set();
  let i = 0;

  for (const post of posts) {
    i++;
    let detail;
    try {
      detail = await jsonp(
        `${API}/detail/${post.no}?action_type=callback&callback=cb&board_code=${BOARD_CODE}`
      );
    } catch (e) {
      console.log(`[${i}/${posts.length}] ✗ 상세 실패 ${post.no}: ${e.message.slice(0, 50)}`);
      continue;
    }

    const content = detail?.Response_Data_For_Detail?.CONTENT || '';
    // GOTCHA: alt 값에 <김부장> 처럼 꺾쇠가 들어있고 속성 순서도 게시글마다 다름
    //   (class·src·alt / alt·class·src). 그래서 `<img[^>]+src=...>` 류는 alt 안의 '>'에서
    //   끊겨 이미지를 통째로 놓친다. → 따옴표 안의 '>'를 허용하는 토큰 파서를 쓴다.
    const imgs = [...content.matchAll(/<img\s+((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g)]
      .map((m) => {
        const attrs = m[1];
        const src = (attrs.match(/\bsrc\s*=\s*"([^"]*)"/) || [, ''])[1];
        const alt = (attrs.match(/\balt\s*=\s*"([^"]*)"/) || [, ''])[1];
        return { url: src, alt: decode(alt).trim() };
      })
      .filter((i) => /^https:\/\/photocloud\.sbs\.co\.kr\//.test(i.url));

    console.log(`[${i}/${posts.length}] ${post.date} ${post.title.slice(0, 36).padEnd(36)} → ${imgs.length}장`);

    let n = 0;
    for (const img of imgs) {
      if (seen.has(img.url)) continue;
      seen.add(img.url);
      n++;
      const name = `${post.date}_${slug(post.title)}_${String(n).padStart(2, '0')}.jpg`;
      try {
        const r = await fetch(img.url, { headers: H });
        if (!r.ok) { console.log(`      ✗ ${r.status} ${img.url.slice(-40)}`); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        const { w, h } = jpegSize(buf);
        await fs.writeFile(path.join(OUT, name), buf);
        manifest.push({
          file: name,
          title: post.title,
          caption: img.alt,
          date: post.date,
          width: w,
          height: h,
          bytes: buf.length,
          board_no: post.no,
          source_page: `https://programs.sbs.co.kr/drama/mrkim/visualboard/89763?cmd=view&board_no=${post.no}`,
          image_url: img.url,
        });
        console.log(`      ✓ ${w}x${h}  ${(buf.length / 1024).toFixed(0)}KB  ${name}`);
      } catch (e) {
        console.log(`      ✗ ${e.message.slice(0, 50)}`);
      }
      await sleep(200); // 예의상 딜레이
    }
    await sleep(150);
  }

  manifest.sort((a, b) => (a.date < b.date ? 1 : -1));
  await fs.writeFile(path.join(ROOT, 'stills-manifest.json'), JSON.stringify(manifest, null, 2));

  const px = manifest.filter((m) => m.width >= 1500).length;
  console.log(`\n✅ 완료: ${manifest.length}장 → ${OUT}`);
  console.log(`   고해상도(1500px+): ${px}장 / 총 ${(manifest.reduce((a, m) => a + m.bytes, 0) / 1048576).toFixed(1)}MB`);
  console.log(`   매니페스트: stills-manifest.json`);
}

main().catch((e) => {
  console.error('치명적 오류:', e);
  process.exit(1);
});
