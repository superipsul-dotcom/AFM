# CONTRACT — 카페 안도 브랜드 허브 (week-5/my-cafe)

서버 에이전트와 프론트 에이전트가 **이 문서만 보고 독립적으로** 작업한다.

## 공통

- PORT: **3013**
- 데이터베이스 없음. **`./my_cafe.md` 파일이 곧 DB다** (UTF-8).
- 파일 소유권: `server.js`·`package.json` = 서버 에이전트 / `index.html` = 프론트 에이전트. **서로의 파일을 만들거나 수정하지 않는다.**
- `my_cafe.md`는 이미 작성돼 있다. **에이전트가 내용을 덮어쓰지 말 것** — 서버는 런타임에 읽고 쓰기만 한다.

## 서버 (server.js — Express)

- 정적 파일 서빙: 프로젝트 폴더 전체 (`GET /` → index.html, `/logo.png` 등)
- `GET /api/health` → 200 `{ "ok": true, "service": "my-cafe" }`
- `GET /api/cafe` → 200 `{ "markdown": "<my_cafe.md 전체 내용>", "updatedAt": "<파일 mtime ISO 문자열>" }`
  - 파일이 없으면 200 `{ "markdown": "", "updatedAt": null }`
- `PUT /api/cafe` — body `{ "markdown": "<string>" }`
  - markdown이 string이 아니거나 trim 후 빈 값이면 **400** `{ "error": "markdown 내용이 비어 있습니다" }` (파일 날림 방지)
  - 성공 시 `my_cafe.md`에 저장 후 200 `{ "ok": true, "updatedAt": "<ISO>" }`
- `express.json({ limit: '1mb' })` 사용, 그 외 `/api/*` 는 404 JSON `{ "error": "not found" }`

## 프론트 (index.html — 단일 파일 React CDN)

- `API_BASE_URL = '/api'` (상대경로 — localhost 하드코딩 금지)
- 탭 2개:
  1. **🏠 브랜드 홈** — `GET /api/cafe`의 마크다운을 marked.js(CDN)로 렌더.
     - 첫 `# H1` + 첫 `> blockquote`는 본문에서 분리해 **히어로 섹션**으로 크게 (로고는 `<img src="/logo.png">` 시도, onError 시 ☕ 이모지 폴백)
     - 마크다운 표·체크리스트·헤딩 스타일링 (카페 감성)
  2. **✏️ 편집** — 고정폭 textarea 에디터 + [💾 저장](PUT, 성공/실패 토스트) + [🪄 인터뷰로 다시 만들기] 버튼
     - 인터뷰 = 8문항 위저드 모달: 카페 이름 / 한 줄 슬로건 / 컨셉 설명 / 위치·평수 / 시그니처 메뉴(이름+가격 2~3개) / 타깃 손님 / 경쟁 카페 / 3개월 목표
     - 답을 마크다운 템플릿에 채워 **에디터 textarea에만 반영** (자동 저장 금지 — 사용자가 검토 후 저장)
- 무드: 크림 `#F5F0E8` · 월넛 브라운 `#5C4633` · 세이지 그린 `#8A9A7B`, 따뜻한 카페 감성, 한국어 UI
