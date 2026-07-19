// ============================================================
// 안도마켓 🥕 — 우리동네 중고거래 (당근마켓 클론) 백엔드 server.js
// AFM week-7 / danggeun-market  ·  PORT 3018
//
// 스택: Express + pg(Supabase Postgres) + JWT(bcryptjs) + ImageKit 서명
// 계약: CONTRACT.md 가 유일한 진실. 응답 규약 = { ok:true, ...data } / { ok:false, error }
//
// ⚠️ 공유 Supabase — 이 서버는 접두사 `dg_` 테이블 5개만 만들고/읽고/쓴다.
//    (dg_users / dg_products / dg_favorites / dg_chat_rooms / dg_chat_messages)
//    그 외 테이블(cafe_·shop_·interior_ …)은 절대 조회/변경/DROP 하지 않는다.
//
// 정적 서빙: GET / 만 index.html sendFile (express.static(__dirname) 금지 — .env 노출).
//            index.html 은 병렬 에이전트가 빌드 중이라 없을 수 있음 → 없으면 503.
// 듀얼 모드: 로컬 `node server.js` = listen / 서버리스 = module.exports = app.
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// ----- 설정 (환경변수는 trailing newline 방지를 위해 전부 .trim()) -----
const PORT = Number((process.env.PORT || '3018').trim());
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const IMAGEKIT_PUBLIC_KEY = (process.env.IMAGEKIT_PUBLIC_KEY || '').trim();
const IMAGEKIT_PRIVATE_KEY = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
const IMAGEKIT_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || '').trim();

const TOKEN_TTL = '7d';
const SALT_ROUNDS = 10;
const MIN_PASSWORD = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 카테고리 8개 고정 (프론트/서버 동일 상수) · 상태 3개
const CATEGORIES = ['디지털기기', '가구/인테리어', '생활가전', '생활/주방', '의류', '도서', '취미/게임', '기타'];
const STATUSES = ['selling', 'reserved', 'sold'];

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 })
  : null;
if (pool) pool.on('error', (e) => console.error('pg pool error:', e.message)); // idle 소켓 끊김에 크래시 방지

// ============================================================
// 스키마 준비 (dg_ 접두사 5개) — 서버리스 콜드스타트 대비 인스턴스당 1회 lazy
// ============================================================
async function initDb() {
  await pool.query(`
    create table if not exists dg_users (
      id            serial primary key,
      email         text unique not null,
      password_hash text not null,
      nickname      text not null,
      neighborhood  text not null,
      created_at    timestamptz not null default now()
    )`);
  await pool.query(`
    create table if not exists dg_products (
      id           serial primary key,
      user_id      int not null references dg_users(id) on delete cascade,
      title        text not null,
      description  text not null,
      price        int not null check (price >= 0),
      category     text not null,
      images       jsonb not null default '[]',
      status       text not null default 'selling',
      neighborhood text not null,
      view_count   int not null default 0,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now()
    )`);
  await pool.query(`
    create table if not exists dg_favorites (
      user_id    int not null references dg_users(id) on delete cascade,
      product_id int not null references dg_products(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (user_id, product_id)
    )`);
  await pool.query(`
    create table if not exists dg_chat_rooms (
      id         serial primary key,
      product_id int not null references dg_products(id) on delete cascade,
      buyer_id   int not null references dg_users(id) on delete cascade,
      seller_id  int not null references dg_users(id) on delete cascade,
      created_at timestamptz not null default now(),
      unique (product_id, buyer_id)
    )`);
  await pool.query(`
    create table if not exists dg_chat_messages (
      id         serial primary key,
      room_id    int not null references dg_chat_rooms(id) on delete cascade,
      sender_id  int not null references dg_users(id) on delete cascade,
      content    text not null,
      created_at timestamptz not null default now()
    )`);
}
let readyPromise = null;
function ensureReady() { readyPromise ||= initDb(); return readyPromise; }

// ============================================================
// 응답 헬퍼 — 성공 { ok:true, ...data } / 실패 { ok:false, error }
// ============================================================
function ok(res, status, data) { return res.status(status).json({ ok: true, ...(data || {}) }); }
function fail(res, status, error) { return res.status(status).json({ ok: false, error }); }

