// ========================================
// 🧊 우리집 냉장고 — 재료 & 레시피 관리앱 백엔드 (Supabase PostgreSQL 영속화)
// AFM week-5 / my-food (Server + DB)
//
// 핵심: 재료/레시피를 localStorage 가 아니라 "실제 Postgres DB"에 저장한다.
//   - Express  : 정적 파일(index.html) 서빙 + REST CRUD API 제공
//   - pg(Pool) : Supabase(Supavisor transaction pooler)에 연결
//   - dotenv   : 자격 증명을 .env 에서 읽어옴 (코드에 하드코딩 금지)
//
// 테이블 2개:
//   ingredients (name, quantity, category, expiry, created_at) — 재료
//   recipes     (title, ingredients, steps, created_at)        — 레시피
//
// ⚠️ index.html(UI)이 기대하는 API 계약에 1:1 로 맞춰져 있다.
//    응답 봉투: { success, data, message }  /  createdAt 은 epoch-ms 숫자
//    recipe 의 ingredients/steps 는 '\n' 구분 TEXT 문자열로 주고받는다.
//    ingredient 의 expiry 는 'YYYY-MM-DD' 문자열(없으면 '') 로 주고받는다.
//
// 🔐 보안: DB 접속 정보는 process.env.DATABASE_URL 로만 읽고, .env 는 .gitignore 로 제외.
// ========================================

require('dotenv').config(); // .env → process.env 로 로드 (가장 먼저 실행)

const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// PORT 는 .env 에서, 없으면 3005. (옆 폴더 fridge-recipe 가 3003 이라 충돌 피하려 3005 기본)
const PORT = Number((process.env.PORT || '3005').trim());

// ----------------------------------------
// OpenAI (AI 레시피 추천) 설정
//   - 키는 .env 의 OPENAI_API_KEY 로만 읽고, 절대 프론트엔드에 노출하지 않는다.
//   - week-3 의 다른 AI 앱들과 동일하게 native fetch 로 chat/completions 호출.
// ----------------------------------------
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const AI_MODEL = 'gpt-4o-mini';

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
// 별도 마이그레이션 단계 없이 서버만 켜면 스키마가 준비된다.
// 서버리스(cold start)에서 여러 번 호출돼도 안전하도록 flag 로 중복 방지.
//
// 스키마:
//   ingredients
//     id          UUID         기본키 (gen_random_uuid())
//     name        TEXT         재료명
//     quantity    TEXT         수량 (예: '6개', '500g')
//     category    TEXT         보관 위치 (냉장/냉동/실온, 기본 '냉장')
//     expiry      TEXT         유통기한 'YYYY-MM-DD' (없으면 '')
//     created_at  TIMESTAMPTZ  생성 시각 (기본 now())
//   recipes
//     id          UUID         기본키 (gen_random_uuid())
//     title       TEXT         요리명
//     ingredients TEXT         재료 목록 ('\n' 구분 문자열)
//     steps       TEXT         조리법 ('\n' 구분 문자열)
//     created_at  TIMESTAMPTZ  생성 시각 (기본 now())
// ----------------------------------------
let dbInitialized = false;

async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingredients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      quantity TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '냉장',
      expiry TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // 마이그레이션: 예전 테이블에 컬럼이 없어도 자동 보강. IF NOT EXISTS 라 반복 실행에 안전.
  await pool.query(
    `ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS quantity TEXT NOT NULL DEFAULT '';`
  );
  await pool.query(
    `ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS expiry TEXT NOT NULL DEFAULT '';`
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      ingredients TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  dbInitialized = true;
  console.log('🗄️  ingredients / recipes 테이블 준비 완료.');
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
// DB row → 클라이언트 모델 매핑 (snake_case → camelCase)
//
// ⚠️ 프론트엔드(index.html)는 createdAt 을 "epoch ms 숫자"로 다룬다.
//    pg 는 TIMESTAMPTZ 를 JS Date 로 돌려주므로 .getTime() 으로 ms 숫자 변환.
//    recipe 의 ingredients/steps 는 TEXT('\n' 구분 문자열) 그대로 내려준다.
//    ingredient 의 expiry 는 TEXT('YYYY-MM-DD' 또는 '') 그대로 내려준다.
// ----------------------------------------
function rowToIngredient(row) {
  return {
    id: row.id,                                    // UUID 문자열
    name: row.name,
    quantity: row.quantity,                        // 수량 문자열 (예: '6개')
    category: row.category,                        // 보관 위치 (냉장/냉동/실온)
    expiry: row.expiry || '',                      // 유통기한 'YYYY-MM-DD' 또는 ''
    createdAt: new Date(row.created_at).getTime(), // → epoch ms (number)
  };
}

function rowToRecipe(row) {
  return {
    id: row.id,
    title: row.title,
    ingredients: row.ingredients,                  // '\n' 구분 문자열
    steps: row.steps,                              // '\n' 구분 문자열
    createdAt: new Date(row.created_at).getTime(),
  };
}

// 문자열 정규화 헬퍼: 문자열이 아니면 '' 로, 맞으면 trim.
const asString = (v) => (typeof v === 'string' ? v.trim() : '');

// ========================================
// REST API — 재료(ingredients) CRUD
// 모든 쿼리는 파라미터화($1, $2)로 작성 → SQL injection 방지.
// 응답 형식 통일: { success, data?, message? }
// 상태 코드: 200 ok / 201 create / 400 검증 / 404 없음 / 500 서버
// ========================================

// --- GET /api/ingredients : 전체 재료 목록 (최신순) ---
app.get('/api/ingredients', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, quantity, category, expiry, created_at FROM ingredients ORDER BY created_at DESC'
    );
    res.json({ success: true, data: rows.map(rowToIngredient) });
  } catch (err) {
    console.error('GET /api/ingredients 오류:', err.message);
    res.status(500).json({ success: false, message: '재료 목록을 불러오지 못했습니다.' });
  }
});

