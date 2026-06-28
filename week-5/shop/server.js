// ========================================
// 🍰 디저트 쇼핑몰 "스윗박스" 백엔드 (Supabase PostgreSQL 영속화 + JWT 인증)
// AFM week-5 / shop (Server + DB + Auth)
//
// 핵심: 상품 목록은 누구나(비로그인) 볼 수 있고, 장바구니는 로그인한 본인 것만 다룬다.
//   - Express        : 정적 파일(index.html) 서빙 + REST API 제공
//   - pg(Pool)       : Supabase(Supavisor transaction pooler, :6543)에 연결
//   - dotenv         : 자격 증명을 .env 에서만 읽음 (코드에 하드코딩 금지)
//   - bcryptjs       : 비밀번호 해시(salt rounds 10) 저장 + 로그인 시 compare
//   - jsonwebtoken   : { userId, email } 페이로드 / 만료 7일 / HS256 서명
//
// 테이블 3개 (shop_ 접두사로 기존 community/todos/my-food 앱과 격리):
//   shop_users    (id, email UNIQUE, password_hash, nickname, created_at)
//   shop_products (id SERIAL, name UNIQUE, price, image_url, description, emoji, gradient) — 부팅 시 12개 시드
//   shop_cart     (id UUID, user_id → shop_users, product_id → shop_products, quantity, created_at,
//                  UNIQUE(user_id, product_id) — 같은 상품을 다시 담으면 수량 증가)
//   ⚠️ 같은 Supabase 프로젝트에 community/todos/my-food 테이블이 이미 있으므로 절대 건드리지 않는다.
//      shop_ 접두사로만 작업한다.
//
// 공유 API 계약(프론트 index.html 의 `api` 객체와 정확히 일치):
//   응답 봉투: 성공 { success:true, data, message } / 실패 { success:false, data:null, message }
//   ⚠️ 프론트는 봉투를 벗긴 `data` 그 자체를 사용한다. 각 엔드포인트의 data 형태를 계약대로 맞춘다.
//   user      = { id, email, nickname }                         (password_hash 는 절대 반환 금지)
//   product   = { id, name, price, image_url, description, emoji, gradient }   (GET /api/products)
//   cart item = { id, quantity, product:{ id, name, price, image_url, emoji, gradient } }  (GET /api/cart)
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

