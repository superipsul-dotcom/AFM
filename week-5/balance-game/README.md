# ⚖️ 실시간 밸런스 게임 (Server + DB: Supabase)

둘 중 하나만 고른다면? 질문을 등록하고 투표하면 **실시간으로 투표율 바가 변하는** 밸런스 게임 앱입니다.
링크 하나만 공유하면 여러 사람이 **동시에** 투표할 수 있어요. (수업 데모용)

- **단일 파일**: `index.html` (CDN React 18 + Tailwind + Supabase JS v2)
- **Server + DB**: Supabase 가 담당 — PostgREST 자동 API + Postgres 집계 뷰 + Realtime 구독
- 별도 Node 서버 불필요

```
[질문 등록 A vs B] → [투표(A/B)] → Supabase DB 저장 → vote_stats 뷰로 집계 → Realtime 으로 모든 화면 실시간 갱신
```

---

## 1) Supabase 프로젝트 만들기
1. https://supabase.com → 로그인 → **New project** 생성 (Region 은 가까운 곳, 예: Northeast Asia)
2. 프로젝트가 준비되면 좌측 메뉴 **SQL Editor** 열기

## 2) 테이블 / 뷰 / RLS / Realtime / 샘플데이터 한 번에 생성
`index.html` **맨 위 주석에 있는 SQL 전체**를 복사해서 SQL Editor 에 붙여넣고 **RUN**.
(아래와 동일한 내용이며, 한 번 실행하면 `questions`, `votes` 테이블 + `vote_stats` 집계 뷰 + RLS 정책 + Realtime + 샘플 질문 6개가 만들어집니다.)

```sql
-- 1) 테이블
create table if not exists public.questions (
  id bigint generated always as identity primary key,
  option_a text not null,
  option_b text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.votes (
  id bigint generated always as identity primary key,
  question_id bigint not null references public.questions(id) on delete cascade,
  choice text not null check (choice in ('A','B')),
  created_at timestamptz not null default now()
);
create index if not exists votes_question_id_idx on public.votes(question_id);

-- 2) 서버측 집계 뷰 (투표율 계산 API 역할)
create or replace view public.vote_stats as
select
  q.id as question_id,
  q.option_a,
  q.option_b,
  count(v.id) filter (where v.choice = 'A') as votes_a,
  count(v.id) filter (where v.choice = 'B') as votes_b,
  count(v.id) as total_votes
from public.questions q
left join public.votes v on v.question_id = q.id
group by q.id, q.option_a, q.option_b;

-- 3) RLS (수업/데모용: 익명 읽기+쓰기 허용)
alter table public.questions enable row level security;
alter table public.votes enable row level security;
create policy "questions read"   on public.questions for select using (true);
create policy "questions insert" on public.questions for insert with check (true);
create policy "votes read"   on public.votes for select using (true);
create policy "votes insert" on public.votes for insert with check (true);
grant select on public.vote_stats to anon, authenticated;

-- 4) Realtime 활성화
alter publication supabase_realtime add table public.votes;
alter publication supabase_realtime add table public.questions;

-- 5) (선택) 샘플 질문 (돈 주제)
insert into public.questions (option_a, option_b) values
  ('월급 500 + 주7일 출근', '월급 300 + 주4일 출근'),
  ('월세 50만원 깔끔하게', '전세 대출 이자 갚기'),
  ('매일 커피 사먹기', '회사 탕비실 공짜 커피'),
  ('매달 적금 100만원', '매달 여행 100만원'),
  ('지금 당장 현금 10억', '평생 매달 500만원'),
  ('평생 점심값 무료', '평생 교통비 무료');
```

> 이미 한 번 실행했다면 4)의 `add table` 은 "already member" 에러가 날 수 있어요 — 무시해도 됩니다.

## 3) URL / anon key 복사
좌측 **Project Settings → API** 에서
- **Project URL** (예: `https://xxxx.supabase.co`)
- **anon public** key (`eyJ...` 로 시작)

> anon key 는 브라우저 노출용으로 설계된 공개 키입니다. 실제 보안은 위에서 만든 **RLS 정책**이 담당합니다.

## 4) 앱에 연결
두 가지 방법 중 하나:

- **빠른 테스트 (개인용)**: 앱을 열면 나오는 **설정 화면**에 URL / anon key 를 붙여넣고 저장 → 브라우저 `localStorage` 에 저장되어 바로 사용. (헤더의 ⚙️ 설정 버튼으로 언제든 변경)
- **여러 사람과 공유 (권장)**: `index.html` 상단의 상수에 직접 넣고 배포 →

```js
const SUPABASE_URL = "https://xxxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

---

## 실행 / 공유
로컬 실행:
```bash
cd week-5/balance-game
npx serve .
# 또는 VS Code "Live Server" 확장으로 index.html 열기
```

링크 공유(권장 — 같은 데이터를 동시에):
```bash
# 상단 상수에 URL/KEY 를 넣은 뒤 (week-4 앱들처럼 Vercel 정적 배포)
npx vercel --prod
```

> 동일한 Supabase URL/KEY 가 들어간 `index.html` 을 본 사람들은 모두 **같은 DB** 에 투표하게 되어 실시간으로 결과가 공유됩니다.

## 동작 원리 요약
- **질문 등록** → `questions` insert · **투표** → `votes` insert (choice = 'A'|'B')
- **투표율 계산** → 서버측 `vote_stats` 뷰가 A/B/총합을 COUNT (뷰가 없으면 `votes` 를 받아 클라이언트 폴백 집계)
- **실시간** → `votes`·`questions` 테이블 INSERT 를 Realtime 으로 구독해 모든 화면의 바/목록을 즉시 갱신
- **중복 투표 방지(UX)** → 내가 투표한 질문/선택을 `localStorage('balance_game_voted')` 에 저장
