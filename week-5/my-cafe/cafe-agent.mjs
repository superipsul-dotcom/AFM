// ========================================
// ☕ 카페 안도 — AI 운영 파트너 에이전트 (cafe-agent.mjs)
// AFM week-5 / my-cafe — [AI Context (my_cafe.md)] + [카페 운영 DB] → [내 카페를 아는 에이전트]
//
// 구조:
//   [질문] → 시스템 프롬프트에 my_cafe.md(컨셉) 전문 주입
//          → AI가 read-only SQL 생성(tool call) → Supabase cafe_ 테이블 조회
//          → 컨셉 + 실데이터 근거의 "카페 안도 맞춤" 답변
//
// Before/After 비교(미션 Part 4)를 위해 --bare(컨텍스트 0) 모드를 내장:
//   node cafe-agent.mjs "신메뉴 뭐 추가할까?"       # ✅ After — my_cafe.md + DB
//   node cafe-agent.mjs --bare "신메뉴 뭐 추가할까?" # ❌ Before — 아무 정보 없는 일반 AI
//   node cafe-agent.mjs --compare "질문"             # 한 질문을 두 모드로 나란히
//   node cafe-agent.mjs --demo                       # 대표 질문 4개 비교 → BEFORE_AFTER.md 저장
//   node cafe-agent.mjs                              # 대화형(REPL, After 모드)
//
// 안전장치(가계부 analyst.mjs 패턴 재사용): SELECT/WITH 1문만, READ ONLY 트랜잭션, 8s 타임아웃.
// 자격증명은 .env(DATABASE_URL, OPENAI_API_KEY)에서만 읽는다.
// ========================================

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env'), quiet: true });

pg.types.setTypeParser(1082, (v) => v); // DATE → 'YYYY-MM-DD' 문자열 (타임존 밀림 방지)

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o').trim(); // mini는 교차분석이 얕아서 4o 기본 (환경변수로 교체 가능)
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

