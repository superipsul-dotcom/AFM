// ========================================
// 💰 가계부 분석 에이전트 (analyst.mjs)
// AFM week-5 / income_expense — "내 데이터 = 내 에이전트의 자산"
//
// 구조:  [질문] → AI가 read-only SQL 생성(tool call) → Supabase 조회 → AI 분석 → [맞춤 답변]
//
//   - 가계부 앱(index.html + server.js)이 쌓은 "똑같은 Supabase 프로젝트/테이블"에 접속.
//   - OpenAI tool-calling 으로 모델이 직접 SQL 을 만들어 실행하는 에이전트 루프.
//   - 🔒 안전장치: SELECT/WITH 만 허용, READ ONLY 트랜잭션, statement_timeout, 1쿼리만.
//
// 사용법:
//   node analyst.mjs "이번 달 얼마 썼어?"      # 단발 질문
//   node analyst.mjs                            # 대화형(REPL) 모드
//   npm run ask -- "교통비 월평균 얼마야?"
//
// 자격증명은 .env(DATABASE_URL, OPENAI_API_KEY)에서만 읽음. 코드에 하드코딩 금지.
// ========================================

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pg from 'pg';

const { Pool } = pg;

// DATE(oid 1082)를 JS Date 객체가 아닌 'YYYY-MM-DD' 문자열 그대로 받는다.
// (Date 변환 시 JSON 직렬화에서 UTC로 하루 밀리는 타임존 버그 방지)
pg.types.setTypeParser(1082, (v) => v);

// ----------------------------------------
// 설정
// ----------------------------------------
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini'; // my-food/week-3 와 동일 모델

if (!DATABASE_URL) { console.error('❌ .env 에 DATABASE_URL 이 없습니다.'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('❌ .env 에 OPENAI_API_KEY 가 없습니다.'); process.exit(1); }

// ----------------------------------------
// DB 풀 (가계부 앱과 동일한 Supabase, SSL 필수)
// ----------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

// ----------------------------------------
// 🔒 read-only SQL 안전 검증 + 실행
//   - 단일 SELECT/WITH 문만 허용
//   - DML/DDL 키워드 차단
//   - READ ONLY 트랜잭션 + statement_timeout 으로 이중 방어
// ----------------------------------------
const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|copy|merge|call|do|vacuum|reindex|refresh)\b/i;

function assertReadOnly(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, ''); // 끝 세미콜론 제거
  if (trimmed.includes(';')) throw new Error('여러 SQL 문은 허용되지 않습니다 (1개의 SELECT만).');
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error('SELECT 또는 WITH 로 시작하는 조회 쿼리만 허용됩니다.');
  if (FORBIDDEN.test(trimmed)) throw new Error('데이터를 변경하는 키워드는 사용할 수 없습니다 (읽기 전용).');
  return trimmed;
}

