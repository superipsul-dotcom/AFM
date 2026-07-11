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
const archiver = require('archiver'); // (v8) 프로젝트 zip 백업 스트리밍 (유일하게 추가된 패키지)
const bcrypt = require('bcryptjs'); // (v13) 비밀번호 해시(네이티브 빌드 불필요)
const jwt = require('jsonwebtoken'); // (v13) JWT 발급/검증
const crypto = require('crypto'); // (v17) 공유 토큰 랜덤 발급(내장 모듈)

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

// (v13) 인증 시크릿 + 기본팀 id. JWT_SECRET 미설정 시 dev 기본값(.trim 으로 trailing newline 방어).
//   토큰 payload { userId, teamId }. DEFAULT_TEAM_ID 는 initDB 에서 "안도공간" 팀으로 확정(기존 데이터 backfill 대상).
const JWT_SECRET = (process.env.JWT_SECRET || 'interior-cost-dev-secret-change-me-v13').trim();
let DEFAULT_TEAM_ID = null;

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

// (v5) 노션 관계형 서브-DB 상태 마스터. 목록 외 값은 각 기본값으로 보정(400 대신).
const CLIENT_STATES = ['리드', '상담', '견적', '계약', '시공중', '완료', '보류']; // interior_clients.status (기본 '리드')
const ORDER_STATES = ['대기', '발주', '입고', '정산완료']; // interior_orders.status (기본 '대기')
const AS_STATES = ['접수', '처리중', '완료', '보류']; // interior_as.status (기본 '접수')

// (v19) 일정 유형(kind). 노션 공정표 '유형'(공정/지원/AS) 대응 — 공사/지원/미팅.
//   목록 외 값은 '공사'로 보정(400 대신). kind='미팅' 일정은 interior_meetings 에 연동행 생성.
const SCHEDULE_KINDS = ['공사', '지원', '미팅'];

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

// ========================================
// (v20) Supabase Storage 인프라 — 자료(파일)/현장사진을 클라이언트가 직접 업로드(서명 URL).
//   목적: Vercel 함수 본문 4.5MB 한도 회피(파일은 서버를 거치지 않고 Storage 로 직접 PUT).
//   서버 역할: 버킷 ensure · 서명 업로드/다운로드 URL 발급 · 메타(DB) 기록 · 삭제.
//   내장 fetch 사용(새 패키지 없음). ⚠️ SUPABASE_SERVICE_KEY 는 서버 전용 비밀 — 로그/응답에 절대 노출 금지.
// ========================================
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''); // 끝 슬래시 제거
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim(); // service_role (비밀)
const STORAGE_BUCKET = 'interior-files'; // private 버킷

// 둘 다 있어야 Storage 사용 가능. 없으면 업로드/다운로드 엔드포인트는 503.
function storageConfigured() {
  return SUPABASE_URL.length > 0 && SUPABASE_SERVICE_KEY.length > 0;
}

// Storage REST 공통 헤더(SERVICE_KEY 인증). 이 값을 로그로 남기지 말 것.
function storageHeaders() {
  return {
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  };
}

// 파일명 새니타이즈: 경로탈출(../)·OS 금지문자·제어문자 제거(sanitizeSiteName 과 동일 정책).
function sanitizeFileName(name) {
  let s = String(name == null ? '' : name).trim();
  s = s.replace(/\.\./g, '_'); // 상위경로 탈출 차단
  s = s.replace(/[\/\\:*?"<>|]/g, '_'); // OS 예약/경로 구분 문자
  // eslint-disable-next-line no-control-regex
  s = s.replace(new RegExp('[\\x00-\\x1f\\x7f]', 'g'), '_'); // control chars
  s = s.replace(/^\.+/, '_'); // 선두 점(숨김/상대경로) 차단
  s = s.replace(/\s+/g, '_'); // 공백 → _
  // Supabase Storage 객체 키는 S3 규격(영숫자 + !-_.*'())만 허용 — 한글 등 비허용 문자는 _ 치환.
  // (한글 파일명이면 키가 "_.pdf" 꼴이 되지만 timestamp 프리픽스로 유니크, 원본명은 DB file_name 에 보존)
  s = s.replace(/[^0-9A-Za-z!\-_.*'()]/g, '_');
  s = s.replace(/_{2,}/g, '_'); // 연속 _ 축약
  if (!s) s = 'file';
  return s.slice(0, 180); // 과도한 길이 컷
}

// Storage 저장 경로: sites/{siteId}/{kind}/{timestamp}_{safeName}
function buildStoragePath(siteId, kind, fileName) {
  return `sites/${siteId}/${kind}/${Date.now()}_${sanitizeFileName(fileName)}`;
}

// 버킷 ensure(없으면 private 로 생성). 이미 존재(400/409)면 무시. 실패해도 부팅/요청 계속(best-effort).
let bucketEnsured = false;
async function ensureStorageBucket() {
  if (bucketEnsured || !storageConfigured()) return;
  try {
    const resp = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: storageHeaders(),
      body: JSON.stringify({ id: STORAGE_BUCKET, name: STORAGE_BUCKET, public: false }),
    });
    if (resp.ok || resp.status === 409 || resp.status === 400) {
      bucketEnsured = true; // 생성 성공 또는 이미 존재(Duplicate)
    } else {
      console.warn(`⚠️  Storage 버킷 ensure 응답 HTTP ${resp.status} — 계속 진행.`);
    }
  } catch (err) {
    console.warn('⚠️  Storage 버킷 ensure 예외(무시):', err.message);
  }
}

// 서명 업로드 URL 발급 → { uploadUrl(클라 PUT 대상 절대 URL), path }.
async function signUploadUrl(storagePath) {
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/upload/sign/${STORAGE_BUCKET}/${storagePath}`,
    // body '{}' 필수: Content-Type json + 빈 body 면 Supabase(Fastify) 가 400 "Body cannot be empty".
    { method: 'POST', headers: storageHeaders(), body: '{}' }
  );
  if (!resp.ok) throw new Error(`sign-upload HTTP ${resp.status}`);
  const data = await resp.json(); // { url: '/object/upload/sign/...?token=...' }
  return { uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}`, path: storagePath };
}

// 서명 다운로드 URL 발급(기본 1시간) → 절대 URL 문자열.
async function signDownloadUrl(storagePath, expiresIn = 3600) {
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${storagePath}`,
    { method: 'POST', headers: storageHeaders(), body: JSON.stringify({ expiresIn }) }
  );
  if (!resp.ok) throw new Error(`sign-download HTTP ${resp.status}`);
  const data = await resp.json(); // { signedURL: '/object/sign/...?token=...' }
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

// Storage 객체 삭제(베스트에포트) — 실패해도 throw 하지 않음(행 삭제는 진행).
async function deleteStorageObject(storagePath) {
  if (!storageConfigured() || !storagePath) return;
  try {
    // body '{}' 필수: Content-Type json + 빈 body 면 Supabase(Fastify) 400 → 삭제가 조용히 실패했었음.
    const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
      method: 'DELETE',
      headers: storageHeaders(),
      body: '{}',
    });
    if (!resp.ok && resp.status !== 404) console.warn(`⚠️  Storage 객체 삭제 응답 HTTP ${resp.status} (계속 진행): ${storagePath}`);
  } catch (err) {
    console.warn('⚠️  Storage 객체 삭제 예외(무시):', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
// (v24) CODEF 조회 API — KB국민카드 등 카드 승인내역 연동.
//   보안 원칙: 카드사 비밀번호는 서버/DB에 절대 저장하지 않는다.
//   등록 시 RSA(PKCS1) 암호화 → CODEF 보안볼트로 즉시 전달, 우리는 connectedId 만 보관.
//   CODEF 키 미설정이면 mock 모드(전체 플로우 동작, 샘플 데이터) — 키 등록 즉시 실연동.
// ════════════════════════════════════════════════════════════════
const CODEF_CLIENT_ID = (process.env.CODEF_CLIENT_ID || '').trim();
const CODEF_CLIENT_SECRET = (process.env.CODEF_CLIENT_SECRET || '').trim();
const CODEF_PUBLIC_KEY = (process.env.CODEF_PUBLIC_KEY || '').trim();
const CODEF_API_HOST = (process.env.CODEF_API_HOST || 'https://development.codef.io').trim().replace(/\/$/, '');

function codefConfigured() {
  return Boolean(CODEF_CLIENT_ID && CODEF_CLIENT_SECRET && CODEF_PUBLIC_KEY);
}

// 카드사 기관코드 (CODEF organization)
const CARD_ORGS = {
  '0301': 'KB국민카드', '0302': '삼성카드', '0304': '현대카드', '0305': 'BC카드',
  '0306': '신한카드', '0309': '우리카드', '0311': '롯데카드', '0313': '하나카드', '0321': 'NH농협카드',
};

// RSA(PKCS1 v1.5) 암호화 — CODEF 규격. PUBLIC_KEY 가 base64 본문만이면 PEM 헤더 자동 감싸기.
function codefRsaEncrypt(plain) {
  let pem = CODEF_PUBLIC_KEY;
  if (!pem.includes('BEGIN')) {
    const body = pem.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
    pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;
  }
  return crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(plain), 'utf8')
  ).toString('base64');
}

// OAuth 토큰 캐시 (client_credentials)
let codefTokenCache = { token: null, expiresAt: 0 };
async function codefToken() {
  if (codefTokenCache.token && Date.now() < codefTokenCache.expiresAt - 60000) return codefTokenCache.token;
  const basic = Buffer.from(`${CODEF_CLIENT_ID}:${CODEF_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch('https://oauth.codef.io/oauth/token?grant_type=client_credentials&scope=read', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!resp.ok) throw new Error(`CODEF 토큰 발급 실패 HTTP ${resp.status}`);
  const data = await resp.json();
  codefTokenCache = { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return codefTokenCache.token;
}

// CODEF 요청 wrapper — 응답이 URL 인코딩된 JSON 인 경우가 있어 decode 시도 후 파싱.
//   result.code !== 'CF-00000' 이면 코드+메시지로 throw(추가인증 CF-12xxx 등 사용자에게 그대로 안내).
async function codefRequest(pathname, body) {
  const token = await codefToken();
  const resp = await fetch(`${CODEF_API_HOST}${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  let parsed;
  try { parsed = JSON.parse(decodeURIComponent(raw.replace(/\+/g, '%20'))); }
  catch (e) { try { parsed = JSON.parse(raw); } catch (e2) { throw new Error(`CODEF 응답 파싱 실패 (HTTP ${resp.status})`); } }
  const code = parsed && parsed.result && parsed.result.code;
  if (code !== 'CF-00000') {
    const msg = (parsed && parsed.result && (parsed.result.message || parsed.result.extraMessage)) || '알 수 없는 오류';
    const err = new Error(`CODEF ${code || 'ERR'}: ${msg}`);
    err.codefCode = code;
    throw err;
  }
  return parsed.data;
}

// 계정(카드사 로그인) 등록 → connectedId. 비번은 이 함수 안에서 즉시 암호화되어 나가고 어디에도 저장되지 않는다.
async function codefCreateAccount({ organization, clientType, loginId, password }) {
  const data = await codefRequest('/v1/account/create', {
    accountList: [{
      countryCode: 'KR', businessType: 'CD', clientType,
      organization, loginType: '1', id: loginId, password: codefRsaEncrypt(password),
    }],
  });
  const cid = data && data.connectedId;
  if (!cid) throw new Error('CODEF connectedId 발급 실패');
  return cid;
}

async function codefDeleteAccount({ connectedId, organization, clientType }) {
  await codefRequest('/v1/account/delete', {
    accountList: [{ countryCode: 'KR', businessType: 'CD', clientType, organization, loginType: '1' }],
    connectedId,
  });
}

// 승인내역 조회 (개인 p / 법인 b) → 표준화 행 배열.
//   카드사/상품별 응답 필드가 조금씩 달라 후보 키에서 안전 추출.
function pick(obj, keys, dflt = '') {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return dflt;
}
function codefMapApproval(r) {
  const dateRaw = pick(r, ['resUsedDate', 'resApprovalDate']); // YYYYMMDD
  const timeRaw = pick(r, ['resUsedTime', 'resApprovalTime'], '000000'); // HHmmss
  const d = dateRaw.replace(/\D/g, '');
  const t = (timeRaw.replace(/\D/g, '') + '000000').slice(0, 6);
  const usedAt = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+09:00` : null;
  const cancelYn = pick(r, ['resCancelYN', 'resCancelYn']);
  const statusRaw = pick(r, ['resApprovalStatus', 'resPaymentStatus']);
  const status = cancelYn === '1' || /취소/.test(statusRaw) ? '취소' : '승인';
  const amount = Number(pick(r, ['resUsedAmount', 'resApprovalAmount', 'resPaymentAmount'], '0').replace(/[^0-9.-]/g, '')) || 0;
  return {
    approval_no: pick(r, ['resApprovalNo', 'resApprovalNumber']),
    used_at: usedAt,
    merchant: pick(r, ['resMemberStoreName', 'resMemberStoreNm', 'resStoreName']),
    merchant_biz_no: pick(r, ['resMemberStoreNo', 'resMemberStoreCorpNo', 'resCompanyIdentityNo']),
    merchant_type: pick(r, ['resMemberStoreType', 'resStoreType', 'resBusinessCode']),
    amount,
    card_no: pick(r, ['resCardNo', 'resCardNumber']),
    status,
    installment: pick(r, ['resInstallmentMonth', 'resInstallment'], ''),
  };
}
async function codefApprovals({ connectedId, organization, clientType, startDate, endDate }) {
  const path = clientType === 'B' ? '/v1/kr/card/b/account/approval-list' : '/v1/kr/card/p/account/approval-list';
  const data = await codefRequest(path, {
    organization, connectedId,
    startDate, endDate, // YYYYMMDD
    orderBy: '0', inquiryType: '0',
  });
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list.map(codefMapApproval).filter((x) => x.used_at && x.approval_no);
}

// ── mock 모드: 현실적인 인테리어 지출 샘플 생성 (키 없이 전체 플로우 검증/시연용) ──
const MOCK_MERCHANTS = [
  { m: '동화철물백화점', t: '철물점', biz: '1108801234', amtRange: [30000, 400000] },
  { m: '을지로타일도기', t: '타일도기', biz: '2018812345', amtRange: [100000, 1500000] },
  { m: '한솔목재상사', t: '목재상', biz: '1058823456', amtRange: [200000, 2000000] },
  { m: '남대문조명프라자', t: '조명기구', biz: '1048834567', amtRange: [50000, 900000] },
  { m: '(주)LX하우시스대리점', t: '건축자재', biz: '2148845678', amtRange: [300000, 3000000] },
  { m: '페인트나라방배점', t: '도료판매', biz: '1208856789', amtRange: [40000, 500000] },
  { m: 'GS25 성수현장점', t: '편의점', biz: '1178867890', amtRange: [3000, 25000] },
  { m: '김밥천국 성수점', t: '음식점', biz: '2068878901', amtRange: [7000, 45000] },
  { m: '스타벅스 성수역점', t: '커피전문점', biz: '2018889012', amtRange: [4500, 32000] },
  { m: '쿠팡(주)', t: '전자상거래', biz: '1208891234', amtRange: [10000, 300000] },
  { m: '현대주유소', t: '주유소', biz: '1108802345', amtRange: [50000, 90000] },
  { m: '철거왕산업폐기물', t: '폐기물처리', biz: '3018813456', amtRange: [150000, 800000] },
];
function mockApprovals(startDate, endDate) {
  const start = new Date(`${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}T00:00:00+09:00`);
  const end = new Date(`${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}T23:59:59+09:00`);
  const span = Math.max(1, end.getTime() - start.getTime());
  const n = 15 + Math.floor(Math.random() * 11); // 15~25건
  const rows = [];
  for (let i = 0; i < n; i++) {
    const mm = MOCK_MERCHANTS[Math.floor(Math.random() * MOCK_MERCHANTS.length)];
    const at = new Date(start.getTime() + Math.random() * span);
    const amt = Math.round((mm.amtRange[0] + Math.random() * (mm.amtRange[1] - mm.amtRange[0])) / 100) * 100;
    rows.push({
      approval_no: 'M' + at.getTime().toString().slice(-8) + String(i).padStart(2, '0'),
      used_at: at.toISOString(),
      merchant: mm.m, merchant_biz_no: mm.biz, merchant_type: mm.t,
      amount: amt, card_no: '5570-12**-****-1234',
      status: Math.random() < 0.04 ? '취소' : '승인',
      installment: '',
    });
  }
  return rows;
}

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

  // (v9) 협력업체 trade(공정)/grade(기술력) 컬럼 — 노션 협력업체 DB import 용.
  //   ADD COLUMN IF NOT EXISTS → 기존 vendors 데이터 100% 보존, 멱등.
  await pool.query(`ALTER TABLE interior_vendors ADD COLUMN IF NOT EXISTS trade TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE interior_vendors ADD COLUMN IF NOT EXISTS grade TEXT NOT NULL DEFAULT ''`);

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

  // 7-b) (v14) 일정 협력업체(이 공정에 투입되는 거래처명) — staff 와 동형 텍스트.
  //   ADD COLUMN IF NOT EXISTS → 기존 일정 데이터 100% 보존, 멱등. 거래처 마스터명과 매칭(자유입력 허용).
  await pool.query(`ALTER TABLE interior_schedule ADD COLUMN IF NOT EXISTS vendor TEXT NOT NULL DEFAULT ''`);

  // 7-c) (v19) 일정 유형(kind): 공사(기본)/지원/미팅. ADD COLUMN IF NOT EXISTS → 기존 일정 전부 '공사' 로 backfill, 멱등.
  //   kind='미팅' 일정은 interior_meetings 에 연동행이 생성된다(아래 syncScheduleMeeting).
  await pool.query(`ALTER TABLE interior_schedule ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT '공사'`);

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

  // 10-b) (v12) 비용 계산서(세금계산서) 유무: has_invoice. true → amount 는 부가세 포함 합계로 간주(공급가=round(amount/1.1)).
  await pool.query('ALTER TABLE interior_costs ADD COLUMN IF NOT EXISTS has_invoice BOOLEAN NOT NULL DEFAULT false');

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

  // (v9) 카탈로그 source(단가 출처)/price_date(단가 기준일) 컬럼 — research 단가 import 용.
  //   ADD COLUMN IF NOT EXISTS → 기존 562 시드 포함 카탈로그 데이터 100% 보존, 멱등.
  await pool.query(`ALTER TABLE interior_catalog ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`);
  await pool.query('ALTER TABLE interior_catalog ADD COLUMN IF NOT EXISTS price_date DATE');

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

  // ====================================================================
  // (v5) 노션 관계형 서브-DB — 고객/리드 · 발주서 · 미팅 · AS
  //   고객/리드 = 전역 마스터(staff/vendors 동형), 발주/미팅/AS = 현장(site_id) 종속 CASCADE.
  //   전부 CREATE TABLE / ADD COLUMN IF NOT EXISTS → v1~v4 데이터 100% 보존, 멱등.
  // ====================================================================

  // 17) 고객/리드 (전역 마스터). UNIQUE 없음(동명 리드 공존 허용).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_clients (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '리드',
      address TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 18) 현장 ↔ 고객/리드 연결 컬럼 (nullable, 앱 레벨 검증; 기존 client 텍스트는 그대로 보존)
  await pool.query('ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS client_id BIGINT');

  // 19) 발주서 (현장 종속, 현장 삭제 시 CASCADE)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_orders (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      order_no TEXT NOT NULL DEFAULT '',
      vendor TEXT NOT NULL DEFAULT '',
      trade TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      amount BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
      order_date DATE,
      due_date DATE,
      status TEXT NOT NULL DEFAULT '대기',
      memo TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 20) 미팅 (현장 종속, CASCADE)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_meetings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      meeting_date DATE,
      title TEXT NOT NULL,
      attendees TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 20-b) (v19) 미팅 → 원본 일정 링크. kind='미팅' 일정에서 연동 생성된 미팅의 schedule_id.
  //   수동 미팅은 null. ADD COLUMN IF NOT EXISTS → 기존 미팅 100% 보존, 멱등.
  await pool.query('ALTER TABLE interior_meetings ADD COLUMN IF NOT EXISTS schedule_id BIGINT');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_meetings_schedule ON interior_meetings (schedule_id);');

  // 21) AS (현장 종속, CASCADE)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_as (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      received_date DATE,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '접수',
      handled_date DATE,
      staff TEXT NOT NULL DEFAULT '',
      cost BIGINT NOT NULL DEFAULT 0 CHECK (cost >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 22) v5 인덱스 (목록/정렬/조인 가속) — 멱등
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_clients_active_name ON interior_clients (active DESC, name ASC);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_sites_client ON interior_sites (client_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_orders_site ON interior_orders (site_id, order_date DESC, id DESC);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_meetings_site ON interior_meetings (site_id, meeting_date DESC, id DESC);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_as_site ON interior_as (site_id, received_date DESC, id DESC);');

  // ====================================================================
  // (v6) 현장 운영 강화 1차 — 진행/완료 분리(archived) + 일정 선후관계(deps)
  //   전부 ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS → v1~v5 데이터 100% 보존, 멱등.
  // ====================================================================

  // 23) (6-1) 현장 보관(아카이브) 플래그. progress_status 와 독립 — 사용자가 명시적으로 토글.
  //     기존 행은 DEFAULT FALSE 로 백필 → GET /api/sites 는 여전히 전체 반환(회귀 안전).
  await pool.query('ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE');

  // 24) (6-4) 일정 선후관계(의존성). 같은 현장 일정끼리만·자기참조/사이클 금지(앱 레벨 검증).
  //     UNIQUE(predecessor_id, successor_id) → 중복 링크 방지. 일정 삭제 시 양방향 CASCADE.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_schedule_deps (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      predecessor_id BIGINT NOT NULL REFERENCES interior_schedule(id) ON DELETE CASCADE,
      successor_id BIGINT NOT NULL REFERENCES interior_schedule(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (predecessor_id, successor_id)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_schedule_deps_pred ON interior_schedule_deps (predecessor_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_schedule_deps_succ ON interior_schedule_deps (successor_id);');

  // ====================================================================
  // (v8) 스케치업/실측 물량 takeoff (interior_takeoff)
  //   CREATE TABLE / CREATE INDEX IF NOT EXISTS → v1~v7 데이터 100% 보존, 멱등.
  //   미래의 스케치업 플러그인이 물량/치수를 보내는 "받는 쪽" 구조 (지금은 수동/테스트).
  // ====================================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_takeoff (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      trade TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT '',
      qty NUMERIC NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      source_guid TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_takeoff_site ON interior_takeoff (site_id, created_at DESC);');

  // ====================================================================
  // (v10) 발주 자동생성 + 필요시기 알림 — interior_orders 확장
  //   ADD COLUMN IF NOT EXISTS → v1~v9 데이터 100% 보존, 멱등.
  //   need_date = 필요시기(자재가 현장에 있어야 하는 날), auto_generated = 자동생성 초안 표시.
  // ====================================================================
  await pool.query('ALTER TABLE interior_orders ADD COLUMN IF NOT EXISTS need_date DATE');
  await pool.query('ALTER TABLE interior_orders ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE');

  // ----------------------------------------
  // (v13) 로그인/회원가입 + 팀(워크스페이스) 멀티테넌트
  //   - interior_teams(테넌트) / interior_users(이메일·비번·소속팀)
  //   - 기본팀 "안도공간" 시드 → DEFAULT_TEAM_ID 확보
  //   - 소유 엔티티 6종에 team_id 컬럼 추가 + 기존 행 전부 기본팀으로 backfill
  //     ⚠️ backfill 누락 = 로그인 사용자에게 기존 데이터(현장2·협력업체283)가 사라짐 → 절대 빠뜨리지 말 것.
  //   - 이 블록은 모든 시드(카테고리 11), 카탈로그 시드(seedCatalogIfEmpty 340))보다 뒤에 실행되므로
  //     그 시드 행들도 backfill 로 함께 team_id 가 채워진다.
  // ----------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_teams (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name        TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      plan        TEXT NOT NULL DEFAULT 'free',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_users (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL DEFAULT '',
      team_id       BIGINT NOT NULL REFERENCES interior_teams(id),
      role          TEXT NOT NULL DEFAULT 'member',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // 기본팀 "안도공간" 확보 (이름 우선 조회 → 없으면 생성). invite_code 는 env 또는 'ANDO-2026'.
  const inviteCode = (process.env.INTERIOR_INVITE_CODE || 'ANDO-2026').trim();
  let teamRow = await pool.query(`SELECT id FROM interior_teams WHERE name=$1 ORDER BY id ASC LIMIT 1`, ['안도공간']);
  if (teamRow.rows.length === 0) {
    await pool.query(
      `INSERT INTO interior_teams (name, invite_code) VALUES ($1,$2) ON CONFLICT (invite_code) DO NOTHING`,
      ['안도공간', inviteCode]
    );
    teamRow = await pool.query(`SELECT id FROM interior_teams WHERE name=$1 ORDER BY id ASC LIMIT 1`, ['안도공간']);
    if (teamRow.rows.length === 0) {
      teamRow = await pool.query(`SELECT id FROM interior_teams WHERE invite_code=$1`, [inviteCode]);
    }
  }
  DEFAULT_TEAM_ID = teamRow.rows[0].id;

  // 소유 엔티티 6종: team_id 컬럼 추가 + 기존 행 backfill(기본팀 귀속). 멱등.
  for (const t of [
    'interior_sites', 'interior_staff', 'interior_vendors',
    'interior_categories', 'interior_catalog', 'interior_clients',
  ]) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS team_id BIGINT`);
    await pool.query(`UPDATE ${t} SET team_id = $1 WHERE team_id IS NULL`, [DEFAULT_TEAM_ID]);
  }

  // (v17) 견적/발주 공유링크 + 비밀번호 — share_token(nullable, 랜덤 발급), share_password_hash(nullable, bcrypt).
  //   ADD COLUMN / CREATE INDEX IF NOT EXISTS → v1~v16 데이터 100% 보존, 멱등. null=비공유/비번없음.
  for (const t of ['interior_estimates', 'interior_orders']) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS share_token TEXT`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS share_password_hash TEXT`);
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_estimates_share_token ON interior_estimates (share_token);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_orders_share_token ON interior_orders (share_token);');

  // (v18 / 18-2) 견적 버전 — 복제([새 버전으로 저장]) 시 새 버전 부여. 기존 견적은 전부 DEFAULT 1.
  //   ADD COLUMN IF NOT EXISTS → v1~v17 데이터 100% 보존, 멱등.
  await pool.query('ALTER TABLE interior_estimates ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1');

  // (v18 / 18-3) 견적 템플릿 — 팀 스코핑. 신규 테이블(생성 시 team_id 세팅 → backfill 불필요).
  //   config = 원가계산 가정율 객체(JSONB), items = 기본 공종 항목 배열(JSONB).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_estimate_templates (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id     BIGINT,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      config      JSONB NOT NULL DEFAULT '{}'::jsonb,
      items       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_estimate_templates_team ON interior_estimate_templates (team_id);');

  // (v20) 자료(파일) — Supabase Storage 직접 업로드. DB 는 메타만 보관. site CASCADE.
  //   팀 스코핑 = site 소유검증(미들웨어/requireChildOwned). 신규 테이블 → backfill 불필요.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_documents (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id      BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      doc_type     TEXT NOT NULL DEFAULT '기타',
      storage_path TEXT NOT NULL DEFAULT '',
      file_name    TEXT NOT NULL DEFAULT '',
      file_size    BIGINT NOT NULL DEFAULT 0,
      uploader     TEXT NOT NULL DEFAULT '',
      memo         TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_documents_site ON interior_documents (site_id);');

  // (v20) 현장사진 — photo_date/공정(다중 콤마문자열)/업로더(자동)/특이사항. site CASCADE.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_photos (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id      BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      photo_date   DATE,
      processes    TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL DEFAULT '',
      file_name    TEXT NOT NULL DEFAULT '',
      uploader     TEXT NOT NULL DEFAULT '',
      memo         TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_photos_site ON interior_photos (site_id);');

  // (v21 / #5) admin 조직·권한 + 프로젝트 인력배정.
  //   ① 직원마스터 확장(직급/고용형태/이메일/입사일) — ADD COLUMN IF NOT EXISTS, v1~v20 데이터 100% 보존, 멱등.
  await pool.query(`ALTER TABLE interior_staff ADD COLUMN IF NOT EXISTS grade TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE interior_staff ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE interior_staff ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE interior_staff ADD COLUMN IF NOT EXISTS hire_date DATE`);

  //   ② 프로젝트 인력배정(다대다) — 신규 테이블. site/staff 둘 다 CASCADE. 팀 스코핑 = site 소유검증.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_site_staff (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      site_id         BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      staff_id        BIGINT NOT NULL REFERENCES interior_staff(id) ON DELETE CASCADE,
      role_in_project TEXT NOT NULL DEFAULT '',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (site_id, staff_id, role_in_project)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_site_staff_site ON interior_site_staff (site_id);');

  //   ③ 최초 관리자 backfill: admin 이 없는 팀은 가장 먼저 가입한 유저를 admin 으로 승격(멱등).
  //      기존 유저(v13 이후 전부 member)로도 조직/배정 기능이 즉시 사용 가능. admin 이 이미 있으면 no-op.
  await pool.query(`
    UPDATE interior_users SET role='admin'
    WHERE id IN (
      SELECT DISTINCT ON (team_id) id FROM interior_users
      WHERE team_id NOT IN (SELECT team_id FROM interior_users WHERE role='admin')
      ORDER BY team_id, id ASC
    )
  `);

  // (v22 / #3) 클라이언트 페이지 공유 — 현장 단위 공개 토큰(+선택 비번). v17 견적/발주 공유와 동형.
  //   rowToSite/SITE_COLS 에는 노출하지 않는다(다른 응답 경유 토큰 누출 방지) — 관리 GET 엔드포인트로만 조회.
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS client_share_token TEXT`);
  await pool.query(`ALTER TABLE interior_sites ADD COLUMN IF NOT EXISTS client_share_password_hash TEXT`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_sites_client_share_token ON interior_sites (client_share_token);');

  // (v24) 카드 연동 — 계정(connectedId만)·거래 스테이징·가맹점 학습규칙. 팀 스코핑 team_id 직접.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_card_accounts (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id        BIGINT NOT NULL,
      organization   TEXT NOT NULL DEFAULT '0301',
      card_type      TEXT NOT NULL DEFAULT 'P',
      connected_id   TEXT NOT NULL DEFAULT '',
      label          TEXT NOT NULL DEFAULT '',
      last_synced_at TIMESTAMPTZ,
      active         BOOLEAN NOT NULL DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_card_accounts_team ON interior_card_accounts (team_id);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_card_txns (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id         BIGINT NOT NULL,
      account_id      BIGINT NOT NULL REFERENCES interior_card_accounts(id) ON DELETE CASCADE,
      approval_no     TEXT NOT NULL DEFAULT '',
      used_at         TIMESTAMPTZ NOT NULL,
      merchant        TEXT NOT NULL DEFAULT '',
      merchant_biz_no TEXT NOT NULL DEFAULT '',
      merchant_type   TEXT NOT NULL DEFAULT '',
      amount          BIGINT NOT NULL DEFAULT 0,
      card_no         TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT '승인',
      installment     TEXT NOT NULL DEFAULT '',
      site_id         BIGINT REFERENCES interior_sites(id) ON DELETE SET NULL,
      cost_id         BIGINT REFERENCES interior_costs(id) ON DELETE SET NULL,
      excluded        BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (account_id, approval_no, used_at)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_card_txns_team ON interior_card_txns (team_id, used_at DESC);');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_merchant_rules (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id    BIGINT NOT NULL,
      merchant   TEXT NOT NULL,
      site_id    BIGINT REFERENCES interior_sites(id) ON DELETE CASCADE,
      category   TEXT NOT NULL DEFAULT '자재비',
      process    TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (team_id, merchant)
    )
  `);

  // (v25) 개인 할일 — 담당자/현장/마감일. 유저·현장 삭제에도 행 보존(SET NULL).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_tasks (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id          BIGINT NOT NULL REFERENCES interior_teams(id) ON DELETE CASCADE,
      site_id          BIGINT REFERENCES interior_sites(id) ON DELETE SET NULL,
      title            TEXT NOT NULL,
      memo             TEXT NOT NULL DEFAULT '',
      due_date         DATE,
      status           TEXT NOT NULL DEFAULT '진행',
      assignee_user_id BIGINT REFERENCES interior_users(id) ON DELETE SET NULL,
      created_by       BIGINT REFERENCES interior_users(id) ON DELETE SET NULL,
      completed_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_tasks_team_assignee ON interior_tasks (team_id, assignee_user_id, status);');

  // (v25) 출력인원 — 현장×날짜×공정 1행(upsert), 기공(skilled)/조공(helper) 분리. 일정 삭제돼도 기록 보존.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_labor_logs (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id     BIGINT NOT NULL REFERENCES interior_teams(id) ON DELETE CASCADE,
      site_id     BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      work_date   DATE NOT NULL,
      schedule_id BIGINT REFERENCES interior_schedule(id) ON DELETE SET NULL,
      process     TEXT NOT NULL DEFAULT '',
      skilled     INT NOT NULL DEFAULT 0 CHECK (skilled >= 0),
      helper      INT NOT NULL DEFAULT 0 CHECK (helper >= 0),
      memo        TEXT NOT NULL DEFAULT '',
      done        BOOLEAN NOT NULL DEFAULT false,
      done_at     TIMESTAMPTZ,
      created_by  BIGINT REFERENCES interior_users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (site_id, work_date, process)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_labor_logs_site_date ON interior_labor_logs (site_id, work_date);');

  // (v26) 인건비: 거래처(시공팀) 일당 프리셋 + 출력 로그의 시공팀/단가 스냅샷.
  //   단가는 행에 스냅샷 저장 → 거래처 단가를 나중에 바꿔도 과거 인건비 불변. 인건비 = skilled*skilled_rate + helper*helper_rate (조회 시 계산).
  await pool.query(`ALTER TABLE interior_vendors ADD COLUMN IF NOT EXISTS skilled_rate BIGINT NOT NULL DEFAULT 0 CHECK (skilled_rate >= 0)`);
  await pool.query(`ALTER TABLE interior_vendors ADD COLUMN IF NOT EXISTS helper_rate  BIGINT NOT NULL DEFAULT 0 CHECK (helper_rate >= 0)`);
  await pool.query(`ALTER TABLE interior_labor_logs ADD COLUMN IF NOT EXISTS vendor_id BIGINT REFERENCES interior_vendors(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE interior_labor_logs ADD COLUMN IF NOT EXISTS skilled_rate BIGINT NOT NULL DEFAULT 0 CHECK (skilled_rate >= 0)`);
  await pool.query(`ALTER TABLE interior_labor_logs ADD COLUMN IF NOT EXISTS helper_rate  BIGINT NOT NULL DEFAULT 0 CHECK (helper_rate >= 0)`);

  // (v25) 매뉴얼 DB — 노션 시공매뉴얼 구조(항목/공정/유형/상태) + 인앱 본문/노션 링크.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_manuals (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id    BIGINT NOT NULL REFERENCES interior_teams(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      trade      TEXT NOT NULL DEFAULT '',
      types      TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT '작성 전',
      content    TEXT NOT NULL DEFAULT '',
      notion_url TEXT NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // (v25) 현장별 매뉴얼 선택(관리자 지정 → 현장 매뉴얼 탭에 선택본만 노출)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_site_manuals (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id    BIGINT NOT NULL REFERENCES interior_teams(id) ON DELETE CASCADE,
      site_id    BIGINT NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
      manual_id  BIGINT NOT NULL REFERENCES interior_manuals(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (site_id, manual_id)
    )
  `);

  // (v25) 인앱 알림 — 수신자 단위 행. 유저 삭제 시 알림도 정리(CASCADE), 현장 삭제 시 관련 알림 정리.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_notifications (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id       BIGINT NOT NULL REFERENCES interior_teams(id) ON DELETE CASCADE,
      user_id       BIGINT NOT NULL REFERENCES interior_users(id) ON DELETE CASCADE,
      actor_user_id BIGINT REFERENCES interior_users(id) ON DELETE SET NULL,
      type          TEXT NOT NULL DEFAULT '',
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      site_id       BIGINT REFERENCES interior_sites(id) ON DELETE CASCADE,
      ref_type      TEXT NOT NULL DEFAULT '',
      ref_id        BIGINT,
      read_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_notifications_user ON interior_notifications (user_id, read_at);');

  // ====================================================================
  // (v27) 자재 코드 연동 — material-research 자재 레지스트리 + 코드 매핑 규칙 + takeoff 코드 컬럼
  //   코드([WD-0001]/[PT:BM:2062-30] 등)는 "포인터": 단가/로스율/공종/카탈로그 연결은 이 앱(팀)이 소유.
  //   전부 CREATE TABLE / ADD COLUMN IF NOT EXISTS → v1~v26 데이터 100% 보존, 멱등.
  // ====================================================================

  // 자재 레지스트리(팀 소유) — material-research /api/mat-codes 동기화(sync) 대상.
  //   price NULL = 단가 미정(빈값). sync 재실행 시 정보필드만 갱신되고 price/trade/카탈로그 연결은 보존된다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_materials (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id         BIGINT NOT NULL REFERENCES interior_teams(id) ON DELETE CASCADE,
      code            TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'other',
      brand           TEXT NOT NULL DEFAULT '',
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT '',
      spec            TEXT NOT NULL DEFAULT '',
      unit            TEXT NOT NULL DEFAULT 'm2',
      price           BIGINT,
      waste_pct       NUMERIC NOT NULL DEFAULT 0,
      trade           TEXT NOT NULL DEFAULT '',
      catalog_item_id BIGINT REFERENCES interior_catalog(id) ON DELETE SET NULL,
      source          TEXT NOT NULL DEFAULT 'material-research',
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (team_id, code)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_interior_materials_team_code ON interior_materials (team_id, code);');

  // 코드 매핑 규칙(자재 행이 없을 때의 폴백) — v24 가맹점 학습규칙 패턴.
  //   exact(is_prefix=false, pattern=코드 전체) / prefix(is_prefix=true, 전방일치·최장 우선).
  //   resolve 호출 시 팀 기본 프리픽스 규칙('PT:'→도장공사, 'WD-'→바닥공사)이 시드된다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interior_mat_rules (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      team_id         BIGINT NOT NULL REFERENCES interior_teams(id) ON DELETE CASCADE,
      pattern         TEXT NOT NULL,
      is_prefix       BOOLEAN NOT NULL DEFAULT false,
      trade           TEXT NOT NULL DEFAULT '',
      catalog_item_id BIGINT REFERENCES interior_catalog(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (team_id, pattern)
    )
  `);

  // takeoff 에 자재 코드(빈값=비코드 행) — DLP-TAKEOFF v2 CSV 의 material_code 컬럼 저장.
  await pool.query(`ALTER TABLE interior_takeoff ADD COLUMN IF NOT EXISTS material_code TEXT NOT NULL DEFAULT ''`);

  // (v25) 매뉴얼 시드 — 전체 0건일 때만 노션 43건을 가장 오래된 팀에 적재
  await seedManualsIfEmpty();

  // (v20) Storage 버킷 ensure (키 있을 때만, best-effort — 실패해도 부팅 계속)
  await ensureStorageBucket();

  dbInitialized = true;
  console.log('🗄️  interior_* (sites/costs/staff/vendors/categories/schedule/schedule_deps/estimates/estimate_items/catalog/clients/orders/meetings/as/takeoff/documents/photos) 준비 완료 + 카테고리/카탈로그 시드.');
}

// (v25) 매뉴얼이 전체 0건일 때만 seed/manuals.json(노션 시공매뉴얼 DB 43건)을 가장 오래된 팀에 적재.
//   단일팀 전제(안도공간). 전부 지운 뒤 재부팅하면 재시드됨 — 관리 탭에서 개별 삭제로 관리.
async function seedManualsIfEmpty() {
  try {
    const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM interior_manuals');
    if (Number(cnt.rows[0].n) > 0) return;
    const team = await pool.query('SELECT id FROM interior_teams ORDER BY id ASC LIMIT 1');
    if (team.rows.length === 0) return; // 팀 없으면 (최초 부팅 순서상) 다음 부팅에서 시드
    const teamId = team.rows[0].id;
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'manuals.json'), 'utf8'));
    const items = Array.isArray(raw.manuals) ? raw.manuals : [];
    if (items.length === 0) return;
    const params = [];
    const values = items.map((m, i) => {
      params.push(teamId, String(m.title || '').trim(), String(m.trade || ''), String(m.types || ''),
        String(m.status || '작성 전'), String(m.content || ''), String(m.notion_url || ''), i);
      const o = i * 8;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`;
    });
    await pool.query(
      `INSERT INTO interior_manuals (team_id, title, trade, types, status, content, notion_url, sort_order)
       VALUES ${values.join(',')}`, params
    );
    console.log(`📖 매뉴얼 시드 완료: ${items.length}건 (team ${teamId})`);
  } catch (err) {
    console.warn('⚠️  매뉴얼 시드 실패(부팅 계속):', err.message);
  }
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
app.use(express.json({ limit: '15mb' })); // v7: 영수증 base64(이미지)가 커서 본문 한도 상향
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
// (v13) 인증 — JWT Bearer + 팀 멀티테넌트
//   - 모든 /api/* 보호. 예외: POST /api/auth/login, POST /api/auth/signup (비보호).
//   - 정적(비 /api, SPA 셸)은 비보호 → 앱이 로그인 게이트를 직접 렌더.
//   - 토큰 검증 성공 시 req.userId / req.teamId 세팅.
//   - 소유 검증 미들웨어들은 인증 뒤에 등록(req.teamId 필요) + 실제 라우트들보다 먼저 실행됨.
// ========================================

// 사용자 행 → 클라이언트 모델. password_hash 는 절대 노출하지 않는다. team_name 은 JOIN 된 경우만.
function rowToUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name || '',
    team_id: Number(row.team_id),
    team_name: row.team_name == null ? null : row.team_name,
    role: row.role || 'member',
  };
}