// ============================================================
// JWT / 인증
// ============================================================
function signToken(u) {
  return jwt.sign({ id: u.id, email: u.email, nickname: u.nickname }, JWT_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_TTL });
}
// passwordHash 를 절대 노출하지 않는 공개용 user 객체
function publicUser(u) {
  return { id: u.id, email: u.email, nickname: u.nickname, neighborhood: u.neighborhood, created_at: u.created_at };
}
// 필수 인증: 없거나 무효면 401
function auth(req, res, next) {
  if (!JWT_SECRET) return fail(res, 503, '서버 설정 오류: JWT_SECRET 이 설정되지 않았어요.');
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return fail(res, 401, '로그인이 필요해요.');
  try { req.user = jwt.verify(token, JWT_SECRET); return next(); }
  catch { return fail(res, 401, '로그인이 만료됐어요. 다시 로그인해주세요.'); }
}
// 선택 인증: 토큰 있으면 req.user 세팅, 없거나 무효여도 통과(비로그인 허용)
function optionalAuth(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* 무시하고 비로그인으로 진행 */ }
  }
  return next();
}

// 양수 정수 라우트 파라미터(:id) 파싱 — 아니면 null
function intParam(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

// ============================================================
// 상품 조회 공통 SELECT (N+1 금지: seller 닉네임 + favorite_count 를 JOIN 한 방에)
// ============================================================
const PRODUCT_SELECT = `
  select p.id, p.user_id, p.title, p.description, p.price, p.category, p.images,
         p.status, p.neighborhood, p.view_count, p.created_at,
         u.nickname     as seller_nickname,
         u.neighborhood as seller_neighborhood,
         coalesce(fc.cnt, 0)::int as favorite_count
    from dg_products p
    join dg_users u on u.id = p.user_id
    left join (select product_id, count(*) as cnt from dg_favorites group by product_id) fc
      on fc.product_id = p.id`;

function rowToCard(r) {
  return {
    id: r.id, title: r.title, price: r.price, category: r.category, images: r.images,
    status: r.status, neighborhood: r.neighborhood, view_count: r.view_count, created_at: r.created_at,
    seller: { id: r.user_id, nickname: r.seller_nickname },
    favorite_count: r.favorite_count,
  };
}
function rowToDetail(r, isFavorite) {
  return {
    ...rowToCard(r),
    description: r.description,
    seller: { id: r.user_id, nickname: r.seller_nickname, neighborhood: r.seller_neighborhood },
    is_favorite: !!isFavorite,
  };
}

// 상품 등록/수정 바디 검증 (POST=신규, PUT=전체교체 공통)
function validateProductBody(b) {
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  const category = typeof b.category === 'string' ? b.category : '';
  const price = Number(b.price);
  const images = b.images;
  if (!title) return { error: '제목을 입력해주세요.' };
  if (!description) return { error: '설명을 입력해주세요.' };
  if (!Number.isInteger(price) || price < 0) return { error: '가격은 0 이상의 정수여야 해요.' };
  if (!CATEGORIES.includes(category)) return { error: '카테고리가 올바르지 않아요.' };
  if (!Array.isArray(images)) return { error: '이미지 형식이 올바르지 않아요.' };
  if (images.length > 3) return { error: '이미지는 최대 3장까지 등록할 수 있어요.' };
  for (const url of images) {
    if (typeof url !== 'string' || !IMAGEKIT_URL_ENDPOINT || !url.startsWith(IMAGEKIT_URL_ENDPOINT)) {
      return { error: '이미지 URL 이 올바르지 않아요.' };
    }
  }
  return { value: { title, description, category, price, images } };
}

// ============================================================
// 앱 + 미들웨어
// ============================================================
const app = express();

// Express 4 는 async 핸들러의 rejection 을 못 잡아 프로세스가 죽는다 →
// 라우트 등록 시점에 자동으로 .catch(next) 로 감싸 에러 미들웨어로 흘려보낸다.
for (const m of ['get', 'post', 'patch', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (route, ...handlers) => orig(route, ...handlers.map((h) =>
    h.length >= 4 ? h : (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)));
}

app.use(express.json({ limit: '1mb' }));

// 모든 /api 요청 전에 DB 준비 보장 (서버리스: 인스턴스당 1회, 부팅 hiccup 은 첫 요청에 자가치유)
app.use('/api', async (_req, res, next) => {
  if (!pool) return fail(res, 503, '서버 설정 오류: DATABASE_URL 이 설정되지 않았어요.');
  try { await ensureReady(); return next(); }
  catch (e) { console.error('[initDb] error:', e); return fail(res, 500, 'DB 초기화에 실패했어요.'); }
});

// ============================================================
// Auth
// ============================================================
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, nickname, neighborhood } = req.body || {};
  if (!email || !password || !nickname || !neighborhood) {
    return fail(res, 400, '이메일·비밀번호·닉네임·동네를 모두 입력해주세요.');
  }
  const normEmail = String(email).trim().toLowerCase();
  const nick = String(nickname).trim();
  const nbhd = String(neighborhood).trim();
  if (!nick || !nbhd) return fail(res, 400, '이메일·비밀번호·닉네임·동네를 모두 입력해주세요.');
  if (!EMAIL_RE.test(normEmail)) return fail(res, 400, '이메일 형식이 올바르지 않아요.');
  if (String(password).length < MIN_PASSWORD) return fail(res, 400, `비밀번호는 ${MIN_PASSWORD}자 이상이어야 해요.`);
  try {
    const hash = bcrypt.hashSync(String(password), SALT_ROUNDS);
    const { rows: [u] } = await pool.query(
      `insert into dg_users (email, password_hash, nickname, neighborhood)
       values ($1,$2,$3,$4) returning id, email, nickname, neighborhood, created_at`,
      [normEmail, hash, nick, nbhd],
    );
    return ok(res, 201, { token: signToken(u), user: u });
  } catch (e) {
    if (e.code === '23505') return fail(res, 409, '이미 가입된 이메일이에요.'); // 동시 가입 레이스 포함
    throw e;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, '이메일과 비밀번호를 입력해주세요.');
  const normEmail = String(email).trim().toLowerCase();
  const { rows: [u] } = await pool.query('select * from dg_users where email = $1', [normEmail]);
  // 이메일 없음/비번 불일치는 동일한 401 (어느 쪽인지 노출 금지)
  const match = u ? bcrypt.compareSync(String(password), u.password_hash) : false;
  if (!u || !match) return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않아요.');
  return ok(res, 200, { token: signToken(u), user: publicUser(u) });
});

