// ========================================
// ✅ 멀티유저 할 일(Todo) 관리앱 백엔드 (Supabase PostgreSQL 영속화 + JWT 인증)
// AFM week-5 / todos (Server + DB + Auth)
//
// 핵심: 이메일/비밀번호 회원가입·로그인 + JWT(Bearer) 인증, 그리고 사용자별로 격리된 Todo CRUD.
//   - Express        : 정적 파일(index.html) 서빙 + REST API 제공
//   - pg(Pool)       : Supabase(Supavisor transaction pooler, :6543)에 연결
//   - dotenv         : 자격 증명을 .env 에서만 읽음 (코드에 하드코딩 금지)
//   - bcryptjs       : 비밀번호 해시(salt rounds 10) 저장 + 로그인 시 compare
//   - jsonwebtoken   : { userId, email } 페이로드 / 만료 7일 / HS256 서명
//
// 테이블 2개:
//   users (id, email UNIQUE, password_hash, created_at)
//   todos (id, user_id → users.id ON DELETE CASCADE, title, done, created_at)
//   ⚠️ 이 Supabase 프로젝트엔 ingredients/recipes 테이블이 따로 있다 — 절대 건드리지 않는다.
//
// 공유 API 계약(프론트/백 동일):
//   응답 봉투: 성공 { success:true, data, message } / 실패 { success:false, data:null, message }
//   todo = { id, title, done, createdAt }   (createdAt = created_at 의 ISO 8601 문자열)
//   user = { id, email }                    (password_hash 는 절대 반환하지 않는다)
//
// 🔐 보안: DB 접속 정보(DATABASE_URL)와 서명 비밀(JWT_SECRET)은 process.env 로만 읽고,
//          .env 는 .gitignore 로 제외한다. 비밀번호 평문/해시·서명키를 응답에 절대 싣지 않는다.
// ========================================

require('dotenv').config(); // .env → process.env 로 로드 (가장 먼저 실행)

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// PORT 는 .env 에서, 없으면 3006. (옆 폴더 my-food 가 3005 라 충돌 피하려 3006 기본)
const PORT = Number((process.env.PORT || '3006').trim());

// JWT 서명 비밀. 환경변수에 trailing newline 이 붙는 플랫폼이 있어 .trim() 으로 방어.
// 비어 있으면 인증이 안전하지 않으므로 부팅 시 경고만 남기고(데모 편의), 토큰 발급/검증 시 503 처리.
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d'; // 토큰 만료 7일

// ----------------------------------------
// PostgreSQL 연결 풀
//
// connection string(DATABASE_URL) 방식. trailing newline 방어로 .trim().
//
// ⚠️ DATABASE_URL 은 Supabase 트랜잭션 풀러(:6543, pgBouncer)다.
//    표준 파라미터 쿼리(pool.query(text, params))만 쓰고 named prepared statement 는 쓰지 않는다.
//    (pgBouncer transaction 모드에서 named prepared statement 는 깨질 수 있음)
//
// Supabase 는 SSL 필수 → rejectUnauthorized:false (self-signed 체인 허용).
// ----------------------------------------
const connectionString = (process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Supabase 는 SSL 필수
  max: 5, // 풀 최대 커넥션 (pooler 환경에 적당)
});

// 풀 차원의 예기치 못한 에러(유휴 커넥션 끊김 등)로 프로세스가 죽지 않도록.
pool.on('error', (err) => {
  console.error('⚠️  PostgreSQL 풀 오류(유휴 커넥션):', err.message);
});

