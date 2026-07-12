// ============================================================
// 역전지붕방수 견적 — 백엔드 (server.js)
// (주)안도공간 내부용: 로그인/가입 + 견적 서버 저장 + 자재 단가 DB
//
// 패턴: week-5/community server.js 계승 (검증 32/32)
//   - Express        : 정적 서빙(index.html, images/) + REST API
//   - pg(Pool)       : Supabase transaction pooler(:6543) — named prepared stmt 금지
//   - bcryptjs       : 비밀번호 해시 (salt rounds 10)
//   - jsonwebtoken   : { userId, email } / HS256 / 7일
//   - dotenv         : DATABASE_URL, JWT_SECRET 은 .env 로만
//
// 테이블 3개 (roof_ 접두사 — 같은 Supabase 의 todos/community/maum_ 등과 격리):
//   roof_users     (id, email UNIQUE, password_hash, name, created_at)
//   roof_estimates (id, title, memo, data JSONB, meta JSONB,
//                   created_by/updated_by → roof_users, created_at, updated_at)
//   roof_prices    (id=1 싱글턴, overrides JSONB, updated_by, updated_at)
//
// 응답 봉투: { success, data, message } — 성공/실패 공통. password_hash 절대 미반환.
// 안도공간 단일팀 공유: 로그인한 직원은 모든 견적 조회/수정/삭제 가능(작성자는 표기용).
// V4-4: 가입 초대코드 요구 제거 (사용자 요청, 2026-07-12) — 이메일/비번/이름만으로 가입.
// ============================================================

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// 3014=bean-shop 까지 사용 → 이 앱은 3015
const PORT = Number((process.env.PORT || '3015').trim());
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d';
const SALT_ROUNDS = 10;
const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ----------------------------------------
// PostgreSQL 연결 풀 (Supabase — SSL 필수, pooler 라 max 5)
// ----------------------------------------
const connectionString = (process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

pool.on('error', (err) => {
  console.error('⚠️  PostgreSQL 풀 오류(유휴 커넥션):', err.message);
});

// ----------------------------------------
// 테이블 자동 생성 (lazy init, 최초 1회)
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roof_users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roof_estimates (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title      TEXT NOT NULL DEFAULT '새 견적',
      memo       TEXT NOT NULL DEFAULT '',
      data       JSONB NOT NULL,
      meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES roof_users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES roof_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roof_prices (
      id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      overrides  JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by UUID REFERENCES roof_users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbInitialized = true;
  console.log('✅ DB 초기화 완료 (roof_users / roof_estimates / roof_prices)');
}

// ----------------------------------------
// 응답 헬퍼
// ----------------------------------------
function ok(res, status, data, message) {
  return res.status(status).json({ success: true, data, message: message || '' });
}
function fail(res, status, message) {
  return res.status(status).json({ success: false, data: null, message });
}

// ----------------------------------------
// JWT 헬퍼 + 인증 미들웨어
// ----------------------------------------
function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

function toPublicUser(row) {
  return { id: row.id, email: row.email, name: row.name };
}

async function authRequired(req, res, next) {
  try {
    if (!JWT_SECRET) return fail(res, 503, '서버 설정 오류: JWT_SECRET 미설정');
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) return fail(res, 401, '로그인이 필요합니다 (Authorization: Bearer <token>)');
    let payload;
    try {
      payload = jwt.verify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return fail(res, 401, '토큰이 유효하지 않거나 만료되었습니다');
    }
    await initDB();
    const { rows } = await pool.query(
      'SELECT id, email, name FROM roof_users WHERE id = $1',
      [payload.userId]
    );
    if (!rows[0]) return fail(res, 401, '존재하지 않는 사용자입니다');
    req.user = rows[0];
    next();
  } catch (err) {
    console.error('authRequired 오류:', err);
    return fail(res, 500, '서버 오류');
  }
}

// ----------------------------------------
// 미들웨어: JSON 바디(견적 data 가 커질 수 있어 2mb) + 정적 서빙
// .env 등 dotfile 은 express.static 기본값(ignore)으로 서빙되지 않지만 명시해 둔다.
// ----------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname, { dotfiles: 'ignore', index: 'index.html' }));

// ----------------------------------------
// 헬스체크 — 프론트가 서버모드/로컬모드 판별에 사용
// ----------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    await initDB();
    await pool.query('SELECT 1');
    return ok(res, 200, { ok: true, db: 'up', app: 'roof-estimate', port: PORT });
  } catch (err) {
    return ok(res, 200, { ok: true, db: 'down', error: err.message });
  }
});