// PORT 는 .env 에서, 없으면 3009. (옆 폴더 my-food=3005, todos=3006, quest=3007, community=3008 과 충돌 회피)
const PORT = Number((process.env.PORT || '3009').trim());

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
// 시드 상품 12개 (name, price, description, emoji, gradient, image_url)
//   name 에 UNIQUE 제약 → ON CONFLICT (name) DO NOTHING 으로 멱등 삽입.
//   서버리스 cold start 마다 initDB 가 호출돼도 중복 없이 안전하다.
// ----------------------------------------
const SEED_PRODUCTS = [
  ['딸기 생크림 케이크', 28000, '촉촉한 시트에 신선한 국산 딸기와 부드러운 생크림을 듬뿍 올렸어요.', '🍰', 'from-strawberry-100 to-rose-200', 'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=70'],
  ['가나슈 초콜릿 케이크', 32000, '진한 벨기에 다크 초콜릿 가나슈로 감싼 리치한 케이크.', '🎂', 'from-amber-100 to-orange-200', 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600&auto=format&fit=crop&q=70'],
  ['프렌치 마카롱 6구', 15000, '파리지앵 감성 그대로, 6가지 맛이 한 상자에.', '🌈', 'from-pink-100 to-fuchsia-200', 'https://images.unsplash.com/photo-1569864358642-9d1684040f43?w=600&auto=format&fit=crop&q=70'],
  ['버터 쿠키 박스', 12000, '고소한 발효버터로 구운 바삭한 수제 쿠키 한 박스.', '🍪', 'from-amber-100 to-yellow-200', 'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=600&auto=format&fit=crop&q=70'],
  ['클래식 크루아상', 4500, '27겹 결결이 살아있는 프랑스산 버터 크루아상.', '🥐', 'from-yellow-100 to-amber-200', 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600&auto=format&fit=crop&q=70'],
  ['포르투갈 에그타르트', 3800, '바삭한 페이스트리에 부드러운 커스터드가 가득.', '🥧', 'from-orange-100 to-amber-200', 'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=600&auto=format&fit=crop&q=70'],
  ['퍼지 브라우니', 6500, '쫀득하고 진한 초콜릿 브라우니, 커피와 환상 궁합.', '🍫', 'from-amber-200 to-orange-300', 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=600&auto=format&fit=crop&q=70'],
  ['레드벨벳 컵케이크', 5500, '벨벳처럼 부드러운 시트에 크림치즈 프로스팅.', '🧁', 'from-rose-100 to-red-200', 'https://images.unsplash.com/photo-1614707267537-b85aaf00c4b7?w=600&auto=format&fit=crop&q=70'],
  ['글레이즈드 도넛', 3500, '겉은 달콤 바삭, 속은 폭신한 클래식 도넛.', '🍩', 'from-pink-100 to-rose-200', 'https://images.unsplash.com/photo-1551024601-bec78aea704b?w=600&auto=format&fit=crop&q=70'],
  ['핸드드립 카페라떼', 5000, '스페셜티 원두로 내린 부드러운 라떼 한 잔.', '☕', 'from-amber-100 to-stone-200', 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=600&auto=format&fit=crop&q=70'],
  ['딸기 밀크쉐이크', 6000, '생딸기를 듬뿍 갈아 만든 진한 핑크빛 쉐이크.', '🥤', 'from-strawberry-100 to-pink-200', 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=600&auto=format&fit=crop&q=70'],
  ['클래식 티라미수', 8500, '마스카르포네와 에스프레소가 어우러진 이탈리안 디저트.', '🍮', 'from-amber-100 to-yellow-200', 'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=600&auto=format&fit=crop&q=70'],
];

// ----------------------------------------
// 테이블 자동 생성 + 상품 시드 (lazy init, 최초 1회)
//
// CREATE TABLE IF NOT EXISTS 라서 이미 있으면 아무 일도 안 한다.
// 서버리스(cold start)에서 여러 번 호출돼도 안전하도록 flag 로 중복 방지.
//
// gen_random_uuid() 를 쓰려면 pgcrypto 확장이 필요 → CREATE EXTENSION IF NOT EXISTS pgcrypto.
//
// 스키마:
//   shop_users
//     id            UUID         기본키 (gen_random_uuid())
//     email         TEXT         로그인 이메일 (UNIQUE, NOT NULL)
//     password_hash TEXT         bcrypt 해시 (NOT NULL) — 절대 응답에 싣지 않음
//     nickname      TEXT         표시 이름 (NOT NULL)
//     created_at    TIMESTAMPTZ  생성 시각 (기본 now())
//   shop_products
//     id            SERIAL       기본키 (정수, 프론트가 숫자 id 로 사용)
//     name          TEXT         상품명 (UNIQUE, NOT NULL) — 시드 멱등성용
//     price         INTEGER      가격(원, NOT NULL)
//     image_url     TEXT         상품 이미지 URL
//     description   TEXT         상품 설명
//     emoji         TEXT         UI 폴백용 이모지
//     gradient      TEXT         UI 폴백용 Tailwind 그라데이션 클래스
//   shop_cart
//     id            UUID         기본키 (gen_random_uuid())
//     user_id       UUID         담은 사람 (shop_users.id 참조, ON DELETE CASCADE)
//     product_id    INTEGER      담은 상품 (shop_products.id 참조, ON DELETE CASCADE)
//     quantity      INTEGER      수량 (기본 1, CHECK quantity>0)
//     created_at    TIMESTAMPTZ  담은 시각 (기본 now())
//     UNIQUE(user_id, product_id)  같은 상품 재담기 → 수량 증가(upsert)용
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;

  // gen_random_uuid() 사용을 위한 확장 (Supabase 에선 보통 이미 활성화돼 있음. 안전하게 보장)
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  // 회원 테이블
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 상품 테이블 (name UNIQUE → 시드 멱등성)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_products (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      price INTEGER NOT NULL,
      image_url TEXT,
      description TEXT,
      emoji TEXT,
      gradient TEXT
    );
  `);

  // 장바구니 테이블 (회원·상품 삭제 시 함께 삭제, 같은 상품은 한 행으로 묶어 수량 관리)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_cart (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, product_id)
    );
  `);

  // 본인 장바구니 조회 가속
  await pool.query('CREATE INDEX IF NOT EXISTS idx_shop_cart_user ON shop_cart(user_id);');

  // 상품 12개 시드 (멱등: ON CONFLICT (name) DO NOTHING — 한 번의 멀티로우 INSERT)
  const valuesSql = SEED_PRODUCTS.map((_, i) => {
    const b = i * 6;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
  }).join(', ');
  await pool.query(
    `INSERT INTO shop_products (name, price, description, emoji, gradient, image_url)
     VALUES ${valuesSql}
     ON CONFLICT (name) DO NOTHING`,
    SEED_PRODUCTS.flat()
  );

  dbInitialized = true;
  console.log('🗄️  shop_users / shop_products / shop_cart 테이블 준비 완료 (상품 시드 멱등 삽입).');
}

// ========================================
// 미들웨어 설정
// ========================================
app.use(express.json()); // JSON 본문 파싱 (POST/PATCH 용)

// 정적 파일 서빙: 같은 폴더의 index.html(프론트엔드) 제공
app.use(express.static(path.join(__dirname)));

// /api/* 요청은 처리 전에 테이블/시드가 준비됐는지 보장한다.
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

const NICKNAME_MAX = 20; // 닉네임 최대 길이 (trim 후 1~20자)

// DB row → 클라이언트 모델 매핑 (snake_case → camelCase)
// ⚠️ user 는 password_hash 를 절대 포함하지 않는다.
const rowToUser = (row) => ({
  id: row.id,
  email: row.email,
  nickname: row.nickname,
});

// 장바구니 JOIN row → 클라이언트 cart item.
//   프론트는 item.product.{name,price,image_url,emoji,gradient} 로 접근하므로 product 를 중첩 객체로 매핑.
const rowToCartItem = (row) => ({
  id: row.id,
  quantity: row.quantity,
  product: {
    id: row.product_id,
    name: row.name,
    price: row.price,
    image_url: row.image_url,
    emoji: row.emoji,
    gradient: row.gradient,
  },
});

// 장바구니 + 상품 JOIN 공통 SELECT (목록/단건 응답 공용)
const CART_SELECT_JOIN = `
  SELECT c.id, c.quantity, c.product_id,
         p.name, p.price, p.image_url, p.emoji, p.gradient
  FROM shop_cart c
  JOIN shop_products p ON p.id = c.product_id
`;

// ========================================
// 인증 (Auth)
// ========================================

// JWT 발급: payload { userId, email }, 만료 7일, HS256.
// (nickname 은 토큰에 싣지 않는다 — 변경 가능한 값이라 DB 가 진실원본.)
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
// POST /api/auth/signup  body { email, password, nickname }
//   → 201 { success:true, data:{ token, user:{id,email,nickname} } }
//   - 이메일 형식 + 비밀번호 최소 6자 + 닉네임 1~20자. 이미 가입된 이메일이면 409.
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

    // 이미 가입된 이메일인지 확인 (UNIQUE 제약과 더불어 친절한 409 메시지를 위해 선조회)
    const existing = await pool.query('SELECT id FROM shop_users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return fail(res, 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
    }

    const passwordHash = await bcrypt.hash(password, 10); // salt rounds 10

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO shop_users (email, password_hash, nickname)
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
    return ok(res, 201, { token, user }, '회원가입이 완료되었습니다.');
  } catch (err) {
    console.error('POST /api/auth/signup 오류:', err.message);
    return fail(res, 500, '회원가입 중 오류가 발생했습니다.');
  }
});

