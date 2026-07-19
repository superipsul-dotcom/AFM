# 안도마켓 🥕 — 우리동네 당근마켓

부트캠프 week-7 파이널 퀘스트: **Auth + DB + 이미지 업로드 + 1:1 폴링 채팅**을 한 번에 통합한 당근마켓 클론.

| | |
|---|---|
| 스택 | Express + pg(Supabase Postgres) + JWT + bcryptjs / 단일 `index.html` (CDN React 18 + Tailwind + Babel) |
| 이미지 | ImageKit 직접 업로드 (서버는 HMAC-SHA1 서명만 발급, 상품당 최대 3장) |
| 채팅 | 1:1 문의방 — 채팅방 2.5초 / 목록 5초 폴링, `?after=<id>` 커서 증분 |
| DB | 공유 Supabase에 `dg_` 접두사 테이블 5개 (users/products/favorites/chat_rooms/chat_messages), 부팅 시 자동 생성 |
| 포트 | 3018 |

## 실행

```bash
npm install
node server.js   # http://localhost:3018
```

`.env` (gitignore됨):

```
PORT=3018
DATABASE_URL=postgresql://...
JWT_SECRET=...
IMAGEKIT_PUBLIC_KEY=...
IMAGEKIT_PRIVATE_KEY=...
IMAGEKIT_URL_ENDPOINT=https://ik.imagekit.io/...
```

## 구조

- `CONTRACT.md` — API·스키마·페이지 명세. **server.js와 index.html을 두 에이전트(single-server-specialist / single-react-dev)가 이 계약서 하나로 병렬 빌드**했다.
- `server.js` — 전 엔드포인트 17종. 소유권 검증(남의 것 403/없는 것 404 분리), 파라미터라이즈드 쿼리, N+1 없는 JOIN(LATERAL last_message 등).
- `index.html` — 해시 라우팅 7페이지(홈/로그인/가입/상세/글쓰기·수정/채팅목록/채팅방/마이), 당근 오렌지 `#FF6F0F`, 모바일 프레임(max-w 430px) + 하단 탭바.
- `tools/seed-demo.sh` — 데모 계정 2개(안도/포도) + ImageKit 실업로드 + 상품 4건 + 관심/채팅 시드.
- `tools/gen-demo-imgs.sh` — 데모 상품 사진 4장 gpt-image-1 생성 스크립트.

## 데모 계정

| 계정 | 이메일 | 비번 | 역할 |
|---|---|---|---|
| 안도 (성수동) | ando@ando.market | demo1234 | 판매자 — 상품 4건 |
| 포도 (성수동) | podo@ando.market | demo1234 | 구매자 — 관심·채팅 |

## 검증

- 서버: curl 자가검증 70/70 (인증/CRUD/권한/검색/필터/관심/채팅/커서/엣지케이스)
- 프론트: Playwright e2e — 로그인 → 상세 → 관심 토글 → 채팅방 생성·전송 → 목록 폴링 실시간 갱신 → 마이페이지 탭 → 검색 `q=의자` 1건 → 카테고리 필터 2건
- 실사용: 제3의 유저(평화·자양동)가 가입 → 폰 사진 업로드 → 상품 등록 → 데모 유저와 채팅 왕복까지 실제 동작 확인
- `screenshots/` 참고

## 배포

미정 — 로컬 검증 완료 상태. (Vercel 배포는 확정 후 진행)
