#!/bin/zsh
set -a; source /Users/pyounghwahong/AFM/week-6/cafe-dashboard/.env; set +a
cd /private/tmp/claude-501/-Users-pyounghwahong-AFM-week-7/ca754868-b005-46ae-a5a0-bb6b7ab29208/scratchpad/demo-imgs
gen() {
  local name=$1 prompt=$2
  curl -s https://api.openai.com/v1/images/generations \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"gpt-image-1\",\"prompt\":$prompt,\"size\":\"1024x1024\",\"quality\":\"medium\",\"n\":1}" \
    | /usr/bin/python3 -c "import sys,json,base64;d=json.load(sys.stdin);open('$name.png','wb').write(base64.b64decode(d['data'][0]['b64_json'])) if 'data' in d else print('ERR $name:',d.get('error',{}).get('message'))"
  echo "done: $name"
}
gen chair '"Casual amateur smartphone photo for a secondhand marketplace listing: a mid-century modern wooden chair with teak frame and beige fabric cushion, standing in a Korean apartment living room, natural window light, slightly off-center framing, realistic, no people, no text"' &
gen ipad '"Casual amateur smartphone photo for a secondhand marketplace listing: a used silver tablet computer lying on a wooden desk next to its box, Korean apartment, warm indoor lighting, realistic, slight shadow, no people, no visible logos, no text"' &
gen coffeemachine '"Casual amateur smartphone photo for a secondhand marketplace listing: a compact white capsule coffee machine on a kitchen counter in a Korean apartment, natural light from window, realistic, no people, no visible brand logos, no text"' &
gen lamp '"Casual amateur smartphone photo for a secondhand marketplace listing: a minimalist fabric floor lamp with warm light turned on, in the corner of a cozy Korean apartment at dusk, realistic, no people, no text"' &
wait
ls -la
