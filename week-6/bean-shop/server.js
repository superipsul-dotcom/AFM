// ============================================================
// 안도 빈즈 · ANDO BEANS — 인증 서버 (server.js)
// 이메일/비밀번호 회원가입·로그인 + JWT Bearer 인증
// 정적 서빙(index.html) + /api/auth/{signup,login,me}
//
// 데이터는 인메모리(Map)에 저장됩니다 → 서버 재시작 시 초기화.
// 사용자 저장/조회는 findUserByEmail / findUserById / createUser
// 로 분리해 두었으니 나중에 DB(Supabase 등)로 교체하기 쉽습니다.
// ============================================================

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ----- 설정 (환경변수는 trailing newline 방지를 위해 .trim()) -----
const PORT = (process.env.PORT || '3014').trim();
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const SALT_ROUNDS = 10;          // bcryptjs salt rounds
const TOKEN_TTL = '7d';          // JWT 만료 7일
const MIN_PASSWORD = 8;          // 비밀번호 최소 길이
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 토스페이먼츠 결제 승인 — 시크릿 키는 서버 전용(절대 프론트 노출 금지)
const TOSS_SECRET_KEY = (process.env.TOSS_SECRET_KEY || '').trim();
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';

// ImageKit 프로필 사진 업로드 — private key는 서버 전용(서명 발급에만 사용)
const IMAGEKIT_PUBLIC_KEY = (process.env.IMAGEKIT_PUBLIC_KEY || '').trim();
const IMAGEKIT_PRIVATE_KEY = (process.env.IMAGEKIT_PRIVATE_KEY || '').trim();
const IMAGEKIT_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || '').trim();

// ============================================================
// 인메모리 저장소 (key = 소문자 정규화 이메일)
// 내부 레코드: { id, email, passwordHash, createdAt }
// ============================================================
const usersByEmail = new Map();

function findUserByEmail(email) {
  return usersByEmail.get(email) || null;
}

function findUserById(id) {
  for (const user of usersByEmail.values()) {
    if (user.id === id) return user;
  }
  return null;
}

function createUser({ email, passwordHash }) {
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  usersByEmail.set(email, user);
  return user;
}

// passwordHash 등 민감 정보를 제거한 공개용 user 객체
function toPublicUser(user) {
  return { id: user.id, email: user.email, avatarUrl: user.avatarUrl || null };
}

// ============================================================
// 주문 저장소 (key = orderId) — 인메모리, 서버 재시작 시 초기화
// 레코드: { orderId, userId, orderName, amount, items, status, createdAt, payment?, paymentKey? }
// status: 'PENDING'(주문 생성) → 'PAID'(토스 승인 완료)
// ============================================================
const ordersById = new Map();

// orderId: 토스 제약(영문·숫자·- _ / 6~64자)을 만족하는 충분히 유니크한 값
// 'ando_' + UUID(하이픈 제거, 32자) = 37자 → 안전
function generateOrderId() {
  return 'ando_' + crypto.randomUUID().replace(/-/g, '');
}

// "첫 상품명 외 N건" — 토스 결제창/영수증에 노출될 주문명
function buildOrderName(items) {
  const first = items[0] || {};
  const firstName = (first.name && String(first.name).trim()) || '주문 상품';
  return items.length > 1 ? `${firstName} 외 ${items.length - 1}건` : firstName;
}

// 클라이언트에 돌려줄 안전한 주문 정보(내부 필드 제외)
function toPublicOrder(order) {
  return {
    orderId: order.orderId,
    orderName: order.orderName,
    amount: order.amount,
    status: order.status,
    items: order.items,
    createdAt: order.createdAt,
  };
}

// ============================================================
// 응답 헬퍼 — 모든 응답을 { success, data, message } 봉투로 통일
// ============================================================
function ok(res, status, data, message) {
  return res.status(status).json({ success: true, data, message: message || '' });
}

function fail(res, status, message) {
  return res.status(status).json({ success: false, data: null, message });
}

// ============================================================
// JWT 헬퍼 & 인증 미들웨어
// ============================================================
function signToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: TOKEN_TTL }
  );
}

