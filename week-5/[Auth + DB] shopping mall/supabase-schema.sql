-- ============================================================
-- 디저트 쇼핑몰 "스윗박스" (week-5/shop) — Supabase PostgreSQL 스키마
-- ------------------------------------------------------------
-- 참고용 / 수동 적용용 SQL. server.js 의 initDB() 가 부팅 시 동일한 작업을
-- CREATE TABLE IF NOT EXISTS + ON CONFLICT 로 멱등하게 수행하므로,
-- 보통은 이 파일을 직접 실행할 필요가 없습니다(문서·재현용).
--
-- ⚠️ 같은 Supabase 프로젝트에 community/todos/my-food 앱 테이블이 이미 있습니다.
--    이 앱은 shop_ 접두사 테이블 3개만 사용하며 기존 테이블을 건드리지 않습니다.
-- ============================================================

-- gen_random_uuid() 사용을 위한 확장 (Supabase 에선 보통 이미 활성화됨)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) 회원
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,       -- 로그인 이메일
  password_hash TEXT NOT NULL,              -- bcrypt 해시 (절대 응답에 싣지 않음)
  nickname      TEXT NOT NULL,              -- 표시 이름 (1~20자)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 2) 상품 (name UNIQUE → 시드 멱등성)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_products (
  id          SERIAL PRIMARY KEY,           -- 정수 PK (프론트가 숫자 id 로 사용)
  name        TEXT UNIQUE NOT NULL,         -- 상품명 (UNIQUE)
  price       INTEGER NOT NULL,             -- 가격(원)
  image_url   TEXT,                         -- 상품 이미지 URL
  description TEXT,                         -- 상품 설명
  emoji       TEXT,                         -- UI 폴백 이모지
  gradient    TEXT                          -- UI 폴백 Tailwind 그라데이션 클래스
);

-- ------------------------------------------------------------
-- 3) 장바구니 (회원·상품 삭제 시 함께 삭제, 같은 상품은 한 행으로 묶어 수량 관리)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shop_cart (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product_id)              -- 같은 상품 재담기 → 수량 증가(upsert)용
);

-- 본인 장바구니 조회 가속
CREATE INDEX IF NOT EXISTS idx_shop_cart_user ON shop_cart(user_id);

-- ------------------------------------------------------------
-- 4) 상품 12개 시드 (멱등: ON CONFLICT (name) DO NOTHING)
--    컬럼 순서: name, price, description, emoji, gradient, image_url
-- ------------------------------------------------------------
INSERT INTO shop_products (name, price, description, emoji, gradient, image_url) VALUES
  ('딸기 생크림 케이크',   28000, '촉촉한 시트에 신선한 국산 딸기와 부드러운 생크림을 듬뿍 올렸어요.', '🍰', 'from-strawberry-100 to-rose-200',    'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&auto=format&fit=crop&q=70'),
  ('가나슈 초콜릿 케이크', 32000, '진한 벨기에 다크 초콜릿 가나슈로 감싼 리치한 케이크.',               '🎂', 'from-amber-100 to-orange-200',       'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600&auto=format&fit=crop&q=70'),
  ('프렌치 마카롱 6구',   15000, '파리지앵 감성 그대로, 6가지 맛이 한 상자에.',                       '🌈', 'from-pink-100 to-fuchsia-200',       'https://images.unsplash.com/photo-1569864358642-9d1684040f43?w=600&auto=format&fit=crop&q=70'),
  ('버터 쿠키 박스',      12000, '고소한 발효버터로 구운 바삭한 수제 쿠키 한 박스.',                 '🍪', 'from-amber-100 to-yellow-200',       'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=600&auto=format&fit=crop&q=70'),
  ('클래식 크루아상',     4500,  '27겹 결결이 살아있는 프랑스산 버터 크루아상.',                     '🥐', 'from-yellow-100 to-amber-200',       'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600&auto=format&fit=crop&q=70'),
  ('포르투갈 에그타르트', 3800,  '바삭한 페이스트리에 부드러운 커스터드가 가득.',                   '🥧', 'from-orange-100 to-amber-200',       'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=600&auto=format&fit=crop&q=70'),
  ('퍼지 브라우니',       6500,  '쫀득하고 진한 초콜릿 브라우니, 커피와 환상 궁합.',                 '🍫', 'from-amber-200 to-orange-300',       'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=600&auto=format&fit=crop&q=70'),
  ('레드벨벳 컵케이크',   5500,  '벨벳처럼 부드러운 시트에 크림치즈 프로스팅.',                     '🧁', 'from-rose-100 to-red-200',           'https://images.unsplash.com/photo-1614707267537-b85aaf00c4b7?w=600&auto=format&fit=crop&q=70'),
  ('글레이즈드 도넛',     3500,  '겉은 달콤 바삭, 속은 폭신한 클래식 도넛.',                         '🍩', 'from-pink-100 to-rose-200',          'https://images.unsplash.com/photo-1551024601-bec78aea704b?w=600&auto=format&fit=crop&q=70'),
  ('핸드드립 카페라떼',   5000,  '스페셜티 원두로 내린 부드러운 라떼 한 잔.',                       '☕', 'from-amber-100 to-stone-200',        'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=600&auto=format&fit=crop&q=70'),
  ('딸기 밀크쉐이크',     6000,  '생딸기를 듬뿍 갈아 만든 진한 핑크빛 쉐이크.',                     '🥤', 'from-strawberry-100 to-pink-200',    'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=600&auto=format&fit=crop&q=70'),
  ('클래식 티라미수',     8500,  '마스카르포네와 에스프레소가 어우러진 이탈리안 디저트.',           '🍮', 'from-amber-100 to-yellow-200',       'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=600&auto=format&fit=crop&q=70')
ON CONFLICT (name) DO NOTHING;