app.get('/api/auth/me', auth, async (req, res) => {
  // 토큰을 그대로 믿지 않고 재조회 (삭제된 계정 → 401)
  const { rows: [u] } = await pool.query(
    'select id, email, nickname, neighborhood, created_at from dg_users where id = $1', [req.user.id]);
  if (!u) return fail(res, 401, '유효하지 않은 세션이에요. 다시 로그인해주세요.');
  return ok(res, 200, { user: u });
});

// ============================================================
// 상품
// ============================================================
// 목록 — 최신순, category 정확일치 필터, q 는 title+description ILIKE 검색
app.get('/api/products', async (req, res) => {
  const params = [];
  const conds = [];
  const category = (req.query.category || '').trim();
  const q = (req.query.q || '').trim();
  if (category) { params.push(category); conds.push(`p.category = $${params.length}`); }
  if (q) { params.push(`%${q}%`); conds.push(`(p.title ilike $${params.length} or p.description ilike $${params.length})`); }
  const where = conds.length ? `where ${conds.join(' and ')}` : '';
  const { rows } = await pool.query(`${PRODUCT_SELECT} ${where} order by p.created_at desc, p.id desc`, params);
  return ok(res, 200, { products: rows.map(rowToCard) });
});

// 상세 — 호출 시 view_count +1, is_favorite 는 토큰 있으면 계산(없으면 false)
app.get('/api/products/:id', optionalAuth, async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return fail(res, 404, '상품을 찾을 수 없어요.');
  const upd = await pool.query('update dg_products set view_count = view_count + 1 where id = $1 returning id', [id]);
  if (!upd.rowCount) return fail(res, 404, '상품을 찾을 수 없어요.');
  const { rows: [row] } = await pool.query(`${PRODUCT_SELECT} where p.id = $1`, [id]);
  let isFav = false;
  if (req.user) {
    const f = await pool.query('select 1 from dg_favorites where user_id = $1 and product_id = $2', [req.user.id, id]);
    isFav = f.rowCount > 0;
  }
  return ok(res, 200, { product: rowToDetail(row, isFav) });
});

