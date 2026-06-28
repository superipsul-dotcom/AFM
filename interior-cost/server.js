// ========================================
// 🏗️  인테리어 현장 비용관리 앱 백엔드 (Supabase PostgreSQL 영속화)
// AFM week-5 / quest (Server + DB)  —  v2: 일정(캘린더) / 견적서 / 관리(마스터) 확장
//
// 핵심:
//   - Express  : 정적 파일(index.html) 서빙 + REST CRUD/요약/내보내기 API 제공
//   - pg(Pool) : Supabase(Supavisor transaction pooler, :6543, SSL) 연결
//   - dotenv   : 자격 증명을 .env 에서 읽어옴 (코드에 하드코딩 금지)
//   - fs       : 현장 폴더(sites/<현장명>/receipts/) 실제 생성 + CSV 파일 출력
//
// 테이블 (공유 Supabase → prefix interior_ 로 충돌 방지):
//   interior_sites          (현장: + v2 status/tags)
//   interior_costs          (비용: site_id FK CASCADE, + v2 schedule_id)
//   interior_staff          (담당자 마스터)
//   interior_vendors        (거래처 마스터)
//   interior_categories     (비용/공정 카테고리 — 편집 가능, 부팅 시 기본값 시드)
//   interior_schedule       (일정: 공정 단위 태스크, site_id FK CASCADE)
//   interior_estimates      (견적서 헤더, site_id FK CASCADE)
//   interior_estimate_items (견적 항목, estimate_id FK CASCADE)
//
// ⚠️ index.html(UI)이 기대하는 API 계약(CONTRACT.md)에 1:1 로 맞춰져 있다.
//    *** 성공 응답은 raw JSON (봉투 없음). 단 DELETE 는 { success: true }. ***
//    - 금액(amount/budget/unit_price/planned_cost)은 원(KRW) 정수. pg BIGINT → Number() 변환.
//    - 수량(qty)만 소수 허용(numeric). 모든 DATE 는 to_char(col,'YYYY-MM-DD') 문자열.
//    - 견적 금액/세금은 서버가 계산해 totals 로 내려준다(프론트 동일 공식).
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
// 테이블 자동 생성 + 마이그레이션 + 카테고리 시드 (부팅 시 + /api lazy-init)
//   CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS → 기존 데이터 보존, 멱등.
//   서버리스 cold start 중복 방지 flag.
// ----------------------------------------
let dbInitialized = false;

// 카테고리 기본값 (CONTRACT "카테고리 기본값") — sort_order 0..N
const SEED_COST = [
  '자재비', '인건비', '장비/공구', '운반/물류', '폐기물처리',
  '가설/안전', '외주(하도급)', '경비(식대/유류)', '임대료', '기타',
];
const SEED_PROCESS = [
  '철거', '설비', '전기', '목공', '미장/방수', '타일', '도장/도배',
  '바닥', '주방/가구', '욕실', '창호/도어', '조명', '준공/청소', '기타',
];

// (v3) 공종 마스터 21종 — seed/catalog.json 의 trade_master 를 서버 상수로 하드코딩.
//   GET /api/catalog/trades 가 이 순서 그대로 반환한다. interior_categories 는 건드리지 않음.
const TRADE_MASTER = [
  '가설공사', '철거공사', '창호공사', '단열/기밀공사', '설비공사', '방수공사', '경량공사',
  '목공사', '전기공사', '에어컨공사', '공조공사', '금속공사', '유리공사', '타일공사',
  '도장공사', '도배공사', '필름공사', '화장실셋팅공사', '바닥공사', '가구공사', '기타공사',
];

// (v4) 현장진행상태 워크플로 — 노션 프로젝트 DB 의 주(主) 상태. POST/PUT 에서 목록 외 값은 '준비'로 보정.
//   기존 status(견적/진행/완료/보류)·tags 와 별개로 공존(둘 다 보존).
const PROGRESS_STATES = ['준비', '착수', '완료', '마감', '인수'];

// (v3) 원가계산서 기본 가정율 (CONTRACT "interior_estimates 확장" / "원가계산서 산출식").
//   견적 헤더에 값이 안 오면 이 기본값 사용. 실제 견적서(.xlsm)로 원 단위 검증된 율.
const BUILDUP_DEFAULTS = {
  indirect_material_rate: 0.025, // 간접재료비 = 직접재료비 × 2.5%
  indirect_labor_rate: 0.03, // 간접노무비 = 직접노무비 × 3%
  safety_insurance_rate: 0.038, // 산재보험료 = 노무비소계 × 3.8%
  employment_insurance_rate: 0.0087, // 고용보험료 = 노무비소계 × 0.87%
  safety_mgmt_rate: 0.024, // 안전관리비 = (재료비소계+직접노무비) × 2.4%
  other_expense_rate: 0.01, // 기타경비 = (재료비소계+노무비소계) × 1%
  admin_rate: 0.07, // 일반관리비 = 순공사원가 × 7%
  design_rate: 0.05, // 디자인비용 = 순공사원가 × 5%
  profit_rate: 0.12, // 회사이윤 = 순공사원가 × 12%
};
const BUILDUP_RATE_KEYS = Object.keys(BUILDUP_DEFAULTS);

async function initDB() {
  if (dbInitialized) return;

  // 1) 현장 (v1)
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

  // 2) 현장 v2 컬럼 (기존 데이터 보존)
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT '진행'`);
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT ''`);

  // 2-1) (v4) 현장=프로젝트 노션 속성 7컬럼 (전부 ADD COLUMN IF NOT EXISTS → 기존 데이터 보존)
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS building_type TEXT NOT NULL DEFAULT ''`);
  await pool.query('ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS floor_area NUMERIC NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS move_in_date DATE');
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS pm TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS construction_manager TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS designer TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS progress_status TEXT NOT NULL DEFAULT '준비'`);

  // 3) 비용 내역 (v1, site 삭제 시 CASCADE)
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

  // 4) 담당자 마스터
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_staff (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 5) 거래처 마스터
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_vendors (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 6) 카테고리 (비용/공정, 편집 가능). UNIQUE(kind,name) → 시드 ON CONFLICT 키.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_categories (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('cost','process')),
      name TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (kind, name)
    );
  `);

  // 7) 일정 (공정 단위 태스크, 현장 삭제 시 CASCADE)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_schedule (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      process TEXT NOT NULL DEFAULT '',
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT '예정',
      planned_cost BIGINT NOT NULL DEFAULT 0 CHECK (planned_cost >= 0),
      staff TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 8) 견적서 헤더 (현장 삭제 시 CASCADE)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_estimates (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id BIGINT REFERENCES interior_sites(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '견적서',
      client_name TEXT NOT NULL DEFAULT '',
      client_contact TEXT NOT NULL DEFAULT '',
      estimate_date DATE,
      valid_until DATE,
      vat_mode TEXT NOT NULL DEFAULT 'exclusive',
      vat_rate NUMERIC NOT NULL DEFAULT 0.10,
      discount BIGINT NOT NULL DEFAULT 0 CHECK (discount >= 0),
      status TEXT NOT NULL DEFAULT 'draft',
      memo TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 9) 견적 항목 (견적 삭제 시 CASCADE). amount = round(qty*unit_price) 서버 계산 저장.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_estimate_items (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      estimate_id BIGINT NOT NULL REFERENCES interior_estimates(id) ON DELETE CASCADE,
      process TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      qty NUMERIC NOT NULL DEFAULT 1 CHECK (qty >= 0),
      unit TEXT NOT NULL DEFAULT '',
      unit_price BIGINT NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
      amount BIGINT NOT NULL DEFAULT 0,
      memo TEXT NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0
    );
  `);

  // 10) 비용 v2 컬럼: schedule_id (interior_schedule 생성 이후 추가).
  //     이미 컬럼이 있으면 IF NOT EXISTS 로 no-op(이때 FK 도 건너뜀) → 앱 레벨 검증/수동 SET NULL 로 보완.
  await pool.query(
    `ALTER TABLE interior_costs ADD COLUMN IF NOT EXISTS schedule_id BIGINT REFERENCES interior_schedule(id) ON DELETE SET NULL`
  );

  // 11) 카테고리 시드 (부팅 시 안전: ON CONFLICT(kind,name) DO NOTHING)
  await pool.query(
    `INSERT INTO interior_categories (kind, name, sort_order)
     SELECT 'cost', t.name, t.ord FROM unnest($1::text[], $2::int[]) AS t(name, ord)
     ON CONFLICT (kind, name) DO NOTHING`,
    [SEED_COST, SEED_COST.map((_, i) => i)]
  );
  await pool.query(
    `INSERT INTO interior_categories (kind, name, sort_order)
     SELECT 'process', t.name, t.ord FROM unnest($1::text[], $2::int[]) AS t(name, ord)
     ON CONFLICT (kind, name) DO NOTHING`,
    [SEED_PROCESS, SEED_PROCESS.map((_, i) => i)]
  );

  // 12) 인덱스 (목록/정렬/조인 가속)
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_interior_costs_site_date ON interior_costs (site_id, date DESC, created_at DESC);'
  );
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_costs_schedule ON interior_costs (schedule_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_schedule_site_start ON interior_schedule (site_id, start_date);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_estimates_site_created ON interior_estimates (site_id, created_at DESC);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_estimate_items_estimate_sort ON interior_estimate_items (estimate_id, sort_order);');

  // ====================================================================
  // (v3) 실무 견적 엔진 — 단가 카탈로그 + 견적 3분할/원가계산서 컬럼
  //   전부 CREATE TABLE / ADD COLUMN IF NOT EXISTS → v1/v2 데이터 100% 보존.
  // ====================================================================

  // 13) 단가 카탈로그(price book). UNIQUE 제약 없음(동일명 항목 공존 가능).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_catalog (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      trade TEXT NOT NULL,
      grp TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      material_price BIGINT NOT NULL DEFAULT 0,
      labor_price BIGINT NOT NULL DEFAULT 0,
      sub_price BIGINT NOT NULL DEFAULT 0,
      product_name TEXT NOT NULL DEFAULT '',
      vendor TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_catalog_trade_name ON interior_catalog (trade, name);');

  // 14) 견적 항목 3분할/공종/출처 컬럼 (기존 unit_price/amount 와 공존, 기존 데이터 보존)
  await pool.query(`ALTER TABLE interior_estimate_items ADD COLUMN IF NOT EXISTS trade TEXT NOT NULL DEFAULT ''`);
  await pool.query('ALTER TABLE interior_estimate_items ADD COLUMN IF NOT EXISTS material_price BIGINT NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE interior_estimate_items ADD COLUMN IF NOT EXISTS labor_price BIGINT NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE interior_estimate_items ADD COLUMN IF NOT EXISTS sub_price BIGINT NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE interior_estimate_items ADD COLUMN IF NOT EXISTS catalog_id BIGINT');

  // 15) 견적 헤더 원가계산서 컬럼 (use_cost_buildup + 9개 율 + round_unit). 기존 견적은 DEFAULT 로 v2 동작 유지.
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS use_cost_buildup BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS indirect_material_rate NUMERIC NOT NULL DEFAULT 0.025');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS indirect_labor_rate NUMERIC NOT NULL DEFAULT 0.03');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS safety_insurance_rate NUMERIC NOT NULL DEFAULT 0.038');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS employment_insurance_rate NUMERIC NOT NULL DEFAULT 0.0087');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS safety_mgmt_rate NUMERIC NOT NULL DEFAULT 0.024');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS other_expense_rate NUMERIC NOT NULL DEFAULT 0.01');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS admin_rate NUMERIC NOT NULL DEFAULT 0.07');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS design_rate NUMERIC NOT NULL DEFAULT 0.05');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS profit_rate NUMERIC NOT NULL DEFAULT 0.12');
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS round_unit BIGINT NOT NULL DEFAULT 0');

  // 16) 카탈로그 시드 — 비어 있을 때만 seed/catalog.json 의 catalog(562) bulk INSERT(한 트랜잭션).
  //     JSON 은 'group' 키 → DB 'grp' 컬럼으로 매핑. markup 류 컬럼은 스키마에 없어 무시.
  await seedCatalogIfEmpty();

  dbInitialized = true;
  console.log('🗄️  interior_* (sites/costs/staff/vendors/categories/schedule/estimates/estimate_items/catalog) 준비 완료 + 카테고리/카탈로그 시드.');
}

