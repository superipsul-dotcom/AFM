// ========================================
// ✅ TODO 앱 백엔드 — Supabase PostgreSQL 영속화
// AFM week-4 실습 프로젝트
//
// 핵심: localStorage 가 아니라 "실제 Postgres DB"에 할 일을 저장한다.
//   - Express      : 정적 파일(index.html) 서빙 + REST API 제공
//   - pg (Pool)    : Supabase(Supavisor transaction pooler)에 연결
//   - dotenv       : 자격 증명을 .env 에서 읽어옴 (코드에 하드코딩 금지)
//
// 🔐 보안: DB 호스트/유저/비밀번호는 전부 process.env 로만 읽는다.
//          .env 는 .gitignore 로 커밋에서 제외된다.
// ========================================

require('dotenv').config(); // .env → process.env 로 로드 (가장 먼저 실행)

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// PORT 는 .env 에서, 없으면 3001. 문자열에 붙을 수 있는 공백/개행 방지로 trim.
const PORT = Number((process.env.PORT || '3001').trim());

// ----------------------------------------
// PostgreSQL 연결 풀 (개별 필드 config)
//
// ⚠️ 연결 문자열(URL) 대신 개별 필드로 구성한다.
//    비밀번호에 ! @ [ ] 같은 특수문자가 있으면 URL 인코딩에서 버그가
//    나기 쉬운데, 개별 필드 방식은 raw 값을 그대로 넘기므로 안전하다.
//
// 환경변수에 trailing newline 등이 붙는 플랫폼이 있어 .trim() 으로 방어.
// (비밀번호는 끝 공백이 의미를 가질 수 있으나, .env 값은 따옴표 없이 넣으므로
//  여기서는 안전하게 trim 처리한다. 비밀번호 자체에 의도적 공백은 없다고 가정.)
// ----------------------------------------
const pool = new Pool({
  host: (process.env.DB_HOST || '').trim(),
  port: Number((process.env.DB_PORT || '6543').trim()),
  user: (process.env.DB_USER || '').trim(),
  password: (process.env.DB_PASSWORD || '').trim(),
  database: (process.env.DB_NAME || 'postgres').trim(),
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필수
  max: 5,                              // 풀 최대 커넥션 (pooler 환경에 적당)
});

// 풀 차원의 예기치 못한 에러(유휴 커넥션 끊김 등)로 프로세스가 죽지 않도록.
pool.on('error', (err) => {
  console.error('⚠️  PostgreSQL 풀 오류(유휴 커넥션):', err.message);
});

// ----------------------------------------
// 테이블 자동 생성 (서버 부팅 시 1회)
//
// CREATE TABLE IF NOT EXISTS 라서 이미 있으면 아무 일도 안 한다.
// 별도 마이그레이션 단계 없이 서버만 켜면 스키마가 준비된다.
//
// 서버리스(cold start)에서 여러 번 호출돼도 안전하도록 flag 로 중복 방지.
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      text TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbInitialized = true;
  console.log('🗄️  todos 테이블 준비 완료 (없으면 생성).');
}

// ========================================
// 미들웨어 설정
// ========================================
app.use(express.json()); // JSON 본문 파싱 (POST/PATCH 용)

// 정적 파일 서빙: 같은 폴더의 index.html 제공
app.use(express.static(path.join(__dirname)));

// /api/* 요청은 처리 전에 테이블이 준비됐는지 보장한다.
// (lazy init: 서버리스 cold start 대응 + 부팅 시 DB 가 잠깐 늦어도 첫 요청에서 복구)
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('❌ DB 초기화 실패:', err.message);
    res.status(500).json({
      success: false,
      message: '데이터베이스 초기화에 실패했습니다. 서버 로그와 .env 설정을 확인해 주세요.',
    });
  }
});

// ----------------------------------------
// DB row → 클라이언트 모델 매핑
//   DB: { id, text, completed, created_at }
//   →  : { id, text, completed, createdAt }
// 프론트가 쓰던 createdAt 키를 그대로 맞춰주고, created_at(snake) → camel 변환.
// ----------------------------------------
function rowToTodo(row) {
  return {
    id: Number(row.id),                       // BIGINT → number
    text: row.text,
    completed: row.completed,
    createdAt: row.created_at,                // ISO 문자열(TIMESTAMPTZ)
  };
}

// ========================================
// REST API
// 모든 쿼리는 파라미터화($1, $2)로 작성 → SQL injection 방지.
// 응답 형식 통일: { success: boolean, data?, message? }
// ========================================

