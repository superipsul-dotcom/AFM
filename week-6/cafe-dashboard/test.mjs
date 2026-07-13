// ========================================
// ☕ 카페 안도 대시보드 — e2e 검증 (node test.mjs [baseUrl])
// 서버가 떠 있어야 한다: npm start (기본 http://localhost:3016)
// ========================================

const BASE = process.argv[2] || 'http://localhost:3016';
const OWNER_CODE = process.env.OWNER_CODE || 'ANDO2026';
const stamp = Date.now();
const EMAIL = `boss.${stamp}@cafeando.test`;
const PASSWORD = 'ando-pass-123';

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

console.log(`\n☕ 카페 안도 대시보드 e2e — ${BASE}\n`);

// ---------- 1. 헬스 ----------
console.log('1) 헬스체크');
{
  const r = await req('GET', '/api/health');
  check('GET /api/health 200 + ok', r.status === 200 && r.json?.ok === true);
}

// ---------- 2. Auth ----------
console.log('2) Auth (회원가입/로그인/보호)');
let token = null;
{
  let r = await req('POST', '/api/auth/signup', { body: { email: EMAIL, password: PASSWORD, name: '안도 사장' } });
  check('사장님 코드 없이 가입 → 403', r.status === 403);

  r = await req('POST', '/api/auth/signup', { body: { email: EMAIL, password: PASSWORD, name: '안도 사장', ownerCode: 'WRONG' } });
  check('틀린 코드 가입 → 403', r.status === 403);

  r = await req('POST', '/api/auth/signup', { body: { email: EMAIL, password: PASSWORD, name: '안도 사장', ownerCode: OWNER_CODE } });
  check('올바른 코드 가입 → 201 + token', r.status === 201 && !!r.json?.token, JSON.stringify(r.json));

  r = await req('POST', '/api/auth/signup', { body: { email: EMAIL, password: PASSWORD, name: '안도 사장', ownerCode: OWNER_CODE } });
  check('중복 이메일 가입 → 409', r.status === 409);

  r = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: 'wrong-pass' } });
  check('틀린 비밀번호 로그인 → 401', r.status === 401);

  r = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  check('로그인 → 200 + token', r.status === 200 && !!r.json?.token);
  token = r.json.token;

  r = await req('GET', '/api/me', { token });
  check('GET /api/me → 사장 이름', r.status === 200 && r.json?.user?.name === '안도 사장');

  r = await req('GET', '/api/dashboard');
  check('토큰 없이 대시보드 → 401', r.status === 401);
}

// ---------- 3. 대시보드 (DB 소스) ----------
console.log('3) 대시보드 데이터 (Supabase cafe_*)');
{
  const r = await req('GET', '/api/dashboard', { token });
  const d = r.json || {};
  check('GET /api/dashboard 200', r.status === 200);
  check('최근 영업일(refDate) 존재', !!d.refDate);
  check('주간 매출 7일', Array.isArray(d.weekSales) && d.weekSales.length === 7);
  check('주간 합계·전주 합계 존재', d.totals?.week_rev > 0 && d.totals?.prev_week_rev > 0);
  check('인기 메뉴 TOP3', Array.isArray(d.topMenus) && d.topMenus.length === 3);
  check('재고 경고 1건 이상 (시드: 흑임자·무화과 등)', Array.isArray(d.inventoryAlerts) && d.inventoryAlerts.length >= 1);
  check('최근 리뷰 3건', Array.isArray(d.recentReviews) && d.recentReviews.length === 3);
  check('최근 영업일 실적 + 전주 같은 요일 비교값', d.lastDay?.revenue > 0 && d.lastDay?.prev_same_dow > 0);
}

// ---------- 4. 날씨 (외부 API 소스) ----------
console.log('4) 날씨 (Open-Meteo)');
{
  const r = await req('GET', '/api/weather', { token });
  const w = r.json || {};
  check('GET /api/weather 200', r.status === 200, JSON.stringify(w).slice(0, 120));
  check('오늘 예보(기온·강수확률·라벨)', w.today && typeof w.today.tmax === 'number' && typeof w.today.precipProb === 'number' && !!w.today.label);
  check('시간별 예보 존재', Array.isArray(w.hourly) && w.hourly.length >= 6);
}

// ---------- 5. 할일 CRUD ----------
console.log('5) 할일 (cafe_todos)');
let todoId = null;
{
  let r = await req('GET', '/api/todos', { token });
  check('GET /api/todos — 시드 포함', r.status === 200 && r.json.todos.length >= 5);

  r = await req('POST', '/api/todos', { token, body: { title: 'e2e 테스트 할일', due_date: r.json.today } });
  check('POST /api/todos 201', r.status === 201 && r.json.todo?.id > 0);
  todoId = r.json.todo?.id;

  r = await req('POST', '/api/todos', { token, body: { title: '   ' } });
  check('빈 할일 → 400', r.status === 400);

  r = await req('PATCH', `/api/todos/${todoId}`, { token, body: { done: true } });
  check('PATCH done=true', r.status === 200 && r.json.todo?.done === true && !!r.json.todo?.done_at);

  r = await req('PATCH', `/api/todos/${todoId}`, { token, body: { done: false } });
  check('PATCH done=false (done_at 초기화)', r.status === 200 && r.json.todo?.done === false && r.json.todo?.done_at === null);

  r = await req('DELETE', `/api/todos/${todoId}`, { token });
  check('DELETE 할일', r.status === 200 && r.json.ok === true);

  r = await req('DELETE', `/api/todos/${todoId}`, { token });
  check('없는 할일 삭제 → 404', r.status === 404);
}

// ---------- 6. AI 브리핑 ----------
console.log('6) AI 브리핑 (생성 → 캐시)');
{
  let r = await req('GET', '/api/briefing', { token });
  check('GET /api/briefing 200', r.status === 200);

  r = await req('POST', '/api/briefing/generate', { token, body: {} });
  const c = r.json?.briefing?.content || '';
  check('브리핑 생성 200 + 내용', r.status === 200 && c.length > 100, JSON.stringify(r.json).slice(0, 150));
  check('브리핑에 실데이터 숫자 인용(원/명)', /원/.test(c) && /명|잔|개/.test(c));

  const r2 = await req('POST', '/api/briefing/generate', { token, body: {} });
  check('재요청 → cached:true (하루 1회 캐시)', r2.status === 200 && r2.json?.cached === true);

  const r3 = await req('GET', '/api/briefing', { token });
  check('GET /api/briefing → 오늘자 캐시 반환', r3.status === 200 && !!r3.json?.briefing?.content);
}

// ---------- 7. 정적 UI ----------
console.log('7) 정적 UI');
{
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  check('GET / → index.html (대시보드 타이틀)', res.status === 200 && html.includes('사장님 대시보드'));
}

console.log(`\n===== 결과: ${passed}/${passed + failed} 통과 =====\n`);
process.exit(failed ? 1 : 0);