// ----------------------------------------
// 테이블 자동 생성 (lazy init, 최초 1회)
//
// CREATE TABLE IF NOT EXISTS 라서 이미 있으면 아무 일도 안 한다.
// 서버리스(cold start)에서 여러 번 호출돼도 안전하도록 flag 로 중복 방지.
//
// gen_random_uuid() 를 쓰려면 pgcrypto 확장이 필요 → CREATE EXTENSION IF NOT EXISTS pgcrypto.
//
// 스키마:
//   users
//     id            UUID         기본키 (gen_random_uuid())
//     email         TEXT         로그인 이메일 (UNIQUE, NOT NULL)
//     password_hash TEXT         bcrypt 해시 (NOT NULL) — 절대 응답에 싣지 않음
//     created_at    TIMESTAMPTZ  생성 시각 (기본 now())
//   todos
//     id            UUID         기본키 (gen_random_uuid())
//     user_id       UUID         소유자 (users.id 참조, ON DELETE CASCADE)
//     title         TEXT         할 일 내용 (NOT NULL)
//     done          BOOLEAN      완료 여부 (기본 false)
//     created_at    TIMESTAMPTZ  생성 시각 (기본 now())
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;

  // gen_random_uuid() 사용을 위한 확장 (Supabase 에선 보통 이미 활성화돼 있음. 안전하게 보장)
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 사용자별 할 일 조회를 빠르게 (필수는 아니나 멀티유저에 유용)
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_todos_user_id ON todos(user_id);'
  );

  dbInitialized = true;
  console.log('🗄️  users / todos 테이블 준비 완료.');
}

// ========================================
// 미들웨어 설정
// ========================================
app.use(express.json()); // JSON 본문 파싱 (POST/PUT 용)

// 정적 파일 서빙: 같은 폴더의 index.html(프론트엔드 에이전트가 작성) 제공
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
      data: null,
      message:
        '데이터베이스 초기화에 실패했습니다. 서버 로그와 .env(DATABASE_URL) 설정을 확인해 주세요.',
    });
  }
});

// ----------------------------------------
// 응답 봉투 헬퍼 + 공통 유틸
//   성공: { success:true, data, message }
//   실패: { success:false, data:null, message }
// ----------------------------------------
const ok = (res, status, data, message) =>
  res.status(status).json({ success: true, data, message: message || 'OK' });

const fail = (res, status, message) =>
  res.status(status).json({ success: false, data: null, message });

// 문자열 정규화: 문자열이 아니면 '' 로, 맞으면 trim.
const asString = (v) => (typeof v === 'string' ? v.trim() : '');

// 간단한 이메일 형식 검증 (지나치게 엄격하지 않게)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (email) => EMAIL_RE.test(email);

// DB row → 클라이언트 모델 매핑 (snake_case → camelCase)
// ⚠️ user 는 password_hash 를 절대 포함하지 않는다.
const rowToUser = (row) => ({ id: row.id, email: row.email });

// ⚠️ todo 의 createdAt 은 ISO 8601 문자열. pg 는 TIMESTAMPTZ 를 JS Date 로 주므로 .toISOString().
const rowToTodo = (row) => ({
  id: row.id,
  title: row.title,
  done: row.done,
  createdAt: new Date(row.created_at).toISOString(),
});

// ========================================
// 인증 (Auth)
// ========================================

// JWT 발급: payload { userId, email }, 만료 7일, HS256.
function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

// authMiddleware: Authorization: Bearer <token> 검증 → req.user = payload.
// 헤더가 없거나 형식이 틀리거나 토큰이 무효/만료면 401.
function authMiddleware(req, res, next) {
  if (!JWT_SECRET) {
    return fail(
      res,
      503,
      '서버에 JWT_SECRET 이 설정되지 않았습니다. .env 를 확인하고 서버를 다시 시작해 주세요.'
    );
  }
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return fail(res, 401, '인증이 필요합니다. 다시 로그인해 주세요.');
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET); // { userId, email, iat, exp }
    next();
  } catch (_err) {
    return fail(res, 401, '세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.');
  }
}

