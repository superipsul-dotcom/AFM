// ========================================
// ☕ 카페 안도 — 사장님 대시보드 서버 (PORT 3016)
// AFM week-6 / cafe-dashboard
//
// [로그인(JWT)] → [Auth 확인] → [카페 DB(Supabase cafe_*) + 날씨 API(Open-Meteo)]
//                → [AI가 데이터 종합 → "오늘의 카페 브리핑"(gpt-4o, DB 캐시)]
//
// 데이터 소스 2+:
//   ① Supabase DB — week-5/my-cafe 미션이 시드한 cafe_daily_sales/menu_sales/reviews/inventory
//                    + 이 앱의 cafe_users(사장님 계정)/cafe_todos(할일)/cafe_briefings(브리핑 캐시)
//   ② 외부 API — Open-Meteo 성수동 예보 (키 불필요, 서버에서 프록시 + 20분 캐시)
//
// Vercel 서버리스 호환: module.exports = app, 스키마 준비는 인스턴스당 1회 lazy,
// 파일 쓰기 없음(브리핑은 DB에 저장), 날짜는 전부 KST 기준.
// ========================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v); // DATE → 'YYYY-MM-DD' 문자열 (타임존 밀림 방지)

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OWNER_CODE = (process.env.OWNER_CODE || 'ANDO2026').trim(); // 사장님 가입 코드
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim();
const PORT = Number(process.env.PORT || 3016);

if (!DATABASE_URL) { console.error('❌ .env 에 DATABASE_URL 이 없습니다.'); process.exit(1); }
if (!JWT_SECRET) { console.error('❌ .env 에 JWT_SECRET 이 없습니다.'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

// ----------------------------------------
// KST 시간 유틸 (Vercel 서버는 UTC — 반드시 +9h 보정)
// ----------------------------------------
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstToday() { return kstNow().toISOString().slice(0, 10); }          // 'YYYY-MM-DD'
function kstDow() { return kstNow().getUTCDay(); }                          // 0=일 … 1=월(휴무) … 6=토
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

// ----------------------------------------
// 스키마 준비 (서버리스: 인스턴스당 1회)
// ----------------------------------------
const SEED_TODOS = [
  // [title, due(days from today, null=없음), done, source]
  ['흑임자 페이스트 5kg 발주 (리드타임 4일 — 오늘 전화)', 0, false, 'seed'],
  ['우유 내일 배송 20L로 증량 요청', 0, false, 'seed'],
  ['생무화과 4kg 발주 (주말 케이크용, 목요일까지)', 3, false, 'seed'],
  ['1층 입구 안내판 시안 확정 → 제작 발주', 2, false, 'seed'],
  ['인스타 릴스 "샘플월 투어" 촬영', 4, false, 'seed'],
  ['주말 알바 급여 이체', -1, true, 'seed'],
  ['원두 입고 확인 (로우스터리 서울)', -1, true, 'seed'],
];

async function initDb() {
  await pool.query(`
    create table if not exists cafe_users (
      id bigserial primary key,
      email text unique not null,
      password_hash text not null,
      name text not null,
      created_at timestamptz not null default now()
    )`);
  await pool.query(`
    create table if not exists cafe_todos (
      id bigserial primary key,
      title text not null,
      done boolean not null default false,
      due_date date,
      source text not null default 'manual',
      created_at timestamptz not null default now(),
      done_at timestamptz
    )`);
  await pool.query(`
    create table if not exists cafe_briefings (
      id bigserial primary key,
      date date unique not null,
      content text not null,
      model text not null,
      inputs jsonb,
      created_at timestamptz not null default now()
    )`);

  const { rows: [{ n }] } = await pool.query('select count(*)::int n from cafe_todos');
  if (n === 0) {
    const today = kstToday();
    for (const [title, dueOffset, done, source] of SEED_TODOS) {
      const due = dueOffset === null ? null
        : new Date(Date.parse(today) + dueOffset * 86400000).toISOString().slice(0, 10);
      await pool.query(
        `insert into cafe_todos (title, due_date, done, source, done_at)
         values ($1,$2,$3,$4, case when $3 then now() else null end)`,
        [title, due, done, source],
      );
    }
  }
}

let readyPromise = null;
function ensureReady() { readyPromise ||= initDb(); return readyPromise; }

// ----------------------------------------
// 앱 + 미들웨어
// ----------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/api', async (_req, res, next) => {
  try { await ensureReady(); next(); }
  catch (e) { console.error('initDb 실패:', e); res.status(500).json({ error: 'DB 초기화 실패' }); }
});