// --- POST /api/ingredients : 재료 추가 ---
// body: { name, quantity, category, expiry }
app.post('/api/ingredients', async (req, res) => {
  try {
    const name = asString(req.body && req.body.name);
    const quantity = asString(req.body && req.body.quantity);
    const category = asString(req.body && req.body.category) || '냉장';
    const expiry = asString(req.body && req.body.expiry);

    if (!name) {
      return res.status(400).json({ success: false, message: '재료명을 입력해 주세요.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO ingredients (name, quantity, category, expiry)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, quantity, category, expiry, created_at`,
      [name, quantity, category, expiry]
    );
    res.status(201).json({ success: true, data: rowToIngredient(rows[0]) });
  } catch (err) {
    console.error('POST /api/ingredients 오류:', err.message);
    res.status(500).json({ success: false, message: '재료를 저장하지 못했습니다.' });
  }
});

// --- DELETE /api/ingredients/:id : 재료 삭제 ---
app.delete('/api/ingredients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM ingredients WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 재료를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id } });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 재료 id 형식입니다.' });
    }
    console.error('DELETE /api/ingredients/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '재료를 삭제하지 못했습니다.' });
  }
});

// ========================================
// REST API — 레시피(recipes) CRUD
// recipe 의 ingredients/steps 는 '\n' 구분 TEXT 문자열로 받는다.
// (UI 는 칩/번호단계를 배열로 다루다가 '\n' 으로 join 해서 보낸다)
// ========================================

// --- GET /api/recipes : 전체 레시피 목록 (최신순) ---
app.get('/api/recipes', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, ingredients, steps, created_at FROM recipes ORDER BY created_at DESC'
    );
    res.json({ success: true, data: rows.map(rowToRecipe) });
  } catch (err) {
    console.error('GET /api/recipes 오류:', err.message);
    res.status(500).json({ success: false, message: '레시피 목록을 불러오지 못했습니다.' });
  }
});

