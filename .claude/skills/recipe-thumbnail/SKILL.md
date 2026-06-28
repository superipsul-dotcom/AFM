---
name: recipe-thumbnail
description: 레시피 마크다운(my-recipe/*.md 등)에서 메타데이터를 읽어, OpenAI 이미지 API(gpt-image-1)로 실제 음식 사진 같은 레시피 썸네일(PNG)을 생성해 "썸네일/" 폴더에 저장합니다. 키 없이 오프라인일 땐 헤드리스 Chrome 카드로 폴백합니다. 사용자가 /recipe-thumbnail 을 실행하거나 "레시피 썸네일/대표 이미지 만들어줘", "썸네일 만들어", "이 레시피 이미지로 뽑아줘" 같이 요청할 때, 또는 /recipe 로 레시피를 만든 직후 썸네일이 필요할 때 사용하세요.
---

# 🖼️ 레시피 썸네일 생성 스킬

레시피 `.md` 한 개 → 음식 사진 썸네일 PNG 한 개. **기본은 OpenAI 이미지 생성(gpt-image-1)** 으로 실제 음식 사진/일러스트를 만들어 레시피 옆 `썸네일/` 폴더에 저장한다.

핵심 파이프라인:
`레시피 .md 읽기 → 메타데이터 추출 → 영어 음식사진 프롬프트 작성 → gen-thumbnail-openai.mjs 실행(OpenAI) → 썸네일/*.png 저장 → 사용자에게 이미지로 보고`

> **두 가지 생성기 (스킬 폴더 안):**
> - 🥇 `gen-thumbnail-openai.mjs` — **기본.** OpenAI `gpt-image-1` 로 실제 음식 이미지 생성. `OPENAI_API_KEY` 필요.
> - 🥈 `gen-thumbnail.mjs` — **폴백.** 키가 없거나 오프라인일 때, 헤드리스 Chrome으로 이모지 카드(제목·배지) PNG 생성. API 불필요.

## 입력 (인자)

- **인자 없음** — `my-recipe/`(또는 현재 폴더)에서 **가장 최근 레시피 `.md`** 1개
- **레시피 파일 경로** — 예: `/recipe-thumbnail week-5/my-recipe/recipe-squid-fried-rice-2026-06-23.md`
- **요리명** — 예: `/recipe-thumbnail 오징어 볶음밥`
- **`all`** — 대상 폴더의 모든 레시피 `.md` 일괄 생성
- **`card`** 포함 — OpenAI 대신 폴백(Chrome 카드)으로 강제 (예: `/recipe-thumbnail 오징어 볶음밥 card`)

## 절차 (이 순서대로)

### 1) 대상 레시피 `.md` 정하기
1. 인자가 파일 경로면 그 파일
2. 인자가 요리명이면 `**/my-recipe/*.md`(없으면 `**/recipes/*.md`)에서 제목 일치 파일 (`node_modules` 제외)
3. `all` → 대상 폴더의 모든 `recipe-*.md`
4. 인자 없음 → 가장 최근(수정시각) 레시피 `.md` 1개
- 어떤 파일을 쓰는지 한 줄로 알린다.

### 2) 메타데이터 추출 (레시피 `.md`를 Read)
- `title` — 첫 `#` 제목에서 이모지를 뺀 요리명 (예: `오징어 볶음밥`)
- `subtitle` — 메타 줄 다음 첫 본문 문단(첫 문장)
- **재료/조리 순서** — 프롬프트에 넣을 핵심 재료·담음새·가니시 파악용 (예: 오징어 링, 채소, 흰밥, 깨, 쪽파)

### 3) 영어 음식사진 프롬프트 작성  ⭐ (이 스킬의 핵심)
추출한 정보로 **구체적인 영어 프롬프트**를 직접 만든다. AI는 영어 묘사를 가장 잘 따른다. 다음 요소를 담는다:
- 요리명 (영문 + 괄호 안 한글), 주재료와 담음새(그릇/플레이팅), 가니시
- 촬영 스타일: `professional food photography`, 시점(`overhead`/`45-degree`), `warm natural lighting`, `shallow depth of field`, `appetizing`, `ultra detailed`
- **반드시 끝에**: `no text, no watermark, no lettering` (AI 글자 깨짐 방지 — 제목/배지는 이미지에 넣지 않는다)

예시(오징어 볶음밥):
```
Professional overhead food photography of Korean squid stir-fried rice (오징어 볶음밥):
glossy stir-fried squid rings with diced onion, green onion and carrot over white rice
in a dark ceramic bowl, garnished with toasted sesame and chopped scallion, light chili
sheen, warm natural lighting, shallow depth of field, rustic wooden table, appetizing
food-magazine style, ultra detailed, no text, no watermark, no lettering
```

### 4) 출력 경로 정하기
- **폴더:** 레시피 `.md`가 있는 디렉터리 바로 아래 `썸네일/` (스크립트가 자동 생성).
- **파일명 slug:** 레시피 파일명에서 `recipe-` 접두사와 `-YYYY-MM-DD` 날짜를 떼어 재사용.
  - 예: `recipe-squid-fried-rice-2026-06-23.md` → `squid-fried-rice.png`
- **덮어쓰기:** 썸네일은 레시피 파생 1:1 산출물 → **같은 레시피면 덮어쓴다**(최신 갱신).

### 5) 생성기 실행 (기본: OpenAI)
값에 공백/한글이 있으니 **각 인자는 따옴표로 감싼다.**
```bash
node ".claude/skills/recipe-thumbnail/gen-thumbnail-openai.mjs" \
  --title "오징어 볶음밥" \
  --prompt "Professional overhead food photography of Korean squid stir-fried rice (오징어 볶음밥): ... no text, no watermark, no lettering" \
  --size landscape --quality medium \
  --out "week-5/my-recipe/썸네일/squid-fried-rice.png"
```
- **API 키:** 스크립트가 `OPENAI_API_KEY`(환경변수) → 출력폴더 옆 `.env` → `week-5/my-food/.env` → `.env` 순으로 자동 탐색. 다른 곳이면 `--env <경로>` 로 지정.
- **옵션:** `--size landscape|square|portrait|WxH` (기본 landscape=1536x1024) · `--quality low|medium|high` (기본 medium; low가 더 싸고 빠름) · `--model gpt-image-1`(기본; 접근 불가 시 `--model dall-e-3`).
- `--prompt` 없이 `--title`(+`--subtitle`)만 줘도 기본 음식사진 프롬프트가 자동 조립된다(품질은 직접 쓴 프롬프트가 더 좋음).
- `all` 모드면 레시피마다 위 명령을 반복.

### 5-폴백) 키 없음/오프라인 → Chrome 카드
인자에 `card`가 있거나 OpenAI 생성이 실패(키 없음/크레딧 부족 등)하면 카드 생성기로 만든다:
```bash
node ".claude/skills/recipe-thumbnail/gen-thumbnail.mjs" \
  --title "오징어 볶음밥" --emoji "🦑" --time "15분" --difficulty "보통" --servings "1인분" \
  --subtitle "쫄깃한 오징어와 채소를 센 불에 볶은 한 그릇" \
  --out "week-5/my-recipe/썸네일/squid-fried-rice.png"
```
(카드는 제목·이모지·배지가 들어간 결정적 산출물 — 자세한 사양은 이 스킬 폴더의 `gen-thumbnail.mjs` 참고.)

### 6) 확인 & 보고
- 생성된 PNG를 **Read로 한 번 열어** 음식이 제대로 나왔는지(엉뚱한 이미지/글자 깨짐 없는지) 눈으로 확인한다. 이상하면 프롬프트를 다듬어 1회 재생성.
- 저장된 **파일 경로**·크기·사용한 방식(OpenAI/카드)을 사용자에게 알리고 이미지를 보여준다.

## 주의사항
- **비용:** OpenAI `gpt-image-1` 은 장당 과금(대략 low 1~2¢, medium 수¢, high 더 비쌈). 반복 생성 시 기본 `medium`, 빠른 미리보기엔 `low` 권장.
- **키 보안:** 키는 `.env`/환경변수에서만 읽는다. 코드·결과물·로그에 키를 출력하지 않는다.
- 스크립트(`*.mjs`)는 **수정하지 않는다.** 새 썸네일은 레시피 `.md`만 있으면 만들 수 있다.
- 폴백 카드는 **Chrome 필요**(macOS 기본 경로 자동 탐색, 없으면 `CHROME=/path` 지정).
- 텍스트는 이미지에 넣지 않는다(프롬프트에 `no text`). 제목/배지가 박힌 썸네일이 필요하면 카드 폴백을 쓰거나, 별도로 OpenAI 이미지 위에 텍스트 오버레이 요청을 받는다.
