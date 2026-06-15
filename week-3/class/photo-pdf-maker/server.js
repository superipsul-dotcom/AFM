// ========================================
// 🖼️ 사진붙여넣기 모음 - 백엔드
// 클립보드로 모은 이미지를 클라이언트(jsPDF)에서 PDF로 만드는 앱.
// PDF 생성은 전적으로 브라우저에서 처리하므로, 이 서버는
// 정적 파일(index.html, client.js) 서빙만 담당한다.
// ========================================

const express = require('express');
const path = require('path');

const app = express();
// 기본 포트는 4777 (형제 프로젝트들과 4321 'npx serve' 점유를 피함).
// 다른 포트가 필요하면 PORT 환경변수로 덮어쓰기: PORT=5000 node server.js
const PORT = process.env.PORT || 4777;

// JSON 바디 파서 (현재는 API 라우트가 없지만, 형제 프로젝트 컨벤션을 따라 기본 장착)
app.use(express.json());

// 정적 파일 서빙 (같은 폴더의 index.html, client.js 등)
app.use(express.static(path.join(__dirname)));

// ========================================
// 헬스 체크 (선택) - 서버가 살아있는지 간단히 확인용
// ========================================
app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' }, message: '서버 정상 동작 중' });
});

// ========================================
// SPA 폴백 - 알 수 없는 경로는 index.html 로 (Express 4 문법)
// /api/* 는 위에서 처리되므로 여기로 내려오지 않는다.
// ========================================
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========================================
// 에러 핸들링 미들웨어
// ========================================
app.use((err, _req, res, _next) => {
  console.error('처리되지 않은 오류:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했어요.' });
});

// ========================================
// 서버 시작 (로컬) / Vercel 등에서는 app export
// ========================================
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`🖼️  사진붙여넣기 모음 서버 실행: http://localhost:${PORT}`);
  });
  // 포트가 이미 사용 중일 때 스택 대신 친절한 안내
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 포트 ${PORT} 가 이미 사용 중이에요.`);
      console.error(`   다른 포트로 실행하세요:  PORT=5000 node server.js\n`);
      process.exit(1);
    }
    throw err;
  });
}

module.exports = app;
