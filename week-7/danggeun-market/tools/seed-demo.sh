#!/bin/zsh
set -e
B=http://localhost:3018
IMG=/private/tmp/claude-501/-Users-pyounghwahong-AFM-week-7/ca754868-b005-46ae-a5a0-bb6b7ab29208/scratchpad/demo-imgs
py() { /usr/bin/python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)"; }

# 1) 데모 계정 2개 (있으면 로그인 폴백)
ST=$(curl -s $B/api/auth/signup -H 'Content-Type: application/json' -d '{"email":"ando@ando.market","password":"demo1234","nickname":"안도","neighborhood":"성수동"}' | py ".get('token','')" )
[ -z "$ST" ] && ST=$(curl -s $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"ando@ando.market","password":"demo1234"}' | py "['token']")
BT=$(curl -s $B/api/auth/signup -H 'Content-Type: application/json' -d '{"email":"podo@ando.market","password":"demo1234","nickname":"포도","neighborhood":"성수동"}' | py ".get('token','')" )
[ -z "$BT" ] && BT=$(curl -s $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"podo@ando.market","password":"demo1234"}' | py "['token']")
echo "seller-token: ${ST:0:20}... / buyer-token: ${BT:0:20}..."

# 2) ImageKit 업로드 (장당 서명 새로)
upload() {
  local f=$1
  local A=$(curl -s $B/api/imagekit/auth -H "Authorization: Bearer $ST")
  local TK=$(echo $A | py "['token']"); local EX=$(echo $A | py "['expire']"); local SG=$(echo $A | py "['signature']"); local PK=$(echo $A | py "['publicKey']")
  curl -s https://upload.imagekit.io/api/v1/files/upload \
    -F "file=@$IMG/$f" -F "fileName=$f" -F "publicKey=$PK" -F "token=$TK" -F "expire=$EX" -F "signature=$SG" \
    -F "folder=/danggeun" -F "useUniqueFileName=true" | py "['url']"
}
U_CHAIR=$(upload chair.png);  echo "chair  → $U_CHAIR"
U_IPAD=$(upload ipad.png);   echo "ipad   → $U_IPAD"
U_COFFEE=$(upload coffeemachine.png); echo "coffee → $U_COFFEE"
U_LAMP=$(upload lamp.png);   echo "lamp   → $U_LAMP"

# 3) 상품 4건 (판매자=안도)
mk() { curl -s $B/api/products -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d "$1" | py "['product']['id']"; }
P1=$(mk "{\"title\":\"미드센추리 원목 의자\",\"price\":45000,\"category\":\"가구/인테리어\",\"images\":[\"$U_CHAIR\"],\"description\":\"티크 프레임 미드센추리 체어입니다. 쿠션 상태 깨끗하고 흔들림 없어요.\\n이사하면서 내놓습니다. 성수역 근처 직거래 선호합니다.\"}")
P2=$(mk "{\"title\":\"태블릿 10.9인치 (박스 풀셋)\",\"price\":320000,\"category\":\"디지털기기\",\"images\":[\"$U_IPAD\"],\"description\":\"작년에 구입한 태블릿입니다. 생활기스 거의 없고 배터리 성능 좋습니다.\\n박스/케이블 풀구성. 네고 사절이요!\"}")
P3=$(mk "{\"title\":\"캡슐 커피머신\",\"price\":55000,\"category\":\"생활가전\",\"images\":[\"$U_COFFEE\"],\"description\":\"반년 사용한 캡슐 머신이에요. 세척 완료, 정상 작동합니다.\\n캡슐 몇 개 남은 것도 같이 드려요 ☕\"}")
P4=$(mk "{\"title\":\"패브릭 플로어 스탠드 (나눔)\",\"price\":0,\"category\":\"가구/인테리어\",\"images\":[\"$U_LAMP\"],\"description\":\"은은한 무드등으로 쓰던 스탠드예요. 전구 포함!\\n필요하신 분 가져가세요. 나눔입니다 🧡\"}")
echo "products: $P1 $P2 $P3 $P4"

# 4) 구매자(포도) 관심 2건
curl -s -X POST $B/api/products/$P1/favorite -H "Authorization: Bearer $BT" | py "['is_favorite']"
curl -s -X POST $B/api/products/$P4/favorite -H "Authorization: Bearer $BT" | py "['is_favorite']"

# 5) 채팅: 포도 → 의자 문의, 왕복 3건
ROOM=$(curl -s -X POST $B/api/products/$P1/chat -H "Authorization: Bearer $BT" | py "['room']['id']")
curl -s $B/api/chats/$ROOM/messages -H "Authorization: Bearer $BT" -H 'Content-Type: application/json' -d '{"content":"안녕하세요! 의자 아직 판매 중인가요?"}' -o /dev/null
curl -s $B/api/chats/$ROOM/messages -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"content":"네 판매 중이에요! 성수역 2번 출구 쪽에서 직거래 가능합니다 🙂"}' -o /dev/null
curl -s $B/api/chats/$ROOM/messages -H "Authorization: Bearer $BT" -H 'Content-Type: application/json' -d '{"content":"좋아요, 내일 저녁 7시쯤 괜찮으세요?"}' -o /dev/null
echo "room: $ROOM (메시지 3건)"

# 6) 의자 → 예약중
curl -s -X PATCH $B/api/products/$P1/status -H "Authorization: Bearer $ST" -H 'Content-Type: application/json' -d '{"status":"reserved"}' | py "['product']['status']"

echo "=== 최종 목록 ==="
curl -s "$B/api/products" | /usr/bin/python3 -c "import sys,json;[print(p['id'],p['status'],p['title'],p['price'],'img:'+str(len(p['images'])),'♥'+str(p['favorite_count'])) for p in json.load(sys.stdin)['products']]"
