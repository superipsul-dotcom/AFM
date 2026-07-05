// ========================================
// 💰 나만의 가계부 — 수입/지출 관리앱 백엔드 (Supabase PostgreSQL 영속화)
// AFM week-5 / quest (Server + DB)
//
// 핵심: 거래 내역을 localStorage 가 아니라 "실제 Postgres DB"에 저장한다.
//   - Express  : 정적 파일(index.html) 서빙 + REST CRUD API 제공
//   - pg(Pool) : Supabase(Supavisor transaction pooler)에 연결
//   - dotenv   : 자격 증명을 .env 에서 읽어옴 (코드에 하드코딩 금지)
//
// 테이블 2개:
//   transactions (type, amount, category, memo, date, scope, created_at) — 거래 내역
//     scope: 'personal'(개인) | 'company'(회사) — 사용 목적 분류 (기본 'personal')
//   budgets (category, amount) — 지출 카테고리별 월 예산
//
// ⚠️ index.html(UI)이 기대하는 API 계약에 1:1 로 맞춰져 있다.
//    *** 이 프론트는 { success, data } 봉투를 쓰지 않는다. raw 배열/객체를 기대한다. ***
//    (my-food 와 달리 봉투 없음! index.html 의 api._tryFetch 가 res.json() 을 그대로 사용)
//      - GET  /api/transactions → 거래 객체 raw 배열
//      - POST /api/transactions → 생성된 거래 객체 raw
//      - PUT  /api/transactions/:id → 수정된 거래 객체 raw
//      - DELETE /api/transactions/:id → { success: true } (프론트가 res.json() 으로 파싱하므로 JSON 필수)
//    필드:
//      id          (BIGINT → 문자열 그대로)
//      type        'income' | 'expense'
//      amount      number (원 단위 정수)
//      category    string
//      memo        string ('' 가능)
//      date        'YYYY-MM-DD' 문자열  (타임존 밀림 방지 위해 to_char 로 직렬화)
//      scope       'personal' | 'company' (없으면 'personal' 로 저장)
//      created_at  ISO 문자열           (프론트가 created_at 을 "문자열 비교"로 정렬하므로)
//
// 🔐 보안: DB 접속 정보는 process.env.DATABASE_URL 로만 읽고, .env 는 .gitignore 로 제외.
// ========================================

require('dotenv').config(); // .env → process.env 로 로드 (가장 먼저 실행)

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// PORT 는 .env 에서, 없으면 3007. (3005=my-food, 3006=todos 와 충돌 피해 3007)
const PORT = Number((process.env.PORT || '3007').trim());

