// ========================================
// 🏗️  인테리어 현장 비용관리 앱 백엔드 (Supabase PostgreSQL 영속화)
// AFM week-5 / quest (Server + DB)
//
// 핵심:
//   - Express  : 정적 파일(index.html) 서빙 + REST CRUD/요약/내보내기 API 제공
//   - pg(Pool) : Supabase(Supavisor transaction pooler, :6543, SSL) 연결
//   - dotenv   : 자격 증명을 .env 에서 읽어옴 (코드에 하드코딩 금지)
//   - fs       : 현장 폴더(sites/<현장명>/receipts/) 실제 생성 + CSV 파일 출력
//
// 테이블 2개 (공유 Supabase → prefix interior_ 로 충돌 방지):
//   interior_sites  (현장: name/client/address/manager/budget/start_date/end_date/folder)
//   interior_costs  (비용: site_id FK ON DELETE CASCADE, date/amount/category/process/...)
//
// ⚠️ index.html(UI)이 기대하는 API 계약(CONTRACT.md)에 1:1 로 맞춰져 있다.
//    *** 성공 응답은 raw JSON (봉투 없음). 단 DELETE 는 { success: true }. ***
//    - 금액(amount/budget)은 원(KRW) 정수. pg BIGINT → Number() 변환.
//    - 모든 DATE 는 to_char(col,'YYYY-MM-DD') 문자열 (타임존 하루밀림 방지).
//
// 🔐 보안: DB 접속 정보는 process.env.DATABASE_URL 로만 읽고, .env 는 .gitignore 로 제외.
// ========================================

require('dotenv').config(); // .env → process.env 로 로드 (가장 먼저 실행)

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();

// PORT 는 .env 에서, 없으면 3010. (3005 my-food / 3006 todos / 3007 income / 3008 community / 3009 shop)
const PORT = Number((process.env.PORT || '3010').trim());

// ----------------------------------------
// PostgreSQL 연결 풀
//   - connectionString(DATABASE_URL) 방식. trailing newline 방어로 .trim().
//   - 포트 6543 = Supabase 트랜잭션 풀러(pgBouncer). prepared statement 이슈 시 5432 로.
//   - Supabase 는 SSL 필수 → rejectUnauthorized:false (self-signed 체인 허용).
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
// 테이블 자동 생성 (부팅 시 + /api lazy-init)
//   CREATE TABLE IF NOT EXISTS → 이미 있으면 no-op. 서버리스 cold start 중복 방지 flag.
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;

  // 현장
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_sites (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      client TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      manager TEXT NOT NULL DEFAULT '',
      budget BIGINT NOT NULL DEFAULT 0 CHECK (budget >= 0),
      start_date DATE,
      end_date DATE,
      folder TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 비용 내역 (site 삭제 시 CASCADE)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_costs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      amount BIGINT NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      process TEXT NOT NULL DEFAULT '',
      manager TEXT NOT NULL DEFAULT '',
      vendor TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 비용 목록 정렬(site_id, date DESC, created_at DESC) 가속 인덱스
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_interior_costs_site_date ON interior_costs (site_id, date DESC, created_at DESC);'
  );

  dbInitialized = true;
  console.log('🗄️  interior_sites / interior_costs 테이블 준비 완료.');
}

// ========================================
// 미들웨어
// ========================================
app.use(express.json());
app.use(express.static(path.join(__dirname))); // index.html 같은 origin 서빙

// /api/* 는 처리 전 테이블 보장 (lazy init: cold start 대응 + 부팅 DB 지연 자가복구)
app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('❌ DB 초기화 실패:', err.message);
    res
      .status(500)
      .json({ success: false, message: '데이터베이스 초기화에 실패했습니다. .env(DATABASE_URL)를 확인해 주세요.' });
  }
});

// ========================================
// 헬퍼
// ========================================

