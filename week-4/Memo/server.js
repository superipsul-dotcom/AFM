// ========================================
// 📝 심플 메모장 백엔드 — Supabase PostgreSQL 영속화
// AFM week-4 실습 프로젝트
//
// 핵심: localStorage 가 아니라 "실제 Postgres DB"에 메모를 저장한다.
//   - Express      : 정적 파일(index.html) 서빙 + REST CRUD API 제공
//   - pg (Pool)    : Supabase(Supavisor transaction pooler)에 연결
//   - dotenv       : 자격 증명을 .env 에서 읽어옴 (코드에 하드코딩 금지)
//
// 🔐 보안: DB 접속 정보(connection string)는 process.env.DATABASE_URL 로만 읽는다.
//          .env 는 .gitignore 로 커밋에서 제외된다.
// ========================================

require('dotenv').config(); // .env → process.env 로 로드 (가장 먼저 실행)

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// PORT 는 .env 에서, 없으면 3002. 문자열에 붙을 수 있는 공백/개행 방지로 trim.
const PORT = Number((process.env.PORT || '3002').trim());

// ----------------------------------------
// PostgreSQL 연결 풀
//
// 과제 요구사항대로 connection string(DATABASE_URL) 방식으로 연결한다.
// 환경변수에 trailing newline 등이 붙는 플랫폼이 있어 .trim() 으로 방어.
//
// ⚠️ 포트 6543 은 Supabase 트랜잭션 풀러(pgBouncer)다.
//    prepared statement 관련 이슈가 나면 .env 의 DATABASE_URL 포트를
//    5432(세션 풀러)로 바꾸면 된다. (이 앱은 단순 쿼리라 6543 으로 충분)
//
// Supabase 는 SSL 필수 → rejectUnauthorized:false (self-signed 체인 허용).
// ----------------------------------------
const connectionString = (process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString,
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
//
// 스키마:
//   id          UUID         기본키 (gen_random_uuid() 로 자동 생성)
//   title       TEXT         제목
//   content     TEXT         본문
//   created_at  TIMESTAMPTZ  생성 시각 (기본 now())
//   updated_at  TIMESTAMPTZ  수정 시각 (생성 시엔 created_at 과 동일)
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      favorite BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // 마이그레이션: 즐겨찾기 컬럼이 없던 예전 테이블도 자동으로 보강한다.
  // IF NOT EXISTS 라 이미 있으면 아무 일도 하지 않아 반복 실행에 안전하다.
  await pool.query(
    `ALTER TABLE memos ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT false;`
  );
  dbInitialized = true;
  console.log('🗄️  memos 테이블 준비 완료 (favorite 컬럼 포함, 없으면 생성/보강).');
}

// ========================================
// 미들웨어 설정
// ========================================
app.use(express.json()); // JSON 본문 파싱 (POST/PUT 용)

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
      message: '데이터베이스 초기화에 실패했습니다. 서버 로그와 .env(DATABASE_URL) 설정을 확인해 주세요.',
    });
  }
});

// ----------------------------------------
// DB row → 클라이언트 모델 매핑
//   DB : { id, title, content, created_at, updated_at }  (snake_case)
//   →  : { id, title, content, createdAt, updatedAt }    (camelCase)
//
// ⚠️ 프론트엔드(index.html)는 createdAt/updatedAt 을 "epoch ms 숫자"로 다룬다.
//    (formatDate(new Date(ts)), 정렬 b.createdAt - a.createdAt,
//     수정여부 판정 updatedAt !== createdAt)
//    pg 는 TIMESTAMPTZ 를 JS Date 객체로 돌려주므로 .getTime() 으로 ms 숫자 변환.
//    이렇게 하면 기존 프론트 로직을 거의 그대로 재사용할 수 있다.
// ----------------------------------------
function rowToMemo(row) {
  return {
    id: row.id,                                 // UUID 문자열
    title: row.title,
    content: row.content,
    favorite: !!row.favorite,                   // 즐겨찾기 여부 (boolean)
    createdAt: new Date(row.created_at).getTime(), // → epoch ms (number)
    updatedAt: new Date(row.updated_at).getTime(), // → epoch ms (number)
  };
}

// 입력 검증 공통 헬퍼: title/content 중 최소 하나는 비어있지 않아야 한다.
// (프론트의 "제목 또는 본문 중 하나는 입력" 규칙과 동일)
function normalizeMemoInput(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  return { title, content };
}

// ========================================
// REST API — 메모 CRUD
// 모든 쿼리는 파라미터화($1, $2)로 작성 → SQL injection 방지.
// 응답 형식 통일: { success: boolean, data?, message? }
// 상태 코드: 200 ok / 201 create / 400 검증 / 404 없음 / 500 서버
// ========================================

