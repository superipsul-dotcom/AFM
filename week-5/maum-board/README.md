# 마음 한 조각 v2 💌 — 이름과 함께 남기는 고민·칭찬·응원

**week-4 익명 게시판에 Auth(회원가입/로그인)를 붙인 업그레이드 버전**입니다.

> 💡 **깨달아야 할 핵심:**
> 4주차 익명 게시판은 "누가 썼는지" 몰랐습니다. Auth 를 붙이면 **"이 글은 OO님이 썼다"** 가 되고,
> **자기 글만 수정/삭제**할 수 있게 됩니다. 공감도 무제한 +1 이 아니라 **1인 1공감(토글)** 이 됩니다.

| | week-4 익명판 | **week-5 이번판 (v2)** |
|---|---|---|
| 작성자 | 없음 (익명) | **닉네임 표시** (회원가입/로그인) |
| 글 구조 | 내용만 | **제목 + 내용** + 카테고리 |
| 수정/삭제 | 불가 | **내 글만 가능** (서버가 강제) |
| 공감 | 무제한 +1 (UPDATE) | **1인 1개, 다시 누르면 취소** (maum_likes 행 기록) |
| 서버 | Supabase 직접 호출 | **직접 만든 Express API + JWT** |

---

## 🧱 구조 (미션의 핵심 구조 그대로)

```
[회원가입/로그인] → [게시글 목록 (전체 공개)] → [글쓰기 (로그인 필수)] → [수정/삭제 (본인만)]
        │                                              │
        └── JWT 토큰 발급 ── Authorization: Bearer ──────┘
```

- **Auth:** "이 글을 누가 썼는지" 기록하는 장치 — bcrypt 해시 + JWT(HS256, 7일)
- **DB:** Supabase PostgreSQL — 게시글 + 작성자 + 공감을 함께 저장 (테이블 3개)
- **앱:** 로그인 여부와 작성자에 따라 권한을 다르게 부여
  - 조회(목록/상세): **로그인 없이도 전체 공개** (공유 링크 받으면 바로 구경 가능)
  - 글쓰기/공감: **로그인한 사람만**
  - 수정/삭제: **본인 글만** (타인 글은 404 — 서버 WHERE 절이 강제)

## 파일 구성

```
maum-board/
├── server.js      # Express + pg + bcryptjs + jsonwebtoken (REST API + 정적 서빙)
├── index.html     # React(CDN) 프론트 — week-4 디자인 계승 + 인증/상세/수정 UI
├── vercel.json    # Vercel 배포 설정 (/api/* → server.js, 나머지 → index.html)
├── .env           # DATABASE_URL / PORT / JWT_SECRET (커밋 금지!)
└── .env.example   # 환경변수 템플릿
```

## 🗄️ 테이블 (maum_ 접두사로 같은 Supabase 의 다른 앱들과 격리)

| 테이블 | 컬럼 | 역할 |
|---|---|---|
| `maum_users` | id(UUID), email(UNIQUE), password_hash, nickname, created_at | 회원 |
| `maum_posts` | id, user_id(FK CASCADE), category, title, content, created_at, updated_at | 게시글 |
| `maum_likes` | post_id + user_id (복합 기본키), created_at | 공감 — **쌍이 PK 라서 1인 1공감** |

서버 부팅/첫 요청 시 `CREATE TABLE IF NOT EXISTS` 로 자동 생성됩니다 (별도 SQL 실행 불필요).

## 🔌 API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/auth/signup` | – | 가입 { email, password, nickname } → { token, user } |
| POST | `/api/auth/login` | – | 로그인 → { token, user } (불일치 401) |
| GET | `/api/auth/me` | Bearer | 세션 복원 |
| GET | `/api/posts?category=고민&sort=popular` | 선택 | 목록 (기본 최신순, 공개) |
| GET | `/api/posts/:id` | 선택 | 상세 (공개) |
| POST | `/api/posts` | Bearer | 작성 { category, title, content } |
| PUT | `/api/posts/:id` | Bearer | 수정 — **본인 글만** (아니면 404) |
| DELETE | `/api/posts/:id` | Bearer | 삭제 — **본인 글만** (아니면 404) |
| POST | `/api/posts/:id/like` | Bearer | **공감 토글** (누르면 +1, 다시 누르면 취소) |

응답 봉투: 성공 `{ success:true, data, message }` / 실패 `{ success:false, data:null, message }`
post 모델: `{ id, category, title, content, authorId, authorName, createdAt, updatedAt, isMine, likeCount, likedByMe }`

## 🚀 로컬 실행

```bash
cp .env.example .env   # DATABASE_URL, JWT_SECRET 채우기
npm install
npm start              # → http://localhost:3012
```

## ☁️ Vercel 배포

```bash
vercel --prod
# 환경변수 2개 등록 필요: DATABASE_URL, JWT_SECRET
```

## 🧪 함께 해보기 (Part 4)

배포 URL 을 가족/친구에게 공유해서 **가입 → 글쓰기 → 서로 공감**을 해보세요.
- 글 읽기는 링크만 받으면 바로 가능해요 (전체 공개)
- 남의 글엔 수정/삭제 버튼이 아예 안 보이고, API 로 우회해도 서버가 404 로 막아요
- 같은 글에 공감을 두 번 누르면? → 취소돼요 (익명판과 달리 "누가 눌렀는지" 알기 때문!)

## 🛟 문제 해결

- **"로그인이 필요합니다"** → 우측 상단으로 로그인하세요. 토큰은 7일 뒤 만료됩니다.
- **DB 연결 실패** → `.env` 의 `DATABASE_URL`(트랜잭션 풀러 :6543) 확인.
- **화면이 하얗게 나옴** → 콘솔에 import 오류가 보이면 babel classic runtime 설정(head 의 스크립트)이 지워지지 않았는지 확인.