async function runSql(sql) {
  const safe = assertReadOnly(sql);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '8s'");
    const res = await client.query(safe);
    await client.query('COMMIT');
    // 결과가 너무 크면 잘라서 토큰 폭주 방지
    const rows = res.rows.slice(0, 200);
    return { rowCount: res.rowCount, rows, truncated: res.rowCount > rows.length };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ----------------------------------------
// 스키마 안내 (모델에게 테이블 구조를 알려줌)
// ----------------------------------------
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const SCHEMA_DOC = `
스키마 (PostgreSQL / Supabase):

테이블 transactions  -- 수입/지출 내역
  id         bigint
  type       text     -- 'income'(수입) | 'expense'(지출)
  amount     bigint   -- 금액(원, 양의 정수)
  category   text     -- 지출: 식비/교통/주거/구독료/경조사/쇼핑/의료/기타, 수입: 급여/용돈/부수입/기타
  memo       text
  date       date     -- 거래 날짜
  created_at timestamptz

테이블 budgets  -- 카테고리별 "월 예산" 한도
  id        bigint
  category  text   -- 지출 카테고리(UNIQUE)
  amount    bigint -- 월 예산 한도(원)
  created_at timestamptz

분석 팁:
- 지출 합계는 항상 type='expense', 수입은 type='income' 으로 필터.
- "이번 달"은 date_trunc('month', CURRENT_DATE) 기준.
- 요일: to_char(date,'Dy') 또는 extract(dow from date) (0=일요일..6=토요일).
- 주말 = dow in (0,6), 주중 = dow in (1,2,3,4,5).
- 금액은 항상 원(KRW) 단위 정수.
`;

const SYSTEM_PROMPT = `너는 사용자의 개인 가계부 데이터를 분석하는 한국어 재무 비서야.
오늘 날짜는 ${todayStr()} 이야.

${SCHEMA_DOC}

규칙:
1. 사용자의 질문에 답하려면 반드시 run_sql 도구로 read-only SELECT 쿼리를 실행해 실제 데이터를 확인해. 추측하지 마.
2. 필요하면 도구를 여러 번 호출해도 돼(단, 한 번에 SELECT 1개).
3. 데이터를 확인한 뒤에는 친근하고 간결한 한국어로, 숫자는 천단위 콤마+"원"으로 답해.
4. 절약 조언/예측 질문이면 데이터 근거를 들어 구체적으로 제안해.
5. 데이터가 없으면 솔직히 "데이터가 없다"고 말해.`;

// run_sql 도구 정의
const TOOLS = [{
  type: 'function',
  function: {
    name: 'run_sql',
    description: '가계부 Supabase DB에 read-only SELECT 쿼리를 실행하고 결과 행을 반환한다. SELECT/WITH 만 가능.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '실행할 단일 PostgreSQL SELECT(또는 WITH) 쿼리' },
      },
      required: ['sql'],
    },
  },
}];

// ----------------------------------------
// OpenAI 호출
// ----------------------------------------
async function chat(messages) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, temperature: 0.2 }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI API 오류 ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// ----------------------------------------
// 에이전트 루프: 질문 1건 처리
// ----------------------------------------
async function ask(question, { verbose = true } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];

  for (let step = 0; step < 6; step++) {
    const msg = await chat(messages);
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      return msg.content || '(빈 응답)';
    }

    // 도구 호출 처리
    for (const call of calls) {
      let result;
      try {
        const { sql } = JSON.parse(call.function.arguments || '{}');
        if (verbose) console.log(`\n  🔎 SQL: ${sql.replace(/\s+/g, ' ').trim()}`);
        const out = await runSql(sql);
        if (verbose) console.log(`     → ${out.rowCount}행${out.truncated ? ' (일부만 표시)' : ''}`);
        result = JSON.stringify(out);
      } catch (e) {
        if (verbose) console.log(`     ⚠️  ${e.message}`);
        result = JSON.stringify({ error: e.message });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return '죄송해요, 답을 정리하지 못했어요. 질문을 조금 더 구체적으로 해주세요.';
}

// ----------------------------------------
// 진입점: 인자 있으면 단발, 없으면 대화형
// ----------------------------------------
async function main() {
  const arg = process.argv.slice(2).join(' ').trim();

  // 연결 체크
  try {
    await pool.query('select 1');
  } catch (e) {
    console.error('❌ Supabase 연결 실패:', e.message);
    process.exit(1);
  }

  if (arg) {
    const answer = await ask(arg);
    console.log(`\n💬 ${answer}\n`);
    await pool.end();
    return;
  }

  // 대화형 모드
  console.log('💰 가계부 분석 에이전트 (종료: exit / quit / 빈 줄 두 번)');
  console.log('   예) 이번 달 얼마 썼어?  /  주중 vs 주말 지출 비교해줘  /  절약할 것 추천해줘\n');
  const rl = readline.createInterface({ input, output });
  let emptyCount = 0;
  while (true) {
    const q = (await rl.question('🙋 ')).trim();
    if (['exit', 'quit', '종료'].includes(q.toLowerCase())) break;
    if (!q) { if (++emptyCount >= 2) break; continue; }
    emptyCount = 0;
    try {
      const answer = await ask(q);
      console.log(`\n💬 ${answer}\n`);
    } catch (e) {
      console.log(`\n⚠️  오류: ${e.message}\n`);
    }
  }
  rl.close();
  await pool.end();
  console.log('👋 종료합니다.');
}

main().catch((e) => { console.error(e); process.exit(1); });