function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: '로그인이 필요합니다.' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '토큰이 유효하지 않습니다. 다시 로그인해주세요.' });
  }
}

// ----------------------------------------
// 헬스체크
// ----------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'cafe-ando-dashboard', kstNow: kstNow().toISOString() }));

// ----------------------------------------
// Auth — 회원가입(사장님 코드 필요) / 로그인
// ----------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, ownerCode } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: '이름/이메일/비밀번호를 모두 입력해주세요.' });
  if (String(password).length < 6) return res.status(400).json({ error: '비밀번호는 6자 이상이어야 합니다.' });
  if ((ownerCode || '').trim() !== OWNER_CODE) return res.status(403).json({ error: '사장님 코드가 올바르지 않습니다.' });
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    const { rows: [u] } = await pool.query(
      'insert into cafe_users (email, password_hash, name) values ($1,$2,$3) returning id, email, name',
      [String(email).toLowerCase().trim(), hash, String(name).trim()],
    );
    const token = jwt.sign({ uid: u.id, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: u });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '이미 가입된 이메일입니다.' });
    throw e;
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '이메일/비밀번호를 입력해주세요.' });
  const { rows: [u] } = await pool.query('select * from cafe_users where email = $1', [String(email).toLowerCase().trim()]);
  if (!u || !bcrypt.compareSync(String(password), u.password_hash)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  const token = jwt.sign({ uid: u.id, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, email: u.email, name: u.name } });
});

app.get('/api/me', auth, (req, res) => res.json({ user: { id: req.user.uid, email: req.user.email, name: req.user.name } }));

// ----------------------------------------
// 대시보드 데이터 (DB 소스) — "최근 영업일" 기준으로 항상 살아있는 데모
// ----------------------------------------
async function getDashboardData() {
  const { rows: [ref] } = await pool.query('select max(date) d from cafe_daily_sales');
  const refDate = ref.d; // 최근 영업일 (월 휴무 등으로 어제가 아닐 수 있음)

  const { rows: [lastDay] } = await pool.query(
    `select d.date, d.customers, d.revenue, d.weather, d.note,
            (select revenue from cafe_daily_sales where date = d.date - 7) prev_same_dow
       from cafe_daily_sales d where d.date = $1`, [refDate]);

  const { rows: weekSales } = await pool.query(
    `with r as (select date, customers, revenue, row_number() over (order by date desc) rn
                  from cafe_daily_sales)
     select date, customers, revenue from r where rn <= 7 order by date`);

  const { rows: [totals] } = await pool.query(
    `with r as (select revenue, customers, row_number() over (order by date desc) rn
                  from cafe_daily_sales)
     select sum(revenue) filter (where rn <= 7)::bigint  week_rev,
            sum(revenue) filter (where rn between 8 and 14)::bigint prev_week_rev,
            round(avg(customers) filter (where rn <= 7), 1) week_avg_customers
       from r where rn <= 14`);

  const { rows: topMenus } = await pool.query(
    `select menu, category, sum(qty)::int qty, sum(amount)::bigint amount
       from cafe_menu_sales
      where date > $1::date - 7
      group by menu, category order by qty desc limit 3`, [refDate]);

  const { rows: inventoryAlerts } = await pool.query(
    `select item, unit, stock, daily_usage,
            round(stock / nullif(daily_usage, 0), 1) days_left,
            reorder_point, lead_time_days, supplier, note
       from cafe_inventory
      where stock <= reorder_point or stock / nullif(daily_usage, 0) <= lead_time_days
      order by days_left asc nulls last`);

  const { rows: recentReviews } = await pool.query(
    `select date, source, rating, sentiment, content
       from cafe_reviews order by date desc, id desc limit 3`);

  return { refDate, lastDay, weekSales, totals, topMenus, inventoryAlerts, recentReviews };
}

app.get('/api/dashboard', auth, async (_req, res) => {
  const data = await getDashboardData();
  res.json({ today: kstToday(), dow: kstDow(), dowKo: DOW_KO[kstDow()], closedToday: kstDow() === 1, ...data });
});

