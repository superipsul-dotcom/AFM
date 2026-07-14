// 파트너 등록 스크립트 — ①단계의 결승선.
//
// 하는 일:
//   1. 공개키가 실제로 공개 URL에서 읽히는지 먼저 확인한다 (테슬라가 여기서 막히면 원인이 안 보인다)
//   2. client_credentials로 파트너 토큰을 받는다
//   3. POST /api/1/partner_accounts 로 도메인을 등록한다 → 테슬라가 우리 공개키를 fetch해서 검증
//
// 실행: node register.mjs
import 'dotenv/config';

const AUDIENCE = process.env.TESLA_AUDIENCE || 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const AUTH_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const CLIENT_ID = process.env.TESLA_CLIENT_ID;
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const DOMAIN = (process.env.PUBLIC_ORIGIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

// 파트너 토큰의 scope는 앱이 developer.tesla.com에서 승인받은 범위 안이어야 한다.
const SCOPES = 'openid vehicle_device_data vehicle_location vehicle_cmds';

const fail = (msg) => { console.error(`\n❌ ${msg}\n`); process.exit(1); };

if (!CLIENT_ID || !CLIENT_SECRET) fail('TESLA_CLIENT_ID / TESLA_CLIENT_SECRET 미설정 — .env를 확인하세요.');
if (!DOMAIN) fail('PUBLIC_ORIGIN 미설정 — 예: PUBLIC_ORIGIN=https://afm-tesla-nav.vercel.app');

console.log(`도메인   : ${DOMAIN}`);
console.log(`audience : ${AUDIENCE}  ${AUDIENCE.includes('.na.') ? '(한국=APAC→NA. 지역 틀리면 412)' : '⚠️ 한국이면 NA여야 합니다'}`);

// ── 1. 공개키가 밖에서 보이는가 ──────────────────────────────────────────────
const keyUrl = `https://${DOMAIN}/.well-known/appspecific/com.tesla.3p.public-key.pem`;
console.log(`\n[1/3] 공개키 공개 확인 → ${keyUrl}`);
{
  const r = await fetch(keyUrl).catch((e) => fail(`공개키 URL에 접근 불가: ${e.message}`));
  const body = await r.text();
  if (!r.ok) fail(`공개키 URL이 HTTP ${r.status} — 배포부터 확인하세요.\n${body.slice(0, 300)}`);
  if (!body.includes('BEGIN PUBLIC KEY')) fail(`PEM이 아닌 응답이 왔습니다:\n${body.slice(0, 300)}`);
  console.log('      ✅ 공개키 정상 노출');
}

// ── 2. 파트너 토큰 ──────────────────────────────────────────────────────────
console.log('\n[2/3] 파트너 토큰 발급 (client_credentials)');
let partnerToken;
{
  const r = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: SCOPES,
      audience: AUDIENCE,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) fail(`파트너 토큰 실패 (HTTP ${r.status})\n${JSON.stringify(data, null, 2)}`);
  partnerToken = data.access_token;
  console.log(`      ✅ 발급됨 (${data.expires_in}초 유효)`);
}

// ── 3. 도메인 등록 ──────────────────────────────────────────────────────────
console.log(`\n[3/3] 파트너 계정 등록 → POST ${AUDIENCE}/api/1/partner_accounts`);
{
  const r = await fetch(`${AUDIENCE}/api/1/partner_accounts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${partnerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: DOMAIN }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`\n❌ 등록 실패 (HTTP ${r.status})\n${text}\n`);
    if (DOMAIN.endsWith('.vercel.app')) {
      console.error('👉 vercel.app 루트 도메인은 Vercel 소유라 거절됐을 가능성이 높습니다.');
      console.error('   andospace.com 서브도메인(예: tesla.andospace.com)으로 전환하세요.');
      console.error('   developer.tesla.com의 allowed_origins도 함께 바꿔야 합니다.');
    }
    process.exit(1);
  }
  console.log(`      ✅ 등록 성공\n${text}`);
}

console.log('\n🎉 ①단계 통과 — 이제 /auth/login 으로 로그인해서 refresh token을 받으세요.\n');
