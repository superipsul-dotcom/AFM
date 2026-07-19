#!/bin/zsh
# 한 장 렌더: Chrome --headless=new가 스크린샷 후 종료 안 하는 행 대응 —
# 파일이 생기고 크기가 안정되면 해당 Chrome만 직접 kill
# 사용: ./render-one.sh <a|b>
set -u
cd "$(dirname "$0")"
V="$1"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TS=$(date +%s)
OUT="out/thumb-$V.png"
rm -f "$OUT"
PROFILE=$(mktemp -d)

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --no-first-run --no-default-browser-check --disable-extensions \
  --user-data-dir="$PROFILE" \
  --window-size=1920,1080 --force-device-scale-factor=1 \
  --virtual-time-budget=15000 \
  --screenshot="$OUT" \
  "file://$PWD/thumb-$V.html?v=$TS" 2>/dev/null &
CPID=$!

for i in {1..60}; do
  [ -f "$OUT" ] && break
  sleep 1
done
sleep 3  # 파일 flush 여유
kill "$CPID" 2>/dev/null
wait "$CPID" 2>/dev/null
rm -rf "$PROFILE"

if [ -f "$OUT" ]; then
  cp "$OUT" "out/preview-300x170-$V.png"
  sips -z 170 300 "out/preview-300x170-$V.png" >/dev/null
  echo "OK $OUT ($(stat -f%z "$OUT") bytes) + preview"
else
  echo "FAIL $OUT not produced"; exit 1
fi
