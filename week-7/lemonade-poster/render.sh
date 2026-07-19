#!/bin/zsh
# 포스터 HTML → PNG (1080×1350 + @2x)
# gotcha: headless=new가 스크린샷을 쓰고도 안 죽음 → 파일 감지 후 직접 kill (cafe-menu-board 패턴)
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
    "file://$PWD/poster.html?v=$TS-$scale" 2>/dev/null &
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

render 1 out/poster.png
render 2 "out/poster@2x.png"
ls -la out/