// --- GET /api/todos : 전체 목록 (최신순) ---
app.get('/api/todos', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, text, completed, created_at FROM todos ORDER BY created_at DESC, id DESC'
    );
    res.json({ success: true, data: rows.map(rowToTodo) });
  } catch (err) {
    console.error('GET /api/todos 오류:', err.message);
    res.status(500).json({ success: false, message: '할 일 목록을 불러오지 못했습니다.' });
  }
});

// --- POST /api/todos : 새 할 일 생성 ---
// body: { text }
app.post('/api/todos', async (req, res) => {
  try {
    const { text } = req.body || {}; // 본문이 없어도 throw 안 되게 방어적 구조분해

    // text 검증: 문자열 + 공백 아님
    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ success: false, message: '할 일 내용을 입력해 주세요.' });
    }
    const cleanText = text.trim();

    const { rows } = await pool.query(
      'INSERT INTO todos (text) VALUES ($1) RETURNING id, text, completed, created_at',
      [cleanText]
    );
    res.status(201).json({ success: true, data: rowToTodo(rows[0]) });
  } catch (err) {
    console.error('POST /api/todos 오류:', err.message);
    res.status(500).json({ success: false, message: '할 일을 저장하지 못했습니다.' });
  }
});

// ⚠️⚠️ 라우트 순서 주의 ⚠️⚠️
// DELETE /api/todos/completed 를 DELETE /api/todos/:id 보다 "먼저" 정의해야 한다.
// Express 는 위→아래로 매칭하므로, :id 가 먼저 오면 "completed" 가 :id="completed"
// 로 잡혀서 일괄 삭제 라우트에 도달하지 못한다.

// --- DELETE /api/todos/completed : 완료된 항목 일괄 삭제 ---
app.delete('/api/todos/completed', async (_req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM todos WHERE completed = TRUE');
    res.json({ success: true, data: { deleted: rowCount } });
  } catch (err) {
    console.error('DELETE /api/todos/completed 오류:', err.message);
    res.status(500).json({ success: false, message: '완료 항목을 삭제하지 못했습니다.' });
  }
});

// --- PATCH /api/todos/:id : 완료 상태 변경 ---
// body: { completed }
app.patch('/api/todos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }

    const { completed } = req.body || {};
    if (typeof completed !== 'boolean') {
      return res.status(400).json({ success: false, message: 'completed 는 true/false 여야 합니다.' });
    }

    const { rows } = await pool.query(
      'UPDATE todos SET completed = $1 WHERE id = $2 RETURNING id, text, completed, created_at',
      [completed, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rowToTodo(rows[0]) });
  } catch (err) {
    console.error('PATCH /api/todos/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '할 일을 수정하지 못했습니다.' });
  }
});

// --- DELETE /api/todos/:id : 단일 삭제 ---
app.delete('/api/todos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '잘못된 id 입니다.' });
    }

    const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('DELETE /api/todos/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '할 일을 삭제하지 못했습니다.' });
  }
});

// ========================================
// SPA / 정적 폴백 (Express 4 문법: '*')
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
//  - 부팅 시 테이블을 미리 만들어 둔다(첫 요청 지연 제거 + DB 연결 조기 확인).
//    실패해도 listen 은 계속한다: API 미들웨어에서 다시 initDB 를 시도하므로,
//    DB 가 잠시 늦게 올라와도 서버 자체는 떠 있고 정적 파일은 서빙된다.
//  - 로컬에서 직접 실행할 때만 listen. (Vercel 등 서버리스 호환 위해 분리)
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ TODO 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`🔌 DB 연결 대상: ${process.env.DB_HOST}:${process.env.DB_PORT} / ${process.env.DB_NAME}`);
  });

  // 부팅 시 테이블 준비 + 연결 확인 (실패해도 서버는 계속 동작)
  initDB().catch((err) => {
    console.error('────────────────────────────────────────────');
    console.error('❌ 서버 부팅 시 DB 연결/초기화에 실패했습니다.');
    console.error('   사유:', err.message);
    console.error('   확인할 점:');
    console.error('   1) .env 의 DB_PASSWORD 가 정확한가? (특수문자 포함, 따옴표 없이)');
    console.error('   2) DB_HOST / DB_PORT / DB_USER 가 맞는가?');
    console.error('   3) 네트워크가 Supabase(:6543)로 나갈 수 있는가?');
    console.error('   → 정적 파일 서빙과 /api 재시도는 계속 동작합니다.');
    console.error('────────────────────────────────────────────');
  });
}

module.exports = app;
