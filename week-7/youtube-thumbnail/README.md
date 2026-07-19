# 유튜브 썸네일 만들기 — 디자인 엔지니어 채널

좋아하는 유튜버 **[디자인 엔지니어](https://www.youtube.com/@design-engineer)** 의 영상
**[어제 나온 클로드 '페이블 5'한테 쿠팡 쇼핑 시켰더니, 진짜 결제까지 해버렸습니다](https://www.youtube.com/watch?v=zQkA30Z8tvc)** 썸네일을 1920×1080으로 직접 디자인.

> 이 영상을 고른 이유: 리포 루트의 `coupang-*.png`, `earphone-*.json`이 바로 이 영상을 따라한 흔적 —
> 그리고 지금 이 썸네일을 만드는 것도 클로드 페이블 5. 완벽한 수미상관.

## 결과물 (A/B 두 버전, 보너스 포함)

| | A안 — 다크 시네마틱 (원본 오마주) | B안 — 옐로 팝 (컷아웃 스티커) |
|---|---|---|
| 1920×1080 | `out/thumb-a.png` | `out/thumb-b.png` |
| 300×170 | `out/preview-300x170-a.png` | `out/preview-300x170-b.png` |
| 카피 | 쿠팡 **결제** AI가 해버렸다 | 진짜 **결제**까지 해버림;; |
| 강조색 | 오렌지 `#ef6a1a` (결제 박스) | 레드 `#e5202e` + 옐로 `#ffd400` 배경 |
| 폰트 | Pretendard Black (900) | Black Han Sans + Pretendard |

비교 시트: `out/compare.png` · **내 픽은 B안** — 300×170 축소에서 발색과 얼굴 크기가 압도적이라 피드에서 먼저 눈에 걸림. A안은 채널 기존 톤과 일관성이 강점 (실제 채널이라면 A가 브랜딩에 안전).

## 체크리스트 (미션 요구사항)

- [x] 1920×1080 (16:9) 고정 — 헤드리스 Chrome `--window-size=1920,1080` 렌더
- [x] 주제가 한눈에 들어오는 굵직한 카피 — 168~190px 초대형 2줄
- [x] 강조색: 핵심 키워드 "결제" 1개에만 적용 (A 오렌지 박스 / B 레드)
- [x] 인물 배경 제거 후 합성 — macOS Vision `VNGenerateForegroundInstanceMaskRequest`
- [x] 300×170 미리보기 가독성 확인 — 두 버전 모두 카피 판독 가능
- [x] 보너스: A/B 두 버전 + 비교 시트

## 제작 파이프라인

```
1. 채널 영상 목록 수집   curl → ytInitialData JSON 파싱 (신형 lockupViewModel 구조)
2. 인물 이미지 생성       generate-assets.mjs
   ├─ 1차: fal.ai flux/dev        → 403 "Exhausted balance" 실패
   └─ 폴백: OpenAI gpt-image-1    → assets/person-raw.png (1024×1536)
3. 배경 제거             remove-bg.swift (Vision 프레임워크, 로컬·무료)
   → assets/person-cutout.png     ※ gpt-image-1 background:transparent는
                                     프롬프트에 배경 묘사가 있으면 무시됨
4. 조판                  thumb-a.html / thumb-b.html (HTML+CSS 1920×1080 캔버스)
5. 렌더                  render-one.sh <a|b> → out/*.png + 300×170 프리뷰(sips)
```

### 배운 것 / gotcha

- **fal.ai 폴백 체인**: 키가 있어도 잔액 소진이면 403 `User is locked` — 폴백 경로를 코드에 내장해두길 잘함
- **gpt-image-1 투명 배경**: `background: "transparent"`여도 프롬프트가 배경을 묘사하면 배경을 그려버림 → 컷아웃은 로컬 Vision이 확실 (사진앱 '배경 제거'와 동일 엔진, 머리카락 경계도 깔끔)
- **Chrome `--headless=new` 행**: 스크린샷 파일을 쓰고도 프로세스가 종료되지 않는 경우 있음 → `render-one.sh`는 파일 생성 감지 후 해당 PID만 kill (다른 세션의 Chrome을 건드리지 않도록 `pkill` 금지)
- **컷아웃 이미지의 절단면**: 가슴까지만 있는 컷아웃은 이미지 좌우 경계가 직선으로 드러남 → 다크 배경(A)에선 안 보이지만 밝은 배경(B)에선 스탬프·원형 버스트 같은 요소로 이음새를 덮는 구도가 필요
- **애플 🎧 이모지**: 104px로 키우면 실사 헤드폰 렌더링이라 제품 목업 이미지 대용으로 충분

### 주의

- `assets/person-*.png`는 AI 생성 가상 인물 (실제 유튜버 얼굴 아님 — 초상권 이슈 방지)
- 실제 영상 썸네일(레퍼런스)은 저작권 문제로 커밋하지 않음 — [영상 링크](https://www.youtube.com/watch?v=zQkA30Z8tvc)에서 확인
