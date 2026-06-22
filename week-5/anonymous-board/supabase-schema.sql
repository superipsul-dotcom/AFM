-- ============================================================
-- 익명 고민·칭찬 게시판 — Supabase 테이블 + 권한(RLS) 설정
-- ------------------------------------------------------------
-- 사용법: Supabase 대시보드 → 왼쪽 메뉴 "SQL Editor" → "New query"
--         아래 내용을 통째로 붙여넣고 RUN(▶) 한 번이면 끝!
-- ============================================================

-- 1) posts 테이블 생성 (게시글 저장소)
create table if not exists posts (
  id          bigint generated always as identity primary key,  -- 글 고유 번호 (자동 증가)
  category    text        not null,                              -- 카테고리: '고민' | '칭찬' | '응원'
  content     text        not null,                              -- 글 내용
  likes       int         not null default 0,                    -- 공감 수 (공감 버튼 누를 때 +1)
  created_at  timestamptz not null default now()                 -- 작성 시각
);

-- 2) RLS(Row Level Security) 켜기
--    켜면 기본적으로 모든 접근이 차단되므로, 아래에서 허용 규칙을 명시합니다.
alter table posts enable row level security;

-- 3) 익명 데모용 권한 정책 (로그인 없이 읽기/쓰기/수정 허용)
--    ⚠️ 수업/실습용 설정입니다. 실제 서비스라면 더 엄격하게 제한하세요.
--    같은 이름의 정책이 이미 있으면 먼저 지웁니다 → 여러 번 RUN 해도 에러(42710)가 안 납니다.
--    (CREATE POLICY 는 IF NOT EXISTS 를 지원하지 않아서 이렇게 처리합니다.)
drop policy if exists "anyone can read"   on posts;
drop policy if exists "anyone can insert" on posts;
drop policy if exists "anyone can update" on posts;

create policy "anyone can read"   on posts for select using (true);                       -- 목록 조회
create policy "anyone can insert" on posts for insert with check (true);                  -- 글 작성
create policy "anyone can update" on posts for update using (true) with check (true);     -- 공감 +1 (UPDATE)

-- (선택) 잘 만들어졌는지 확인용 — 빈 결과가 나오면 정상입니다.
-- select * from posts order by created_at desc;