// Authorization: Bearer <token> 파싱 → 검증 성공 시 req.user = payload
function authMiddleware(req, res, next) {
  if (!JWT_SECRET) return fail(res, 503, '서버 설정 오류: JWT_SECRET이 설정되지 않았습니다');

  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return fail(res, 401, '인증 토큰이 필요합니다');
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { userId, email, iat, exp }
    return next();
  } catch (err) {
    return fail(res, 401, '유효하지 않거나 만료된 토큰입니다');
  }
}

// ============================================================
// 앱 초기화 & 미들웨어
// ============================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname))); // index.html(및 이후 정적파일) 서빙

// ============================================================
// 인증 API
// ============================================================

// [POST] /api/auth/signup — { email, password } → 201 { token, user }
app.post('/api/auth/signup', async (req, res) => {
  try {
    if (!JWT_SECRET) return fail(res, 503, '서버 설정 오류: JWT_SECRET이 설정되지 않았습니다');

    const { email, password } = req.body || {};

    // 필드 누락
    if (!email || !password) {
      return fail(res, 400, '이메일과 비밀번호를 모두 입력해 주세요');
    }

    const normEmail = String(email).trim().toLowerCase();

    // 이메일 형식
    if (!EMAIL_RE.test(normEmail)) {
      return fail(res, 400, '올바른 이메일 형식이 아닙니다');
    }

    // 비밀번호 길이(문자열 & 8자 이상)
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return fail(res, 400, `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);
    }

    // 이메일 중복
    if (findUserByEmail(normEmail)) {
      return fail(res, 409, '이미 가입된 이메일입니다');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = createUser({ email: normEmail, passwordHash });
    const token = signToken(user);

    // 가입 즉시 로그인 상태 → token 함께 반환
    return ok(res, 201, { token, user: toPublicUser(user) }, '회원가입이 완료되었습니다');
  } catch (err) {
    console.error('[signup] error:', err);
    return fail(res, 500, '회원가입 처리 중 오류가 발생했습니다');
  }
});

// [POST] /api/auth/login — { email, password } → 200 { token, user }
app.post('/api/auth/login', async (req, res) => {
  try {
    if (!JWT_SECRET) return fail(res, 503, '서버 설정 오류: JWT_SECRET이 설정되지 않았습니다');

    const { email, password } = req.body || {};

    // 필드 누락은 400 (자격증명 오류가 아니라 잘못된 요청)
    if (!email || !password) {
      return fail(res, 400, '이메일과 비밀번호를 모두 입력해 주세요');
    }

    const normEmail = String(email).trim().toLowerCase();
    const user = findUserByEmail(normEmail);

    // 이메일 없음 / 비밀번호 불일치 → 동일한 401 (어느 쪽인지 노출 금지)
    const match = user ? await bcrypt.compare(String(password), user.passwordHash) : false;
    if (!user || !match) {
      return fail(res, 401, '이메일 또는 비밀번호가 올바르지 않습니다');
    }

    const token = signToken(user);
    return ok(res, 200, { token, user: toPublicUser(user) }, '로그인되었습니다');
  } catch (err) {
    console.error('[login] error:', err);
    return fail(res, 500, '로그인 처리 중 오류가 발생했습니다');
  }
});

// [GET] /api/auth/me — Bearer 토큰 필요 → 200 { user }
app.get('/api/auth/me', authMiddleware, (req, res) => {
  // 토큰을 그대로 믿지 않고 저장소에서 재조회 (삭제된 계정/재시작 후 무효 세션은 401)
  const user = findUserById(req.user.userId);
  if (!user) {
    return fail(res, 401, '유효하지 않은 세션입니다. 다시 로그인해 주세요');
  }
  return ok(res, 200, { user: toPublicUser(user) }, '사용자 정보를 불러왔습니다');
});

// ============================================================
// 🖼 프로필 사진 (ImageKit)
// ============================================================

// [GET] /api/imagekit/auth — 클라이언트 직접 업로드용 서명 발급 (인증 필요)
// ImageKit V1 upload 인증: signature = HMAC-SHA1(token + expire, privateKey)
app.get('/api/imagekit/auth', authMiddleware, (req, res) => {
  if (!IMAGEKIT_PUBLIC_KEY || !IMAGEKIT_PRIVATE_KEY || !IMAGEKIT_URL_ENDPOINT) {
    return fail(res, 503, '서버 설정 오류: ImageKit 키가 설정되지 않았습니다');
  }
  const token = crypto.randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 60 * 30; // 30분 유효 (ImageKit 최대 1시간)
  const signature = crypto
    .createHmac('sha1', IMAGEKIT_PRIVATE_KEY)
    .update(token + expire)
    .digest('hex');
  return ok(res, 200, {
    token, expire, signature,
    publicKey: IMAGEKIT_PUBLIC_KEY,
    urlEndpoint: IMAGEKIT_URL_ENDPOINT,
  }, '업로드 인증 정보를 발급했습니다');
});

// [PUT] /api/auth/avatar — 업로드 완료된 ImageKit URL을 프로필에 저장 (인증 필요)
app.put('/api/auth/avatar', authMiddleware, (req, res) => {
  const user = findUserById(req.user.userId);
  if (!user) {
    return fail(res, 401, '유효하지 않은 세션입니다. 다시 로그인해 주세요');
  }
  const { url, fileId } = req.body || {};
  // 우리 ImageKit 계정 URL만 허용 (임의 외부 URL 주입 방지)
  if (!url || typeof url !== 'string' || !IMAGEKIT_URL_ENDPOINT || !url.startsWith(IMAGEKIT_URL_ENDPOINT)) {
    return fail(res, 400, '올바른 프로필 이미지 URL이 아닙니다');
  }
  user.avatarUrl = url;
  user.avatarFileId = typeof fileId === 'string' ? fileId : null;
  return ok(res, 200, { user: toPublicUser(user) }, '프로필 사진이 변경되었습니다');
});

// ============================================================
// 💳 주문 & 결제 API (토스페이먼츠 결제위젯 v2)
// ============================================================

// [POST] /api/orders — 주문 생성 (인증 필요)
// body: { items:[{id,name,grind,qty,price}], amount } → 201 { orderId, orderName, amount }
// ⚠️ amount는 서버가 저장해 두고, 결제 승인 때 successUrl 금액과 대조하는 "정답값"이 된다.
app.post('/api/orders', authMiddleware, (req, res) => {
  const { items, amount } = req.body || {};

  // 검증: items = 비어있지 않은 배열
  if (!Array.isArray(items) || items.length === 0) {
    return fail(res, 400, '주문 항목(items)이 비어 있습니다');
  }
  // 검증: amount = 양수 정수
  if (!Number.isInteger(amount) || amount <= 0) {
    return fail(res, 400, '결제 금액(amount)이 올바르지 않습니다');
  }

  const orderId = generateOrderId();
  const orderName = buildOrderName(items);
  const order = {
    orderId,
    userId: req.user.userId,
    orderName,
    amount,
    items,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  };
  ordersById.set(orderId, order);

  return ok(res, 201, { orderId, orderName, amount }, '주문이 생성되었습니다');
});

// [POST] /api/payments/confirm — 결제 승인 (인증 불필요)
// 리다이렉트 복귀 직후 세션복원 레이스를 피하려 인증을 걸지 않는다.
// orderId + paymentKey 조합 자체가 capability이며, 서버가 저장 금액과 대조해 위변조를 막는다.
// body: { paymentKey, orderId, amount } → 200 { order, payment }
app.post('/api/payments/confirm', async (req, res) => {
  try {
    // JWT_SECRET처럼 시크릿 키 미설정 시 503 가드
    if (!TOSS_SECRET_KEY) {
      return fail(res, 503, '서버 설정 오류: TOSS_SECRET_KEY가 설정되지 않았습니다');
    }

    const { paymentKey, orderId, amount } = req.body || {};
    if (!paymentKey || !orderId || amount === undefined || amount === null) {
      return fail(res, 400, 'paymentKey, orderId, amount가 모두 필요합니다');
    }

    // 저장된 주문 조회 (없으면 404)
    const order = ordersById.get(String(orderId));
    if (!order) {
      return fail(res, 404, '주문 정보를 찾을 수 없습니다');
    }

    // 🔒 서버 금액 검증 — successUrl로 넘어온 amount를 신뢰하지 않고 저장값과 대조
    if (Number(amount) !== order.amount) {
      return fail(res, 400, '결제 금액이 주문 금액과 일치하지 않습니다');
    }

    // 멱등: 이미 승인 완료된 주문이면 저장된 결제정보를 그대로 반환 (새로고침 재confirm 방지)
    if (order.status === 'PAID' && order.payment) {
      return ok(res, 200, { order: toPublicOrder(order), payment: order.payment }, '이미 결제가 완료된 주문입니다');
    }

    // 토스 결제 승인 API 호출 (Authorization: Basic base64("시크릿키:"))
    const encodedKey = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
    let tossRes, tossData;
    try {
      tossRes = await fetch(TOSS_CONFIRM_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${encodedKey}`,
          'Content-Type': 'application/json',
        },
        // 서버가 검증한 저장 금액(order.amount)으로 승인 요청
        body: JSON.stringify({ paymentKey, orderId: order.orderId, amount: order.amount }),
      });
      tossData = await tossRes.json();
    } catch (e) {
      console.error('[confirm] toss fetch error:', e);
      return fail(res, 502, '결제 승인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요');
    }

    // 토스 실패 → 주문은 PENDING 유지(재시도 가능) + 토스 {code, message}를 그대로 전달
    if (!tossRes.ok) {
      return res.status(tossRes.status).json({
        success: false,
        data: null,
        message: (tossData && tossData.message) || '결제 승인에 실패했습니다',
        code: (tossData && tossData.code) || null,
      });
    }

    // 승인 성공 → status PAID + 결제정보 저장
    const payment = {
      method: tossData.method || null,
      totalAmount: (tossData.totalAmount != null) ? tossData.totalAmount : order.amount,
      approvedAt: tossData.approvedAt || null,
      receiptUrl: (tossData.receipt && tossData.receipt.url) || null,
      orderName: tossData.orderName || order.orderName,
    };
    order.status = 'PAID';
    order.payment = payment;
    order.paymentKey = paymentKey;
    ordersById.set(order.orderId, order);

    return ok(res, 200, { order: toPublicOrder(order), payment }, '결제가 완료되었습니다');
  } catch (err) {
    console.error('[confirm] error:', err);
    return fail(res, 500, '결제 승인 처리 중 오류가 발생했습니다');
  }
});

