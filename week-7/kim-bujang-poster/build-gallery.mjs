/**
 * stills-manifest.json → index.html (컨택트시트 생성기)
 * 매니페스트를 HTML에 인라인해서 file:// 로 바로 열리게 만든다 (fetch CORS 회피).
 * 사용법: node build-gallery.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'stills-manifest.json'), 'utf8'));

// SBS 외 출처에서 수동으로 보강한 이미지(나무위키 고해상도 포스터 등).
// collect-stills.mjs 는 stills-manifest.json 을 통째로 덮어쓰므로 따로 둬야 살아남는다.
let extra = [];
try {
  extra = JSON.parse(await fs.readFile(path.join(ROOT, 'stills-extra.json'), 'utf8'));
} catch {
  /* 없으면 무시 */
}
manifest.push(...extra);

// 캡션에서 인물 추출 (캡션 예: "김부장 소지섭 최대훈 윤경호")
const CAST = [
  '소지섭', '최대훈', '윤경호', '주상욱', '손나은', '서수민', '서지혜', '원현준',
  '김성규', '유지안', '옥택연', '이재응', '박진우', '조복래', '이동하', '김지영', '최범호',
];
const ROLE = {
  소지섭: '김부장', 최대훈: '성한수', 윤경호: '박진철', 주상욱: '주강찬', 손나은: '정상아',
  서수민: '김민지', 서지혜: '림유진', 원현준: '강국철', 김성규: '박강성', 유지안: '주혜리',
  옥택연: '박영광', 최범호: '장 소장',
};

const items = manifest.map((m) => ({
  ...m,
  cast: CAST.filter((c) => (m.caption || '').includes(c)),
  isPoster: /포스터/.test(m.title),
}));

const castCounts = {};
items.forEach((i) => i.cast.forEach((c) => (castCounts[c] = (castCounts[c] || 0) + 1)));
const castList = Object.entries(castCounts).sort((a, b) => b[1] - a[1]);

