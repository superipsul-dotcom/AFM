// ============================================================
// 서버 e2e 테스트 — node test-server.mjs
// server.js 를 자식 프로세스로 띄우고(/api/health 대기) 전 구간 검증 후 종료.
// 매 실행 고유 이메일로 가입 → 생성 데이터는 마지막에 삭제(estimate). 사용자 행은 잔류(무해).
// ============================================================
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const PORT = 3015;
const BASE = `http://localhost:${PORT}`;


let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`); }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* HTML 응답 등 */ }
  return { status: res.status, json };
}

// ---------- 서버 기동 ----------
console.log('서버 기동 중…');
const server = spawn(process.execPath, ['server.js'], {
  cwd: dirname(fileURLToPath(import.meta.url)), // 폴더명에 한글·공백 → URL.pathname 인코딩 이슈 회피
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.env.DEBUG_SERVER && process.stdout.write('[srv] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[srv:err] ' + d));

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const r = await fetch(BASE + '/api/health');
    if (r.ok) { const j = await r.json(); if (j?.data?.db === 'up') { up = true; break; }
      if (i > 20 && j?.data) { up = true; break; } // db down 이어도 진단 위해 진행
    }
  } catch { /* 아직 */ }
}
if (!up) {
  console.error('서버가 20초 내에 뜨지 않았습니다.');
  server.kill('SIGTERM');
  process.exit(1);
}

const uniq = Date.now();
const EMAIL = `roof-test-${uniq}@test.andospace.com`;
const EMAIL2 = `roof-test2-${uniq}@test.andospace.com`;
const PW = 'roofpass123!';
let token = '', token2 = '', estId = '';

try {
  // ---------- 헬스/정적 ----------
  console.log('\n[헬스체크 · 정적 서빙]');
  {
    const h = await api('GET', '/api/health');
    check('GET /api/health 200 + db up', h.status === 200 && h.json?.data?.db === 'up', JSON.stringify(h.json?.data));
    const idx = await fetch(BASE + '/');
    const html = await idx.text();
    check('GET / → index.html 서빙', idx.status === 200 && html.includes('calc-engine'));
    const env = await fetch(BASE + '/.env');
    check('GET /.env 차단 (404)', env.status === 404, `status=${env.status}`);
  }

  // ---------- 인증 ----------
  console.log('\n[인증]');
  {
    const weak = await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: 'short', name: '테스터' } });
    check('가입: 비밀번호 8자 미만 → 400', weak.status === 400);

    const s1 = await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: PW, name: '홍평화' } });
    check('가입 성공 (V4: 초대코드 불필요) → 201 + token + user.name', s1.status === 201 && !!s1.json?.data?.token && s1.json?.data?.user?.name === '홍평화');
    token = s1.json?.data?.token || '';

    const dup = await api('POST', '/api/auth/signup', { body: { email: EMAIL, password: PW, name: '중복' } });
    check('가입: 중복 이메일 → 409', dup.status === 409);

    const wrong = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: 'wrongpass123' } });
    check('로그인: 비밀번호 오류 → 401', wrong.status === 401);

    const login = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PW } });
    check('로그인 성공 → 200 + token', login.status === 200 && !!login.json?.data?.token);
    token = login.json?.data?.token || token;

    const noAuth = await api('GET', '/api/auth/me');
    check('GET /me 토큰 없음 → 401', noAuth.status === 401);
    const me = await api('GET', '/api/auth/me', { token });
    check('GET /me → 내 정보', me.status === 200 && me.json?.data?.user?.email === EMAIL);

    const s2 = await api('POST', '/api/auth/signup', { body: { email: EMAIL2, password: PW, name: '김직원' } });
    token2 = s2.json?.data?.token || '';
    check('두 번째 직원 가입', s2.status === 201 && !!token2);
  }

  // ---------- 견적 CRUD (팀 공유 + 작성자/메모) ----------
  console.log('\n[견적 CRUD]');
  {
    const noAuth = await api('GET', '/api/estimates');
    check('목록: 토큰 없음 → 401', noAuth.status === 401);

    const noData = await api('POST', '/api/estimates', { token, body: { title: 'x' } });
    check('생성: data 누락 → 400', noData.status === 400);

    const data = { info: { title: 'e2e 테스트 견적', address: '평택 동삭동' }, zones: [], sel: {}, v: 2 };
    const meta = { grandTotal: 30133213.8756, floorSum: 180, address: '평택 동삭동' };
    const created = await api('POST', '/api/estimates', { token, body: { title: 'e2e 테스트 견적', memo: '테스트 특이사항', data, meta } });
    check('생성 → 201 + creatorName=홍평화', created.status === 201 && created.json?.data?.estimate?.creatorName === '홍평화');
    check('생성 → memo 저장', created.json?.data?.estimate?.memo === '테스트 특이사항');
    estId = created.json?.data?.estimate?.id || '';

    const list = await api('GET', '/api/estimates', { token: token2 });
    const found = (list.json?.data?.estimates || []).find((e) => e.id === estId);
    check('목록(다른 직원 토큰) → 팀 공유 조회', list.status === 200 && !!found);
    check('목록 항목에 meta.grandTotal 포함', Math.round(found?.meta?.grandTotal || 0) === 30133214);

    const one = await api('GET', `/api/estimates/${estId}`, { token });
    check('단건 → data 포함', one.status === 200 && one.json?.data?.estimate?.data?.info?.title === 'e2e 테스트 견적');

    const memoUpd = await api('PUT', `/api/estimates/${estId}`, { token: token2, body: { memo: '2층 크랙 보수 협의 필요' } });
    check('메모 수정(타 직원) → 200 + updaterName=김직원', memoUpd.status === 200 && memoUpd.json?.data?.estimate?.updaterName === '김직원');
    check('메모 수정 반영', memoUpd.json?.data?.estimate?.memo === '2층 크랙 보수 협의 필요');

    const notFound = await api('GET', '/api/estimates/00000000-0000-0000-0000-000000000000', { token });
    check('없는 id → 404', notFound.status === 404);
    const badId = await api('GET', '/api/estimates/not-a-uuid', { token });
    check('잘못된 id 형식 → 404', badId.status === 404);
  }

  // ---------- 단가 오버라이드 ----------
  console.log('\n[자재 단가 DB]');
  {
    const empty = await api('GET', '/api/prices', { token });
    check('GET /api/prices → overrides 객체', empty.status === 200 && typeof empty.json?.data?.overrides === 'object');

    const put = await api('PUT', '/api/prices', { token, body: { overrides: { items: { x150: { mat: 16000 } }, equip: { '지게차': 90000 } } } });
    check('PUT /api/prices → 저장', put.status === 200);

    const got = await api('GET', '/api/prices', { token: token2 });
    check('오버라이드 팀 공유 조회 (x150.mat=16000)', got.json?.data?.overrides?.items?.x150?.mat === 16000);
    check('updatedByName 기록', got.json?.data?.updatedByName === '홍평화');

    const reset = await api('PUT', '/api/prices', { token, body: { overrides: {} } });
    check('오버라이드 초기화(빈 객체 저장)', reset.status === 200);

    const badPut = await api('PUT', '/api/prices', { token, body: { overrides: 'nope' } });
    check('PUT 잘못된 overrides → 400', badPut.status === 400);
  }

  // ---------- 정리 ----------
  console.log('\n[정리]');
  {
    const del = await api('DELETE', `/api/estimates/${estId}`, { token });
    check('삭제 → 200', del.status === 200);
    const gone = await api('GET', `/api/estimates/${estId}`, { token });
    check('삭제 후 조회 → 404', gone.status === 404);
    const api404 = await api('GET', '/api/nope', { token });
    check('없는 API → 404 JSON', api404.status === 404 && api404.json?.success === false);
  }
} finally {
  server.kill('SIGTERM');
}

console.log(`\n결과: ${passed} 통과 / ${failed} 실패 (총 ${passed + failed})`);
if (failed === 0) console.log('\x1b[32m✓ 서버 e2e 전체 통과\x1b[0m');
process.exit(failed === 0 ? 0 : 1);