// 등록 — neighborhood 는 작성자 동네 자동 스냅샷
app.post('/api/products', auth, async (req, res) => {
  const v = validateProductBody(req.body || {});
  if (v.error) return fail(res, 400, v.error);
  const { title, description, category, price, images } = v.value;
  const ins = await pool.query(
    `insert into dg_products (user_id, title, description, price, category, images, neighborhood)
     values ($1,$2,$3,$4,$5,$6, (select neighborhood from dg_users where id = $1))
     returning id`,
    [req.user.id, title, description, price, category, JSON.stringify(images)],
  );
  const { rows: [row] } = await pool.query(`${PRODUCT_SELECT} where p.id = $1`, [ins.rows[0].id]);
  return ok(res, 201, { product: rowToCard(row) });
});

// 수정 — 본인만(남의 것 403, 없음 404). 전체 교체(neighborhood 스냅샷은 유지)
app.put('/api/products/:id', auth, async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return fail(res, 404, '상품을 찾을 수 없어요.');
  const own = await pool.query('select user_id from dg_products where id = $1', [id]);
  if (!own.rowCount) return fail(res, 404, '상품을 찾을 수 없어요.');
  if (own.rows[0].user_id !== req.user.id) return fail(res, 403, '내 상품만 수정할 수 있어요.');
  const v = validateProductBody(req.body || {});
  if (v.error) return fail(res, 400, v.error);
  const { title, description, category, price, images } = v.value;
  await pool.query(
    `update dg_products set title=$2, description=$3, price=$4, category=$5, images=$6, updated_at=now()
     where id = $1`,
    [id, title, description, price, category, JSON.stringify(images)],
  );
  const { rows: [row] } = await pool.query(`${PRODUCT_SELECT} where p.id = $1`, [id]);
  return ok(res, 200, { product: rowToCard(row) });
});

// 상태 변경 — 본인만. status ∈ selling/reserved/sold
app.patch('/api/products/:id/status', auth, async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return fail(res, 404, '상품을 찾을 수 없어요.');
  const own = await pool.query('select user_id from dg_products where id = $1', [id]);
  if (!own.rowCount) return fail(res, 404, '상품을 찾을 수 없어요.');
  if (own.rows[0].user_id !== req.user.id) return fail(res, 403, '내 상품만 변경할 수 있어요.');
  const status = req.body?.status;
  if (!STATUSES.includes(status)) return fail(res, 400, '상태 값이 올바르지 않아요.');
  await pool.query('update dg_products set status = $2, updated_at = now() where id = $1', [id, status]);
  const { rows: [row] } = await pool.query(`${PRODUCT_SELECT} where p.id = $1`, [id]);
  return ok(res, 200, { product: rowToCard(row) });
});

// 삭제 — 본인만. CASCADE 로 favorites/chat_rooms/messages 정리됨
app.delete('/api/products/:id', auth, async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return fail(res, 404, '상품을 찾을 수 없어요.');
  const own = await pool.query('select user_id from dg_products where id = $1', [id]);
  if (!own.rowCount) return fail(res, 404, '상품을 찾을 수 없어요.');
  if (own.rows[0].user_id !== req.user.id) return fail(res, 403, '내 상품만 삭제할 수 있어요.');
  await pool.query('delete from dg_products where id = $1', [id]);
  return ok(res, 200, {});
});

