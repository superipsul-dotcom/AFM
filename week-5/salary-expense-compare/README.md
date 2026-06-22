# 💰 익명 월급·지출 비교소 (Server + DB · Supabase)

혼자의 월급은 그냥 숫자지만, 여러 명이 모이면 **통계**가 됩니다.
익명으로 **월급 · 월 지출 · 직군/연차**를 입력하면
**전체 평균 / 월급 분포 / 내 위치(상위 %) / 카테고리별 평균 지출 / 직군별 평균**을 보여줍니다.

## 구조 (Server + DB)

```
[익명 입력]  →  supabase-js  →  [ Supabase ]
                                  ├─ DB     : submissions 테이블 (원본 데이터 저장)
                                  └─ Server : 통계 함수(RPC) — AVG · COUNT · GROUP BY
```

- **DB 역할** — `submissions` 테이블에 익명 데이터를 저장
- **Server 역할** — Postgres 함수 4개가 통계/비교 API 역할을 합니다
  - `get_overall_stats()` — 전체 평균 (AVG · COUNT)
  - `get_job_category_stats()` — 직군별 평균 (GROUP BY)
  - `get_salary_percentile(p_salary)` — 내 위치 = 상위 %
  - `get_salary_distribution()` — 월급 분포 (구간별 COUNT)
- 별도의 Node 서버는 없습니다. **Supabase가 자동 생성하는 API가 서버 역할**을 합니다.

## 준비 (약 5분)

1. <https://supabase.com> 에서 무료 프로젝트를 생성합니다.
2. **SQL Editor → New query** 에 `supabase-schema.sql` 전체를 붙여넣고 **RUN(▶)**.
3. **Project Settings → API** 에서 **Project URL** 과 **anon public** 키를 복사합니다.
4. `index.html` 을 (로컬 서버로) 연 뒤 우측 상단 **⚙️ 설정**에 URL/Key 를 붙여넣습니다.
   - 또는 `index.html` 상단의 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 상수를 직접 수정해도 됩니다.

## 실행

- VS Code의 **Live Server** 확장으로 `index.html` 열기, 또는
- 터미널에서 `npx serve .`

## 수업 팁 📊

수강생들이 각자 월급/지출을 입력할 때마다 평균·분포·내 위치가 **실시간으로 바뀌는** 걸 함께 보세요.
20명만 모여도 "우리 반 월급 분포"라는 의미 있는 통계가 만들어집니다.

> ⚠️ 누구나 익명으로 읽고 쓸 수 있는 **수업/실습용 설정**입니다. 실제 서비스에는 인증·검증을 추가하세요.
> 💡 금액 단위는 모두 **만원**입니다. (월급 300 = 월 300만원, 연봉 환산 = ×12)