// 'YYYY-MM-DD' 가 실제 달력상 존재하는 날짜인지 (예: 2026-02-30 거르기)
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 현장명 새니타이즈: 경로 탈출(../) 및 OS 금지문자 차단.
//   / \ .. : * ? " < > | 및 제어문자 → _, 한글/공백 허용, 앞뒤 공백 trim.
function sanitizeSiteName(name) {
  let s = String(name == null ? '' : name).trim();
  s = s.replace(/\.\./g, '_'); // 상위경로 탈출 차단
  s = s.replace(/[\/\\:*?"<>|]/g, '_'); // OS 예약/경로 구분 문자
  // eslint-disable-next-line no-control-regex
  s = s.replace(new RegExp("[\\x00-\\x1f\\x7f]", "g"), '_'); // control chars
  s = s.replace(/^\.+/, '_'); // 선두 점(., 숨김/상대경로) 차단
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = 'site';
  return s;
}

// 현장 폴더(sites/<safeName>/receipts/)를 실제 생성하고, sites/ 밖으로 못 나가게 검증.
// 반환: 현장 폴더 상대경로 (folder 컬럼 저장용) e.g. 'sites/우리집 리모델링'
function createSiteFolder(name) {
  const safeName = sanitizeSiteName(name);
  const sitesRoot = path.join(__dirname, 'sites');
  const siteAbs = path.join(sitesRoot, safeName);

  // 최종 경로 탈출 방지: 반드시 sites/ 하위여야 한다.
  const rootWithSep = sitesRoot + path.sep;
  if (siteAbs !== sitesRoot.slice(0, -1) && !siteAbs.startsWith(rootWithSep)) {
    throw new Error('잘못된 현장 폴더 경로입니다.');
  }

  fs.mkdirSync(path.join(siteAbs, 'receipts'), { recursive: true });
  return path.join('sites', safeName); // 상대경로 (OS 구분자 그대로)
}

// :id 가 양의 정수인지
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  return raw;
}

// ----------------------------------------
// row → 클라이언트 모델 매핑 (BIGINT → Number, DATE 는 이미 to_char 텍스트)
// ----------------------------------------
function rowToSite(row) {
  return {
    id: row.id,
    name: row.name,
    client: row.client || '',
    address: row.address || '',
    manager: row.manager || '',
    budget: Number(row.budget),
    start_date: row.start_date, // 'YYYY-MM-DD' | null
    end_date: row.end_date, // 'YYYY-MM-DD' | null
    folder: row.folder || '',
    created_at: new Date(row.created_at).toISOString(),
  };
}

function rowToCost(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    date: row.date, // 'YYYY-MM-DD'
    amount: Number(row.amount),
    category: row.category,
    process: row.process || '',
    manager: row.manager || '',
    vendor: row.vendor || '',
    memo: row.memo || '',
    created_at: new Date(row.created_at).toISOString(),
  };
}

const SITE_COLS =
  "id, name, client, address, manager, budget, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, folder, created_at";
const COST_COLS =
  "id, site_id, to_char(date,'YYYY-MM-DD') AS date, amount, category, process, manager, vendor, memo, created_at";

