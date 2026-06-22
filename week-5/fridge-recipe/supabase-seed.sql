-- ============================================================
-- 🧊 냉장고 재료 & 레시피 — Supabase 시드 SQL
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 RUN 하면
-- 테이블이 생성되고 내 재료 5개 + 레시피 3개가 들어갑니다.
--
-- ingredients/*.json 과 recipes/*.md 를 분석해 만든 시드입니다.
-- 이름(재료)·제목(레시피) 기준 중복 방지라 여러 번 실행해도 안전합니다.
-- (server.js 와 동일 스키마: 서버를 켜도 같은 테이블을 사용)
-- ============================================================

-- ---------- 테이블 ----------
CREATE TABLE IF NOT EXISTS ingredients (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  quantity   TEXT NOT NULL DEFAULT '',      -- 수량 (예: '6개', '1/2포기')
  category   TEXT NOT NULL DEFAULT '냉장',   -- 보관 위치 (냉장/냉동/실온)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 예전(수량 컬럼 없던) 테이블도 자동 보강
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS quantity TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS recipes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  ingredients TEXT NOT NULL DEFAULT '',   -- '\n' 구분 문자열
  steps       TEXT NOT NULL DEFAULT '',   -- '\n' 구분 문자열
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- 재료 5개 (ingredients/*.json) ----------
INSERT INTO ingredients (name, quantity, category)
SELECT v.name, v.quantity, v.category
FROM (VALUES
  ('계란', '6개',     '냉장'),
  ('대파', '2대',     '냉장'),
  ('김치', '1/2포기', '냉장'),
  ('라면', '3개',     '실온'),
  ('밥',   '2공기',   '냉장')
) AS v(name, quantity, category)
WHERE NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.name = v.name);

-- ---------- 레시피 3개 (recipes/*.md) ----------
-- 1) 얼큰 김치 계란 라면
INSERT INTO recipes (title, ingredients, steps)
SELECT '얼큰 김치 계란 라면',
$ing$라면 2개 (냉장고에 3개 보유 · 실온)
김치 1컵 (1/2포기 중 일부, 송송 썰어 · 냉장)
계란 2개 (6개 보유 · 냉장)
대파 1대 (2대 보유 · 냉장)
물 1,100ml (라면 2개 기준 — 필수)
고춧가루 1작은술 (선택 — 더 얼큰하게)$ing$,
$step$냄비에 물 1,100ml를 붓고, 송송 썬 김치와 대파 흰 부분을 먼저 넣어 끓인다. (김치를 먼저 끓이면 국물이 깊어진다)
물이 끓으면 분말스프·건더기스프를 넣는다. (얼큰하게 원하면 고춧가루 1작은술 추가)
면을 넣고 약 4분간 끓인다.
면이 거의 익으면 계란을 풀어 넣는다 — 젓지 않고 30초 두면 몽글몽글, 바로 저으면 국물이 걸쭉해진다.
대파 녹색 부분을 올리고 불을 끈 뒤 그릇에 담아 완성.$step$
WHERE NOT EXISTS (SELECT 1 FROM recipes WHERE title = '얼큰 김치 계란 라면');

-- 2) 자취생 김치 계란 덮밥
INSERT INTO recipes (title, ingredients, steps)
SELECT '자취생 김치 계란 덮밥',
$ing$밥 1공기 (2공기 보유)
계란 1개 (6개 보유)
김치 1/3컵 (송송 썰어 · 1/2포기 보유)
대파 약간 (1/4대 · 2대 보유)
식용유·간장·참기름 약간 (기본 양념 — 필수)
김가루 (선택)$ing$,
$step$밥 1공기를 그릇에 담아 둔다. (찬밥이면 전자레인지 1분)
팬에 기름을 두르고 송송 썬 김치를 1~2분 살짝 볶아 밥 위에 올린다.
같은 팬에 계란을 깨 넣어 반숙 프라이를 부친다.
계란을 밥 위에 올리고, 간장 1작은술 + 참기름 몇 방울을 두른다.
대파(와 김가루)를 뿌려 완성. 노른자를 터뜨려 비벼 먹는다.$step$
WHERE NOT EXISTS (SELECT 1 FROM recipes WHERE title = '자취생 김치 계란 덮밥');

-- 3) 김치볶음밥
INSERT INTO recipes (title, ingredients, steps)
SELECT '김치볶음밥',
$ing$밥 2공기
김치 1/2포기 (송송 썰어 약 1.5컵)
계란 2개 (프라이용 · 냉장고에 6개 보유)
대파 1대 (2대 보유)
식용유·간장·참기름·설탕 약간 (기본 양념 — 필수)
김가루·통깨 (선택)$ing$,
$step$김치는 한입 크기로 송송 썰고, 대파는 잘게 썬다.
달군 팬에 식용유를 두르고 대파를 넣어 파기름을 낸다.
썬 김치를 넣고 2~3분 볶아 신맛을 날린 뒤, 설탕을 약간 넣어 간을 잡는다.
밥을 넣고 김치와 고루 섞으며 볶는다. 간장 1큰술을 팬 가장자리에 둘러 불맛을 더한다.
불을 끄고 참기름을 둘러 마무리한 뒤 그릇에 담는다.
계란을 반숙 프라이로 부쳐 위에 올린다. (기호에 따라 김가루·통깨)$step$
WHERE NOT EXISTS (SELECT 1 FROM recipes WHERE title = '김치볶음밥');

-- ---------- 확인 ----------
-- SELECT name, quantity, category FROM ingredients ORDER BY created_at;
-- SELECT title FROM recipes ORDER BY created_at;