// --- GET /api/memos : 전체 목록 (최신순) ---
app.get('/api/memos', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, content, favorite, created_at, updated_at FROM memos ORDER BY favorite DESC, created_at DESC'
    );
    res.json({ success: true, data: rows.map(rowToMemo) });
  } catch (err) {
    console.error('GET /api/memos 오류:', err.message);
    res.status(500).json({ success: false, message: '메모 목록을 불러오지 못했습니다.' });
  }
});

// --- POST /api/memos : 새 메모 생성 ---
// body: { title, content }
app.post('/api/memos', async (req, res) => {
  try {
    const { title, content } = normalizeMemoInput(req.body || {});

    if (!title && !content) {
      return res.status(400).json({
        success: false,
        message: '제목 또는 본문 중 하나는 입력해야 합니다.',
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO memos (title, content)
       VALUES ($1, $2)
       RETURNING id, title, content, favorite, created_at, updated_at`,
      [title, content]
    );
    res.status(201).json({ success: true, data: rowToMemo(rows[0]) });
  } catch (err) {
    console.error('POST /api/memos 오류:', err.message);
    res.status(500).json({ success: false, message: '메모를 저장하지 못했습니다.' });
  }
});

// --- PUT /api/memos/:id : 메모 수정 ---
// body: { title, content } → updated_at 을 now() 로 갱신
app.put('/api/memos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = normalizeMemoInput(req.body || {});

    if (!title && !content) {
      return res.status(400).json({
        success: false,
        message: '제목 또는 본문 중 하나는 입력해야 합니다.',
      });
    }

    const { rows } = await pool.query(
      `UPDATE memos
       SET title = $1, content = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, title, content, favorite, created_at, updated_at`,
      [title, content, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rowToMemo(rows[0]) });
  } catch (err) {
    // 잘못된 UUID 형식이면 pg 가 22P02 (invalid_text_representation) 를 던진다 → 400
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 메모 id 형식입니다.' });
    }
    console.error('PUT /api/memos/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '메모를 수정하지 못했습니다.' });
  }
});

// --- PATCH /api/memos/:id/favorite : 즐겨찾기 토글 ---
// body: { favorite: boolean } → favorite 컬럼만 갱신한다.
// ⚠️ updated_at 은 일부러 건드리지 않는다: 즐겨찾기는 '내용 수정'이 아니므로
//    프론트의 "수정됨" 배지가 뜨면 안 된다.
app.patch('/api/memos/:id/favorite', async (req, res) => {
  try {
    const { id } = req.params;
    const favorite = !!(req.body && req.body.favorite); // 불리언으로 정규화

    const { rows } = await pool.query(
      `UPDATE memos
       SET favorite = $1
       WHERE id = $2
       RETURNING id, title, content, favorite, created_at, updated_at`,
      [favorite, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rowToMemo(rows[0]) });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 메모 id 형식입니다.' });
    }
    console.error('PATCH /api/memos/:id/favorite 오류:', err.message);
    res.status(500).json({ success: false, message: '즐겨찾기 상태를 변경하지 못했습니다.' });
  }
});

// --- DELETE /api/memos/:id : 메모 삭제 ---
app.delete('/api/memos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { rowCount } = await pool.query('DELETE FROM memos WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id } });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 메모 id 형식입니다.' });
    }
    console.error('DELETE /api/memos/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '메모를 삭제하지 못했습니다.' });
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
    console.log(`✅ 메모장 서버 실행 중 → http://localhost:${PORT}`);
  });

  // 부팅 시 테이블 준비 + 연결 확인 (실패해도 서버는 계속 동작)
  initDB()
    .then(() => {
      console.log('🔌 Supabase PostgreSQL 연결 성공.');
    })
    .catch((err) => {
      console.error('────────────────────────────────────────────');
      console.error('❌ 서버 부팅 시 DB 연결/초기화에 실패했습니다.');
      console.error('   사유:', err.message);
      console.error('   확인할 점:');
      console.error('   1) .env 의 DATABASE_URL 이 정확한가? (비밀번호 포함)');
      console.error('   2) 포트 6543(트랜잭션 풀러) 이슈면 5432 로 바꿔보기.');
      console.error('   3) 네트워크가 Supabase(:6543)로 나갈 수 있는가?');
      console.error('   → 정적 파일 서빙과 /api 재시도는 계속 동작합니다.');
      console.error('────────────────────────────────────────────');
    });
}

module.exports = app;