// ----------------------------------------
// 입력 검증
// ----------------------------------------
function validateSite(body) {
  const b = body || {};

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: 'name(현장명) 은 필수입니다.' };

  // budget: 0 이상 정수 (미입력 → 0)
  let budget = 0;
  if (b.budget !== undefined && b.budget !== null && b.budget !== '') {
    budget = Number(b.budget);
    if (!Number.isFinite(budget) || !Number.isInteger(budget) || budget < 0) {
      return { valid: false, message: 'budget(견적비) 은 0 이상의 정수(원)여야 합니다.' };
    }
  }

  // 날짜는 선택. 있으면 유효성 검증.
  const start_date = typeof b.start_date === 'string' && b.start_date.trim() ? b.start_date.trim() : null;
  const end_date = typeof b.end_date === 'string' && b.end_date.trim() ? b.end_date.trim() : null;
  if (start_date && !isRealDate(start_date)) {
    return { valid: false, message: 'start_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }
  if (end_date && !isRealDate(end_date)) {
    return { valid: false, message: 'end_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }
  if (start_date && end_date && start_date > end_date) {
    return { valid: false, message: 'start_date 는 end_date 보다 이후일 수 없습니다.' };
  }

  return {
    valid: true,
    values: {
      name,
      client: typeof b.client === 'string' ? b.client.trim() : '',
      address: typeof b.address === 'string' ? b.address.trim() : '',
      manager: typeof b.manager === 'string' ? b.manager.trim() : '',
      budget,
      start_date,
      end_date,
    },
  };
}

function validateCost(body) {
  const b = body || {};

  const date = typeof b.date === 'string' ? b.date.trim() : '';
  if (!isRealDate(date)) {
    return { valid: false, message: 'date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return { valid: false, message: 'amount 는 0보다 큰 정수(원)여야 합니다.' };
  }

  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!category) return { valid: false, message: 'category(비용 카테고리) 는 필수입니다.' };

  return {
    valid: true,
    values: {
      date,
      amount,
      category,
      process: typeof b.process === 'string' ? b.process.trim() : '',
      manager: typeof b.manager === 'string' ? b.manager.trim() : '',
      vendor: typeof b.vendor === 'string' ? b.vendor.trim() : '',
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
    },
  };
}

// ========================================
// REST API — 현장(interior_sites)
// 응답은 raw. DELETE 만 { success:true }. 상태: 200/201/400/404/409/500.
// ========================================

// GET /api/sites — 현장 배열 (created_at 최신순)
app.get('/api/sites', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${SITE_COLS} FROM interior_sites ORDER BY created_at DESC`);
    res.json(rows.map(rowToSite));
  } catch (err) {
    console.error('GET /api/sites 오류:', err.message);
    res.status(500).json({ success: false, message: '현장 목록을 불러오지 못했습니다.' });
  }
});

// POST /api/sites — 현장 생성 + 폴더 실제 생성
app.post('/api/sites', async (req, res) => {
  try {
    const check = validateSite(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    // 폴더 먼저 생성 (sites/<safeName>/receipts/) → 경로 저장
    let folder = '';
    try {
      folder = createSiteFolder(v.name);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    const { rows } = await pool.query(
      `INSERT INTO interior_sites (name, client, address, manager, budget, start_date, end_date, folder)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${SITE_COLS}`,
      [v.name, v.client, v.address, v.manager, v.budget, v.start_date, v.end_date, folder]
    );
    res.status(201).json(rowToSite(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: '이미 존재하는 현장명입니다.' });
    }
    console.error('POST /api/sites 오류:', err.message);
    res.status(500).json({ success: false, message: '현장을 생성하지 못했습니다.' });
  }
});

// PUT /api/sites/:id — 현장 수정 (폴더는 그대로 유지)
app.put('/api/sites/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const check = validateSite(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    const { rows } = await pool.query(
      `UPDATE interior_sites
       SET name=$1, client=$2, address=$3, manager=$4, budget=$5, start_date=$6, end_date=$7
       WHERE id=$8
       RETURNING ${SITE_COLS}`,
      [v.name, v.client, v.address, v.manager, v.budget, v.start_date, v.end_date, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    res.json(rowToSite(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: '이미 존재하는 현장명입니다.' });
    }
    console.error('PUT /api/sites/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '현장을 수정하지 못했습니다.' });
  }
});

// DELETE /api/sites/:id — 현장 삭제 (costs CASCADE). 폴더/파일은 보존.
app.delete('/api/sites/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const { rowCount } = await pool.query('DELETE FROM interior_sites WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/sites/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '현장을 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 비용(interior_costs)
// ========================================

// GET /api/sites/:id/costs — 현장 비용 배열 (date DESC, created_at DESC)
app.get('/api/sites/:id/costs', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const { rows } = await pool.query(
      `SELECT ${COST_COLS} FROM interior_costs WHERE site_id=$1 ORDER BY date DESC, created_at DESC`,
      [id]
    );
    res.json(rows.map(rowToCost));
  } catch (err) {
    console.error('GET /api/sites/:id/costs 오류:', err.message);
    res.status(500).json({ success: false, message: '비용 목록을 불러오지 못했습니다.' });
  }
});

// POST /api/sites/:id/costs — 비용 생성 (201)
app.post('/api/sites/:id/costs', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const check = validateCost(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    // 현장 존재 확인 (FK 위반 전 친절한 404)
    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    const { rows } = await pool.query(
      `INSERT INTO interior_costs (site_id, date, amount, category, process, manager, vendor, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${COST_COLS}`,
      [id, v.date, v.amount, v.category, v.process, v.manager, v.vendor, v.memo]
    );
    res.status(201).json(rowToCost(rows[0]));
  } catch (err) {
    console.error('POST /api/sites/:id/costs 오류:', err.message);
    res.status(500).json({ success: false, message: '비용을 저장하지 못했습니다.' });
  }
});

// PUT /api/costs/:id — 비용 수정
app.put('/api/costs/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 비용 id 형식입니다.' });

    const check = validateCost(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    const { rows } = await pool.query(
      `UPDATE interior_costs
       SET date=$1, amount=$2, category=$3, process=$4, manager=$5, vendor=$6, memo=$7
       WHERE id=$8
       RETURNING ${COST_COLS}`,
      [v.date, v.amount, v.category, v.process, v.manager, v.vendor, v.memo, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 비용 내역을 찾을 수 없습니다.' });
    res.json(rowToCost(rows[0]));
  } catch (err) {
    console.error('PUT /api/costs/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '비용을 수정하지 못했습니다.' });
  }
});

// DELETE /api/costs/:id — 비용 삭제
app.delete('/api/costs/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 비용 id 형식입니다.' });

    const { rowCount } = await pool.query('DELETE FROM interior_costs WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 비용 내역을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/costs/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '비용을 삭제하지 못했습니다.' });
  }
});

// ========================================
// 요약/계산 — GET /api/sites/:id/summary
//   견적비 대비 집행/잔여/집행률, 카테고리별·공정별 합계, 날짜(공기) 계산.
//   날짜 계산은 SQL(CURRENT_DATE, date 빼기)로.
// ========================================
app.get('/api/sites/:id/summary', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    // 현장 + 날짜 계산을 한 번에 (CURRENT_DATE 서버 기준)
    const siteQ = await pool.query(
      `SELECT
         budget,
         to_char(start_date,'YYYY-MM-DD') AS start_date,
         to_char(end_date,'YYYY-MM-DD')   AS end_date,
         (end_date - start_date)          AS total_days,
         (CURRENT_DATE - start_date)      AS elapsed_raw,
         (end_date - CURRENT_DATE)        AS remaining_days,
         (end_date - CURRENT_DATE)        AS dday
       FROM interior_sites WHERE id=$1`,
      [id]
    );
    if (siteQ.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    const s = siteQ.rows[0];
    const budget = Number(s.budget);

    // 집행 합계
    const spentQ = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::bigint AS spent FROM interior_costs WHERE site_id=$1`,
      [id]
    );
    const spent = Number(spentQ.rows[0].spent);

    // 카테고리별 합계
    const byCatQ = await pool.query(
      `SELECT category, COALESCE(SUM(amount),0)::bigint AS total
       FROM interior_costs WHERE site_id=$1 GROUP BY category ORDER BY total DESC`,
      [id]
    );
    // 공정별 합계 (process 가 빈 문자열인 행은 '미분류' 로 표기)
    const byProcQ = await pool.query(
      `SELECT CASE WHEN process IS NULL OR process='' THEN '미분류' ELSE process END AS process,
              COALESCE(SUM(amount),0)::bigint AS total
       FROM interior_costs WHERE site_id=$1
       GROUP BY 1 ORDER BY total DESC`,
      [id]
    );

    // schedule 계산 (날짜 일부 없으면 null 처리)
    let schedule;
    if (s.start_date && s.end_date) {
      const totalDays = Number(s.total_days);
      const elapsedRaw = Number(s.elapsed_raw);
      const elapsedDays = Math.max(0, Math.min(elapsedRaw, totalDays)); // clamp 0..total
      const remainingDays = Number(s.remaining_days);
      const dday = Number(s.dday);
      schedule = {
        start_date: s.start_date,
        end_date: s.end_date,
        totalDays,
        elapsedDays,
        remainingDays,
        progressRate: totalDays > 0 ? Math.round((elapsedDays / totalDays) * 100) / 100 : null,
        dday,
      };
    } else {
      schedule = {
        start_date: s.start_date,
        end_date: s.end_date,
        totalDays: null,
        elapsedDays: null,
        remainingDays: null,
        progressRate: null,
        dday: null,
      };
    }

    res.json({
      budget,
      spent,
      remaining: budget - spent,
      rate: budget > 0 ? Math.round((spent / budget) * 100) / 100 : null,
      byCategory: byCatQ.rows.map((r) => ({ category: r.category, total: Number(r.total) })),
      byProcess: byProcQ.rows.map((r) => ({ process: r.process, total: Number(r.total) })),
      schedule,
    });
  } catch (err) {
    console.error('GET /api/sites/:id/summary 오류:', err.message);
    res.status(500).json({ success: false, message: '요약을 계산하지 못했습니다.' });
  }
});

// ========================================
// 내보내기 — GET /api/sites/:id/export
//   현장 비용을 CSV 로 만들어 sites/<현장폴더>/costs-export.csv 에 저장하고,
//   UTF-8 BOM + text/csv + Content-Disposition 으로 파일 다운로드 응답.
//   컬럼: 날짜,금액,비용카테고리,공정,담당자,거래처,메모
// ========================================
function csvCell(v) {
  const s = v == null ? '' : String(v);
  // 큰따옴표/콤마/개행 포함 시 따옴표로 감싸고 내부 따옴표는 두 배로 escape
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/sites/:id/export', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const siteQ = await pool.query('SELECT name, folder FROM interior_sites WHERE id=$1', [id]);
    if (siteQ.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    const site = siteQ.rows[0];

    const { rows } = await pool.query(
      `SELECT ${COST_COLS} FROM interior_costs WHERE site_id=$1 ORDER BY date DESC, created_at DESC`,
      [id]
    );
    const costs = rows.map(rowToCost);

    const header = ['날짜', '금액', '비용카테고리', '공정', '담당자', '거래처', '메모'];
    const lines = [header.map(csvCell).join(',')];
    for (const c of costs) {
      lines.push(
        [c.date, c.amount, c.category, c.process, c.manager, c.vendor, c.memo].map(csvCell).join(',')
      );
    }
    const BOM = '﻿';
    const csv = BOM + lines.join('\r\n') + '\r\n';

    // 현장 폴더에 저장 (folder 가 비었거나 사라졌으면 안전하게 재생성)
    let folderRel = site.folder;
    if (!folderRel) folderRel = createSiteFolder(site.name);
    const folderAbs = path.join(__dirname, folderRel);
    // 경로 탈출 방어: 반드시 sites/ 하위
    const sitesRoot = path.join(__dirname, 'sites');
    if (!folderAbs.startsWith(sitesRoot + path.sep)) {
      folderRel = createSiteFolder(site.name);
    }
    fs.mkdirSync(path.join(__dirname, folderRel), { recursive: true });
    const filePath = path.join(__dirname, folderRel, 'costs-export.csv');
    fs.writeFileSync(filePath, csv, 'utf8');

    const downloadName = `${sanitizeSiteName(site.name)}-costs-export.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="costs-export.csv"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    res.send(csv);
  } catch (err) {
    console.error('GET /api/sites/:id/export 오류:', err.message);
    res.status(500).json({ success: false, message: 'CSV 내보내기에 실패했습니다.' });
  }
});

// ========================================
// /api/* JSON 404 (SPA 폴백이 삼키지 않도록 API 라우트들 뒤, '*' 폴백 앞)
// ========================================
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API 경로입니다.' });
});

// ========================================
// SPA / 정적 폴백 (Express 4 문법: '*'). 반드시 /api 라우트들보다 뒤.
// ========================================
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 에러 처리 미들웨어 (마지막 안전망)
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '올바른 JSON 형식이 아닙니다.' });
  }
  console.error('처리되지 않은 오류:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ========================================
// 서버 시작 (로컬에서 직접 실행할 때만 listen → Vercel 서버리스 호환)
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 인테리어 비용관리 서버 실행 중 → http://localhost:${PORT}`);
  });

  initDB()
    .then(() => console.log('🔌 Supabase PostgreSQL 연결 성공.'))
    .catch((err) => {
      console.error('────────────────────────────────────────────');
      console.error('❌ 부팅 시 DB 연결/초기화 실패:', err.message);
      console.error('   1) .env 의 DATABASE_URL 확인 (비밀번호 포함)');
      console.error('   2) 포트 6543(트랜잭션 풀러) 이슈면 5432(세션 풀러)로 변경');
      console.error('   3) 네트워크가 Supabase(:6543)로 나갈 수 있는지 확인');
      console.error('   → 정적 파일 서빙과 /api 재시도는 계속 동작합니다.');
      console.error('────────────────────────────────────────────');
    });
}

module.exports = app;