// ----------------------------------------
// POST /api/auth/login  body { email, password }
//   → 200 { success:true, data:{ token, user:{id,email,nickname} } } (자격 불일치 401)
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
      'SELECT id, email, nickname, password_hash FROM shop_users WHERE email = $1',
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
// GET /api/auth/me  (Bearer) → 200 { success:true, data:{ user:{id,email,nickname} } }
//   세션 복원용. 토큰의 userId 로 DB 를 다시 조회해 (탈퇴한 계정 등) 최신 상태를 확인.
// ----------------------------------------
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, nickname FROM shop_users WHERE id = $1',
      [req.user.userId]
    );
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
// 상품(products) — 공개(인증 불필요)
// ========================================

// --- GET /api/products : 전체 상품 목록 (id 오름차순) ---
//   data = [{ id, name, price, image_url, description, emoji, gradient }]
//   비로그인 사용자도 볼 수 있어야 하므로 authMiddleware 를 붙이지 않는다.
app.get('/api/products', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, price, image_url, description, emoji, gradient
       FROM shop_products
       ORDER BY id ASC`
    );
    return ok(res, 200, rows, '상품 목록을 불러왔습니다.');
  } catch (err) {
    console.error('GET /api/products 오류:', err.message);
    return fail(res, 500, '상품 목록을 불러오지 못했습니다.');
  }
});

// ========================================
// 장바구니(cart) — 전부 Bearer 필수, 본인 것만
//
//   모든 쿼리는 파라미터화($1,$2…) → SQL injection 방지.
//   소유 격리는 SQL 에서: cart 조회/수정/삭제는 항상 WHERE user_id = req.user.userId.
//   타인 소유 행은 매칭 자체가 0건 → 404 (소유 여부 노출 최소화).
// ========================================

// --- GET /api/cart : 본인 장바구니 (담은 순서대로) ---
//   data = [{ id, quantity, product:{ id, name, price, image_url, emoji, gradient } }]
app.get('/api/cart', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `${CART_SELECT_JOIN} WHERE c.user_id = $1 ORDER BY c.created_at ASC`,
      [req.user.userId]
    );
    return ok(res, 200, rows.map(rowToCartItem), '장바구니를 불러왔습니다.');
  } catch (err) {
    console.error('GET /api/cart 오류:', err.message);
    return fail(res, 500, '장바구니를 불러오지 못했습니다.');
  }
});

// --- POST /api/cart : 장바구니 담기 --- body { product_id, quantity=1 }
//   이미 담긴 상품이면 수량 증가 (UNIQUE(user_id,product_id) 충돌 시 quantity 합산).
//   존재하지 않는 product_id → FK 위반(23503) → 404.
//   data = 갱신된 cart item { id, quantity, product:{...} }
app.post('/api/cart', authMiddleware, async (req, res) => {
  try {
    const productId = Number(req.body && req.body.product_id);
    if (!Number.isInteger(productId) || productId <= 0) {
      return fail(res, 400, '올바른 상품을 선택해 주세요.');
    }

    let quantity = 1;
    if (req.body && typeof req.body.quantity !== 'undefined') {
      quantity = Number(req.body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return fail(res, 400, '수량은 1 이상의 정수여야 합니다.');
      }
    }

    // upsert(INSERT … ON CONFLICT … DO UPDATE) 후, 그 행을 상품과 JOIN 해 한 번에 반환(왕복 1회).
    let rows;
    try {
      ({ rows } = await pool.query(
        `WITH upsert AS (
           INSERT INTO shop_cart (user_id, product_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, product_id)
           DO UPDATE SET quantity = shop_cart.quantity + EXCLUDED.quantity
           RETURNING id, product_id, quantity
         )
         SELECT u.id, u.quantity, u.product_id,
                p.name, p.price, p.image_url, p.emoji, p.gradient
         FROM upsert u
         JOIN shop_products p ON p.id = u.product_id`,
        [req.user.userId, productId, quantity]
      ));
    } catch (err) {
      // FK 위반(존재하지 않는 product_id) → 404
      if (err.code === '23503') {
        return fail(res, 404, '선택한 상품을 찾을 수 없습니다.');
      }
      throw err;
    }

    return ok(res, 201, rowToCartItem(rows[0]), '장바구니에 담았습니다.');
  } catch (err) {
    console.error('POST /api/cart 오류:', err.message);
    return fail(res, 500, '장바구니에 담지 못했습니다.');
  }
});

// --- PATCH /api/cart/:id : 수량 변경 --- body { quantity }
//   본인 소유 행만 변경 (WHERE id=$ AND user_id=$). 없거나 타인 소유면 404.
//   quantity 는 1 이상의 정수만 허용(1 미만 방지).
//   data = 갱신된 cart item { id, quantity, product:{...} }
app.patch('/api/cart/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const quantity = Number(req.body && req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return fail(res, 400, '수량은 1 이상의 정수여야 합니다.');
    }

    const { rows } = await pool.query(
      `WITH upd AS (
         UPDATE shop_cart
         SET quantity = $1
         WHERE id = $2 AND user_id = $3
         RETURNING id, product_id, quantity
       )
       SELECT u.id, u.quantity, u.product_id,
              p.name, p.price, p.image_url, p.emoji, p.gradient
       FROM upd u
       JOIN shop_products p ON p.id = u.product_id`,
      [quantity, id, req.user.userId]
    );

    if (rows.length === 0) {
      return fail(res, 404, '장바구니 항목을 찾을 수 없습니다.');
    }
    return ok(res, 200, rowToCartItem(rows[0]), '수량을 변경했습니다.');
  } catch (err) {
    if (err.code === '22P02') {
      // 잘못된 UUID 형식의 :id → 없음 취급
      return fail(res, 404, '장바구니 항목을 찾을 수 없습니다.');
    }
    console.error('PATCH /api/cart/:id 오류:', err.message);
    return fail(res, 500, '수량을 변경하지 못했습니다.');
  }
});

// --- DELETE /api/cart/:id : 장바구니에서 제거 --- (본인 소유 아니면 404)
app.delete('/api/cart/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'DELETE FROM shop_cart WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    if (rowCount === 0) {
      return fail(res, 404, '장바구니 항목을 찾을 수 없습니다.');
    }
    return ok(res, 200, { id }, '장바구니에서 삭제했습니다.');
  } catch (err) {
    if (err.code === '22P02') {
      return fail(res, 404, '장바구니 항목을 찾을 수 없습니다.');
    }
    console.error('DELETE /api/cart/:id 오류:', err.message);
    return fail(res, 500, '장바구니에서 삭제하지 못했습니다.');
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
// /api 가 아닌 경로로 직접 접속하면 index.html 을 돌려준다 → :3009 로 접속하면 앱이 뜬다.
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
//  - 부팅 시 테이블/시드를 미리 만들어 둔다(첫 요청 지연 제거 + DB 연결 조기 확인).
//    실패해도 listen 은 계속한다: /api 미들웨어에서 initDB 를 재시도하므로,
//    DB 가 잠시 늦게 올라와도 서버 자체는 떠 있고 정적 파일은 서빙된다.
//  - 로컬에서 직접 실행할 때만 listen. (Vercel 등 서버리스 호환 위해 module.exports 와 분리)
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 스윗박스 쇼핑몰 서버 실행 중 → http://localhost:${PORT}`);
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