function signToken(user) {
  return jwt.sign(
    { userId: Number(user.id), teamId: Number(user.team_id) },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '30d' }
  );
}

// 인증 게이트: /api/* 전부 보호(login/signup 만 예외). originalUrl 로 판별(마운트 경로 영향 없음).
app.use('/api', (req, res, next) => {
  const pathOnly = (req.originalUrl || '').split('?')[0];
  if (req.method === 'POST' && (pathOnly === '/api/auth/login' || pathOnly === '/api/auth/signup')) {
    return next(); // 비보호 (로그인/회원가입)
  }
  // (v17) 공유 열람(외부 고객용)은 무인증 공개 — 정확히 /api/share/* 경로만 예외. 다른 /api/* 는 그대로 401.
  if (pathOnly === '/api/share' || pathOnly.startsWith('/api/share/')) {
    return next();
  }
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: '인증이 필요합니다' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    req.teamId = payload.teamId;
    return next();
  } catch (_) {
    return res.status(401).json({ error: '인증이 필요합니다' });
  }
});

// 현장 소유 검증: /api/sites/:id 및 모든 /api/sites/:id/* 일괄 보호.
//   id 형식 오류는 통과(각 핸들러가 기존 400 반환 → 동작 보존). 미존재/타팀 → 404.
app.use('/api/sites/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next();
  try {
    const r = await pool.query('SELECT 1 FROM interior_sites WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    return next();
  } catch (err) {
    return next(err);
  }
});

// 자식(by id) 소유 검증 팩토리: child → site 조인으로 팀 일치 확인. 미존재/타팀 → 404.
//   /api/<resource>/:id 와 그 하위(예: /schedule/:id/deps)까지 한 번에 보호.
function requireChildOwned(table, label) {
  return async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return next(); // 형식 오류 → 핸들러가 기존 400/404 처리
    try {
      const r = await pool.query(
        `SELECT 1 FROM ${table} t JOIN interior_sites s ON s.id = t.site_id WHERE t.id=$1 AND s.team_id=$2`,
        [id, req.teamId]
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ success: false, message: `해당 ${label}을(를) 찾을 수 없습니다.` });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
app.use('/api/costs/:id', requireChildOwned('interior_costs', '비용 내역'));
app.use('/api/schedule/:id', requireChildOwned('interior_schedule', '일정'));
app.use('/api/estimates/:id', requireChildOwned('interior_estimates', '견적서'));
app.use('/api/orders/:id', requireChildOwned('interior_orders', '발주서'));
app.use('/api/meetings/:id', requireChildOwned('interior_meetings', '미팅'));
app.use('/api/as/:id', requireChildOwned('interior_as', 'A/S'));
app.use('/api/takeoff/:id', requireChildOwned('interior_takeoff', '물량'));
app.use('/api/documents/:id', requireChildOwned('interior_documents', '자료')); // (v20)
app.use('/api/photos/:id', requireChildOwned('interior_photos', '현장사진')); // (v20)
app.use('/api/site-staff/:id', requireChildOwned('interior_site_staff', '인력배정')); // (v21) 배정 by-id → site 조인 팀검증

// (v21) 관리자 가드: users.role='admin' 만 통과, 그 외 403. req.role 세팅.
//   JWT 에는 role 이 없으므로(재로그인 없이 승격 반영 위해) 매 요청 DB 조회. 인증(req.userId) 이후에만 사용.
async function requireAdmin(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT role FROM interior_users WHERE id=$1', [req.userId]);
    const role = rows.length ? (rows[0].role || 'member') : 'member';
    req.role = role;
    if (role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다' });
    return next();
  } catch (err) {
    return next(err);
  }
}

// ----------------------------------------
// 인증 라우트 (signup/login 은 비보호, me 는 보호)
// ----------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const b = req.body || {};
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const inviteCode = typeof b.invite_code === 'string' ? b.invite_code.trim() : '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: '올바른 이메일을 입력해 주세요.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: '비밀번호는 6자 이상이어야 합니다.' });
    }

    // 초대코드 → 팀 조회 (없으면 400)
    const teamQ = await pool.query('SELECT id, name FROM interior_teams WHERE invite_code=$1', [inviteCode]);
    if (teamQ.rows.length === 0) {
      return res.status(400).json({ success: false, message: '초대코드가 올바르지 않습니다.' });
    }
    const team = teamQ.rows[0];

    // 이메일 중복 사전 체크(409) + INSERT UNIQUE 위반도 409 로 동일 처리(경합 방어)
    const dup = await pool.query('SELECT 1 FROM interior_users WHERE email=$1', [email]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ success: false, message: '이미 가입된 이메일입니다.' });
    }

    const hash = await bcrypt.hash(password, 10);
    // (v21) 첫 가입자 = 관리자: 그 팀 유저 수가 0이면 admin, 아니면 member.
    const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM interior_users WHERE team_id=$1', [team.id]);
    const role = cnt.rows[0].n === 0 ? 'admin' : 'member';
    const { rows } = await pool.query(
      `INSERT INTO interior_users (email, password_hash, name, team_id, role)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, email, name, team_id, role`,
      [email, hash, name, team.id, role]
    );
    const userRow = { ...rows[0], team_name: team.name };
    const token = signToken(userRow);
    res.status(201).json({ token, user: rowToUser(userRow) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: '이미 가입된 이메일입니다.' });
    }
    console.error('POST /api/auth/signup 오류:', err.message);
    res.status(500).json({ success: false, message: '회원가입에 실패했습니다.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const b = req.body || {};
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.name, u.team_id, u.role, t.name AS team_name
         FROM interior_users u JOIN interior_teams t ON t.id = u.team_id
        WHERE u.email=$1`,
      [email]
    );
    const row = rows[0];
    // 이메일 존재 여부를 노출하지 않도록 동일한 401 메시지
    const match = row ? await bcrypt.compare(password, row.password_hash) : false;
    if (!row || !match) {
      return res.status(401).json({ success: false, message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }
    const token = signToken(row);
    res.json({ token, user: rowToUser(row) });
  } catch (err) {
    console.error('POST /api/auth/login 오류:', err.message);
    res.status(500).json({ success: false, message: '로그인에 실패했습니다.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.team_id, u.role, t.name AS team_name
         FROM interior_users u JOIN interior_teams t ON t.id = u.team_id
        WHERE u.id=$1`,
      [req.userId]
    );
    if (rows.length === 0) return res.status(401).json({ error: '인증이 필요합니다' });
    res.json({ user: rowToUser(rows[0]) });
  } catch (err) {
    console.error('GET /api/auth/me 오류:', err.message);
    res.status(500).json({ success: false, message: '사용자 정보를 불러오지 못했습니다.' });
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

  // (v23.1) mkdir 은 best-effort — Vercel 등 서버리스는 read-only FS 라 항상 실패했고,
  // 그 throw 가 현장 생성 자체를 400 으로 죽이던 프로덕션 버그. 폴더는 로컬 실행 전용 편의 기능
  // (파일 실체는 v20부터 Supabase Storage). 경로탈출 검증(위)은 유지.
  try {
    fs.mkdirSync(path.join(siteAbs, 'receipts'), { recursive: true });
  } catch (e) {
    console.warn('⚠️  현장 폴더 생성 실패(무시 — 서버리스/권한):', e.message);
  }
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
    // (v5) 고객/리드 연결. id 는 다른 id 들과 동일하게 문자열, client_name 은 JOIN 된 경우만(아니면 null).
    client_id: row.client_id == null ? null : String(row.client_id),
    client_name: row.client_name == null ? null : row.client_name,
    // (v6) 보관(아카이브) 여부 — 진행중/완료·보관 분리. 누락 시 false.
    archived: row.archived == null ? false : !!row.archived,
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
    has_invoice: row.has_invoice == null ? false : !!row.has_invoice, // (v12) 세금계산서 발행 여부
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
    // (v21) 직원마스터 확장: 직급/고용형태/이메일/입사일.
    grade: row.grade || '',
    employment_type: row.employment_type || '',
    email: row.email || '',
    hire_date: row.hire_date, // 'YYYY-MM-DD' | null (to_char 직렬화)
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v21) 프로젝트 인력배정 행(interior_site_staff JOIN interior_staff) → 클라이언트 모델.
function rowToSiteStaff(row) {
  return {
    id: Number(row.id),
    site_id: Number(row.site_id),
    staff_id: Number(row.staff_id),
    role_in_project: row.role_in_project || '',
    created_at: new Date(row.created_at).toISOString(),
    // JOIN 된 직원 정보(있을 때만)
    staff_name: row.staff_name || '',
    staff_role: row.staff_role || '',
    staff_grade: row.staff_grade || '',
    staff_employment_type: row.staff_employment_type || '',
    staff_phone: row.staff_phone || '',
    staff_active: row.staff_active,
  };
}