// ============================================================
// 미정의 /api/* → 404 JSON (SPA 폴백보다 먼저 와야 함)
// ============================================================
app.use('/api', (_req, res) => fail(res, 404, '요청하신 API 경로를 찾을 수 없습니다'));

// ============================================================
// SPA 폴백 — 그 외 모든 경로는 index.html 서빙
// (BrowserRouter 딥링크 /cart, /product/:id 새로고침 대응)
// app.use(콜백)은 Express 4/5 양쪽에서 안전한 catch-all
// ============================================================
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// 에러 핸들링 미들웨어 (반드시 마지막, 4-arg)
// 잘못된 JSON 바디 등은 여기서 400으로 변환
// ============================================================
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, '올바른 JSON 형식이 아닙니다');
  }
  console.error('[unhandled] error:', err);
  return fail(res, 500, '서버 오류가 발생했습니다');
});

// ============================================================
// 로컬 실행 / Vercel 서버리스 듀얼 모드
// ============================================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🫘 안도 빈즈 인증 서버 실행 중 → http://localhost:${PORT}`);
    if (!JWT_SECRET) {
      console.warn('⚠️  JWT_SECRET이 설정되지 않았습니다. .env 파일을 확인하세요. (인증 API가 503을 반환합니다)');
    }
    if (!TOSS_SECRET_KEY) {
      console.warn('⚠️  TOSS_SECRET_KEY가 설정되지 않았습니다. .env 파일을 확인하세요. (결제 승인 API가 503을 반환합니다)');
    }
  });
}

module.exports = app;
