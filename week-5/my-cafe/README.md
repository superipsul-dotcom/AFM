# ☕ week-5/my-cafe — 카페 창업 여정의 출발점

5주차 '카페 창업' 미션의 시작. 하버 카페 이야기를 딛고 **내 카페 = 카페 안도(Cafe Ando)** 를 정의했다.

## 산출물

| 파일 | 설명 |
|---|---|
| **`my_cafe.md`** | ⭐ 핵심 — 내 카페 정의서. 이후 홍보·조사·운영·견적 퀘스트 전부가 이 파일을 '내 데이터'로 쓴다 (카페 버전 MISSION.md) |
| `index.html` | 브랜드 허브 앱 (단일 파일 React) — 🏠 브랜드 홈(마크다운 렌더) + ✏️ 편집(에디터·인터뷰 위저드) |
| `server.js` | Express 서버 (PORT 3013) — my_cafe.md 파일이 곧 DB |
| `logo.png` | AI 생성 로고 (gpt-image-1) — 브랜드 홈 히어로에 자동 표시 |
| `CONTRACT.md` | 서버/프론트 두 에이전트 병렬 빌드용 API 계약 |
| `db/schema.sql` + `db/seed.mjs` | 🗄️ 운영 DB — 공유 Supabase에 `cafe_` 접두사 4테이블(일별 매출·메뉴별 판매·리뷰·재고), 오픈일 6/7~어제까지 my_cafe.md와 정합한 시드 |
| **`cafe-agent.mjs`** | 🤖 **AI 운영 파트너 에이전트** — [my_cafe.md 컨셉] + [운영 브리핑(고정 SQL 9개)] 주입 + read-only `run_sql` 도구 |
| `BEFORE_AFTER.md` | 🎬 미션 시연 — 같은 질문 4개를 "컨텍스트 없는 AI" vs "카페 안도 에이전트"로 비교한 기록 (`npm run demo` 산출물) |

## 🤖 [Context + DB] AI 운영 파트너 미션

```
[AI Context (my_cafe.md)]  +  [카페 운영 DB (Supabase cafe_*)]  →  [내 카페를 아는 에이전트]
```

- **DB (4테이블, `cafe_` 격리)**: `cafe_daily_sales`(31영업일, 날씨·완판 메모) · `cafe_menu_sales`(메뉴판 7종 그대로, 일매출↔메뉴합계 정합) · `cafe_reviews`(22건 — 입구 불만·흑임자 디저트 요청 등) · `cafe_inventory`(10품목 — 리드타임·발주점)
- **에이전트 구조**: 시스템 프롬프트에 ①my_cafe.md 전문 ②운영 브리핑(요일별·주차별·날씨별·메뉴 랭킹·리뷰 전문·재고 계산) 주입 + ③심화 조회용 read-only SQL 도구(SELECT 1문만, READ ONLY 트랜잭션, 8s 타임아웃 — 가계부 analyst.mjs 패턴 재사용)
- **Before/After**: 컨텍스트 없는 AI는 7월에 "겨울 고구마 라떼", 휴무일(월)에 "커피 1+1"을 제안하지만, 에이전트는 "흑임자 아포가토(음료 1위 시그니처 × 폭염 × 리뷰 요청)"·"생무화과 오늘 발주(남은 0.1일)"처럼 데이터를 인용해 답한다 → `BEFORE_AFTER.md`

```bash
npm run seed                                       # DB 스키마+시드 (멱등, 시드 고정 PRNG)
npm run ask "신메뉴 뭐 추가할까?"                    # ✅ 카페 안도 에이전트
node cafe-agent.mjs --bare "신메뉴 뭐 추가할까?"      # ❌ 컨텍스트 없는 일반 AI
node cafe-agent.mjs --compare "질문"                 # 두 모드 나란히 비교
npm run demo                                       # 대표 질문 4개 비교 → BEFORE_AFTER.md
node cafe-agent.mjs                                # 대화형 REPL
```

`.env` 필요: `DATABASE_URL`(공유 Supabase — my-food/가계부와 동일 프로젝트), `OPENAI_API_KEY` (모델 기본 gpt-4o, `OPENAI_MODEL`로 교체 가능)

## 카페 안도 요약

> "잠시 숨 고르며 안도(安堵)하는 공간" — 인테리어 회사 **안도공간**이 성수동 골목 2층 12평에 직접 지은 **자재 쇼룸 겸 카페**.
> 시그니처: 흑임자 크림라떼 · 무화과 바스크 치즈케이크. 오픈 4주차, 일 손님 18명(BEP 20명)으로 월 -27만 적자.
> 문제: 2층이라 아무도 모른다 → 홍보·조사·운영·견적 퀘스트로 해결해 나간다.

## 실행

```bash
cd week-5/my-cafe
npm install
npm start        # http://localhost:3013
```

## API

- `GET /api/health` → `{ ok, service }`
- `GET /api/cafe` → `{ markdown, updatedAt }` (my_cafe.md 내용)
- `PUT /api/cafe` `{ markdown }` → 저장 (빈 내용이면 400으로 파일 날림 방지)