function rowToVendor(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind || '',
    phone: row.phone || '',
    memo: row.memo || '',
    trade: row.trade || '', // (v9) 공정
    grade: row.grade || '', // (v9) 기술력/등급
    skilled_rate: Number(row.skilled_rate) || 0, // (v26) 기공 일당(원)
    helper_rate: Number(row.helper_rate) || 0,   // (v26) 조공 일당(원)
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
    vendor: row.vendor || '', // (v14) 협력업체(거래처명) — 자유입력/마스터 매칭
    color: row.color || '',
    memo: row.memo || '',
    sort_order: Number(row.sort_order || 0),
    kind: SCHEDULE_KINDS.includes(row.kind) ? row.kind : '공사', // (v19) 공사/지원/미팅
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
    // (v18) 견적 버전 (컬럼 미선택 시에도 안전하게 1 폴백)
    version: row.version == null ? 1 : Number(row.version),
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

// (v18) 견적 템플릿 row → 클라이언트 모델. config=객체, items=배열(node-pg 가 jsonb 를 파싱해 반환).
function rowToTemplate(row) {
  return {
    id: row.id,
    team_id: row.team_id == null ? null : Number(row.team_id),
    name: row.name,
    description: row.description || '',
    config: row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {},
    items: Array.isArray(row.items) ? row.items : [],
    created_at: new Date(row.created_at).toISOString(),
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
    source: row.source || 'manual', // (v9) 단가 출처
    price_date: row.price_date || null, // (v9) 단가 기준일 (to_char 'YYYY-MM-DD' 또는 null)
    active: row.active,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v5) 고객/리드 row → 클라이언트 모델
function rowToClient(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || '',
    email: row.email || '',
    source: row.source || '',
    status: row.status || '리드',
    address: row.address || '',
    memo: row.memo || '',
    active: row.active,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v5) 발주서 row → 클라이언트 모델 (amount BIGINT → Number, DATE 는 to_char 텍스트)
function rowToOrder(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    order_no: row.order_no || '',
    vendor: row.vendor || '',
    trade: row.trade || '',
    title: row.title,
    amount: Number(row.amount),
    order_date: row.order_date, // 'YYYY-MM-DD' | null
    due_date: row.due_date, // 'YYYY-MM-DD' | null
    status: row.status || '대기',
    memo: row.memo || '',
    need_date: row.need_date, // (v10) 필요시기 'YYYY-MM-DD' | null
    auto_generated: row.auto_generated === true, // (v10) 자동생성 초안 여부
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v5) 미팅 row → 클라이언트 모델
function rowToMeeting(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    schedule_id: row.schedule_id == null ? null : Number(row.schedule_id), // (v19) 연동 일정 링크(수동=null)
    meeting_date: row.meeting_date, // 'YYYY-MM-DD' | null
    title: row.title,
    attendees: row.attendees || '',
    content: row.content || '',
    next_action: row.next_action || '',
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v5) AS row → 클라이언트 모델 (cost BIGINT → Number)
function rowToAS(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    received_date: row.received_date, // 'YYYY-MM-DD' | null
    title: row.title,
    detail: row.detail || '',
    status: row.status || '접수',
    handled_date: row.handled_date, // 'YYYY-MM-DD' | null
    staff: row.staff || '',
    cost: Number(row.cost),
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v20) 자료 row → 클라이언트 모델 (file_size BIGINT → Number, id/site_id 는 앱 규약대로 원본 유지)
function rowToDocument(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    name: row.name,
    doc_type: row.doc_type || '기타',
    storage_path: row.storage_path || '',
    file_name: row.file_name || '',
    file_size: Number(row.file_size || 0),
    uploader: row.uploader || '',
    memo: row.memo || '',
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v20) 현장사진 row → 클라이언트 모델
function rowToPhoto(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    photo_date: row.photo_date, // 'YYYY-MM-DD' | null (to_char 직렬화)
    processes: row.processes || '', // 콤마문자열(다중 공정)
    storage_path: row.storage_path || '',
    file_name: row.file_name || '',
    uploader: row.uploader || '',
    memo: row.memo || '',
    created_at: new Date(row.created_at).toISOString(),
  };
}

// (v20) 오늘 날짜(KST 기준 YYYY-MM-DD) — 현장사진 photo_date 기본값.
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// (v20) 현재 로그인 사용자 표시명(uploader 기본값). name 우선, 없으면 email, 실패 시 ''.
async function currentUserName(req) {
  try {
    const { rows } = await pool.query('SELECT name, email FROM interior_users WHERE id=$1', [req.userId]);
    if (rows.length === 0) return '';
    return (rows[0].name && rows[0].name.trim()) || rows[0].email || '';
  } catch (_) {
    return '';
  }
}

// ----------------------------------------
// SELECT 컬럼 목록 (DATE 는 to_char 직렬화)
// ----------------------------------------
const SITE_COLS =
  "id, name, client, address, manager, budget, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, folder, status, tags, " +
  "building_type, floor_area, to_char(move_in_date,'YYYY-MM-DD') AS move_in_date, pm, construction_manager, designer, progress_status, client_id, archived, created_at";
const COST_COLS =
  "id, site_id, to_char(date,'YYYY-MM-DD') AS date, amount, category, process, manager, vendor, memo, schedule_id, has_invoice, created_at";
const STAFF_COLS = "id, name, role, phone, active, grade, employment_type, email, to_char(hire_date,'YYYY-MM-DD') AS hire_date, created_at"; // (v21) 직원마스터 확장
const VENDOR_COLS = 'id, name, kind, phone, memo, trade, grade, skilled_rate, helper_rate, active, created_at';
const CATEGORY_COLS = 'id, kind, name, sort_order, active';
const ESTIMATE_COLS =
  "id, site_id, title, client_name, client_contact, to_char(estimate_date,'YYYY-MM-DD') AS estimate_date, to_char(valid_until,'YYYY-MM-DD') AS valid_until, vat_mode, vat_rate, discount, status, memo, created_at, " +
  'use_cost_buildup, indirect_material_rate, indirect_labor_rate, safety_insurance_rate, employment_insurance_rate, ' +
  'safety_mgmt_rate, other_expense_rate, admin_rate, design_rate, profit_rate, round_unit, ' +
  'version'; // (v18) 견적 버전
const ITEM_COLS =
  'id, estimate_id, trade, process, name, spec, qty, unit, material_price, labor_price, sub_price, unit_price, amount, catalog_id, memo, sort_order';
// (v3) 카탈로그 컬럼 (가격은 rowToCatalog 에서 Number 변환). (v9) source/price_date 확장.
const CATALOG_COLS =
  "id, trade, grp, name, unit, material_price, labor_price, sub_price, product_name, vendor, code, source, to_char(price_date,'YYYY-MM-DD') AS price_date, active, created_at";
// (v5) 노션 서브-DB 컬럼 (DATE 는 to_char 직렬화, BIGINT 금액은 rowTo* 에서 Number)
const CLIENT_COLS = 'id, name, phone, email, source, status, address, memo, active, created_at';
const ORDER_COLS =
  "id, site_id, order_no, vendor, trade, title, amount, to_char(order_date,'YYYY-MM-DD') AS order_date, to_char(due_date,'YYYY-MM-DD') AS due_date, status, memo, " +
  "to_char(need_date,'YYYY-MM-DD') AS need_date, auto_generated, created_at"; // (v10) need_date/auto_generated 확장
const MEETING_COLS =
  "id, site_id, schedule_id, to_char(meeting_date,'YYYY-MM-DD') AS meeting_date, title, attendees, content, next_action, created_at";
const AS_COLS =
  "id, site_id, to_char(received_date,'YYYY-MM-DD') AS received_date, title, detail, status, to_char(handled_date,'YYYY-MM-DD') AS handled_date, staff, cost, created_at";
// (v18) 견적 템플릿 컬럼. config/items 는 JSONB → node-pg 가 JS 객체/배열로 반환.
const TEMPLATE_COLS = 'id, team_id, name, description, config, items, created_at';
// (v20) 자료/현장사진 컬럼 (DATE 는 to_char, file_size BIGINT 는 rowTo* 에서 Number)
const DOCUMENT_COLS =
  'id, site_id, name, doc_type, storage_path, file_name, file_size, uploader, memo, created_at';
const PHOTO_COLS =
  "id, site_id, to_char(photo_date,'YYYY-MM-DD') AS photo_date, processes, storage_path, file_name, uploader, memo, created_at";

// 일정 SELECT (alias s) — actual_cost = 연결 비용 합계 서브쿼리
const SCHEDULE_SELECT_COLS = `
  s.id, s.site_id, s.title, s.process,
  to_char(s.start_date,'YYYY-MM-DD') AS start_date,
  to_char(s.end_date,'YYYY-MM-DD')   AS end_date,
  s.status, s.planned_cost, s.staff, s.vendor, s.color, s.memo, s.sort_order, s.kind, s.created_at,
  (SELECT COALESCE(SUM(c.amount),0)::bigint FROM interior_costs c WHERE c.schedule_id = s.id) AS actual_cost
`;
// 일정 INSERT/UPDATE RETURNING — 동일하지만 테이블명(interior_schedule)으로 상관 서브쿼리 참조
const SCHEDULE_RETURNING_COLS = `
  id, site_id, title, process,
  to_char(start_date,'YYYY-MM-DD') AS start_date,
  to_char(end_date,'YYYY-MM-DD')   AS end_date,
  status, planned_cost, staff, vendor, color, memo, sort_order, kind, created_at,
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

// (v18) 복제 시 title 자동 버전 표기: 끝의 '(-| )vN' 을 새 버전으로 치환, 없으면 ' vN' 부가.
//   구분자(대시/공백)는 원본을 보존. body.title 이 있으면 이 함수는 호출되지 않는다.
function nextVersionTitle(origTitle, newVersion) {
  const base = String(origTitle == null || origTitle === '' ? '견적서' : origTitle);
  const m = base.match(/^(.*?)([-\s])v(\d+)$/i);
  if (m) return `${m[1]}${m[2]}v${newVersion}`;
  return `${base} v${newVersion}`;
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

// (v6 / 6-4) 'YYYY-MM-DD' 두 날짜의 일수 차 (a - b). UTC 자정 기준이라 DST/타임존 영향 없음.
//   연쇄이동 delta = dayDiff(새 start_date, 기존 start_date). 음수(앞당김)/0/양수 모두 가능.
function dayDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  const ta = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const tb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((ta - tb) / 86400000);
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

  // (v5) 고객/리드 연결(client_id). 본문에 키가 있을 때만 반영 → PUT 미전달 시 기존값 보존.
  //   양의 정수 → 문자열 / null·'' → 연결 해제(null) / 키 없음 → undefined(보존, provided=false).
  let client_id; // undefined = 본문 미전달
  let client_id_provided = false;
  if (Object.prototype.hasOwnProperty.call(b, 'client_id')) {
    client_id_provided = true;
    const raw = b.client_id;
    if (raw === null || raw === '' || raw === undefined) {
      client_id = null;
    } else if (/^\d+$/.test(String(raw))) {
      client_id = String(raw);
    } else {
      return { valid: false, message: 'client_id 는 양의 정수이거나 null 이어야 합니다.' };
    }
  }

  // (v6) 보관(archived): 본문에 키가 있을 때만 반영 → PUT 미전달 시 기존값 보존, POST 미전달 시 false.
  let archived; // undefined = 본문 미전달
  let archived_provided = false;
  if (Object.prototype.hasOwnProperty.call(b, 'archived')) {
    archived_provided = true;
    archived = parseBool(b.archived, false);
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
      // (v5) 고객/리드 연결 (undefined=미전달 → PUT 보존, null=해제, '문자열'=연결)
      client_id,
      client_id_provided,
      // (v6) 보관 여부 (undefined=미전달 → PUT 보존 / POST false)
      archived,
      archived_provided,
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

  // (v12) 계산서(세금계산서) 유무: 본문에 키가 있을 때만 반영 → PUT 미전달 시 기존값 보존, POST 미전달 시 false.
  let has_invoice; // undefined = 본문 미전달
  let has_invoice_provided = false;
  if (Object.prototype.hasOwnProperty.call(b, 'has_invoice')) {
    has_invoice_provided = true;
    has_invoice = parseBool(b.has_invoice, false);
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
      has_invoice,
      has_invoice_provided,
    },
  };
}

function validateStaff(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: 'name(담당자명) 은 필수입니다.' };
  // (v21) 입사일(hire_date): '' 또는 미전달 → null, 그 외엔 유효한 YYYY-MM-DD 만 허용(그 외 400).
  let hire_date = null;
  if (b.hire_date !== undefined && b.hire_date !== null && String(b.hire_date).trim() !== '') {
    const hd = String(b.hire_date).trim();
    if (!isRealDate(hd)) return { valid: false, message: 'hire_date(입사일) 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
    hire_date = hd;
  }
  return {
    valid: true,
    values: {
      name,
      role: typeof b.role === 'string' ? b.role.trim() : '',
      phone: typeof b.phone === 'string' ? b.phone.trim() : '',
      active: parseBool(b.active, true),
      // (v21) 직원마스터 확장 필드
      grade: typeof b.grade === 'string' ? b.grade.trim() : '',
      employment_type: typeof b.employment_type === 'string' ? b.employment_type.trim() : '',
      email: typeof b.email === 'string' ? b.email.trim() : '',
      hire_date,
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
      // (v9) trade(공정)/grade(기술력). PUT 에서 미전달 시 기존값 보존(provided-flag).
      trade: typeof b.trade === 'string' ? b.trade.trim() : '',
      grade: typeof b.grade === 'string' ? b.grade.trim() : '',
      tradeProvided: b.trade !== undefined,
      gradeProvided: b.grade !== undefined,
      // (v26) 기공/조공 일당 — 음수/비숫자는 0. PUT 미전달 시 기존값 보존.
      skilledRate: Math.max(0, Math.round(Number(b.skilled_rate) || 0)),
      helperRate: Math.max(0, Math.round(Number(b.helper_rate) || 0)),
      skilledRateProvided: b.skilled_rate !== undefined,
      helperRateProvided: b.helper_rate !== undefined,
      active: parseBool(b.active, true),
    },
  };
}

// (v5) 고객/리드 검증. name 필수, status 는 CLIENT_STATES 외 값이면 '리드'로 보정.
function validateClient(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: 'name(고객/리드명) 은 필수입니다.' };

  let status = '리드';
  if (typeof b.status === 'string' && b.status.trim()) {
    const s = b.status.trim();
    status = CLIENT_STATES.includes(s) ? s : '리드';
  }

  return {
    valid: true,
    values: {
      name,
      phone: typeof b.phone === 'string' ? b.phone.trim() : '',
      email: typeof b.email === 'string' ? b.email.trim() : '',
      source: typeof b.source === 'string' ? b.source.trim() : '',
      status,
      address: typeof b.address === 'string' ? b.address.trim() : '',
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
      active: parseBool(b.active, true),
    },
  };
}

// (v5) 발주서 검증. title 필수, amount 0 이상 정수, status 는 ORDER_STATES 외 값이면 '대기' 보정.
//   order_no 는 선택(미전달 시 라우트에서 'PO-'+id 자동 세팅).
function validateOrder(body) {
  const b = body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) return { valid: false, message: 'title(발주 품목/내역) 은 필수입니다.' };

  let amount = 0;
  if (b.amount !== undefined && b.amount !== null && b.amount !== '') {
    amount = Number(b.amount);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      return { valid: false, message: 'amount(발주 금액) 은 0 이상의 정수(원)여야 합니다.' };
    }
  }

  const order_date = typeof b.order_date === 'string' && b.order_date.trim() ? b.order_date.trim() : null;
  if (order_date && !isRealDate(order_date)) {
    return { valid: false, message: 'order_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }
  const due_date = typeof b.due_date === 'string' && b.due_date.trim() ? b.due_date.trim() : null;
  if (due_date && !isRealDate(due_date)) {
    return { valid: false, message: 'due_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }

  let status = '대기';
  if (typeof b.status === 'string' && b.status.trim()) {
    const s = b.status.trim();
    status = ORDER_STATES.includes(s) ? s : '대기';
  }

  // (v10) 필요시기(need_date): 유효 날짜면 그 값, 아니면 null.
  //   POST=미설정(null), PUT=COALESCE 로 기존값 보존 → "미전달 보존".
  let need_date = null;
  if (typeof b.need_date === 'string' && b.need_date.trim()) {
    const nd = b.need_date.trim();
    if (!isRealDate(nd)) return { valid: false, message: 'need_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
    need_date = nd;
  }

  // (v10) auto_generated: 본문에 명시되면 boolean, 미전달이면 null(PUT=기존 보존 / POST=false 기본).
  let auto_generated = null;
  if (b.auto_generated !== undefined && b.auto_generated !== null) {
    auto_generated = parseBool(b.auto_generated, false);
  }

  return {
    valid: true,
    values: {
      order_no: typeof b.order_no === 'string' ? b.order_no.trim() : '',
      vendor: typeof b.vendor === 'string' ? b.vendor.trim() : '',
      trade: typeof b.trade === 'string' ? b.trade.trim() : '',
      title,
      amount,
      order_date,
      due_date,
      status,
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
      need_date, // (v10) 'YYYY-MM-DD' | null
      auto_generated, // (v10) boolean | null(미전달)
    },
  };
}

// (v5) 미팅 검증. title 필수, meeting_date 선택.
function validateMeeting(body) {
  const b = body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) return { valid: false, message: 'title(미팅 제목) 은 필수입니다.' };

  const meeting_date = typeof b.meeting_date === 'string' && b.meeting_date.trim() ? b.meeting_date.trim() : null;
  if (meeting_date && !isRealDate(meeting_date)) {
    return { valid: false, message: 'meeting_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }

  return {
    valid: true,
    values: {
      meeting_date,
      title,
      attendees: typeof b.attendees === 'string' ? b.attendees.trim() : '',
      content: typeof b.content === 'string' ? b.content.trim() : '',
      next_action: typeof b.next_action === 'string' ? b.next_action.trim() : '',
    },
  };
}

// (v5) AS 검증. title 필수, status 는 AS_STATES 외 값이면 '접수' 보정, cost 0 이상 정수.
function validateAS(body) {
  const b = body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) return { valid: false, message: 'title(AS 내용/제목) 은 필수입니다.' };

  const received_date = typeof b.received_date === 'string' && b.received_date.trim() ? b.received_date.trim() : null;
  if (received_date && !isRealDate(received_date)) {
    return { valid: false, message: 'received_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }
  const handled_date = typeof b.handled_date === 'string' && b.handled_date.trim() ? b.handled_date.trim() : null;
  if (handled_date && !isRealDate(handled_date)) {
    return { valid: false, message: 'handled_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
  }

  let status = '접수';
  if (typeof b.status === 'string' && b.status.trim()) {
    const s = b.status.trim();
    status = AS_STATES.includes(s) ? s : '접수';
  }

  let cost = 0;
  if (b.cost !== undefined && b.cost !== null && b.cost !== '') {
    cost = Number(b.cost);
    if (!Number.isFinite(cost) || !Number.isInteger(cost) || cost < 0) {
      return { valid: false, message: 'cost(AS 비용) 은 0 이상의 정수(원)여야 합니다.' };
    }
  }

  return {
    valid: true,
    values: {
      received_date,
      title,
      detail: typeof b.detail === 'string' ? b.detail.trim() : '',
      status,
      handled_date,
      staff: typeof b.staff === 'string' ? b.staff.trim() : '',
      cost,
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

  // (v14) 협력업체: 본문에 키가 있을 때만 반영 → PUT 미전달 시 기존값 보존, POST 미전달 시 ''.
  const vendor_provided = Object.prototype.hasOwnProperty.call(b, 'vendor');
  const vendor = typeof b.vendor === 'string' ? b.vendor.trim() : '';

  // (v19) 유형(kind): 공사/지원/미팅. 본문에 키가 있을 때만 반영(PUT 미전달 시 기존값 보존).
  //   목록 외 값은 '공사'로 보정(400 대신). POST 미전달 시 '공사'.
  const kind_provided = Object.prototype.hasOwnProperty.call(b, 'kind');
  let kind = '공사';
  if (kind_provided) {
    const k = typeof b.kind === 'string' ? b.kind.trim() : '';
    kind = SCHEDULE_KINDS.includes(k) ? k : '공사';
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
      vendor, // (v14) '' when absent (POST default); PUT uses vendor_provided for preserve
      vendor_provided,
      kind, // (v19) '공사' when absent (POST default); PUT uses kind_provided for preserve
      kind_provided,
      color: typeof b.color === 'string' ? b.color.trim() : '',
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
      sort_order,
    },
  };
}

// (v19) 일정 kind='미팅' ↔ interior_meetings 연동행 동기화(단방향, 일정→미팅).
//   client = 트랜잭션 내부 pg client. sched = rowToSchedule 결과({id,site_id,kind,title,start_date,staff,memo}).
//   - kind='미팅': 연동행 있으면 UPDATE(meeting_date/title/attendees/content 갱신, next_action 보존), 없으면 INSERT.
//   - kind≠'미팅': 이 일정에 연동된 미팅(schedule_id 매칭)이 있으면 DELETE(연동 해제).
//   팀 스코핑: 라우트에서 이미 sched(그 site)가 req.teamId 소유임을 검증 → site_id 그대로 사용해 안전.
async function syncScheduleMeeting(client, sched) {
  if (sched.kind === '미팅') {
    const upd = await client.query(
      `UPDATE interior_meetings
       SET meeting_date=$2, title=$3, attendees=$4, content=$5
       WHERE schedule_id=$1`,
      [sched.id, sched.start_date, sched.title, sched.staff || '', sched.memo || '']
    );
    if (upd.rowCount === 0) {
      await client.query(
        `INSERT INTO interior_meetings (site_id, schedule_id, meeting_date, title, attendees, content, next_action)
         VALUES ($1,$2,$3,$4,$5,$6,'')`,
        [sched.site_id, sched.id, sched.start_date, sched.title, sched.staff || '', sched.memo || '']
      );
    }
  } else {
    await client.query('DELETE FROM interior_meetings WHERE schedule_id=$1', [sched.id]);
  }
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

// (v18) 견적 템플릿 입력 검증. name 필수. config=객체(JSON), items=배열(각 원소 name 필수·빈 배열 허용).
function validateTemplate(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: '템플릿명(name) 은 필수입니다.' };
  if (name.length > 200) return { valid: false, message: '템플릿명은 200자 이하여야 합니다.' };
  const description = typeof b.description === 'string' ? b.description.trim() : '';

  // config: 객체만 허용(배열/원시 아님). 미전달·null → {}.
  let config = {};
  if (b.config !== undefined && b.config !== null) {
    if (typeof b.config !== 'object' || Array.isArray(b.config)) {
      return { valid: false, message: 'config 는 객체(JSON) 여야 합니다.' };
    }
    config = b.config;
  }

  // items: 배열. 각 원소는 객체 + name 필수(가벼운 검증). 미전달·null → [].
  let items = [];
  if (b.items !== undefined && b.items !== null) {
    if (!Array.isArray(b.items)) return { valid: false, message: 'items 는 배열이어야 합니다.' };
    for (let i = 0; i < b.items.length; i++) {
      const it = b.items[i];
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        return { valid: false, message: `items[${i}] 는 객체여야 합니다.` };
      }
      const nm = typeof it.name === 'string' ? it.name.trim() : '';
      if (!nm) return { valid: false, message: `items[${i}].name(품목) 은 필수입니다.` };
    }
    items = b.items;
  }

  return { valid: true, values: { name, description, config, items } };
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

  // (v9) price_date 유효성 (있으면 실제 달력 날짜여야 함)
  let price_date = null;
  if (b.price_date !== undefined && b.price_date !== null && b.price_date !== '') {
    const pd = String(b.price_date).trim();
    if (!isRealDate(pd)) {
      return { valid: false, message: 'price_date 는 유효한 YYYY-MM-DD 형식이어야 합니다.' };
    }
    price_date = pd;
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
      // (v9) source(단가 출처)/price_date(단가 기준일). PUT 에서 미전달 시 기존값 보존(provided-flag).
      source: typeof b.source === 'string' && b.source.trim() ? b.source.trim() : 'manual',
      price_date,
      sourceProvided: b.source !== undefined,
      priceDateProvided: b.price_date !== undefined,
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
app.get('/api/sites', async (req, res) => {
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
        interior_sites.progress_status, interior_sites.client_id, interior_sites.archived, interior_sites.created_at,
        cl.name AS client_name,
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
      LEFT JOIN interior_clients cl ON cl.id = interior_sites.client_id
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
      WHERE interior_sites.team_id = $1
      ORDER BY interior_sites.created_at DESC
    `, [req.teamId]);

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
          building_type, floor_area, move_in_date, pm, construction_manager, designer, progress_status, client_id, archived,
          team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING ${SITE_COLS}`,
      [
        v.name, v.client, v.address, v.manager, v.budget, v.start_date, v.end_date, folder, v.status, v.tags,
        v.building_type, v.floor_area, v.move_in_date, v.pm, v.construction_manager, v.designer, v.progress_status,
        v.client_id != null ? v.client_id : null, // (v5) 미전달/null → null
        v.archived_provided ? v.archived : false, // (v6) 미전달 → false
        req.teamId, // (v13) 소속 팀
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

    // 기본 SET 절(v1~v4 컬럼) — 전부 풀-리플레이스.
    const sets = [
      'name=$1', 'client=$2', 'address=$3', 'manager=$4', 'budget=$5', 'start_date=$6', 'end_date=$7', 'status=$8', 'tags=$9',
      'building_type=$10', 'floor_area=$11', 'move_in_date=$12', 'pm=$13', 'construction_manager=$14', 'designer=$15', 'progress_status=$16',
    ];
    const params = [
      v.name, v.client, v.address, v.manager, v.budget, v.start_date, v.end_date, v.status, v.tags,
      v.building_type, v.floor_area, v.move_in_date, v.pm, v.construction_manager, v.designer, v.progress_status,
    ];
    // (v5) client_id 는 본문에 키가 있을 때만 SET → 미전달 시 기존값 보존(null 이면 연결 해제).
    if (v.client_id_provided) {
      params.push(v.client_id != null ? v.client_id : null);
      sets.push(`client_id=$${params.length}`);
    }
    // (v6) archived 도 본문에 키가 있을 때만 SET → 미전달 시 기존값 보존.
    if (v.archived_provided) {
      params.push(v.archived);
      sets.push(`archived=$${params.length}`);
    }
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE interior_sites SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING ${SITE_COLS}`,
      params
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
      `INSERT INTO interior_costs (site_id, date, amount, category, process, manager, vendor, memo, schedule_id, has_invoice)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${COST_COLS}`,
      [id, v.date, v.amount, v.category, v.process, v.manager, v.vendor, v.memo, v.schedule_id,
       v.has_invoice_provided ? v.has_invoice : false]
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
       SET date=$1, amount=$2, category=$3, process=$4, manager=$5, vendor=$6, memo=$7, schedule_id=$8,
           has_invoice=COALESCE($9::boolean, has_invoice)
       WHERE id=$10
       RETURNING ${COST_COLS}`,
      [v.date, v.amount, v.category, v.process, v.manager, v.vendor, v.memo, v.schedule_id,
       v.has_invoice_provided ? v.has_invoice : null, id]
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
    const where = wantAll(req) ? 'WHERE team_id = $1' : 'WHERE team_id = $1 AND active = TRUE';
    const { rows } = await pool.query(`SELECT ${STAFF_COLS} FROM interior_staff ${where} ORDER BY active DESC, name ASC`, [req.teamId]);
    res.json(rows.map(rowToStaff));
  } catch (err) {
    console.error('GET /api/staff 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/staff', requireAdmin, async (req, res) => {
  try {
    const check = validateStaff(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `INSERT INTO interior_staff (name, role, phone, active, grade, employment_type, email, hire_date, team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${STAFF_COLS}`,
      [v.name, v.role, v.phone, v.active, v.grade, v.employment_type, v.email, v.hire_date, req.teamId]
    );
    res.status(201).json(rowToStaff(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 담당자명입니다.' });
    console.error('POST /api/staff 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자를 생성하지 못했습니다.' });
  }
});

app.put('/api/staff/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 담당자 id 형식입니다.' });
    const check = validateStaff(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_staff SET name=$1, role=$2, phone=$3, active=$4,
              grade=$5, employment_type=$6, email=$7, hire_date=$8
        WHERE id=$9 AND team_id=$10 RETURNING ${STAFF_COLS}`,
      [v.name, v.role, v.phone, v.active, v.grade, v.employment_type, v.email, v.hire_date, id, req.teamId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 담당자를 찾을 수 없습니다.' });
    res.json(rowToStaff(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 담당자명입니다.' });
    console.error('PUT /api/staff/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자를 수정하지 못했습니다.' });
  }
});

app.delete('/api/staff/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 담당자 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_staff WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 담당자를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/staff/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '담당자를 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 프로젝트 인력배정(interior_site_staff, v21/#5)
//   · GET    /api/sites/:id/staff   배정 목록(JOIN staff). 인증 사용자 누구나(팀 소유검증=/api/sites/:id 미들웨어).
//   · POST   /api/sites/:id/staff   배정(admin 전용). staff 같은 팀 검증, UNIQUE 중복 409/멱등.
//   · DELETE /api/site-staff/:id    해제(admin 전용). 소유검증=requireChildOwned('interior_site_staff').
// ========================================
const SITE_STAFF_COLS =
  'ss.id, ss.site_id, ss.staff_id, ss.role_in_project, ss.created_at, ' +
  'st.name AS staff_name, st.role AS staff_role, st.grade AS staff_grade, ' +
  'st.employment_type AS staff_employment_type, st.phone AS staff_phone, st.active AS staff_active';

app.get('/api/sites/:id/staff', async (req, res) => {
  try {
    const siteId = parseId(req.params.id);
    if (!siteId) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${SITE_STAFF_COLS}
         FROM interior_site_staff ss JOIN interior_staff st ON st.id = ss.staff_id
        WHERE ss.site_id=$1
        ORDER BY ss.created_at ASC, ss.id ASC`,
      [siteId]
    );
    res.json(rows.map(rowToSiteStaff));
  } catch (err) {
    console.error('GET /api/sites/:id/staff 오류:', err.message);
    res.status(500).json({ success: false, message: '배정 인력을 불러오지 못했습니다.' });
  }
});

app.post('/api/sites/:id/staff', requireAdmin, async (req, res) => {
  try {
    const siteId = parseId(req.params.id);
    if (!siteId) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const b = req.body || {};
    const staffId = parseId(b.staff_id);
    if (!staffId) return res.status(400).json({ success: false, message: 'staff_id(직원) 은 필수입니다.' });
    const roleInProject = typeof b.role_in_project === 'string' ? b.role_in_project.trim() : '';
    // staff 가 같은 팀 소속인지 검증(타팀 직원 배정 차단).
    const st = await pool.query('SELECT 1 FROM interior_staff WHERE id=$1 AND team_id=$2', [staffId, req.teamId]);
    if (st.rows.length === 0) return res.status(404).json({ success: false, message: '해당 직원을 찾을 수 없습니다.' });
    // UNIQUE(site_id, staff_id, role_in_project) 중복 → 멱등 409(중복 배정 방지).
    const ins = await pool.query(
      `INSERT INTO interior_site_staff (site_id, staff_id, role_in_project) VALUES ($1,$2,$3)
       ON CONFLICT (site_id, staff_id, role_in_project) DO NOTHING RETURNING id`,
      [siteId, staffId, roleInProject]
    );
    if (ins.rows.length === 0) return res.status(409).json({ success: false, message: '이미 배정된 직원입니다.' });
    const { rows } = await pool.query(
      `SELECT ${SITE_STAFF_COLS}
         FROM interior_site_staff ss JOIN interior_staff st ON st.id = ss.staff_id
        WHERE ss.id=$1`,
      [ins.rows[0].id]
    );
    res.status(201).json(rowToSiteStaff(rows[0]));
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ success: false, message: '현장 또는 직원을 찾을 수 없습니다.' });
    console.error('POST /api/sites/:id/staff 오류:', err.message);
    res.status(500).json({ success: false, message: '인력을 배정하지 못했습니다.' });
  }
});

app.delete('/api/site-staff/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 배정 id 형식입니다.' });
    // 소유검증은 requireChildOwned('interior_site_staff') 미들웨어가 이미 수행(타팀/미존재 → 404).
    const { rowCount } = await pool.query('DELETE FROM interior_site_staff WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 배정을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/site-staff/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '배정을 해제하지 못했습니다.' });
  }
});

// ========================================
// (v24) REST API — 카드 연동(CODEF): 계정/동기화/거래 스테이징/배분
//   팀 스코핑 = team_id 직접. 비밀번호는 어떤 경로로도 저장되지 않는다.
// ========================================
function rowToCardAccount(row) {
  return {
    id: String(row.id),
    organization: row.organization,
    organization_name: CARD_ORGS[row.organization] || row.organization,
    card_type: row.card_type,
    label: row.label || '',
    mock: String(row.connected_id || '').startsWith('mock-'),
    last_synced_at: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    active: row.active !== false,
    created_at: new Date(row.created_at).toISOString(),
  };
}
function rowToCardTxn(row) {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    account_label: row.account_label || '',
    approval_no: row.approval_no || '',
    used_at: new Date(row.used_at).toISOString(),
    merchant: row.merchant || '',
    merchant_biz_no: row.merchant_biz_no || '',
    merchant_type: row.merchant_type || '',
    amount: Number(row.amount),
    card_no: row.card_no || '',
    status: row.status || '승인',
    installment: row.installment || '',
    site_id: row.site_id == null ? null : String(row.site_id),
    site_name: row.site_name || null,
    cost_id: row.cost_id == null ? null : String(row.cost_id),
    excluded: !!row.excluded,
    // 가맹점 학습규칙 제안(있을 때만)
    suggested_site_id: row.sug_site_id == null ? null : String(row.sug_site_id),
    suggested_category: row.sug_category || null,
    suggested_process: row.sug_process || null,
    created_at: new Date(row.created_at).toISOString(),
  };
}
const yyyymmdd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
};

// GET /api/card/config — 연동 모드(프론트 뱃지/안내용)
app.get('/api/card/config', (req, res) => {
  res.json({ configured: codefConfigured(), mode: codefConfigured() ? 'live' : 'mock', host: CODEF_API_HOST });
});

// GET /api/card/accounts — 팀의 카드 계정 목록
app.get('/api/card/accounts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM interior_card_accounts WHERE team_id=$1 ORDER BY id ASC', [req.teamId]
    );
    res.json(rows.map(rowToCardAccount));
  } catch (err) {
    console.error('GET /api/card/accounts 오류:', err.message);
    res.status(500).json({ success: false, message: '카드 계정을 불러오지 못했습니다.' });
  }
});

// POST /api/card/accounts — 카드사 로그인 등록 → connectedId 보관(비번 비저장).
app.post('/api/card/accounts', async (req, res) => {
  try {
    const b = req.body || {};
    const organization = CARD_ORGS[String(b.organization || '').trim()] ? String(b.organization).trim() : '0301';
    const cardType = b.card_type === 'B' ? 'B' : 'P';
    const loginId = typeof b.login_id === 'string' ? b.login_id.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const label = (typeof b.label === 'string' && b.label.trim()) || `${CARD_ORGS[organization]} ${cardType === 'B' ? '법인' : '개인'}`;
    if (!loginId || !password) return res.status(400).json({ success: false, message: '카드사 아이디와 비밀번호를 입력하세요.' });

    let connectedId;
    if (codefConfigured()) {
      try {
        connectedId = await codefCreateAccount({ organization, clientType: cardType, loginId, password });
      } catch (e) {
        // CODEF 오류(로그인 실패/추가인증 등)는 메시지 그대로 안내
        return res.status(400).json({ success: false, message: e.message });
      }
    } else {
      connectedId = 'mock-' + crypto.randomBytes(12).toString('hex'); // 모의 모드
    }

    const { rows } = await pool.query(
      `INSERT INTO interior_card_accounts (team_id, organization, card_type, connected_id, label)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.teamId, organization, cardType, connectedId, label]
    );
    res.status(201).json(rowToCardAccount(rows[0]));
  } catch (err) {
    console.error('POST /api/card/accounts 오류:', err.message);
    res.status(500).json({ success: false, message: '카드 계정을 등록하지 못했습니다.' });
  }
});

// DELETE /api/card/accounts/:id — 연동 해제(CODEF 계정 삭제 best-effort + 행 삭제, txns CASCADE. 반영된 비용은 보존)
app.delete('/api/card/accounts/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 계정 id 형식입니다.' });
    const q = await pool.query('SELECT * FROM interior_card_accounts WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '해당 카드 계정을 찾을 수 없습니다.' });
    const acc = q.rows[0];
    if (codefConfigured() && !String(acc.connected_id).startsWith('mock-')) {
      try { await codefDeleteAccount({ connectedId: acc.connected_id, organization: acc.organization, clientType: acc.card_type }); }
      catch (e) { console.warn('⚠️  CODEF 계정 삭제 실패(무시):', e.message); }
    }
    await pool.query('DELETE FROM interior_card_accounts WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/card/accounts/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '카드 계정을 해제하지 못했습니다.' });
  }
});

// POST /api/card/accounts/:id/sync — 승인내역 동기화(기본: 마지막 동기화−3일 ~ 오늘, 최초 30일. UNIQUE 로 중복 차단)
app.post('/api/card/accounts/:id/sync', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 계정 id 형식입니다.' });
    const q = await pool.query('SELECT * FROM interior_card_accounts WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '해당 카드 계정을 찾을 수 없습니다.' });
    const acc = q.rows[0];

    const b = req.body || {};
    const today = new Date();
    let startDate;
    if (b.start_date && isRealDate(String(b.start_date))) startDate = String(b.start_date).replace(/-/g, '');
    else if (acc.last_synced_at) startDate = yyyymmdd(new Date(new Date(acc.last_synced_at).getTime() - 3 * 86400000));
    else startDate = yyyymmdd(new Date(today.getTime() - 30 * 86400000));
    const endDate = b.end_date && isRealDate(String(b.end_date)) ? String(b.end_date).replace(/-/g, '') : yyyymmdd(today);

    let approvals;
    if (String(acc.connected_id).startsWith('mock-')) {
      approvals = mockApprovals(startDate, endDate);
    } else if (codefConfigured()) {
      try {
        approvals = await codefApprovals({
          connectedId: acc.connected_id, organization: acc.organization, clientType: acc.card_type,
          startDate, endDate,
        });
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
    } else {
      return res.status(503).json({ error: 'CODEF 미설정 — 이 계정은 실연동 계정입니다. CODEF 키를 설정하세요.' });
    }

    let imported = 0, skipped = 0;
    for (const a of approvals) {
      const r = await pool.query(
        `INSERT INTO interior_card_txns
           (team_id, account_id, approval_no, used_at, merchant, merchant_biz_no, merchant_type, amount, card_no, status, installment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (account_id, approval_no, used_at) DO NOTHING RETURNING id`,
        [req.teamId, id, a.approval_no, a.used_at, a.merchant, a.merchant_biz_no, a.merchant_type,
         Math.round(a.amount), a.card_no, a.status, a.installment]
      );
      if (r.rows.length) imported++; else skipped++;
    }
    await pool.query('UPDATE interior_card_accounts SET last_synced_at=now() WHERE id=$1', [id]);
    res.json({ imported, skipped, total: approvals.length, from: startDate, to: endDate });
  } catch (err) {
    console.error('POST /api/card/accounts/:id/sync 오류:', err.message);
    res.status(500).json({ success: false, message: '카드 내역을 동기화하지 못했습니다.' });
  }
});

// GET /api/card/txns?view=unassigned|assigned|excluded|all — 거래 목록(+가맹점 규칙 제안/계정/현장 JOIN)
app.get('/api/card/txns', async (req, res) => {
  try {
    const view = ['unassigned', 'assigned', 'excluded', 'all'].includes(String(req.query.view)) ? String(req.query.view) : 'unassigned';
    let cond = '';
    if (view === 'unassigned') cond = 'AND t.cost_id IS NULL AND t.excluded = false';
    else if (view === 'assigned') cond = 'AND t.cost_id IS NOT NULL';
    else if (view === 'excluded') cond = 'AND t.excluded = true AND t.cost_id IS NULL';
    const { rows } = await pool.query(
      `SELECT t.*, a.label AS account_label, s.name AS site_name,
              r.site_id AS sug_site_id, r.category AS sug_category, r.process AS sug_process
         FROM interior_card_txns t
         JOIN interior_card_accounts a ON a.id = t.account_id
         LEFT JOIN interior_sites s ON s.id = t.site_id
         LEFT JOIN interior_merchant_rules r ON r.team_id = t.team_id AND r.merchant = t.merchant
        WHERE t.team_id=$1 ${cond}
        ORDER BY t.used_at DESC, t.id DESC
        LIMIT 500`,
      [req.teamId]
    );
    res.json(rows.map(rowToCardTxn));
  } catch (err) {
    console.error('GET /api/card/txns 오류:', err.message);
    res.status(500).json({ success: false, message: '카드 거래를 불러오지 못했습니다.' });
  }
});