// ----------------------------------------
// POST /api/auth/signup  body { email, password }
//   → 201 { success:true, data:{ token, user:{id,email} } }
//   - 이메일 형식 검증 + 비밀번호 최소 6자. 이미 가입된 이메일이면 409.
// ----------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    if (!JWT_SECRET) {
      return fail(
        res,
        503,
        '서버에 JWT_SECRET 이 설정되지 않았습니다. .env 를 확인하고 서버를 다시 시작해 주세요.'
      );
    }

    const email = asString(req.body && req.body.email).toLowerCase();
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';

    if (!email || !isValidEmail(email)) {
      return fail(res, 400, '올바른 이메일 형식을 입력해 주세요.');
    }
    if (password.length < 6) {
      return fail(res, 400, '비밀번호는 최소 6자 이상이어야 합니다.');
    }

    // 이미 가입된 이메일인지 확인 (UNIQUE 제약과 더불어 친절한 409 메시지를 위해 선조회)
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return fail(res, 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
    }

    const passwordHash = await bcrypt.hash(password, 10); // salt rounds 10

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email`,
        [email, passwordHash]
      ));
    } catch (err) {
      // 동시 가입 경쟁 등으로 UNIQUE 위반(23505)이 나면 409 로.
      if (err.code === '23505') {
        return fail(res, 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
      }
      throw err;
    }

    const user = rowToUser(rows[0]);
    const token = signToken(user);
    return ok(res, 201, { token, user }, '회원가입이 완료되었습니다.');
  } catch (err) {
    console.error('POST /api/auth/signup 오류:', err.message);
    return fail(res, 500, '회원가입 중 오류가 발생했습니다.');
  }
});

// ----------------------------------------
// POST /api/auth/login  body { email, password }
//   → 200 { success:true, data:{ token, user:{id,email} } } (자격 불일치 401)
// ----------------------------------------
app.post('/api/auth/login', async (req, res) => {
  try {
    if (!JWT_SECRET) {
      return fail(
        res,
        503,
        '서버에 JWT_SECRET 이 설정되지 않았습니다. .env 를 확인하고 서버를 다시 시작해 주세요.'
      );
    }

    const email = asString(req.body && req.body.email).toLowerCase();
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';

    if (!email || !password) {
      return fail(res, 400, '이메일과 비밀번호를 모두 입력해 주세요.');
    }

    const { rows } = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );

    // 이메일이 없거나 비밀번호가 틀려도 동일한 401 메시지(계정 존재 여부 노출 방지)
    const row = rows[0];
    const match = row ? await bcrypt.compare(password, row.password_hash) : false;
    if (!row || !match) {
      return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않습니다.');
    }

    const user = rowToUser(row);
    const token = signToken(user);
    return ok(res, 200, { token, user }, '로그인되었습니다.');
  } catch (err) {
    console.error('POST /api/auth/login 오류:', err.message);
    return fail(res, 500, '로그인 중 오류가 발생했습니다.');
  }
});

// ----------------------------------------
// GET /api/auth/me  (Bearer) → 200 { success:true, data:{ user:{id,email} } }
//   세션 복원용. 토큰의 userId 로 DB 를 다시 조회해 (탈퇴한 계정 등) 최신 상태를 확인.
// ----------------------------------------
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [
      req.user.userId,
    ]);
    if (rows.length === 0) {
      return fail(res, 401, '계정을 찾을 수 없습니다. 다시 로그인해 주세요.');
    }
    return ok(res, 200, { user: rowToUser(rows[0]) }, '세션이 유효합니다.');
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 401, '유효하지 않은 토큰입니다. 다시 로그인해 주세요.');
    }
    console.error('GET /api/auth/me 오류:', err.message);
    return fail(res, 500, '사용자 정보를 불러오지 못했습니다.');
  }
});

// ========================================
// REST API — 할 일(todos) CRUD  [보호: Bearer 필요]
// 항상 현재 사용자(req.user.userId)로 스코프한다 → 남의 todo 는 보이지도, 수정/삭제되지도 않는다.
// 모든 쿼리는 파라미터화($1,$2) → SQL injection 방지.
// 응답: { success, data, message } / 상태: 200 ok / 201 create / 400 검증 / 401 인증 / 404 없음 / 500 서버
// ========================================

// --- GET /api/todos : 내 할 일 전체 (created_at 최신순) ---
app.get('/api/todos', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, done, created_at
       FROM todos
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.userId]
    );
    return ok(res, 200, rows.map(rowToTodo), '할 일 목록을 불러왔습니다.');
  } catch (err) {
    console.error('GET /api/todos 오류:', err.message);
    return fail(res, 500, '할 일 목록을 불러오지 못했습니다.');
  }
});

// --- POST /api/todos : 할 일 추가 --- body { title }
app.post('/api/todos', authMiddleware, async (req, res) => {
  try {
    const title = asString(req.body && req.body.title);
    if (!title) {
      return fail(res, 400, '할 일 내용을 입력해 주세요.');
    }

    const { rows } = await pool.query(
      `INSERT INTO todos (user_id, title)
       VALUES ($1, $2)
       RETURNING id, title, done, created_at`,
      [req.user.userId, title]
    );
    return ok(res, 201, rowToTodo(rows[0]), '할 일을 추가했습니다.');
  } catch (err) {
    console.error('POST /api/todos 오류:', err.message);
    return fail(res, 500, '할 일을 저장하지 못했습니다.');
  }
});

// --- PUT /api/todos/:id : 할 일 수정 --- body { title?, done? }
//   본인 소유가 아니면 404 (WHERE 에 user_id 를 함께 걸어 타인 소유는 매칭 자체가 안 됨).
app.put('/api/todos/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 부분 수정 지원: 전달된 필드만 갱신. COALESCE($n, col) 로 null(미전달) 이면 기존값 유지.
    const hasTitle = req.body && typeof req.body.title !== 'undefined';
    const hasDone = req.body && typeof req.body.done !== 'undefined';

    if (!hasTitle && !hasDone) {
      return fail(res, 400, '수정할 내용(title 또는 done)이 없습니다.');
    }

    // title 이 전달됐다면 빈 문자열은 거부.
    let title = null;
    if (hasTitle) {
      title = asString(req.body.title);
      if (!title) {
        return fail(res, 400, '할 일 내용은 비울 수 없습니다.');
      }
    }

    const done = hasDone ? Boolean(req.body.done) : null;

    const { rows } = await pool.query(
      `UPDATE todos
       SET title = COALESCE($1, title),
           done  = COALESCE($2, done)
       WHERE id = $3 AND user_id = $4
       RETURNING id, title, done, created_at`,
      [title, done, id, req.user.userId]
    );

    if (rows.length === 0) {
      return fail(res, 404, '해당 할 일을 찾을 수 없습니다.');
    }
    return ok(res, 200, rowToTodo(rows[0]), '할 일을 수정했습니다.');
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 400, '잘못된 할 일 id 형식입니다.');
    }
    console.error('PUT /api/todos/:id 오류:', err.message);
    return fail(res, 500, '할 일을 수정하지 못했습니다.');
  }
});

// --- DELETE /api/todos/:id : 할 일 삭제 --- (본인 소유 아니면 404)
app.delete('/api/todos/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'DELETE FROM todos WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    if (rowCount === 0) {
      return fail(res, 404, '해당 할 일을 찾을 수 없습니다.');
    }
    return ok(res, 200, { id }, '할 일을 삭제했습니다.');
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 400, '잘못된 할 일 id 형식입니다.');
    }
    console.error('DELETE /api/todos/:id 오류:', err.message);
    return fail(res, 500, '할 일을 삭제하지 못했습니다.');
  }
});

// ----------------------------------------
// 정의되지 않은 /api/* 경로 → JSON 404 (SPA 폴백이 가로채 HTML 을 주지 않도록 먼저 처리)
// ----------------------------------------
app.use('/api', (_req, res) => {
  return fail(res, 404, '요청한 API 경로를 찾을 수 없습니다.');
});

// ========================================
// SPA / 정적 폴백 (Express 4 문법: '*')
// /api 가 아닌 경로로 직접 접속하면 index.html 을 돌려준다 → :3006 으로 접속하면 앱이 뜬다.
// 반드시 /api 라우트들보다 "아래"에 정의해야 한다.
// ========================================
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========================================
// 에러 처리 미들웨어 (마지막 안전망)
// express.json() 파싱 실패(잘못된 JSON) 등도 여기서 잡아 JSON 으로 응답한다.
// ========================================
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, '요청 본문이 올바른 JSON 형식이 아닙니다.');
  }
  console.error('처리되지 않은 오류:', err);
  return fail(res, 500, '서버 내부 오류가 발생했습니다.');
});

// ========================================
// 서버 시작
//  - 부팅 시 테이블을 미리 만들어 둔다(첫 요청 지연 제거 + DB 연결 조기 확인).
//    실패해도 listen 은 계속한다: /api 미들웨어에서 initDB 를 재시도하므로,
//    DB 가 잠시 늦게 올라와도 서버 자체는 떠 있고 정적 파일은 서빙된다.
//  - 로컬에서 직접 실행할 때만 listen. (Vercel 등 서버리스 호환 위해 module.exports 와 분리)
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 할 일 관리 서버 실행 중 → http://localhost:${PORT}`);
    if (!JWT_SECRET) {
      console.warn('⚠️  JWT_SECRET 이 비어 있습니다. .env 에 JWT_SECRET 을 설정해야 인증이 동작합니다.');
    }
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
