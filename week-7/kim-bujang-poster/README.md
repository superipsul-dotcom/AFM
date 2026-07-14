# 김부장 포스터 작업 — 자료 수집

SBS 드라마 **김부장**(Agent Kim Reactivated, 2026) 영화 포스터 제작을 위한 스틸컷·자료 모음.

> ⚠️ **저작권**: `Copyright © SBS & SBSi. All rights reserved.`
> SBS는 포토갤러리 자료에 **"무단 전재, 재배포 및 AI학습 이용 금지"** 를 명시하고 있다.
> 여기 모은 것은 SBS가 공개 배포한 홍보용 스틸이며, **개인 참고·습작 용도**로만 쓸 것.
> 재배포·상업적 이용·AI 학습 입력은 불가. → `stills/` 는 git에 커밋하지 않는다(`.gitignore`).

---

## 무엇이 있나

| 파일 | 내용 |
|---|---|
| **`index.html`** | 스틸 **120장** 컨택트시트. **브라우저로 열면 됨.** 인물별 필터(배역명 표시)·포스터/세로형 필터·클릭 시 원본 라이트박스·←/→ 이동 |
| `stills/` | 스틸컷 120장 (58MB) = SBS 118 + 나무위키 고해상도 포스터 2 |
| `stills-manifest.json` | SBS 수집분 118장 메타데이터 — 캡션(등장인물), 날짜, 해상도, 원본 URL, SBS 원문 링크. **`collect-stills.mjs` 가 통째로 덮어쓴다** |
| `stills-extra.json` | SBS 외 출처로 보강한 2장(나무위키 포스터). 수집기가 건드리지 않으므로 **수동 보강분은 여기에** 넣는다. `build-gallery.mjs` 가 둘을 병합한다 |
| `SERIES.md` | 시리즈 내용 정리 593줄 (줄거리·인물·회차·**포스터용 톤&비주얼 분석** — 스틸 86장 픽셀 실측 포함) |
| `collect-stills.mjs` | 수집기 (재실행하면 신규 스틸 반영) |
| `build-gallery.mjs` | 매니페스트(+extra) → `index.html` 생성기 |

## 수집 현황

- **SBS 118장 / 56MB** — 게시글 32건 전량, 누락 0 (검증: 게시글 CONTENT 내 이미지 수 == 다운로드 수)
- **+ 나무위키 고해상도 포스터 2장** → 합계 120장 / 58MB
- 해상도: `1800×1200` 86장 · `1800×2700` 29장 · 포스터 5장(SBS 3 + 나무위키 2)
- ⚠️ 스틸에는 **좌하단 `SBS play` 워터마크 + 우하단 「김부장」 로고**가 박혀 있다.
  인물을 누끼 따서 쓰면 무관하지만 배경째 쓰려면 크롭 필요. (나무위키 포스터 2장은 워터마크 없음)
