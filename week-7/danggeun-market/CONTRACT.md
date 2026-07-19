# 안도마켓 🥕 — 우리동네 당근마켓 CONTRACT (v1)

server.js(백엔드)와 index.html(프론트) **두 에이전트가 병렬로 빌드**하는 단일 계약서.
여기 정의된 것과 다르게 구현하지 말 것. 애매하면 이 문서가 정답.

## 컨셉

- 이름: **안도마켓 🥕** — 우리동네 중고거래 (당근마켓 클론)
- 기본 동네 예시: 성수동
- 스택: Express + pg(Supabase Postgres) + JWT / 단일 index.html (CDN React 18 + Tailwind + Babel)
- 이미지: ImageKit 직접 업로드 (서버는 서명만 발급, 상품당 최대 3장)
- 채팅: 1:1 문의, **폴링** (채팅방 2.5초 / 채팅목록 5초)
- 배포는 아직 안 함. 로컬 PORT **3018**.

## 파일 구조 (이것만!)

```
danggeun-market/
├── server.js      ← single-server-specialist 담당
├── index.html     ← single-react-dev 담당
├── package.json   (있음: express, pg, bcryptjs, jsonwebtoken, dotenv)
├── .env           (있음: PORT, DATABASE_URL, JWT_SECRET, IMAGEKIT_*)
└── CONTRACT.md
```

- server.js는 `GET /` 에서 index.html을 정적 서빙 (`express.static(__dirname)` 금지 — .env 노출됨. `res.sendFile`로 index.html만).
- 프론트 API_BASE = `''` (같은 오리진, 상대경로 `/api/...`).

## DB 스키마 (server.js가 부팅 시 CREATE TABLE IF NOT EXISTS로 자동 생성)

공유 Supabase라 **접두사 `dg_` 필수**. 기존 테이블(cafe_, shop_, interior_ 등) 절대 건드리지 말 것.

```sql
CREATE TABLE IF NOT EXISTS dg_users (
  id            serial PRIMARY KEY,
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  nickname      text NOT NULL,
  neighborhood  text NOT NULL,            -- 동네 (예: 성수동)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dg_products (
  id           serial PRIMARY KEY,
  user_id      int NOT NULL REFERENCES dg_users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text NOT NULL,
  price        int NOT NULL CHECK (price >= 0),   -- 원 단위, 0 = 나눔
  category     text NOT NULL,
  images       jsonb NOT NULL DEFAULT '[]',       -- ImageKit URL 문자열 배열, 최대 3
  status       text NOT NULL DEFAULT 'selling',   -- selling | reserved | sold
  neighborhood text NOT NULL,                     -- 등록 시점 판매자 동네 스냅샷
  view_count   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dg_favorites (
  user_id    int NOT NULL REFERENCES dg_users(id) ON DELETE CASCADE,
  product_id int NOT NULL REFERENCES dg_products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS dg_chat_rooms (
  id         serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES dg_products(id) ON DELETE CASCADE,
  buyer_id   int NOT NULL REFERENCES dg_users(id) ON DELETE CASCADE,
  seller_id  int NOT NULL REFERENCES dg_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, buyer_id)
);

CREATE TABLE IF NOT EXISTS dg_chat_messages (
  id         serial PRIMARY KEY,
  room_id    int NOT NULL REFERENCES dg_chat_rooms(id) ON DELETE CASCADE,
  sender_id  int NOT NULL REFERENCES dg_users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## 카테고리 (고정 8개, 프론트/서버 동일 상수)

`["디지털기기","가구/인테리어","생활가전","생활/주방","의류","도서","취미/게임","기타"]`

서버는 POST/PUT 시 이 목록에 없는 category를 400 처리.

## 응답 규약

- 성공: `200/201` + `{ "ok": true, ...데이터 }`
- 실패: `4xx/5xx` + `{ "ok": false, "error": "사람이 읽을 한국어 메시지" }`
- 인증: `Authorization: Bearer <JWT>`. JWT payload `{ id, email, nickname }`, 만료 7일.
- 인증 실패 401, 권한 없음(남의 것 수정/삭제) 403, 없음 404.
- user 객체는 절대 password_hash 포함 금지. shape: `{ id, email, nickname, neighborhood, created_at }`

## API 목록

### Auth
| 메서드 | 경로 | 인증 | 바디 | 응답 |
|---|---|---|---|---|
| POST | `/api/auth/signup` | - | `{email, password, nickname, neighborhood}` | `201 {ok, token, user}` (이메일 중복 409, password 6자 미만 400, 전부 필수 400) |
| POST | `/api/auth/login` | - | `{email, password}` | `{ok, token, user}` (불일치 401) |
| GET | `/api/auth/me` | ✅ | - | `{ok, user}` |

### 상품
| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/api/products?category=&q=` | - | 최신순 목록. `category` 정확일치 필터, `q`는 title+description ILIKE 검색. 응답 `{ok, products:[ProductCard]}` |
| GET | `/api/products/:id` | 선택 | 상세. **호출 시 view_count +1**. 응답 `{ok, product: ProductDetail}` |
| POST | `/api/products` | ✅ | `{title, price, description, category, images}` → `201 {ok, product}`. images는 0~3개 문자열 배열(IMAGEKIT_URL_ENDPOINT로 시작해야 함, 아니면 400). neighborhood는 작성자 동네 자동 스냅샷 |
| PUT | `/api/products/:id` | ✅ 본인 | 같은 바디(부분 아님, 전체 교체). 남의 것 403 |
| PATCH | `/api/products/:id/status` | ✅ 본인 | `{status}` ∈ selling/reserved/sold |
| DELETE | `/api/products/:id` | ✅ 본인 | `{ok}` |