// POST /api/card/txns/assign — 선택 거래를 현장 비용으로 반영(+선택 시 가맹점 규칙 학습). 트랜잭션.
app.post('/api/card/txns/assign', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(parseId).filter(Boolean) : [];
    const siteId = parseId(b.site_id);
    const category = (typeof b.category === 'string' && b.category.trim()) || '자재비';
    const processName = typeof b.process === 'string' ? b.process.trim() : '';
    const remember = !!b.remember;
    if (ids.length === 0) return res.status(400).json({ success: false, message: '배분할 거래를 선택하세요.' });
    if (!siteId) return res.status(400).json({ success: false, message: '현장을 선택하세요.' });

    const site = await client.query('SELECT id, name FROM interior_sites WHERE id=$1 AND team_id=$2', [siteId, req.teamId]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    await client.query('BEGIN');
    const txq = await client.query(
      `SELECT t.*, a.label AS account_label FROM interior_card_txns t
         JOIN interior_card_accounts a ON a.id = t.account_id
        WHERE t.id = ANY($1) AND t.team_id=$2 AND t.cost_id IS NULL AND t.excluded=false AND t.status='승인'
        FOR UPDATE`,
      [ids, req.teamId]
    );
    let assigned = 0;
    let lastMerchant = '';
    for (const t of txq.rows) {
      const dateStr = new Date(t.used_at).toISOString().slice(0, 10);
      const memo = `카드 ${t.account_label || ''}${t.approval_no ? ` · 승인 ${t.approval_no}` : ''}`.trim();
      const c = await client.query(
        `INSERT INTO interior_costs (site_id, date, amount, category, process, manager, vendor, memo, schedule_id, has_invoice)
         VALUES ($1,$2,$3,$4,$5,'',$6,$7,NULL,false) RETURNING id`,
        [siteId, dateStr, Number(t.amount), category, processName, t.merchant || '', memo]
      );
      await client.query('UPDATE interior_card_txns SET site_id=$1, cost_id=$2 WHERE id=$3', [siteId, c.rows[0].id, t.id]);
      assigned++;
      if (t.merchant) lastMerchant = t.merchant;
    }
    if (remember) {
      // 선택 거래들의 가맹점 전부 학습(같은 값으로) — 다음 동기화부터 제안 프리필
      const merchants = Array.from(new Set(txq.rows.map((t) => t.merchant).filter(Boolean)));
      for (const m of merchants) {
        await client.query(
          `INSERT INTO interior_merchant_rules (team_id, merchant, site_id, category, process)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (team_id, merchant) DO UPDATE SET site_id=$3, category=$4, process=$5`,
          [req.teamId, m, siteId, category, processName]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ assigned, requested: ids.length, skipped: ids.length - assigned, site_name: site.rows[0].name, remembered: remember });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/card/txns/assign 오류:', err.message);
    res.status(500).json({ success: false, message: '비용으로 반영하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// POST /api/card/txns/:id/unassign — 배분 해제(연결된 비용 삭제 + 링크 해제). 트랜잭션.
app.post('/api/card/txns/:id/unassign', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 거래 id 형식입니다.' });
    await client.query('BEGIN');
    const q = await client.query('SELECT * FROM interior_card_txns WHERE id=$1 AND team_id=$2 FOR UPDATE', [id, req.teamId]);
    if (q.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: '해당 거래를 찾을 수 없습니다.' }); }
    const t = q.rows[0];
    if (t.cost_id) await client.query('DELETE FROM interior_costs WHERE id=$1', [t.cost_id]);
    await client.query('UPDATE interior_card_txns SET site_id=NULL, cost_id=NULL WHERE id=$1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/card/txns/:id/unassign 오류:', err.message);
    res.status(500).json({ success: false, message: '배분을 해제하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// POST /api/card/txns/:id/exclude — 개인지출 등 제외/복원 토글
app.post('/api/card/txns/:id/exclude', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 거래 id 형식입니다.' });
    const excluded = parseBool((req.body || {}).excluded, true);
    const r = await pool.query(
      'UPDATE interior_card_txns SET excluded=$1 WHERE id=$2 AND team_id=$3 AND cost_id IS NULL RETURNING id',
      [excluded, id, req.teamId]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: '해당 거래를 찾을 수 없습니다. (배분된 거래는 먼저 해제하세요)' });
    res.json({ success: true, excluded });
  } catch (err) {
    console.error('POST /api/card/txns/:id/exclude 오류:', err.message);
    res.status(500).json({ success: false, message: '거래를 변경하지 못했습니다.' });
  }
});

// ========================================
// REST API — 거래처(interior_vendors)
// ========================================
app.get('/api/vendors', async (req, res) => {
  try {
    const where = wantAll(req) ? 'WHERE team_id = $1' : 'WHERE team_id = $1 AND active = TRUE';
    const { rows } = await pool.query(`SELECT ${VENDOR_COLS} FROM interior_vendors ${where} ORDER BY active DESC, name ASC`, [req.teamId]);
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
      `INSERT INTO interior_vendors (name, kind, phone, memo, trade, grade, skilled_rate, helper_rate, active, team_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${VENDOR_COLS}`,
      [v.name, v.kind, v.phone, v.memo, v.trade, v.grade, v.skilledRate, v.helperRate, v.active, req.teamId]
    );
    res.status(201).json(rowToVendor(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: '이미 존재하는 거래처명입니다.' });
    console.error('POST /api/vendors 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처를 생성하지 못했습니다.' });
  }
});

// (v9) POST /api/vendors/import — 노션 협력업체 일괄 import (name 기준 upsert).
//   body { items:[{name, kind?, phone?, trade?, grade?, memo?}] }
//   name 있으면 update / 없으면 insert / name 빈 항목 skip → { imported(신규), updated(갱신), total }.
//   미전달 필드는 update 시 기존값 보존(provided-flag → COALESCE), insert 시 '' 기본.
//   POST 메서드 + 리터럴 '/import' 라 PUT/DELETE :id 와 충돌 없음. 트랜잭션으로 일괄 처리.
app.post('/api/vendors/import', async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let imported = 0;
    let updated = 0;
    for (const raw of items) {
      const it = raw || {};
      const name = typeof it.name === 'string' ? it.name.trim() : '';
      if (!name) continue; // name 빈 항목 skip

      // 미전달(undefined) → null(보존), 전달 → trim 값. (insert 시 null 은 '' 로 대체)
      const norm = (key) => (it[key] !== undefined ? (typeof it[key] === 'string' ? it[key].trim() : String(it[key])) : null);
      const kind = norm('kind');
      const phone = norm('phone');
      const trade = norm('trade');
      const grade = norm('grade');
      const memo = norm('memo');

      const existing = await client.query('SELECT id FROM interior_vendors WHERE name=$1 AND team_id=$2', [name, req.teamId]);
      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE interior_vendors
             SET kind=COALESCE($1,kind), phone=COALESCE($2,phone), trade=COALESCE($3,trade),
                 grade=COALESCE($4,grade), memo=COALESCE($5,memo)
           WHERE name=$6 AND team_id=$7`,
          [kind, phone, trade, grade, memo, name, req.teamId]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO interior_vendors (name, kind, phone, trade, grade, memo, team_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [name, kind || '', phone || '', trade || '', grade || '', memo || '', req.teamId]
        );
        imported++;
      }
    }
    await client.query('COMMIT');
    res.json({ imported, updated, total: imported + updated });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* noop */
    }
    console.error('POST /api/vendors/import 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처 import 에 실패했습니다.' });
  } finally {
    client.release();
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
      `UPDATE interior_vendors SET name=$1, kind=$2, phone=$3, memo=$4, active=$5,
              trade=COALESCE($6, trade), grade=COALESCE($7, grade),
              skilled_rate=COALESCE($8, skilled_rate), helper_rate=COALESCE($9, helper_rate)
       WHERE id=$10 AND team_id=$11 RETURNING ${VENDOR_COLS}`,
      [v.name, v.kind, v.phone, v.memo, v.active, v.tradeProvided ? v.trade : null, v.gradeProvided ? v.grade : null,
       v.skilledRateProvided ? v.skilledRate : null, v.helperRateProvided ? v.helperRate : null, id, req.teamId]
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
    const { rowCount } = await pool.query('DELETE FROM interior_vendors WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 거래처를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/vendors/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처를 삭제하지 못했습니다.' });
  }
});

// (v14) GET /api/vendors/:id/usage — 거래처 사용내역(어느 현장에서 얼마 썼는지). 팀 스코핑.
//   거래처(이름) 기준으로 interior_costs / interior_orders / interior_schedule 를 현장별로 집계.
//   - costs/orders = 금액 합계, schedule = 계획비용 합계. 전부 팀 소속 현장(JOIN interior_sites)만.
//   - bySite = 세 소스 site 합집합(각 0 기본), lastDate = 해당 현장 그 vendor costs 최근일 or null.
//   라우트 충돌 없음: GET .../:id/usage 는 PUT/DELETE /api/vendors/:id(메서드·세그먼트 상이)와 구분.
app.get('/api/vendors/:id/usage', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 거래처 id 형식입니다.' });

    // 1) 거래처가 이 팀 소속인지 확인 (아니면 404). 이 거래처의 name 으로 사용내역을 집계.
    const vq = await pool.query(
      `SELECT id, name, kind, phone, trade, grade, memo, skilled_rate, helper_rate FROM interior_vendors WHERE id=$1 AND team_id=$2`,
      [id, req.teamId]
    );
    if (vq.rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 거래처를 찾을 수 없습니다.' });
    }
    const vendorRow = vq.rows[0];
    const name = vendorRow.name;

    // 2) 세 소스 현장별 집계 — 전부 팀 소속 현장(s.team_id)만, vendor 이름 일치. 정수원(BIGINT).
    const costsQ = await pool.query(
      `SELECT c.site_id,
              COALESCE(SUM(c.amount),0)::bigint  AS total,
              to_char(MAX(c.date),'YYYY-MM-DD')  AS last_date
         FROM interior_costs c
         JOIN interior_sites s ON s.id = c.site_id
        WHERE s.team_id=$1 AND c.vendor=$2
        GROUP BY c.site_id`,
      [req.teamId, name]
    );
    const ordersQ = await pool.query(
      `SELECT o.site_id, COALESCE(SUM(o.amount),0)::bigint AS total
         FROM interior_orders o
         JOIN interior_sites s ON s.id = o.site_id
        WHERE s.team_id=$1 AND o.vendor=$2
        GROUP BY o.site_id`,
      [req.teamId, name]
    );
    const planQ = await pool.query(
      `SELECT sc.site_id, COALESCE(SUM(sc.planned_cost),0)::bigint AS total
         FROM interior_schedule sc
         JOIN interior_sites s ON s.id = sc.site_id
        WHERE s.team_id=$1 AND sc.vendor=$2
        GROUP BY sc.site_id`,
      [req.teamId, name]
    );
    // (v26) 출력인원(시공팀=이 거래처) — 현장별 출력일수/기공/조공/인건비(행 스냅샷 단가)
    const laborQ = await pool.query(
      `SELECT l.site_id, COUNT(DISTINCT l.work_date)::int AS days,
              COALESCE(SUM(l.skilled),0)::int AS skilled, COALESCE(SUM(l.helper),0)::int AS helper,
              COALESCE(SUM(l.skilled*l.skilled_rate + l.helper*l.helper_rate),0)::bigint AS total,
              to_char(MAX(l.work_date),'YYYY-MM-DD') AS last_date
         FROM interior_labor_logs l
         JOIN interior_sites s ON s.id = l.site_id
        WHERE s.team_id=$1 AND l.vendor_id=$2
        GROUP BY l.site_id`,
      [req.teamId, id]
    );

    // 3) 세 소스 site 합집합 → bySite (각 0 기본). lastDate 는 costs 에서만 채움.
    const map = new Map(); // site_id(string) → 누적 객체
    const ensure = (sid) => {
      const key = String(sid);
      if (!map.has(key)) {
        map.set(key, { site_id: key, site_name: '', costTotal: 0, orderTotal: 0, plannedTotal: 0, laborTotal: 0, laborDays: 0, laborSkilled: 0, laborHelper: 0, lastDate: null });
      }
      return map.get(key);
    };
    for (const r of costsQ.rows) {
      const e = ensure(r.site_id);
      e.costTotal = Number(r.total);
      e.lastDate = r.last_date || null;
    }
    for (const r of ordersQ.rows) ensure(r.site_id).orderTotal = Number(r.total);
    for (const r of planQ.rows) ensure(r.site_id).plannedTotal = Number(r.total);
    for (const r of laborQ.rows) {
      const e = ensure(r.site_id);
      e.laborTotal = Number(r.total);
      e.laborDays = Number(r.days);
      e.laborSkilled = Number(r.skilled);
      e.laborHelper = Number(r.helper);
      if (r.last_date && (!e.lastDate || r.last_date > e.lastDate)) e.lastDate = r.last_date; // 최근일 = costs·labor 중 더 최근
    }

    // 4) 현장명 채우기 (팀 소속만; 합집합 site 들 1회 조회 — N+1 금지).
    const siteIds = [...map.keys()];
    if (siteIds.length > 0) {
      const namesQ = await pool.query(
        `SELECT id, name FROM interior_sites WHERE id = ANY($1::bigint[]) AND team_id=$2`,
        [siteIds, req.teamId]
      );
      for (const r of namesQ.rows) {
        const e = map.get(String(r.id));
        if (e) e.site_name = r.name;
      }
    }

    // 사용액 큰 현장 우선(동률 시 site_id). 합계는 bySite 누적.
    const bySite = [...map.values()].sort((a, b) => {
      const sb = b.costTotal + b.orderTotal + b.plannedTotal + b.laborTotal;
      const sa = a.costTotal + a.orderTotal + a.plannedTotal + a.laborTotal;
      if (sb !== sa) return sb - sa;
      return Number(a.site_id) - Number(b.site_id);
    });
    const totals = bySite.reduce(
      (acc, s) => {
        acc.costTotal += s.costTotal;
        acc.orderTotal += s.orderTotal;
        acc.plannedTotal += s.plannedTotal;
        acc.laborTotal += s.laborTotal;
        acc.laborDays += s.laborDays;
        acc.laborSkilled += s.laborSkilled;
        acc.laborHelper += s.laborHelper;
        return acc;
      },
      { costTotal: 0, orderTotal: 0, plannedTotal: 0, laborTotal: 0, laborDays: 0, laborSkilled: 0, laborHelper: 0 }
    );

    res.json({
      vendor: {
        id: vendorRow.id,
        name: vendorRow.name,
        kind: vendorRow.kind || '',
        phone: vendorRow.phone || '',
        trade: vendorRow.trade || '',
        grade: vendorRow.grade || '',
        memo: vendorRow.memo || '',
        skilled_rate: Number(vendorRow.skilled_rate) || 0,
        helper_rate: Number(vendorRow.helper_rate) || 0,
      },
      totals,
      bySite,
    });
  } catch (err) {
    console.error('GET /api/vendors/:id/usage 오류:', err.message);
    res.status(500).json({ success: false, message: '거래처 사용내역을 불러오지 못했습니다.' });
  }
});

// ========================================
// REST API — 카테고리(interior_categories)
// GET 은 항상 { cost:[...], process:[...] } 객체 (sort_order ASC).
// ========================================
app.get('/api/categories', async (req, res) => {
  try {
    const where = wantAll(req) ? 'WHERE team_id = $1' : 'WHERE team_id = $1 AND active = TRUE';
    const { rows } = await pool.query(
      `SELECT ${CATEGORY_COLS} FROM interior_categories ${where} ORDER BY kind ASC, sort_order ASC, name ASC`,
      [req.teamId]
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
      `INSERT INTO interior_categories (kind, name, sort_order, team_id) VALUES ($1,$2,$3,$4) RETURNING ${CATEGORY_COLS}`,
      [kind, name, sort_order, req.teamId]
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
    const existing = await pool.query(`SELECT ${CATEGORY_COLS} FROM interior_categories WHERE id=$1 AND team_id=$2`, [id, req.teamId]);
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
    const { rowCount } = await pool.query('DELETE FROM interior_categories WHERE id=$1 AND team_id=$2', [id, req.teamId]);
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
    const schedules = rows.map(rowToSchedule);

    // (6-4) 현장 전체 선후관계를 1회 조회해 매핑 (N+1 금지). id 는 다른 id 와 동일하게 문자열로 통일.
    const ids = schedules.map((s) => s.id);
    const predMap = {}; // successor id → [predecessor id...]
    const succMap = {}; // predecessor id → [successor id...]
    if (ids.length > 0) {
      const depQ = await pool.query(
        `SELECT predecessor_id, successor_id FROM interior_schedule_deps
         WHERE predecessor_id = ANY($1::bigint[]) OR successor_id = ANY($1::bigint[])`,
        [ids]
      );
      for (const d of depQ.rows) {
        const p = String(d.predecessor_id);
        const su = String(d.successor_id);
        (succMap[p] = succMap[p] || []).push(su);
        (predMap[su] = predMap[su] || []).push(p);
      }
    }

    res.json(
      schedules.map((s) => ({
        ...s,
        predecessors: predMap[s.id] || [],
        successors: succMap[s.id] || [],
      }))
    );
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

    // (v19) kind 컬럼 포함. kind≠'미팅' 이면 v1~v18 그대로 단일 INSERT(트랜잭션 불필요).
    const insertSQL = `INSERT INTO interior_schedule (site_id, title, process, start_date, end_date, status, planned_cost, staff, vendor, color, memo, sort_order, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING ${SCHEDULE_RETURNING_COLS}`;
    const insertParams = [id, v.title, v.process, v.start_date, v.end_date, v.status, v.planned_cost, v.staff, v.vendor, v.color, v.memo, v.sort_order, v.kind];

    if (v.kind !== '미팅') {
      const { rows } = await pool.query(insertSQL, insertParams);
      return res.status(201).json(rowToSchedule(rows[0]));
    }

    // (v19) kind='미팅': 일정 INSERT + interior_meetings 연동행 INSERT 를 한 트랜잭션으로.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(insertSQL, insertParams);
      const sched = rowToSchedule(rows[0]);
      await syncScheduleMeeting(client, sched); // 연동 미팅 생성
      await client.query('COMMIT');
      return res.status(201).json(sched);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e; // 바깥 catch 가 로깅 + 500 처리
    } finally {
      client.release();
    }
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

    const cascade = parseBool(req.body && req.body.cascade, false);

    // ===== cascade 미전달/false: v1~v18 단일 일정 갱신 동작 보존. (v19) kind 갱신 + 미팅 연동 동기화(트랜잭션) =====
    if (!cascade) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `UPDATE interior_schedule
           SET title=$1, process=$2, start_date=$3, end_date=$4, status=$5, planned_cost=$6, staff=$7, color=$8, memo=$9, sort_order=$10, vendor=COALESCE($11::text, vendor), kind=COALESCE($12::text, kind)
           WHERE id=$13
           RETURNING ${SCHEDULE_RETURNING_COLS}`,
          [v.title, v.process, v.start_date, v.end_date, v.status, v.planned_cost, v.staff, v.color, v.memo, v.sort_order, v.vendor_provided ? v.vendor : null, v.kind_provided ? v.kind : null, id]
        );
        if (rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ success: false, message: '해당 일정을 찾을 수 없습니다.' });
        }
        const sched = rowToSchedule(rows[0]);
        await syncScheduleMeeting(client, sched); // (v19) 새 kind 기준 연동 미팅 upsert(미팅)/삭제(비미팅)
        await client.query('COMMIT');
        return res.json(sched);
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw e; // 바깥 catch 가 로깅 + 500 처리
      } finally {
        client.release();
      }
    }

    // ===== (6-4) cascade=true: 트랜잭션으로 본 일정 갱신 + 모든 후속(transitive)을 +delta 연쇄이동 =====
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) 기존 start_date 확보(delta 계산용) + 현장 식별. 본 행 잠금.
      const cur = await client.query(
        `SELECT site_id, to_char(start_date,'YYYY-MM-DD') AS start_date
         FROM interior_schedule WHERE id=$1 FOR UPDATE`,
        [id]
      );
      if (cur.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: '해당 일정을 찾을 수 없습니다.' });
      }
      const oldStart = cur.rows[0].start_date;
      const siteId = cur.rows[0].site_id;

      // 2) 본 일정 갱신 (cascade=false 와 동일한 풀-리플레이스). (v19) kind 포함.
      const upd = await client.query(
        `UPDATE interior_schedule
         SET title=$1, process=$2, start_date=$3, end_date=$4, status=$5, planned_cost=$6, staff=$7, color=$8, memo=$9, sort_order=$10, vendor=COALESCE($11::text, vendor), kind=COALESCE($12::text, kind)
         WHERE id=$13
         RETURNING ${SCHEDULE_RETURNING_COLS}`,
        [v.title, v.process, v.start_date, v.end_date, v.status, v.planned_cost, v.staff, v.color, v.memo, v.sort_order, v.vendor_provided ? v.vendor : null, v.kind_provided ? v.kind : null, id]
      );
      const self = rowToSchedule(upd.rows[0]);

      // (v19) 본 일정의 미팅 연동 동기화(새 kind 기준). self.start_date=새 시작일 → 연동 미팅 meeting_date 도 새 시작일로 갱신.
      await syncScheduleMeeting(client, self);

      // 3) delta = 새 start − 기존 start (일수). 0 이면 후속 이동 없음.
      const delta = dayDiff(v.start_date, oldStart);
      let shifted = [];

      if (delta !== 0) {
        // 4) 현장 deps 1회 조회 → 후행 adjacency (predecessor → [successor...])
        const depsQ = await client.query(
          `SELECT predecessor_id, successor_id FROM interior_schedule_deps
           WHERE predecessor_id IN (SELECT id FROM interior_schedule WHERE site_id=$1)`,
          [siteId]
        );
        const succMap = {};
        for (const d of depsQ.rows) {
          const p = String(d.predecessor_id);
          (succMap[p] = succMap[p] || []).push(String(d.successor_id));
        }
        // 5) BFS — 모든 transitive successor 수집 (방문체크로 사이클·중복 안전, 본 일정 제외)
        const visited = new Set([String(id)]);
        const toShift = [];
        const queue = [String(id)];
        while (queue.length) {
          const cu = queue.shift();
          for (const nx of succMap[cu] || []) {
            if (!visited.has(nx)) {
              visited.add(nx);
              toShift.push(nx);
              queue.push(nx);
            }
          }
        }
        // 6) 후속들 start/end 를 +delta 이동 (PG date + int = N일 가감 → 타임존 무관)
        if (toShift.length > 0) {
          const shiftQ = await client.query(
            `UPDATE interior_schedule
             SET start_date = start_date + ($2::int), end_date = end_date + ($2::int)
             WHERE id = ANY($1::bigint[])
             RETURNING id, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date`,
            [toShift, delta]
          );
          shifted = shiftQ.rows.map((r) => ({
            id: String(r.id),
            start_date: r.start_date,
            end_date: r.end_date,
          }));

          // (v19) 이동한 후속 중 미팅 연동행(schedule_id 매칭)이 있으면 meeting_date 도 동일 delta 만큼 이동.
          await client.query(
            `UPDATE interior_meetings
             SET meeting_date = meeting_date + ($2::int)
             WHERE schedule_id = ANY($1::bigint[]) AND meeting_date IS NOT NULL`,
            [toShift, delta]
          );
        }
      }

      await client.query('COMMIT');
      return res.json({ ...self, shifted });
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        /* noop */
      }
      throw e; // 바깥 catch 가 로깅 + 500 처리
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('PUT /api/schedule/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '일정을 수정하지 못했습니다.' });
  }
});

app.delete('/api/schedule/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 일정 id 형식입니다.' });

    // (v19) 비용 schedule_id SET NULL + 연동 미팅 삭제 + 일정 삭제를 한 트랜잭션으로.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 연결된 비용의 schedule_id 를 SET NULL (FK 가 없을 수도 있어 수동 처리 — 비용 자체는 보존)
      await client.query('UPDATE interior_costs SET schedule_id=NULL WHERE schedule_id=$1', [id]);
      // (v19) kind='미팅' 일정에서 연동 생성된 미팅도 함께 삭제(schedule_id 매칭). 수동 미팅(null)은 영향 없음.
      await client.query('DELETE FROM interior_meetings WHERE schedule_id=$1', [id]);
      const { rowCount } = await client.query('DELETE FROM interior_schedule WHERE id=$1', [id]);
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: '해당 일정을 찾을 수 없습니다.' });
      }
      await client.query('COMMIT');
      return res.json({ success: true });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e; // 바깥 catch 가 로깅 + 500 처리
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('DELETE /api/schedule/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '일정을 삭제하지 못했습니다.' });
  }
});

// ========================================
// (v6 / 6-4) 일정 선후관계(의존성) — predecessor(선행)가 끝나야 successor(후행) 시작
//   :id = successor 기준. 검증: 같은 현장 / 자기참조 금지 / 사이클 금지 / 중복 멱등.
// ========================================

// POST /api/schedule/:id/deps — 선행 추가. body {predecessor_id} (:id = successor)
app.post('/api/schedule/:id/deps', async (req, res) => {
  try {
    const succId = parseId(req.params.id);
    if (!succId) return res.status(400).json({ success: false, message: '잘못된 일정 id 형식입니다.' });

    const rawPred = req.body && req.body.predecessor_id;
    if (rawPred === undefined || rawPred === null || rawPred === '' || !/^\d+$/.test(String(rawPred))) {
      return res.status(400).json({ success: false, message: 'predecessor_id 는 양의 정수여야 합니다.' });
    }
    const predId = String(rawPred);

    // 자기참조 금지
    if (predId === String(succId)) {
      return res.status(400).json({ success: false, message: '자기 자신을 선행으로 지정할 수 없습니다.' });
    }

    // 두 일정 존재 + 같은 현장 확인
    const both = await pool.query('SELECT id, site_id FROM interior_schedule WHERE id = ANY($1::bigint[])', [
      [predId, succId],
    ]);
    if (both.rows.length < 2) {
      return res.status(404).json({ success: false, message: '선행/후행 일정을 찾을 수 없습니다.' });
    }
    const siteSet = new Set(both.rows.map((r) => String(r.site_id)));
    if (siteSet.size > 1) {
      return res.status(400).json({ success: false, message: '같은 현장의 일정끼리만 선후관계를 지정할 수 있습니다.' });
    }
    const siteId = both.rows[0].site_id;

    // 이미 동일 링크가 있으면 멱등 200
    const existing = await pool.query(
      'SELECT id, predecessor_id, successor_id FROM interior_schedule_deps WHERE predecessor_id=$1 AND successor_id=$2',
      [predId, succId]
    );
    if (existing.rows.length > 0) {
      const r = existing.rows[0];
      return res
        .status(200)
        .json({ id: String(r.id), predecessor_id: String(r.predecessor_id), successor_id: String(r.successor_id) });
    }

    // 사이클 검사: 기존 그래프에서 succ 가 pred 에 도달 가능하면 pred→succ 추가 시 순환 발생.
    const depsQ = await pool.query(
      `SELECT predecessor_id, successor_id FROM interior_schedule_deps
       WHERE predecessor_id IN (SELECT id FROM interior_schedule WHERE site_id=$1)`,
      [siteId]
    );
    const succMap = {};
    for (const d of depsQ.rows) {
      const p = String(d.predecessor_id);
      (succMap[p] = succMap[p] || []).push(String(d.successor_id));
    }
    const visited = new Set([String(succId)]);
    const queue = [String(succId)];
    while (queue.length) {
      const cu = queue.shift();
      for (const nx of succMap[cu] || []) {
        if (nx === predId) {
          return res.status(400).json({ success: false, message: '선후관계에 순환(사이클)이 생깁니다.' });
        }
        if (!visited.has(nx)) {
          visited.add(nx);
          queue.push(nx);
        }
      }
    }

    // 통과 → INSERT (201). 동시성 레이스의 UNIQUE 충돌은 멱등 200 으로 흡수.
    try {
      const ins = await pool.query(
        'INSERT INTO interior_schedule_deps (predecessor_id, successor_id) VALUES ($1,$2) RETURNING id, predecessor_id, successor_id',
        [predId, succId]
      );
      const r = ins.rows[0];
      return res
        .status(201)
        .json({ id: String(r.id), predecessor_id: String(r.predecessor_id), successor_id: String(r.successor_id) });
    } catch (e) {
      if (e.code === '23505') {
        const re = await pool.query(
          'SELECT id, predecessor_id, successor_id FROM interior_schedule_deps WHERE predecessor_id=$1 AND successor_id=$2',
          [predId, succId]
        );
        if (re.rows.length > 0) {
          const r = re.rows[0];
          return res
            .status(200)
            .json({ id: String(r.id), predecessor_id: String(r.predecessor_id), successor_id: String(r.successor_id) });
        }
      }
      throw e;
    }
  } catch (err) {
    console.error('POST /api/schedule/:id/deps 오류:', err.message);
    res.status(500).json({ success: false, message: '선후관계를 추가하지 못했습니다.' });
  }
});

// DELETE /api/schedule/:id/deps/:predId — 선행 링크 삭제 (:id = successor, :predId = predecessor)
app.delete('/api/schedule/:id/deps/:predId', async (req, res) => {
  try {
    const succId = parseId(req.params.id);
    const predId = parseId(req.params.predId);
    if (!succId || !predId) return res.status(400).json({ success: false, message: '잘못된 일정 id 형식입니다.' });

    const { rowCount } = await pool.query(
      'DELETE FROM interior_schedule_deps WHERE predecessor_id=$1 AND successor_id=$2',
      [predId, succId]
    );
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 선후관계를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/schedule/:id/deps/:predId 오류:', err.message);
    res.status(500).json({ success: false, message: '선후관계를 삭제하지 못했습니다.' });
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

// POST /api/estimates/new — (v15) 견적에서 현장 생성: 현장+견적을 단일 트랜잭션으로 원자적 생성 (201)
//   라우트 순서: /api/estimates/:id 보다 위에 등록. ('new'는 parseId 가 null → /api/estimates/:id 소유검증 미들웨어를 통과)
//   body: { site:{ name(필수), client?, address?, building_type?, manager?, start_date?, end_date?,
//                  move_in_date?, floor_area?, pm?, construction_manager?, designer?, ... },
//           estimate:{ title?, client_name?, client_contact?, estimate_date?, valid_until?, vat_mode?, vat_rate?,
//                      discount?, memo?, use_cost_buildup?, ...11율, items?:[...] } }
//   ① 현장 INSERT  (POST /api/sites 로직 재사용: team_id=req.teamId, 폴더 생성·folder 컬럼, 신규필드, name 중복 시 409로 롤백)
//   ② 그 site_id 로 견적 헤더+items INSERT (POST /api/sites/:id/estimates 로직 재사용: 각 amount 서버계산, status 기본 'draft')
//   현장 row 와 견적 row 는 한 트랜잭션으로 원자성 보장(어느 한쪽 실패 시 둘 다 롤백).
//   폴더 생성은 트랜잭션 밖 부수효과(POST /api/sites 와 동일하게 INSERT 전에 경로 확보) — 롤백돼도 폴더는 남을 수 있음(기존 폴더 보존 정책).
app.post('/api/estimates/new', async (req, res) => {
  const body = req.body || {};

  // 현장 검증 (name 필수 → 400). 기존 POST /api/sites 와 동일한 validateSite 재사용.
  const siteCheck = validateSite(body.site);
  if (!siteCheck.valid) return res.status(400).json({ success: false, message: siteCheck.message });
  const sv = siteCheck.values;

  // 견적 헤더/항목 검증. 기존 POST /api/sites/:id/estimates 와 동일한 검증 재사용.
  const estBody = body.estimate || {};
  const headerCheck = validateEstimateHeader(estBody);
  if (!headerCheck.valid) return res.status(400).json({ success: false, message: headerCheck.message });
  const itemsCheck = validateEstimateItems(estBody.items);
  if (!itemsCheck.valid) return res.status(400).json({ success: false, message: itemsCheck.message });
  const h = headerCheck.values;
  const items = itemsCheck.values;

  // estimate.client_name 미전달/빈값 → site.client 로 기본.
  const clientName = h.client_name ? h.client_name : (sv.client || '');

  // 폴더 생성(부수효과) — POST /api/sites 와 동일하게 트랜잭션 밖에서 경로 확보. 경로 탈출 시 400.
  let folder = '';
  try {
    folder = createSiteFolder(sv.name);
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ① 현장 INSERT — POST /api/sites 와 동일 컬럼/파라미터 (team_id=req.teamId, 신규필드 포함).
    const siteIns = await client.query(
      `INSERT INTO interior_sites
         (name, client, address, manager, budget, start_date, end_date, folder, status, tags,
          building_type, floor_area, move_in_date, pm, construction_manager, designer, progress_status, client_id, archived,
          team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING ${SITE_COLS}`,
      [
        sv.name, sv.client, sv.address, sv.manager, sv.budget, sv.start_date, sv.end_date, folder, sv.status, sv.tags,
        sv.building_type, sv.floor_area, sv.move_in_date, sv.pm, sv.construction_manager, sv.designer, sv.progress_status,
        sv.client_id != null ? sv.client_id : null, // (v5) 미전달/null → null
        sv.archived_provided ? sv.archived : false, // (v6) 미전달 → false
        req.teamId, // (v13) 소속 팀
      ]
    );
    const site = rowToSite(siteIns.rows[0]);

    // ② 그 site_id 로 견적 헤더 INSERT — POST /api/sites/:id/estimates 와 동일 컬럼/파라미터.
    //    client_name 만 site.client 기본 적용, status 는 컬럼 DEFAULT('draft') 사용.
    const estIns = await client.query(
      `INSERT INTO interior_estimates
         (site_id, title, client_name, client_contact, estimate_date, valid_until, vat_mode, vat_rate, discount, memo,
          use_cost_buildup, indirect_material_rate, indirect_labor_rate, safety_insurance_rate, employment_insurance_rate,
          safety_mgmt_rate, other_expense_rate, admin_rate, design_rate, profit_rate, round_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING ${ESTIMATE_COLS}`,
      [
        site.id, h.title, clientName, h.client_contact, h.estimate_date, h.valid_until, h.vat_mode, h.vat_rate, h.discount, h.memo,
        h.use_cost_buildup, h.indirect_material_rate, h.indirect_labor_rate, h.safety_insurance_rate, h.employment_insurance_rate,
        h.safety_mgmt_rate, h.other_expense_rate, h.admin_rate, h.design_rate, h.profit_rate, h.round_unit,
      ]
    );
    const est = rowToEstimate(estIns.rows[0]);

    // ② items INSERT — 각 amount 는 validateEstimateItems 가 서버 계산함(POST estimates 와 동일).
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
    res.status(201).json({ site, estimate: { ...est, items: insertedItems, totals } });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* noop */
    }
    if (err.code === '23505') {
      // 현장명 UNIQUE 충돌 → 현장도 견적도 생성되지 않음(롤백). 폴더는 보존 정책상 남을 수 있음.
      return res.status(409).json({ success: false, message: '이미 존재하는 현장명입니다.' });
    }
    console.error('POST /api/estimates/new 오류:', err.message);
    res.status(500).json({ success: false, message: '견적에서 현장을 생성하지 못했습니다.' });
  } finally {
    client.release();
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

// POST /api/estimates/:id/duplicate — (v18/18-2) 견적 복제(헤더+items 전부 복사)해 새 버전 생성.
//   소유/팀 검증은 requireChildOwned('interior_estimates') 가 /api/estimates/:id/* 를 이미 보호(타팀/미존재 404).
//   새 version = 같은 현장 견적 중 max(version)+1 (현장 없으면 원본 version+1). status='draft'. 원본은 불변.
//   title = body.title 있으면 그것, 없으면 원본 title 에 vN 반영. share_token/비번은 복사하지 않음(새 견적은 비공유).
app.post('/api/estimates/:id/duplicate', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });
  const bodyTitle =
    req.body && typeof req.body.title === 'string' && req.body.title.trim() ? req.body.title.trim() : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 원본 헤더
    const origQ = await client.query(`SELECT ${ESTIMATE_COLS} FROM interior_estimates WHERE id=$1`, [id]);
    if (origQ.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });
    }
    const orig = rowToEstimate(origQ.rows[0]);

    // 원본 items (정렬 보존)
    const itemsQ = await client.query(
      `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
      [id]
    );

    // 새 버전: 같은 현장 계열의 max(version)+1 (없으면 원본+1). 항상 원본보다 크게 보장.
    let baseVersion = orig.version;
    if (orig.site_id != null) {
      const mx = await client.query(
        'SELECT COALESCE(MAX(version),0) AS mx FROM interior_estimates WHERE site_id=$1',
        [orig.site_id]
      );
      baseVersion = Math.max(baseVersion, Number(mx.rows[0].mx));
    }
    const newVersion = baseVersion + 1;
    const newTitle = bodyTitle || nextVersionTitle(orig.title, newVersion);

    // 헤더 복제 (status='draft', version=newVersion 명시)
    const ins = await client.query(
      `INSERT INTO interior_estimates
         (site_id, title, client_name, client_contact, estimate_date, valid_until, vat_mode, vat_rate, discount, status, memo,
          use_cost_buildup, indirect_material_rate, indirect_labor_rate, safety_insurance_rate, employment_insurance_rate,
          safety_mgmt_rate, other_expense_rate, admin_rate, design_rate, profit_rate, round_unit, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING ${ESTIMATE_COLS}`,
      [
        orig.site_id, newTitle, orig.client_name, orig.client_contact, orig.estimate_date, orig.valid_until,
        orig.vat_mode, orig.vat_rate, orig.discount, orig.memo,
        orig.use_cost_buildup, orig.indirect_material_rate, orig.indirect_labor_rate, orig.safety_insurance_rate,
        orig.employment_insurance_rate, orig.safety_mgmt_rate, orig.other_expense_rate, orig.admin_rate,
        orig.design_rate, orig.profit_rate, orig.round_unit, newVersion,
      ]
    );
    const est = rowToEstimate(ins.rows[0]);

    // items 복제 (amount 포함 그대로 — 서버 계산값 보존)
    const insertedItems = [];
    for (const row of itemsQ.rows) {
      const it = rowToItem(row);
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
    console.error('POST /api/estimates/:id/duplicate 오류:', err.message);
    res.status(500).json({ success: false, message: '견적서를 복제하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// ========================================
// REST API — (v18/18-3) 견적 템플릿(interior_estimate_templates) · 인증·팀 스코핑
//   staff/vendors(v13) 와 동형: GET=team_id 필터, POST=team_id 세팅, PUT/DELETE=team_id 일치 404.
//   config/items 는 JSONB — JSON.stringify 후 ::jsonb 캐스팅으로 저장(배열을 pg 배열로 오해하지 않도록).
// ========================================
app.get('/api/estimate-templates', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${TEMPLATE_COLS} FROM interior_estimate_templates WHERE team_id=$1 ORDER BY name ASC, id ASC`,
      [req.teamId]
    );
    res.json(rows.map(rowToTemplate));
  } catch (err) {
    console.error('GET /api/estimate-templates 오류:', err.message);
    res.status(500).json({ success: false, message: '견적 템플릿 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/estimate-templates', async (req, res) => {
  try {
    const check = validateTemplate(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `INSERT INTO interior_estimate_templates (team_id, name, description, config, items)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING ${TEMPLATE_COLS}`,
      [req.teamId, v.name, v.description, JSON.stringify(v.config), JSON.stringify(v.items)]
    );
    res.status(201).json(rowToTemplate(rows[0]));
  } catch (err) {
    console.error('POST /api/estimate-templates 오류:', err.message);
    res.status(500).json({ success: false, message: '견적 템플릿을 생성하지 못했습니다.' });
  }
});

app.put('/api/estimate-templates/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 템플릿 id 형식입니다.' });
    const check = validateTemplate(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_estimate_templates
         SET name=$1, description=$2, config=$3::jsonb, items=$4::jsonb
       WHERE id=$5 AND team_id=$6 RETURNING ${TEMPLATE_COLS}`,
      [v.name, v.description, JSON.stringify(v.config), JSON.stringify(v.items), id, req.teamId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 견적 템플릿을 찾을 수 없습니다.' });
    res.json(rowToTemplate(rows[0]));
  } catch (err) {
    console.error('PUT /api/estimate-templates/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '견적 템플릿을 수정하지 못했습니다.' });
  }
});

app.delete('/api/estimate-templates/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 템플릿 id 형식입니다.' });
    const { rowCount } = await pool.query(
      'DELETE FROM interior_estimate_templates WHERE id=$1 AND team_id=$2',
      [id, req.teamId]
    );
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 견적 템플릿을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/estimate-templates/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '견적 템플릿을 삭제하지 못했습니다.' });
  }
});

// ========================================
// (v17) 견적 공유링크 관리 (인증 필수·팀 스코핑)
//   소유 검증은 requireChildOwned('interior_estimates') 가 /api/estimates/:id/* 를 이미 보호 → 타팀/미존재 404.
// ========================================
// POST /api/estimates/:id/share — 공유 활성화 + 선택적 비번.
//   share_token 없으면 crypto 랜덤 발급(있으면 유지). body.password 키가 있으면 설정(빈문자→해시 제거), 없으면 기존 비번 유지.
app.post('/api/estimates/:id/share', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });

    const cur = await pool.query('SELECT share_token, share_password_hash FROM interior_estimates WHERE id=$1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });

    let token = cur.rows[0].share_token;
    if (!token) token = crypto.randomBytes(16).toString('hex'); // 신규 발급(재호출 시 기존 토큰 유지)

    const body = req.body || {};
    let hash = cur.rows[0].share_password_hash; // 기본: 기존 유지
    if (Object.prototype.hasOwnProperty.call(body, 'password')) {
      const pw = typeof body.password === 'string' ? body.password : '';
      hash = pw ? await bcrypt.hash(pw, 10) : null; // 빈문자 → 비번 제거
    }

    await pool.query('UPDATE interior_estimates SET share_token=$1, share_password_hash=$2 WHERE id=$3', [token, hash, id]);
    res.json({ share_token: token, url: '/share/estimate/' + token, hasPassword: !!hash });
  } catch (err) {
    console.error('POST /api/estimates/:id/share 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 링크를 생성하지 못했습니다.' });
  }
});

