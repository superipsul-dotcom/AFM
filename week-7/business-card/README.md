# 나의 명함 — 홍평화 · 안도공간

> **나를 한 단어로 정의하면 "결"** — 나무의 결을 다듬는 목수이자, **공간의 결을 설계하는 디자이너**.
> 인테리어 디자이너(설계)와 원목을 다루는 목수(결)라는 두 정체성을 '결' 하나로 꿰었다.
> 앞면 "공간의 결을 설계하는 디자이너" → 뒷면 "점, 선, 면, 그리고 결."로 이어진다.

| | |
|---|---|
| 사이즈 | 90 × 54 mm (표준 명함) |
| 폰트 | Pretendard 1종 (400 / 600 / 700) — OFL 라이선스 |
| 컬러 | 블랙 `#111` + 화이트 + 포인트 앰버 `#F6A800` 1점 |
| 레퍼런스 | Braun / Dieter Rams — "Less, but better" |
| 강조 1개 | 앞면 히어로 **"디자이너"** (크기 + 앰버 도트 마침표) |

## 디자인 의도

- **Braun ET66 계산기의 앰버 원형 버튼**을 마침표(●)로 인용 — 카드 전체에서 유일한 컬러.
- 뒷면 슬로건 **"점, 선, 면, 그리고 결."** — 조형의 기본(점·선·면)에 목수의 **나뭇결(결)** 을 더한 문장. (안도공간 DLP = Dot Line Plane 철학과 연결)
- 정보는 5개로 압축: 이름 · 직함(안도공간 대표) · 전화 · 이메일 · 웹(QR).
- 흑백 출력 시에도 도트가 미드 그레이로 살아있고 QR 판독 정상 (`out/*-bw.png`로 검증).

## 파일

```
out/front.png, back.png        공유용 (2000×1200, 300dpi급)
out/share.png                  단톡방용 앞+뒤 한 장
out/front-bw.png, back-bw.png  흑백 출력 시뮬레이션
out/card.pdf                   인쇄용 벡터 PDF 2p (정확히 90×54mm)
out/card-print-bleed.pdf       인쇄소 접수용 재단여백 +2mm (94×58mm)
```

## 재생성

```bash
./render.sh   # headless Chrome → PNG + 벡터 PDF (면당 1p 렌더 후 PDFKit 병합)
```

- QR: `npx qrcode -t svg -e M -q 0 -o assets/qr.svg "https://www.andospace.com"` (macOS Vision으로 판독 검증됨)
- gotcha: Chrome `--print-to-pdf`는 페이지 크기 서브픽셀 반올림으로 **트레일링 빈 페이지**가 생길 수 있음 → 면당 1페이지로 뽑아 `merge-pdf.swift`(PDFKit)로 병합해 해결.