**ProductCard** (목록용): `{ id, title, price, category, images, status, neighborhood, view_count, created_at, seller: {id, nickname}, favorite_count }`
**ProductDetail** = ProductCard + `{ description, seller: {id, nickname, neighborhood}, is_favorite }` (is_favorite는 토큰 있으면 계산, 없으면 false)

### 관심 (찜)
| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/products/:id/favorite` | ✅ | **토글**. 응답 `{ok, is_favorite, favorite_count}` |
| GET | `/api/me/favorites` | ✅ | 내가 찜한 상품 `{ok, products:[ProductCard]}` (찜한 순 최신) |

### 마이
| GET | `/api/me/products` | ✅ | 내가 등록한 상품 `{ok, products:[ProductCard]}` |

### 채팅 (폴링)
| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/products/:id/chat` | ✅ | 채팅방 get-or-create. **본인 상품이면 400** ("내 상품에는 채팅할 수 없어요"). 응답 `{ok, room: {id, product_id}}` |
| GET | `/api/chats` | ✅ | 내 채팅방 목록(구매자든 판매자든). 응답 `{ok, rooms:[Room]}` 최근 메시지순 |
| GET | `/api/chats/:roomId/messages?after=<msgId>` | ✅ 참여자만(403) | `after` 이후 메시지만(없으면 전체). 응답 `{ok, messages:[{id, room_id, sender_id, content, created_at}]}` id 오름차순 |
| POST | `/api/chats/:roomId/messages` | ✅ 참여자만 | `{content}` (빈문자 400) → `201 {ok, message}` |

**Room**: `{ id, product: {id, title, price, images, status}, other: {id, nickname}, last_message: {content, created_at} | null }`

### ImageKit
| GET | `/api/imagekit/auth` | ✅ | `{ok, token, expire, signature, publicKey, urlEndpoint}` — bean-shop 패턴 그대로: `token=crypto.randomUUID()`, `expire=now/1000+1800`, `signature=HMAC-SHA1(token+expire, PRIVATE_KEY) hex` |

