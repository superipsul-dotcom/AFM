// 안도 드라이브 — 테슬라 목적지 전송 (PORT 3017)
//
// 현재 단계: ① 개발자 등록 게이트.
// 이 서버가 지금 하는 일은 두 가지뿐이다.
//   1. 테슬라가 도메인 소유권을 검증하려고 읽어가는 공개키를 호스팅한다.
//   2. OAuth 로그인을 태워서 refresh token을 받아온다.
// AI 레이어와 목적지 전송은 ②단계에서 실차 연동이 확인된 뒤에 붙인다.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3017;

// 한국(KR)은 테슬라 기준 Asia-Pacific이고, APAC은 NA 엔드포인트를 쓴다.
// 지역이 틀리면 API가 412로 거절한다.
const AUDIENCE = process.env.TESLA_AUDIENCE || 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const AUTH_BASE = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3';

const CLIENT_ID = process.env.TESLA_CLIENT_ID;
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;

// offline_access가 없으면 8시간마다 다시 로그인해야 한다. 개인 상시 사용 앱에서는 필수.
const SCOPES = 'openid offline_access user_data vehicle_device_data vehicle_location vehicle_cmds';

// PUBLIC_ORIGIN은 테슬라에 등록한 도메인과 정확히 일치해야 한다 (redirect_uri 대조 대상).
function publicOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}`;
}
const redirectUri = (req) => `${publicOrigin(req)}/auth/callback`;

// ── 공개키 호스팅 ────────────────────────────────────────────────────────────
// 이 경로 하나가 파트너 등록 전체의 관문이다. 테슬라 서버가 등록 시점에 직접
// 여기를 GET 해서 200 + 유효한 secp256r1 PEM이 나와야 도메인 검증을 통과시킨다.
const PUBLIC_KEY_PATH = path.join(__dirname, 'keys', 'com.tesla.3p.public-key.pem');

app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', (req, res) => {
  fs.readFile(PUBLIC_KEY_PATH, 'utf8', (err, pem) => {
    if (err) {
      console.error('[publickey] 공개키 파일을 읽지 못함:', err.message);
      return res.status(500).type('text/plain').send('public key unavailable');
    }
    res.type('text/plain').send(pem);
  });
});

// ── OAuth ───────────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('TESLA_CLIENT_ID 미설정 — .env를 확인하세요.');

  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie',
    `tesla_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`);

  const url = new URL(`${AUTH_BASE}/authorize`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'login');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) return res.status(400).send(page('테슬라가 인증을 거부했습니다', `${error}: ${errorDescription || ''}`));
  if (!code) return res.status(400).send(page('code가 없습니다', '인증 흐름이 중간에 끊겼습니다.'));

  const cookieState = /tesla_oauth_state=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  if (!cookieState || cookieState !== state) {
    return res.status(400).send(page('state 불일치', 'CSRF 방어에 걸렸습니다. /auth/login 부터 다시 시작하세요.'));
  }

  try {
    const r = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        audience: AUDIENCE,
        redirect_uri: redirectUri(req),
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).send(page('토큰 교환 실패', `HTTP ${r.status}\n${JSON.stringify(data, null, 2)}`));
    }
    // refresh token은 화면에 한 번만 보여주고 서버에 남기지 않는다.
    // 이 단계의 목표는 "토큰을 받을 수 있다"는 증명이지 영속화가 아니다.
    // 사용자가 .env(TESLA_REFRESH_TOKEN)에 붙여넣으면 ②단계에서 그걸로 실차를 때린다.
    return res.send(page('✅ 인증 성공',
      `아래 refresh token을 .env의 TESLA_REFRESH_TOKEN 에 붙여넣으세요.\n` +
      `이 화면을 닫으면 다시 볼 수 없습니다 (재발급하려면 /auth/login 부터 다시).\n\n` +
      `${data.refresh_token}\n\n` +
      `--- 참고 ---\ntoken_type: ${data.token_type}\nexpires_in: ${data.expires_in}초\n`));
  } catch (e) {
    return res.status(500).send(page('토큰 교환 중 예외', e.stack || String(e)));
  }
});

// ── 상태 확인 ────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stage: '① 개발자 등록 게이트',
    publicOrigin: publicOrigin(req),
    redirectUri: redirectUri(req),
    audience: AUDIENCE,
    publicKeyHosted: fs.existsSync(PUBLIC_KEY_PATH),
    clientIdSet: Boolean(CLIENT_ID),
    clientSecretSet: Boolean(CLIENT_SECRET),
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:ui-monospace,Menlo,monospace;background:#111;color:#eee;padding:2rem;line-height:1.6">
<h1 style="font-size:1.2rem">${title}</h1><pre style="white-space:pre-wrap;word-break:break-all;background:#1c1c1c;padding:1rem;border-radius:8px;border:1px solid #333">${body}</pre></body>`;
}

// Vercel(서버리스)에서는 listen하지 않고 핸들러만 내보낸다.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`안도 드라이브 → http://localhost:${PORT}`);
    console.log(`공개키       → http://localhost:${PORT}/.well-known/appspecific/com.tesla.3p.public-key.pem`);
  });
}
module.exports = app;