// DELETE /api/estimates/:id/share — 공유 해제 (토큰/해시 null)
app.delete('/api/estimates/:id/share', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });
    const r = await pool.query(
      'UPDATE interior_estimates SET share_token=NULL, share_password_hash=NULL WHERE id=$1 RETURNING id',
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: '해당 견적서를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/estimates/:id/share 오류:', err.message);
    res.status(500).json({ success: false, message: '공유를 해제하지 못했습니다.' });
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

    // 집행 합계 (+ v12: 공급가 기준 / 계산서 집계)
    //   spent            = Σ amount                                   (세금 포함 = 실제 지출 총액, 기존 키 그대로)
    //   spent_supply     = Σ (has_invoice ? round(amount/1.1) : amount) (공급가 기준 = 매입세액 제외 실질 원가)
    //   invoiced_count   = 계산서 발행(has_invoice=true) 비용 건수
    //   invoiced_amount  = 계산서 발행 비용 amount 합
    const spentQ = await pool.query(
      `SELECT
         COALESCE(SUM(amount),0)::bigint AS spent,
         COALESCE(SUM(CASE WHEN has_invoice THEN round(amount/1.1) ELSE amount END),0)::bigint AS spent_supply,
         COUNT(*) FILTER (WHERE has_invoice) AS invoiced_count,
         COALESCE(SUM(amount) FILTER (WHERE has_invoice),0)::bigint AS invoiced_amount
       FROM interior_costs WHERE site_id=$1`,
      [id]
    );
    const spent = Number(spentQ.rows[0].spent);
    const spentSupply = Number(spentQ.rows[0].spent_supply); // 공급가 기준 사용비용
    const invoicedCount = Number(spentQ.rows[0].invoiced_count);
    const invoicedAmount = Number(spentQ.rows[0].invoiced_amount);
    const vatTotal = spent - spentSupply; // 부가세 합계 = 세금포함 − 공급가

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

    // (v5) 연결된 고객/리드명 — 단일 테이블 쿼리(SITE_COLS)라 별도 조회. 미연결/삭제됨 → null.
    let clientName = null;
    if (s.client_id != null) {
      const clQ = await pool.query('SELECT name FROM interior_clients WHERE id=$1', [s.client_id]);
      if (clQ.rows.length > 0) clientName = clQ.rows[0].name;
    }
    s.client_name = clientName; // rowToSite(s) 가 집어가도록 주입

    // (v5) 서브-DB 카운트(프로젝트 헤더 뱃지용) — 발주/미팅/AS 건수 + 미완료 AS 건수.
    //   (v10) orderDueSoon = need_date ≤ today+7 & 미완료(입고/정산완료 제외) 발주 수,
    //         orderOverdue = need_date < today & 동일 미완료 발주 수. (need_date NULL 은 제외)
    const cntQ = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM interior_orders   WHERE site_id=$1) AS order_count,
         (SELECT COUNT(*) FROM interior_meetings WHERE site_id=$1) AS meeting_count,
         (SELECT COUNT(*) FROM interior_as       WHERE site_id=$1) AS as_count,
         (SELECT COUNT(*) FROM interior_as       WHERE site_id=$1 AND status <> '완료') AS as_open_count,
         (SELECT COUNT(*) FROM interior_orders   WHERE site_id=$1 AND need_date IS NOT NULL
            AND need_date <= CURRENT_DATE + 7 AND status NOT IN ('입고','정산완료')) AS order_due_soon,
         (SELECT COUNT(*) FROM interior_orders   WHERE site_id=$1 AND need_date IS NOT NULL
            AND need_date < CURRENT_DATE AND status NOT IN ('입고','정산완료')) AS order_overdue`,
      [id]
    );
    const cnt = cntQ.rows[0];

    res.json({
      // (v4) 프로젝트 헤더 카드용 현장 전체 정보(신규 7컬럼 포함). 기존 키는 그대로 보존(추가만).
      site: rowToSite(s),
      budget,
      spent,
      remaining: budget - spent,
      rate: budget > 0 ? Math.round((spent / budget) * 100) / 100 : null,
      // (v12) 계산서 유무 기반 집계 — 공급가 기준 / 세금 포함 두 가지 보기. spent 는 위 그대로(=taxIncluded).
      spentSupply, // 공급가 기준 사용비용 = Σ(has_invoice ? round(amount/1.1) : amount)
      spentTaxIncluded: spent, // 세금 포함 사용비용 = spent (명시적 별칭)
      vatTotal, // 부가세 합계 = spentTaxIncluded − spentSupply
      invoicedCount, // 계산서 발행 비용 건수
      invoicedAmount, // 계산서 발행 비용 amount 합
      byCategory: byCatQ.rows.map((r) => ({ category: r.category, total: Number(r.total) })),
      byProcess: byProcQ.rows.map((r) => ({ process: r.process, total: Number(r.total) })),
      schedule,
      estimateTotal,
      byProcessPlan,
      scheduleAgg,
      // (v5) 고객/리드 + 서브-DB 카운트 (프로젝트 헤더 뱃지용)
      client_id: s.client_id == null ? null : String(s.client_id),
      client_name: clientName,
      orderCount: Number(cnt.order_count),
      meetingCount: Number(cnt.meeting_count),
      asCount: Number(cnt.as_count),
      asOpenCount: Number(cnt.as_open_count),
      // (v10) 발주 필요시기 알림 카운트 (need_date 기준)
      orderDueSoon: Number(cnt.order_due_soon),
      orderOverdue: Number(cnt.order_overdue),
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

    // (v13) 팀 스코핑 — 항상 적용 ($1)
    params.push(req.teamId);
    where.push(`team_id = $${params.length}`);

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
      `INSERT INTO interior_catalog (trade, grp, name, unit, material_price, labor_price, sub_price, product_name, vendor, code, source, price_date, active, team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${CATALOG_COLS}`,
      [v.trade, v.grp, v.name, v.unit, v.material_price, v.labor_price, v.sub_price, v.product_name, v.vendor, v.code, v.source, v.price_date, v.active, req.teamId]
    );
    res.status(201).json(rowToCatalog(rows[0]));
  } catch (err) {
    console.error('POST /api/catalog 오류:', err.message);
    res.status(500).json({ success: false, message: '카탈로그 항목을 생성하지 못했습니다.' });
  }
});

// (v9) POST /api/catalog/import — research 단가 일괄 import.
//   body { items:[{trade,name,unit?,material_price?,labor_price?,sub_price?,grp?,product_name?,vendor?,code?,source?,price_date?}] }
//   중복 회피 upsert 키 = (trade + name + product_name): 있으면 가격/source/price_date 등 update, 없으면 insert.
//   trade·name 필수 항목만 반영(둘 중 하나라도 없으면 skip). 가격은 0 이상 정수만 반영(아니면 무시→보존/0),
//   price_date 는 실제 달력 날짜만 반영. 미전달 필드는 update 시 기존값 보존(provided-flag → COALESCE).
//   POST 메서드 + 리터럴 '/import' 라 PUT/DELETE :id 와 충돌 없음. 트랜잭션으로 일괄 처리.
app.post('/api/catalog/import', async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });

  // 가격: 미전달/무효 → null(update 보존, insert 0), 유효 정수 → 그 값(0 포함).
  const normPrice = (x) => {
    if (x === undefined || x === null || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
  };
  // 텍스트: 미전달 → null(update 보존, insert ''), 전달 → trim.
  const normText = (x) => (x !== undefined ? (typeof x === 'string' ? x.trim() : String(x)) : null);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let imported = 0;
    let updated = 0;
    for (const raw of items) {
      const it = raw || {};
      const trade = typeof it.trade === 'string' ? it.trade.trim() : '';
      const name = typeof it.name === 'string' ? it.name.trim() : '';
      if (!trade || !name) continue; // trade·name 필수 항목만 반영
      const product_name = typeof it.product_name === 'string' ? it.product_name.trim() : '';

      const unit = normText(it.unit);
      const grp = normText(it.grp);
      const vendor = normText(it.vendor);
      const code = normText(it.code);
      const material_price = normPrice(it.material_price);
      const labor_price = normPrice(it.labor_price);
      const sub_price = normPrice(it.sub_price);
      // source: 미전달 → null(update 보존, insert 'manual'), 전달(비어있지않음) → 값.
      const source = it.source !== undefined && String(it.source).trim() ? String(it.source).trim() : (it.source !== undefined ? 'manual' : null);
      // price_date: 미전달 → null(update 보존, insert null). 전달이면 유효 날짜만, 무효는 null.
      let price_date = null;
      if (it.price_date !== undefined && it.price_date !== null && it.price_date !== '') {
        const pd = String(it.price_date).trim();
        price_date = isRealDate(pd) ? pd : null;
      }
      const priceDateProvided = it.price_date !== undefined;

      // upsert 키 = trade + name + product_name
      const existing = await client.query(
        'SELECT id FROM interior_catalog WHERE trade=$1 AND name=$2 AND product_name=$3 AND team_id=$4 ORDER BY id ASC LIMIT 1',
        [trade, name, product_name, req.teamId]
      );
      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE interior_catalog
             SET unit=COALESCE($1,unit), grp=COALESCE($2,grp), vendor=COALESCE($3,vendor), code=COALESCE($4,code),
                 material_price=COALESCE($5,material_price), labor_price=COALESCE($6,labor_price), sub_price=COALESCE($7,sub_price),
                 source=COALESCE($8,source), price_date=COALESCE($9,price_date)
           WHERE id=$10`,
          [unit, grp, vendor, code, material_price, labor_price, sub_price, source, priceDateProvided ? price_date : null, existing.rows[0].id]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO interior_catalog
             (trade, grp, name, unit, material_price, labor_price, sub_price, product_name, vendor, code, source, price_date, team_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            trade, grp || '', name, unit || '',
            material_price || 0, labor_price || 0, sub_price || 0,
            product_name, vendor || '', code || '', source || 'manual', priceDateProvided ? price_date : null,
            req.teamId,
          ]
        );
        imported++;
      }
    }
    await client.query('COMMIT');
    res.json({ imported, updated, total: imported + updated });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* noop */
    }
    console.error('POST /api/catalog/import 오류:', err.message);
    res.status(500).json({ success: false, message: '카탈로그 import 에 실패했습니다.' });
  } finally {
    client.release();
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
       SET trade=$1, grp=$2, name=$3, unit=$4, material_price=$5, labor_price=$6, sub_price=$7, product_name=$8, vendor=$9, code=$10, active=$11,
           source=COALESCE($12, source), price_date=COALESCE($13, price_date)
       WHERE id=$14 AND team_id=$15
       RETURNING ${CATALOG_COLS}`,
      [v.trade, v.grp, v.name, v.unit, v.material_price, v.labor_price, v.sub_price, v.product_name, v.vendor, v.code, v.active, v.sourceProvided ? v.source : null, v.priceDateProvided ? v.price_date : null, id, req.teamId]
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
    const { rowCount } = await pool.query('DELETE FROM interior_catalog WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 카탈로그 항목을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/catalog/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '카탈로그 항목을 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 고객/리드(interior_clients) — 전역 마스터 (staff/vendors 동형)
//   GET 기본 active 만, ?all=1 비활성 포함. status 는 CLIENT_STATES 외 값이면 '리드' 보정.
// ========================================
app.get('/api/clients', async (req, res) => {
  try {
    const where = wantAll(req) ? 'WHERE team_id = $1' : 'WHERE team_id = $1 AND active = TRUE';
    const { rows } = await pool.query(
      `SELECT ${CLIENT_COLS} FROM interior_clients ${where} ORDER BY active DESC, name ASC`,
      [req.teamId]
    );
    res.json(rows.map(rowToClient));
  } catch (err) {
    console.error('GET /api/clients 오류:', err.message);
    res.status(500).json({ success: false, message: '고객/리드 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    const check = validateClient(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `INSERT INTO interior_clients (name, phone, email, source, status, address, memo, active, team_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${CLIENT_COLS}`,
      [v.name, v.phone, v.email, v.source, v.status, v.address, v.memo, v.active, req.teamId]
    );
    res.status(201).json(rowToClient(rows[0]));
  } catch (err) {
    console.error('POST /api/clients 오류:', err.message);
    res.status(500).json({ success: false, message: '고객/리드를 생성하지 못했습니다.' });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 고객/리드 id 형식입니다.' });
    const check = validateClient(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_clients
       SET name=$1, phone=$2, email=$3, source=$4, status=$5, address=$6, memo=$7, active=$8
       WHERE id=$9 AND team_id=$10 RETURNING ${CLIENT_COLS}`,
      [v.name, v.phone, v.email, v.source, v.status, v.address, v.memo, v.active, id, req.teamId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 고객/리드를 찾을 수 없습니다.' });
    res.json(rowToClient(rows[0]));
  } catch (err) {
    console.error('PUT /api/clients/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '고객/리드를 수정하지 못했습니다.' });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 고객/리드 id 형식입니다.' });
    // 삭제 시 현장의 client_id 는 그대로 둔다(프론트가 못 찾으면 미표시 — 단순화, 데이터 보존).
    const { rowCount } = await pool.query('DELETE FROM interior_clients WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 고객/리드를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/clients/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '고객/리드를 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 발주서(interior_orders) — 프로젝트(현장) 종속, CASCADE
//   order_no 미전달 시 생성 직후 'PO-'+id 자동 세팅. status 는 ORDER_STATES 외 값이면 '대기' 보정.
// ========================================
app.get('/api/sites/:id/orders', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${ORDER_COLS} FROM interior_orders WHERE site_id=$1 ORDER BY order_date DESC NULLS LAST, id DESC`,
      [id]
    );
    res.json(rows.map(rowToOrder));
  } catch (err) {
    console.error('GET /api/sites/:id/orders 오류:', err.message);
    res.status(500).json({ success: false, message: '발주서 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/sites/:id/orders', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const check = validateOrder(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    const ins = await pool.query(
      `INSERT INTO interior_orders (site_id, order_no, vendor, trade, title, amount, order_date, due_date, status, memo, need_date, auto_generated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${ORDER_COLS}`,
      [id, v.order_no, v.vendor, v.trade, v.title, v.amount, v.order_date, v.due_date, v.status, v.memo,
       v.need_date, v.auto_generated === null ? false : v.auto_generated]
    );
    let row = ins.rows[0];
    // order_no 미전달 → 'PO-'+id 자동 세팅 후 재조회
    if (!v.order_no) {
      const upd = await pool.query(
        `UPDATE interior_orders SET order_no=$1 WHERE id=$2 RETURNING ${ORDER_COLS}`,
        ['PO-' + row.id, row.id]
      );
      row = upd.rows[0];
    }
    res.status(201).json(rowToOrder(row));
  } catch (err) {
    console.error('POST /api/sites/:id/orders 오류:', err.message);
    res.status(500).json({ success: false, message: '발주서를 저장하지 못했습니다.' });
  }
});

// ----------------------------------------
// (v10) POST /api/sites/:id/orders/auto-generate — 확정 견적 + 일정 기반 공종별 발주 초안 자동생성
//   body {estimate_id?} (미전달 시 해당 현장 최신 status='confirmed' 견적). 확정 견적 없으면 404.
//   ?replace=1 → 그 현장의 auto_generated=true·status='대기' 발주를 먼저 삭제 후 재생성(중복 누적 방지).
//   공종(trade)별 그룹 → 공종당 발주 1건:
//     amount = Σ round(material_price×qty)(해당 공종; 0/없으면 Σ amount 로 폴백),
//     need_date = interior_schedule(process=공종) min(start_date) − 3일(없으면 null),
//     title='{공종} 자재 발주', vendor='', status='대기', auto_generated=true, order_no='PO-'+id.
//   trade 빈 항목은 '기타'로 묶음. 전 과정 트랜잭션.
// ----------------------------------------
app.post('/api/sites/:id/orders/auto-generate', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    // 현장 존재 확인
    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    // 견적 해석: estimate_id 주어지면 그 현장 소속 견적, 아니면 최신 confirmed.
    const estIdRaw = (req.body || {}).estimate_id;
    let estRow;
    if (estIdRaw !== undefined && estIdRaw !== null && String(estIdRaw).trim() !== '') {
      const eid = parseId(estIdRaw);
      if (!eid) return res.status(400).json({ success: false, message: '잘못된 견적 id 형식입니다.' });
      const q = await pool.query('SELECT id FROM interior_estimates WHERE id=$1 AND site_id=$2', [eid, id]);
      estRow = q.rows[0];
    } else {
      const q = await pool.query(
        "SELECT id FROM interior_estimates WHERE site_id=$1 AND status='confirmed' ORDER BY created_at DESC, id DESC LIMIT 1",
        [id]
      );
      estRow = q.rows[0];
    }
    if (!estRow) return res.status(404).json({ error: '확정된 견적이 없습니다' });

    // 견적 항목 로드 → 공종(trade)별 그룹 (matSum=Σ round(material_price×qty), amtSum=Σ amount)
    const itemsQ = await pool.query(
      `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
      [estRow.id]
    );
    const items = itemsQ.rows.map(rowToItem);
    const groups = new Map(); // trade → { matSum, amtSum }
    for (const it of items) {
      const trade = it.trade && it.trade.trim() ? it.trade.trim() : '기타';
      const qv = Number(it.qty);
      const qty = Number.isFinite(qv) ? qv : 0;
      const g = groups.get(trade) || { matSum: 0, amtSum: 0 };
      g.matSum += Math.round(qty * (Number(it.material_price) || 0));
      g.amtSum += itemAmount(it);
      groups.set(trade, g);
    }

    // 공종별 need_date: interior_schedule(process) 의 min(start_date) − 3일 (1회 집계, N+1 금지)
    const ndQ = await pool.query(
      "SELECT process, to_char(MIN(start_date) - 3, 'YYYY-MM-DD') AS need_date FROM interior_schedule WHERE site_id=$1 GROUP BY process",
      [id]
    );
    const needDateByProcess = new Map();
    for (const r of ndQ.rows) needDateByProcess.set(r.process || '', r.need_date);

    // 트랜잭션: (replace) 기존 자동초안 삭제 → 공종별 INSERT → order_no='PO-'+id
    const replace = req.query.replace === '1' || req.query.replace === 'true';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (replace) {
        await client.query(
          "DELETE FROM interior_orders WHERE site_id=$1 AND auto_generated=TRUE AND status='대기'",
          [id]
        );
      }
      const created = [];
      for (const [trade, g] of groups) {
        const amount = g.matSum > 0 ? g.matSum : g.amtSum;
        const need_date = needDateByProcess.has(trade) ? needDateByProcess.get(trade) : null;
        const ins = await client.query(
          `INSERT INTO interior_orders (site_id, order_no, vendor, trade, title, amount, status, memo, need_date, auto_generated)
           VALUES ($1, '', '', $2, $3, $4, '대기', '', $5, TRUE) RETURNING ${ORDER_COLS}`,
          [id, trade, `${trade} 자재 발주`, amount, need_date]
        );
        const upd = await client.query(
          `UPDATE interior_orders SET order_no=$1 WHERE id=$2 RETURNING ${ORDER_COLS}`,
          ['PO-' + ins.rows[0].id, ins.rows[0].id]
        );
        created.push(rowToOrder(upd.rows[0]));
      }
      await client.query('COMMIT');
      res.json({ generated: created.length, orders: created });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/sites/:id/orders/auto-generate 오류:', err.message);
    res.status(500).json({ success: false, message: '발주 자동생성에 실패했습니다.' });
  }
});

// ----------------------------------------
// (v10) GET /api/orders/alerts?within=7 — 전역(모든 현장) 임박 발주 배열 (헤더 알림용)
//   need_date IS NOT NULL AND need_date ≤ today+within AND status NOT IN ('입고','정산완료'). need_date ASC.
//   GET /api/orders/:id 는 없으므로 경로 충돌 없음.
// ----------------------------------------
app.get('/api/orders/alerts', async (req, res) => {
  try {
    let within = Number(req.query.within);
    if (!Number.isFinite(within) || within < 0) within = 7;
    within = Math.min(Math.round(within), 365); // 과도한 범위 방지
    const { rows } = await pool.query(
      `SELECT o.id, o.site_id, s.name AS site_name, o.title, o.trade,
              to_char(o.need_date,'YYYY-MM-DD') AS need_date,
              (o.need_date - CURRENT_DATE) AS dday, o.status
       FROM interior_orders o JOIN interior_sites s ON s.id = o.site_id
       WHERE o.need_date IS NOT NULL AND o.need_date <= CURRENT_DATE + $1::int
         AND o.status NOT IN ('입고','정산완료')
         AND s.team_id = $2
       ORDER BY o.need_date ASC, o.id ASC`,
      [within, req.teamId]
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        site_id: r.site_id,
        site_name: r.site_name,
        title: r.title,
        trade: r.trade || '',
        need_date: r.need_date,
        dday: Number(r.dday),
        status: r.status || '대기',
      }))
    );
  } catch (err) {
    console.error('GET /api/orders/alerts 오류:', err.message);
    res.status(500).json({ success: false, message: '발주 알림을 불러오지 못했습니다.' });
  }
});

app.put('/api/orders/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 발주서 id 형식입니다.' });
    const check = validateOrder(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    // order_no 가 비면 'PO-'+id 로 유지(공란 방지 — POST 자동생성 규칙과 일관).
    const orderNo = v.order_no ? v.order_no : 'PO-' + id;
    // (v10) need_date/auto_generated 는 미전달(null)이면 COALESCE 로 기존값 보존 → 기존 프론트 PUT 회귀 안전.
    const { rows } = await pool.query(
      `UPDATE interior_orders
       SET order_no=$1, vendor=$2, trade=$3, title=$4, amount=$5, order_date=$6, due_date=$7, status=$8, memo=$9,
           need_date=COALESCE($11::date, need_date), auto_generated=COALESCE($12::boolean, auto_generated)
       WHERE id=$10 RETURNING ${ORDER_COLS}`,
      [orderNo, v.vendor, v.trade, v.title, v.amount, v.order_date, v.due_date, v.status, v.memo, id,
       v.need_date, v.auto_generated]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 발주서를 찾을 수 없습니다.' });
    res.json(rowToOrder(rows[0]));
  } catch (err) {
    console.error('PUT /api/orders/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '발주서를 수정하지 못했습니다.' });
  }
});

app.delete('/api/orders/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 발주서 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_orders WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 발주서를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/orders/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '발주서를 삭제하지 못했습니다.' });
  }
});

// ========================================
// (v17) 발주 공유링크 관리 (인증 필수·팀 스코핑)
//   소유 검증은 requireChildOwned('interior_orders') 가 /api/orders/:id/* 를 이미 보호(발주→현장→팀) → 타팀/미존재 404.
// ========================================
// POST /api/orders/:id/share — 공유 활성화 + 선택적 비번 (견적과 동형)
app.post('/api/orders/:id/share', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 발주서 id 형식입니다.' });

    const cur = await pool.query('SELECT share_token, share_password_hash FROM interior_orders WHERE id=$1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ success: false, message: '해당 발주서를 찾을 수 없습니다.' });

    let token = cur.rows[0].share_token;
    if (!token) token = crypto.randomBytes(16).toString('hex');

    const body = req.body || {};
    let hash = cur.rows[0].share_password_hash;
    if (Object.prototype.hasOwnProperty.call(body, 'password')) {
      const pw = typeof body.password === 'string' ? body.password : '';
      hash = pw ? await bcrypt.hash(pw, 10) : null;
    }

    await pool.query('UPDATE interior_orders SET share_token=$1, share_password_hash=$2 WHERE id=$3', [token, hash, id]);
    res.json({ share_token: token, url: '/share/order/' + token, hasPassword: !!hash });
  } catch (err) {
    console.error('POST /api/orders/:id/share 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 링크를 생성하지 못했습니다.' });
  }
});