if (!DATABASE_URL) { console.error('❌ .env 에 DATABASE_URL 이 없습니다.'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('❌ .env 에 OPENAI_API_KEY 가 없습니다.'); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

// ----------------------------------------
// 🔒 read-only SQL 검증 + 실행 (analyst.mjs 검증된 패턴)
// ----------------------------------------
const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|comment|copy|merge|call|do|vacuum|reindex|refresh)\b/i;

function assertReadOnly(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
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
// AI Context ①: my_cafe.md — 파일을 "런타임에" 읽는다 (파일 수정 = 에이전트 인식 갱신)
// ----------------------------------------
function loadCafeContext() {
  return readFileSync(join(__dirname, 'my_cafe.md'), 'utf8');
}

// ----------------------------------------
// AI Context ②: 운영 DB 스키마 안내
// ----------------------------------------
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const yoil = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} (${yoil})`;
}

const SCHEMA_DOC = `
운영 DB 스키마 (PostgreSQL/Supabase — 오픈일 2026-06-07부터 어제까지의 실적):

테이블 cafe_daily_sales  -- 일별 매출/방문 (월요일 휴무 → 행 없음)
  date date UNIQUE / customers int(손님 수) / revenue bigint(총매출 원)
  weather text('맑음'|'흐림'|'비'|'폭염') / note text(오픈일·완판 등)

테이블 cafe_menu_sales  -- 메뉴별 일 판매량 (그날 판매 0인 메뉴는 행 없음)
  date date / menu text / category text('커피'|'시그니처'|'논커피'|'디저트')
  qty int / unit_price int / amount bigint(=qty*unit_price)
  ※ '무화과 바스크 치즈케이크'는 주말(토·일) 한정 20개 → 평일 행 없음
  ※ '소금빵'은 매일 30개 한정

테이블 cafe_reviews  -- 손님 리뷰
  date date / source text('네이버'|'인스타'|'방명록') / rating int(1~5)
  content text / sentiment text('긍정'|'중립'|'불만')

테이블 cafe_inventory  -- 재고/발주 스냅샷 (오늘 아침 기준)
  item text / unit text / stock numeric(현재 재고) / daily_usage numeric(일 사용량)
  reorder_point numeric(발주점) / lead_time_days int(입고 소요일)
  supplier text / last_ordered date / note text

분석 팁:
- 요일: extract(dow from date) → 0=일 1=월 … 6=토. 주말 = dow in (0,6). 월(1)은 휴무라 데이터 없음.
- 남은 재고 일수 = stock / daily_usage. "발주 필요" = stock <= reorder_point 또는 남은 일수 <= lead_time_days.
- 금액은 원(KRW) 정수. 답변할 땐 천단위 콤마.
- 추세를 볼 땐 주차별(date_trunc('week', date)) 비교가 유용.`;

// ----------------------------------------
// AI Context ③: 오늘의 운영 브리핑 — 고정 SQL 9개를 미리 돌려 통째로 주입
// (모델이 쿼리를 좁게 잡아 핵심 패턴을 놓치는 것을 구조적으로 방지.
//  데이터가 작아 전부 넣어도 토큰 부담 없음. run_sql 은 심화 조회용으로 유지)
// ----------------------------------------
const BRIEFING_QUERIES = [
  ['전체 요약', `select count(*) "영업일수", min(date) "첫영업일", max(date) "마지막영업일", round(avg(customers),1) "일평균손님", sum(revenue) "총매출" from cafe_daily_sales`],
  ['최근 7영업일 vs 이전 7영업일', `with r as (select date, customers, revenue, row_number() over (order by date desc) rn from cafe_daily_sales) select case when rn<=7 then '최근 7영업일' else '이전 7영업일' end "구간", round(avg(customers),1) "평균손님", sum(revenue) "매출" from r where rn<=14 group by 1 order by 1 desc`],
  ['요일별 평균 (월 휴무)', `select to_char(date,'Dy') "요일", extract(dow from date)::int "dow", round(avg(customers),1) "평균손님", round(avg(revenue))::bigint "평균매출" from cafe_daily_sales group by 1,2 order by 2`],
  ['오픈 주차별 추세', `select (floor((date - date '2026-06-07')/7)+1)::int "오픈주차", round(avg(customers),1) "평균손님", sum(revenue) "매출" from cafe_daily_sales group by 1 order by 1`],
  ['날씨별 평균 손님', `select weather "날씨", count(*) "일수", round(avg(customers),1) "평균손님" from cafe_daily_sales group by 1 order by 3 desc`],
  ['메뉴별 누적 판매 (매출순)', `select menu "메뉴", category "카테고리", sum(qty)::int "총수량", sum(amount)::bigint "총매출" from cafe_menu_sales group by 1,2 order by 4 desc`],
  ['완판·특이사항 있던 날', `select date, note from cafe_daily_sales where note is not null order by date`],
  ['손님 리뷰 전체', `select date, source "출처", rating "별점", sentiment "감정", content "내용" from cafe_reviews order by date`],
  ['재고 현황 (남은일수·발주필요 계산)', `select item "품목", unit "단위", stock "재고", daily_usage "일사용량", round(stock/nullif(daily_usage,0),1) "남은일수", reorder_point "발주점", lead_time_days "입고소요일", (stock<=reorder_point or stock/nullif(daily_usage,0)<=lead_time_days) "발주필요", supplier "거래처", note "비고" from cafe_inventory order by 8 desc, 5 asc`],
];

let briefingCache = null;
async function buildBriefing() {
  if (briefingCache) return briefingCache;
  const parts = [];
  for (const [title, sql] of BRIEFING_QUERIES) {
    const { rows } = await runSql(sql);
    parts.push(`### ${title}\n${JSON.stringify(rows, null, 0)}`);
  }
  briefingCache = parts.join('\n\n');
  return briefingCache;
}

// ----------------------------------------
// 시스템 프롬프트: After(풀 컨텍스트) vs Before(제로 컨텍스트)
// ----------------------------------------
async function systemFull() {
  return `너는 "카페 안도"의 전속 AI 운영 파트너야. 사장(인테리어 디자이너, 1인 운영)의 동업자처럼 답해.
오늘은 ${todayStr()}이야. 월요일은 정기 휴무일이고, 화요일부터 새로운 한 주 영업이 시작돼.

아래는 우리 카페의 정의서(my_cafe.md) 전문이야. 컨셉·타깃·메뉴판·경쟁 구도·손익·목표가 모두 담겨 있어.
=================== my_cafe.md 시작 ===================
${loadCafeContext()}
=================== my_cafe.md 끝 ===================
${SCHEMA_DOC}

아래는 방금 운영 DB에서 뽑은 "오늘의 운영 브리핑"(실데이터)이야. 검증된 숫자니 바로 근거로 인용해도 돼.
=================== 운영 브리핑 시작 ===================
${await buildBriefing()}
=================== 운영 브리핑 끝 ===================

규칙:
1. 위 브리핑을 근거의 기본으로 삼고, 더 깊은 디테일(특정 기간·메뉴·조합)이 필요할 때만 run_sql 로 read-only SELECT를 추가 실행해.
2. "아무 카페에나 통하는 답"(빙수·비건·타르트 나열, "계절 메뉴를 고려하세요" 류)은 실패작이야. 반드시 우리 데이터의 구체 패턴 — 1위 메뉴, 완판·품절 반복, 리뷰 속 손님의 직접 요청, 날씨·요일 효과 — 에서 출발하고, my_cafe.md의 컨셉(자재 쇼룸 카페·조용함·체류형)과 결이 맞는지 검증해.
3. 결론은 실행 가능한 수준까지 구체적으로: 신메뉴면 이름+가격대+근거, 프로모션이면 요일+내용+기대효과, 발주면 품목+우선순위+발주 시점(리드타임 역산).
4. 손익(월 -27만, BEP 일 20명)과 1인 운영이라는 현실을 감안해. 여러 근거(판매×리뷰×날씨×재고)가 서로 만나는 지점을 최우선으로.
5. 한국어로 간결하게: 핵심 결론 먼저, 숫자는 천단위 콤마, 전체 12문장 이내.
6. 데이터가 없으면 솔직히 없다고 말해.`;
}

