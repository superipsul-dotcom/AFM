#!/bin/zsh
# 메뉴판 HTML → PNG (1080×1350 + @2x 2160×2700)
# gotcha 1: Chromium이 HTML을 메모리캐시하므로 cachebust 쿼리 + 새 프로필 필수
# gotcha 2: headless=new가 스크린샷을 쓰고도 프로세스가 안 죽음(zombie)
#           → 파일이 생기면 2초 여유 후 직접 kill (2026-07-19 실측)
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TS=$(date +%s)
mkdir -p out

render() {
  local scale=$1 out=$2
  local profile=$(mktemp -d)
  rm -f "$out"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --no-first-run --no-default-browser-check --disable-extensions \
    --user-data-dir="$profile" \
    --window-size=1080,1350 --force-device-scale-factor=$scale \
    --virtual-time-budget=20000 --timeout=30000 \
    --screenshot="$out" \
    "file://$PWD/menu.html?v=$TS-$scale" 2>/dev/null &
  local pid=$!
  local i=0
  while [ $i -lt 60 ]; do
    if [ -s "$out" ]; then sleep 2; break; fi
    sleep 1; i=$((i+1))
  done
  kill $pid 2>/dev/null || true
  wait $pid 2>/dev/null || true
  rm -rf "$profile"
  if [ -s "$out" ]; then echo "rendered $out"; else echo "FAILED $out"; exit 1; fi
}

render 1 out/menu-board.png
render 2 "out/menu-board@2x.png"
ls -la out/