// DELETE /api/orders/:id/share — 공유 해제
app.delete('/api/orders/:id/share', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 발주서 id 형식입니다.' });
    const r = await pool.query(
      'UPDATE interior_orders SET share_token=NULL, share_password_hash=NULL WHERE id=$1 RETURNING id',
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: '해당 발주서를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/orders/:id/share 오류:', err.message);
    res.status(500).json({ success: false, message: '공유를 해제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 미팅(interior_meetings) — 프로젝트(현장) 종속, CASCADE
// ========================================
app.get('/api/sites/:id/meetings', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${MEETING_COLS} FROM interior_meetings WHERE site_id=$1 ORDER BY meeting_date DESC NULLS LAST, id DESC`,
      [id]
    );
    res.json(rows.map(rowToMeeting));
  } catch (err) {
    console.error('GET /api/sites/:id/meetings 오류:', err.message);
    res.status(500).json({ success: false, message: '미팅 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/sites/:id/meetings', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const check = validateMeeting(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    const { rows } = await pool.query(
      `INSERT INTO interior_meetings (site_id, meeting_date, title, attendees, content, next_action)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${MEETING_COLS}`,
      [id, v.meeting_date, v.title, v.attendees, v.content, v.next_action]
    );
    res.status(201).json(rowToMeeting(rows[0]));
  } catch (err) {
    console.error('POST /api/sites/:id/meetings 오류:', err.message);
    res.status(500).json({ success: false, message: '미팅을 저장하지 못했습니다.' });
  }
});

app.put('/api/meetings/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 미팅 id 형식입니다.' });
    const check = validateMeeting(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_meetings
       SET meeting_date=$1, title=$2, attendees=$3, content=$4, next_action=$5
       WHERE id=$6 RETURNING ${MEETING_COLS}`,
      [v.meeting_date, v.title, v.attendees, v.content, v.next_action, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 미팅을 찾을 수 없습니다.' });
    res.json(rowToMeeting(rows[0]));
  } catch (err) {
    console.error('PUT /api/meetings/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '미팅을 수정하지 못했습니다.' });
  }
});

app.delete('/api/meetings/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 미팅 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_meetings WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 미팅을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/meetings/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '미팅을 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — AS(interior_as) — 프로젝트(현장) 종속, CASCADE
//   status 는 AS_STATES 외 값이면 '접수' 보정. cost 0 이상 정수.
// ========================================
app.get('/api/sites/:id/as', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${AS_COLS} FROM interior_as WHERE site_id=$1 ORDER BY received_date DESC NULLS LAST, id DESC`,
      [id]
    );
    res.json(rows.map(rowToAS));
  } catch (err) {
    console.error('GET /api/sites/:id/as 오류:', err.message);
    res.status(500).json({ success: false, message: 'AS 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/sites/:id/as', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const check = validateAS(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;

    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    const { rows } = await pool.query(
      `INSERT INTO interior_as (site_id, received_date, title, detail, status, handled_date, staff, cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${AS_COLS}`,
      [id, v.received_date, v.title, v.detail, v.status, v.handled_date, v.staff, v.cost]
    );
    res.status(201).json(rowToAS(rows[0]));
  } catch (err) {
    console.error('POST /api/sites/:id/as 오류:', err.message);
    res.status(500).json({ success: false, message: 'AS 를 저장하지 못했습니다.' });
  }
});

app.put('/api/as/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 AS id 형식입니다.' });
    const check = validateAS(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_as
       SET received_date=$1, title=$2, detail=$3, status=$4, handled_date=$5, staff=$6, cost=$7
       WHERE id=$8 RETURNING ${AS_COLS}`,
      [v.received_date, v.title, v.detail, v.status, v.handled_date, v.staff, v.cost, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 AS 를 찾을 수 없습니다.' });
    res.json(rowToAS(rows[0]));
  } catch (err) {
    console.error('PUT /api/as/:id 오류:', err.message);
    res.status(500).json({ success: false, message: 'AS 를 수정하지 못했습니다.' });
  }
});

app.delete('/api/as/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 AS id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_as WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 AS 를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/as/:id 오류:', err.message);
    res.status(500).json({ success: false, message: 'AS 를 삭제하지 못했습니다.' });
  }
});

// ========================================
// v7 — 영수증 OCR 분석 (POST /api/receipts/analyze) — OpenAI gpt-4o 비전
// 금액·날짜는 정확 추출, 카테고리는 비용 카테고리 목록 기반 추론(틀릴 수 있음 → 폼에서 수정).
// 새 패키지 없이 Node 내장 fetch 로 OpenAI Chat Completions 직접 호출. 응답은 raw JSON.
// ========================================
app.post('/api/receipts/analyze', async (req, res) => {
  try {
    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) {
      // 키는 절대 로그/응답에 노출하지 않는다.
      return res.status(503).json({ error: 'OPENAI_API_KEY 미설정' });
    }

    const body = req.body || {};
    const image = typeof body.image === 'string' ? body.image.trim() : '';
    if (!image) {
      return res.status(400).json({ error: 'image(영수증 data URI)는 필수입니다.' });
    }

    // (v13) site_id 가 주어지면 팀 소유 검증 (아니면 404)
    if (body.site_id !== undefined && body.site_id !== null && body.site_id !== '') {
      const sid = parseId(body.site_id);
      if (!sid) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
      const own = await pool.query('SELECT 1 FROM interior_sites WHERE id=$1 AND team_id=$2', [sid, req.teamId]);
      if (own.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    }

    // 현재 비용 카테고리(kind='cost', active) 목록 → 추론 가이드로 프롬프트에 포함.
    let catNames = [];
    try {
      const catQ = await pool.query(
        "SELECT name FROM interior_categories WHERE kind='cost' AND active = TRUE AND team_id=$1 ORDER BY sort_order ASC, name ASC",
        [req.teamId]
      );
      catNames = catQ.rows.map((r) => r.name).filter(Boolean);
    } catch (_) {
      /* 카테고리 조회 실패 시 기본값으로 폴백 */
    }
    if (catNames.length === 0) {
      catNames = ['자재비', '인건비', '장비/공구', '운반/물류', '폐기물처리', '가설/안전', '외주(하도급)', '경비(식대/유류)', '임대료', '기타'];
    }

    const systemPrompt =
      '당신은 한국 인테리어 현장의 영수증/세금계산서 이미지를 분석하는 어시스턴트입니다. ' +
      '이미지에서 아래 항목을 추출해 JSON 객체 하나로만 응답하세요.\n' +
      '- amount: 합계/총액을 원(KRW) 정수로(콤마·"원" 제거, 예: 55000). 불명확하면 0.\n' +
      '- date: 거래일자를 "YYYY-MM-DD" 형식으로. 없으면 빈 문자열 "".\n' +
      '- category: 다음 비용 카테고리 중 영수증 내용에 가장 가까운 1개만 고르세요: [' +
      catNames.join(', ') +
      ']. 불명확하면 "기타".\n' +
      '- vendor: 상호(거래처명). 없으면 "".\n' +
      '- memo: 주요 품목 요약(짧게). 없으면 "".\n' +
      '- confidence: 추출 신뢰도 0~1 사이 숫자.\n' +
      '반드시 위 키들만 가진 JSON 객체로 답하세요.';

    const payload = {
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: '이 영수증을 분석해 위 JSON 형식으로만 답하세요.' },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
    };

    // OpenAI 호출 (Node 18+ 내장 fetch + 타임아웃)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let apiRes;
    try {
      apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const detail = e && e.name === 'AbortError' ? '응답 시간 초과(60초)' : String((e && e.message) || e);
      return res.status(502).json({ error: 'OpenAI 호출에 실패했습니다.', detail });
    }
    clearTimeout(timer);

    if (!apiRes.ok) {
      let detail = `OpenAI 응답 코드 ${apiRes.status}`;
      try {
        const errBody = await apiRes.json();
        if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
      } catch (_) {
        /* 본문 파싱 실패는 무시하고 상태코드만 */
      }
      console.error('OpenAI receipts/analyze 실패 status:', apiRes.status); // 키는 로깅하지 않음
      return res.status(502).json({ error: 'OpenAI 호출에 실패했습니다.', detail });
    }

    let apiJson;
    try {
      apiJson = await apiRes.json();
    } catch (e) {
      return res.status(502).json({ error: 'OpenAI 응답을 파싱하지 못했습니다.', detail: String((e && e.message) || e) });
    }

    const content =
      apiJson && apiJson.choices && apiJson.choices[0] && apiJson.choices[0].message
        ? apiJson.choices[0].message.content
        : '';
    if (!content) {
      return res.status(502).json({ error: 'OpenAI 응답이 비어 있습니다.', detail: '분석 결과 없음' });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(502).json({ error: '분석 결과 JSON 파싱에 실패했습니다.', detail: String((e && e.message) || e) });
    }

    // 값 정규화 (계약: amount 정수, date 'YYYY-MM-DD'|'', category 목록 내 1개)
    const toIntAmount = (v) => {
      if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
      if (typeof v === 'string') {
        const digits = v.replace(/[^0-9]/g, '');
        if (digits) return parseInt(digits, 10);
      }
      return 0;
    };
    const toYmd = (v) => {
      if (typeof v !== 'string') return '';
      const s = v.trim().replace(/[./]/g, '-');
      const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (!m) return '';
      const ymd = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      return isRealDate(ymd) ? ymd : '';
    };

    let category = typeof parsed.category === 'string' ? parsed.category.trim() : '';
    if (!catNames.includes(category)) category = '기타';

    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));

    const result = {
      amount: toIntAmount(parsed.amount),
      date: toYmd(parsed.date),
      category,
      vendor: typeof parsed.vendor === 'string' ? parsed.vendor.trim() : '',
      memo: typeof parsed.memo === 'string' ? parsed.memo.trim() : '',
      confidence,
      model: 'gpt-4o',
    };

    // (선택, 베스트에포트) site_id 있으면 현장 폴더 sites/<folder>/receipts/ 에 이미지 저장.
    // 저장 실패해도 분석 결과는 정상 반환(try/catch 격리).
    const siteIdRaw = body.site_id;
    if (siteIdRaw !== undefined && siteIdRaw !== null && siteIdRaw !== '') {
      try {
        const sid = parseId(siteIdRaw);
        if (sid) {
          const siteQ = await pool.query('SELECT name, folder FROM interior_sites WHERE id=$1', [sid]);
          if (siteQ.rows.length > 0) {
            const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(image);
            if (m) {
              const buf = Buffer.from(m[1], 'base64');
              let folderRel = siteQ.rows[0].folder;
              if (!folderRel) folderRel = createSiteFolder(siteQ.rows[0].name);
              // 경로 탈출 방어: 반드시 sites/ 하위
              const sitesRoot = path.join(__dirname, 'sites');
              const folderAbs = path.join(__dirname, folderRel);
              if (folderAbs !== sitesRoot && !folderAbs.startsWith(sitesRoot + path.sep)) {
                folderRel = createSiteFolder(siteQ.rows[0].name);
              }
              const receiptsDir = path.join(__dirname, folderRel, 'receipts');
              fs.mkdirSync(receiptsDir, { recursive: true });
              const fname = `receipt-${Date.now()}.jpg`;
              fs.writeFileSync(path.join(receiptsDir, fname), buf);
              result.saved = path.join(folderRel, 'receipts', fname);
            }
          }
        }
      } catch (saveErr) {
        console.error('영수증 이미지 저장 실패(무시):', saveErr.message);
      }
    }

    res.json(result);
  } catch (err) {
    console.error('POST /api/receipts/analyze 오류:', err.message);
    res.status(502).json({ error: '영수증 분석 중 오류가 발생했습니다.', detail: err.message });
  }
});

// ========================================
// (v8) 스케치업/실측 물량(takeoff) + 프로젝트 zip 백업
//   v1~v7 동작/엔드포인트/스키마 100% 보존. 아래 라우트는 catch-all('*') 앞.
// ========================================

// takeoff SELECT 컬럼 (qty 는 rowToTakeoff 에서 Number 직렬화). (v27) +material_code
const TAKEOFF_COLS = 'id, site_id, trade, name, spec, unit, qty, source, source_guid, memo, material_code, created_at';

function rowToTakeoff(row) {
  return {
    id: row.id,
    site_id: row.site_id,
    trade: row.trade || '',
    name: row.name,
    spec: row.spec || '',
    unit: row.unit || '',
    qty: Number(row.qty), // NUMERIC → Number (물량/길이/면적)
    source: row.source || 'manual',
    source_guid: row.source_guid || '',
    memo: row.memo || '',
    material_code: row.material_code || '', // (v27) 자재 코드 (빈값=비코드 행)
    created_at: new Date(row.created_at).toISOString(),
  };
}

// takeoff 항목 검증. name 필수, qty≥0(기본0), source 화이트리스트('sketchup'|'manual', 기본 manual).
function validateTakeoff(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { valid: false, message: 'name(품목/부재명) 은 필수입니다.' };

  let qty = 0;
  if (b.qty !== undefined && b.qty !== null && b.qty !== '') {
    qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      return { valid: false, message: 'qty(물량) 은 0 이상의 숫자여야 합니다.' };
    }
  }

  let source = 'manual';
  if (typeof b.source === 'string' && b.source.trim()) {
    source = b.source.trim() === 'sketchup' ? 'sketchup' : 'manual';
  }

  return {
    valid: true,
    values: {
      trade: typeof b.trade === 'string' ? b.trade.trim() : '',
      name,
      spec: typeof b.spec === 'string' ? b.spec.trim() : '',
      unit: typeof b.unit === 'string' ? b.unit.trim() : '',
      qty,
      source,
      source_guid: typeof b.source_guid === 'string' ? b.source_guid.trim() : '',
      memo: typeof b.memo === 'string' ? b.memo.trim() : '',
      // (v27) 자재 코드 — 미전달이면 INSERT 시 '', PUT 은 provided 플래그로 기존값 보존(COALESCE)
      material_code: typeof b.material_code === 'string' ? b.material_code.trim() : '',
      material_code_provided: b.material_code !== undefined,
    },
  };
}

// 여러 takeoff 행을 한 번의 multi-row INSERT 로 적재 → rowToTakeoff 배열 반환.
//   (v23) db 인자: 트랜잭션 client 를 넘기면 그 안에서 실행(기본 pool — 기존 호출 무영향).
async function insertTakeoffRows(siteId, valsArr, db = pool) {
  if (!valsArr || valsArr.length === 0) return [];
  const cols = ['site_id', 'trade', 'name', 'spec', 'unit', 'qty', 'source', 'source_guid', 'memo', 'material_code']; // (v27) +material_code
  const placeholders = [];
  const params = [];
  valsArr.forEach((v, i) => {
    const base = i * cols.length;
    placeholders.push('(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')');
    params.push(siteId, v.trade, v.name, v.spec, v.unit, v.qty, v.source, v.source_guid, v.memo, v.material_code || '');
  });
  const { rows } = await db.query(
    `INSERT INTO interior_takeoff (${cols.join(', ')}) VALUES ${placeholders.join(', ')} RETURNING ${TAKEOFF_COLS}`,
    params
  );
  return rows.map(rowToTakeoff);
}

// GET /api/sites/:id/takeoff — 현장 물량 목록 (created_at DESC)
app.get('/api/sites/:id/takeoff', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${TAKEOFF_COLS} FROM interior_takeoff WHERE site_id=$1 ORDER BY created_at DESC, id DESC`,
      [id]
    );
    res.json(rows.map(rowToTakeoff));
  } catch (err) {
    console.error('GET /api/sites/:id/takeoff 오류:', err.message);
    res.status(500).json({ success: false, message: '물량 목록을 불러오지 못했습니다.' });
  }
});

// POST /api/sites/:id/takeoff — 단건 {..} 또는 배치 {items:[..]} → 201
//   (v23) ?replace_sketchup=1 — 스케치업 CSV 재임포트용: source='sketchup' 기존행을 지우고
//   배치를 넣는다(트랜잭션 — 삭제만 되고 삽입 실패하는 부분 상태 방지). 수기(manual) 물량은 보존.
app.post('/api/sites/:id/takeoff', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    const body = req.body || {};
    const isBatch = Array.isArray(body.items);
    const rawItems = isBatch ? body.items : [body];
    if (rawItems.length === 0) return res.status(400).json({ success: false, message: '저장할 물량 항목이 없습니다.' });

    const vals = [];
    for (const it of rawItems) {
      const check = validateTakeoff(it);
      if (!check.valid) return res.status(400).json({ success: false, message: check.message });
      vals.push(check.values);
    }

    const replaceSketchup = String(req.query.replace_sketchup || '') === '1';
    let inserted;
    if (replaceSketchup) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM interior_takeoff WHERE site_id=$1 AND source='sketchup'`, [id]);
        inserted = await insertTakeoffRows(id, vals, client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } else {
      inserted = await insertTakeoffRows(id, vals);
    }
    // 단건 요청 → 객체, 배치 요청 → 배열 (orders 등 단건 객체 규약과 일관)
    res.status(201).json(isBatch ? inserted : inserted[0]);
  } catch (err) {
    console.error('POST /api/sites/:id/takeoff 오류:', err.message);
    res.status(500).json({ success: false, message: '물량을 저장하지 못했습니다.' });
  }
});

// PUT /api/takeoff/:id — 물량 수정
app.put('/api/takeoff/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 물량 id 형식입니다.' });
    const check = validateTakeoff(req.body);
    if (!check.valid) return res.status(400).json({ success: false, message: check.message });
    const v = check.values;
    const { rows } = await pool.query(
      `UPDATE interior_takeoff
       SET trade=$1, name=$2, spec=$3, unit=$4, qty=$5, source=$6, source_guid=$7, memo=$8,
           material_code=COALESCE($9, material_code)
       WHERE id=$10 RETURNING ${TAKEOFF_COLS}`,
      [v.trade, v.name, v.spec, v.unit, v.qty, v.source, v.source_guid, v.memo,
       v.material_code_provided ? v.material_code : null, id] // (v27) 미전달 시 기존 코드 보존
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 물량 항목을 찾을 수 없습니다.' });
    res.json(rowToTakeoff(rows[0]));
  } catch (err) {
    console.error('PUT /api/takeoff/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '물량을 수정하지 못했습니다.' });
  }
});

// DELETE /api/takeoff/:id
app.delete('/api/takeoff/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 물량 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_takeoff WHERE id=$1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 물량 항목을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/takeoff/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '물량을 삭제하지 못했습니다.' });
  }
});

// POST /api/sites/:id/import/sketchup — 스케치업 물량 일괄 import (전부 source='sketchup')
//   body {items:[{trade,name,spec?,unit?,qty,source_guid?}]} → {imported:n, items:[...]}
//   이 JSON 포맷이 스케치업↔앱 계약(물량/치수만; 단가·내용은 앱에서 입력).
//   NOTE: source_guid 멱등(있으면 update)은 향후 플러그인 연동 시 도입 — 지금은 단순 일괄 insert.
app.post('/api/sites/:id/import/sketchup', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const site = await pool.query('SELECT id FROM interior_sites WHERE id=$1', [id]);
    if (site.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    const body = req.body || {};
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ success: false, message: 'items 배열(스케치업 물량) 이 필요합니다.' });
    }

    const vals = [];
    for (const it of body.items) {
      const check = validateTakeoff(it);
      if (!check.valid) return res.status(400).json({ success: false, message: check.message });
      const v = check.values;
      v.source = 'sketchup'; // 출처 강제
      vals.push(v);
    }

    const inserted = await insertTakeoffRows(id, vals);
    res.status(201).json({ imported: inserted.length, items: inserted });
  } catch (err) {
    console.error('POST /api/sites/:id/import/sketchup 오류:', err.message);
    res.status(500).json({ success: false, message: '스케치업 물량을 가져오지 못했습니다.' });
  }
});

// ----------------------------------------
// (v8) 백업 데이터 수집 — 기존 도메인 SELECT/COLS/rowTo*/computeTotals 를 그대로 재사용.
//   현장 없으면 null. 이 객체가 data.json 본문이 된다.
// ----------------------------------------
async function buildSiteBackup(siteId) {
  const siteQ = await pool.query(`SELECT ${SITE_COLS} FROM interior_sites WHERE id=$1`, [siteId]);
  if (siteQ.rows.length === 0) return null;
  const site = rowToSite(siteQ.rows[0]);

  // costs (GET /costs 와 동일)
  const costsQ = await pool.query(
    `SELECT ${COST_COLS} FROM interior_costs WHERE site_id=$1 ORDER BY date DESC, created_at DESC`,
    [siteId]
  );
  const costs = costsQ.rows.map(rowToCost);

  // schedule + deps (GET /schedule 와 동일 — N+1 없이 dep 1회 조회 매핑)
  const schQ = await pool.query(
    `SELECT ${SCHEDULE_SELECT_COLS} FROM interior_schedule s WHERE s.site_id=$1
     ORDER BY s.start_date ASC, s.sort_order ASC, s.id ASC`,
    [siteId]
  );
  const schedules = schQ.rows.map(rowToSchedule);
  const schIds = schedules.map((s) => s.id);
  const predMap = {};
  const succMap = {};
  if (schIds.length > 0) {
    const depQ = await pool.query(
      `SELECT predecessor_id, successor_id FROM interior_schedule_deps
       WHERE predecessor_id = ANY($1::bigint[]) OR successor_id = ANY($1::bigint[])`,
      [schIds]
    );
    for (const d of depQ.rows) {
      const p = String(d.predecessor_id);
      const su = String(d.successor_id);
      (succMap[p] = succMap[p] || []).push(su);
      (predMap[su] = predMap[su] || []).push(p);
    }
  }
  const schedule = schedules.map((s) => ({ ...s, predecessors: predMap[s.id] || [], successors: succMap[s.id] || [] }));

  // estimates + items + totals (GET /estimates/:id 와 동일)
  const estQ = await pool.query(
    `SELECT ${ESTIMATE_COLS} FROM interior_estimates WHERE site_id=$1 ORDER BY created_at DESC, id DESC`,
    [siteId]
  );
  const estimates = [];
  for (const r of estQ.rows) {
    const est = rowToEstimate(r);
    const itemsQ = await pool.query(
      `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
      [est.id]
    );
    const items = itemsQ.rows.map(rowToItem);
    const totals = computeTotals(est, items);
    estimates.push({ ...est, items, totals });
  }

  // orders / meetings / as (각 GET 과 동일)
  const ordersQ = await pool.query(
    `SELECT ${ORDER_COLS} FROM interior_orders WHERE site_id=$1 ORDER BY order_date DESC NULLS LAST, id DESC`,
    [siteId]
  );
  const orders = ordersQ.rows.map(rowToOrder);

  const meetingsQ = await pool.query(
    `SELECT ${MEETING_COLS} FROM interior_meetings WHERE site_id=$1 ORDER BY meeting_date DESC NULLS LAST, id DESC`,
    [siteId]
  );
  const meetings = meetingsQ.rows.map(rowToMeeting);

  const asQ = await pool.query(
    `SELECT ${AS_COLS} FROM interior_as WHERE site_id=$1 ORDER BY received_date DESC NULLS LAST, id DESC`,
    [siteId]
  );
  const as = asQ.rows.map(rowToAS);

  // takeoff (v8)
  const takeoffQ = await pool.query(
    `SELECT ${TAKEOFF_COLS} FROM interior_takeoff WHERE site_id=$1 ORDER BY created_at DESC, id DESC`,
    [siteId]
  );
  const takeoff = takeoffQ.rows.map(rowToTakeoff);

  return { site, costs, schedule, estimates, orders, meetings, as, takeoff, exportedAt: new Date().toISOString() };
}

// 백업 README.txt (한글 요약)
function buildBackupReadme(backup) {
  const s = backup.site;
  const L = [];
  L.push('인테리어 현장 프로젝트 백업');
  L.push('========================================');
  L.push(`현장명     : ${s.name}`);
  L.push(`주소       : ${s.address || '-'}`);
  L.push(`고객/발주처 : ${s.client || '-'}`);
  L.push(`진행상태   : ${s.progress_status || '-'}`);
  L.push(`백업일시   : ${backup.exportedAt}`);
  L.push('');
  L.push('[포함 항목 요약]');
  L.push(`- 비용 내역(costs)   : ${backup.costs.length} 건`);
  L.push(`- 일정(schedule)     : ${backup.schedule.length} 건`);
  L.push(`- 견적서(estimates)  : ${backup.estimates.length} 건`);
  L.push(`- 발주서(orders)     : ${backup.orders.length} 건`);
  L.push(`- 미팅(meetings)     : ${backup.meetings.length} 건`);
  L.push(`- AS(as)             : ${backup.as.length} 건`);
  L.push(`- 물량(takeoff)      : ${backup.takeoff.length} 건`);
  L.push('');
  L.push('[파일 구성]');
  L.push('- data.json  : 현장 전체 데이터(JSON)');
  L.push('- receipts/  : 영수증 이미지(있는 경우)');
  L.push('- README.txt : 본 안내 파일');
  L.push('');
  L.push('※ data.json 은 보관용이며, 앱에서 다시 참조할 수 있습니다.');
  return L.join('\n');
}

// GET /api/sites/:id/backup.zip — 현장 전체를 zip 스트림으로 다운로드
app.get('/api/sites/:id/backup.zip', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

  let backup;
  try {
    backup = await buildSiteBackup(id);
  } catch (err) {
    console.error('GET /api/sites/:id/backup.zip 데이터 수집 오류:', err.message);
    return res.status(500).json({ success: false, message: '백업 데이터를 수집하지 못했습니다.' });
  }
  if (!backup) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

  const site = backup.site;
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const downloadBase = `${site.name}-backup-${dateStr}.zip`;
  // 현장명 ASCII 안전 처리(헤더값) + filename* 로 UTF-8 원본도 전달.
  const asciiName =
    downloadBase.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || `backup-${dateStr}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadBase)}`
  );

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('warning', (err) => {
    console.warn('backup.zip archiver 경고:', err && err.message);
  });
  archive.on('error', (err) => {
    console.error('backup.zip archiver 오류:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'zip 생성 중 오류가 발생했습니다.' });
    } else {
      try {
        res.destroy(err);
      } catch (_) {
        /* noop */
      }
    }
  });

  archive.pipe(res);

  // 1) data.json — 현장 전체 데이터
  archive.append(JSON.stringify(backup, null, 2), { name: 'data.json' });
  // 2) README.txt — 한글 요약
  archive.append(buildBackupReadme(backup), { name: 'README.txt' });

  // 3) receipts/ — sites/<folder>/receipts/ 의 파일 전부 (있으면; 경로탈출 가드)
  try {
    const folderRel = site.folder || path.join('sites', sanitizeSiteName(site.name));
    const sitesRoot = path.join(__dirname, 'sites');
    const receiptsAbs = path.join(__dirname, folderRel, 'receipts');
    // 반드시 sites/ 하위여야 포함 (경로 탈출 방어)
    const underSites = receiptsAbs === sitesRoot || receiptsAbs.startsWith(sitesRoot + path.sep);
    if (underSites && fs.existsSync(receiptsAbs) && fs.statSync(receiptsAbs).isDirectory()) {
      for (const ent of fs.readdirSync(receiptsAbs, { withFileTypes: true })) {
        if (ent.isFile()) {
          archive.file(path.join(receiptsAbs, ent.name), { name: path.join('receipts', ent.name) });
        }
      }
    }
  } catch (rErr) {
    console.warn('backup.zip receipts 포함 실패(무시):', rErr.message);
  }

  archive.finalize();
});

// ========================================
// (v17) 공개 공유 열람 (무인증 — 위 인증 게이트에서 /api/share/* 예외). 팀 무관, 토큰으로만 조회. 민감필드 제외.
//   rowToEstimate/rowToOrder 는 화이트리스트 매핑 → team_id/share_token/share_password_hash 절대 노출 안 됨.
// ========================================
const SHARE_SUPPLIER = { name: '안도공간', phone: '', address: '', email: '' }; // 읽기전용 공유 뷰 공급자 정보

// 공유용 현장 요약(name/address/client 만). 없으면 null.
async function sharedSiteSummary(siteId) {
  if (siteId == null) return null;
  const sQ = await pool.query('SELECT name, address, client FROM interior_sites WHERE id=$1', [siteId]);
  if (sQ.rows.length === 0) return null;
  const s = sQ.rows[0];
  return { name: s.name, address: s.address || '', client: s.client || '' };
}

// 견적 공개 데이터: 헤더 + items + totals + 현장요약 + 공급자. (민감필드 미포함)
async function buildSharedEstimate(estRow) {
  const est = rowToEstimate(estRow);
  const itemsQ = await pool.query(
    `SELECT ${ITEM_COLS} FROM interior_estimate_items WHERE estimate_id=$1 ORDER BY sort_order ASC, id ASC`,
    [est.id]
  );
  const items = itemsQ.rows.map(rowToItem);
  const totals = computeTotals(est, items);
  return { estimate: { ...est, items, totals }, site: await sharedSiteSummary(est.site_id), supplier: SHARE_SUPPLIER };
}

// 발주 공개 데이터: 발주 헤더 + 현장요약 + 공급자. (발주는 라인아이템 없음)
async function buildSharedOrder(orderRow) {
  const order = rowToOrder(orderRow);
  return { order, site: await sharedSiteSummary(order.site_id), supplier: SHARE_SUPPLIER };
}

// GET /api/share/estimate/:token — 무인증. 비번설정 시 requiresPassword(데이터 없음). 없는 토큰 404.
app.get('/api/share/estimate/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(404).json({ success: false, message: '공유 견적을 찾을 수 없습니다.' });
    const q = await pool.query(
      `SELECT ${ESTIMATE_COLS}, share_password_hash FROM interior_estimates WHERE share_token=$1`,
      [token]
    );
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '공유 견적을 찾을 수 없습니다.' });
    if (q.rows[0].share_password_hash) return res.json({ requiresPassword: true }); // 데이터 미포함
    res.json(await buildSharedEstimate(q.rows[0]));
  } catch (err) {
    console.error('GET /api/share/estimate/:token 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 견적을 불러오지 못했습니다.' });
  }
});

// POST /api/share/estimate/:token body {password} — 비번 검증 실패 401, 성공 시 데이터.
app.post('/api/share/estimate/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(404).json({ success: false, message: '공유 견적을 찾을 수 없습니다.' });
    const q = await pool.query(
      `SELECT ${ESTIMATE_COLS}, share_password_hash FROM interior_estimates WHERE share_token=$1`,
      [token]
    );
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '공유 견적을 찾을 수 없습니다.' });
    const hash = q.rows[0].share_password_hash;
    if (hash) {
      const pw = typeof (req.body || {}).password === 'string' ? req.body.password : '';
      const ok = pw ? await bcrypt.compare(pw, hash) : false;
      if (!ok) return res.status(401).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
    }
    res.json(await buildSharedEstimate(q.rows[0]));
  } catch (err) {
    console.error('POST /api/share/estimate/:token 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 견적을 불러오지 못했습니다.' });
  }
});

// GET /api/share/order/:token — 무인증. (발주 동형)
app.get('/api/share/order/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(404).json({ success: false, message: '공유 발주서를 찾을 수 없습니다.' });
    const q = await pool.query(
      `SELECT ${ORDER_COLS}, share_password_hash FROM interior_orders WHERE share_token=$1`,
      [token]
    );
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '공유 발주서를 찾을 수 없습니다.' });
    if (q.rows[0].share_password_hash) return res.json({ requiresPassword: true });
    res.json(await buildSharedOrder(q.rows[0]));
  } catch (err) {
    console.error('GET /api/share/order/:token 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 발주서를 불러오지 못했습니다.' });
  }
});

// POST /api/share/order/:token body {password} — 비번 검증 실패 401, 성공 시 데이터.
app.post('/api/share/order/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(404).json({ success: false, message: '공유 발주서를 찾을 수 없습니다.' });
    const q = await pool.query(
      `SELECT ${ORDER_COLS}, share_password_hash FROM interior_orders WHERE share_token=$1`,
      [token]
    );
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '공유 발주서를 찾을 수 없습니다.' });
    const hash = q.rows[0].share_password_hash;
    if (hash) {
      const pw = typeof (req.body || {}).password === 'string' ? req.body.password : '';
      const ok = pw ? await bcrypt.compare(pw, hash) : false;
      if (!ok) return res.status(401).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
    }
    res.json(await buildSharedOrder(q.rows[0]));
  } catch (err) {
    console.error('POST /api/share/order/:token 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 발주서를 불러오지 못했습니다.' });
  }
});

// ========================================
// (v22 / #3) 클라이언트 페이지 공유 — 현장 단위 공개 뷰(요약/일정/현장사진/자료).
//   · 관리(GET/POST/DELETE /api/sites/:id/client-share)는 인증·팀 스코핑(/api/sites/:id 소유검증 미들웨어).
//   · 공개(GET/POST /api/share/client/:token)는 무인증 — 기존 /api/share/* 예외 재사용. v17 견적/발주와 동형.
//   · payload 는 화이트리스트: 비용/금액/팀/토큰/내부담당(uploader·staff) 절대 미포함.
// ========================================

// GET /api/sites/:id/client-share — 현재 공유 상태(UI 초기값). 토큰 없으면 {share_token:null}.
app.get('/api/sites/:id/client-share', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const q = await pool.query('SELECT client_share_token, client_share_password_hash FROM interior_sites WHERE id=$1', [id]);
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    res.json({ share_token: q.rows[0].client_share_token || null, hasPassword: !!q.rows[0].client_share_password_hash });
  } catch (err) {
    console.error('GET /api/sites/:id/client-share 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 상태를 불러오지 못했습니다.' });
  }
});

// POST /api/sites/:id/client-share — 공유 활성화 + 선택적 비번 (견적 share 와 동형 시맨틱).
//   토큰 없으면 crypto 발급(있으면 유지). body.password 키 있으면 설정(빈문자→해시 제거), 없으면 기존 유지.
app.post('/api/sites/:id/client-share', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });

    const cur = await pool.query('SELECT client_share_token, client_share_password_hash FROM interior_sites WHERE id=$1', [id]);
    if (cur.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });

    let token = cur.rows[0].client_share_token;
    if (!token) token = crypto.randomBytes(16).toString('hex');

    const body = req.body || {};
    let hash = cur.rows[0].client_share_password_hash;
    if (Object.prototype.hasOwnProperty.call(body, 'password')) {
      const pw = typeof body.password === 'string' ? body.password : '';
      hash = pw ? await bcrypt.hash(pw, 10) : null;
    }

    await pool.query('UPDATE interior_sites SET client_share_token=$1, client_share_password_hash=$2 WHERE id=$3', [token, hash, id]);
    res.json({ share_token: token, url: '/share/client/' + token, hasPassword: !!hash });
  } catch (err) {
    console.error('POST /api/sites/:id/client-share 오류:', err.message);
    res.status(500).json({ success: false, message: '클라이언트 공유 링크를 생성하지 못했습니다.' });
  }
});

// DELETE /api/sites/:id/client-share — 공유 해제(토큰/해시 NULL).
app.delete('/api/sites/:id/client-share', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const r = await pool.query(
      'UPDATE interior_sites SET client_share_token=NULL, client_share_password_hash=NULL WHERE id=$1 RETURNING id',
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/sites/:id/client-share 오류:', err.message);
    res.status(500).json({ success: false, message: '클라이언트 공유를 해제하지 못했습니다.' });
  }
});

// 공유 payload — 화이트리스트만. 사진/자료 서명 URL 은 일괄 발급(스토리지 미설정/경로없음 → null).
async function buildSharedClient(siteRow) {
  const siteId = siteRow.id;
  const site = {
    name: siteRow.name,
    address: siteRow.address || '',
    building_type: siteRow.building_type || '',
    floor_area: Number(siteRow.floor_area || 0),
    start_date: siteRow.start_date, // 'YYYY-MM-DD' | null (to_char)
    end_date: siteRow.end_date,
    move_in_date: siteRow.move_in_date,
    progress_status: siteRow.progress_status || '준비',
    status: siteRow.status || '진행',
  };

  // 일정: 미팅 제외, 금액(planned_cost/actual_cost)·내부담당(staff)·메모 미포함.
  const sch = await pool.query(
    `SELECT id, title, process, to_char(start_date,'YYYY-MM-DD') AS start_date,
            to_char(end_date,'YYYY-MM-DD') AS end_date, status, kind
       FROM interior_schedule
      WHERE site_id=$1 AND kind <> '미팅'
      ORDER BY start_date ASC, id ASC`,
    [siteId]
  );
  const schedule = sch.rows.map((r) => ({
    id: String(r.id), title: r.title, process: r.process || '',
    start_date: r.start_date, end_date: r.end_date,
    status: r.status || '예정', kind: r.kind || '공사',
  }));

  // 서명 URL 발급 헬퍼 — 실패/미설정 시 null (뷰에서 플레이스홀더 처리).
  const canSign = storageConfigured();
  const signOrNull = async (path) => {
    if (!canSign || !path) return null;
    try { return await signDownloadUrl(path); } catch (e) { return null; }
  };

  const ph = await pool.query(
    `SELECT ${PHOTO_COLS} FROM interior_photos WHERE site_id=$1 ORDER BY photo_date DESC NULLS LAST, created_at DESC, id DESC`,
    [siteId]
  );
  const photos = await Promise.all(ph.rows.map(async (r) => ({
    id: String(r.id), photo_date: r.photo_date, processes: r.processes || '',
    file_name: r.file_name || '', memo: r.memo || '',
    created_at: new Date(r.created_at).toISOString(),
    url: await signOrNull(r.storage_path),
  })));

  const dc = await pool.query(
    `SELECT ${DOCUMENT_COLS} FROM interior_documents WHERE site_id=$1 ORDER BY created_at DESC, id DESC`,
    [siteId]
  );
  const documents = await Promise.all(dc.rows.map(async (r) => ({
    id: String(r.id), name: r.name, doc_type: r.doc_type || '기타',
    file_name: r.file_name || '', file_size: Number(r.file_size || 0), memo: r.memo || '',
    created_at: new Date(r.created_at).toISOString(),
    url: await signOrNull(r.storage_path),
  })));

  return { site, schedule, photos, documents };
}

// GET /api/share/client/:token — 무인증. 비번설정 시 requiresPassword(데이터 없음). 없는 토큰 404.
app.get('/api/share/client/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(404).json({ success: false, message: '공유 페이지를 찾을 수 없습니다.' });
    const q = await pool.query(
      `SELECT ${SITE_COLS}, client_share_password_hash FROM interior_sites WHERE client_share_token=$1`,
      [token]
    );
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '공유 페이지를 찾을 수 없습니다.' });
    if (q.rows[0].client_share_password_hash) return res.json({ requiresPassword: true });
    res.json(await buildSharedClient(q.rows[0]));
  } catch (err) {
    console.error('GET /api/share/client/:token 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 페이지를 불러오지 못했습니다.' });
  }
});

// POST /api/share/client/:token body {password} — 비번 검증 실패 401, 성공 시 payload.
app.post('/api/share/client/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(404).json({ success: false, message: '공유 페이지를 찾을 수 없습니다.' });
    const q = await pool.query(
      `SELECT ${SITE_COLS}, client_share_password_hash FROM interior_sites WHERE client_share_token=$1`,
      [token]
    );
    if (q.rows.length === 0) return res.status(404).json({ success: false, message: '공유 페이지를 찾을 수 없습니다.' });
    const hash = q.rows[0].client_share_password_hash;
    if (hash) {
      const pw = typeof (req.body || {}).password === 'string' ? req.body.password : '';
      const ok = pw ? await bcrypt.compare(pw, hash) : false;
      if (!ok) return res.status(401).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
    }
    res.json(await buildSharedClient(q.rows[0]));
  } catch (err) {
    console.error('POST /api/share/client/:token 오류:', err.message);
    res.status(500).json({ success: false, message: '공유 페이지를 불러오지 못했습니다.' });
  }
});

// ========================================
// (v20) 자료(interior_documents) + 현장사진(interior_photos) — Supabase Storage 직접 업로드.
//   · site 종속(GET/POST/sign-upload)은 app.use('/api/sites/:id') 소유검증이 자동 선행 → 타팀/미존재 404.
//   · by-id(PUT/DELETE/download)는 requireChildOwned('interior_documents'|'interior_photos') 가 보호.
//   · 데이터 응답은 앱 규약대로 raw(배열/객체), 에러는 {success:false,message}, 미설정은 503 {error}.
// ========================================

// 서명 업로드 URL 발급 핸들러 팩토리(documents/photos 공용). 스토리지 미설정 → 503.
function makeSignUploadHandler(kind, siteLabel) {
  return async (req, res) => {
    try {
      if (!storageConfigured()) return res.status(503).json({ error: '스토리지 미설정' });
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
      const b = req.body || {};
      const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
      if (!fileName) return res.status(400).json({ success: false, message: '파일명(file_name)이 필요합니다.' });
      const storagePath = buildStoragePath(id, kind, fileName);
      const signed = await signUploadUrl(storagePath); // content_type 은 클라 PUT 시 지정(서명엔 불필요)
      // 클라: 이 upload_url 로 PUT(body=파일, header x-upsert:true) 후 storage_path 로 메타 POST.
      res.json({ upload_url: signed.uploadUrl, storage_path: signed.path });
    } catch (err) {
      console.error(`POST sign-upload(${kind}) 오류:`, err.message);
      res.status(502).json({ success: false, message: `${siteLabel} 업로드 URL 발급에 실패했습니다.` });
    }
  };
}

// 서명 다운로드 URL 발급 핸들러 팩토리. 반환 { url }. 미설정 503, 미존재/파일없음 404.
function makeDownloadHandler(table, label) {
  return async (req, res) => {
    try {
      if (!storageConfigured()) return res.status(503).json({ error: '스토리지 미설정' });
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: `잘못된 ${label} id 형식입니다.` });
      const { rows } = await pool.query(`SELECT storage_path FROM ${table} WHERE id=$1`, [id]);
      if (rows.length === 0) return res.status(404).json({ success: false, message: `해당 ${label}을(를) 찾을 수 없습니다.` });
      const sp = rows[0].storage_path || '';
      if (!sp) return res.status(404).json({ success: false, message: '연결된 파일이 없습니다.' });
      const url = await signDownloadUrl(sp);
      res.json({ url });
    } catch (err) {
      console.error(`GET download(${table}) 오류:`, err.message);
      res.status(502).json({ success: false, message: '다운로드 URL 발급에 실패했습니다.' });
    }
  };
}

// ---------- 자료(documents) ----------
app.post('/api/sites/:id/documents/sign-upload', makeSignUploadHandler('documents', '자료'));

// GET /api/sites/:id/documents — created_at DESC
app.get('/api/sites/:id/documents', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${DOCUMENT_COLS} FROM interior_documents WHERE site_id=$1 ORDER BY created_at DESC, id DESC`,
      [id]
    );
    res.json(rows.map(rowToDocument));
  } catch (err) {
    console.error('GET /api/sites/:id/documents 오류:', err.message);
    res.status(500).json({ success: false, message: '자료 목록을 불러오지 못했습니다.' });
  }
});