const SYSTEM_BARE = `너는 카페 창업/운영 상담 AI야. 상대방의 카페에 대한 정보(이름·컨셉·메뉴·위치·데이터)는 전혀 주어지지 않았고, 조회할 수단도 없어.
일반적인 카페 운영 지식으로만 조언해. 한국어로 간결하게, 전체 10문장 이내로 답해.`;

const TOOLS = [{
  type: 'function',
  function: {
    name: 'run_sql',
    description: '카페 안도 운영 DB(Supabase)에 read-only SELECT 쿼리를 실행하고 결과 행을 반환한다. SELECT/WITH 만 가능.',
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string', description: '실행할 단일 PostgreSQL SELECT(또는 WITH) 쿼리' } },
      required: ['sql'],
    },
  },
}];

// ----------------------------------------
// OpenAI 호출
// ----------------------------------------
async function chat(messages, { withTools }) {
  const body = { model: MODEL, messages, temperature: 0.3 };
  if (withTools) body.tools = TOOLS;
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI API 오류 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices[0].message;
}

// ----------------------------------------
// 에이전트 루프 — mode: 'full'(my_cafe.md+DB) | 'bare'(컨텍스트 없음)
// 반환: { answer, sqlLog[] }
// ----------------------------------------
async function ask(question, mode = 'full', { verbose = true } = {}) {
  const full = mode === 'full';
  const messages = [
    { role: 'system', content: full ? await systemFull() : SYSTEM_BARE },
    { role: 'user', content: question },
  ];
  const sqlLog = [];

  for (let step = 0; step < 8; step++) {
    const msg = await chat(messages, { withTools: full });
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (calls.length === 0) return { answer: msg.content || '(빈 응답)', sqlLog };

    for (const call of calls) {
      let result;
      try {
        const { sql } = JSON.parse(call.function.arguments || '{}');
        const oneline = sql.replace(/\s+/g, ' ').trim();
        if (verbose) console.log(`  🔎 SQL: ${oneline}`);
        const out = await runSql(sql);
        if (verbose) console.log(`     → ${out.rowCount}행${out.truncated ? ' (일부만 전달)' : ''}`);
        sqlLog.push(oneline);
        result = JSON.stringify(out);
      } catch (e) {
        if (verbose) console.log(`     ⚠️  ${e.message}`);
        result = JSON.stringify({ error: e.message });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return { answer: '죄송해요, 답을 정리하지 못했어요. 질문을 조금 더 구체적으로 해주세요.', sqlLog };
}

// ----------------------------------------
// --compare: 같은 질문을 Before/After 로
// ----------------------------------------
async function compare(question, { verbose = true } = {}) {
  console.log(`\n${'═'.repeat(64)}\n🙋 질문: "${question}"\n${'═'.repeat(64)}`);

  console.log('\n❌ BEFORE — 컨텍스트 없는 일반 AI (my_cafe.md ✗ · DB ✗)\n');
  const before = await ask(question, 'bare', { verbose: false });
  console.log(before.answer);

  console.log(`\n${'─'.repeat(64)}\n✅ AFTER — 카페 안도 에이전트 (my_cafe.md ✓ + 운영 DB ✓)\n`);
  const after = await ask(question, 'full', { verbose });
  console.log(`\n${after.answer}`);

  return { question, before, after };
}

// ----------------------------------------
// --demo: 미션 Part 4 — 대표 질문 4개 Before/After → BEFORE_AFTER.md
// ----------------------------------------
const DEMO_QUESTIONS = [
  { role: '메뉴 기획자', q: '신메뉴 뭐 추가할까?' },
  { role: '마케터', q: '이번 주 프로모션, 무슨 요일에 뭘 하면 좋을까?' },
  { role: '재고 관리자', q: '오늘 발주 뭐부터 챙겨야 해?' },
  { role: '리뷰 분석가', q: '손님 리뷰 보면 뭘 제일 먼저 고쳐야 할까?' },
];

async function demo() {
  const results = [];
  for (const { role, q } of DEMO_QUESTIONS) {
    console.log(`\n\n🎬 [${role}] 시연 중…`);
    results.push({ role, ...(await compare(q)) });
  }

  const md = [];
  md.push('# 🅰️→🅱️ Before / After — "내 카페를 아는 AI 운영 파트너" 시연');
  md.push('');
  md.push('> **핵심 구조**: `[AI Context (my_cafe.md)]` + `[카페 운영 DB (Supabase cafe_*)]` → **[카페 안도 맞춤 에이전트]**');
  md.push('>');
  md.push(`> - ❌ **Before** = 컨텍스트 없는 일반 AI — my_cafe.md ✗ · DB ✗ (모델은 동일: ${MODEL})`);
  md.push('> - ✅ **After** = `cafe-agent.mjs` — ①my_cafe.md 전문 + ②고정 SQL 9개로 뽑은 "운영 브리핑"(요일별·주차별·날씨별·메뉴 랭킹·리뷰 전문·재고)을 시스템 프롬프트에 주입 + ③심화 조회용 read-only run_sql 도구');
  md.push(`> - 생성: \`node cafe-agent.mjs --demo\` · ${todayStr()} 실행 (월요일 휴무 → 이번 주 준비 시점)`);
  md.push('');
  for (const r of results) {
    md.push(`---`);
    md.push('');
    md.push(`## ${r.role} — "${r.question}"`);
    md.push('');
    md.push('### ❌ Before (컨텍스트 없음)');
    md.push('');
    md.push(r.before.answer.trim());
    md.push('');
    md.push('### ✅ After (my_cafe.md + 운영 DB)');
    md.push('');
    md.push(r.after.answer.trim());
    md.push('');
    if (r.after.sqlLog.length) {
      md.push(`<details><summary>에이전트가 실행한 SQL ${r.after.sqlLog.length}개</summary>`);
      md.push('');
      md.push('```sql');
      for (const s of r.after.sqlLog) md.push(`${s};`);
      md.push('```');
      md.push('</details>');
      md.push('');
    }
  }
  md.push('---');
  md.push('');
  md.push('**차이 요약**: Before는 어느 카페에나 통하는 일반론(= 아무 카페의 답도 아님).');
  md.push('After는 흑임자 크림라떼·무화과 바스크 같은 **우리 시그니처**, 요일별 실제 손님 수, 재고 리드타임,');
  md.push('리뷰 불만 키워드까지 **DB 숫자를 인용**하며 "카페 안도의 다음 한 수"를 제안한다.');
  md.push('');

  const outPath = join(__dirname, 'BEFORE_AFTER.md');
  writeFileSync(outPath, md.join('\n'), 'utf8');
  console.log(`\n\n📝 시연 기록 저장: ${outPath}`);
}

// ----------------------------------------
// 진입점
// ----------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i !== -1) argv.splice(i, 1);
    return i !== -1;
  };
  const isDemo = flag('--demo');
  const isCompare = flag('--compare');
  const isBare = flag('--bare');
  const question = argv.join(' ').trim();

  try {
    await pool.query('select 1'); // 연결 체크
  } catch (e) {
    console.error('❌ Supabase 연결 실패:', e.message);
    process.exit(1);
  }

  if (isDemo) { await demo(); await pool.end(); return; }
  if (isCompare && question) { await compare(question); await pool.end(); return; }
  if (question) {
    const { answer } = await ask(question, isBare ? 'bare' : 'full');
    console.log(`\n💬 ${answer}\n`);
    await pool.end();
    return;
  }

  // 대화형 모드 (After 모드)
  console.log('☕ 카페 안도 AI 운영 파트너 (종료: exit / quit / 빈 줄 두 번)');
  console.log('   예) 신메뉴 뭐 추가할까?  /  화요일 손님 왜 이렇게 없지?  /  발주 뭐부터?\n');
  const rl = readline.createInterface({ input, output });
  let emptyCount = 0;
  while (true) {
    const q = (await rl.question('🙋 ')).trim();
    if (['exit', 'quit', '종료'].includes(q.toLowerCase())) break;
    if (!q) { if (++emptyCount >= 2) break; continue; }
    emptyCount = 0;
    try {
      const { answer } = await ask(q, 'full');
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
