-- ============================================================
-- ⚖️ 밸런스 게임 Supabase 셋업 (안전 재실행 가능 / 다른 앱 테이블과 무관)
-- 사용법: Supabase 대시보드 → SQL Editor → 아래 전체 붙여넣고 RUN
-- 몇 번을 실행해도 오류 없이 동작합니다.
-- ============================================================

-- 1) 테이블 (없을 때만 생성 → 기존 다른 앱 테이블에 영향 없음)
create table if not exists public.questions (
  id         bigint generated always as identity primary key,
  option_a   text not null,
  option_b   text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.votes (
  id          bigint generated always as identity primary key,
  question_id bigint not null references public.questions(id) on delete cascade,
  choice      text not null check (choice in ('A','B')),
  created_at  timestamptz not null default now()
);

create index if not exists votes_question_id_idx on public.votes(question_id);

-- 2) 집계 뷰 (투표율 계산 = "서버측 계산 API" 역할)
create or replace view public.vote_stats as
select
  q.id        as question_id,
  q.option_a,
  q.option_b,
  count(v.id) filter (where v.choice = 'A') as votes_a,
  count(v.id) filter (where v.choice = 'B') as votes_b,
  count(v.id)                               as total_votes
from public.questions q
left join public.votes v on v.question_id = q.id
group by q.id, q.option_a, q.option_b;

grant select on public.vote_stats to anon, authenticated;

-- 3) RLS + 정책 (재실행 안전: 먼저 drop 후 재생성 → 중복 에러 없음)
alter table public.questions enable row level security;
alter table public.votes    enable row level security;

drop policy if exists "questions read"   on public.questions;
drop policy if exists "questions insert" on public.questions;
drop policy if exists "votes read"       on public.votes;
drop policy if exists "votes insert"     on public.votes;

create policy "questions read"   on public.questions for select using (true);
create policy "questions insert" on public.questions for insert with check (true);
create policy "votes read"       on public.votes     for select using (true);
create policy "votes insert"     on public.votes     for insert with check (true);

-- 4) Realtime (이미 등록돼 있으면 건너뜀 → "already member" 중복 에러 없음)
do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='questions') then
    alter publication supabase_realtime add table public.questions;
  end if;
  if not exists (select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='votes') then
    alter publication supabase_realtime add table public.votes;
  end if;
end $$;

-- 5) 샘플 질문 (questions 가 비어 있을 때만 → 중복 삽입 방지)
insert into public.questions (option_a, option_b)
select t.a, t.b from (values
  ('월급 500 + 주7일 출근', '월급 300 + 주4일 출근'),
  ('월세 50만원 깔끔하게',  '전세 대출 이자 갚기'),
  ('매일 커피 사먹기',      '회사 탕비실 공짜 커피'),
  ('매달 적금 100만원',     '매달 여행 100만원'),
  ('지금 당장 현금 10억',   '평생 매달 500만원'),
  ('평생 점심값 무료',      '평생 교통비 무료')
) as t(a, b)
where not exists (select 1 from public.questions);

-- 6) PostgREST 스키마 캐시 리로드 (REST API 즉시 갱신 신호)
notify pgrst, 'reload schema';

-- 7) (선택) 잘못 만든 빈 테이블 정리하고 싶으면 아래 주석 해제
-- drop table if exists "balanced game";

-- 8) 확인용: 아래 결과에 질문 6행이 나오면 성공 ✅
select id, option_a, option_b from public.questions order by id;
