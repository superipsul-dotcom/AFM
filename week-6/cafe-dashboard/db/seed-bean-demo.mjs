// ========================================
// 🫘 안도 빈즈(bean-shop) 테이블 + 데모 데이터 시드
// - bean_users / bean_orders 테이블 생성 (bean-shop 서버와 동일 스키마)
// - 비어 있을 때만 데모 회원 8명 + 주문 14건 삽입 (멱등)
//   → 대시보드 "주문 내역 / 멤버" 페이지의 초기 데이터
//   → 이후 bean-shop(Supabase 전환본)에서 발생하는 실제 가입/주문이 그대로 합류
// 실행: node db/seed-bean-demo.mjs
// ========================================

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const pool = new pg.Pool({ connectionString: (process.env.DATABASE_URL || '').trim(), ssl: { rejectUnauthorized: false }, max: 3 });

const DDL = `
create table if not exists bean_users (
  id             uuid primary key,
  email          text unique not null,
  password_hash  text not null,
  avatar_url     text,
  avatar_file_id text,
  created_at     timestamptz not null default now()
);
create table if not exists bean_orders (
  order_id    text primary key,
  user_id     uuid not null,
  order_name  text not null,
  amount      bigint not null,
  items       jsonb not null,
  status      text not null default 'PENDING',
  payment     jsonb,
  payment_key text,
  created_at  timestamptz not null default now()
);`;

// bean-shop index.html 상품 카탈로그와 동일한 이름/가격
const P = {
  예가체프: ['에티오피아 예가체프 코체레', 19000],
  구지: ['에티오피아 시다모 구지', 21000],
  수프리모: ['콜롬비아 우일라 수프리모', 16000],
  케냐: ['케냐 AA 니에리', 23000],
  안티구아: ['과테말라 안티구아', 18000],
  세하도: ['브라질 세하도', 13000],
  게이샤: ['파나마 게이샤 에스메랄다', 45000],
  따라주: ['코스타리카 따라주', 19000],
};

// 데모 회원 8명 (가입일 분산, 오픈 이후)  [email, daysAgo]
const MEMBERS = [
  ['minji.kim@demo-ando.kr', 24], ['junho.park@demo-ando.kr', 21],
  ['sohee.lee@demo-ando.kr', 18], ['dawon.choi@demo-ando.kr', 15],
  ['hyunwoo.jung@demo-ando.kr', 11], ['yerin.kang@demo-ando.kr', 8],
  ['taemin.oh@demo-ando.kr', 5], ['seula.yoon@demo-ando.kr', 2],
];

// 데모 주문 14건 [memberIdx, daysAgo, status, [ [상품키, 분쇄, 수량] ...]]
const ORDERS = [
  [0, 23, 'PAID', [['예가체프', '홀빈', 1]]],
  [1, 20, 'PAID', [['세하도', '핸드드립', 2]]],
  [0, 17, 'PAID', [['게이샤', '홀빈', 1]]],
  [2, 16, 'PAID', [['수프리모', '에스프레소', 1], ['세하도', '홀빈', 1]]],
  [3, 14, 'PAID', [['케냐', '핸드드립', 1]]],
  [1, 12, 'PAID', [['예가체프', '홀빈', 1], ['구지', '홀빈', 1]]],
  [4, 10, 'PAID', [['안티구아', '에스프레소', 2]]],
  [2, 9, 'PAID', [['따라주', '핸드드립', 1]]],
  [5, 7, 'PAID', [['구지', '홀빈', 2]]],
  [3, 5, 'PAID', [['예가체프', '핸드드립', 1], ['세하도', '핸드드립', 1]]],
  [6, 4, 'PAID', [['케냐', '홀빈', 1], ['따라주', '홀빈', 1]]],
  [7, 2, 'PAID', [['게이샤', '홀빈', 1], ['예가체프', '홀빈', 1]]],
  [4, 1, 'PENDING', [['수프리모', '에스프레소', 1]]],
  [6, 0, 'PENDING', [['안티구아', '홀빈', 1]]],
];

const daysAgoIso = (d, hour = 14) => new Date(Date.now() - d * 86400000 - (14 - hour) * 0).toISOString();

async function main() {
  const c = await pool.connect();
  try {
    await c.query(DDL);
    const { rows: [{ n }] } = await c.query('select count(*)::int n from bean_users');
    if (n > 0) {
      console.log(`이미 bean_users ${n}명 존재 — 시드 생략 (멱등)`);
      return;
    }

    console.log('🫘 데모 회원 8명 삽입…');
    const hash = bcrypt.hashSync('ando-demo-2026', 10); // 데모 계정 공통 비번 (원두샵 로그인 가능)
    const ids = [];
    for (const [email, daysAgo] of MEMBERS) {
      const id = crypto.randomUUID();
      ids.push(id);
      await c.query(
        'insert into bean_users (id, email, password_hash, created_at) values ($1,$2,$3,$4)',
        [id, email, hash, daysAgoIso(daysAgo)],
      );
    }

    console.log('🧾 데모 주문 14건 삽입…');
    for (const [mi, daysAgo, status, lines] of ORDERS) {
      const items = lines.map(([key, grind, qty]) => ({
        id: null, name: P[key][0], grind, qty, price: P[key][1],
      }));
      const amount = items.reduce((a, it) => a + it.price * it.qty, 0);
      const orderName = items.length > 1 ? `${items[0].name} 외 ${items.length - 1}건` : items[0].name;
      const created = daysAgoIso(daysAgo);
      const payment = status === 'PAID'
        ? { method: '카드', totalAmount: amount, approvedAt: created, receiptUrl: null, orderName }
        : null;
      await c.query(
        `insert into bean_orders (order_id, user_id, order_name, amount, items, status, payment, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        ['ando_demo_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
         ids[mi], orderName, amount, JSON.stringify(items), status,
         payment ? JSON.stringify(payment) : null, created],
      );
    }

    const { rows: [sum] } = await c.query(
      `select count(*)::int orders, sum(amount) filter (where status='PAID')::bigint paid from bean_orders`);
    console.log(`\n===== 완료: 회원 ${MEMBERS.length}명 · 주문 ${sum.orders}건 · PAID 매출 ${Number(sum.paid).toLocaleString()}원 =====`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