// ----------------------------------------
// 날씨 (외부 API 소스) — Open-Meteo 성수동, 서버 프록시 + 20분 캐시
// ----------------------------------------
const WMO = [
  [[0], '맑음', '☀️'], [[1, 2], '대체로 맑음', '🌤️'], [[3], '흐림', '☁️'],
  [[45, 48], '안개', '🌫️'], [[51, 53, 55, 56, 57], '이슬비', '🌦️'],
  [[61, 63, 65, 66, 67], '비', '🌧️'], [[71, 73, 75, 77, 85, 86], '눈', '🌨️'],
  [[80, 81, 82], '소나기', '🌧️'], [[95, 96, 99], '뇌우', '⛈️'],
];
function wmoLabel(code) {
  for (const [codes, label, emoji] of WMO) if (codes.includes(code)) return { label, emoji };
  return { label: '알 수 없음', emoji: '🌡️' };
}

let weatherCache = null; // { at, data }
async function fetchWeather() {
  if (weatherCache && Date.now() - weatherCache.at < 20 * 60 * 1000) return weatherCache.data;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=37.5446&longitude=127.0559'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&hourly=temperature_2m,precipitation_probability,weather_code'
    + '&timezone=Asia%2FSeoul&forecast_days=2';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = await r.json();

  const { label, emoji } = wmoLabel(j.daily.weather_code[0]);
  const tmax = j.daily.temperature_2m_max[0];
  const today = {
    date: j.daily.time[0], label, emoji,
    tmax, tmin: j.daily.temperature_2m_min[0],
    precipProb: j.daily.precipitation_probability_max[0],
    heatwave: tmax >= 33,
  };
  // 현재 KST 시각 이후 12시간
  const nowIso = kstNow().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
  const hourly = [];
  for (let i = 0; i < j.hourly.time.length && hourly.length < 12; i++) {
    if (j.hourly.time[i].slice(0, 13) >= nowIso) {
      hourly.push({
        time: j.hourly.time[i].slice(11, 16),
        temp: Math.round(j.hourly.temperature_2m[i]),
        precipProb: j.hourly.precipitation_probability[i],
        emoji: wmoLabel(j.hourly.weather_code[i]).emoji,
      });
    }
  }
  const data = { location: '서울 성동구 성수동', today, hourly, fetchedAt: new Date().toISOString() };
  weatherCache = { at: Date.now(), data };
  return data;
}

app.get('/api/weather', auth, async (_req, res) => {
  try { res.json(await fetchWeather()); }
  catch (e) { res.status(502).json({ error: `날씨 API 오류: ${e.message}` }); }
});

// ----------------------------------------
// 할일 (Notion 대신 DB 테이블 — 대시보드에서 직접 CRUD)
// ----------------------------------------
app.get('/api/todos', auth, async (_req, res) => {
  const { rows } = await pool.query(
    `select id, title, done, due_date, source, created_at, done_at
       from cafe_todos
      order by done asc, due_date asc nulls last, id asc
      limit 30`);
  res.json({ todos: rows, today: kstToday() });
});

app.post('/api/todos', auth, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const due = (req.body?.due_date || '').trim() || null;
  if (!title) return res.status(400).json({ error: '할일 내용을 입력해주세요.' });
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: '날짜 형식은 YYYY-MM-DD 입니다.' });
  const { rows: [todo] } = await pool.query(
    'insert into cafe_todos (title, due_date) values ($1,$2) returning *', [title, due]);
  res.status(201).json({ todo });
});

app.patch('/api/todos/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 id' });
  const { done, title } = req.body || {};
  const { rows: [todo] } = await pool.query(
    `update cafe_todos set
       done = coalesce($2, done),
       done_at = case when $2 is true then now() when $2 is false then null else done_at end,
       title = coalesce(nullif(trim($3), ''), title)
     where id = $1 returning *`,
    [id, typeof done === 'boolean' ? done : null, title ?? null]);
  if (!todo) return res.status(404).json({ error: '할일을 찾을 수 없습니다.' });
  res.json({ todo });
});

app.delete('/api/todos/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '잘못된 id' });
  const { rowCount } = await pool.query('delete from cafe_todos where id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: '할일을 찾을 수 없습니다.' });
  res.json({ ok: true });
});

// ----------------------------------------
// 🤖 오늘의 카페 브리핑 — AI가 [DB + 날씨 + 할일] 종합, 하루 1회 DB 캐시
// ----------------------------------------
function loadCafeContext() {
  try { return fs.readFileSync(path.join(__dirname, 'my_cafe.md'), 'utf8'); }
  catch { return '(my_cafe.md 를 찾지 못했습니다 — 카페 안도: 성수동 2층 자재 쇼룸 겸 카페, 시그니처 흑임자 크림라떼·무화과 바스크 치즈케이크)'; }
}

