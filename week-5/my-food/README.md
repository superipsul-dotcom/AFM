# 🧊 우리집 냉장고 — 재료 & 레시피 관리앱 (Server + DB)

냉장고 재료와 레시피를 **Supabase PostgreSQL** 에 영속 저장하는 단일 페이지 앱.
프론트(`index.html`, CDN React)와 백엔드(`server.js`, Express + pg)를 한 서버가 함께 서빙합니다.

## 구성

| 파일 | 역할 |
|------|------|
| `index.html` | UI (React + Tailwind, CDN). `/api` 로 서버와 통신 |
| `server.js` | Express 서버 + REST API + 정적 서빙 (pg → Supabase) |
| `supabase-seed.sql` | Supabase SQL Editor 에 붙여넣는 시드 (재료 7 + 레시피 3) |
| `seed.js` | `node seed.js` 로 같은 시드를 코드로 삽입 (멱등) |
| `.env.example` | `DATABASE_URL` 템플릿 (→ `.env` 로 복사해 채움) |
| `vercel.json` | Vercel 배포 설정 |

## 실행 방법

```bash
# 1) 의존성 설치
npm install

# 2) 환경변수 설정
cp .env.example .env
#   - DATABASE_URL   : Supabase 대시보드 → Connect → Transaction pooler (포트 6543)
#   - OPENAI_API_KEY : AI 레시피 추천용 (https://platform.openai.com/api-keys)

# 3) 시드 (둘 중 하나)
#   (a) Supabase 대시보드 SQL Editor 에 supabase-seed.sql 붙여넣고 RUN
#   (b) 또는: npm run seed        (미리보기: npm run seed:dry)

# 4) 서버 실행 → http://localhost:3005
npm start
```

## API 계약

응답 봉투는 `{ success, data, message }`. `createdAt` 은 epoch-ms 숫자.

| 메서드 | 경로 | 본문 |
|--------|------|------|
| GET | `/api/ingredients` | — |
| POST | `/api/ingredients` | `{ name, quantity, category, expiry }` |
| DELETE | `/api/ingredients/:id` | — |
| GET | `/api/recipes` | — |
| POST | `/api/recipes` | `{ title, ingredients, steps }` |
| PUT | `/api/recipes/:id` | `{ title, ingredients, steps }` |
| DELETE | `/api/recipes/:id` | — |
| POST | `/api/ai/recommend` | — (서버가 DB 재료를 읽어 OpenAI로 추천 생성) |

**AI 레시피 추천:** 레시피 탭의 `✨ AI 추천` 버튼 → 서버가 현재 냉장고 재료(유통기한 임박 우선)를 OpenAI `gpt-4o-mini`에 보내 요리 2~3개를 JSON으로 받아 카드로 표시. `저장` 누르면 `recipes` 테이블에 영속. API 키는 서버에서만 사용(프론트 노출 없음).

- `ingredient.category` = 보관위치(`냉장`/`냉동`/`실온`), `expiry` = `'YYYY-MM-DD'` 또는 `''`.
- `recipe.ingredients` / `recipe.steps` 는 줄바꿈(`\n`) 구분 TEXT.

## 스키마

```
ingredients(id uuid, name text, quantity text, category text, expiry text, created_at timestamptz)
recipes(id uuid, title text, ingredients text, steps text, created_at timestamptz)
```
