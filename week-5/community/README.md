# 🗣️ 커뮤니티 게시판 (JWT 인증)

로그인한 사용자만 글을 쓸 수 있고, **자기 글만 수정·삭제**할 수 있는 커뮤니티 게시판입니다.
4주차 익명 게시판(누구나 삭제 가능)과 달리 **"누가 썼는지"를 기록**하고 권한을 부여합니다.

- **인증:** 이메일/비밀번호 회원가입 + 로그인 → **JWT(Bearer) 토큰**
- **DB:** Supabase(PostgreSQL) — 회원/게시글을 영속 저장
- **앱:** 로그인 여부와 작성자에 따라 권한 분기

```
[회원가입/로그인] → [게시글 목록(로그인한 전체 공개)] → [글쓰기(로그인 필수)] → [수정/삭제(본인만)]
```

## 구성

| 파일 | 역할 |
|------|------|
| `index.html` | 프론트엔드 — 단일 파일 CDN React(UMD) + Tailwind + Babel. 해시 라우팅, AuthContext, JWT 저장/세션복원 |
| `server.js` | 백엔드 — Express + pg + JWT(jsonwebtoken) + bcryptjs. 인증 + 게시글 CRUD REST API |
| `supabase-schema.sql` | DB 스키마 (서버가 부팅 시 자동 생성하므로 실행은 선택) |
| `.env` | 비밀(DATABASE_URL / JWT_SECRET / PORT) — **git 제외, 커밋 금지** |
| `.env.example` | `.env` 작성용 템플릿 (플레이스홀더) |
| `vercel.json` | Vercel 배포 설정 (server.js=함수, index.html=정적) |

## 실행

```bash
cd week-5/community
npm install
npm start          # → http://localhost:3008
```

`.env` 는 이미 채워져 있습니다(같은 Supabase 프로젝트 재사용). 다른 Supabase 를 쓰려면
`.env.example` 을 참고해 `DATABASE_URL` 을 교체하고, `JWT_SECRET` 은 아래로 새로 발급하세요:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 데이터베이스

같은 Supabase 프로젝트의 다른 앱(todos·my-food)과 충돌하지 않도록 **`community_` 접두사**로 격리했습니다.

- **`community_users`** — `id`(UUID), `email`(UNIQUE), `password_hash`(bcrypt), `nickname`, `created_at`
- **`community_posts`** — `id`(UUID), `user_id`→`community_users`(ON DELETE CASCADE), `title`, `content`, `created_at`, `updated_at`

비밀번호는 **bcrypt 해시**로만 저장하며, 평문/해시는 어떤 응답에도 포함되지 않습니다.

## API (응답 봉투 `{ success, data, message }`)

| 메서드 | 경로 | 인증 | 설명 |
|--------|------|------|------|
| POST | `/api/auth/signup` | 공개 | 회원가입 `{email,password,nickname}` → `{token,user}` (중복 409, 검증 400) |
| POST | `/api/auth/login` | 공개 | 로그인 `{email,password}` → `{token,user}` (불일치 401) |
| GET | `/api/auth/me` | Bearer | 세션 복원 → `{user}` |
| GET | `/api/posts` | Bearer | **전체** 글 최신순 (작성자 닉네임·`isMine` 포함) |
| GET | `/api/posts/:id` | Bearer | 글 상세 (없으면 404) |
| POST | `/api/posts` | Bearer | 글 작성 `{title,content}` → 글 (201) |
| PUT | `/api/posts/:id` | Bearer | 글 수정 — **본인만** (타인/없음 404) |
| DELETE | `/api/posts/:id` | Bearer | 글 삭제 — **본인만** (타인/없음 404) |

`post = { id, title, content, authorId, authorName, createdAt, updatedAt, isMine }`

**권한 모델**
- 글쓰기 → 로그인 필요(`authMiddleware`)
- 조회 → 로그인한 누구나 전체 열람(작성자 표시)
- 수정/삭제 → SQL `WHERE id=$1 AND user_id=$2` 로 본인 글만(타인 소유는 매칭 0건 → 404, 존재 여부도 노출 안 함)

## 화면 (해시 라우팅)

`/#/login` · `/#/signup` · `/#/`(목록) · `/#/write`(글쓰기) · `/#/posts/:id`(상세) · `/#/posts/:id/edit`(수정, 본인만)
보호 라우트는 비로그인 시 로그인으로, 로그인/회원가입은 로그인 상태면 목록으로 자동 이동합니다.

## 배포 (Vercel)

```bash
npm i -g vercel       # 최초 1회
vercel                # 프리뷰 배포 / vercel --prod 운영 배포
```

Vercel 대시보드 → **Settings → Environment Variables** 에 `DATABASE_URL`, `JWT_SECRET` 을 추가하세요
(`.env` 는 배포에 포함되지 않습니다). 배포 후 URL 을 가족·친구·수강생에게 공유해 가입·글쓰기를 시켜보세요.

## 검증 (2026-06-28)

`npm start` 부팅 + Supabase 연결 + 테이블 자동 생성 확인. fetch 스위트 **32/32 통과**(정적 서빙,
인증 가드, 회원가입/로그인/me, 검증·중복, 게시글 CRUD, **권한 격리**(타인 글 수정·삭제 404),
최신순 정렬, 미정의 API 404). 헤드리스 렌더로 로그인 화면 표시(흰 화면 아님) 확인.