async function buildBriefingDigest() {
  const dash = await getDashboardData();
  let weather = null;
  try { weather = await fetchWeather(); } catch { /* 날씨 실패해도 브리핑은 진행 */ }
  const { rows: openTodos } = await pool.query(
    'select title, due_date from cafe_todos where done = false order by due_date asc nulls last limit 10');
  return {
    today: kstToday(), dowKo: DOW_KO[kstDow()], closedToday: kstDow() === 1,
    lastBusinessDay: dash.lastDay,      // 최근 영업일 실적 (+ 전주 같은 요일 매출)
    weekSales: dash.weekSales,          // 최근 7영업일
    totals: dash.totals,                // 주간 합계/전주 대비/평균 손님
    topMenus: dash.topMenus,            // 최근 7일 인기 메뉴
    inventoryAlerts: dash.inventoryAlerts,
    recentReviews: dash.recentReviews,
    openTodos,
    weather: weather ? { today: weather.today } : null,
  };
}

app.get('/api/briefing', auth, async (_req, res) => {
  const { rows: [b] } = await pool.query('select * from cafe_briefings where date = $1', [kstToday()]);
  res.json({ briefing: b || null });
});

app.post('/api/briefing/generate', auth, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(500).json({ error: '.env 에 OPENAI_API_KEY 가 없습니다.' });
  const force = !!req.body?.force;
  const today = kstToday();

  const { rows: [cached] } = await pool.query('select * from cafe_briefings where date = $1', [today]);
  if (cached && !force) return res.json({ briefing: cached, cached: true });

  const digest = await buildBriefingDigest();
  const system = `너는 "카페 안도" 사장님의 AI 파트너야. 매일 아침 대시보드 맨 위에 실리는 "오늘의 카페 브리핑"을 쓴다.

아래는 카페 정의서(my_cafe.md) 전문 — 컨셉·타깃·메뉴·손익(BEP 일 20명)·목표가 담겨 있다:
${loadCafeContext()}

작성 규칙:
- 마크다운, 전체 9줄 이내. 첫 줄은 "**${digest.dowKo}요일**" 같은 요일 언급이 있는 다정한 인사 한 문장 (오늘 휴무면 휴무 모드로).
- 이어서 불릿 4~6개: ①최근 영업일 성과(매출·손님, 전주 같은 요일 대비 %) ②이번 주 흐름(주간 합계·전주 대비) ③오늘 날씨 → 구체적 운영 팁 (비=체류 손님·따뜻한 메뉴, 폭염=에이드·테이크아웃) ④인기 메뉴 → 오늘의 푸시 메뉴 ⑤재고·할일 중 급한 것 (리드타임 역산해서 "오늘 발주" 같은 액션으로) ⑥리뷰에서 주목할 것 1개.
- 모든 제안은 카페 안도의 컨셉(조용한 자재 쇼룸 카페·체류형)과 결이 맞아야 하고, 반드시 넘겨준 실데이터 숫자를 인용해. 일반론 금지.
- 숫자는 천단위 콤마 + "원"/"명". 이모지는 불릿당 최대 1개.`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0.4,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `오늘의 운영 데이터(JSON):\n${JSON.stringify(digest)}\n\n오늘의 카페 브리핑을 작성해줘.` },
      ],
    }),
  });
  if (!r.ok) return res.status(502).json({ error: `OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}` });
  const content = (await r.json()).choices[0].message.content;

  const { rows: [b] } = await pool.query(
    `insert into cafe_briefings (date, content, model, inputs) values ($1,$2,$3,$4)
     on conflict (date) do update set content = excluded.content, model = excluded.model,
       inputs = excluded.inputs, created_at = now()
     returning *`,
    [today, content, MODEL, JSON.stringify(digest)]);
  res.json({ briefing: b, cached: false });
});

// ----------------------------------------
// 정적 파일 + 에러 핸들러
// ----------------------------------------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use((err, _req, res, _next) => {
  console.error('서버 오류:', err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// 로컬 실행 시에만 listen (Vercel 은 module.exports 사용)
if (require.main === module) {
  app.listen(PORT, () => console.log(`☕ 카페 안도 대시보드: http://localhost:${PORT} (사장님 코드: ${OWNER_CODE})`));
}

module.exports = app;