// (v3) 카탈로그가 비어 있을 때만 seed/catalog.json 을 읽어 일괄 적재 (트랜잭션). 실패해도 부팅은 계속.
async function seedCatalogIfEmpty() {
  let cnt;
  try {
    cnt = await pool.query('SELECT COUNT(*)::int AS n FROM interior_catalog');
  } catch (err) {
    console.warn('⚠️  카탈로그 개수 확인 실패(시드 생략):', err.message);
    return;
  }
  if (Number(cnt.rows[0].n) > 0) return; // 이미 적재됨 → no-op

  let items = [];
  try {
    const seedPath = path.join(__dirname, 'seed', 'catalog.json');
    const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    items = Array.isArray(raw.catalog) ? raw.catalog : [];
  } catch (err) {
    console.warn('⚠️  seed/catalog.json 읽기 실패(카탈로그 시드 생략):', err.message);
    return;
  }
  if (items.length === 0) return;

  const cols = ['trade', 'grp', 'name', 'unit', 'material_price', 'labor_price', 'sub_price', 'product_name', 'vendor', 'code'];
  const placeholders = [];
  const params = [];
  items.forEach((it, i) => {
    const base = i * cols.length;
    placeholders.push('(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')');
    const grp = it.grp != null ? it.grp : it.group != null ? it.group : ''; // JSON 은 'group'
    params.push(
      String(it.trade == null ? '' : it.trade),
      String(grp),
      String(it.name == null ? '' : it.name),
      String(it.unit == null ? '' : it.unit),
      Math.round(Number(it.material_price) || 0),
      Math.round(Number(it.labor_price) || 0),
      Math.round(Number(it.sub_price) || 0),
      String(it.product_name == null ? '' : it.product_name),
      String(it.vendor == null ? '' : it.vendor),
      String(it.code == null ? '' : it.code)
    );
  });

  // 동시 부팅/서버리스 콜드스타트 중복 시드 방지: advisory lock 으로 직렬화 후 재확인.
  //   (카탈로그엔 UNIQUE 제약이 없어 ON CONFLICT 로 막을 수 없음 → 락으로 1회만 적재 보장)
  const SEED_LOCK_KEY = 472019283; // interior_catalog 시드 전용 임의 키
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_KEY]); // 트랜잭션 종료 시 자동 해제
    const recheck = await client.query('SELECT COUNT(*)::int AS n FROM interior_catalog');
    if (Number(recheck.rows[0].n) === 0) {
      await client.query(`INSERT INTO interior_catalog (${cols.join(',')}) VALUES ${placeholders.join(',')}`, params);
      console.log(`📚 카탈로그 시드 완료: ${items.length}개 항목 적재.`);
    } else {
      console.log('📚 카탈로그 이미 적재됨(동시 시드 감지) — 건너뜀.');
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* noop */
    }
    console.warn('⚠️  카탈로그 bulk INSERT 실패(시드 생략):', err.message);
  } finally {
    client.release();
  }
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

// 다양한 truthy 표현 → boolean (JSON 불리언/문자열/숫자 모두 수용)
function parseBool(v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on', 't'].includes(s)) return true;
    if (['false', '0', 'no', 'n', 'off', 'f', ''].includes(s)) return false;
  }
  return dflt;
}

// ?all=1 / ?all=true 여부
function wantAll(req) {
  return req.query.all === '1' || req.query.all === 'true';
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
    status: row.status || '진행',
    tags: row.tags || '',
    // (v4) 노션 프로젝트 속성 7개 (건물종류/바닥면적/입주예정일/PM/시공책임/디자이너/진행상태)
    building_type: row.building_type || '',
    floor_area: Number(row.floor_area || 0), // NUMERIC → Number
    move_in_date: row.move_in_date, // 'YYYY-MM-DD' | null (to_char 직렬화)
    pm: row.pm || '',
    construction_manager: row.construction_manager || '',
    designer: row.designer || '',
    progress_status: row.progress_status || '준비',
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
    schedule_id: row.schedule_id == null ? null : String(row.schedule_id), // BIGINT → 문자열(다른 id들과 동일 타입 유지)
    created_at: new Date(row.created_at).toISOString(),
  };
}

