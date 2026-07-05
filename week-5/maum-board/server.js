// ========================================
// 💌  마음 한 조각 v2 백엔드 (Supabase PostgreSQL + JWT 인증)
// AFM week-5 / maum-board (Server + DB + Auth)
//
// week-4 "익명" 고민·칭찬 게시판의 Auth 업그레이드 버전.
//   익명판:  누가 썼는지 모름 · 공감은 무제한 +1
//   이번판:  "이 글은 OO님이 썼다" · 내 글만 수정/삭제 · 공감은 1인 1개(토글)
//
//   - Express        : 정적 파일(index.html) 서빙 + REST API 제공
//   - pg(Pool)       : Supabase(Supavisor transaction pooler, :6543)에 연결
//   - dotenv         : 자격 증명을 .env 에서만 읽음 (코드에 하드코딩 금지)
//   - bcryptjs       : 비밀번호 해시(salt rounds 10) 저장 + 로그인 시 compare
//   - jsonwebtoken   : { userId, email } 페이로드 / 만료 7일 / HS256 서명
//
// 테이블 3개 (maum_ 접두사로 같은 Supabase 의 다른 앱들과 격리):
//   maum_users (id, email UNIQUE, password_hash, nickname, created_at)
//   maum_posts (id, user_id → maum_users.id CASCADE, category, title, content,
//               created_at, updated_at)
//   maum_likes (post_id, user_id, PRIMARY KEY(post_id,user_id))
//     ⚠️ week-4 는 posts.likes INT 를 UPDATE +1 했지만, 이제 "누가" 눌렀는지 알 수
//        있으므로 공감을 행(row)으로 저장한다 → 1인 1공감 + 다시 누르면 취소(토글).
//
// 접근 모델 (미션의 핵심 구조 그대로):
//   [게시글 목록/상세] = 전체 공개 (로그인 없이도 읽기 가능, 토큰 있으면 isMine/likedByMe 계산)
//   [글쓰기/공감]      = 로그인한 사람만
//   [수정/삭제]        = 본인 글만 (타인 글은 WHERE 매칭 실패 → 404)
//
// 공유 API 계약:
//   응답 봉투: 성공 { success:true, data, message } / 실패 { success:false, data:null, message }
//   user = { id, email, nickname }   (password_hash 는 절대 반환하지 않는다)
//   post = { id, category, title, content, authorId, authorName,
//            createdAt, updatedAt, isMine, likeCount, likedByMe }
//
// 🔐 보안: DATABASE_URL/JWT_SECRET 은 process.env 로만 읽고 .env 는 .gitignore 로 제외.
//          비밀번호 평문/해시·서명키를 응답에 절대 싣지 않는다.
// ========================================

require('dotenv').config(); // .env → process.env 로 로드 (가장 먼저 실행)

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// PORT 는 .env 에서, 없으면 3012. (3005~3011 은 옆 폴더 앱들이 사용 중)
const PORT = Number((process.env.PORT || '3012').trim());

// JWT 서명 비밀. 환경변수에 trailing newline 이 붙는 플랫폼이 있어 .trim() 으로 방어.
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES_IN = '7d'; // 토큰 만료 7일

// ----------------------------------------
// PostgreSQL 연결 풀
//
// ⚠️ DATABASE_URL 은 Supabase 트랜잭션 풀러(:6543, pgBouncer)다.
//    표준 파라미터 쿼리(pool.query(text, params))만 쓰고 named prepared statement 는 쓰지 않는다.
// Supabase 는 SSL 필수 → rejectUnauthorized:false (self-signed 체인 허용).
// ----------------------------------------
const connectionString = (process.env.DATABASE_URL || '').trim();

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5, // 풀 최대 커넥션 (pooler 환경에 적당)
});

// 풀 차원의 예기치 못한 에러(유휴 커넥션 끊김 등)로 프로세스가 죽지 않도록.
pool.on('error', (err) => {
  console.error('⚠️  PostgreSQL 풀 오류(유휴 커넥션):', err.message);
});