// ============================================================
// 인증 API
// ============================================================

// 회원가입
app.post('/api/auth/signup', async (req, res) => {
  try {
    await initDB();
    const { email, password, name } = req.body || {};
    const normEmail = String(email || '').trim().toLowerCase();
    const rawPassword = String(password || '');
    const normName = String(name || '').trim();

    // V4-4: 초대코드 요구 제거 (사용자 요청) — 보내와도 무시
    if (!EMAIL_RE.test(normEmail)) return fail(res, 400, '올바른 이메일을 입력해 주세요');
    if (rawPassword.length < MIN_PASSWORD) return fail(res, 400, `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);
    if (!normName) return fail(res, 400, '이름(표시명)을 입력해 주세요');

    const dup = await pool.query('SELECT id FROM roof_users WHERE email = $1', [normEmail]);
    if (dup.rows[0]) return fail(res, 409, '이미 가입된 이메일입니다');

    const passwordHash = await bcrypt.hash(rawPassword, SALT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO roof_users (email, password_hash, name)
       VALUES ($1, $2, $3) RETURNING id, email, name`,
      [normEmail, passwordHash, normName]
    );
    const user = rows[0];
    return ok(res, 201, { token: signToken(user), user: toPublicUser(user) }, '가입 완료');
  } catch (err) {
    console.error('signup 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// 로그인
app.post('/api/auth/login', async (req, res) => {
  try {
    await initDB();
    const normEmail = String((req.body || {}).email || '').trim().toLowerCase();
    const rawPassword = String((req.body || {}).password || '');
    if (!EMAIL_RE.test(normEmail) || !rawPassword) {
      return fail(res, 400, '이메일과 비밀번호를 입력해 주세요');
    }
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash FROM roof_users WHERE email = $1',
      [normEmail]
    );
    const row = rows[0];
    // 계정 존재 여부를 구분해 주지 않는다 (열거 방지) — 동일 메시지
    if (!row) return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않습니다');
    const match = await bcrypt.compare(rawPassword, row.password_hash);
    if (!match) return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않습니다');
    return ok(res, 200, { token: signToken(row), user: toPublicUser(row) }, '로그인 성공');
  } catch (err) {
    console.error('login 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// 내 정보
app.get('/api/auth/me', authRequired, (req, res) => {
  return ok(res, 200, { user: toPublicUser(req.user) });
});

// ============================================================
// 견적 API — 팀 공유 (로그인 필수)
// estimate 행 → 프론트 형태로 변환. 목록은 data 를 빼고 가볍게.
// meta 는 프론트가 저장 시 보내는 표시용 스냅샷 { grandTotal, address, floorSum, date } 등.
// ============================================================
function toListItem(row) {
  return {
    id: row.id,
    title: row.title,
    memo: row.memo,
    meta: row.meta || {},
    creatorName: row.creator_name || '(탈퇴)',
    updaterName: row.updater_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const LIST_SQL = `
  SELECT e.id, e.title, e.memo, e.meta, e.created_at, e.updated_at,
         cu.name AS creator_name, uu.name AS updater_name
  FROM roof_estimates e
  LEFT JOIN roof_users cu ON cu.id = e.created_by
  LEFT JOIN roof_users uu ON uu.id = e.updated_by
`;

// 목록 (data 제외, 최근 수정순)
app.get('/api/estimates', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(`${LIST_SQL} ORDER BY e.updated_at DESC`);
    return ok(res, 200, { estimates: rows.map(toListItem) });
  } catch (err) {
    console.error('estimates list 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// 생성
app.post('/api/estimates', authRequired, async (req, res) => {
  try {
    const { title, memo, data, meta } = req.body || {};
    if (!data || typeof data !== 'object') return fail(res, 400, 'data(견적 JSON)가 필요합니다');
    const { rows } = await pool.query(
      `INSERT INTO roof_estimates (title, memo, data, meta, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      [
        String(title || '새 견적').slice(0, 200),
        String(memo || '').slice(0, 2000),
        JSON.stringify(data),
        JSON.stringify(meta || {}),
        req.user.id,
      ]
    );
    const listed = await pool.query(`${LIST_SQL} WHERE e.id = $1`, [rows[0].id]);
    return ok(res, 201, { estimate: toListItem(listed.rows[0]) }, '저장 완료');
  } catch (err) {
    console.error('estimates create 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// 단건 (data 포함)
app.get('/api/estimates/:id', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${LIST_SQL.replace('SELECT e.id,', 'SELECT e.data, e.id,')} WHERE e.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return fail(res, 404, '견적을 찾을 수 없습니다');
    return ok(res, 200, { estimate: { ...toListItem(rows[0]), data: rows[0].data } });
  } catch (err) {
    if (String(err.message || '').includes('invalid input syntax for type uuid')) {
      return fail(res, 404, '견적을 찾을 수 없습니다');
    }
    console.error('estimates get 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// 수정 (부분 업데이트: title / memo / data / meta 중 온 것만)
app.put('/api/estimates/:id', authRequired, async (req, res) => {
  try {
    const { title, memo, data, meta } = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;
    if (title !== undefined) { sets.push(`title = $${i++}`); params.push(String(title).slice(0, 200)); }
    if (memo !== undefined) { sets.push(`memo = $${i++}`); params.push(String(memo).slice(0, 2000)); }
    if (data !== undefined) {
      if (!data || typeof data !== 'object') return fail(res, 400, 'data 는 객체여야 합니다');
      sets.push(`data = $${i++}`); params.push(JSON.stringify(data));
    }
    if (meta !== undefined) { sets.push(`meta = $${i++}`); params.push(JSON.stringify(meta || {})); }
    if (!sets.length) return fail(res, 400, '수정할 내용이 없습니다');
    sets.push(`updated_by = $${i++}`); params.push(req.user.id);
    sets.push(`updated_at = now()`);
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE roof_estimates SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
      params
    );
    if (!rows[0]) return fail(res, 404, '견적을 찾을 수 없습니다');
    const listed = await pool.query(`${LIST_SQL} WHERE e.id = $1`, [rows[0].id]);
    return ok(res, 200, { estimate: toListItem(listed.rows[0]) }, '수정 완료');
  } catch (err) {
    if (String(err.message || '').includes('invalid input syntax for type uuid')) {
      return fail(res, 404, '견적을 찾을 수 없습니다');
    }
    console.error('estimates update 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// 삭제
app.delete('/api/estimates/:id', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM roof_estimates WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return fail(res, 404, '견적을 찾을 수 없습니다');
    return ok(res, 200, { id: rows[0].id }, '삭제 완료');
  } catch (err) {
    if (String(err.message || '').includes('invalid input syntax for type uuid')) {
      return fail(res, 404, '견적을 찾을 수 없습니다');
    }
    console.error('estimates delete 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// ============================================================
// 자재 단가 오버라이드 API (자재DB 탭)
// overrides = { items: { <itemId>: {mat?, lab?, sub?} }, equip: { <장비명>: <단가> } }
// 전체 맵을 통째로 저장/조회 (싱글턴 행 id=1). 빈 값/미지정 = 기본단가 사용.
// ============================================================
app.get('/api/prices', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.overrides, p.updated_at, u.name AS updated_by_name
       FROM roof_prices p LEFT JOIN roof_users u ON u.id = p.updated_by
       WHERE p.id = 1`
    );
    if (!rows[0]) return ok(res, 200, { overrides: {}, updatedAt: null, updatedByName: null });
    return ok(res, 200, {
      overrides: rows[0].overrides || {},
      updatedAt: rows[0].updated_at,
      updatedByName: rows[0].updated_by_name || null,
    });
  } catch (err) {
    console.error('prices get 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

app.put('/api/prices', authRequired, async (req, res) => {
  try {
    const overrides = (req.body || {}).overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return fail(res, 400, 'overrides 객체가 필요합니다');
    }
    await pool.query(
      `INSERT INTO roof_prices (id, overrides, updated_by, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET overrides = EXCLUDED.overrides,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [JSON.stringify(overrides), req.user.id]
    );
    return ok(res, 200, { overrides }, '단가 저장 완료');
  } catch (err) {
    console.error('prices put 오류:', err);
    return fail(res, 500, '서버 오류');
  }
});

// ----------------------------------------
// 나머지 /api/* 는 404 (정적 폴백으로 흘러가지 않게)
// ----------------------------------------
app.all(/^\/api\//, (req, res) => fail(res, 404, '존재하지 않는 API 입니다'));

// ----------------------------------------
// 부팅 — 직접 실행 시에만 listen (Vercel 서버리스는 module.exports 사용)
// ----------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🏗️  역전지붕 견적 서버: http://localhost:${PORT}`);
    if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET 이 비어 있습니다 — .env 확인');
    if (!connectionString) console.warn('⚠️  DATABASE_URL 이 비어 있습니다 — DB 기능 불가');
    initDB().catch((err) => console.error('DB 초기화 실패(요청 시 재시도):', err.message));
  });
}

module.exports = app;