function rowToStaff(row) {
  return {
    id: row.id,
    name: row.name,
    role: row.role || '',
    phone: row.phone || '',
    active: row.active,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function rowToVendor(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind || '',
    phone: row.phone || '',
    memo: row.memo || '',
    active: row.active,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function rowToCategory(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    sort_order: Number(row.sort_order || 0),
    active: row.active,
  };
}

function rowToSchedule(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    title: row.title,
    process: row.process || '',
    start_date: row.start_date, // 'YYYY-MM-DD'
    end_date: row.end_date, // 'YYYY-MM-DD'
    status: row.status || '예정',
    planned_cost: Number(row.planned_cost),
    actual_cost: Number(row.actual_cost || 0), // 서버 집계 (연결 비용 합)
    staff: row.staff || '',
    color: row.color || '',
    memo: row.memo || '',
    sort_order: Number(row.sort_order || 0),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function rowToEstimate(row) {
  return {
    id: row.id,
    site_id: row.site_id == null ? null : row.site_id,
    title: row.title,
    client_name: row.client_name || '',
    client_contact: row.client_contact || '',
    estimate_date: row.estimate_date, // 'YYYY-MM-DD' | null
    valid_until: row.valid_until, // 'YYYY-MM-DD' | null
    vat_mode: row.vat_mode,
    vat_rate: Number(row.vat_rate),
    discount: Number(row.discount),
    status: row.status,
    memo: row.memo || '',
    created_at: new Date(row.created_at).toISOString(),
    // (v3) 원가계산서 가정값 (numeric → Number, boolean 그대로)
    use_cost_buildup: parseBool(row.use_cost_buildup, false),
    indirect_material_rate: Number(row.indirect_material_rate),
    indirect_labor_rate: Number(row.indirect_labor_rate),
    safety_insurance_rate: Number(row.safety_insurance_rate),
    employment_insurance_rate: Number(row.employment_insurance_rate),
    safety_mgmt_rate: Number(row.safety_mgmt_rate),
    other_expense_rate: Number(row.other_expense_rate),
    admin_rate: Number(row.admin_rate),
    design_rate: Number(row.design_rate),
    profit_rate: Number(row.profit_rate),
    round_unit: Number(row.round_unit || 0),
  };
}

function rowToItem(row) {
  return {
    id: row.id,
    estimate_id: row.estimate_id,
    trade: row.trade || '', // (v3) 공종
    process: row.process || '',
    name: row.name,
    spec: row.spec || '',
    qty: Number(row.qty),
    unit: row.unit || '',
    // (v3) 재료/노무/부자재 3분할 단가
    material_price: Number(row.material_price || 0),
    labor_price: Number(row.labor_price || 0),
    sub_price: Number(row.sub_price || 0),
    unit_price: Number(row.unit_price),
    amount: Number(row.amount),
    catalog_id: row.catalog_id == null ? null : String(row.catalog_id), // (v3) 출처 카탈로그 id (다른 id 와 동일 타입=문자열)
    memo: row.memo || '',
    sort_order: Number(row.sort_order || 0),
  };
}

// (v3) 카탈로그 row → 클라이언트 모델 (가격 Number 변환)
function rowToCatalog(row) {
  return {
    id: row.id,
    trade: row.trade,
    grp: row.grp || '',
    name: row.name,
    unit: row.unit || '',
    material_price: Number(row.material_price),
    labor_price: Number(row.labor_price),
    sub_price: Number(row.sub_price),
    product_name: row.product_name || '',
    vendor: row.vendor || '',
    code: row.code || '',
    active: row.active,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// ----------------------------------------
// SELECT 컬럼 목록 (DATE 는 to_char 직렬화)
// ----------------------------------------
const SITE_COLS =
  "id, name, client, address, manager, budget, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, folder, status, tags, " +
  "building_type, floor_area, to_char(move_in_date,'YYYY-MM-DD') AS move_in_date, pm, construction_manager, designer, progress_status, created_at";
const COST_COLS =
  "id, site_id, to_char(date,'YYYY-MM-DD') AS date, amount, category, process, manager, vendor, memo, schedule_id, created_at";
const STAFF_COLS = 'id, name, role, phone, active, created_at';
const VENDOR_COLS = 'id, name, kind, phone, memo, active, created_at';
const CATEGORY_COLS = 'id, kind, name, sort_order, active';
const ESTIMATE_COLS =
  "id, site_id, title, client_name, client_contact, to_char(estimate_date,'YYYY-MM-DD') AS estimate_date, to_char(valid_until,'YYYY-MM-DD') AS valid_until, vat_mode, vat_rate, discount, status, memo, created_at, " +
  'use_cost_buildup, indirect_material_rate, indirect_labor_rate, safety_insurance_rate, employment_insurance_rate, ' +
  'safety_mgmt_rate, other_expense_rate, admin_rate, design_rate, profit_rate, round_unit';
const ITEM_COLS =
  'id, estimate_id, trade, process, name, spec, qty, unit, material_price, labor_price, sub_price, unit_price, amount, catalog_id, memo, sort_order';
// (v3) 카탈로그 컬럼 (가격은 rowToCatalog 에서 Number 변환)
const CATALOG_COLS =
  'id, trade, grp, name, unit, material_price, labor_price, sub_price, product_name, vendor, code, active, created_at';

// 일정 SELECT (alias s) — actual_cost = 연결 비용 합계 서브쿼리
const SCHEDULE_SELECT_COLS = `
  s.id, s.site_id, s.title, s.process,
  to_char(s.start_date,'YYYY-MM-DD') AS start_date,
  to_char(s.end_date,'YYYY-MM-DD')   AS end_date,
  s.status, s.planned_cost, s.staff, s.color, s.memo, s.sort_order, s.created_at,
  (SELECT COALESCE(SUM(c.amount),0)::bigint FROM interior_costs c WHERE c.schedule_id = s.id) AS actual_cost
`;
// 일정 INSERT/UPDATE RETURNING — 동일하지만 테이블명(interior_schedule)으로 상관 서브쿼리 참조
const SCHEDULE_RETURNING_COLS = `
  id, site_id, title, process,
  to_char(start_date,'YYYY-MM-DD') AS start_date,
  to_char(end_date,'YYYY-MM-DD')   AS end_date,
  status, planned_cost, staff, color, memo, sort_order, created_at,
  (SELECT COALESCE(SUM(c.amount),0)::bigint FROM interior_costs c WHERE c.schedule_id = interior_schedule.id) AS actual_cost
`;

// ----------------------------------------
// 견적 금액/세금 계산 (CONTRACT "견적 금액/세금 계산식" — 서버·프론트 동일)
// ----------------------------------------
function itemAmount(it) {
  // 저장된 amount 가 있으면 그대로, 없으면 round(qty*unit_price)
  if (it && it.amount !== undefined && it.amount !== null && Number.isFinite(Number(it.amount))) {
    return Math.round(Number(it.amount));
  }
  const qty = Number(it && it.qty);
  const up = Number(it && it.unit_price);
  return Math.round((Number.isFinite(qty) ? qty : 0) * (Number.isFinite(up) ? up : 0));
}

// 과세표준(base) → vat_mode 별 {supplyAmount, vat, total}. (v2/v3 공용)
function vatFromBase(base, opts) {
  const rateRaw = Number(opts && opts.vat_rate);
  const rate = Number.isFinite(rateRaw) ? rateRaw : 0.1;
  const mode = (opts && opts.vat_mode) || 'exclusive';

  if (mode === 'inclusive') {
    const total = base;
    const supplyAmount = Math.round(total / (1 + rate));
    return { supplyAmount, vat: total - supplyAmount, total };
  }
  if (mode === 'none') {
    return { supplyAmount: base, vat: 0, total: base };
  }
  // 'exclusive' (기본)
  const vat = Math.round(base * rate);
  return { supplyAmount: base, vat, total: base + vat };
}

// 단순 모드 totals: subtotal 에서 할인 → 과세표준 → VAT. (v2 동작 그대로, 출력 동일)
function totalsFromSubtotal(subtotal, opts) {
  const discount = Math.max(0, Number(opts && opts.discount) || 0);
  const discounted = Math.max(0, subtotal - discount);
  const { supplyAmount, vat, total } = vatFromBase(discounted, opts);
  return { subtotal, discount, supplyAmount, vat, total };
}

// (v3) 율 1개를 안전하게 읽기: 유효한 0 이상 숫자면 그 값, 아니면 기본값.
function buildupRate(estimate, key) {
  const v = Number(estimate && estimate[key]);
  return Number.isFinite(v) && v >= 0 ? v : BUILDUP_DEFAULTS[key];
}

// (v3) 직접재료/직접노무/부자재 합계 → 원가계산서 buildup 객체 (CONTRACT "원가계산서 산출식" 1:1)
function buildupFromSums(directMaterial, directLabor, subMaterial, estimate) {
  const indirectMaterial = Math.round(directMaterial * buildupRate(estimate, 'indirect_material_rate'));
  const indirectLabor = Math.round(directLabor * buildupRate(estimate, 'indirect_labor_rate'));
  const materialSum = directMaterial + indirectMaterial; // 재료비 소계
  const laborSum = directLabor + indirectLabor; // 노무비 소계
  const safetyIns = Math.round(laborSum * buildupRate(estimate, 'safety_insurance_rate'));
  const employIns = Math.round(laborSum * buildupRate(estimate, 'employment_insurance_rate'));
  const safetyMgmt = Math.round((materialSum + directLabor) * buildupRate(estimate, 'safety_mgmt_rate'));
  const otherExp = Math.round((materialSum + laborSum) * buildupRate(estimate, 'other_expense_rate'));
  const expenseSum = subMaterial + safetyIns + employIns + safetyMgmt + otherExp; // 경비 소계
  const primeCost = materialSum + laborSum + expenseSum; // 순공사원가
  const admin = Math.round(primeCost * buildupRate(estimate, 'admin_rate'));
  const design = Math.round(primeCost * buildupRate(estimate, 'design_rate'));
  const profit = Math.round(primeCost * buildupRate(estimate, 'profit_rate'));
  const constructionTotal = primeCost + admin + design + profit; // 공사비 합계
  const discount = Math.max(0, Number(estimate && estimate.discount) || 0);
  const afterDiscount = Math.max(0, constructionTotal - discount);
  const roundUnit = Math.max(0, Math.round(Number(estimate && estimate.round_unit) || 0));
  const proposed = roundUnit > 0 ? Math.floor(afterDiscount / roundUnit) * roundUnit : afterDiscount; // 제안가
  return {
    directMaterial,
    indirectMaterial,
    materialSum,
    directLabor,
    indirectLabor,
    laborSum,
    subMaterial,
    safetyIns,
    employIns,
    safetyMgmt,
    otherExp,
    expenseSum,
    primeCost,
    admin,
    design,
    profit,
    constructionTotal,
    proposed,
  };
}

// totals 계산기: parts({subtotal, directMaterial, directLabor, subMaterial}) + estimate → totals.
//   use_cost_buildup=true → buildup 포함, supply/vat/total 은 proposed 기준.
//   false → 기존 v2 그대로 + buildup:null.
function totalsFromParts(parts, estimate) {
  const subtotal = Math.round(Number(parts && parts.subtotal) || 0);
  if (estimate && parseBool(estimate.use_cost_buildup, false)) {
    const buildup = buildupFromSums(
      Math.round(Number(parts.directMaterial) || 0),
      Math.round(Number(parts.directLabor) || 0),
      Math.round(Number(parts.subMaterial) || 0),
      estimate
    );
    const discount = Math.max(0, Number(estimate.discount) || 0);
    const { supplyAmount, vat, total } = vatFromBase(buildup.proposed, estimate);
    return { subtotal, discount, supplyAmount, vat, total, buildup };
  }
  return { ...totalsFromSubtotal(subtotal, estimate), buildup: null };
}

// items 배열로부터 totals 계산 (상세/생성/확정 경로). 3분할 합계는 항목별 round 후 합산.
function computeTotals(estimate, items) {
  let subtotal = 0;
  let directMaterial = 0;
  let directLabor = 0;
  let subMaterial = 0;
  for (const it of items || []) {
    subtotal += itemAmount(it);
    const qty = Number(it && it.qty);
    const q = Number.isFinite(qty) ? qty : 0;
    directMaterial += Math.round(q * (Number(it && it.material_price) || 0));
    directLabor += Math.round(q * (Number(it && it.labor_price) || 0));
    subMaterial += Math.round(q * (Number(it && it.sub_price) || 0));
  }
  return totalsFromParts({ subtotal, directMaterial, directLabor, subMaterial }, estimate);
}

// ----------------------------------------
// ICS(캘린더) 헬퍼
// ----------------------------------------
function icsEscape(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}
function icsDate(s) {
  // 'YYYY-MM-DD' → 'YYYYMMDD'
  return String(s || '').replace(/-/g, '');
}
function icsDatePlusOne(s) {
  // 종료일+1 (all-day DTEND 는 exclusive)
  const [y, m, d] = String(s).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

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

  // (v4) 바닥면적: 0 이상 숫자(소수 허용). 미입력 → 0.
  let floor_area = 0;
  if (b.floor_area !== undefined && b.floor_area !== null && b.floor_area !== '') {
    floor_area = Number(b.floor_area);
    if (!Number.isFinite(floor_area) || floor_area < 0) {
      return { valid: false, message: 'floor_area(바닥면적) 은 0 이상의 숫자여야 합니다.' };
    }
  }

  // (v4) 입주 예정일: 선택. 있으면 유효한 달력 날짜.
  const move_in_date = typeof b.move_in_date === 'string' && b.move_in_date.trim() ? b.move_in_date.trim() : null;
  if (move_in_date && !isRealDate(move_in_date)) {
    return { valid: false, message: 'move_in_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }

  // (v4) 진행상태: PROGRESS_STATES 목록 외 값은 '준비'로 보정(400 대신). 미입력 → '준비'.
  let progress_status = '준비';
  if (typeof b.progress_status === 'string' && b.progress_status.trim()) {
    const p = b.progress_status.trim();
    progress_status = PROGRESS_STATES.includes(p) ? p : '준비';
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
      status: typeof b.status === 'string' && b.status.trim() ? b.status.trim() : '진행',
      tags: typeof b.tags === 'string' ? b.tags.trim() : '',
      // (v4) 노션 프로젝트 속성
      building_type: typeof b.building_type === 'string' ? b.building_type.trim() : '',
      floor_area,
      move_in_date,
      pm: typeof b.pm === 'string' ? b.pm.trim() : '',
      construction_manager: typeof b.construction_manager === 'string' ? b.construction_manager.trim() : '',
      designer: typeof b.designer === 'string' ? b.designer.trim() : '',
      progress_status,
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

  // schedule_id: null 허용. 값 있으면 양의 정수(같은 현장 일정인지는 라우트에서 검증).
  let schedule_id = null;
  if (b.schedule_id !== undefined && b.schedule_id !== null && b.schedule_id !== '') {
    if (!/^\d+$/.test(String(b.schedule_id))) {
      return { valid: false, message: 'schedule_id 는 양의 정수이거나 비어 있어야 합니다.' };
    }
    schedule_id = String(b.schedule_id);
  }

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
      schedule_id,
    },
  };
}

function validateStaff(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: 'name(담당자명) 은 필수입니다.' };
  return {
    valid: true,
    values: {
      name,
      role: typeof b.role === 'string' ? b.role.trim() : '',
      phone: typeof b.phone === 'string' ? b.phone.trim() : '',
      active: parseBool(b.active, true),
    },
  };
}

function validateVendor(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: 'name(거래처명) 은 필수입니다.' };
  return {
    valid: true,
    values: {
      name,
      kind: typeof b.kind === 'string' ? b.kind.trim() : '',
      phone: typeof b.phone === 'string' ? b.phone.trim() : '',
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
      active: parseBool(b.active, true),
    },
  };
}

function validateSchedule(body) {
  const b = body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) return { valid: false, message: 'title(작업명) 은 필수입니다.' };

  const start_date = typeof b.start_date === 'string' ? b.start_date.trim() : '';
  const end_date = typeof b.end_date === 'string' ? b.end_date.trim() : '';
  if (!isRealDate(start_date)) return { valid: false, message: 'start_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  if (!isRealDate(end_date)) return { valid: false, message: 'end_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  if (start_date > end_date) return { valid: false, message: 'start_date 는 end_date 보다 이후일 수 없습니다.' };

  let planned_cost = 0;
  if (b.planned_cost !== undefined && b.planned_cost !== null && b.planned_cost !== '') {
    planned_cost = Number(b.planned_cost);
    if (!Number.isFinite(planned_cost) || !Number.isInteger(planned_cost) || planned_cost < 0) {
      return { valid: false, message: 'planned_cost 는 0 이상의 정수(원)여야 합니다.' };
    }
  }

  let sort_order = 0;
  if (b.sort_order !== undefined && b.sort_order !== null && b.sort_order !== '') {
    sort_order = Number(b.sort_order);
    if (!Number.isFinite(sort_order) || !Number.isInteger(sort_order)) {
      return { valid: false, message: 'sort_order 는 정수여야 합니다.' };
    }
  }

  return {
    valid: true,
    values: {
      title,
      process: typeof b.process === 'string' ? b.process.trim() : '',
      start_date,
      end_date,
      status: typeof b.status === 'string' && b.status.trim() ? b.status.trim() : '예정',
      planned_cost,
      staff: typeof b.staff === 'string' ? b.staff.trim() : '',
      color: typeof b.color === 'string' ? b.color.trim() : '',
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
      sort_order,
    },
  };
}

const VAT_MODES = ['exclusive', 'inclusive', 'none'];

function validateEstimateHeader(body) {
  const b = body || {};
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : '견적서';

  const estimate_date = typeof b.estimate_date === 'string' && b.estimate_date.trim() ? b.estimate_date.trim() : null;
  const valid_until = typeof b.valid_until === 'string' && b.valid_until.trim() ? b.valid_until.trim() : null;
  if (estimate_date && !isRealDate(estimate_date)) {
    return { valid: false, message: 'estimate_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }
  if (valid_until && !isRealDate(valid_until)) {
    return { valid: false, message: 'valid_until 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }

  let vat_mode = 'exclusive';
  if (b.vat_mode !== undefined && b.vat_mode !== null && b.vat_mode !== '') {
    vat_mode = String(b.vat_mode).trim();
    if (!VAT_MODES.includes(vat_mode)) {
      return { valid: false, message: 'vat_mode 는 exclusive/inclusive/none 중 하나여야 합니다.' };
    }
  }

  let vat_rate = 0.1;
  if (b.vat_rate !== undefined && b.vat_rate !== null && b.vat_rate !== '') {
    vat_rate = Number(b.vat_rate);
    if (!Number.isFinite(vat_rate) || vat_rate < 0) {
      return { valid: false, message: 'vat_rate 는 0 이상의 숫자여야 합니다.' };
    }
  }

  let discount = 0;
  if (b.discount !== undefined && b.discount !== null && b.discount !== '') {
    discount = Number(b.discount);
    if (!Number.isFinite(discount) || !Number.isInteger(discount) || discount < 0) {
      return { valid: false, message: 'discount(할인액) 은 0 이상의 정수(원)여야 합니다.' };
    }
  }

  // (v3) 원가계산서 모드 + 9개 가정율 + 제안가 라운딩 단위 (미전달 시 DEFAULT)
  const use_cost_buildup = parseBool(b.use_cost_buildup, false);

  const rates = {};
  for (const key of BUILDUP_RATE_KEYS) {
    if (b[key] === undefined || b[key] === null || b[key] === '') {
      rates[key] = BUILDUP_DEFAULTS[key];
    } else {
      const n = Number(b[key]);
      if (!Number.isFinite(n) || n < 0) {
        return { valid: false, message: `${key} 는 0 이상의 숫자여야 합니다.` };
      }
      rates[key] = n;
    }
  }

  let round_unit = 0;
  if (b.round_unit !== undefined && b.round_unit !== null && b.round_unit !== '') {
    round_unit = Number(b.round_unit);
    if (!Number.isFinite(round_unit) || !Number.isInteger(round_unit) || round_unit < 0) {
      return { valid: false, message: 'round_unit 은 0 이상의 정수여야 합니다.' };
    }
  }

  return {
    valid: true,
    values: {
      title,
      client_name: typeof b.client_name === 'string' ? b.client_name.trim() : '',
      client_contact: typeof b.client_contact === 'string' ? b.client_contact.trim() : '',
      estimate_date,
      valid_until,
      vat_mode,
      vat_rate,
      discount,
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
      use_cost_buildup,
      ...rates,
      round_unit,
    },
  };
}

function validateEstimateItems(rawItems) {
  if (rawItems === undefined || rawItems === null) return { valid: true, values: [] };
  if (!Array.isArray(rawItems)) return { valid: false, message: 'items 는 배열이어야 합니다.' };

  const values = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i] || {};
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) return { valid: false, message: `items[${i}].name(품목) 은 필수입니다.` };

    let qty = 1;
    if (it.qty !== undefined && it.qty !== null && it.qty !== '') {
      qty = Number(it.qty);
      if (!Number.isFinite(qty) || qty < 0) {
        return { valid: false, message: `items[${i}].qty 는 0 이상의 숫자여야 합니다.` };
      }
    }

    let unit_price = 0;
    if (it.unit_price !== undefined && it.unit_price !== null && it.unit_price !== '') {
      unit_price = Number(it.unit_price);
      if (!Number.isFinite(unit_price) || !Number.isInteger(unit_price) || unit_price < 0) {
        return { valid: false, message: `items[${i}].unit_price 는 0 이상의 정수(원)여야 합니다.` };
      }
    }

    // (v3) 재료/노무/부자재 3분할 단가 (각 0 이상 정수, 미전달 0)
    const splitFields = [
      ['material_price', '재료비단가'],
      ['labor_price', '노무비단가'],
      ['sub_price', '부자재단가'],
    ];
    const split = { material_price: 0, labor_price: 0, sub_price: 0 };
    for (const [key, label] of splitFields) {
      if (it[key] !== undefined && it[key] !== null && it[key] !== '') {
        const n = Number(it[key]);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          return { valid: false, message: `items[${i}].${key}(${label}) 는 0 이상의 정수(원)여야 합니다.` };
        }
        split[key] = n;
      }
    }

    // (v3) 합산단가 규칙: 3분할 합이 0보다 크면 unit_price = 합(3분할 모드).
    //      셋 다 0이면 들어온 unit_price 를 그대로(기존 v2 단순 모드). amount 는 둘 다 서버 계산.
    const splitSum = split.material_price + split.labor_price + split.sub_price;
    const finalUnitPrice = splitSum > 0 ? splitSum : unit_price;

    // (v3) catalog_id: null 허용, 값 있으면 양의 정수(문자열로 보관)
    let catalog_id = null;
    if (it.catalog_id !== undefined && it.catalog_id !== null && it.catalog_id !== '') {
      if (!/^\d+$/.test(String(it.catalog_id))) {
        return { valid: false, message: `items[${i}].catalog_id 는 양의 정수이거나 비어 있어야 합니다.` };
      }
      catalog_id = String(it.catalog_id);
    }

    let sort_order = i;
    if (it.sort_order !== undefined && it.sort_order !== null && it.sort_order !== '') {
      sort_order = Number(it.sort_order);
      if (!Number.isFinite(sort_order) || !Number.isInteger(sort_order)) {
        return { valid: false, message: `items[${i}].sort_order 는 정수여야 합니다.` };
      }
    }

    values.push({
      trade: typeof it.trade === 'string' ? it.trade.trim() : '',
      process: typeof it.process === 'string' ? it.process.trim() : '',
      name,
      spec: typeof it.spec === 'string' ? it.spec.trim() : '',
      qty,
      unit: typeof it.unit === 'string' ? it.unit.trim() : '',
      material_price: split.material_price,
      labor_price: split.labor_price,
      sub_price: split.sub_price,
      unit_price: finalUnitPrice, // 서버 계산(3분할 합 또는 단순 단가)
      amount: Math.round(qty * finalUnitPrice), // 서버 계산 저장
      catalog_id,
      memo: typeof it.memo === 'string' ? it.memo.trim() : '',
      sort_order,
    });
  }
  return { valid: true, values };
}

// (v3) 카탈로그 입력 검증 (trade·name 필수, 가격은 0 이상 정수)
function validateCatalog(body) {
  const b = body || {};
  const trade = typeof b.trade === 'string' ? b.trade.trim() : '';
  if (!trade) return { valid: false, message: 'trade(공종) 은 필수입니다.' };
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: 'name(품목) 은 필수입니다.' };

  const priceFields = [
    ['material_price', '재료비단가'],
    ['labor_price', '노무비단가'],
    ['sub_price', '부자재단가'],
  ];
  const prices = { material_price: 0, labor_price: 0, sub_price: 0 };
  for (const [key, label] of priceFields) {
    if (b[key] !== undefined && b[key] !== null && b[key] !== '') {
      const n = Number(b[key]);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return { valid: false, message: `${key}(${label}) 는 0 이상의 정수(원)여야 합니다.` };
      }
      prices[key] = n;
    }
  }

  return {
    valid: true,
    values: {
      trade,
      grp: typeof b.grp === 'string' ? b.grp.trim() : '',
      name,
      unit: typeof b.unit === 'string' ? b.unit.trim() : '',
      material_price: prices.material_price,
      labor_price: prices.labor_price,
      sub_price: prices.sub_price,
      product_name: typeof b.product_name === 'string' ? b.product_name.trim() : '',
      vendor: typeof b.vendor === 'string' ? b.vendor.trim() : '',
      code: typeof b.code === 'string' ? b.code.trim() : '',
      active: parseBool(b.active, true),
    },
  };
}

// ========================================
// REST API — 현장(interior_sites)
// 응답은 raw. DELETE 만 { success:true }. 상태: 200/201/400/404/409/500.
// ========================================

// GET /api/sites — 현장(프로젝트) 배열 (created_at 최신순)
//   (v4) 신규 7컬럼 + 경량 롤업 2개: spent(Σ 비용, 정수) + estimateTotal(확정 견적 total, 없으면 null).
//   ⚠️ 단일 쿼리(LATERAL/서브쿼리)로 N+1 금지. 확정 견적의 헤더 율 + 항목합계를 한 번에 가져와
//      JS totalsFromParts 로 계산 → 견적 상세/요약 endpoint 와 값이 원 단위까지 정확히 일치.
//   site 컬럼은 LATERAL 별칭(est)과의 모호성 방지를 위해 interior_sites. 로 완전수식(= SITE_COLS 미러).
app.get('/api/sites', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        interior_sites.id, interior_sites.name, interior_sites.client, interior_sites.address,
        interior_sites.manager, interior_sites.budget,
        to_char(interior_sites.start_date,'YYYY-MM-DD') AS start_date,
        to_char(interior_sites.end_date,'YYYY-MM-DD')   AS end_date,
        interior_sites.folder, interior_sites.status, interior_sites.tags,
        interior_sites.building_type, interior_sites.floor_area,
        to_char(interior_sites.move_in_date,'YYYY-MM-DD') AS move_in_date,
        interior_sites.pm, interior_sites.construction_manager, interior_sites.designer,
        interior_sites.progress_status, interior_sites.created_at,
        (SELECT COALESCE(SUM(c.amount),0)::bigint FROM interior_costs c WHERE c.site_id = interior_sites.id) AS spent,
        est.id                        AS conf_id,
        est.vat_mode                  AS conf_vat_mode,
        est.vat_rate                  AS conf_vat_rate,
        est.discount                  AS conf_discount,
        est.use_cost_buildup          AS conf_use_cost_buildup,
        est.indirect_material_rate    AS conf_indirect_material_rate,
        est.indirect_labor_rate       AS conf_indirect_labor_rate,
        est.safety_insurance_rate     AS conf_safety_insurance_rate,
        est.employment_insurance_rate AS conf_employment_insurance_rate,
        est.safety_mgmt_rate          AS conf_safety_mgmt_rate,
        est.other_expense_rate        AS conf_other_expense_rate,
        est.admin_rate                AS conf_admin_rate,
        est.design_rate               AS conf_design_rate,
        est.profit_rate               AS conf_profit_rate,
        est.round_unit                AS conf_round_unit,
        COALESCE(agg.subtotal,0)::bigint        AS conf_subtotal,
        COALESCE(agg.direct_material,0)::bigint AS conf_direct_material,
        COALESCE(agg.direct_labor,0)::bigint    AS conf_direct_labor,
        COALESCE(agg.sub_material,0)::bigint     AS conf_sub_material
      FROM interior_sites
      LEFT JOIN LATERAL (
        SELECT e.* FROM interior_estimates e
        WHERE e.site_id = interior_sites.id AND e.status = 'confirmed'
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 1
      ) est ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(i.amount),0)::bigint                        AS subtotal,
          COALESCE(SUM(round(i.qty * i.material_price)),0)::bigint AS direct_material,
          COALESCE(SUM(round(i.qty * i.labor_price)),0)::bigint    AS direct_labor,
          COALESCE(SUM(round(i.qty * i.sub_price)),0)::bigint      AS sub_material
        FROM interior_estimate_items i WHERE i.estimate_id = est.id
      ) agg ON TRUE
      ORDER BY interior_sites.created_at DESC
    `);

    const out = rows.map((r) => {
      const spent = Number(r.spent || 0);
      let estimateTotal = null;
      if (r.conf_id != null) {
        // totalsFromParts 가 읽는 필드만 채운 최소 estimate 객체 (rowToEstimate 는 created_at 등 미선택 필드에서 throw 가능)
        const est = {
          vat_mode: r.conf_vat_mode,
          vat_rate: Number(r.conf_vat_rate),
          discount: Number(r.conf_discount),
          use_cost_buildup: r.conf_use_cost_buildup,
          indirect_material_rate: Number(r.conf_indirect_material_rate),
          indirect_labor_rate: Number(r.conf_indirect_labor_rate),
          safety_insurance_rate: Number(r.conf_safety_insurance_rate),
          employment_insurance_rate: Number(r.conf_employment_insurance_rate),
          safety_mgmt_rate: Number(r.conf_safety_mgmt_rate),
          other_expense_rate: Number(r.conf_other_expense_rate),
          admin_rate: Number(r.conf_admin_rate),
          design_rate: Number(r.conf_design_rate),
          profit_rate: Number(r.conf_profit_rate),
          round_unit: Number(r.conf_round_unit),
        };
        const parts = {
          subtotal: Number(r.conf_subtotal),
          directMaterial: Number(r.conf_direct_material),
          directLabor: Number(r.conf_direct_labor),
          subMaterial: Number(r.conf_sub_material),
        };
        estimateTotal = totalsFromParts(parts, est).total;
      }
      return { ...rowToSite(r), spent, estimateTotal };
    });
    res.json(out);
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
      `INSERT INTO interior_sites
         (name, client, address, manager, budget, start_date, end_date, folder, status, tags,
          building_type, floor_area, move_in_date, pm, construction_manager, designer, progress_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING ${SITE_COLS}`,
      [
        v.name, v.client, v.address, v.manager, v.budget, v.start_date, v.end_date, folder, v.status, v.tags,
        v.building_type, v.floor_area, v.move_in_date, v.pm, v.construction_manager, v.designer, v.progress_status,
      ]
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
       SET name=$1, client=$2, address=$3, manager=$4, budget=$5, start_date=$6, end_date=$7, status=$8, tags=$9,
           building_type=$10, floor_area=$11, move_in_date=$12, pm=$13, construction_manager=$14, designer=$15, progress_status=$16
       WHERE id=$17
       RETURNING ${SITE_COLS}`,
      [
        v.name, v.client, v.address, v.manager, v.budget, v.start_date, v.end_date, v.status, v.tags,
        v.building_type, v.floor_area, v.move_in_date, v.pm, v.construction_manager, v.designer, v.progress_status, id,
      ]
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

// DELETE /api/sites/:id — 현장 삭제 (costs/schedule/estimates CASCADE). 폴더/파일은 보존.
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

    // schedule_id 가 있으면 같은 현장의 일정인지 검증
    if (v.schedule_id !== null) {
      const sch = await pool.query('SELECT id FROM interior_schedule WHERE id=$1 AND site_id=$2', [v.schedule_id, id]);
      if (sch.rows.length === 0) return res.status(400).json({ success: false, message: '잘못된 일정 연결입니다.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO interior_costs (site_id, date, amount, category, process, manager, vendor, memo, schedule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${COST_COLS}`,
      [id, v.date, v.amount, v.category, v.process, v.manager, v.vendor, v.memo, v.schedule_id]
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

    // schedule_id 가 있으면 해당 비용이 속한 현장의 일정인지 검증
    if (v.schedule_id !== null) {
      const cur = await pool.query('SELECT site_id FROM interior_costs WHERE id=$1', [id]);
      if (cur.rows.length === 0) return res.status(404).json({ success: false, message: '해당 비용 내역을 찾을 수 없습니다.' });
      const sch = await pool.query('SELECT id FROM interior_schedule WHERE id=$1 AND site_id=$2', [
        v.schedule_id,
        cur.rows[0].site_id,
      ]);
      if (sch.rows.length === 0) return res.status(400).json({ success: false, message: '잘못된 일정 연결입니다.' });
    }

    const { rows } = await pool.query(
      `UPDATE interior_costs
       SET date=$1, amount=$2, category=$3, process=$4, manager=$5, vendor=$6, memo=$7, schedule_id=$8
       WHERE id=$9
       RETURNING ${COST_COLS}`,
      [v.date, v.amount, v.category, v.process, v.manager, v.vendor, v.memo, v.schedule_id, id]
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
// REST API — 담당자(interior_staff)
// ========================================
app.get('/api/staff', async (req, res) => {
  try {
    const where = wantAll(req) ? '' : 'WHERE active = TRUE';
    const { rows } = await pool.query(`SELECT ${STAFF_COLS} FROM interior_staff ${where} ORDER BY active DESC, name ASC`);
    res.json(rows.map(rowToStaff));
  } catch (err) {
    console.error('GET /api/staff 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/staff', async (req, res) => {
  try {
    const check = validateStaff(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `INSERT INTO interior_staff (name, role, phone, active) VALUES ($1,$2,$3,$4) RETURNING ${STAFF_COLS}`,
      [v.name, v.role, v.phone, v.active]
    );
    res.status(201).json(rowToStaff(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 담당자명입니다.' });
    console.error('POST /api/staff 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자를 생성하지 못했습니다.' });
  }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 담당자 id 형식입니다.' });
    const check = validateStaff(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_staff SET name=$1, role=$2, phone=$3, active=$4 WHERE id=$5 RETURNING ${STAFF_COLS}`,
      [v.name, v.role, v.phone, v.active, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 담당자를 찾을 수 없습니다.' });
    res.json(rowToStaff(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 담당자명입니다.' });
    console.error('PUT /api/staff/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자를 수정하지 못했습니다.' });
  }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 담당자 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_staff WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 담당자를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/staff/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자를 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 거래처(interior_vendors)
// ========================================
app.get('/api/vendors', async (req, res) => {
  try {
    const where = wantAll(req) ? '' : 'WHERE active = TRUE';
    const { rows } = await pool.query(`SELECT ${VENDOR_COLS} FROM interior_vendors ${where} ORDER BY active DESC, name ASC`);
    res.json(rows.map(rowToVendor));
  } catch (err) {
    console.error('GET /api/vendors 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/vendors', async (req, res) => {
  try {
    const check = validateVendor(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `INSERT INTO interior_vendors (name, kind, phone, memo, active) VALUES ($1,$2,$3,$4,$5) RETURNING ${VENDOR_COLS}`,
      [v.name, v.kind, v.phone, v.memo, v.active]
    );
    res.status(201).json(rowToVendor(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 거래처명입니다.' });
    console.error('POST /api/vendors 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처를 생성하지 못했습니다.' });
  }
});

app.put('/api/vendors/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 거래처 id 형식입니다.' });
    const check = validateVendor(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_vendors SET name=$1, kind=$2, phone=$3, memo=$4, active=$5 WHERE id=$6 RETURNING ${VENDOR_COLS}`,
      [v.name, v.kind, v.phone, v.memo, v.active, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 거래처를 찾을 수 없습니다.' });
    res.json(rowToVendor(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 거래처명입니다.' });
    console.error('PUT /api/vendors/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처를 수정하지 못했습니다.' });
  }
});

app.delete('/api/vendors/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 거래처 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_vendors WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 거래처를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/vendors/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처를 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 카테고리(interior_categories)
// GET 은 항상 { cost:[...], process:[...] } 객체 (sort_order ASC).
// ========================================
app.get('/api/categories', async (req, res) => {
  try {
    const where = wantAll(req) ? '' : 'WHERE active = TRUE';
    const { rows } = await pool.query(
      `SELECT ${CATEGORY_COLS} FROM interior_categories ${where} ORDER BY kind ASC, sort_order ASC, name ASC`
    );
    const out = { cost: [], process: [] };
    for (const r of rows) {
      const item = rowToCategory(r);
      if (r.kind === 'cost') out.cost.push(item);
      else if (r.kind === 'process') out.process.push(item);
    }
    res.json(out);
  } catch (err) {
    console.error('GET /api/categories 오류:', err.message);
    res.status(500).json({ success: false, message: '카테고리를 불러오지 못했습니다.' });
  }
});

app.post('/api/categories', async (req, res) => {
  try {
    const b = req.body || {};
    const kind = typeof b.kind === 'string' ? b.kind.trim() : '';
    if (kind !== 'cost' && kind !== 'process') {
      return res.status(400).json({ success: false, message: "kind 는 'cost' 또는 'process' 여야 합니다." });
    }
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return res.status(400).json({ success: false, message: 'name(카테고리명) 은 필수입니다.' });

    let sort_order = 0;
    if (b.sort_order !== undefined && b.sort_order !== null && b.sort_order !== '') {
      sort_order = Number(b.sort_order);
      if (!Number.isFinite(sort_order) || !Number.isInteger(sort_order)) {
        return res.status(400).json({ success: false, message: 'sort_order 는 정수여야 합니다.' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO interior_categories (kind, name, sort_order) VALUES ($1,$2,$3) RETURNING ${CATEGORY_COLS}`,
      [kind, name, sort_order]
    );
    res.status(201).json(rowToCategory(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 카테고리입니다.' });
    console.error('POST /api/categories 오류:', err.message);
    res.status(500).json({ success: false, message: '카테고리를 생성하지 못했습니다.' });
  }
});

app.put('/api/categories/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 카테고리 id 형식입니다.' });
    const b = req.body || {};

    // 부분 수정 → 기존 값 읽어 병합
    const existing = await pool.query(`SELECT ${CATEGORY_COLS} FROM interior_categories WHERE id=$1`, [id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: '해당 카테고리를 찾을 수 없습니다.' });
    const cur = existing.rows[0];

    let name = cur.name;
    if (b.name !== undefined) {
      name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name) return res.status(400).json({ success: false, message: 'name(카테고리명) 은 비울 수 없습니다.' });
    }

    let sort_order = Number(cur.sort_order || 0);
    if (b.sort_order !== undefined && b.sort_order !== null && b.sort_order !== '') {
      sort_order = Number(b.sort_order);
      if (!Number.isFinite(sort_order) || !Number.isInteger(sort_order)) {
        return res.status(400).json({ success: false, message: 'sort_order 는 정수여야 합니다.' });
      }
    }

    let active = cur.active;
    if (b.active !== undefined) active = parseBool(b.active, cur.active);

    const { rows } = await pool.query(
      `UPDATE interior_categories SET name=$1, sort_order=$2, active=$3 WHERE id=$4 RETURNING ${CATEGORY_COLS}`,
      [name, sort_order, active, id]
    );
    res.json(rowToCategory(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 카테고리입니다.' });
    console.error('PUT /api/categories/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '카테고리를 수정하지 못했습니다.' });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 카테고리 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_categories WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 카테고리를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/categories/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '카테고리를 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 일정(interior_schedule)
// 각 항목 actual_cost = 그 schedule_id 로 묶인 interior_costs.amount 합계(서버 계산).
// ========================================
app.get('/api/sites/:id/schedule', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${SCHEDULE_SELECT_COLS}
       FROM interior_schedule s
       WHERE s.site_id=$1
       ORDER BY s.start_date ASC, s.sort_order ASC, s.id ASC`,
      [id]
    );
    res.json(rows.map(rowToSchedule));
  } catch (err) {
    console.error('GET /api/sites/:id/schedule 오류:', err.message);
    res.status(500).json({ success: false, message: '일정을 불러오지 못했습니다.' });
  }
});

app.post('/api/sites/:id/schedule', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const check = validateSchedule(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    const { rows } = await pool.query(
      `INSERT INTO interior_schedule (site_id, title, process, start_date, end_date, status, planned_cost, staff, color, memo, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${SCHEDULE_RETURNING_COLS}`,
      [id, v.title, v.process, v.start_date, v.end_date, v.status, v.planned_cost, v.staff, v.color, v.memo, v.sort_order]
    );
    res.status(201).json(rowToSchedule(rows[0]));
  } catch (err) {
    console.error('POST /api/sites/:id/schedule 오류:', err.message);
    res.status(500).json({ success: false, message: '일정을 저장하지 못했습니다.' });
  }
});

app.put('/api/schedule/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 일정 id 형식입니다.' });

    const check = validateSchedule(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    const { rows } = await pool.query(
      `UPDATE interior_schedule
       SET title=$1, process=$2, start_date=$3, end_date=$4, status=$5, planned_cost=$6, staff=$7, color=$8, memo=$9, sort_order=$10
       WHERE id=$11
       RETURNING ${SCHEDULE_RETURNING_COLS}`,
      [v.title, v.process, v.start_date, v.end_date, v.status, v.planned_cost, v.staff, v.color, v.memo, v.sort_order, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 일정을 찾을 수 없습니다.' });
    res.json(rowToSchedule(rows[0]));
  } catch (err) {
    console.error('PUT /api/schedule/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '일정을 수정하지 못했습니다.' });
  }
});

app.delete('/api/schedule/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 일정 id 형식입니다.' });

    // 연결된 비용의 schedule_id 를 SET NULL (FK 가 없을 수도 있어 수동 처리 — 비용 자체는 보존)
    await pool.query('UPDATE interior_costs SET schedule_id=NULL WHERE schedule_id=$1', [id]);

    const { rowCount } = await pool.query('DELETE FROM interior_schedule WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 일정을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/schedule/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '일정을 삭제하지 못했습니다.' });
  }
});

// GET /api/sites/:id/schedule.ics — 현장 일정 전체를 iCalendar(text/calendar)로 다운로드
app.get('/api/sites/:id/schedule.ics', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const siteQ = await pool.query('SELECT name FROM interior_sites WHERE id=$1', [id]);
    if (siteQ.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    const siteName = siteQ.rows[0].name;

    const { rows } = await pool.query(
      `SELECT ${SCHEDULE_SELECT_COLS}
       FROM interior_schedule s
       WHERE s.site_id=$1
       ORDER BY s.start_date ASC, s.sort_order ASC, s.id ASC`,
      [id]
    );
    const tasks = rows.map(rowToSchedule);

    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//interior-cost//schedule//KO',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsEscape(siteName + ' 일정')}`,
    ];
    for (const t of tasks) {
      const summary = `[${t.process || '미분류'}] ${t.title}`;
      const description = [
        `담당자: ${t.staff || '-'}`,
        `상태: ${t.status || '-'}`,
        `계획비용: ${Number(t.planned_cost || 0).toLocaleString('ko-KR')}원`,
        `메모: ${t.memo || '-'}`,
      ].join('\n');

      lines.push('BEGIN:VEVENT');
      lines.push(`UID:schedule-${t.id}@interior-cost`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${icsDate(t.start_date)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDatePlusOne(t.end_date)}`);
      lines.push(`SUMMARY:${icsEscape(summary)}`);
      lines.push(`DESCRIPTION:${icsEscape(description)}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    const ics = lines.join('\r\n') + '\r\n';
    const downloadName = `${sanitizeSiteName(siteName)}-schedule.ics`;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="schedule.ics"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    res.send(ics);
  } catch (err) {
    console.error('GET /api/sites/:id/schedule.ics 오류:', err.message);
    res.status(500).json({ success: false, message: 'ICS 내보내기에 실패했습니다.' });
  }
});

// ========================================
// REST API — 견적(interior_estimates / interior_estimate_items)
// 금액/세금은 서버가 computeTotals 로 계산해 totals 로 내려준다.
// ========================================

// GET /api/sites/:id/estimates — 헤더 목록 + totals + itemCount (items 본문 제외)
app.get('/api/sites/:id/estimates', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const { rows } = await pool.query(
      `SELECT ${ESTIMATE_COLS} FROM interior_estimates WHERE site_id=$1 ORDER BY created_at DESC, id DESC`,
      [id]
    );
    if (rows.length === 0) return res.json([]);

    const ids = rows.map((r) => r.id);
    // subtotal + (v3) 3분할 합계(원가계산서용)을 한 번에 집계 — N+1 없이 buildup 계산.
    //   항목별 round 후 합산이라 상세 경로(JS Math.round per item)와 결과 일치.
    const aggQ = await pool.query(
      `SELECT estimate_id,
              COALESCE(SUM(amount),0)::bigint AS subtotal,
              COUNT(*) AS item_count,
              COALESCE(SUM(round(qty * material_price)),0)::bigint AS direct_material,
              COALESCE(SUM(round(qty * labor_price)),0)::bigint   AS direct_labor,
              COALESCE(SUM(round(qty * sub_price)),0)::bigint      AS sub_material
       FROM interior_estimate_items WHERE estimate_id = ANY($1::bigint[]) GROUP BY estimate_id`,
      [ids]
    );
    const aggMap = new Map();
    for (const a of aggQ.rows) {
      aggMap.set(String(a.estimate_id), {
        subtotal: Number(a.subtotal),
        itemCount: Number(a.item_count),
        directMaterial: Number(a.direct_material),
        directLabor: Number(a.direct_labor),
        subMaterial: Number(a.sub_material),
      });
    }

    const out = rows.map((r) => {
      const est = rowToEstimate(r);
      const agg = aggMap.get(String(r.id)) || { subtotal: 0, itemCount: 0, directMaterial: 0, directLabor: 0, subMaterial: 0 };
      const totals = totalsFromParts(agg, est);
      return { ...est, totals, itemCount: agg.itemCount };
    });
    res.json(out);
  } catch (err) {
    console.error('GET /api/sites/:id/estimates 오류:', err.message);
    res.status(500).json({ success: false, message: '견적 목록을 불러오지 못했습니다.' });
  }
});

// GET /api/estimates/:id — 헤더 + items + totals (상세)
app.get('/api/estimates/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });

    const headerQ = await pool.query(`SELECT ${ESTIMATE_COLS} FROM interior_estimates WHERE id=$1`, [id]);
    if (headerQ.rows.length === 0) return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });
    const est = rowToEstimate(headerQ.rows[0]);

    const itemsQ = await pool.query(
      `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    const items = itemsQ.rows.map(rowToItem);
    const totals = computeTotals(est, items);
    res.json({ ...est, items, totals });
  } catch (err) {
    console.error('GET /api/estimates/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '견적서를 불러오지 못했습니다.' });
  }
});

// POST /api/sites/:id/estimates — 헤더 + items 트랜잭션 생성 (201)
app.post('/api/sites/:id/estimates', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

  const headerCheck = validateEstimateHeader(req.body);
  if (!headerCheck.valid) return res.status(400).json({ success: false, message: headerCheck.message });
  const itemsCheck = validateEstimateItems((req.body || {}).items);
  if (!itemsCheck.valid) return res.status(400).json({ success: false, message: itemsCheck.message });
  const h = headerCheck.values;
  const items = itemsCheck.values;

  // 현장 존재 확인 (트랜잭션 밖, 일반 pool)
  try {
    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
  } catch (err) {
    console.error('POST /api/sites/:id/estimates (현장확인) 오류:', err.message);
    return res.status(500).json({ success: false, message: '견적서를 생성하지 못했습니다.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headerInsert = await client.query(
      `INSERT INTO interior_estimates
         (site_id, title, client_name, client_contact, estimate_date, valid_until, vat_mode, vat_rate, discount, memo,
          use_cost_buildup, indirect_material_rate, indirect_labor_rate, safety_insurance_rate, employment_insurance_rate,
          safety_mgmt_rate, other_expense_rate, admin_rate, design_rate, profit_rate, round_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING ${ESTIMATE_COLS}`,
      [
        id, h.title, h.client_name, h.client_contact, h.estimate_date, h.valid_until, h.vat_mode, h.vat_rate, h.discount, h.memo,
        h.use_cost_buildup, h.indirect_material_rate, h.indirect_labor_rate, h.safety_insurance_rate, h.employment_insurance_rate,
        h.safety_mgmt_rate, h.other_expense_rate, h.admin_rate, h.design_rate, h.profit_rate, h.round_unit,
      ]
    );
    const est = rowToEstimate(headerInsert.rows[0]);

    const insertedItems = [];
    for (const it of items) {
      const r = await client.query(
        `INSERT INTO interior_estimate_items
           (estimate_id, trade, process, name, spec, qty, unit, material_price, labor_price, sub_price, unit_price, amount, catalog_id, memo, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING ${ITEM_COLS}`,
        [est.id, it.trade, it.process, it.name, it.spec, it.qty, it.unit, it.material_price, it.labor_price, it.sub_price, it.unit_price, it.amount, it.catalog_id, it.memo, it.sort_order]
      );
      insertedItems.push(rowToItem(r.rows[0]));
    }
    await client.query('COMMIT');

    const totals = computeTotals(est, insertedItems);
    res.status(201).json({ ...est, items: insertedItems, totals });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* noop */
    }
    console.error('POST /api/sites/:id/estimates 오류:', err.message);
    res.status(500).json({ success: false, message: '견적서를 생성하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// PUT /api/estimates/:id — 헤더 수정 + items 전체 교체 (트랜잭션). status 는 보존(재확정 필요).
app.put('/api/estimates/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });

  const headerCheck = validateEstimateHeader(req.body);
  if (!headerCheck.valid) return res.status(400).json({ success: false, message: headerCheck.message });
  const itemsCheck = validateEstimateItems((req.body || {}).items);
  if (!itemsCheck.valid) return res.status(400).json({ success: false, message: itemsCheck.message });
  const h = headerCheck.values;
  const items = itemsCheck.values;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE interior_estimates
       SET title=$1, client_name=$2, client_contact=$3, estimate_date=$4, valid_until=$5, vat_mode=$6, vat_rate=$7, discount=$8, memo=$9,
           use_cost_buildup=$10, indirect_material_rate=$11, indirect_labor_rate=$12, safety_insurance_rate=$13, employment_insurance_rate=$14,
           safety_mgmt_rate=$15, other_expense_rate=$16, admin_rate=$17, design_rate=$18, profit_rate=$19, round_unit=$20
       WHERE id=$21
       RETURNING ${ESTIMATE_COLS}`,
      [
        h.title, h.client_name, h.client_contact, h.estimate_date, h.valid_until, h.vat_mode, h.vat_rate, h.discount, h.memo,
        h.use_cost_buildup, h.indirect_material_rate, h.indirect_labor_rate, h.safety_insurance_rate, h.employment_insurance_rate,
        h.safety_mgmt_rate, h.other_expense_rate, h.admin_rate, h.design_rate, h.profit_rate, h.round_unit, id,
      ]
    );
    if (upd.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });
    }
    const est = rowToEstimate(upd.rows[0]);

    // items 전체 교체
    await client.query('DELETE FROM interior_estimate_items WHERE estimate_id=$1', [id]);
    const insertedItems = [];
    for (const it of items) {
      const r = await client.query(
        `INSERT INTO interior_estimate_items
           (estimate_id, trade, process, name, spec, qty, unit, material_price, labor_price, sub_price, unit_price, amount, catalog_id, memo, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING ${ITEM_COLS}`,
        [id, it.trade, it.process, it.name, it.spec, it.qty, it.unit, it.material_price, it.labor_price, it.sub_price, it.unit_price, it.amount, it.catalog_id, it.memo, it.sort_order]
      );
      insertedItems.push(rowToItem(r.rows[0]));
    }
    await client.query('COMMIT');

    const totals = computeTotals(est, insertedItems);
    res.json({ ...est, items: insertedItems, totals });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* noop */
    }
    console.error('PUT /api/estimates/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '견적서를 수정하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// DELETE /api/estimates/:id — items CASCADE
app.delete('/api/estimates/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_estimates WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/estimates/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '견적서를 삭제하지 못했습니다.' });
  }
});

// POST /api/estimates/:id/confirm — 확정. site_id 있으면 현장 budget = totals.total 로 갱신.
app.post('/api/estimates/:id/confirm', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });

    const headerQ = await pool.query(`SELECT ${ESTIMATE_COLS} FROM interior_estimates WHERE id=$1`, [id]);
    if (headerQ.rows.length === 0) return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });

    const itemsQ = await pool.query(
      `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    const items = itemsQ.rows.map(rowToItem);
    const totals = computeTotals(rowToEstimate(headerQ.rows[0]), items);

    // status='confirmed'
    const updEst = await pool.query(
      `UPDATE interior_estimates SET status='confirmed' WHERE id=$1 RETURNING ${ESTIMATE_COLS}`,
      [id]
    );
    const est = rowToEstimate(updEst.rows[0]);

    // 현장 예산 연동
    let site = null;
    if (est.site_id != null) {
      const updSite = await pool.query(`UPDATE interior_sites SET budget=$1 WHERE id=$2 RETURNING ${SITE_COLS}`, [
        totals.total,
        est.site_id,
      ]);
      if (updSite.rows.length > 0) site = rowToSite(updSite.rows[0]);
    }

    res.json({ estimate: { ...est, items, totals }, site });
  } catch (err) {
    console.error('POST /api/estimates/:id/confirm 오류:', err.message);
    res.status(500).json({ success: false, message: '견적서를 확정하지 못했습니다.' });
  }
});

// POST /api/estimates/:id/unconfirm — 확정 해제(draft). budget 은 보존.
app.post('/api/estimates/:id/unconfirm', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });

    const upd = await pool.query(
      `UPDATE interior_estimates SET status='draft' WHERE id=$1 RETURNING ${ESTIMATE_COLS}`,
      [id]
    );
    if (upd.rows.length === 0) return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });
    const est = rowToEstimate(upd.rows[0]);

    const itemsQ = await pool.query(
      `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
      [id]
    );
    const items = itemsQ.rows.map(rowToItem);
    const totals = computeTotals(est, items);
    res.json({ estimate: { ...est, items, totals } });
  } catch (err) {
    console.error('POST /api/estimates/:id/unconfirm 오류:', err.message);
    res.status(500).json({ success: false, message: '견적 확정을 해제하지 못했습니다.' });
  }
});

// ========================================
// 요약/계산 — GET /api/sites/:id/summary
//   견적비 대비 집행/잔여/집행률, 카테고리별·공정별 합계, 날짜(공기) 계산.
//   (v2) estimateTotal / byProcessPlan(확정 견적) / scheduleAgg 추가.
// ========================================
app.get('/api/sites/:id/summary', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    // 현장 + 날짜 계산을 한 번에 (CURRENT_DATE 서버 기준).
    //   (v4) SITE_COLS 전체를 가져와 프로젝트 헤더용 site 객체(신규 7컬럼 포함)를 자동 구성.
    const siteQ = await pool.query(
      `SELECT ${SITE_COLS},
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

    // schedule(공기) 계산 (날짜 일부 없으면 null 처리)
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

    // (v2) 확정(confirmed) 견적: estimateTotal + byProcessPlan (가장 최근 것)
    let estimateTotal = null;
    let byProcessPlan = [];
    const confQ = await pool.query(
      `SELECT ${ESTIMATE_COLS} FROM interior_estimates
       WHERE site_id=$1 AND status='confirmed' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [id]
    );
    if (confQ.rows.length > 0) {
      const est = rowToEstimate(confQ.rows[0]);
      const planItemsQ = await pool.query(
        `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
        [est.id]
      );
      const planItems = planItemsQ.rows.map(rowToItem);
      estimateTotal = computeTotals(est, planItems).total;

      const planMap = new Map();
      for (const it of planItems) {
        const key = it.process && it.process.trim() ? it.process : '미분류';
        planMap.set(key, (planMap.get(key) || 0) + Number(it.amount));
      }
      byProcessPlan = Array.from(planMap.entries())
        .map(([process, total]) => ({ process, total }))
        .sort((a, b) => b.total - a.total);
    }

    // (v2) 일정 집계
    const schedAggQ = await pool.query(
      `SELECT
         COUNT(*) AS task_count,
         COALESCE(SUM(planned_cost),0) AS planned_total,
         COUNT(*) FILTER (WHERE status='완료') AS done_count
       FROM interior_schedule WHERE site_id=$1`,
      [id]
    );
    const sa = schedAggQ.rows[0];
    const scheduleAgg = {
      taskCount: Number(sa.task_count),
      plannedTotal: Number(sa.planned_total),
      doneCount: Number(sa.done_count),
    };

    res.json({
      // (v4) 프로젝트 헤더 카드용 현장 전체 정보(신규 7컬럼 포함). 기존 키는 그대로 보존(추가만).
      site: rowToSite(s),
      budget,
      spent,
      remaining: budget - spent,
      rate: budget > 0 ? Math.round((spent / budget) * 100) / 100 : null,
      byCategory: byCatQ.rows.map((r) => ({ category: r.category, total: Number(r.total) })),
      byProcess: byProcQ.rows.map((r) => ({ process: r.process, total: Number(r.total) })),
      schedule,
      estimateTotal,
      byProcessPlan,
      scheduleAgg,
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
// (v3) REST API — 단가 카탈로그(interior_catalog)
//   GET 은 active 만(?all=1 비활성 포함), trade 정확일치 + q ILIKE 부분일치 필터.
//   응답은 raw 배열. DELETE 만 { success:true }.
// ========================================

// GET /api/catalog/trades — 공종 마스터 21종(고정 순서). (/:id 라우트보다 앞)
app.get('/api/catalog/trades', (_req, res) => {
  res.json(TRADE_MASTER);
});

// GET /api/catalog?trade=&q=&limit= — 카탈로그 검색/필터
app.get('/api/catalog', async (req, res) => {
  try {
    const where = [];
    const params = [];

    if (!wantAll(req)) where.push('active = TRUE');

    const trade = typeof req.query.trade === 'string' ? req.query.trade.trim() : '';
    if (trade) {
      params.push(trade);
      where.push(`trade = $${params.length}`);
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      params.push('%' + q + '%');
      const p = `$${params.length}`;
      where.push(`(name ILIKE ${p} OR grp ILIKE ${p} OR product_name ILIKE ${p} OR vendor ILIKE ${p})`);
    }

    let limit = 200;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      const l = Number(req.query.limit);
      if (Number.isFinite(l) && l > 0) limit = Math.min(1000, Math.floor(l));
    }
    params.push(limit);
    const limitPh = `$${params.length}`;

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT ${CATALOG_COLS} FROM interior_catalog ${whereSql} ORDER BY trade ASC, name ASC LIMIT ${limitPh}`,
      params
    );
    res.json(rows.map(rowToCatalog));
  } catch (err) {
    console.error('GET /api/catalog 오류:', err.message);
    res.status(500).json({ success: false, message: '카탈로그를 불러오지 못했습니다.' });
  }
});