// POST /api/sites/:id/documents {name, doc_type?, storage_path, file_name?, file_size?, memo?, uploader?} → 201
app.post('/api/sites/:id/documents', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const b = req.body || {};
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return res.status(400).json({ success: false, message: '자료명(name)이 필요합니다.' });
    const docType = typeof b.doc_type === 'string' && b.doc_type.trim() ? b.doc_type.trim() : '기타';
    const storagePath = typeof b.storage_path === 'string' ? b.storage_path.trim() : '';
    const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
    const fsNum = Number(b.file_size);
    const fileSize = Number.isFinite(fsNum) && fsNum >= 0 ? Math.floor(fsNum) : 0;
    const memo = typeof b.memo === 'string' ? b.memo : '';
    // uploader: 프론트 전달값 우선, 없으면 로그인 사용자명 자동
    let uploader = typeof b.uploader === 'string' && b.uploader.trim() ? b.uploader.trim() : '';
    if (!uploader) uploader = await currentUserName(req);
    const { rows } = await pool.query(
      `INSERT INTO interior_documents (site_id, name, doc_type, storage_path, file_name, file_size, uploader, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${DOCUMENT_COLS}`,
      [id, name, docType, storagePath, fileName, fileSize, uploader, memo]
    );
    res.status(201).json(rowToDocument(rows[0]));
  } catch (err) {
    console.error('POST /api/sites/:id/documents 오류:', err.message);
    res.status(500).json({ success: false, message: '자료를 저장하지 못했습니다.' });
  }
});

// PUT /api/documents/:id — 부분 수정 {name?, doc_type?, memo?}
app.put('/api/documents/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 자료 id 형식입니다.' });
    const b = req.body || {};
    const hasName = typeof b.name !== 'undefined';
    const name = hasName ? String(b.name).trim() : null;
    if (hasName && !name) return res.status(400).json({ success: false, message: '자료명은 비울 수 없습니다.' });
    const docType = typeof b.doc_type !== 'undefined' ? (String(b.doc_type).trim() || '기타') : null;
    const memo = typeof b.memo !== 'undefined' ? String(b.memo) : null;
    if (name === null && docType === null && memo === null)
      return res.status(400).json({ success: false, message: '수정할 내용이 없습니다.' });
    const { rows } = await pool.query(
      `UPDATE interior_documents
       SET name=COALESCE($1,name), doc_type=COALESCE($2,doc_type), memo=COALESCE($3,memo)
       WHERE id=$4 RETURNING ${DOCUMENT_COLS}`,
      [name, docType, memo, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 자료을(를) 찾을 수 없습니다.' });
    res.json(rowToDocument(rows[0]));
  } catch (err) {
    console.error('PUT /api/documents/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '자료를 수정하지 못했습니다.' });
  }
});

// DELETE /api/documents/:id — Storage 파일 삭제 시도(베스트에포트) + 행 삭제
app.delete('/api/documents/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 자료 id 형식입니다.' });
    const { rows } = await pool.query('DELETE FROM interior_documents WHERE id=$1 RETURNING storage_path', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 자료을(를) 찾을 수 없습니다.' });
    await deleteStorageObject(rows[0].storage_path);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/documents/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '자료를 삭제하지 못했습니다.' });
  }
});

// GET /api/documents/:id/download — 서명 다운로드 URL {url}
app.get('/api/documents/:id/download', makeDownloadHandler('interior_documents', '자료'));

// ---------- 현장사진(photos) ----------
app.post('/api/sites/:id/photos/sign-upload', makeSignUploadHandler('photos', '현장사진'));

// GET /api/sites/:id/photos — photo_date DESC, created_at DESC
app.get('/api/sites/:id/photos', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT ${PHOTO_COLS} FROM interior_photos WHERE site_id=$1 ORDER BY photo_date DESC NULLS LAST, created_at DESC, id DESC`,
      [id]
    );
    res.json(rows.map(rowToPhoto));
  } catch (err) {
    console.error('GET /api/sites/:id/photos 오류:', err.message);
    res.status(500).json({ success: false, message: '현장사진 목록을 불러오지 못했습니다.' });
  }
});

// POST /api/sites/:id/photos {photo_date?, processes?, storage_path, file_name?, memo?, uploader?} → 201
//   photo_date 기본=오늘(KST), uploader 자동=로그인 사용자, processes 는 배열/문자열 모두 수용.
app.post('/api/sites/:id/photos', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const b = req.body || {};
    let photoDate = typeof b.photo_date === 'string' ? b.photo_date.trim() : '';
    if (photoDate && !isRealDate(photoDate))
      return res.status(400).json({ success: false, message: '촬영일 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
    if (!photoDate) photoDate = todayKST();
    let processes = '';
    if (Array.isArray(b.processes)) {
      processes = b.processes.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()).join(',');
    } else if (typeof b.processes === 'string') {
      processes = b.processes.trim();
    }
    const storagePath = typeof b.storage_path === 'string' ? b.storage_path.trim() : '';
    const fileName = typeof b.file_name === 'string' ? b.file_name.trim() : '';
    const memo = typeof b.memo === 'string' ? b.memo : '';
    let uploader = typeof b.uploader === 'string' && b.uploader.trim() ? b.uploader.trim() : '';
    if (!uploader) uploader = await currentUserName(req);
    const { rows } = await pool.query(
      `INSERT INTO interior_photos (site_id, photo_date, processes, storage_path, file_name, uploader, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${PHOTO_COLS}`,
      [id, photoDate, processes, storagePath, fileName, uploader, memo]
    );
    res.status(201).json(rowToPhoto(rows[0]));
  } catch (err) {
    console.error('POST /api/sites/:id/photos 오류:', err.message);
    res.status(500).json({ success: false, message: '현장사진을 저장하지 못했습니다.' });
  }
});

// DELETE /api/photos/:id — Storage 파일 삭제 시도 + 행 삭제
app.delete('/api/photos/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장사진 id 형식입니다.' });
    const { rows } = await pool.query('DELETE FROM interior_photos WHERE id=$1 RETURNING storage_path', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 현장사진을(를) 찾을 수 없습니다.' });
    await deleteStorageObject(rows[0].storage_path);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/photos/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '현장사진을 삭제하지 못했습니다.' });
  }
});

// GET /api/photos/:id/download — 서명 다운로드 URL {url}
app.get('/api/photos/:id/download', makeDownloadHandler('interior_photos', '현장사진'));

// ========================================
// (v25) 개인 할일 · 출력인원(기공/조공) · 매뉴얼 · 인앱 알림
//   알림 규칙: 할일 할당→담당자 / 할일 완료→팀 admin+생성자 / 출력 완료→팀원 전체 (모두 actor 제외)
// ========================================
// 알림 생성 헬퍼 — 수신자 dedupe + actor 제외 + 빈 배열 no-op. 실패해도 본 요청은 성공 처리(warn).
async function notifyUsers({ teamId, userIds, actorUserId, type, title, body = '', siteId = null, refType = '', refId = null }) {
  try {
    const targets = [...new Set((userIds || []).map(Number).filter((x) => Number.isFinite(x) && x > 0 && x !== Number(actorUserId)))];
    if (targets.length === 0) return;
    const params = [];
    const values = targets.map((uid, i) => {
      params.push(teamId, uid, actorUserId || null, type, title, body, siteId, refType, refId);
      const o = i * 9;
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`;
    });
    await pool.query(
      `INSERT INTO interior_notifications (team_id, user_id, actor_user_id, type, title, body, site_id, ref_type, ref_id)
       VALUES ${values.join(',')}`, params
    );
  } catch (err) {
    console.warn('⚠️  알림 생성 실패(요청은 계속):', err.message);
  }
}
async function teamUserIdsByRole(teamId, onlyAdmin) {
  const { rows } = await pool.query(
    `SELECT id FROM interior_users WHERE team_id=$1 ${onlyAdmin ? "AND role='admin'" : ''}`, [teamId]
  );
  return rows.map((r) => Number(r.id));
}

// GET /api/team/users — 담당자 피커용 팀 유저 목록(전원 열람)
app.get('/api/team/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(NULLIF(name,''), email) AS name, email, role FROM interior_users WHERE team_id=$1 ORDER BY id ASC`,
      [req.teamId]
    );
    res.json(rows.map((r) => ({ id: String(r.id), name: r.name, email: r.email, role: r.role || 'member' })));
  } catch (err) {
    console.error('GET /api/team/users 오류:', err.message);
    res.status(500).json({ success: false, message: '팀원 목록을 불러오지 못했습니다.' });
  }
});

// ── 할일 ──
const TASK_SELECT = `
  SELECT t.id, t.team_id, t.site_id, t.title, t.memo, to_char(t.due_date,'YYYY-MM-DD') AS due_date,
         t.status, t.assignee_user_id, t.created_by, t.completed_at, t.created_at,
         s.name AS site_name,
         COALESCE(NULLIF(au.name,''), au.email) AS assignee_name,
         COALESCE(NULLIF(cu.name,''), cu.email) AS creator_name
  FROM interior_tasks t
  LEFT JOIN interior_sites s ON s.id = t.site_id
  LEFT JOIN interior_users au ON au.id = t.assignee_user_id
  LEFT JOIN interior_users cu ON cu.id = t.created_by`;
function rowToTask(r) {
  return {
    id: String(r.id),
    title: r.title, memo: r.memo || '',
    due_date: r.due_date || null,
    status: r.status || '진행',
    site_id: r.site_id == null ? null : String(r.site_id),
    site_name: r.site_name || null,
    assignee_user_id: r.assignee_user_id == null ? null : String(r.assignee_user_id),
    assignee_name: r.assignee_name || null,
    created_by: r.created_by == null ? null : String(r.created_by),
    creator_name: r.creator_name || null,
    completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

// GET /api/tasks?view=mine|team&status=진행|완료|all&site_id= — 기본 mine·진행. 마감 임박순(NULL 마지막).
app.get('/api/tasks', async (req, res) => {
  try {
    const view = req.query.view === 'team' ? 'team' : 'mine';
    const status = ['진행', '완료', 'all'].includes(String(req.query.status)) ? String(req.query.status) : '진행';
    const conds = ['t.team_id=$1'];
    const params = [req.teamId];
    if (view === 'mine') { params.push(req.userId); conds.push(`t.assignee_user_id=$${params.length}`); }
    if (status !== 'all') { params.push(status); conds.push(`t.status=$${params.length}`); }
    const siteId = parseId(req.query.site_id);
    if (siteId) { params.push(siteId); conds.push(`t.site_id=$${params.length}`); }
    const order = status === '완료' ? 't.completed_at DESC NULLS LAST, t.id DESC' : 't.due_date ASC NULLS LAST, t.id ASC';
    const { rows } = await pool.query(`${TASK_SELECT} WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT 300`, params);
    res.json(rows.map(rowToTask));
  } catch (err) {
    console.error('GET /api/tasks 오류:', err.message);
    res.status(500).json({ success: false, message: '할일을 불러오지 못했습니다.' });
  }
});

// POST /api/tasks — 팀 전원 생성 가능. 담당자 기본=본인, 타인 할당 시 task_assigned 알림.
app.post('/api/tasks', async (req, res) => {
  try {
    const b = req.body || {};
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) return res.status(400).json({ success: false, message: '할일 제목을 입력하세요.' });
    const memo = typeof b.memo === 'string' ? b.memo : '';
    const dueDate = b.due_date && isRealDate(String(b.due_date)) ? String(b.due_date) : null;
    let assignee = parseId(b.assignee_user_id) || req.userId;
    // 담당자는 우리 팀 유저만
    const chk = await pool.query('SELECT id FROM interior_users WHERE id=$1 AND team_id=$2', [assignee, req.teamId]);
    if (chk.rows.length === 0) assignee = req.userId;
    let siteId = parseId(b.site_id) || null;
    if (siteId) {
      const sc = await pool.query('SELECT id, name FROM interior_sites WHERE id=$1 AND team_id=$2', [siteId, req.teamId]);
      if (sc.rows.length === 0) siteId = null;
    }
    const ins = await pool.query(
      `INSERT INTO interior_tasks (team_id, site_id, title, memo, due_date, assignee_user_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.teamId, siteId, title, memo, dueDate, assignee, req.userId]
    );
    const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id=$1`, [ins.rows[0].id]);
    const task = rowToTask(rows[0]);
    if (Number(assignee) !== Number(req.userId)) {
      const actorName = await currentUserName(req);
      await notifyUsers({
        teamId: req.teamId, userIds: [assignee], actorUserId: req.userId, type: 'task_assigned',
        title: `📌 새 할일: ${title}`,
        body: `${actorName || '팀원'}님이 할일을 배정했습니다.${task.due_date ? ` 마감 ${task.due_date}` : ''}${task.site_name ? ` · ${task.site_name}` : ''}`,
        siteId, refType: 'task', refId: Number(task.id),
      });
    }
    res.status(201).json(task);
  } catch (err) {
    console.error('POST /api/tasks 오류:', err.message);
    res.status(500).json({ success: false, message: '할일을 저장하지 못했습니다.' });
  }
});

// PATCH /api/tasks/:id — 부분 수정. status '완료' 전환 시 completed_at + 팀 admin/생성자 알림, '진행' 복귀 시 해제.
app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 할일 id 형식입니다.' });
    const cur = await pool.query('SELECT * FROM interior_tasks WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (cur.rows.length === 0) return res.status(404).json({ success: false, message: '해당 할일을 찾을 수 없습니다.' });
    const prev = cur.rows[0];
    const b = req.body || {};
    const sets = [];
    const params = [];
    const push = (frag, v) => { params.push(v); sets.push(`${frag}$${params.length}`); };
    if (typeof b.title === 'string' && b.title.trim()) push('title=', b.title.trim());
    if (typeof b.memo === 'string') push('memo=', b.memo);
    if (b.due_date !== undefined) push('due_date=', b.due_date && isRealDate(String(b.due_date)) ? String(b.due_date) : null);
    let newAssignee = null;
    if (b.assignee_user_id !== undefined) {
      newAssignee = parseId(b.assignee_user_id);
      if (newAssignee) {
        const chk = await pool.query('SELECT id FROM interior_users WHERE id=$1 AND team_id=$2', [newAssignee, req.teamId]);
        if (chk.rows.length === 0) newAssignee = null;
      }
      push('assignee_user_id=', newAssignee);
    }
    if (b.site_id !== undefined) {
      let siteId = parseId(b.site_id) || null;
      if (siteId) {
        const sc = await pool.query('SELECT id FROM interior_sites WHERE id=$1 AND team_id=$2', [siteId, req.teamId]);
        if (sc.rows.length === 0) siteId = null;
      }
      push('site_id=', siteId);
    }
    let statusChangedToDone = false;
    if (b.status === '완료' || b.status === '진행') {
      push('status=', b.status);
      if (b.status === '완료' && prev.status !== '완료') { sets.push('completed_at=now()'); statusChangedToDone = true; }
      if (b.status === '진행') sets.push('completed_at=NULL');
    }
    if (sets.length === 0) return res.status(400).json({ success: false, message: '수정할 내용이 없습니다.' });
    params.push(id);
    await pool.query(`UPDATE interior_tasks SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id=$1`, [id]);
    const task = rowToTask(rows[0]);

    const actorName = await currentUserName(req);
    if (statusChangedToDone) {
      // 완료 알림 → 팀 admin 전원 + 생성자 (actor 제외, dedupe)
      const admins = await teamUserIdsByRole(req.teamId, true);
      const targets = [...admins, prev.created_by ? Number(prev.created_by) : null].filter(Boolean);
      await notifyUsers({
        teamId: req.teamId, userIds: targets, actorUserId: req.userId, type: 'task_done',
        title: `✅ 할일 완료: ${task.title}`,
        body: `${actorName || '팀원'}님이 완료했습니다.${task.site_name ? ` · ${task.site_name}` : ''}`,
        siteId: task.site_id ? Number(task.site_id) : null, refType: 'task', refId: Number(task.id),
      });
    } else if (newAssignee && Number(newAssignee) !== Number(prev.assignee_user_id || 0) && Number(newAssignee) !== Number(req.userId)) {
      // 담당자 변경 알림 → 새 담당자
      await notifyUsers({
        teamId: req.teamId, userIds: [newAssignee], actorUserId: req.userId, type: 'task_assigned',
        title: `📌 새 할일: ${task.title}`,
        body: `${actorName || '팀원'}님이 할일을 배정했습니다.${task.due_date ? ` 마감 ${task.due_date}` : ''}${task.site_name ? ` · ${task.site_name}` : ''}`,
        siteId: task.site_id ? Number(task.site_id) : null, refType: 'task', refId: Number(task.id),
      });
    }
    res.json(task);
  } catch (err) {
    console.error('PATCH /api/tasks/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '할일을 수정하지 못했습니다.' });
  }
});

// DELETE /api/tasks/:id
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 할일 id 형식입니다.' });
    const del = await pool.query('DELETE FROM interior_tasks WHERE id=$1 AND team_id=$2 RETURNING id', [id, req.teamId]);
    if (del.rows.length === 0) return res.status(404).json({ success: false, message: '해당 할일을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/tasks/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '할일을 삭제하지 못했습니다.' });
  }
});

// ── 출력인원 ──
function rowToLabor(r) {
  const skilled = Number(r.skilled) || 0;
  const helper = Number(r.helper) || 0;
  const skilledRate = Number(r.skilled_rate) || 0;
  const helperRate = Number(r.helper_rate) || 0;
  return {
    id: String(r.id),
    site_id: String(r.site_id),
    work_date: r.work_date_s,
    schedule_id: r.schedule_id == null ? null : String(r.schedule_id),
    process: r.process || '',
    skilled, helper,
    // (v26) 시공팀(거래처) + 일당 스냅샷 → 인건비
    vendor_id: r.vendor_id == null ? null : String(r.vendor_id),
    vendor_name: r.vendor_name || null,
    skilled_rate: skilledRate,
    helper_rate: helperRate,
    cost: skilled * skilledRate + helper * helperRate,
    memo: r.memo || '',
    done: !!r.done,
    done_at: r.done_at ? new Date(r.done_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
  };
}
const LABOR_COLS = "l.id, l.site_id, to_char(l.work_date,'YYYY-MM-DD') AS work_date_s, l.schedule_id, l.process, l.skilled, l.helper, l.vendor_id, l.skilled_rate, l.helper_rate, l.memo, l.done, l.done_at, l.created_at";

// GET /api/sites/:id/labor?date=YYYY-MM-DD — 그날 로그 + 당일 일정(kind=공사, 겹침)
app.get('/api/sites/:id/labor', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const date = req.query.date && isRealDate(String(req.query.date)) ? String(req.query.date) : null;
    if (!id || !date) return res.status(400).json({ success: false, message: 'date(YYYY-MM-DD)가 필요합니다.' });
    const [logs, scheds] = await Promise.all([
      pool.query(
        `SELECT ${LABOR_COLS}, v.name AS vendor_name
         FROM interior_labor_logs l LEFT JOIN interior_vendors v ON v.id = l.vendor_id
         WHERE l.site_id=$1 AND l.work_date=$2 ORDER BY l.id ASC`, [id, date]
      ),
      pool.query(
        `SELECT id, title, process, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, status
         FROM interior_schedule WHERE site_id=$1 AND kind='공사' AND start_date<=$2 AND end_date>=$2
         ORDER BY sort_order ASC, id ASC`, [id, date]
      ),
    ]);
    res.json({
      date,
      logs: logs.rows.map(rowToLabor),
      schedules: scheds.rows.map((s) => ({ id: String(s.id), title: s.title, process: s.process || '', start_date: s.start_date, end_date: s.end_date, status: s.status })),
    });
  } catch (err) {
    console.error('GET /api/sites/:id/labor 오류:', err.message);
    res.status(500).json({ success: false, message: '출력인원을 불러오지 못했습니다.' });
  }
});

// POST /api/sites/:id/labor — upsert(현장×날짜×공정). 기공/조공/비고 갱신.
app.post('/api/sites/:id/labor', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const b = req.body || {};
    const date = b.work_date && isRealDate(String(b.work_date)) ? String(b.work_date) : null;
    if (!id || !date) return res.status(400).json({ success: false, message: 'work_date(YYYY-MM-DD)가 필요합니다.' });
    const process = typeof b.process === 'string' ? b.process.trim() : '';
    const skilled = Math.max(0, Math.round(Number(b.skilled) || 0));
    const helper = Math.max(0, Math.round(Number(b.helper) || 0));
    const memo = typeof b.memo === 'string' ? b.memo : '';
    let scheduleId = parseId(b.schedule_id) || null;
    if (scheduleId) {
      const sc = await pool.query('SELECT id FROM interior_schedule WHERE id=$1 AND site_id=$2', [scheduleId, id]);
      if (sc.rows.length === 0) scheduleId = null;
    }
    // (v26) 시공팀(거래처) + 일당: 명시 단가 > 거래처 프리셋 > 0. 행에 스냅샷 저장(이후 거래처 단가 변경과 무관).
    let vendorId = parseId(b.vendor_id) || null;
    let vendorRow = null;
    if (vendorId) {
      const vq = await pool.query('SELECT id, skilled_rate, helper_rate FROM interior_vendors WHERE id=$1 AND team_id=$2', [vendorId, req.teamId]);
      if (vq.rows.length === 0) vendorId = null; else vendorRow = vq.rows[0];
    }
    const skilledRate = b.skilled_rate !== undefined ? Math.max(0, Math.round(Number(b.skilled_rate) || 0))
      : vendorRow ? Number(vendorRow.skilled_rate) : 0;
    const helperRate = b.helper_rate !== undefined ? Math.max(0, Math.round(Number(b.helper_rate) || 0))
      : vendorRow ? Number(vendorRow.helper_rate) : 0;
    const ins = await pool.query(
      `INSERT INTO interior_labor_logs (team_id, site_id, work_date, schedule_id, process, skilled, helper, vendor_id, skilled_rate, helper_rate, memo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (site_id, work_date, process) DO UPDATE
         SET skilled=EXCLUDED.skilled, helper=EXCLUDED.helper, memo=EXCLUDED.memo,
             vendor_id=EXCLUDED.vendor_id, skilled_rate=EXCLUDED.skilled_rate, helper_rate=EXCLUDED.helper_rate,
             schedule_id=COALESCE(EXCLUDED.schedule_id, interior_labor_logs.schedule_id)
       RETURNING id`,
      [req.teamId, id, date, scheduleId, process, skilled, helper, vendorId, skilledRate, helperRate, memo, req.userId]
    );
    const { rows } = await pool.query(
      `SELECT ${LABOR_COLS}, v.name AS vendor_name
       FROM interior_labor_logs l LEFT JOIN interior_vendors v ON v.id = l.vendor_id
       WHERE l.id=$1`, [ins.rows[0].id]
    );
    res.status(201).json(rowToLabor(rows[0]));
  } catch (err) {
    console.error('POST /api/sites/:id/labor 오류:', err.message);
    res.status(500).json({ success: false, message: '출력인원을 저장하지 못했습니다.' });
  }
});