// ============================================================
// 관심 (찜)
// ============================================================
// 토글 — 있으면 해제, 없으면 등록
app.post('/api/products/:id/favorite', auth, async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return fail(res, 404, '상품을 찾을 수 없어요.');
  const exists = await pool.query('select 1 from dg_products where id = $1', [id]);
  if (!exists.rowCount) return fail(res, 404, '상품을 찾을 수 없어요.');
  const del = await pool.query('delete from dg_favorites where user_id = $1 and product_id = $2', [req.user.id, id]);
  let is_favorite;
  if (del.rowCount > 0) {
    is_favorite = false;
  } else {
    await pool.query('insert into dg_favorites (user_id, product_id) values ($1,$2) on conflict do nothing', [req.user.id, id]);
    is_favorite = true;
  }
  const { rows: [{ c }] } = await pool.query('select count(*)::int c from dg_favorites where product_id = $1', [id]);
  return ok(res, 200, { is_favorite, favorite_count: c });
});

// 내가 찜한 상품 (찜한 순 최신)
app.get('/api/me/favorites', auth, async (req, res) => {
  const { rows } = await pool.query(
    `${PRODUCT_SELECT}
       join dg_favorites myf on myf.product_id = p.id and myf.user_id = $1
      order by myf.created_at desc`, [req.user.id]);
  return ok(res, 200, { products: rows.map(rowToCard) });
});

// ============================================================
// 마이 — 내가 등록한 상품 (최신순)
// ============================================================
app.get('/api/me/products', auth, async (req, res) => {
  const { rows } = await pool.query(
    `${PRODUCT_SELECT} where p.user_id = $1 order by p.created_at desc, p.id desc`, [req.user.id]);
  return ok(res, 200, { products: rows.map(rowToCard) });
});

// ============================================================
// 채팅 (폴링)
// ============================================================
// 채팅방 get-or-create — 본인 상품이면 400
app.post('/api/products/:id/chat', auth, async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return fail(res, 404, '상품을 찾을 수 없어요.');
  const prod = await pool.query('select user_id from dg_products where id = $1', [id]);
  if (!prod.rowCount) return fail(res, 404, '상품을 찾을 수 없어요.');
  const sellerId = prod.rows[0].user_id;
  if (sellerId === req.user.id) return fail(res, 400, '내 상품에는 채팅할 수 없어요');
  // ON CONFLICT DO UPDATE(무의미 갱신)로 기존 방도 RETURNING 되게 한다 (get-or-create)
  const { rows: [room] } = await pool.query(
    `insert into dg_chat_rooms (product_id, buyer_id, seller_id) values ($1,$2,$3)
     on conflict (product_id, buyer_id) do update set product_id = excluded.product_id
     returning id, product_id`,
    [id, req.user.id, sellerId],
  );
  return ok(res, 200, { room: { id: room.id, product_id: room.product_id } });
});

// 내 채팅방 목록 (구매자든 판매자든) — 최근 메시지순
app.get('/api/chats', auth, async (req, res) => {
  const me = req.user.id;
  const { rows } = await pool.query(
    `select r.id, r.product_id,
            p.title, p.price, p.images, p.status,
            ou.id as other_id, ou.nickname as other_nickname,
            lm.content as last_content, lm.created_at as last_created_at
       from dg_chat_rooms r
       join dg_products p on p.id = r.product_id
       join dg_users ou on ou.id = (case when r.buyer_id = $1 then r.seller_id else r.buyer_id end)
       left join lateral (
         select content, created_at from dg_chat_messages
          where room_id = r.id order by id desc limit 1
       ) lm on true
      where r.buyer_id = $1 or r.seller_id = $1
      order by coalesce(lm.created_at, r.created_at) desc`, [me]);
  const rooms = rows.map((r) => ({
    id: r.id,
    product: { id: r.product_id, title: r.title, price: r.price, images: r.images, status: r.status },
    other: { id: r.other_id, nickname: r.other_nickname },
    last_message: r.last_created_at != null ? { content: r.last_content, created_at: r.last_created_at } : null,
  }));
  return ok(res, 200, { rooms });
});