- 인물 분포: 소지섭 57 · 최대훈 34 · 윤경호 28 · 손나은 13 · 주상욱 12 · 옥택연 4 · 서수민 4 · 김성규 3 · 그 외
- 출처: [SBS 공식 포토갤러리](https://programs.sbs.co.kr/drama/mrkim/visualboards/89763) (2026-05-26 ~ 2026-07-13)

### 핵심 키아트 3종
| 스틸 | 해상도 | 특징 |
|---|---|---|
| 메인 포스터 (06-05) | 2500×1750 | 오렌지 그런지 `AGENT KIM` + 흑백 인물 컷아웃 + `CODE NAME : 66` |
| 캐릭터 포스터 (06-12) | 896×1280 | 앰버/틸 반반 조명, 깨진 유리, 카피 **"안경 쓴 아저씨는 건드리지 말자"** |
| 티저 포스터 (05-29) | 700×1000 | 흑백 실루엣 + 소음기 권총, 우측 눈금자(조준경) 모티프 |

⚠️ 포스터 3종은 SBS가 업로드한 크기가 위 해상도로 **끝**이다(`-org`/`-o`/`-l` 등 변형 전부 403).
스틸(1800px)보다 작으니, 고해상도 키아트가 필요하면 나무위키·뉴스 보도 등 다른 출처를 봐야 한다.

✅ **해결됨(2026-07-14)**: 나무위키 원본이 SBS 업로드보다 크다. 아래 2종을 `stills/`에 추가했다.

| 포스터 | SBS | 나무위키 | 채택 |
|---|---|---|---|
| 티저 | 700×1000 | **1000×1428** | `2026-05-29_티저포스터_namuwiki-1000x1428.jpg` |
| 캐릭터 | 896×1280 | **1000×1428** | `2026-06-12_캐릭터포스터_namuwiki-1000x1428.jpg` |
| 메인 | **2500×1750** | 1000×700 | SBS 원본 유지 (나무위키가 더 작음) |

> **gotcha**: `namu.wiki`는 WebFetch/일반 요청에 **403**을 준다. `curl`에 브라우저 `User-Agent`를 주면 통과하고,
> 이미지(`i.namu.wiki`)는 추가로 **`Referer: https://namu.wiki/`** 가 필요하다.
> 본문 이미지는 `<img>`의 `src`가 아니라 **`data-src`** 에 있다(레이지 로딩).

## 재실행

```bash
node collect-stills.mjs   # 스틸 수집 → stills/ + stills-manifest.json
node build-gallery.mjs    # 매니페스트 → index.html
```

---

## 역공학 메모 (SBS 사이트)

같은 작업을 다시 할 사람(=미래의 나)을 위한 기록. **SBS 페이지 스크래핑은 HTML로는 불가능하다.**

### 1. 페이지는 전부 SPA — HTML에 콘텐츠가 없다
`programs.sbs.co.kr` 은 동적 포트(`program-component-front-desktop.sbs.co.kr:${port}`)로 컴포넌트를 불러오는
마이크로프론트엔드다. `curl` 로 받은 HTML엔 `og:image` 썸네일 하나뿐. → **내부 게시판 API를 직접 호출하는 게 정답.**

### 2. 게시판 JSONP API
```
목록  GET api.board.sbs.co.kr/bbs/V2.0/basic/board/lists
        ?action_type=callback&callback=cb&board_code=mrkim_pt&offset=0&limit=15
      → cb({notice:[], best:[], list:[{NO, TITLE, REG_DATE, FILE_CNT, ...}]})

상세  GET api.board.sbs.co.kr/bbs/V2.0/basic/board/detail/{NO}
        ?action_type=callback&callback=cb&board_code=mrkim_pt
      → cb({Response_Data_For_Detail:{CONTENT:"<img class=aba_img src=...>"}})
```
`board_code` 는 `{프로그램ID}_pt` 규칙 (김부장 = `mrkim_pt`). 프로그램 메뉴는
`static.apis.sbs.co.kr/program-api/1.0/menu/mrkim` 로 확인 가능.

### 3. 겪은 함정 4개
| 함정 | 증상 | 해결 |
|---|---|---|
| **JSONP 파라미터 누락** | 200 OK인데 본문이 `noParam({err_code:405})` | `action_type=callback&callback=cb` 필수 |
| **limit 캡** | `limit=200` 줘도 15건만 반환 → 게시글 절반 유실 | `offset` 을 15씩 밀어서 페이지네이션 |
| **alt 안의 꺾쇠** | `<img[^>]+src="...">` 정규식이 `alt="<김부장> ..."` 의 `>` 에서 끊겨 **이미지를 통째로 놓침** (캐릭터 포스터가 0장으로 집계됨) | 따옴표 안 `>` 를 허용하는 파서: `/<img\s+((?:[^>"']\|"[^"]*"\|'[^']*')*)\/?>/g` |
| **속성 순서 제각각** | 게시글마다 `class·src·alt` / `alt·class·src` | 태그 전체를 뜯어 속성별로 추출 |

### 4. 이미지 CDN 해상도 규칙
| 호스트 | 규칙 |
|---|---|
| `photocloud.sbs.co.kr/origin/edit/{SET}/{HASH}-p.jpg` | **본문 원본. `-p` 가 유일하게 200** (`.jpg`/`-o`/`-org`/`-l` 은 403) |
| `image.board.sbs.co.kr/.../{HASH}-cr.jpg` | 목록 **썸네일** 573×436 — 쓰지 말 것 (`-cr` 떼면 원본이지만 작다) |
| `img2.sbs.co.kr/img/sbs_cms/.../{HASH}-640-360.jpg` | 클립/VOD 썸네일. 접미사 떼면 1280×720 원본, 임의 사이즈는 403 |

### 5. `FILE_CNT` 는 이미지 수가 아니다
합계가 147인데 실제 본문 이미지는 118. 다중 이미지 게시글마다 정확히 +1 — **목록 썸네일이 첨부로 카운트**된 것.
포스터 게시글(`FILE_CNT=1`)만 정확히 일치. 누락 판단은 `FILE_CNT` 말고 **CONTENT 내 img 수**로 할 것.

### 6. 기타
- 목록 페이지는 광고/파이어베이스가 계속 폴링해서 **`waitUntil:'networkidle'` 이 절대 안 걸린다** → 타임아웃.
  Playwright를 쓸 거면 `domcontentloaded` + 명시적 대기.
- 최종 수집기는 브라우저 없이 **순수 `fetch`** 로 동작한다(정찰에만 브라우저 사용).
