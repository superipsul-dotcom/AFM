-- ========================================
-- 🧊 우리집 냉장고 — 시드 데이터
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 RUN 하세요.
-- 멱등성: 같은 이름(재료)/제목(레시피)이 이미 있으면 건너뜁니다. 여러 번 실행해도 안전.
-- expiry 는 'YYYY-MM-DD' TEXT (오늘 기준 상대 날짜로 생성). 라면은 유통기한 없음('').
-- ========================================

-- 서버가 부팅 때 자동으로 만들지만, SQL 만 단독 실행해도 되도록 테이블을 먼저 보장.
CREATE TABLE IF NOT EXISTS ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '냉장',
  expiry TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  ingredients TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 재료 7종 (보관위치별)
INSERT INTO ingredients (name, quantity, category, expiry)
SELECT v.name, v.quantity, v.category, v.expiry
FROM (VALUES
  ('계란', '6개',   '냉장', to_char(CURRENT_DATE + 9,  'YYYY-MM-DD')),
  ('우유', '1팩',   '냉장', to_char(CURRENT_DATE + 2,  'YYYY-MM-DD')),
  ('대파', '2대',   '냉장', to_char(CURRENT_DATE - 1,  'YYYY-MM-DD')),
  ('만두', '1봉',   '냉동', to_char(CURRENT_DATE + 60, 'YYYY-MM-DD')),
  ('라면', '3개',   '실온', ''),
  ('김치', '500g',  '냉장', to_char(CURRENT_DATE + 14, 'YYYY-MM-DD')),
  ('밥',   '2공기', '냉장', to_char(CURRENT_DATE + 1,  'YYYY-MM-DD'))
) AS v(name, quantity, category, expiry)
WHERE NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.name = v.name);

-- 레시피 3종 (ingredients/steps 는 줄바꿈 구분 TEXT)
INSERT INTO recipes (title, ingredients, steps)
SELECT v.title, v.ingredients, v.steps
FROM (VALUES
  (
    '계란말이',
    E'계란 3개\n대파 약간\n소금 약간\n식용유 1스푼',
    E'계란을 풀고 잘게 썬 대파와 소금을 넣어 잘 섞는다.\n팬에 식용유를 두르고 약불로 달군다.\n계란물을 얇게 부어 가장자리가 익으면 돌돌 말아준다.\n여러 번 반복해 도톰하게 말고 한 김 식힌 뒤 썰어낸다.'
  ),
  (
    '얼큰 라면',
    E'라면 1개\n계란 1개\n대파 약간\n물 550ml',
    E'냄비에 물 550ml를 넣고 끓인다.\n물이 끓으면 면과 스프, 건더기를 넣는다.\n면이 절반쯤 익으면 계란을 풀어 넣고 대파를 올린다.\n1~2분 더 끓여 기호에 맞게 완성한다.'
  ),
  (
    '김치볶음밥',
    E'밥 1공기\n김치 1컵\n대파 약간\n계란 1개\n식용유 1스푼',
    E'김치를 잘게 썰어 식용유 두른 팬에 볶는다.\n김치가 익으면 밥을 넣고 골고루 볶는다.\n간을 맞추고 접시에 담는다.\n계란 후라이를 올려 마무리한다.'
  )
) AS v(title, ingredients, steps)
WHERE NOT EXISTS (SELECT 1 FROM recipes r WHERE r.title = v.title);
