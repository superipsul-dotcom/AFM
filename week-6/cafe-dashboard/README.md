# ☕ week-6/cafe-dashboard — 카페 안도 사장님 대시보드

> **라이브**: https://afm-cafe-dashboard.vercel.app (Vercel 프로젝트 `afm-cafe-dashboard`)

```
[로그인] → [Auth 확인(JWT)] → [카페 DB(Supabase) + 날씨 API(Open-Meteo)] → [AI "오늘의 카페 브리핑"] → [대시보드]
```

week-5/my-cafe 미션이 만든 **카페 안도 운영 DB(`cafe_*`)** 위에, 사장님 전용 운영 대시보드를 올렸다.

## 미션 충족

| Part | 구현 |
|---|---|
| **1. Auth** | 이메일/비밀번호 회원가입 + 로그인 (bcryptjs + JWT 7d). 가입에는 **사장님 코드**(`OWNER_CODE` env) 필요 → 사장님만 대시보드 접근. 모든 데이터 API는 Bearer 토큰 필수 |
| **2. 데이터 소스 2+** | ① **Supabase DB** — `cafe_daily_sales`/`cafe_menu_sales`/`cafe_reviews`/`cafe_inventory`(week-5 시드) + 신규 `cafe_users`/`cafe_todos`/`cafe_briefings` ② **외부 API** — Open-Meteo 성수동 예보(키 불요, 서버 프록시+20분 캐시). (노션은 API 토큰이 없어 할일을 DB 테이블로 구현) |
| **3. AI 브리핑** | `POST /api/briefing/generate` — 최근 영업일 실적(전주 같은 요일 대비)·주간 추세·인기 메뉴·재고 경고(리드타임 역산)·미완료 할일·오늘 날씨 + **my_cafe.md 전문**을 gpt-4o에 종합 → 마크다운 브리핑. **하루 1회 DB 캐시**(`cafe_briefings`, KST 기준) + 다시 생성(force) |
| **4. 대시보드 + 배포** | 단일 index.html React — AI 브리핑 · 오늘 할일(CRUD+D-day 배지) · 성수동 날씨(시간별 12h) · 이번 주 매출(Chart.js, 월 휴무 반영) · 인기 메뉴 TOP3 · 재고 경고 · 최근 리뷰. 카페 안도 브랜드 컬러(크림/월넛/세이지). Vercel 배포 |

## 파일

| 파일 | 설명 |
|---|---|
| `server.js` | Express (PORT 3016) — Auth/대시보드/날씨/할일/브리핑 API. Vercel 서버리스 호환(스키마 lazy 준비, KST 보정, 파일쓰기 없음) |
| `index.html` | 단일 파일 React 대시보드 (Tailwind CDN + Babel classic runtime + Chart.js + marked) |
| `my_cafe.md` | 카페 정의서 스냅샷 (week-5/my-cafe 원본 복사) — 브리핑의 컨셉 컨텍스트 |
| `test.mjs` | e2e 33개 — 로컬/프로덕션 동일 실행 (`node test.mjs [baseUrl]`) |
| `vercel.json` | @vercel/node + includeFiles(index.html·my_cafe.md) + maxDuration 60 |

## 실행

```bash
npm install
npm start                  # http://localhost:3016
npm test                   # e2e 33개 (서버 떠 있어야 함)
node test.mjs https://afm-cafe-dashboard.vercel.app   # 프로덕션 스모크
```

`.env`: `DATABASE_URL`(공유 Supabase) · `JWT_SECRET` · `OPENAI_API_KEY` · `OWNER_CODE`(가입 코드, 기본 ANDO2026) · `PORT`

## 검증 기록 (2026-07-13)

- 로컬 e2e **33/33** · 프로덕션 e2e **33/33**
- 프로덕션 브리핑 force 재생성 6.4s (gpt-4o) — "어제 일요일 매출 400,400원(+21%), 흑임자 페이스트 오늘 발주(리드타임 4일)" 등 실데이터 인용 확인
- Playwright UI 관통(로그인→대시보드 전 위젯, 콘솔 에러 0) — `screenshots/dashboard-local.png`
