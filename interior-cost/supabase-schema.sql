-- ========================================
-- 인테리어 현장 비용관리 앱 — Supabase 스키마
-- AFM week-5 / quest (Server + DB)
--
-- 공유 Supabase 프로젝트(my-food 등과 동일 DB)라 prefix interior_ 로 충돌 방지.
-- server.js 의 initDB() 가 부팅 시 동일 DDL 을 CREATE TABLE IF NOT EXISTS 로 실행하므로
-- 이 파일은 수동 적용/문서화/검토용. (둘 중 하나만 실행해도 동일 결과)
-- ========================================

-- 현장 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interior_sites (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,          -- 현장명 (중복 불가)
  client      TEXT        NOT NULL DEFAULT '',      -- 발주처/고객
  address     TEXT        NOT NULL DEFAULT '',      -- 현장 주소
  manager     TEXT        NOT NULL DEFAULT '',      -- 현장 담당자
  budget      BIGINT      NOT NULL DEFAULT 0 CHECK (budget >= 0), -- 견적비(원)
  start_date  DATE,                                 -- 착공일
  end_date    DATE,                                 -- 준공(예정)일
  folder      TEXT        NOT NULL DEFAULT '',      -- 서버 생성 현장 폴더(상대경로)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 비용 내역 (현장 삭제 시 CASCADE 로 함께 삭제) -----------------------
CREATE TABLE IF NOT EXISTS interior_costs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id     BIGINT      NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE,
  date        DATE        NOT NULL,                 -- 지출일
  amount      BIGINT      NOT NULL CHECK (amount > 0), -- 금액(원)
  category    TEXT        NOT NULL,                 -- 비용 카테고리(자재비/인건비/...)
  process     TEXT        NOT NULL DEFAULT '',      -- 공정 카테고리(철거/설비/...)
  manager     TEXT        NOT NULL DEFAULT '',      -- 집행 담당자
  vendor      TEXT        NOT NULL DEFAULT '',      -- 거래처
  memo        TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 비용 목록 정렬(site_id, date DESC, created_at DESC) 가속 인덱스
CREATE INDEX IF NOT EXISTS idx_interior_costs_site_date
  ON interior_costs (site_id, date DESC, created_at DESC);
