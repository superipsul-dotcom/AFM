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