// DELETE /api/labor/:id — 행 삭제(팀 검증)
app.delete('/api/labor/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 출력인원 id 형식입니다.' });
    const del = await pool.query('DELETE FROM interior_labor_logs WHERE id=$1 AND team_id=$2 RETURNING id', [id, req.teamId]);
    if (del.rows.length === 0) return res.status(404).json({ success: false, message: '해당 출력인원 기록을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/labor/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '출력인원을 삭제하지 못했습니다.' });
  }
});

// POST /api/sites/:id/labor/complete {date} — 그날 기록 done 처리 + 팀원 전체 알림(0건이면 400)
app.post('/api/sites/:id/labor/complete', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const b = req.body || {};
    const date = b.date && isRealDate(String(b.date)) ? String(b.date) : null;
    if (!id || !date) return res.status(400).json({ success: false, message: 'date(YYYY-MM-DD)가 필요합니다.' });
    const upd = await pool.query(
      `UPDATE interior_labor_logs SET done=true, done_at=now()
       WHERE site_id=$1 AND work_date=$2 RETURNING process, skilled, helper`, [id, date]
    );
    if (upd.rows.length === 0) return res.status(400).json({ success: false, message: '해당 날짜에 입력된 출력인원이 없습니다.' });
    const skilled = upd.rows.reduce((a, r) => a + Number(r.skilled), 0);
    const helper = upd.rows.reduce((a, r) => a + Number(r.helper), 0);
    const site = await pool.query('SELECT name FROM interior_sites WHERE id=$1', [id]);
    const siteName = site.rows.length ? site.rows[0].name : '현장';
    const [, mm, dd] = date.split('-');
    const actorName = await currentUserName(req);
    const everyone = await teamUserIdsByRole(req.teamId, false);
    await notifyUsers({
      teamId: req.teamId, userIds: everyone, actorUserId: req.userId, type: 'labor_done',
      title: `👷 [${siteName}] ${Number(mm)}/${Number(dd)} 출력 완료`,
      body: `기공 ${skilled} · 조공 ${helper} · 계 ${skilled + helper}명 (공정 ${upd.rows.length}건) — ${actorName || '팀원'} 입력`,
      siteId: id, refType: 'labor', refId: null,
    });
    res.json({ success: true, done: upd.rows.length, skilled, helper });
  } catch (err) {
    console.error('POST /api/sites/:id/labor/complete 오류:', err.message);
    res.status(500).json({ success: false, message: '출력 완료 처리를 하지 못했습니다.' });
  }
});

// GET /api/sites/:id/labor/summary — 최근 60일 일자별 합계 + 전체 누적
app.get('/api/sites/:id/labor/summary', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const [daily, total, byProcess, dailyProcess] = await Promise.all([
      pool.query(
        `SELECT to_char(work_date,'YYYY-MM-DD') AS d, SUM(skilled)::int AS skilled, SUM(helper)::int AS helper,
                COALESCE(SUM(skilled*skilled_rate + helper*helper_rate),0)::bigint AS cost,
                COUNT(*)::int AS entries, bool_and(done) AS done
         FROM interior_labor_logs WHERE site_id=$1 AND work_date >= (CURRENT_DATE - INTERVAL '60 days')
         GROUP BY work_date ORDER BY work_date DESC`, [id]
      ),
      pool.query(
        `SELECT COALESCE(SUM(skilled),0)::int AS skilled, COALESCE(SUM(helper),0)::int AS helper,
                COALESCE(SUM(skilled*skilled_rate + helper*helper_rate),0)::bigint AS cost,
                COUNT(DISTINCT work_date)::int AS days
         FROM interior_labor_logs WHERE site_id=$1`, [id]
      ),
      // (v26) 공정별 누적 — 인원·인건비·출력일수
      pool.query(
        `SELECT process, COUNT(DISTINCT work_date)::int AS days,
                COALESCE(SUM(skilled),0)::int AS skilled, COALESCE(SUM(helper),0)::int AS helper,
                COALESCE(SUM(skilled*skilled_rate + helper*helper_rate),0)::bigint AS cost
         FROM interior_labor_logs WHERE site_id=$1
         GROUP BY process ORDER BY (COALESCE(SUM(skilled),0)+COALESCE(SUM(helper),0)) DESC, process ASC`, [id]
      ),
      // (v26) 공정별 인원 추이(최근 30일, 일자×공정) — 스택 차트용
      pool.query(
        `SELECT to_char(work_date,'YYYY-MM-DD') AS d, process,
                (COALESCE(SUM(skilled),0)+COALESCE(SUM(helper),0))::int AS total
         FROM interior_labor_logs WHERE site_id=$1 AND work_date >= (CURRENT_DATE - INTERVAL '30 days')
         GROUP BY work_date, process ORDER BY work_date ASC`, [id]
      ),
    ]);
    res.json({
      daily: daily.rows.map((r) => ({ date: r.d, skilled: r.skilled, helper: r.helper, cost: Number(r.cost), entries: r.entries, done: !!r.done })),
      total: { skilled: total.rows[0].skilled, helper: total.rows[0].helper, cost: Number(total.rows[0].cost), days: total.rows[0].days },
      by_process: byProcess.rows.map((r) => ({ process: r.process || '(공정 미지정)', days: r.days, skilled: r.skilled, helper: r.helper, cost: Number(r.cost) })),
      daily_process: dailyProcess.rows.map((r) => ({ date: r.d, process: r.process || '(공정 미지정)', total: r.total })),
    });
  } catch (err) {
    console.error('GET /api/sites/:id/labor/summary 오류:', err.message);
    res.status(500).json({ success: false, message: '출력인원 요약을 불러오지 못했습니다.' });
  }
});

// ── 매뉴얼 ──
function rowToManual(r, withContent) {
  const base = {
    id: String(r.id),
    title: r.title, trade: r.trade || '', types: r.types || '',
    status: r.status || '작성 전', notion_url: r.notion_url || '',
    has_content: !!r.has_content || (typeof r.content === 'string' && r.content.trim() !== ''),
    sort_order: Number(r.sort_order) || 0,
    updated_at: new Date(r.updated_at).toISOString(),
  };
  if (withContent) base.content = r.content || '';
  return base;
}

// GET /api/manuals?q=&trade=&type= — 목록(본문 제외, has_content 플래그)
app.get('/api/manuals', async (req, res) => {
  try {
    const conds = ['team_id=$1'];
    const params = [req.teamId];
    if (req.query.q && String(req.query.q).trim()) { params.push(`%${String(req.query.q).trim()}%`); conds.push(`title ILIKE $${params.length}`); }
    if (req.query.trade && String(req.query.trade).trim()) { params.push(String(req.query.trade).trim()); conds.push(`trade=$${params.length}`); }
    if (req.query.type && String(req.query.type).trim()) { params.push(`%${String(req.query.type).trim()}%`); conds.push(`types ILIKE $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT id, title, trade, types, status, notion_url, (content <> '') AS has_content, sort_order, updated_at
       FROM interior_manuals WHERE ${conds.join(' AND ')} ORDER BY trade ASC, sort_order ASC, id ASC`, params
    );
    res.json(rows.map((r) => rowToManual(r, false)));
  } catch (err) {
    console.error('GET /api/manuals 오류:', err.message);
    res.status(500).json({ success: false, message: '매뉴얼을 불러오지 못했습니다.' });
  }
});

// GET /api/manuals/:id — 본문 포함 단건
app.get('/api/manuals/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 매뉴얼 id 형식입니다.' });
    const { rows } = await pool.query('SELECT * FROM interior_manuals WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 매뉴얼을 찾을 수 없습니다.' });
    res.json(rowToManual(rows[0], true));
  } catch (err) {
    console.error('GET /api/manuals/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '매뉴얼을 불러오지 못했습니다.' });
  }
});

// POST /api/manuals — admin 전용 생성
app.post('/api/manuals', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) return res.status(400).json({ success: false, message: '매뉴얼 제목(항목)을 입력하세요.' });
    const { rows } = await pool.query(
      `INSERT INTO interior_manuals (team_id, title, trade, types, status, content, notion_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.teamId, title, String(b.trade || '').trim(), String(b.types || '').trim(),
       String(b.status || '작성 전').trim(), typeof b.content === 'string' ? b.content : '', String(b.notion_url || '').trim()]
    );
    res.status(201).json(rowToManual(rows[0], true));
  } catch (err) {
    console.error('POST /api/manuals 오류:', err.message);
    res.status(500).json({ success: false, message: '매뉴얼을 저장하지 못했습니다.' });
  }
});

// PATCH /api/manuals/:id — admin 전용 부분 수정
app.patch('/api/manuals/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 매뉴얼 id 형식입니다.' });
    const b = req.body || {};
    const sets = [];
    const params = [];
    const push = (frag, v) => { params.push(v); sets.push(`${frag}$${params.length}`); };
    if (typeof b.title === 'string' && b.title.trim()) push('title=', b.title.trim());
    if (typeof b.trade === 'string') push('trade=', b.trade.trim());
    if (typeof b.types === 'string') push('types=', b.types.trim());
    if (typeof b.status === 'string' && b.status.trim()) push('status=', b.status.trim());
    if (typeof b.content === 'string') push('content=', b.content);
    if (typeof b.notion_url === 'string') push('notion_url=', b.notion_url.trim());
    if (Number.isFinite(Number(b.sort_order))) push('sort_order=', Math.round(Number(b.sort_order)));
    if (sets.length === 0) return res.status(400).json({ success: false, message: '수정할 내용이 없습니다.' });
    sets.push('updated_at=now()');
    params.push(id, req.teamId);
    const { rows } = await pool.query(
      `UPDATE interior_manuals SET ${sets.join(', ')} WHERE id=$${params.length - 1} AND team_id=$${params.length} RETURNING *`, params
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 매뉴얼을 찾을 수 없습니다.' });
    res.json(rowToManual(rows[0], true));
  } catch (err) {
    console.error('PATCH /api/manuals/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '매뉴얼을 수정하지 못했습니다.' });
  }
});

// DELETE /api/manuals/:id — admin 전용 (site_manuals CASCADE)
app.delete('/api/manuals/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 매뉴얼 id 형식입니다.' });
    const del = await pool.query('DELETE FROM interior_manuals WHERE id=$1 AND team_id=$2 RETURNING id', [id, req.teamId]);
    if (del.rows.length === 0) return res.status(404).json({ success: false, message: '해당 매뉴얼을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/manuals/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '매뉴얼을 삭제하지 못했습니다.' });
  }
});

// GET /api/sites/:id/manuals — 이 현장에 선택된 매뉴얼(본문 포함, 열람용)
app.get('/api/sites/:id/manuals', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const { rows } = await pool.query(
      `SELECT m.*, sm.created_at AS selected_at FROM interior_site_manuals sm
       JOIN interior_manuals m ON m.id = sm.manual_id
       WHERE sm.site_id=$1 ORDER BY m.trade ASC, m.sort_order ASC, m.id ASC`, [id]
    );
    res.json(rows.map((r) => rowToManual(r, true)));
  } catch (err) {
    console.error('GET /api/sites/:id/manuals 오류:', err.message);
    res.status(500).json({ success: false, message: '현장 매뉴얼을 불러오지 못했습니다.' });
  }
});

// PUT /api/sites/:id/manuals {manual_ids[]} — admin 전용, 선택 전체 교체(트랜잭션)
app.put('/api/sites/:id/manuals', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 현장 id 형식입니다.' });
    const idsRaw = Array.isArray(req.body && req.body.manual_ids) ? req.body.manual_ids : [];
    const ids = [...new Set(idsRaw.map(parseId).filter(Boolean))];
    // 우리 팀 매뉴얼만 허용
    let valid = [];
    if (ids.length > 0) {
      const chk = await client.query('SELECT id FROM interior_manuals WHERE team_id=$1 AND id = ANY($2::bigint[])', [req.teamId, ids]);
      valid = chk.rows.map((r) => Number(r.id));
    }
    await client.query('BEGIN');
    await client.query('DELETE FROM interior_site_manuals WHERE site_id=$1', [id]);
    for (const mid of valid) {
      await client.query('INSERT INTO interior_site_manuals (team_id, site_id, manual_id) VALUES ($1,$2,$3)', [req.teamId, id, mid]);
    }
    await client.query('COMMIT');
    res.json({ success: true, count: valid.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/sites/:id/manuals 오류:', err.message);
    res.status(500).json({ success: false, message: '현장 매뉴얼 선택을 저장하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// ── 알림 ──
// GET /api/notifications?limit= — 내 알림 최신순 + 미읽음 수
app.get('/api/notifications', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const [items, unread] = await Promise.all([
      pool.query(
        `SELECT n.id, n.type, n.title, n.body, n.site_id, n.ref_type, n.ref_id, n.read_at, n.created_at,
                COALESCE(NULLIF(u.name,''), u.email) AS actor_name
         FROM interior_notifications n LEFT JOIN interior_users u ON u.id = n.actor_user_id
         WHERE n.user_id=$1 ORDER BY n.id DESC LIMIT ${limit}`, [req.userId]
      ),
      pool.query('SELECT COUNT(*)::int AS n FROM interior_notifications WHERE user_id=$1 AND read_at IS NULL', [req.userId]),
    ]);
    res.json({
      unread: unread.rows[0].n,
      items: items.rows.map((r) => ({
        id: String(r.id), type: r.type || '', title: r.title, body: r.body || '',
        site_id: r.site_id == null ? null : String(r.site_id),
        ref_type: r.ref_type || '', ref_id: r.ref_id == null ? null : String(r.ref_id),
        actor_name: r.actor_name || null,
        read: !!r.read_at,
        created_at: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (err) {
    console.error('GET /api/notifications 오류:', err.message);
    res.status(500).json({ success: false, message: '알림을 불러오지 못했습니다.' });
  }
});

// POST /api/notifications/read {ids[]} — 내 알림 읽음 처리
app.post('/api/notifications/read', async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(parseId).filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: '읽음 처리할 알림 id가 없습니다.' });
    await pool.query('UPDATE interior_notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [req.userId, ids]);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/notifications/read 오류:', err.message);
    res.status(500).json({ success: false, message: '알림을 읽음 처리하지 못했습니다.' });
  }
});

// POST /api/notifications/read-all — 전체 읽음
app.post('/api/notifications/read-all', async (req, res) => {
  try {
    await pool.query('UPDATE interior_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/notifications/read-all 오류:', err.message);
    res.status(500).json({ success: false, message: '알림을 읽음 처리하지 못했습니다.' });
  }
});

// ========================================
// (v27) 자재 코드 연동 REST — material-research 동기화 · 코드 resolve · 매핑 기억(remember) · 규칙
//   전부 인증 게이트 내 + 팀 스코핑(team_id 직접 컬럼, vendors 패턴).
//   resolve 우선순위: 자재(active) > 규칙(exact) > 규칙(prefix, 최장). price = 자재.price ?? 연결 카탈로그 material_price.
// ========================================

// 자재 row → 클라이언트 모델 (BIGINT → Number, price NULL = 단가 미정 유지, catalog_name 은 JOIN 된 경우만)
function rowToMaterial(row) {
  return {
    id: row.id,
    code: row.code,
    type: row.type || 'other',
    brand: row.brand || '',
    name: row.name,
    kind: row.kind || '',
    spec: row.spec || '',
    unit: row.unit || 'm2',
    price: row.price == null ? null : Number(row.price),
    waste_pct: Number(row.waste_pct || 0),
    trade: row.trade || '',
    catalog_item_id: row.catalog_item_id == null ? null : Number(row.catalog_item_id),
    catalog_name: row.catalog_name == null ? null : row.catalog_name,
    source: row.source || 'material-research',
    active: row.active,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

// 매핑 규칙 row → 클라이언트 모델
function rowToMatRule(row) {
  return {
    id: row.id,
    pattern: row.pattern,
    is_prefix: !!row.is_prefix,
    trade: row.trade || '',
    catalog_item_id: row.catalog_item_id == null ? null : Number(row.catalog_item_id),
    catalog_name: row.catalog_name == null ? null : row.catalog_name,
    created_at: new Date(row.created_at).toISOString(),
  };
}

// 팀 기본 프리픽스 규칙 시드(멱등, resolve 호출 시 보장) — 컬러 파생코드 PT:* → 도장공사, 우드 WD-* → 바닥공사.
async function seedMatPrefixRules(teamId, db = pool) {
  await db.query(
    `INSERT INTO interior_mat_rules (team_id, pattern, is_prefix, trade)
     VALUES ($1,'PT:',true,'도장공사'), ($1,'WD-',true,'바닥공사')
     ON CONFLICT (team_id, pattern) DO NOTHING`,
    [teamId]
  );
}

// catalog_item_id 입력 정규화: 미전달 → {provided:false}, null/'' → 해제(null), id → 팀 소유 검증(타팀/미존재 → 무시=미전달 취급).
async function normCatalogRef(raw, teamId, db = pool) {
  if (raw === undefined) return { provided: false, id: null };
  if (raw === null || raw === '') return { provided: true, id: null }; // 명시적 해제
  const cid = parseId(raw);
  if (!cid) return { provided: false, id: null };
  const q = await db.query('SELECT 1 FROM interior_catalog WHERE id=$1 AND team_id=$2', [cid, teamId]);
  return q.rows.length > 0 ? { provided: true, id: cid } : { provided: false, id: null };
}

// GET /api/materials — 팀 자재 목록 (code asc, 연결 카탈로그명 JOIN)
app.get('/api/materials', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, c.name AS catalog_name
         FROM interior_materials m
         LEFT JOIN interior_catalog c ON c.id = m.catalog_item_id
        WHERE m.team_id=$1
        ORDER BY m.code ASC, m.id ASC`,
      [req.teamId]
    );
    res.json(rows.map(rowToMaterial));
  } catch (err) {
    console.error('GET /api/materials 오류:', err.message);
    res.status(500).json({ success: false, message: '자재 목록을 불러오지 못했습니다.' });
  }
});

// POST /api/materials/sync {items:[{code,type,brand,name,kind,spec,unit,trade_hint,source_id}]} — (team_id, code) upsert.
//   신규 = trade_hint 를 trade 로. 기존 = 정보필드(brand/name/kind/spec/type/unit)만 갱신,
//   price/trade/catalog_item_id/waste_pct/active 는 보존(단, trade='' 면 trade_hint 로 채움). code 없는 항목 skip.
app.post('/api/materials/sync', async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    let updated = 0;
    for (const raw of items) {
      const it = raw || {};
      const code = typeof it.code === 'string' ? it.code.trim() : '';
      if (!code) continue; // 코드 없는 항목 skip
      const name = (typeof it.name === 'string' && it.name.trim()) || code; // name 비면 코드로 대체(NOT NULL)
      const type = (typeof it.type === 'string' && it.type.trim()) || 'other';
      const brand = typeof it.brand === 'string' ? it.brand.trim() : '';
      const kind = typeof it.kind === 'string' ? it.kind.trim() : '';
      const spec = typeof it.spec === 'string' ? it.spec.trim() : '';
      const unit = (typeof it.unit === 'string' && it.unit.trim()) || 'm2';
      const tradeHint = typeof it.trade_hint === 'string' ? it.trade_hint.trim() : '';
      // xmax=0 → 이번에 INSERT 된 행(신규/갱신 카운트 분리)
      const r = await client.query(
        `INSERT INTO interior_materials (team_id, code, type, brand, name, kind, spec, unit, trade)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (team_id, code) DO UPDATE
           SET type=EXCLUDED.type, brand=EXCLUDED.brand, name=EXCLUDED.name, kind=EXCLUDED.kind,
               spec=EXCLUDED.spec, unit=EXCLUDED.unit,
               trade=CASE WHEN interior_materials.trade='' THEN EXCLUDED.trade ELSE interior_materials.trade END,
               updated_at=now()
         RETURNING (xmax = 0) AS is_insert`,
        [req.teamId, code, type, brand, name, kind, spec, unit, tradeHint]
      );
      if (r.rows[0].is_insert) inserted++;
      else updated++;
    }
    await client.query('COMMIT');
    res.json({ inserted, updated, total: inserted + updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/materials/sync 오류:', err.message);
    res.status(500).json({ success: false, message: '자재 코드 동기화에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// POST /api/materials/resolve {codes:[..]} → {[code]: {via, trade, price, waste_pct, material|null, catalog|null}}
//   우선순위: 자재(active) > 규칙(exact) > 규칙(prefix, 최장). 호출 시 팀 기본 프리픽스 규칙 시드(멱등).
app.post('/api/materials/resolve', async (req, res) => {
  try {
    const codes = Array.isArray(req.body && req.body.codes)
      ? Array.from(new Set(req.body.codes.map((c) => String(c == null ? '' : c).trim()).filter(Boolean)))
      : [];
    await seedMatPrefixRules(req.teamId);
    const result = {};
    if (codes.length === 0) return res.json(result);

    // ① 자재(active, 연결 카탈로그 JOIN) 일괄 조회
    const matQ = await pool.query(
      `SELECT m.*, c.id AS c_id, c.name AS c_name, c.unit AS c_unit,
              c.material_price AS c_material_price, c.labor_price AS c_labor_price, c.sub_price AS c_sub_price
         FROM interior_materials m
         LEFT JOIN interior_catalog c ON c.id = m.catalog_item_id
        WHERE m.team_id=$1 AND m.active=true AND m.code = ANY($2::text[])`,
      [req.teamId, codes]
    );
    const matBy = new Map(matQ.rows.map((r) => [r.code, r]));

    // ② 팀 규칙 전체 — exact 는 코드 일치, prefix 는 전방일치(패턴 최장 우선)
    const ruleQ = await pool.query(
      `SELECT r.*, c.id AS c_id, c.name AS c_name, c.unit AS c_unit,
              c.material_price AS c_material_price, c.labor_price AS c_labor_price, c.sub_price AS c_sub_price
         FROM interior_mat_rules r
         LEFT JOIN interior_catalog c ON c.id = r.catalog_item_id
        WHERE r.team_id=$1`,
      [req.teamId]
    );
    const exactBy = new Map();
    const prefixRules = [];
    for (const r of ruleQ.rows) {
      if (r.is_prefix) prefixRules.push(r);
      else exactBy.set(r.pattern, r);
    }
    prefixRules.sort((a, b) => b.pattern.length - a.pattern.length); // 최장 프리픽스 우선

    const catOf = (r) => (r.c_id == null ? null : {
      id: Number(r.c_id),
      name: r.c_name,
      unit: r.c_unit || '',
      material_price: Number(r.c_material_price),
      labor_price: Number(r.c_labor_price),
      sub_price: Number(r.c_sub_price),
    });

    for (const code of codes) {
      const m = matBy.get(code);
      if (m) {
        const catalog = catOf(m);
        result[code] = {
          via: 'material',
          trade: m.trade || '',
          price: m.price != null ? Number(m.price) : (catalog ? catalog.material_price : null),
          waste_pct: Number(m.waste_pct || 0),
          material: {
            id: Number(m.id), brand: m.brand || '', name: m.name, unit: m.unit || 'm2',
            price: m.price == null ? null : Number(m.price),
            catalog_item_id: m.catalog_item_id == null ? null : Number(m.catalog_item_id),
          },
          catalog,
        };
        continue;
      }
      const ex = exactBy.get(code);
      const rule = ex || prefixRules.find((r) => code.startsWith(r.pattern)) || null;
      if (rule) {
        const catalog = catOf(rule);
        result[code] = {
          via: ex ? 'rule' : 'prefix',
          trade: rule.trade || '',
          price: catalog ? catalog.material_price : null,
          waste_pct: 0,
          material: null,
          catalog,
        };
      } else {
        result[code] = { via: null, trade: '', price: null, waste_pct: 0, material: null, catalog: null };
      }
    }
    res.json(result);
  } catch (err) {
    console.error('POST /api/materials/resolve 오류:', err.message);
    res.status(500).json({ success: false, message: '자재 코드를 해석하지 못했습니다.' });
  }
});

// POST /api/materials/remember {items:[{code,trade,catalog_item_id?}]} — 임포트에서 수정한 코드 매핑 학습.
//   자재 행이 있으면(비활성 포함) 그 행의 trade/catalog 를 갱신, 없으면 exact 규칙 upsert(v24 가맹점 규칙 패턴).
//   미전달 catalog_item_id 는 기존값 보존, trade='' 는 보존(빈 값으로 덮지 않음).
app.post('/api/materials/remember', async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ success: false, message: 'items 배열이 필요합니다.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let materials = 0;
    let rules = 0;
    for (const raw of items) {
      const it = raw || {};
      const code = typeof it.code === 'string' ? it.code.trim() : '';
      if (!code) continue;
      const trade = typeof it.trade === 'string' ? it.trade.trim() : '';
      const cat = await normCatalogRef(it.catalog_item_id, req.teamId, client);
      // ① 자재 행 존재 → 행 갱신
      const upd = await client.query(
        `UPDATE interior_materials
           SET trade = CASE WHEN $1 <> '' THEN $1 ELSE trade END,
               catalog_item_id = CASE WHEN $2::boolean THEN $3::bigint ELSE catalog_item_id END,
               updated_at = now()
         WHERE team_id=$4 AND code=$5
         RETURNING id`,
        [trade, cat.provided, cat.id, req.teamId, code]
      );
      if (upd.rows.length > 0) {
        materials++;
        continue;
      }
      // ② 없으면 exact 규칙 upsert
      await client.query(
        `INSERT INTO interior_mat_rules (team_id, pattern, is_prefix, trade, catalog_item_id)
         VALUES ($1,$2,false,$3,$4)
         ON CONFLICT (team_id, pattern) DO UPDATE
           SET is_prefix=false,
               trade=CASE WHEN EXCLUDED.trade <> '' THEN EXCLUDED.trade ELSE interior_mat_rules.trade END,
               catalog_item_id=CASE WHEN $5::boolean THEN EXCLUDED.catalog_item_id ELSE interior_mat_rules.catalog_item_id END`,
        [req.teamId, code, trade, cat.provided ? cat.id : null, cat.provided]
      );
      rules++;
    }
    await client.query('COMMIT');
    res.json({ materials, rules, total: materials + rules });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/materials/remember 오류:', err.message);
    res.status(500).json({ success: false, message: '코드 매핑을 저장하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// GET /api/materials/rules — 팀 매핑 규칙 목록 (prefix 먼저, 패턴 asc)
app.get('/api/materials/rules', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, c.name AS catalog_name
         FROM interior_mat_rules r
         LEFT JOIN interior_catalog c ON c.id = r.catalog_item_id
        WHERE r.team_id=$1
        ORDER BY r.is_prefix DESC, r.pattern ASC, r.id ASC`,
      [req.teamId]
    );
    res.json(rows.map(rowToMatRule));
  } catch (err) {
    console.error('GET /api/materials/rules 오류:', err.message);
    res.status(500).json({ success: false, message: '매핑 규칙을 불러오지 못했습니다.' });
  }
});

// DELETE /api/materials/rules/:id — 규칙 삭제 (팀 스코핑)
app.delete('/api/materials/rules/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 규칙 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_mat_rules WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 규칙을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/materials/rules/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '규칙을 삭제하지 못했습니다.' });
  }
});

// PUT /api/materials/:id — 부분 수정(COALESCE 보존): price/waste_pct/trade/catalog_item_id/active/brand/name/kind/spec/unit.
//   price 는 null/'' 로 "단가 미정" 해제 가능, catalog_item_id 도 null/'' 로 연결 해제(타팀/무효 id 는 무시=보존).
app.put('/api/materials/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 자재 id 형식입니다.' });
    const b = req.body || {};
    // 텍스트류: 미전달 → null(COALESCE 보존), 전달 → trim 값('' 허용)
    const txt = (k) => (b[k] !== undefined ? (typeof b[k] === 'string' ? b[k].trim() : String(b[k])) : null);
    const name = txt('name');
    if (name !== null && !name) return res.status(400).json({ success: false, message: 'name(자재명) 은 비울 수 없습니다.' });
    // price: 미전달 → 보존, null/'' → NULL(단가 미정), 숫자 → 0 이상 정수 반올림
    const priceProvided = b.price !== undefined;
    let price = null;
    if (priceProvided && b.price !== null && b.price !== '') {
      const n = Number(b.price);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'price(단가) 는 0 이상의 숫자여야 합니다.' });
      price = Math.round(n);
    }
    // waste_pct: 미전달 → 보존, 0 이상 숫자
    const wasteProvided = b.waste_pct !== undefined;
    let waste = 0;
    if (wasteProvided) {
      const n = Number(b.waste_pct);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'waste_pct(로스율) 는 0 이상의 숫자여야 합니다.' });
      waste = n;
    }
    const cat = await normCatalogRef(b.catalog_item_id, req.teamId);
    const activeProvided = b.active !== undefined;
    const active = parseBool(b.active, true);

    const { rows } = await pool.query(
      `UPDATE interior_materials SET
         brand=COALESCE($1, brand), name=COALESCE($2, name), kind=COALESCE($3, kind),
         spec=COALESCE($4, spec), unit=COALESCE($5, unit), trade=COALESCE($6, trade),
         price=CASE WHEN $7::boolean THEN $8::bigint ELSE price END,
         waste_pct=CASE WHEN $9::boolean THEN $10::numeric ELSE waste_pct END,
         catalog_item_id=CASE WHEN $11::boolean THEN $12::bigint ELSE catalog_item_id END,
         active=CASE WHEN $13::boolean THEN $14::boolean ELSE active END,
         updated_at=now()
       WHERE id=$15 AND team_id=$16
       RETURNING id`,
      [txt('brand'), name, txt('kind'), txt('spec'), txt('unit'), txt('trade'),
       priceProvided, price, wasteProvided, waste, cat.provided, cat.id, activeProvided, active, id, req.teamId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: '해당 자재를 찾을 수 없습니다.' });
    const q = await pool.query(
      `SELECT m.*, c.name AS catalog_name
         FROM interior_materials m LEFT JOIN interior_catalog c ON c.id = m.catalog_item_id
        WHERE m.id=$1`,
      [id]
    );
    res.json(rowToMaterial(q.rows[0]));
  } catch (err) {
    console.error('PUT /api/materials/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '자재를 수정하지 못했습니다.' });
  }
});

// DELETE /api/materials/:id — 자재 삭제 (팀 스코핑; takeoff/견적 행은 코드 텍스트 보유라 영향 없음)
app.delete('/api/materials/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: '잘못된 자재 id 형식입니다.' });
    const { rowCount } = await pool.query('DELETE FROM interior_materials WHERE id=$1 AND team_id=$2', [id, req.teamId]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: '해당 자재를 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/materials/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '자재를 삭제하지 못했습니다.' });
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
