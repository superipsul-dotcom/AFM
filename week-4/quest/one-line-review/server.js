// ========================================
// 📝 한줄 기대평 - 방명록 스타일 게시판 백엔드
// AFM week-4 실습 프로젝트
//
// 핵심: in-memory 가 아니라 "파일 기반 영구 저장"
//   - data/reviews.json      : 전체 기대평 목록(정본). 서버 재시작 후에도 유지됨.
//   - data/entries/<...>.json : 제출 한 건마다 개별 파일(한 건 = 한 파일)
// ========================================

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4100;

// ----------------------------------------
// 데이터 저장 경로 설정
// __dirname 기준으로 data/ 폴더를 잡아서, 어디서 node 를 실행하든
// 항상 이 프로젝트 폴더 안의 data/ 에 저장되도록 한다.
// ----------------------------------------
const DATA_DIR = path.join(__dirname, 'data');            // data/
const ENTRIES_DIR = path.join(DATA_DIR, 'entries');       // data/entries/
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json'); // data/reviews.json (정본)

// 입력 검증 기준 (클라이언트와 동일한 규칙을 서버에서도 한 번 더 검사)
const MAX_NICKNAME_LEN = 20;   // 닉네임 최대 길이
const MAX_MESSAGE_LEN = 100;   // 한줄 기대평 최대 길이

// ----------------------------------------
// 메모리 캐시(정본 파일의 복사본)
// 매 요청마다 파일을 새로 읽지 않도록, 서버 시작 시 reviews.json 을
// 읽어 이 배열에 올려두고 이후에는 이 배열을 기준으로 응답한다.
// 새 글이 들어오면 배열 + 파일을 함께 갱신한다.
// ----------------------------------------
let reviews = [];

// ----------------------------------------
// 저장소 초기화
//  1) data/, data/entries/ 폴더가 없으면 자동 생성
//  2) 기존 reviews.json 이 있으면 읽어서 메모리에 반영
// 서버가 켜질 때 딱 한 번 호출된다.
// ----------------------------------------
function initStore() {
  // recursive:true → 상위 폴더가 없어도 한 번에 만들고, 이미 있어도 에러 안 남
  fs.mkdirSync(ENTRIES_DIR, { recursive: true }); // data/entries 까지 보장

  if (fs.existsSync(REVIEWS_FILE)) {
    try {
      const raw = fs.readFileSync(REVIEWS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      // 혹시 파일이 배열이 아닐 경우를 대비해 방어적으로 처리
      reviews = Array.isArray(parsed) ? parsed : [];
      console.log(`📂 기존 기대평 ${reviews.length}건을 불러왔습니다.`);
    } catch (err) {
      // 파일이 깨졌을 때 서버가 죽지 않도록: 빈 목록으로 시작
      console.warn('⚠️  reviews.json 을 읽지 못해 빈 목록으로 시작합니다:', err.message);
      reviews = [];
    }
  } else {
    // 최초 실행: 빈 정본 파일을 만들어 둔다
    reviews = [];
    fs.writeFileSync(REVIEWS_FILE, '[]', 'utf-8');
    console.log('🆕 reviews.json 을 새로 생성했습니다.');
  }
}

// ----------------------------------------
// 정본 파일(reviews.json) 다시 쓰기
// 메모리의 reviews 배열 전체를 보기 좋게(들여쓰기 2칸) 저장한다.
// ----------------------------------------
function saveReviewsFile() {
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2), 'utf-8');
}

// ----------------------------------------
// 개별 파일 저장 (요구사항: "각각 저장")
// 제출 한 건을 data/entries/<타임스탬프>-<id>.json 으로 따로 저장.
// 파일명에 못 쓰는 문자(: 등)는 -로 바꿔 안전하게 만든다.
// ----------------------------------------
function saveEntryFile(review) {
  // 예: 2026-06-16T11-22-33-456Z-3.json
  const safeTime = review.createdAt.replace(/[:.]/g, '-');
  const fileName = `${safeTime}-${review.id}.json`;
  const filePath = path.join(ENTRIES_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(review, null, 2), 'utf-8');
  return fileName;
}