// ----------------------------------------
// 테이블 자동 생성 (lazy init, 최초 1회)
// CREATE TABLE IF NOT EXISTS 라서 이미 있으면 아무 일도 안 한다.
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;

  // gen_random_uuid() 사용을 위한 확장 (Supabase 에선 보통 이미 활성화. 안전하게 보장)
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // 회원 테이블
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maum_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 게시글 테이블 (week-4 posts 에 없던 것: user_id 작성자 + title 제목)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maum_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES maum_users(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT '고민',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 공감 테이블 — (글, 사람) 쌍이 기본키라서 같은 글에 두 번 공감할 수 없다(1인 1공감).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maum_likes (
      post_id UUID NOT NULL REFERENCES maum_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES maum_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    );
  `);

  // 목록은 최신순 정렬 → created_at 인덱스로 가속
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_maum_posts_created ON maum_posts(created_at DESC);'
  );
  await pool.query('CREATE INDEX IF NOT EXISTS idx_maum_posts_user ON maum_posts(user_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_maum_likes_post ON maum_likes(post_id);');

  dbInitialized = true;
  console.log('🗄️  maum_users / maum_posts / maum_likes 테이블 준비 완료.');
}

// ========================================
// 미들웨어 설정
// ========================================
app.use(express.json());

// 정적 파일 서빙: 같은 폴더의 index.html 제공
app.use(express.static(path.join(__dirname)));

// /api/* 요청은 처리 전에 테이블이 준비됐는지 보장 (서버리스 cold start 대응)
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
// ----------------------------------------
const ok = (res, status, data, message) =>
  res.status(status).json({ success: true, data, message: message || 'OK' });

const fail = (res, status, message) =>
  res.status(status).json({ success: false, data: null, message });

const asString = (v) => (typeof v === 'string' ? v.trim() : '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (email) => EMAIL_RE.test(email);

const NICKNAME_MAX = 20; // 닉네임 1~20자
const TITLE_MAX = 100; // 제목 1~100자
const CONTENT_MAX = 2000; // 내용 1~2000자
const CATEGORIES = ['고민', '칭찬', '응원']; // week-4 와 동일한 3종

// DB row → 클라이언트 모델 (password_hash 는 절대 포함하지 않는다)
const rowToUser = (row) => ({
  id: row.id,
  email: row.email,
  nickname: row.nickname,
});

// post row → 클라이언트 모델.
//   author_name / like_count / liked_by_me 는 SELECT 에서 서브쿼리·JOIN 으로 함께 받는다.
//   isMine 은 서버가 현재 로그인 사용자와 비교해 계산 (비로그인 = 항상 false).
const rowToPost = (row, currentUserId) => ({
  id: row.id,
  category: row.category,
  title: row.title,
  content: row.content,
  authorId: row.user_id,
  authorName: row.author_name,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  isMine: !!currentUserId && row.user_id === currentUserId,
  likeCount: Number(row.like_count) || 0,
  likedByMe: row.liked_by_me === true,
});

// ========================================
// 인증 (Auth)
// ========================================

// JWT 발급: payload { userId, email }, 만료 7일, HS256.
// (nickname 은 변경될 수 있는 값이라 토큰에 싣지 않는다 — DB 가 진실원본)
function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

// authMiddleware: Authorization: Bearer <token> 검증 → req.user = payload. 없거나 무효면 401.
// (글쓰기 · 수정 · 삭제 · 공감 등 "로그인해야만" 되는 라우트에 사용)
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
    return fail(res, 401, '로그인이 필요합니다.');
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET); // { userId, email, iat, exp }
    next();
  } catch (_err) {
    return fail(res, 401, '세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.');
  }
}

// optionalAuth: 토큰이 있고 유효하면 req.user 를 채우고, 없거나 무효면 그냥 익명(null)으로 통과.
// (목록/상세 조회는 "전체 공개"라서 401 을 던지지 않는다 — 대신 isMine/likedByMe 만 달라진다)
function optionalAuth(req, _res, next) {
  req.user = null;
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (JWT_SECRET && scheme === 'Bearer' && token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (_err) {
      req.user = null; // 만료된 토큰으로도 목록은 볼 수 있게 익명 취급
    }
  }
  next();
}

// ----------------------------------------
// POST /api/auth/signup  body { email, password, nickname }
//   → 201 { token, user }  (이메일 중복 409, 검증 실패 400)
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
    const nickname = asString(req.body && req.body.nickname);

    if (!email || !isValidEmail(email)) {
      return fail(res, 400, '올바른 이메일 형식을 입력해 주세요.');
    }
    if (password.length < 6) {
      return fail(res, 400, '비밀번호는 최소 6자 이상이어야 합니다.');
    }
    if (!nickname) {
      return fail(res, 400, '닉네임을 입력해 주세요.');
    }
    if (nickname.length > NICKNAME_MAX) {
      return fail(res, 400, `닉네임은 최대 ${NICKNAME_MAX}자까지 가능합니다.`);
    }

    // 이미 가입된 이메일인지 선조회 (UNIQUE 제약과 더불어 친절한 409 메시지)
    const existing = await pool.query('SELECT id FROM maum_users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return fail(res, 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO maum_users (email, password_hash, nickname)
         VALUES ($1, $2, $3)
         RETURNING id, email, nickname`,
        [email, passwordHash, nickname]
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
    return ok(res, 201, { token, user }, `${user.nickname}님, 환영해요! 회원가입이 완료되었습니다.`);
  } catch (err) {
    console.error('POST /api/auth/signup 오류:', err.message);
    return fail(res, 500, '회원가입 중 오류가 발생했습니다.');
  }
});