// --- POST /api/recipes : 레시피 작성 ---
// body: { title, ingredients, steps }
app.post('/api/recipes', async (req, res) => {
  try {
    const title = asString(req.body && req.body.title);
    const ingredients = asString(req.body && req.body.ingredients);
    const steps = asString(req.body && req.body.steps);

    if (!title) {
      return res.status(400).json({ success: false, message: '요리명을 입력해 주세요.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO recipes (title, ingredients, steps)
       VALUES ($1, $2, $3)
       RETURNING id, title, ingredients, steps, created_at`,
      [title, ingredients, steps]
    );
    res.status(201).json({ success: true, data: rowToRecipe(rows[0]) });
  } catch (err) {
    console.error('POST /api/recipes 오류:', err.message);
    res.status(500).json({ success: false, message: '레시피를 저장하지 못했습니다.' });
  }
});

// --- PUT /api/recipes/:id : 레시피 수정 ---
// body: { title, ingredients, steps }
app.put('/api/recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const title = asString(req.body && req.body.title);
    const ingredients = asString(req.body && req.body.ingredients);
    const steps = asString(req.body && req.body.steps);

    if (!title) {
      return res.status(400).json({ success: false, message: '요리명을 입력해 주세요.' });
    }

    const { rows } = await pool.query(
      `UPDATE recipes
       SET title = $1, ingredients = $2, steps = $3
       WHERE id = $4
       RETURNING id, title, ingredients, steps, created_at`,
      [title, ingredients, steps, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 레시피를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rowToRecipe(rows[0]) });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 레시피 id 형식입니다.' });
    }
    console.error('PUT /api/recipes/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '레시피를 수정하지 못했습니다.' });
  }
});

// --- DELETE /api/recipes/:id : 레시피 삭제 ---
app.delete('/api/recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM recipes WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '해당 레시피를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: { id } });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ success: false, message: '잘못된 레시피 id 형식입니다.' });
    }
    console.error('DELETE /api/recipes/:id 오류:', err.message);
    res.status(500).json({ success: false, message: '레시피를 삭제하지 못했습니다.' });
  }
});

// ========================================
// 🤖 AI 레시피 추천 — POST /api/ai/recommend
//   DB 의 현재 재료를 읽어 프롬프트를 만들고 OpenAI(gpt-4o-mini)로 요리 2~3개를 추천받는다.
//   - 유통기한 임박/지난 재료를 우선 활용하도록 유도(앱이 가진 expiry 데이터 활용).
//   - OpenAI JSON 모드로 받아 파싱 → recipe 모양({title, ingredients[], steps[], have[], missing[], tip})으로 정규화.
//   - 추천만 반환하고 저장은 안 한다(프론트가 '저장' 시 기존 POST /api/recipes 로 영속).
// ========================================
app.post('/api/ai/recommend', async (_req, res) => {
  try {
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'OpenAI API 키가 설정되지 않았습니다. .env 에 OPENAI_API_KEY 를 넣고 서버를 다시 시작해 주세요.',
      });
    }

    // 현재 냉장고 재료 조회 (서버가 단일 출처)
    const { rows } = await pool.query(
      'SELECT name, quantity, category, expiry FROM ingredients ORDER BY created_at DESC'
    );
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: '냉장고에 재료가 없어요. 재료를 먼저 추가해 주세요.' });
    }

    // 유통기한 → D-day 표현 (서버 오늘 자정 기준)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dday = (iso) => {
      if (!iso) return '';
      const t = new Date(iso + 'T00:00:00');
      if (Number.isNaN(t.getTime())) return '';
      const d = Math.round((t - today) / 86400000);
      if (d < 0) return `유통기한 ${Math.abs(d)}일 지남`;
      if (d === 0) return '오늘까지';
      return `D-${d}`;
    };
    const ingLines = rows
      .map((r) => `- ${r.name}${r.quantity ? ` ${r.quantity}` : ''} (${r.category}${dday(r.expiry) ? `, ${dday(r.expiry)}` : ''})`)
      .join('\n');

    const systemPrompt =
      '너는 한국 자취생을 위한 친절한 요리 추천 도우미야. 사용자가 가진 냉장고 재료로 지금 당장 만들 수 있는 현실적인 1인분 요리를 추천해. ' +
      '소금·간장·식용유·설탕 같은 기본 양념은 집에 있다고 가정해도 되지만, 주재료는 보유 목록 위주로 사용해. ' +
      '반드시 지정된 JSON 형식으로만 답하고 그 외의 말은 절대 하지 마.';

    const userPrompt =
`내 냉장고 재료:
${ingLines}

위 재료로 만들 수 있는 요리를 2~3개 추천해줘.
- 유통기한이 임박했거나 지난 재료(D-3 이하 / 오늘까지 / 지남)를 가능하면 먼저 활용해줘.
- 모든 텍스트는 한국어로.
- 아래 JSON 스키마를 정확히 지켜서 답해줘(키 이름 변경 금지):

{
  "recipes": [
    {
      "title": "요리 이름",
      "ingredients": ["재료 분량 포함", "..."],
      "steps": ["조리 1단계", "조리 2단계", "..."],
      "have": ["내가 보유한 재료 중 사용하는 것"],
      "missing": ["추가로 사야 하는 재료 (없으면 빈 배열)"],
      "tip": "한 줄 요리 팁"
    }
  ]
}`;

    const aiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' }, // JSON 모드 → 파싱 안정성
        temperature: 0.7,
      }),
    });

    if (!aiRes.ok) {
      let detail = `HTTP ${aiRes.status}`;
      try { const e = await aiRes.json(); detail = (e.error && e.error.message) || detail; } catch (_) {}
      console.error('OpenAI 오류:', detail);
      return res.status(502).json({ success: false, message: `AI 추천 요청에 실패했어요 (${detail}).` });
    }

    const data = await aiRes.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    let parsed;
    try { parsed = JSON.parse(content); } catch (_) {
      return res.status(502).json({ success: false, message: 'AI 응답을 해석하지 못했어요. 다시 시도해 주세요.' });
    }

    // 정규화: 배열/문자열 어느 쪽이 와도 깔끔한 문자열 배열로.
    const toArr = (v) =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
        : (typeof v === 'string' ? v.split('\n').map((s) => s.trim()).filter(Boolean) : []);

    const list = Array.isArray(parsed && parsed.recipes) ? parsed.recipes : [];
    const recipes = list.slice(0, 3).map((r) => ({
      title: asString(r && r.title) || '이름 없는 요리',
      ingredients: toArr(r && r.ingredients),
      steps: toArr(r && r.steps),
      have: toArr(r && r.have),
      missing: toArr(r && r.missing),
      tip: asString(r && r.tip),
    })).filter((r) => r.title && (r.ingredients.length || r.steps.length));

    if (recipes.length === 0) {
      return res.status(502).json({ success: false, message: 'AI가 추천을 만들지 못했어요. 다시 시도해 주세요.' });
    }

    res.json({ success: true, data: { recipes } });
  } catch (err) {
    console.error('POST /api/ai/recommend 오류:', err.message);
    res.status(500).json({ success: false, message: 'AI 추천 중 오류가 발생했어요.' });
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
    console.log(`✅ 우리집 냉장고 서버 실행 중 → http://localhost:${PORT}`);
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