// ----------------------------------------
// PostgreSQL 연결 풀
//
// connection string(DATABASE_URL) 방식으로 연결. 환경변수에 trailing newline 이
// 붙는 플랫폼이 있어 .trim() 으로 방어.
//
// ⚠️ 포트 6543 은 Supabase 트랜잭션 풀러(pgBouncer)다. prepared statement 이슈 시
//    .env 의 포트를 5432(세션 풀러)로 바꾸면 된다. (이 앱은 단순 쿼리라 6543 으로 충분)
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
// 서버리스(cold start)에서 여러 번 호출돼도 안전하도록 flag 로 중복 방지.
//
// 스키마(transactions):
//   id          BIGINT IDENTITY  기본키
//   type        TEXT             'income' | 'expense' (CHECK 제약)
//   amount      BIGINT           원 단위 정수, 0보다 큼 (CHECK 제약)
//   category    TEXT             카테고리
//   memo        TEXT             메모 (기본 '')
//   date        DATE             거래 날짜
//   scope       TEXT             'personal'(개인) | 'company'(회사) — 사용 목적 분류
//   created_at  TIMESTAMPTZ      생성 시각 (기본 now())
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      amount BIGINT NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT '',
      date DATE NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','company')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // 마이그레이션: 이미 만들어진 transactions 테이블엔 scope 컬럼이 없으므로 추가.
  // 기존 행은 전부 'personal' 로 채워진다. IF NOT EXISTS 라 반복 실행 안전.
  // (CHECK 는 새 테이블에만 걸리지만, 값 검증은 어차피 서버 validateTransaction 이 한다)
  await pool.query(
    "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal'"
  );
  // 목록 정렬(date DESC, created_at DESC) 가속용 인덱스. IF NOT EXISTS 라 반복 실행 안전.
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date DESC, created_at DESC);'
  );

  // ----------------------------------------
  // budgets 테이블 (지출 카테고리별 월 예산)
  //   id          BIGINT IDENTITY  기본키
  //   category    TEXT UNIQUE      카테고리 (1카테고리 = 1예산 → upsert)
  //   amount      BIGINT           월 예산 한도(원), 0보다 큼 (CHECK 제약)
  //   created_at  TIMESTAMPTZ      생성 시각 (기본 now())
  // ----------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS budgets (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      category TEXT NOT NULL UNIQUE,
      amount BIGINT NOT NULL CHECK (amount > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  dbInitialized = true;
  console.log('🗄️  transactions / budgets 테이블 준비 완료.');
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
//
// ⚠️ 프론트(index.html) 계약:
//   - amount 는 number 로 (pg 는 BIGINT 를 문자열로 돌려주므로 Number() 변환)
//   - date 는 'YYYY-MM-DD' 문자열 (SELECT 시 to_char 로 이미 텍스트화 → 타임존 안전)
//   - created_at 은 ISO 문자열 (프론트가 created_at 을 문자열 대소 비교로 정렬)
//   - id 는 pg 가 주는 문자열 그대로 (모든 행이 동일하게 문자열 → ===/URL 일관)
// ----------------------------------------
function rowToTransaction(row) {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    memo: row.memo || '',
    date: row.date, // 'YYYY-MM-DD' (to_char 로 직렬화됨)
    scope: row.scope === 'company' ? 'company' : 'personal', // 구데이터/이상값 방어
    created_at: new Date(row.created_at).toISOString(),
  };
}

// SELECT 시 공통으로 쓰는 컬럼식 (date 를 타임존 안전한 텍스트로 직렬화)
const SELECT_COLS =
  "id, type, amount, category, memo, to_char(date, 'YYYY-MM-DD') AS date, scope, created_at";

// 쿼리스트링 ?scope= 값 파싱: 유효('personal'|'company')하면 그 값, 아니면 '' (필터 없음)
function parseScope(q) {
  const s = typeof q === 'string' ? q.trim() : '';
  return s === 'personal' || s === 'company' ? s : '';
}

