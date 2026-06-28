-- ============================================================
-- 익명 월급·지출 비교소 — Supabase 테이블 + 통계 함수 설정
-- ------------------------------------------------------------
-- 사용법: Supabase 대시보드 → 왼쪽 메뉴 "SQL Editor" → "New query"
--         아래 내용을 통째로 붙여넣고 RUN(▶) 한 번이면 끝!
--         (여러 번 실행해도 안전하도록 만들어 두었습니다.)
--
-- 이 앱의 핵심: "혼자의 월급은 숫자일 뿐이지만, 여러 명이 모이면 통계가 된다"
--   - DB 역할     : 익명 월급/지출 데이터 저장소 (submissions 테이블)
--   - Server 역할 : 통계/비교 API (아래 4개 함수 = AVG · COUNT · GROUP BY 의 힘!)
--
--   금액 단위는 모두 "만원" 입니다. (예: 300 = 300만원)
-- ============================================================


-- 1) submissions 테이블 생성 (익명 제출 데이터 저장소) -------------------
create table if not exists submissions (
  id                   bigint generated always as identity primary key, -- 제출 고유 번호 (자동 증가)
  job_category         text        not null,                            -- 직군 (개발 / 디자인 / 마케팅 ...)
  experience_years     int         not null default 0,                  -- 연차 (년)
  monthly_salary       int         not null,                            -- 월급 (만원)
  expense_food         int         not null default 0,                  -- 월 지출: 식비 (만원)
  expense_housing      int         not null default 0,                  -- 월 지출: 주거 (만원)
  expense_transport    int         not null default 0,                  -- 월 지출: 교통 (만원)
  expense_subscription int         not null default 0,                  -- 월 지출: 구독료 (만원)
  expense_other        int         not null default 0,                  -- 월 지출: 기타 (만원)
  created_at           timestamptz not null default now(),              -- 제출 시각

  -- 말도 안 되는 값이 들어와 통계가 깨지지 않도록 최소한의 안전장치
  constraint chk_exp   check (experience_years     between 0 and 60),
  constraint chk_sal   check (monthly_salary       between 0 and 100000),
  constraint chk_food  check (expense_food         between 0 and 100000),
  constraint chk_house check (expense_housing      between 0 and 100000),
  constraint chk_tran  check (expense_transport    between 0 and 100000),
  constraint chk_subs  check (expense_subscription between 0 and 100000),
  constraint chk_etc   check (expense_other        between 0 and 100000)
);


-- 2) RLS(Row Level Security) + 익명 읽기/쓰기 허용 (수업용) ----------------
--    ⚠️ 누구나 익명으로 읽고 쓸 수 있는 실습용 설정입니다.
--       실제 서비스라면 인증/검증을 더 엄격하게 두세요.
alter table submissions enable row level security;

drop policy if exists "anyone can read"   on submissions;
drop policy if exists "anyone can insert" on submissions;

create policy "anyone can read"   on submissions for select using (true);        -- 통계 조회
create policy "anyone can insert" on submissions for insert with check (true);   -- 데이터 등록


-- ============================================================
-- 3) 통계 함수들 (Server 역할) — 앱은 supabase.rpc('함수이름') 으로 호출
-- ============================================================

-- 3-1) 전체 평균 통계 (AVG · COUNT) — 한 번에 JSON 으로 반환
create or replace function get_overall_stats()
returns json
language sql
stable
as $$
  select json_build_object(
    'count',             count(*),
    'avg_salary',        round(avg(monthly_salary)),
    'avg_expense_total', round(avg(expense_food + expense_housing + expense_transport + expense_subscription + expense_other)),
    'avg_food',          round(avg(expense_food)),
    'avg_housing',       round(avg(expense_housing)),
    'avg_transport',     round(avg(expense_transport)),
    'avg_subscription',  round(avg(expense_subscription)),
    'avg_other',         round(avg(expense_other))
  )
  from submissions;
$$;

-- 3-2) 직군별 평균 (GROUP BY) — 직군마다 인원 / 평균월급 / 평균지출
create or replace function get_job_category_stats()
returns table(job_category text, cnt bigint, avg_salary numeric, avg_expense numeric)
language sql
stable
as $$
  select
    job_category,
    count(*)                   as cnt,
    round(avg(monthly_salary)) as avg_salary,
    round(avg(expense_food + expense_housing + expense_transport + expense_subscription + expense_other)) as avg_expense
  from submissions
  group by job_category
  order by round(avg(monthly_salary)) desc;
$$;

-- 3-3) 내 위치 = 상위 몇 %? (COUNT + FILTER)
--      내 월급(p_salary) 이상을 받는 사람 비율 = 상위 X%
create or replace function get_salary_percentile(p_salary int)
returns json
language sql
stable
as $$
  select json_build_object(
    'total',       count(*),
    'below',       count(*) filter (where monthly_salary <  p_salary),
    'at_or_above', count(*) filter (where monthly_salary >= p_salary),
    'top_percent', case when count(*) = 0 then null
                        else round(100.0 * count(*) filter (where monthly_salary >= p_salary) / count(*), 1)
                   end
  )
  from submissions;
$$;

-- 3-4) 월급 분포 (구간별 COUNT) — 히스토그램(막대그래프)용
create or replace function get_salary_distribution()
returns table(bucket text, sort_order int, cnt bigint)
language sql
stable
as $$
  with labeled as (
    select case
      when monthly_salary < 200  then 1
      when monthly_salary < 300  then 2
      when monthly_salary < 400  then 3
      when monthly_salary < 500  then 4
      when monthly_salary < 700  then 5
      when monthly_salary < 1000 then 6
      else 7
    end as sort_order
    from submissions
  )
  select
    case sort_order
      when 1 then '200 미만'
      when 2 then '200~299'
      when 3 then '300~399'
      when 4 then '400~499'
      when 5 then '500~699'
      when 6 then '700~999'
      else        '1000+'
    end as bucket,
    sort_order,
    count(*) as cnt
  from labeled
  group by sort_order
  order by sort_order;
$$;


-- 4) 함수 실행 권한 (익명 사용자도 통계를 볼 수 있도록) --------------------
grant execute on function get_overall_stats()        to anon, authenticated;
grant execute on function get_job_category_stats()   to anon, authenticated;
grant execute on function get_salary_percentile(int) to anon, authenticated;
grant execute on function get_salary_distribution()  to anon, authenticated;


-- (선택) 잘 만들어졌는지 확인 — count 가 0 으로 나오면 정상입니다.
-- select get_overall_stats();
