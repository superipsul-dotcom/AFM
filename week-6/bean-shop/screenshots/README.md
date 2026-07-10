# 안도 빈즈 — Playwright 검증 스크린샷 (2026-07-07)

프론트(index.html) ↔ 인증 서버(server.js, PORT 3014) 연동 후 전 기능 e2e 검증 캡처.
서버 API 스모크 15항목(상태코드·봉투계약·보안) 별도 전부 통과.

| 파일 | 검증 내용 |
|---|---|
| `01-home.png` | 홈 전체 — fal.ai 실사 12종 카드 + 히어로, 헤더 [로그인] 버튼 |
| `02-product-detail.png` | 상세(#/product/7) — 분쇄도 '에스프레소' 선택 + 수량 2 담기 |
| `03-cart-guest-locked.png` | 비로그인 장바구니 — 🔒 로그인 후 주문 안내, 무료배송/합계 계산 |
| `04-order-gate-login-modal.png` | 비로그인 주문하기 클릭 → 로그인 모달 자동 오픈 (주문 게이트) |
| `05-signup-form.png` | 회원가입 탭 — 이메일/비밀번호/확인 입력 상태 |
| `06-logged-in-header.png` | 가입 즉시 로그인 — 헤더 👤 owner@cafeando.kr + [로그아웃] |
| `07-order-complete.png` | 로그인 상태 주문 완료 모달 — 계정 표시 포함 |
| `08-login-wrong-password.png` | 오답 로그인 → 서버 401 메시지("이메일 또는 비밀번호가...") 표시 |
| `09-session-restored-after-reload.png` | 새로고침 후 JWT로 세션 자동 복원(/api/auth/me) |
| `10-filter-africa.png` | 산지 필터 '아프리카' → 4종만 노출 + 필터 초기화 링크 |
| `11-search-jasmine.png` | '자스민' 검색 → 컵노트 매칭 2종(예가체프·게이샤) |
| `12-mobile-home.png` | 모바일(390px) 반응형 — 컴팩트 헤더 + 1열 그리드 |

## 토스페이먼츠 결제 연동 검증 (v2 위젯, 테스트 상점)

| 파일 | 검증 내용 |
|---|---|
| `13-checkout-toss-widget.png` | `#/checkout` — 실제 토스 위젯 렌더(결제수단 6종 + 약관), 주문요약과 결제금액 일치 |
| `14-toss-payment-window.png` | 결제하기 → 토스 결제창 오버레이(서버 생성 주문명 "…외 1건" 표시, 샌드박스 테스트 번호 프리필) |
| `15-toss-sandbox-password.png` | 퀵계좌이체 샌드박스 — 테스트 비밀번호(000000) 키패드 단계 |
| `16-payment-success-confirmed.png` | successUrl 복귀 → **서버 confirm 승인** — 주문명/64,000원/계좌이체/승인시각/주문번호 + 영수증 버튼. URL search 자동 정리(재confirm 방지) |
| `17-payment-fail.png` | failUrl — 오류코드/메시지 표시(PAY_PROCESS_CANCELED) + 장바구니 보존 |

- 실승인 확인: `POST /api/payments/confirm` → order.status **PAID**, approvedAt 2026-07-07T22:23:57+09:00, 영수증 URL HTTP 200. 멱등 재호출 200.
- 해시 라우팅 successUrl 함정(파라미터가 hash 앞 `location.search`에 붙음)은 `parseHashQuery()` 병합 파서로 해결.

## ImageKit 프로필 사진 검증

| 파일 | 검증 내용 |
|---|---|
| `18-profile-modal.png` | 헤더 아바타 칩 클릭 → 프로필 모달(이니셜 폴백 아바타 "B", 사진 변경/닫기) |
| `19-avatar-uploaded.png` | 파일 선택 → 서버 서명 → **ImageKit 직접 업로드** → 아바타 저장 — 모달·헤더 즉시 반영 |
| `20-avatar-persisted-after-reload.png` | 새로고침 후 세션 복원 → `/me`의 avatarUrl로 헤더 아바타 유지 |

- 흐름: `GET /api/imagekit/auth`(로그인 필요, HMAC-SHA1 서명 발급 — private key는 서버 전용) → 브라우저가 `upload.imagekit.io`로 직접 업로드(`/bean-shop/avatars/`) → `PUT /api/auth/avatar`(우리 ImageKit URL만 허용). 표시 시 `?tr=w-160,h-160,fo-auto` 변환.
- 서버 스모크: 무토큰 401 · 서명 필드 5종 · **curl 실업로드 200** · 외부 URL 거부 400 · /me에 avatarUrl 포함 — 전부 통과.
- 잡은 버그: 헤더의 `backdrop-blur`(backdrop-filter)가 fixed containing block을 만들어 헤더 안에 렌더한 모달이 잘리는 문제 → 모달을 header 밖으로 이동.

실행: `npm start` → http://localhost:3014 (인메모리 저장이라 서버 재시작 시 계정/주문 초기화)