// ----------------------------------------
// POST /api/auth/login  body { email, password } → 200 { token, user } (자격 불일치 401)
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
      'SELECT id, email, nickname, password_hash FROM maum_users WHERE email = $1',
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
    return ok(res, 200, { token, user }, `${user.nickname}님, 다시 만나 반가워요!`);
  } catch (err) {
    console.error('POST /api/auth/login 오류:', err.message);
    return fail(res, 500, '로그인 중 오류가 발생했습니다.');
  }
});

// ----------------------------------------
// GET /api/auth/me  (Bearer) → 200 { user }  — 새로고침 시 세션 복원용
// ----------------------------------------
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, nickname FROM maum_users WHERE id = $1', [
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
// REST API — 게시글(posts)
//
//   조회(GET)             : 공개 (optionalAuth — 토큰 있으면 isMine/likedByMe 반영)
//   작성(POST)            : 로그인 필요. 작성자 = 현재 사용자
//   수정/삭제(PUT/DELETE)  : 본인 글만. WHERE id AND user_id → 타인 소유는 매칭 0건 = 404
//   공감(POST /:id/like)   : 로그인 필요. 토글(누르면 +1, 다시 누르면 취소) — 1인 1공감
//
// 모든 쿼리는 파라미터화($1,$2…) → SQL injection 방지.
// ========================================

// 작성자 닉네임 + 공감 수 + 내가 눌렀는지 를 함께 가져오는 공통 SELECT.
//   $1 = 현재 사용자 id (비로그인일 땐 null → liked_by_me 는 항상 false)
const POST_SELECT = `
  SELECT p.id, p.user_id, p.category, p.title, p.content, p.created_at, p.updated_at,
         u.nickname AS author_name,
         (SELECT COUNT(*)::int FROM maum_likes l WHERE l.post_id = p.id) AS like_count,
         EXISTS(
           SELECT 1 FROM maum_likes l WHERE l.post_id = p.id AND l.user_id = $1::uuid
         ) AS liked_by_me
  FROM maum_posts p
  JOIN maum_users u ON u.id = p.user_id
`;

// --- GET /api/posts?category=고민&sort=latest|popular : 전체 글 목록 (공개) ---
//   category 를 주면 해당 카테고리만(WHERE), sort=popular 면 공감순(ORDER BY like_count).
app.get('/api/posts', optionalAuth, async (req, res) => {
  try {
    const currentUserId = req.user ? req.user.userId : null;
    const category = asString(req.query.category);
    const sort = asString(req.query.sort) === 'popular' ? 'popular' : 'latest';

    const params = [currentUserId];
    let where = '';
    if (category && CATEGORIES.includes(category)) {
      params.push(category);
      where = ` WHERE p.category = $${params.length}`;
    }
    const orderBy =
      sort === 'popular'
        ? ' ORDER BY like_count DESC, p.created_at DESC' // 공감순 (동률이면 최신 먼저)
        : ' ORDER BY p.created_at DESC'; // 최신순 (기본)

    const { rows } = await pool.query(POST_SELECT + where + orderBy, params);
    const posts = rows.map((row) => rowToPost(row, currentUserId));
    return ok(res, 200, posts, '게시글 목록을 불러왔습니다.');
  } catch (err) {
    console.error('GET /api/posts 오류:', err.message);
    return fail(res, 500, '게시글 목록을 불러오지 못했습니다.');
  }
});