프론트 업로드 (장당 서명 1회 새로 발급):
```js
const auth = await api('/api/imagekit/auth');            // 인증 필요
const fd = new FormData();
fd.append('file', file);
fd.append('fileName', file.name);
fd.append('publicKey', auth.publicKey);
fd.append('token', auth.token);
fd.append('expire', auth.expire);
fd.append('signature', auth.signature);
fd.append('folder', '/danggeun');
fd.append('useUniqueFileName', 'true');
const r = await fetch('https://upload.imagekit.io/api/v1/files/upload', { method:'POST', body: fd });
const j = await r.json();   // j.url ← 이걸 images 배열에 저장
```
썸네일 표시는 URL 변환: `url + '?tr=w-400,h-400,fo-auto'` (상세 슬라이드는 `tr=w-800`).
파일 제한: image/* 만, 장당 5MB 이하, 최대 3장.

## 프론트 페이지 (해시 라우팅)

| 경로 | 내용 |
|---|---|
| `/#/` | 홈: 상단(동네명+검색 아이콘→검색바 토글), 카테고리 칩 가로스크롤, 상품 리스트(당근처럼 좌 썸네일·우 정보 리스트형), 우하단 주황 FAB ✏️ 글쓰기 |
| `/#/login` `/#/signup` | 로그인/가입(가입에 닉네임+**동네 텍스트 입력**, placeholder 성수동) |
| `/#/product/:id` | 상세: 이미지 슬라이드(스와이프 대신 좌우 버튼+도트), 판매자(닉네임·동네), 상태뱃지, 제목/카테고리/시간/설명/조회수, 하단 고정바: ♡관심 토글 + 가격 + [채팅하기]. 본인 글이면 [채팅하기] 대신 상태변경 셀렉트 + 수정/삭제 버튼 |
| `/#/write`, `/#/edit/:id` | 등록/수정 폼: 사진 최대 3장(미리보기+삭제), 제목, 카테고리 칩 선택, 가격(0이면 "나눔" 표시), 설명 |
| `/#/chats` | 채팅 목록 (5초 폴링): 상대 닉네임, 상품 썸네일·제목, 마지막 메시지 |
| `/#/chat/:roomId` | 채팅방 (2.5초 폴링, `after` 커서로 증분): 상단 상품 요약바, 말풍선(내것 주황 우측/상대 회색 좌측+시각), 하단 입력바. 새 메시지 오면 하단 스크롤 |
| `/#/me` | 마이: 프로필 카드(닉네임·이메일·동네), 탭 3개 = 판매상품 / 관심목록 / 채팅. 로그아웃 버튼 |

- 로그인 필요 액션(글쓰기/관심/채팅/마이)을 비로그인 상태에서 누르면 `/#/login` 으로 (toast "로그인이 필요해요").
- 토큰은 localStorage key `dg_token`, 유저는 `dg_user`. 401 응답 받으면 자동 로그아웃 처리.
- 시간 표시: "방금 전 / n분 전 / n시간 전 / n일 전" 상대시간 헬퍼.
- 가격 표시: `12,000원`, 0이면 `나눔 🧡`.

## 디자인

- 모바일 앱 프레임: `max-w-[430px] mx-auto min-h-screen bg-white shadow` — 데스크톱에선 중앙 폰 프레임처럼.
- 당근 오렌지 `#FF6F0F` (프라이머리 버튼/FAB/활성탭/내 말풍선), 배경 white, 보조 gray-100~500.
- 하단 고정 탭바 3개: 🏠 홈 / 💬 채팅 / 👤 마이 (활성 주황). 상세/채팅방/폼 페이지에선 탭바 숨김.
- 상태뱃지: 예약중(초록), 거래완료(회색, 카드 썸네일 어둡게 + "거래완료" 오버레이).
- 폰트: 시스템 산세리프. 이모지 아이콘으로 충분(외부 아이콘 라이브러리 금지).

## 검증 (서버 에이전트가 끝나기 전에 직접 실행)

`node server.js` 띄우고 curl로: 회원가입 2명(판매자/구매자) → 로그인 → 상품 등록(이미지 없이) → 목록/검색/카테고리 필터 → 상세(view_count 증가) → 남의 상품 수정 403 → 관심 토글 2회 → 구매자가 채팅방 생성 → 메시지 왕복 → after 커서 증분 확인 → 본인 상품 채팅 400 확인. 전부 통과하면 종료 전에 서버 kill.
