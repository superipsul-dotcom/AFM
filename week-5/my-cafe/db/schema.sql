-- ========================================
-- ☕ 카페 안도 운영 DB 스키마
-- my-food/todos/가계부와 "같은 Supabase 프로젝트"를 재사용하므로
-- cafe_ 접두사로 테이블을 격리한다. (shared-table-name gotcha 방지)
-- 시드가 곧 원본 데이터이므로 drop 후 재생성 (재실행 안전)
-- ========================================

drop table if exists cafe_menu_sales;
drop table if exists cafe_daily_sales;
drop table if exists cafe_reviews;
drop table if exists cafe_inventory;

-- 일별 매출/방문 (월요일 휴무 → 해당 날짜 행 없음)
create table cafe_daily_sales (
  id        bigserial primary key,
  date      date unique not null,
  customers int    not null,          -- 방문 손님 수
  revenue   bigint not null,          -- 총 매출(원) = 그날 cafe_menu_sales.amount 합계
  weather   text   not null,          -- 맑음 | 흐림 | 비 | 폭염
  note      text                      -- 오픈일, 완판 등 특이사항
);

-- 메뉴별 일 판매량 (판매 0인 메뉴는 행 없음 — 무화과 바스크는 주말 한정)
create table cafe_menu_sales (
  id         bigserial primary key,
  date       date   not null,
  menu       text   not null,
  category   text   not null,         -- 커피 | 시그니처 | 논커피 | 디저트
  qty        int    not null,
  unit_price int    not null,         -- 판매 단가(원)
  amount     bigint not null,         -- qty * unit_price
  unique (date, menu)
);

-- 손님 리뷰 (네이버플레이스 / 인스타 / 방명록)
create table cafe_reviews (
  id        bigserial primary key,
  date      date not null,
  source    text not null,            -- 네이버 | 인스타 | 방명록
  rating    int  not null check (rating between 1 and 5),
  content   text not null,
  sentiment text not null             -- 긍정 | 중립 | 불만
);

-- 재고/발주 현황 (오늘 아침 기준 스냅샷)
create table cafe_inventory (
  id             bigserial primary key,
  item           text unique not null,
  unit           text not null,
  stock          numeric not null,    -- 현재 재고
  daily_usage    numeric not null,    -- 일 평균 사용량 (최근 7일 기준)
  reorder_point  numeric not null,    -- 발주점 (이 밑으로 내려가면 발주)
  lead_time_days int     not null,    -- 발주 → 입고 소요일
  supplier       text    not null,
  last_ordered   date,
  note           text
);
