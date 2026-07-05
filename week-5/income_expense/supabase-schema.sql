-- ========================================
-- 💰 나만의 가계부 — 스키마 + (선택) 시드 데이터
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 RUN 하세요.
-- (서버가 부팅 때 테이블을 자동 생성하므로 이 파일 실행은 선택사항입니다.)
--
-- 테이블: transactions  (수입/지출 거래 내역)
--   amount 는 원 단위 정수(BIGINT), date 는 DATE.
-- 멱등성: 시드는 테이블이 비어있을 때만 들어갑니다. 여러 번 실행해도 안전.
-- ========================================

CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount BIGINT NOT NULL CHECK (amount > 0),   -- 원 단위 정수
  category TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  date DATE NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','company')),  -- 개인/회사 사용 분류
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 마이그레이션: 예전 버전으로 만들어진 테이블에 scope 컬럼 추가 (기존 행은 'personal')
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'personal';

-- 목록 정렬(date DESC, created_at DESC) 가속용 인덱스
CREATE INDEX IF NOT EXISTS idx_transactions_date
  ON transactions (date DESC, created_at DESC);

-- ----------------------------------------
-- 테이블: budgets  (지출 카테고리별 월 예산 한도)
--   category 는 UNIQUE → 1카테고리 = 1예산 (서버는 ON CONFLICT 로 upsert).
--   amount 는 원 단위 정수(BIGINT), 0보다 커야 함.
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category TEXT NOT NULL UNIQUE,
  amount BIGINT NOT NULL CHECK (amount > 0),    -- 월 예산 한도(원)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------
-- (선택) 시드 데이터 — 테이블이 비어 있을 때만 삽입
-- 오늘(CURRENT_DATE) 기준 날짜로 생성.
-- ----------------------------------------
INSERT INTO transactions (type, amount, category, memo, date, scope)
SELECT v.type, v.amount, v.category, v.memo, v.date, v.scope
FROM (VALUES
  ('income'::text,  3200000::bigint, '급여'::text,   '6월 월급'::text,      CURRENT_DATE, 'personal'::text),
  ('expense',       12000,           '식비',         '점심 김치찌개',        CURRENT_DATE, 'personal'),
  ('expense',       9900,            '구독료',       '넷플릭스',            CURRENT_DATE, 'personal'),
  ('expense',       55000,           '교통',         '외근 교통카드 충전',    CURRENT_DATE, 'company')
) AS v(type, amount, category, memo, date, scope)
WHERE NOT EXISTS (SELECT 1 FROM transactions);