// 방 메시지 — 참여자만(403). after 이후만(없으면 전체), id 오름차순
app.get('/api/chats/:roomId/messages', auth, async (req, res) => {
  const roomId = intParam(req.params.roomId);
  if (!roomId) return fail(res, 404, '채팅방을 찾을 수 없어요.');
  const room = await pool.query('select buyer_id, seller_id from dg_chat_rooms where id = $1', [roomId]);
  if (!room.rowCount) return fail(res, 404, '채팅방을 찾을 수 없어요.');
  const { buyer_id, seller_id } = room.rows[0];
  if (req.user.id !== buyer_id && req.user.id !== seller_id) return fail(res, 403, '참여 중인 채팅방만 볼 수 있어요.');
  const after = Number(req.query.after);
  const hasAfter = Number.isInteger(after) && after > 0;
  const { rows } = hasAfter
    ? await pool.query(
      'select id, room_id, sender_id, content, created_at from dg_chat_messages where room_id = $1 and id > $2 order by id asc',
      [roomId, after])
    : await pool.query(
      'select id, room_id, sender_id, content, created_at from dg_chat_messages where room_id = $1 order by id asc',
      [roomId]);
  return ok(res, 200, { messages: rows });
});

// 메시지 전송 — 참여자만(403). 빈문자 400
app.post('/api/chats/:roomId/messages', auth, async (req, res) => {
  const roomId = intParam(req.params.roomId);
  if (!roomId) return fail(res, 404, '채팅방을 찾을 수 없어요.');
  const room = await pool.query('select buyer_id, seller_id from dg_chat_rooms where id = $1', [roomId]);
  if (!room.rowCount) return fail(res, 404, '채팅방을 찾을 수 없어요.');
  const { buyer_id, seller_id } = room.rows[0];
  if (req.user.id !== buyer_id && req.user.id !== seller_id) return fail(res, 403, '참여 중인 채팅방에만 보낼 수 있어요.');
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) return fail(res, 400, '메시지를 입력해주세요.');
  const { rows: [message] } = await pool.query(
    `insert into dg_chat_messages (room_id, sender_id, content) values ($1,$2,$3)
     returning id, room_id, sender_id, content, created_at`,
    [roomId, req.user.id, content],
  );
  return ok(res, 201, { message });
});

// ============================================================
// ImageKit — 클라이언트 직접 업로드용 서명 발급 (bean-shop 패턴 그대로)
// signature = HMAC-SHA1(token + expire, PRIVATE_KEY) hex
// ============================================================
app.get('/api/imagekit/auth', auth, (_req, res) => {
  if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_URL_ENDPOINT) {
    return fail(res, 503, '서버 설정 오류: ImageKit 키가 설정되지 않았어요.');
  }
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 1800; // 30분
  const signature = crypto.createHmac('sha1', IMAGEKIT_PRIVATE_KEY).update(token + expire).digest('hex');
  return ok(res, 200, {
    token, expire, signature,
    publicKey: IMAGEKIT_PUBLIC_KEY,
    urlEndpoint: IMAGEKIT_URL_ENDPOINT,
  });
});

// ============================================================
// 미정의 /api/* → 404 JSON (SPA/정적 폴백보다 먼저)
// ============================================================
app.use('/api', (_req, res) => fail(res, 404, '요청하신 API 경로를 찾을 수 없어요.'));

// ============================================================
// 정적 서빙 — GET / 만 index.html (express.static(__dirname) 금지: .env 노출)
// index.html 은 병렬 에이전트가 빌드 중일 수 있음 → 없으면 503 텍스트
// ============================================================
const INDEX_HTML = path.join(__dirname, 'index.html');
app.get('/', (_req, res) => {
  if (fs.existsSync(INDEX_HTML)) return res.sendFile(INDEX_HTML);
  return res.status(503).type('text').send('프론트 빌드 중');
});
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ============================================================
// 에러 미들웨어 (반드시 마지막, 4-arg). 잘못된 JSON 바디 → 400
// ============================================================
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return fail(res, 400, '올바른 JSON 형식이 아니에요.');
  console.error('[unhandled] error:', err);
  return fail(res, 500, '서버 오류가 발생했어요.');
});

// ============================================================
// 로컬 실행 / 서버리스 듀얼 모드
// ============================================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🥕 안도마켓 서버 실행 중 → http://localhost:${PORT}`);
    if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL 미설정 — /api 는 503 을 반환합니다.');
    if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET 미설정 — 인증 API 가 503/401 을 반환합니다.');
    if (!IMAGEKIT_PRIVATE_KEY) console.warn('⚠️  IMAGEKIT_* 미설정 — /api/imagekit/auth 가 503 을 반환합니다.');
  });
}

module.exports = app;