// --- GET /api/posts/:id : 단일 글 상세 (공개) --- 없으면 404. 잘못된 UUID(22P02)도 404.
app.get('/api/posts/:id', optionalAuth, async (req, res) => {
  try {
    const currentUserId = req.user ? req.user.userId : null;
    const { rows } = await pool.query(`${POST_SELECT} WHERE p.id = $2`, [
      currentUserId,
      req.params.id,
    ]);
    if (rows.length === 0) {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    return ok(res, 200, rowToPost(rows[0], currentUserId), '게시글을 불러왔습니다.');
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    console.error('GET /api/posts/:id 오류:', err.message);
    return fail(res, 500, '게시글을 불러오지 못했습니다.');
  }
});

// 제목/내용/카테고리 공통 검증 → 에러 메시지 or null
function validatePostBody(body) {
  const category = asString(body && body.category) || '고민';
  const title = asString(body && body.title);
  const content = asString(body && body.content);
  if (!CATEGORIES.includes(category)) {
    return { error: `카테고리는 ${CATEGORIES.join('/')} 중 하나여야 합니다.` };
  }
  if (!title) return { error: '제목을 입력해 주세요.' };
  if (title.length > TITLE_MAX) return { error: `제목은 최대 ${TITLE_MAX}자까지 가능합니다.` };
  if (!content) return { error: '내용을 입력해 주세요.' };
  if (content.length > CONTENT_MAX) {
    return { error: `내용은 최대 ${CONTENT_MAX}자까지 가능합니다.` };
  }
  return { category, title, content };
}

// --- POST /api/posts : 글 작성 (로그인 필요) --- body { category, title, content }
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const v = validatePostBody(req.body);
    if (v.error) return fail(res, 400, v.error);

    // INSERT 하면서 작성자 닉네임도 서브쿼리로 함께 (새 글은 공감 0 / 내가 안 누름이 자명)
    const { rows } = await pool.query(
      `INSERT INTO maum_posts (user_id, category, title, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, category, title, content, created_at, updated_at,
         (SELECT nickname FROM maum_users WHERE id = $1) AS author_name,
         0 AS like_count, FALSE AS liked_by_me`,
      [req.user.userId, v.category, v.title, v.content]
    );
    return ok(res, 201, rowToPost(rows[0], req.user.userId), '마음을 남겼어요. 💌');
  } catch (err) {
    console.error('POST /api/posts 오류:', err.message);
    return fail(res, 500, '게시글을 저장하지 못했습니다.');
  }
});

// --- PUT /api/posts/:id : 글 수정 (본인 글만) --- body { category, title, content }
app.put('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const v = validatePostBody(req.body);
    if (v.error) return fail(res, 400, v.error);

    // WHERE 에 user_id 를 함께 걸어 타인 소유는 매칭 자체가 안 됨 → 404 (소유 여부 노출 최소화)
    const { rows } = await pool.query(
      `UPDATE maum_posts
       SET category = $1, title = $2, content = $3, updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING id, user_id, category, title, content, created_at, updated_at,
         (SELECT nickname FROM maum_users WHERE id = $5) AS author_name,
         (SELECT COUNT(*)::int FROM maum_likes l WHERE l.post_id = maum_posts.id) AS like_count,
         EXISTS(
           SELECT 1 FROM maum_likes l WHERE l.post_id = maum_posts.id AND l.user_id = $5
         ) AS liked_by_me`,
      [v.category, v.title, v.content, id, req.user.userId]
    );

    if (rows.length === 0) {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    return ok(res, 200, rowToPost(rows[0], req.user.userId), '게시글을 수정했습니다.');
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    console.error('PUT /api/posts/:id 오류:', err.message);
    return fail(res, 500, '게시글을 수정하지 못했습니다.');
  }
});

