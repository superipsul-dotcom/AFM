#!/bin/bash
# src/*.html → 1080×1080 PNG 렌더 (헤드리스 Chrome)
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TS=$(date +%s) # Chromium 메모리캐시 우회용 캐시버스트

render() { # $1=src html  $2=out png  $3=WxH
  "$CHROME" --headless=new --screenshot="$2" --window-size="$3" \
    --force-device-scale-factor=1 --hide-scrollbars \
    --default-background-color=FFFFFFFF \
    "file://$PWD/src/$1?v=$TS" 2>/dev/null
  printf '%s ' "$(sips -g pixelWidth -g pixelHeight "$2" | awk '/pixel/{print $2}' | paste -sd x -)"
  echo "← $2"
}

render main.html       cards/main.png       1080,1080
render carousel-1.html cards/carousel-1.png 1080,1080
render carousel-2.html cards/carousel-2.png 1080,1080
render carousel-3.html cards/carousel-3.png 1080,1080
# 카드 4장이 먼저 있어야 프리뷰 렌더 가능
render feed-preview.html preview/feed-preview.png 1440,1000
