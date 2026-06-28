// ========================================
// 🌱 seed.js — 냉장고 재료/레시피 시드 스크립트
//
// ingredients/*.json 과 recipes/*.md 를 "폴더에서 직접 읽어" Supabase 에 적재한다.
//   - 재료  : ingredients/*.json  → { name, quantity, category }
//   - 레시피: recipes/*.md         → { title, ingredients, steps }  (/recipe 스킬 포맷 파싱)
//
// 사용법:
//   node seed.js --dry     # DB 접속 없이 파싱 결과만 출력 (미리보기)
//   node seed.js           # .env 의 DATABASE_URL 로 접속 → 테이블 보장 + 적재
//
// 적재는 이름(재료)·제목(레시피) 기준 "중복 방지"라서 여러 번 실행해도 안전하다.
// ========================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');

const INGREDIENTS_DIR = path.join(__dirname, 'ingredients');
const RECIPES_DIR = path.join(__dirname, 'recipes');

// ----------------------------------------
// 텍스트 정리 헬퍼
// ----------------------------------------
// 줄 앞쪽의 이모지/마커(✅ 🛒 🍜 🍚 🍳 등) + 공백 제거
function stripLeadingEmoji(s) {
  return String(s).replace(
    /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍\s]+/u,
    ''
  );
}
// 마크다운 강조(**굵게**, *기울임*) 제거 + 공백 정리
function cleanInline(s) {
  return String(s).replace(/\*\*/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

// ----------------------------------------
// 재료 읽기: ingredients/*.json
// ----------------------------------------
function readIngredients() {
  if (!fs.existsSync(INGREDIENTS_DIR)) return [];
  return fs
    .readdirSync(INGREDIENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(INGREDIENTS_DIR, f), 'utf8'));
      return {
        name: String(raw.name || '').trim(),
        quantity: String(raw.quantity || '').trim(),
        category: String(raw.category || '냉장').trim(), // 보관 위치 (냉장/냉동/실온)
      };
    })
    .filter((i) => i.name);
}

// ----------------------------------------
// 레시피 읽기: recipes/*.md → { title, ingredients, steps }
//
// /recipe 스킬 생성 포맷 가정:
//   # <제목>            맨 위 H1 (앞 이모지 제거)
//   ## ...재료          아래 '- ' 항목들 (앞 ✅/🛒 마커 제거)
//   ## ...조리/순서     아래 '1. ' 번호 항목들 (번호 제거)
// ----------------------------------------
function parseRecipeMarkdown(md) {
  const lines = md.split('\n');
  let title = '';
  const ingredients = [];
  const steps = [];
  let section = null; // 'ing' | 'step' | null

  for (const line of lines) {
    const t = line.trim();
    if (!title && t.startsWith('# ') && !t.startsWith('## ')) {
      title = cleanInline(stripLeadingEmoji(t.replace(/^#\s+/, '')));
      continue;
    }
    if (t.startsWith('## ')) {
      const h = t.replace(/^##\s+/, '');
      if (/재료/.test(h)) section = 'ing';
      else if (/조리|순서|만드는|레시피/.test(h)) section = 'step';
      else section = null; // 팁/다른 선택지 등은 무시
      continue;
    }
    if (section === 'ing' && t.startsWith('- ')) {
      const item = cleanInline(stripLeadingEmoji(t.replace(/^-\s+/, '')));
      if (item) ingredients.push(item);
    } else if (section === 'step') {
      const m = t.match(/^\d+\.\s+(.*)$/);
      if (m && m[1].trim()) steps.push(cleanInline(m[1]));
    }
  }
  return { title, ingredients, steps };
}

function readRecipes() {
  if (!fs.existsSync(RECIPES_DIR)) return [];
  return fs
    .readdirSync(RECIPES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const parsed = parseRecipeMarkdown(fs.readFileSync(path.join(RECIPES_DIR, f), 'utf8'));
      return {
        title: parsed.title,
        ingredients: parsed.ingredients.join('\n'), // 와이어/DB 는 '\n' 구분 TEXT
        steps: parsed.steps.join('\n'),
        _file: f,
        _ing: parsed.ingredients.length,
        _step: parsed.steps.length,
      };
    })
    .filter((r) => r.title);
}

// ----------------------------------------
// 메인
// ----------------------------------------
async function main() {
  const ingredients = readIngredients();
  const recipes = readRecipes();

  // --- 파싱 결과 출력 (항상) ---
  console.log(`\n📦 재료 ${ingredients.length}개`);
  ingredients.forEach((i) =>
    console.log(`   - ${i.name}${i.quantity ? ' ' + i.quantity : ''}  [${i.category}]`)
  );

  console.log(`\n🍳 레시피 ${recipes.length}개`);
  recipes.forEach((r) => {
    console.log(`\n   # ${r.title}   (${r._file} · 재료 ${r._ing} · 단계 ${r._step})`);
    r.ingredients.split('\n').forEach((x) => console.log(`     - ${x}`));
    r.steps.split('\n').forEach((x, idx) => console.log(`     ${idx + 1}. ${x}`));
  });

  if (DRY) {
    console.log('\n(--dry 모드: DB 적재를 건너뜁니다. 실제 적재는 .env 설정 후 `node seed.js`)');
    return;
  }

  // --- DB 적재 ---
  const connectionString = (process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    console.error('\n❌ DATABASE_URL 이 없습니다. 먼저 .env 를 설정하세요: cp .env.example .env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 5 });

  try {
    // 테이블 보장 (server.js 와 동일 스키마). 단독 실행해도 동작하도록 여기서도 생성.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ingredients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        quantity TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '냉장',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(
      `ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS quantity TEXT NOT NULL DEFAULT '';`
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

    // 적재 — 이름/제목 기준 중복 방지(WHERE NOT EXISTS) → 재실행 안전
    let addedIng = 0;
    for (const i of ingredients) {
      const { rowCount } = await pool.query(
        `INSERT INTO ingredients (name, quantity, category)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM ingredients WHERE name = $1)`,
        [i.name, i.quantity, i.category]
      );
      addedIng += rowCount;
    }

    let addedRec = 0;
    for (const r of recipes) {
      const { rowCount } = await pool.query(
        `INSERT INTO recipes (title, ingredients, steps)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM recipes WHERE title = $1)`,
        [r.title, r.ingredients, r.steps]
      );
      addedRec += rowCount;
    }

    console.log(
      `\n✅ 적재 완료 — 재료 ${addedIng}개 / 레시피 ${addedRec}개 새로 추가 (이미 있으면 건너뜀).`
    );
    console.log('   이제 `npm start` 로 서버를 켜고 앱에서 확인하세요.');
  } catch (err) {
    console.error('\n❌ 적재 실패:', err.message);
    console.error('   .env 의 DATABASE_URL 과 네트워크(Supabase :6543)를 확인하세요.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