// ----------------------------------------
// 입력 검증 헬퍼 (POST/PUT 공용)
//   - type   : 'income' | 'expense'
//   - amount : 0보다 큰 정수
//   - category: 비어있지 않은 문자열
//   - date   : 유효한 'YYYY-MM-DD'
//   - memo   : 선택 (없으면 '')
//   - scope  : 선택 ('personal' | 'company', 없으면 'personal')
// 반환: { valid, message?, values? }
// ----------------------------------------
function validateTransaction(body) {
  const b = body || {};

  const type = b.type;
  if (type !== 'income' && type !== 'expense') {
    return { valid: false, message: "type 은 'income' 또는 'expense' 여야 합니다." };
  }

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return { valid: false, message: 'amount 는 0보다 큰 정수(원 단위)여야 합니다.' };
  }

  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!category) {
    return { valid: false, message: 'category 는 필수입니다.' };
  }

  const date = typeof b.date === 'string' ? b.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) {
    return { valid: false, message: 'date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }

  const memo = typeof b.memo === 'string' ? b.memo.trim() : '';

  // scope: 미전송(구버전 클라이언트) 시 'personal' 로 취급, 보냈다면 두 값만 허용
  let scope = typeof b.scope === 'string' ? b.scope.trim() : '';
  if (!scope) scope = 'personal';
  if (scope !== 'personal' && scope !== 'company') {
    return { valid: false, message: "scope 는 'personal' 또는 'company' 여야 합니다." };
  }

  return { valid: true, values: { type, amount, category, memo, date, scope } };
}

// 'YYYY-MM-DD' 가 실제 달력상 존재하는 날짜인지 확인 (예: 2026-02-30 거르기).
function isRealDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

// ========================================
// REST API — 거래 내역(transactions) CRUD
// 모든 쿼리는 파라미터화($1, $2)로 작성 → SQL injection 방지.
// ⚠️ 응답은 raw (봉투 없음). 단, DELETE 만 { success: true } JSON 반환.
// 상태 코드: 200 ok / 201 create / 400 검증 / 404 없음 / 500 서버
// ========================================

// --- GET /api/transactions : 전체 내역 (date 최신순, 동일 date 면 created_at 최신순) ---
//     ?scope=personal|company 로 회사/개인 사용 내역만 필터 가능 (그 외 값은 무시=전체)
app.get('/api/transactions', async (req, res) => {
  try {
    const scope = parseScope(req.query.scope);
    const where = scope ? 'WHERE scope = $1' : '';
    const params = scope ? [scope] : [];
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM transactions ${where} ORDER BY date DESC, created_at DESC`,
      params
    );
    res.json(rows.map(rowToTransaction)); // raw 배열
  } catch (err) {
    console.error('GET /api/transactions 오류:', err.message);
    res.status(500).json({ success: false, message: '내역을 불러오지 못했습니다.' });
  }
});

// --- POST /api/transactions : 내역 추가 ---
// body: { type, amount, category, memo, date, scope }
app.post('/api/transactions', async (req, res) => {
  try {
    const check = validateTransaction(req.body);
    if (!check.valid) {
      return res.status(400).json({ success: false, message: check.message });
    }
    const { type, amount, category, memo, date, scope } = check.values;

    const { rows } = await pool.query(
      `INSERT INTO transactions (type, amount, category, memo, date, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_COLS}`,
      [type, amount, category, memo, date, scope]
    );
    res.status(201).json(rowToTransaction(rows[0])); // raw 객체
  } catch (err) {
    console.error('POST /api/transactions 오류:', err.message);
    res.status(500).json({ success: false, message: '내역을 저장하지 못했습니다.' });
  }
});

// --- PUT /api/transactions/:id : 내역 수정 ---
// body: { type, amount, category, memo, date, scope }
app.put('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const check = validateTransaction(req.body);
    if (!check.valid) {
      return res.status(400).json({ success: false, message: check.message });
    }
    const { type, amount, category, memo, date, scope } = check.values;

    const { rows } = await pool.query(
      `UPDATE transactions
       SET type = $1, amount = $2, category = $3, memo = $4, date = $5, scope = $6
       WHERE id = $7
       RETURNING ${SELECT_COLS}`,
      [type, amount, category, memo, date, scope, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 내역을 찾을 수 없습니다.' });
    }
    res.json(rowToTransaction(rows[0])); // raw 객체
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 내역 id 형식입니다.' });
    }
    console.error('PUT /api/transactions/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '내역을 수정하지 못했습니다.' });
  }
});

// --- DELETE /api/transactions/:id : 내역 삭제 ---
// 프론트의 api.remove() 가 res.json() 으로 파싱하므로 반드시 JSON 본문을 준다.
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 내역을 찾을 수 없습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 내역 id 형식입니다.' });
    }
    console.error('DELETE /api/transactions/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '내역을 삭제하지 못했습니다.' });
  }
});

// --- GET /api/summary : 요약 집계 (SQL 로 계산) ---
//   { totalIncome, totalExpense, balance, byCategory: [{ category, type, total }] }
//   ?scope=personal|company 로 회사/개인 분리 집계 가능.
//   ※ 현재 프론트는 클라이언트에서 직접 계산하지만, 계약 충족 + 서버 단일 출처 용도로 제공.
app.get('/api/summary', async (req, res) => {
  try {
    const scope = parseScope(req.query.scope);
    const where = scope ? 'WHERE scope = $1' : '';
    const params = scope ? [scope] : [];

    // 타입별 총합
    const totalsQ = await pool.query(
      `SELECT type, COALESCE(SUM(amount), 0)::bigint AS total
       FROM transactions ${where} GROUP BY type`,
      params
    );
    let totalIncome = 0, totalExpense = 0;
    for (const r of totalsQ.rows) {
      if (r.type === 'income') totalIncome = Number(r.total);
      else if (r.type === 'expense') totalExpense = Number(r.total);
    }

    // (type, category) 별 합계
    const byCatQ = await pool.query(
      `SELECT category, type, COALESCE(SUM(amount), 0)::bigint AS total
       FROM transactions ${where}
       GROUP BY category, type
       ORDER BY total DESC`,
      params
    );
    const byCategory = byCatQ.rows.map((r) => ({
      category: r.category,
      type: r.type,
      total: Number(r.total),
    }));

    res.json({
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      byCategory,
    }); // raw 객체
  } catch (err) {
    console.error('GET /api/summary 오류:', err.message);
    res.status(500).json({ success: false, message: '요약을 계산하지 못했습니다.' });
  }
});

// ========================================
// 📊 차트 집계 엔드포인트 (transactions 테이블 GROUP BY)
// ⚠️ 응답은 raw 배열(봉투 없음). income/expense 는 정수(Number).
// ========================================

// --- GET /api/monthly : 월별 수입/지출 합계 (month 오름차순) ---
//   [{ month: '2026-06', income: 3200000, expense: 106900 }]
//   to_char(date,'YYYY-MM') 로 그룹핑. 데이터 있는 월만.
//   ?scope=personal|company 로 회사/개인 필터 가능 (차트의 분류 보기용)
app.get('/api/monthly', async (req, res) => {
  try {
    const scope = parseScope(req.query.scope);
    const where = scope ? 'WHERE scope = $1' : '';
    const params = scope ? [scope] : [];
    const { rows } = await pool.query(
      `SELECT
         to_char(date, 'YYYY-MM') AS month,
         COALESCE(SUM(amount) FILTER (WHERE type = 'income'),  0)::bigint AS income,
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::bigint AS expense
       FROM transactions
       ${where}
       GROUP BY 1
       ORDER BY 1 ASC`,
      params
    );
    res.json(
      rows.map((r) => ({
        month: r.month,
        income: Number(r.income),
        expense: Number(r.expense),
      }))
    ); // raw 배열
  } catch (err) {
    console.error('GET /api/monthly 오류:', err.message);
    res.status(500).json({ success: false, message: '월별 집계를 계산하지 못했습니다.' });
  }
});

// --- GET /api/weekly : 주별 수입/지출 합계 (weekStart 오름차순) ---
//   [{ weekStart: '2026-06-22', income: 0, expense: 76900 }]
//   date_trunc('week', date) → ISO 주(월요일 시작). weekStart 는 'YYYY-MM-DD'.
//   ?scope=personal|company 로 회사/개인 필터 가능 (차트의 분류 보기용)
app.get('/api/weekly', async (req, res) => {
  try {
    const scope = parseScope(req.query.scope);
    const where = scope ? 'WHERE scope = $1' : '';
    const params = scope ? [scope] : [];
    const { rows } = await pool.query(
      `SELECT
         to_char(date_trunc('week', date), 'YYYY-MM-DD') AS week_start,
         COALESCE(SUM(amount) FILTER (WHERE type = 'income'),  0)::bigint AS income,
         COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::bigint AS expense
       FROM transactions
       ${where}
       GROUP BY date_trunc('week', date)
       ORDER BY date_trunc('week', date) ASC`,
      params
    );
    res.json(
      rows.map((r) => ({
        weekStart: r.week_start,
        income: Number(r.income),
        expense: Number(r.expense),
      }))
    ); // raw 배열
  } catch (err) {
    console.error('GET /api/weekly 오류:', err.message);
    res.status(500).json({ success: false, message: '주별 집계를 계산하지 못했습니다.' });
  }
});

// ========================================
// 💵 예산(budgets) CRUD
// ⚠️ 응답은 raw (봉투 없음). 단, DELETE 만 { success: true } JSON 반환.
// ========================================

// budgets row → 클라이언트 모델 (amount 는 number 로 변환)
function rowToBudget(row) {
  return {
    id: row.id,
    category: row.category,
    amount: Number(row.amount),
  };
}

// 예산 입력 검증 (POST/PUT 공용)
//   - category : 비어있지 않은 문자열 (필수)
//   - amount   : 0보다 큰 정수(원)
// 반환: { valid, message?, values? }
function validateBudget(body) {
  const b = body || {};

  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!category) {
    return { valid: false, message: 'category 는 필수입니다.' };
  }

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return { valid: false, message: 'amount 는 0보다 큰 정수(원 단위)여야 합니다.' };
  }

  return { valid: true, values: { category, amount } };
}

// --- GET /api/budgets : 전체 예산 (category 오름차순) ---
app.get('/api/budgets', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, category, amount FROM budgets ORDER BY category ASC'
    );
    res.json(rows.map(rowToBudget)); // raw 배열
  } catch (err) {
    console.error('GET /api/budgets 오류:', err.message);
    res.status(500).json({ success: false, message: '예산을 불러오지 못했습니다.' });
  }
});

// --- POST /api/budgets : 예산 추가 (category UNIQUE → upsert) ---
// body: { category, amount }
//   기존 category 면 UPDATE(200), 신규면 INSERT(201).
app.post('/api/budgets', async (req, res) => {
  try {
    const check = validateBudget(req.body);
    if (!check.valid) {
      return res.status(400).json({ success: false, message: check.message });
    }
    const { category, amount } = check.values;

    const { rows } = await pool.query(
      `INSERT INTO budgets (category, amount)
       VALUES ($1, $2)
       ON CONFLICT (category) DO UPDATE SET amount = EXCLUDED.amount
       RETURNING id, category, amount, (xmax = 0) AS inserted`,
      [category, amount]
    );
    const wasInserted = rows[0].inserted; // xmax=0 → 신규 INSERT
    res.status(wasInserted ? 201 : 200).json(rowToBudget(rows[0])); // raw 객체
  } catch (err) {
    console.error('POST /api/budgets 오류:', err.message);
    res.status(500).json({ success: false, message: '예산을 저장하지 못했습니다.' });
  }
});

// --- PUT /api/budgets/:id : 예산 수정 ---
// body: { category, amount }
app.put('/api/budgets/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const check = validateBudget(req.body);
    if (!check.valid) {
      return res.status(400).json({ success: false, message: check.message });
    }
    const { category, amount } = check.values;

    const { rows } = await pool.query(
      `UPDATE budgets
       SET category = $1, amount = $2
       WHERE id = $3
       RETURNING id, category, amount`,
      [category, amount, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 예산을 찾을 수 없습니다.' });
    }
    res.json(rowToBudget(rows[0])); // raw 객체
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 예산 id 형식입니다.' });
    }
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: '이미 존재하는 category 입니다.' });
    }
    console.error('PUT /api/budgets/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '예산을 수정하지 못했습니다.' });
  }
});

// --- DELETE /api/budgets/:id : 예산 삭제 ---
app.delete('/api/budgets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM budgets WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 예산을 찾을 수 없습니다.' });
    }
    res.json({ success: true });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 예산 id 형식입니다.' });
    }
    console.error('DELETE /api/budgets/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '예산을 삭제하지 못했습니다.' });
  }
});

// ========================================
// 📈 예산 대비 사용량 — GET /api/budget-usage?month=YYYY-MM
//   month 없으면 현재 월(서버 기준).
//   예산이 설정된 모든 카테고리 반환(지출 0이어도 spent=0). category 오름차순.
//   [{ category, budget, spent, remaining, ratio }]
//     budget=예산 amount, spent=해당 월·해당 category 의 expense 합계,
//     remaining=budget-spent(음수 가능), ratio=budget>0?round2(spent/budget):null
// ========================================
app.get('/api/budget-usage', async (req, res) => {
  try {
    let month = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    if (month) {
      // 형식 검증: 'YYYY-MM' + 실제 달(01~12)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return res
          .status(400)
          .json({ success: false, message: 'month 는 YYYY-MM 형식이어야 합니다.' });
      }
    } else {
      // 현재 월(서버 기준)
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      month = `${y}-${m}`;
    }

    // 예산 설정된 카테고리 기준 LEFT JOIN → 해당 월 expense 합계 매칭.
    const { rows } = await pool.query(
      `SELECT
         b.category AS category,
         b.amount::bigint AS budget,
         COALESCE(SUM(t.amount), 0)::bigint AS spent
       FROM budgets b
       LEFT JOIN transactions t
         ON t.category = b.category
        AND t.type = 'expense'
        AND to_char(t.date, 'YYYY-MM') = $1
       GROUP BY b.category, b.amount
       ORDER BY b.category ASC`,
      [month]
    );

    const data = rows.map((r) => {
      const budget = Number(r.budget);
      const spent = Number(r.spent);
      return {
        category: r.category,
        budget,
        spent,
        remaining: budget - spent,
        ratio: budget > 0 ? Math.round((spent / budget) * 100) / 100 : null,
      };
    });

    res.json(data); // raw 배열
  } catch (err) {
    console.error('GET /api/budget-usage 오류:', err.message);
    res.status(500).json({ success: false, message: '예산 사용량을 계산하지 못했습니다.' });
  }
});

// ========================================
// 🧾 월간 리포트 — GET /api/report?month=YYYY-MM
//   "자기만의 개성" 담당: 한 달 치를 SQL 로 통째로 분석해 리포트 재료를 만든다.
//   month 없으면 현재 월(서버 기준). 프론트(🐷 월간 머니 브리핑)가 등급/총평/인사이트로 가공.
//   응답(raw 객체):
//   {
//     month, prevMonth, txCount,
//     totalIncome, totalExpense, balance,
//     savingsRate,          // 수입>0 이면 round((수입-지출)/수입*100), 아니면 null
//     prevIncome, prevExpense,
//     momExpenseChange,     // 전월 대비 지출 증감률(%) — 전월 지출 0이면 null
//     dailyAvgExpense, daysCounted,  // 하루 평균 지출(진행 중인 달이면 오늘까지 일수 기준)
//     topCategories: [{ category, total, pct }],           // 지출 상위 3
//     topExpense: { amount, category, memo, date, scope } | null, // 최대 단일 지출
//     scope: { personal:{income,expense}, company:{income,expense} }, // 회사/개인 분류 합계
//     budgets: [{ category, budget, spent, remaining }]    // 해당 월 예산 대비
//       ※ ratio 는 주지 않는다 — 소수/퍼센트 계약 혼동 방지, 프론트가 spent/budget 로 직접 계산
//   }
// ========================================
app.get('/api/report', async (req, res) => {
  try {
    let month = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return res
          .status(400)
          .json({ success: false, message: 'month 는 YYYY-MM 형식이어야 합니다.' });
      }
    } else {
      const now = new Date();
      month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    // 전월 계산 ('2026-01' → '2025-12'). UTC 고정으로 타임존 밀림 방지.
    const [y, m] = month.split('-').map(Number);
    const prevDate = new Date(Date.UTC(y, m - 2, 1));
    const prevMonth = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;

    // 5개 집계를 병렬 실행:
    // 1) 이번 달 (type, scope)별 합계+건수  2) 전월 type별 합계
    // 3) 지출 상위 카테고리 3               4) 최대 단일 지출 1건
    // 5) 예산 대비 (해당 월 지출 매칭)
    const [curQ, prevQ, topCatQ, topExpQ, budgetQ] = await Promise.all([
      pool.query(
        `SELECT type, scope, COALESCE(SUM(amount),0)::bigint AS total, COUNT(*)::int AS cnt
         FROM transactions WHERE to_char(date,'YYYY-MM') = $1 GROUP BY type, scope`,
        [month]
      ),
      pool.query(
        `SELECT type, COALESCE(SUM(amount),0)::bigint AS total
         FROM transactions WHERE to_char(date,'YYYY-MM') = $1 GROUP BY type`,
        [prevMonth]
      ),
      pool.query(
        `SELECT category, COALESCE(SUM(amount),0)::bigint AS total
         FROM transactions WHERE type = 'expense' AND to_char(date,'YYYY-MM') = $1
         GROUP BY category ORDER BY total DESC LIMIT 3`,
        [month]
      ),
      pool.query(
        `SELECT amount, category, memo, to_char(date,'YYYY-MM-DD') AS date, scope
         FROM transactions WHERE type = 'expense' AND to_char(date,'YYYY-MM') = $1
         ORDER BY amount DESC, date DESC LIMIT 1`,
        [month]
      ),
      pool.query(
        `SELECT b.category, b.amount::bigint AS budget, COALESCE(SUM(t.amount),0)::bigint AS spent
         FROM budgets b
         LEFT JOIN transactions t
           ON t.category = b.category AND t.type = 'expense' AND to_char(t.date,'YYYY-MM') = $1
         GROUP BY b.category, b.amount ORDER BY b.category ASC`,
        [month]
      ),
    ]);

    // (type, scope) 집계 → 총합 + 회사/개인 분류합 재구성
    let totalIncome = 0, totalExpense = 0, txCount = 0;
    const scopeSplit = {
      personal: { income: 0, expense: 0 },
      company: { income: 0, expense: 0 },
    };
    for (const r of curQ.rows) {
      const total = Number(r.total);
      txCount += r.cnt;
      const typeKey = r.type === 'income' ? 'income' : 'expense';
      if (typeKey === 'income') totalIncome += total; else totalExpense += total;
      const s = r.scope === 'company' ? 'company' : 'personal';
      scopeSplit[s][typeKey] += total;
    }

    let prevIncome = 0, prevExpense = 0;
    for (const r of prevQ.rows) {
      if (r.type === 'income') prevIncome = Number(r.total);
      else prevExpense = Number(r.total);
    }

    // 하루 평균 지출: 진행 중인 달이면 "오늘까지 일수", 지난달이면 그 달 전체 일수로 나눔.
    const now = new Date();
    const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const daysInMonth = new Date(y, m, 0).getDate();
    const daysCounted = month === nowMonth ? Math.min(now.getDate(), daysInMonth) : daysInMonth;

    const top = topExpQ.rows[0];

    res.json({
      month,
      prevMonth,
      txCount,
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      savingsRate:
        totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : null,
      prevIncome,
      prevExpense,
      momExpenseChange:
        prevExpense > 0 ? Math.round(((totalExpense - prevExpense) / prevExpense) * 100) : null,
      dailyAvgExpense: daysCounted > 0 ? Math.round(totalExpense / daysCounted) : 0,
      daysCounted,
      topCategories: topCatQ.rows.map((r) => ({
        category: r.category,
        total: Number(r.total),
        pct: totalExpense > 0 ? Math.round((Number(r.total) / totalExpense) * 100) : 0,
      })),
      topExpense: top
        ? {
            amount: Number(top.amount),
            category: top.category,
            memo: top.memo || '',
            date: top.date,
            scope: top.scope === 'company' ? 'company' : 'personal',
          }
        : null,
      scope: scopeSplit,
      budgets: budgetQ.rows.map((r) => {
        const budget = Number(r.budget);
        const spent = Number(r.spent);
        return { category: r.category, budget, spent, remaining: budget - spent };
      }),
    }); // raw 객체
  } catch (err) {
    console.error('GET /api/report 오류:', err.message);
    res.status(500).json({ success: false, message: '월간 리포트를 계산하지 못했습니다.' });
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
    console.log(`✅ 가계부 서버 실행 중 → http://localhost:${PORT}`);
  });

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
