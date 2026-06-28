// ========================================
// 🌱 시드 스크립트 — DB 에 샘플 재료/레시피를 넣는다.
//   node seed.js        → 실제 삽입 (이미 있으면 건너뜀 / 멱등)
//   node seed.js --dry  → 미리보기만 (DB 변경 없음)
//
// supabase-seed.sql 과 동일한 데이터를 코드로 넣는 버전.
// .env 의 DATABASE_URL 을 사용한다.
// ========================================

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const DRY = process.argv.includes('--dry');

// 오늘 기준 n일 뒤(또는 앞) 날짜 'YYYY-MM-DD'
const offset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const INGREDIENTS = [
  { name: '계란', quantity: '6개',   category: '냉장', expiry: offset(9) },
  { name: '우유', quantity: '1팩',   category: '냉장', expiry: offset(2) },
  { name: '대파', quantity: '2대',   category: '냉장', expiry: offset(-1) },
  { name: '만두', quantity: '1봉',   category: '냉동', expiry: offset(60) },
  { name: '라면', quantity: '3개',   category: '실온', expiry: '' },
  { name: '김치', quantity: '500g',  category: '냉장', expiry: offset(14) },
  { name: '밥',   quantity: '2공기', category: '냉장', expiry: offset(1) },
];

const RECIPES = [
  {
    title: '계란말이',
    ingredients: ['계란 3개', '대파 약간', '소금 약간', '식용유 1스푼'].join('\n'),
    steps: [
      '계란을 풀고 잘게 썬 대파와 소금을 넣어 잘 섞는다.',
      '팬에 식용유를 두르고 약불로 달군다.',
      '계란물을 얇게 부어 가장자리가 익으면 돌돌 말아준다.',
      '여러 번 반복해 도톰하게 말고 한 김 식힌 뒤 썰어낸다.',
    ].join('\n'),
  },
  {
    title: '얼큰 라면',
    ingredients: ['라면 1개', '계란 1개', '대파 약간', '물 550ml'].join('\n'),
    steps: [
      '냄비에 물 550ml를 넣고 끓인다.',
      '물이 끓으면 면과 스프, 건더기를 넣는다.',
      '면이 절반쯤 익으면 계란을 풀어 넣고 대파를 올린다.',
      '1~2분 더 끓여 기호에 맞게 완성한다.',
    ].join('\n'),
  },
  {
    title: '김치볶음밥',
    ingredients: ['밥 1공기', '김치 1컵', '대파 약간', '계란 1개', '식용유 1스푼'].join('\n'),
    steps: [
      '김치를 잘게 썰어 식용유 두른 팬에 볶는다.',
      '김치가 익으면 밥을 넣고 골고루 볶는다.',
      '간을 맞추고 접시에 담는다.',
      '계란 후라이를 올려 마무리한다.',
    ].join('\n'),
  },
];

async function ensureTables() {
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      ingredients TEXT NOT NULL DEFAULT '',
      steps TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function main() {
  if (!(process.env.DATABASE_URL || '').trim()) {
    console.error('❌ .env 의 DATABASE_URL 이 비어 있습니다. cp .env.example .env 후 값을 채워주세요.');
    process.exit(1);
  }

  console.log(DRY ? '🔎 DRY RUN — DB 를 바꾸지 않고 미리보기만 합니다.\n' : '🌱 시드를 시작합니다...\n');

  if (DRY) {
    console.log(`재료 ${INGREDIENTS.length}종:`);
    INGREDIENTS.forEach((i) => console.log(`  - ${i.name} ${i.quantity} (${i.category}) ${i.expiry || '유통기한 없음'}`));
    console.log(`\n레시피 ${RECIPES.length}종:`);
    RECIPES.forEach((r) => console.log(`  - ${r.title} (재료 ${r.ingredients.split('\n').length} · 단계 ${r.steps.split('\n').length})`));
    await pool.end();
    return;
  }

  await ensureTables();

  let addedIng = 0;
  for (const ing of INGREDIENTS) {
    const { rowCount } = await pool.query(
      `INSERT INTO ingredients (name, quantity, category, expiry)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM ingredients WHERE name = $1)`,
      [ing.name, ing.quantity, ing.category, ing.expiry]
    );
    if (rowCount > 0) { addedIng++; console.log(`  + 재료: ${ing.name}`); }
    else console.log(`  · 건너뜀(이미 있음): ${ing.name}`);
  }

  let addedRec = 0;
  for (const rec of RECIPES) {
    const { rowCount } = await pool.query(
      `INSERT INTO recipes (title, ingredients, steps)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM recipes WHERE title = $1)`,
      [rec.title, rec.ingredients, rec.steps]
    );
    if (rowCount > 0) { addedRec++; console.log(`  + 레시피: ${rec.title}`); }
    else console.log(`  · 건너뜀(이미 있음): ${rec.title}`);
  }

  console.log(`\n✅ 완료 — 재료 ${addedIng}개 / 레시피 ${addedRec}개 새로 추가.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('❌ 시드 실패:', err.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
