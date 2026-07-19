# The Row — 브랜드 분석

> 인스타그램 광고 카드 제작을 위한 톤앤매너 분석.
> 분석일 2026-07-19 · 출처: therow.com/ko-kr 실측(HTML/CSS/캠페인 이미지) + 브랜드 리서치

## 1. 브랜드 개요

- 2006년 Mary-Kate & Ashley Olsen이 뉴욕에서 설립. 이름은 런던 새빌 로우(Savile Row)에서.
- **"콰이어트 럭셔리"의 정점** — 로고를 밖으로 드러내지 않고 소재·재단·실루엣으로만 말하는 브랜드.
- 마케팅 언어가 거의 없음. 공식 슬로건 없음(무언(無言) 자체가 브랜드 보이스).
- 인스타그램 피드도 캡션이 `Summer 2026`, 제품명 한 줄이 전부. 감탄사·이모지·느낌표 전무.

## 2. 실측 데이터 (therow.com/ko-kr)

### 타이포그래피
| 요소 | 실측 값 | 카드에 쓸 대체 폰트(로컬) |
|---|---|---|
| 웹폰트 | **Basic Commercial** (Akzidenz-Grotesk 계열 그로테스크 산세리프, theme.css `@font-face` 4종: Roman/Bold/Italic/BoldItalic) | Helvetica Neue Light |
| 워드마크 | 얇은 산세리프 대문자 + 초광폭 자간 `T H E   R O W` (세리프 아님 — og:image 로고로 확인) | Helvetica Neue Light + letter-spacing 0.55em |
| 한글(ko-kr UI) | 시스템 산세리프 | Apple SD Gothic Neo Light |

### 컬러 (사이트 CSS 변수 + HTML 빈도 실측)
| 역할 | HEX | 근거 |
|---|---|---|
| 잉크(텍스트/버튼) | `#1C1B1B` | `--button-background-rgb: 28,27,27` |
| 보조 텍스트 | `#6A6A6A` | `--text-color-light-rgb: 106,106,106` |
| 경계선/라이트 그레이 | `#D8D7D5` | HTML 빈도 상위 |
| 배경 | `#FFFFFF` | `--light-background-rgb` |
| (예외 액센트) 세일가 레드 | `#F94C43` | `--product-sale-price-color-rgb` — 광고 카드에는 미사용 |

### Summer 2026 캠페인 사진 (히어로 이미지 실측)
- 웜 오프화이트 **심리스 스튜디오** (벽·바닥 ≈ `#EDEAE4`~`#E4E1DA`)
- **중앙의 단일 피사체**, 화면의 70% 이상이 여백
- 카멜 실크 코트(≈ `#B49B72`) + 블랙 팬츠/클러치 — 뉴트럴 3색 이내
- 부드러운 확산광, 옅은 자연 그림자, 미세한 필름 그레인
- 이미지 위 텍스트/로고 오버레이 **없음**

### 보이스 (ko-kr 네비게이션/카피)
- `여성 · 남성 · 핸드백 · 홈 · 컬렉션 · 갤러리 · 매장` — 짧고 건조한 명사형 라벨
- 뉴스레터 문구도 `뉴스레터 구독` 네 글자가 전부

## 3. 카드 제작 규칙 (위 분석의 적용)

| 항목 | 규칙 |
|---|---|
| 팔레트 | 메인 2색: Ivory `#EDEAE4` + Ink `#1C1B1B` / 보조 1색: Camel `#A98E64` |
| 타이포 | 워드마크·카피 = Helvetica Neue Light(≈Basic Commercial), 한글 = Apple SD Gothic Neo Light |
| 카피 | 절제된 평서문, 3~7단어. 메인: **"Luxury, spoken softly."** (3단어) |
| CTA | 채운 버튼 금지 → 헤어라인 보더 박스 or 하이픈 구분 텍스트만 (`컬렉션 보기 · THEROW.COM`) |
| 비주얼 | 캠페인과 동일 문법 — 웜 오프화이트 스튜디오, 단일 피사체, 여백 70%+, 필름 그레인, 이미지 안 텍스트 금지 |
| 레이아웃 | 여백을 주인공으로. 텍스트는 상/하단 가장자리에 소형으로만 |
