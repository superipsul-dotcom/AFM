// server.js — 카페 안도 브랜드 허브 (week-5/my-cafe)
// CONTRACT.md 의 "서버" 파트 구현. PORT 3013.
//
//   정적 서빙 : 프로젝트 폴더 전체 (GET / -> index.html, /logo.png 등)
//   GET  /api/health -> 200 { ok:true, service:"my-cafe" }
//   GET  /api/cafe   -> 200 { markdown:<my_cafe.md 전체>, updatedAt:<mtime ISO> }
//                       파일 없으면 200 { markdown:"", updatedAt:null }
//   PUT  /api/cafe   -> body { markdown } 저장. 문자열 아님/trim 후 빈값이면
//                       400 { error:"markdown 내용이 비어 있습니다" } (파일 날림 방지)
//                       성공 시 200 { ok:true, updatedAt:<ISO> }
//   그 외 /api/*      -> 404 JSON { error:"not found" }
//
// ⚠️ my_cafe.md 가 곧 DB — 서버는 런타임에 읽고 쓰기만 한다(내용을 덮어쓰는 시드 금지).
// ⚠️ index.html 은 프론트 에이전트 소유 — 여기서 만들거나 수정하지 않는다.
//    (아직 없어도 서버는 정상 기동하고 API 는 동작해야 한다.)

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3013;

// 실행 위치와 무관하게 항상 이 파일 옆의 경로로 해석 (cwd 의존 금지)
const CAFE_FILE = path.join(__dirname, 'my_cafe.md');
const INDEX_FILE = path.join(__dirname, 'index.html');

// ── 미들웨어 ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
// 프로젝트 폴더 전체 정적 서빙. index.html 이 있으면 GET / 에서 자동으로 서빙된다.
app.use(express.static(__dirname));

// ── API ──────────────────────────────────────────────────────────────

// 헬스체크
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'my-cafe' });
});

// 브랜드 문서 조회 — my_cafe.md 전체 내용 + 파일 수정시각(mtime)
app.get('/api/cafe', async (_req, res, next) => {
  try {
    // 매 요청마다 파일을 새로 읽어 PUT 이후 최신 내용을 반영 (캐시하지 않음)
    const [markdown, stat] = await Promise.all([
      fs.promises.readFile(CAFE_FILE, 'utf-8'),
      fs.promises.stat(CAFE_FILE),
    ]);
    res.json({ markdown, updatedAt: stat.mtime.toISOString() });
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 파일이 아직 없으면 빈 문서로 응답 (프론트가 안전하게 렌더)
      return res.json({ markdown: '', updatedAt: null });
    }
    next(err);
  }
});

// 브랜드 문서 저장 — body { markdown }
app.put('/api/cafe', async (req, res, next) => {
  try {
    const { markdown } = req.body || {};
    // 파일 날림 방지: 문자열이 아니거나 공백뿐이면 저장을 거부한다.
    if (typeof markdown !== 'string' || markdown.trim() === '') {
      return res.status(400).json({ error: 'markdown 내용이 비어 있습니다' });
    }
    // 원본 그대로 저장 (trim 은 검증용일 뿐, 사용자 서식/줄바꿈 보존)
    await fs.promises.writeFile(CAFE_FILE, markdown, 'utf-8');
    const stat = await fs.promises.stat(CAFE_FILE);
    res.json({ ok: true, updatedAt: stat.mtime.toISOString() });
  } catch (err) {
    next(err);
  }
});

// 위에서 처리되지 않은 모든 /api/* 는 JSON 404 (실제 라우트 정의 뒤에 위치)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// 비(非) API 요청 폴백:
//   index.html 이 있으면 그대로 서빙(SPA), 아직 없으면 친절한 안내 페이지.
//   → 프론트 빌드 전에도 브라우저로 접속했을 때 서버가 살아있음을 보여준다.
app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(404).json({ error: 'not found' });
  }
  if (fs.existsSync(INDEX_FILE)) {
    return res.sendFile(INDEX_FILE);
  }
  res.status(200).type('html').send(
    '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>카페 안도 — 준비 중</title><style>' +
      'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F5F0E8;color:#5C4633;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo",sans-serif}' +
      '.card{text-align:center;padding:2rem;max-width:30rem}.logo{font-size:3rem}' +
      'h1{margin:.5rem 0;font-size:1.35rem}p{color:#8A9A7B;margin:.35rem 0;line-height:1.6}' +
      'code{background:#fff;padding:.15rem .45rem;border-radius:.35rem;color:#5C4633}</style></head>' +
      '<body><div class="card"><div class="logo">☕</div>' +
      '<h1>카페 안도 브랜드 허브</h1>' +
      '<p>서버는 정상 동작 중이에요. 화면(index.html)을 준비하고 있어요.</p>' +
      '<p><code>GET /api/health</code> · <code>GET /api/cafe</code> 는 지금 바로 사용할 수 있어요.</p>' +
      '</div></body></html>'
  );
});

// ── 에러 핸들러 ───────────────────────────────────────────────────────
// 항상 JSON 으로 응답하고 스택트레이스는 노출하지 않는다.
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '요청 본문을 해석할 수 없습니다 (JSON 형식 확인)' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '요청이 너무 큽니다 (최대 1MB)' });
  }
  console.error('[my-cafe] 서버 오류:', err && err.message);
  res.status(500).json({ error: '서버 오류가 발생했습니다' });
});

// ── 기동 ──────────────────────────────────────────────────────────────
// 로컬(node server.js)에서는 리슨, 서버리스에서 require 되면 app 만 export.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🍮 my-cafe 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`   my_cafe.md: ${CAFE_FILE}`);
    if (!fs.existsSync(INDEX_FILE)) {
      console.log('   ⓘ index.html 아직 없음 (프론트 에이전트 작업 중) — API 는 정상 동작');
    }
  });
}

module.exports = app;