// POST /api/catalog — 카탈로그 항목 추가 (trade·name 필수)
app.post('/api/catalog', async (req, res) => {
  try {
    const check = validateCatalog(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `INSERT INTO interior_catalog (trade, grp, name, unit, material_price, labor_price, sub_price, product_name, vendor, code, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${CATALOG_COLS}`,
      [v.trade, v.grp, v.name, v.unit, v.material_price, v.labor_price, v.sub_price, v.product_name, v.vendor, v.code, v.active]
    );
    res.status(201).json(rowToCatalog(rows[0]));
  } catch (err) {
    console.error('POST /api/catalog 오류:', err.message);
    res.status(500).json({ success: false, message: '카탈로그 항목을 생성하지 못했습니다.' });
  }
});

// PUT /api/catalog/:id — 카탈로그 항목 수정(active 포함)
app.put('/api/catalog/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 카탈로그 id 형식입니다.' });
    const check = validateCatalog(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_catalog
       SET trade=$1, grp=$2, name=$3, unit=$4, material_price=$5, labor_price=$6, sub_price=$7, product_name=$8, vendor=$9, code=$10, active=$11
       WHERE id=$12
       RETURNING ${CATALOG_COLS}`,
      [v.trade, v.grp, v.name, v.unit, v.material_price, v.labor_price, v.sub_price, v.product_name, v.vendor, v.code, v.active, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 카탈로그 항목을 찾을 수 없습니다.' });
    res.json(rowToCatalog(rows[0]));
  } catch (err) {
    console.error('PUT /api/catalog/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '카탈로그 항목을 수정하지 못했습니다.' });
  }
});

// DELETE /api/catalog/:id — 실삭제 (견적 항목은 값 복사본이라 영향 없음)
app.delete('/api/catalog/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 카탈로그 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_catalog WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 카탈로그 항목을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/catalog/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '카탈로그 항목을 삭제하지 못했습니다.' });
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