// --- DELETE /api/posts/:id : 글 삭제 (본인 글만, 아니면 404) ---
app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'DELETE FROM maum_posts WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    if (rowCount === 0) {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    return ok(res, 200, { id }, '게시글을 삭제했습니다.');
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    console.error('DELETE /api/posts/:id 오류:', err.message);
    return fail(res, 500, '게시글을 삭제하지 못했습니다.');
  }
});

// --- POST /api/posts/:id/like : 공감 토글 (로그인 필요) ---
//   week-4 학습 포인트의 업그레이드: 익명판은 "무제한 +1 UPDATE"였지만,
//   Auth 가 생기면서 (글, 사람) 쌍을 기록 → 1인 1공감, 다시 누르면 취소.
//   응답: 갱신된 post 전체 (likeCount / likedByMe 포함) → 프런트는 그대로 치환만 하면 됨.
app.post('/api/posts/:id/like', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // 글 존재 확인 (없으면 404)
    const found = await pool.query('SELECT id FROM maum_posts WHERE id = $1', [id]);
    if (found.rows.length === 0) {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }

    // 토글: 이미 눌렀으면(충돌) INSERT 가 0건 → DELETE 로 취소
    const inserted = await pool.query(
      `INSERT INTO maum_likes (post_id, user_id) VALUES ($1, $2)
       ON CONFLICT (post_id, user_id) DO NOTHING`,
      [id, req.user.userId]
    );
    let liked = inserted.rowCount > 0;
    if (!liked) {
      await pool.query('DELETE FROM maum_likes WHERE post_id = $1 AND user_id = $2', [
        id,
        req.user.userId,
      ]);
    }

    // 갱신된 글을 통째로 반환
    const { rows } = await pool.query(`${POST_SELECT} WHERE p.id = $2`, [req.user.userId, id]);
    if (rows.length === 0) {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    return ok(
      res,
      200,
      rowToPost(rows[0], req.user.userId),
      liked ? '이 마음에 공감했어요. 💗' : '공감을 취소했어요.'
    );
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 404, '해당 게시글을 찾을 수 없습니다.');
    }
    console.error('POST /api/posts/:id/like 오류:', err.message);
    return fail(res, 500, '공감 처리에 실패했습니다.');
  }
});

// ----------------------------------------
// 정의되지 않은 /api/* 경로 → JSON 404 (SPA 폴백이 HTML 을 주지 않도록 먼저 처리)
// ----------------------------------------
app.use('/api', (_req, res) => {
  return fail(res, 404, '요청한 API 경로를 찾을 수 없습니다.');
});

// ========================================
// SPA / 정적 폴백 — /api 가 아닌 모든 경로는 index.html (반드시 /api 라우트들보다 아래)
// ========================================
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========================================
// 에러 처리 미들웨어 (마지막 안전망) — 잘못된 JSON 본문 등도 JSON 으로 응답
// ========================================
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, '요청 본문이 올바른 JSON 형식이 아닙니다.');
  }
  console.error('처리되지 않은 오류:', err);
  return fail(res, 500, '서버 내부 오류가 발생했습니다.');
});

// ========================================
// 서버 시작 — 로컬에서 직접 실행할 때만 listen (Vercel 서버리스 호환)
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 마음 한 조각 v2 서버 실행 중 → http://localhost:${PORT}`);
    if (!JWT_SECRET) {
      console.warn('⚠️  JWT_SECRET 이 비어 있습니다. .env 에 설정해야 인증이 동작합니다.');
    }
  });

  // 부팅 시 테이블 준비 + 연결 확인 (실패해도 서버는 계속 동작, /api 에서 재시도)
  initDB()
    .then(() => {
      console.log('🔌 Supabase PostgreSQL 연결 성공.');
    })
    .catch((err) => {
      console.error('❌ 서버 부팅 시 DB 연결/초기화 실패:', err.message);
      console.error('   .env 의 DATABASE_URL 을 확인하세요. (/api 요청에서 재시도합니다)');
    });
}

module.exports = app;