const groups = [...new Map(items.map((i) => [i.board_no, { no: i.board_no, title: i.title, date: i.date }])).values()]
  .sort((a, b) => (a.date < b.date ? 1 : -1));

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>김부장 스틸컷 컨택트시트 — 포스터 작업용</title>
<style>
  :root{
    --bg:#0d0d0f; --panel:#16161a; --line:#2a2a31; --txt:#e9e9ee; --dim:#8b8b96;
    --accent:#e8531f;               /* 메인 포스터의 오렌지 */
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
  header{position:sticky;top:0;z-index:20;background:rgba(13,13,15,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 20px}
  h1{font-size:17px;letter-spacing:-.02em;display:flex;align-items:center;gap:10px}
  h1 b{color:var(--accent);font-weight:800}
  .sub{color:var(--dim);font-size:12px;margin-top:3px}
  .filters{display:flex;flex-wrap:wrap;gap:6px;margin-top:11px}
  button.f{background:var(--panel);color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:5px 11px;font-size:12px;cursor:pointer;transition:.12s}
  button.f:hover{color:var(--txt);border-color:#3d3d47}
  button.f.on{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600}
  button.f .n{opacity:.55;margin-left:4px;font-size:11px}
  /* 세로(2:3)·가로(3:2)가 섞여 있어 grid로는 행마다 빈틈이 생김 → 컬럼 메이슨리 */
  .grid{columns:5 230px;column-gap:11px;padding:16px 20px 60px}
  @media(max-width:900px){.grid{columns:2 160px}}
  figure{background:var(--panel);border:1px solid var(--line);border-radius:9px;overflow:hidden;cursor:zoom-in;transition:.12s;
         break-inside:avoid;margin:0 0 11px}
  figure:hover{border-color:var(--accent);transform:translateY(-2px)}
  figure img{width:100%;height:auto;display:block;background:#000}
  figcaption{padding:7px 9px;font-size:11px;line-height:1.45}
  .cap{color:var(--txt);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta{color:var(--dim);margin-top:2px;display:flex;justify-content:space-between;gap:6px}
  .badge{position:absolute;top:8px;left:8px;background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.04em}
  .wrap{position:relative}
  /* 라이트박스 */
  #lb{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.94);display:none;align-items:center;justify-content:center;flex-direction:column;padding:22px;cursor:zoom-out}
  #lb.on{display:flex}
  #lb img{max-width:100%;max-height:calc(100vh - 108px);object-fit:contain}
  #lbi{color:var(--dim);font-size:12.5px;margin-top:12px;text-align:center;line-height:1.7}
  #lbi b{color:var(--txt)} #lbi a{color:var(--accent)}
  .nav{position:fixed;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.09);border:0;color:#fff;font-size:26px;width:46px;height:66px;cursor:pointer;border-radius:7px}
  .nav:hover{background:var(--accent)} #prev{left:14px} #next{right:14px}
  .empty{padding:60px 20px;text-align:center;color:var(--dim)}
  .note{background:#1e1509;border:1px solid #6b4a12;color:#e0b978;padding:9px 13px;border-radius:7px;font-size:12px;margin-top:11px;line-height:1.6}
</style>
</head>
<body>
<header>
  <h1><b>김부장</b> 스틸컷 컨택트시트 <span style="color:var(--dim);font-weight:400;font-size:13px">Agent Kim Reactivated · SBS 2026</span></h1>
  <div class="sub">총 <b id="cnt">${items.length}</b>장 · SBS 공식 포토갤러리 · 클릭하면 원본 크기 · ←/→ 로 이동</div>
  <div class="filters" id="fCast"></div>
  <div class="note">⚠️ Copyright © SBS &amp; SBSi. SBS가 <b>무단 전재·재배포 및 AI학습 이용 금지</b>를 명시한 자료입니다. 개인 참고·습작 용도로만 사용하세요.</div>
</header>
<div class="grid" id="grid"></div>
<div id="lb">
  <img id="lbimg" alt="">
  <div id="lbi"></div>
</div>
<button class="nav" id="prev">‹</button>
<button class="nav" id="next">›</button>

<script>
const ITEMS = ${JSON.stringify(items)};
const ROLE = ${JSON.stringify(ROLE)};
const CASTLIST = ${JSON.stringify(castList)};
let filter = null, view = ITEMS, cur = 0;

const fc = document.getElementById('fCast');
const mk = (label, val, n) => {
  const b = document.createElement('button');
  b.className = 'f' + (val === filter ? ' on' : '');
  b.innerHTML = label + (n != null ? ' <span class="n">' + n + '</span>' : '');
  b.onclick = () => { filter = (filter === val ? null : val); render(); };
  return b;
};
function chips(){
  fc.innerHTML = '';
  fc.append(mk('전체', null, ITEMS.length));
  fc.append(mk('🎯 포스터', '__poster', ITEMS.filter(i => i.isPoster).length));
  fc.append(mk('📐 세로형', '__tall', ITEMS.filter(i => i.height > i.width).length));
  CASTLIST.forEach(([c, n]) => fc.append(mk(c + (ROLE[c] ? ' <span class="n">' + ROLE[c] + '</span>' : ''), c, n)));
}
function render(){
  chips();
  view = ITEMS.filter(i =>
    !filter ? true :
    filter === '__poster' ? i.isPoster :
    filter === '__tall' ? i.height > i.width :
    i.cast.includes(filter));
  document.getElementById('cnt').textContent = view.length;
  const g = document.getElementById('grid');
  g.innerHTML = view.length ? '' : '<div class="empty">해당 조건의 스틸이 없습니다.</div>';
  view.forEach((it, idx) => {
    const f = document.createElement('figure');
    if (it.height > it.width) f.className = 'tall';
    f.innerHTML =
      '<div class="wrap">' + (it.isPoster ? '<span class="badge">POSTER</span>' : '') +
      '<img loading="lazy" src="stills/' + encodeURIComponent(it.file) + '" alt="' + it.caption + '"></div>' +
      '<figcaption><div class="cap">' + (it.caption || it.title) + '</div>' +
      '<div class="meta"><span>' + it.date + '</span><span>' + it.width + '×' + it.height + '</span></div></figcaption>';
    f.onclick = () => open(idx);
    g.append(f);
  });
}
const lb = document.getElementById('lb');
function open(i){
  cur = i; const it = view[i];
  document.getElementById('lbimg').src = 'stills/' + encodeURIComponent(it.file);
  document.getElementById('lbi').innerHTML =
    '<b>' + (it.caption || '') + '</b> — ' + it.title + '<br>' +
    it.date + ' · ' + it.width + '×' + it.height + ' · ' + (it.bytes/1024/1024).toFixed(1) + 'MB · ' +
    (i+1) + '/' + view.length + '<br>' +
    '<a href="' + it.source_page + '" target="_blank">SBS 원문</a> · <span style="opacity:.6">' + it.file + '</span>';
  lb.classList.add('on');
}
lb.onclick = e => { if (e.target.id !== 'lbimg') lb.classList.remove('on'); };
const step = d => { if (!lb.classList.contains('on')) return; open((cur + d + view.length) % view.length); };
document.getElementById('prev').onclick = e => { e.stopPropagation(); step(-1); };
document.getElementById('next').onclick = e => { e.stopPropagation(); step(1); };
document.onkeydown = e => {
  if (e.key === 'Escape') lb.classList.remove('on');
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
};
render();
</script>
</body>
</html>`;

await fs.writeFile(path.join(ROOT, 'index.html'), html);
console.log(`✅ index.html 생성 — 스틸 ${items.length}장, 인물 필터 ${castList.length}종`);
console.log(`   인물: ${castList.map(([c, n]) => c + '(' + n + ')').join(' ')}`);
