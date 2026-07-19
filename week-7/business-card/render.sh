#!/bin/bash
# 홍평화 명함 렌더 — PNG(300dpi급) + PDF(벡터 90×54 / 재단여백 94×58)
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="file://$PWD/index.html"
CB=$(date +%s)   # Chromium file:// 메모리캐시 → cachebust 필수
mkdir -p out

# headless=new가 가끔 좀비로 남는 문제 → 출력파일 감지 후 해당 PID만 kill (pkill 광역 금지)
run_chrome() { # out_file, chrome args...
  local out_file="$1"; shift
  rm -f "$out_file"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars "$@" >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    [ -s "$out_file" ] && sleep 1 && break
    sleep 0.5
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [ -s "$out_file" ] || { echo "FAIL: $out_file"; exit 1; }
  echo "OK: $out_file"
}

# PNG (1000×600 디자인 × dsf2 = 2000×1200)
run_chrome out/front.png --window-size=1000,600 --force-device-scale-factor=2 --screenshot=out/front.png "$URL?side=front&cb=$CB"
run_chrome out/back.png  --window-size=1000,600 --force-device-scale-factor=2 --screenshot=out/back.png  "$URL?side=back&cb=$CB"

# 흑백 출력 시뮬레이션
run_chrome out/front-bw.png --window-size=1000,600 --force-device-scale-factor=2 --screenshot=out/front-bw.png "$URL?side=front&bw=1&cb=$CB"
run_chrome out/back-bw.png  --window-size=1000,600 --force-device-scale-factor=2 --screenshot=out/back-bw.png  "$URL?side=back&bw=1&cb=$CB"

# 단톡방 공유용 (앞+뒤 한 장)
run_chrome out/share.png --window-size=2140,700 --force-device-scale-factor=2 --screenshot=out/share.png "$URL?side=share&cb=$CB"

# PDF — 벡터 (인쇄용). 면당 1페이지로 뽑아 PDFKit 병합(트레일링 빈 페이지 방지)
run_chrome out/_f.pdf  --no-pdf-header-footer --print-to-pdf=out/_f.pdf  "$URL?mode=print&side=front&cb=$CB"
run_chrome out/_b.pdf  --no-pdf-header-footer --print-to-pdf=out/_b.pdf  "$URL?mode=print&side=back&cb=$CB"
run_chrome out/_fb.pdf --no-pdf-header-footer --print-to-pdf=out/_fb.pdf "$URL?mode=print-bleed&side=front&cb=$CB"
run_chrome out/_bb.pdf --no-pdf-header-footer --print-to-pdf=out/_bb.pdf "$URL?mode=print-bleed&side=back&cb=$CB"
swift merge-pdf.swift out/card.pdf out/_f.pdf out/_b.pdf
swift merge-pdf.swift out/card-print-bleed.pdf out/_fb.pdf out/_bb.pdf
rm -f out/_f.pdf out/_b.pdf out/_fb.pdf out/_bb.pdf

echo "done."