// ----------------------------------------
// 다음 id 계산
// 기존 목록에서 가장 큰 id + 1. (목록이 비었으면 1)
// 파일 기반이라 서버 재시작 후에도 이어지는 번호가 된다.
// ----------------------------------------
function nextId() {
  if (reviews.length === 0) return 1;
  const maxId = reviews.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0);
  return maxId + 1;
}

// ========================================
// 미들웨어 설정
// ========================================
app.use(express.json()); // POST JSON 본문 파싱

// 정적 파일 서빙 (같은 폴더의 index.html, client.js 제공)
app.use(express.static(path.join(__dirname)));

// ========================================
// GET /api/reviews
// 저장된 기대평 전체를 "최신순"으로 반환
//   → 메모리 배열을 복사해 뒤집어서 내려준다(원본 순서는 보존).
// 응답: { success, data: [ {id, nickname, message, createdAt}, ... ], count }
// ========================================
app.get('/api/reviews', (_req, res) => {
  try {
    const latestFirst = [...reviews].reverse(); // 최신 글이 앞으로 오게
    res.json({ success: true, data: latestFirst, count: latestFirst.length });
  } catch (err) {
    console.error('GET /api/reviews 오류:', err);
    res.status(500).json({ success: false, message: '기대평을 불러오는 중 오류가 발생했습니다.' });
  }
});

// ========================================
// POST /api/reviews
// body: { nickname, message }
//   1) 입력 검증 (message 필수, 길이 제한)
//   2) 새 항목 생성 → 메모리 배열에 추가
//   3) reviews.json 갱신 + data/entries/ 에 개별 파일 저장
// 응답(성공): { success:true, data: <생성된 항목> }  (상태코드 201)
// ========================================
app.post('/api/reviews', (req, res) => {
  try {
    // 본문이 비어 있어도 throw 되지 않도록 방어적으로 구조 분해
    const { nickname, message } = req.body || {};

    // --- message 검증 (필수) ---
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, message: '기대평 내용을 입력해 주세요.' });
    }
    const cleanMessage = message.trim();
    if (cleanMessage.length > MAX_MESSAGE_LEN) {
      return res.status(400).json({
        success: false,
        message: `기대평은 최대 ${MAX_MESSAGE_LEN}자까지 입력할 수 있어요.`,
      });
    }

    // --- nickname 검증 (선택: 비우면 "익명") ---
    let cleanNickname = (typeof nickname === 'string' ? nickname.trim() : '');
    if (cleanNickname.length > MAX_NICKNAME_LEN) {
      return res.status(400).json({
        success: false,
        message: `닉네임은 최대 ${MAX_NICKNAME_LEN}자까지 입력할 수 있어요.`,
      });
    }
    if (cleanNickname.length === 0) cleanNickname = '익명';

    // --- 새 항목 생성 ---
    const review = {
      id: nextId(),
      nickname: cleanNickname,
      message: cleanMessage,
      createdAt: new Date().toISOString(), // ISO 문자열로 작성 시각 저장
    };

    // --- 저장 ---
    reviews.push(review);    // 1) 메모리 반영
    saveReviewsFile();       // 2) 정본 파일(reviews.json) 갱신
    saveEntryFile(review);   // 3) 개별 파일(data/entries/...) 저장

    res.status(201).json({ success: true, data: review });
  } catch (err) {
    console.error('POST /api/reviews 오류:', err);
    res.status(500).json({ success: false, message: '기대평을 저장하는 중 오류가 발생했습니다.' });
  }
});

// ========================================
// SPA/정적 폴백 (Express 4 문법: '*')
// API 가 아닌 경로로 직접 접속하면 index.html 을 돌려준다.
// 반드시 /api 라우트들보다 "아래"에 정의해야 한다.
// ========================================
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========================================
// 에러 처리 미들웨어 (마지막 안전망)
// 위에서 못 잡은 예외도 JSON 으로 응답하고 서버가 죽지 않게 한다.
// ========================================
app.use((err, _req, res, _next) => {
  console.error('처리되지 않은 오류:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ========================================
// 서버 시작
// 저장소를 먼저 초기화(폴더 생성 + 기존 데이터 로드)한 뒤 리스닝 시작.
// ========================================
initStore();

// 로컬에서 직접 실행할 때만 listen (Vercel 등 서버리스 호환을 위해 분리)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`📝 한줄 기대평 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`💾 데이터 저장 위치: ${DATA_DIR}`);
  });
}

module.exports = app;
