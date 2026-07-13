// ========================================
// ☕ 카페 안도 운영 데이터 시드 (db/seed.mjs)
//
// my_cafe.md 와 "정합성 있는" 임의 데이터를 생성해 Supabase에 넣는다.
//   - 기간: 2026-06-07(오픈일, 일) ~ 2026-07-12(어제, 일), 월요일 휴무
//   - 메뉴/가격/한정수량(무화과 20·소금빵 30)/객단가 수준 = my_cafe.md 메뉴판 그대로
//   - 스토리: 흑임자 크림라떼가 매출 1위로 성장 / 화요일이 가장 한산 /
//             6월말 장마(비) 손님 감소 / 7월초 폭염에 자몽에이드 급증 /
//             주말 무화과 바스크 완판 반복 / 흑임자 페이스트 재고 위기
//   - 시드 고정 PRNG → 재실행해도 같은 데이터 (drop 후 재생성이라 멱등)
//
// 실행: npm run seed   (또는 node db/seed.mjs)
// ========================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

pg.types.setTypeParser(1082, (v) => v); // DATE → 'YYYY-MM-DD' 문자열 그대로

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) { console.error('❌ .env 에 DATABASE_URL 이 없습니다.'); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

// ---------- 시드 고정 PRNG (mulberry32) ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260607); // 오픈일이 시드

// ---------- 달력 유틸 (UTC 고정 — 타임존 밀림 방지) ----------
const OPEN = Date.UTC(2026, 5, 7);   // 2026-06-07 (일) 오픈
const LAST = Date.UTC(2026, 6, 12);  // 2026-07-12 (일) 어제까지
const DAY = 86400000;
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---------- 메뉴판 (my_cafe.md §4 그대로) ----------
const MENU = {
  아메리카노: { cat: '커피', price: 4500 },
  카페라떼: { cat: '커피', price: 5500 },
  '흑임자 크림라떼': { cat: '시그니처', price: 6500 },
  '쑥 라떼': { cat: '논커피', price: 6000 },
  '수제 자몽에이드': { cat: '논커피', price: 6500 },
  '무화과 바스크 치즈케이크': { cat: '시그니처', price: 7000 },
  소금빵: { cat: '디저트', price: 3800 },
};

// ---------- 날씨: 6/25~7/2 장마(비) · 7/7~ 폭염 ----------
function weatherOf(dateStr) {
  if (dateStr >= '2026-06-25' && dateStr <= '2026-07-02') {
    return dateStr === '2026-06-28' ? '흐림' : '비';
  }
  if (dateStr >= '2026-07-07') return '폭염';
  return rnd() < 0.7 ? '맑음' : '흐림';
}

// ---------- 음료 수량 배분 (largest remainder) ----------
function allocate(total, shares) {
  const sum = Object.values(shares).reduce((a, b) => a + b, 0);
  const exact = Object.entries(shares).map(([k, v]) => [k, (total * v) / sum]);
  const base = exact.map(([k, v]) => [k, Math.floor(v), v - Math.floor(v)]);
  let left = total - base.reduce((a, [, q]) => a + q, 0);
  base.sort((a, b) => b[2] - a[2]);
  for (let i = 0; i < base.length && left > 0; i++, left--) base[i][1]++;
  return Object.fromEntries(base.map(([k, q]) => [k, q]));
}

// ---------- 일별 데이터 생성 ----------
function buildDays() {
  const days = [];
  for (let ms = OPEN; ms <= LAST; ms += DAY) {
    const date = fmt(ms);
    const dow = new Date(ms).getUTCDay(); // 0=일 .. 6=토
    if (dow === 1) continue; // 월요일 휴무

    const week = Math.floor((ms - OPEN) / DAY / 7); // 0~5 (오픈 n주차-1)
    const weather = weatherOf(date);
    const isWeekend = dow === 0 || dow === 6;
    const heat = weather === '폭염';
    const rain = weather === '비';

    // 손님 수: 요일 기본값 × 주차 성장 × 날씨 × 노이즈
    const baseByDow = { 0: 25, 2: 13, 3: 15, 4: 16, 5: 18, 6: 27 };
    let mult = (0.78 + 0.055 * week) * (0.92 + rnd() * 0.16);
    if (rain) mult *= 0.82;
    if (heat) mult *= 1.02;
    let note = null;
    if (date === '2026-06-07') { mult *= 1.35; note = '오픈일 — 지인·안도공간 고객 초대'; }
    const customers = Math.max(6, Math.round(baseByDow[dow] * mult));

    // 음료: 손님 1인당 1.05잔
    const drinks = Math.round(customers * 1.05);
    const shares = {
      아메리카노: 0.30, 카페라떼: 0.17,
      '흑임자 크림라떼': 0.22 + 0.012 * week, // 입소문으로 점유율 상승 → 매출 1위로
      '쑥 라떼': 0.08,
      '수제 자몽에이드': heat ? 0.20 : 0.10,  // 폭염에 급증
    };
    if (heat) { shares.아메리카노 -= 0.04; shares.카페라떼 -= 0.02; }
    if (rain) { shares['쑥 라떼'] += 0.03; shares['수제 자몽에이드'] = Math.max(0.04, shares['수제 자몽에이드'] - 0.03); }
    const qty = allocate(drinks, shares);

    // 디저트: 소금빵(일 30개 한정) · 무화과 바스크(주말 20개 한정)
    qty.소금빵 = Math.min(30, Math.round(customers * ((isWeekend ? 0.70 : 0.62) + rnd() * 0.13)));
    if (isWeekend) qty['무화과 바스크 치즈케이크'] = Math.min(20, Math.round(customers * (0.58 + rnd() * 0.14)));

    const soldout = [];
    if (qty['무화과 바스크 치즈케이크'] === 20) soldout.push('무화과 바스크 완판');
    if (qty.소금빵 === 30) soldout.push('소금빵 완판');
    if (soldout.length) note = note ? `${note} · ${soldout.join(' · ')}` : soldout.join(' · ');

    const rows = Object.entries(qty)
      .filter(([, q]) => q > 0)
      .map(([menu, q]) => ({ date, menu, category: MENU[menu].cat, qty: q, unit_price: MENU[menu].price, amount: q * MENU[menu].price }));
    const revenue = rows.reduce((a, r) => a + r.amount, 0);

    days.push({ date, customers, revenue, weather, note, rows });
  }
  return days;
}

// ---------- 손님 리뷰 22건 (my_cafe.md §7 불만 키워드와 일치) ----------
const REVIEWS = [
  ['2026-06-08', '네이버', 5, '오픈 첫날 방문. 2층 계단 올라가면 딴 세상이 나옵니다. 조용하고 인테리어가 미쳤어요.', '긍정'],
  ['2026-06-10', '네이버', 4, '흑임자 크림라떼 고소하고 안 달아서 좋아요. 근데 입구 찾는 데 5분 헤맸어요. 간판이 안 보여요.', '중립'],
  ['2026-06-12', '인스타', 5, '샘플월 만져볼 수 있는 카페는 처음. 커피 마시다가 우리집 마루 자재 상담까지 하고 왔어요.', '긍정'],
  ['2026-06-14', '네이버', 5, '무화과 바스크 인생 케이크. 주말에만 판다니 너무 아쉬워요. 평일에도 팔아주세요.', '긍정'],
  ['2026-06-16', '네이버', 3, '커피는 좋은데 메뉴가 너무 적어요. 디카페인도 없고 선택지가 부족합니다.', '불만'],
  ['2026-06-18', '방명록', 5, '노트북 작업 3시간 하고 갑니다. 눈치 안 보여서 좋았어요. 콘센트 자리가 좀 더 있으면 완벽.', '긍정'],
  ['2026-06-20', '네이버', 4, '조용해서 미팅하기 좋아요. 다만 결제가 좀 느려서 뒤에 줄이 생겼어요.', '중립'],
  ['2026-06-21', '네이버', 5, '치즈케이크 품절ㅠㅠ 3시에 갔는데 없었어요. 그래도 흑임자 크림라떼가 다 위로해줌.', '긍정'],
  ['2026-06-23', '인스타', 5, '성수에서 제일 조용한 카페. 창가 바 자리에서 릴스 찍어갑니다.', '긍정'],
  ['2026-06-26', '네이버', 4, '비 오는 날 창가 자리가 최고예요. 쑥 라떼는 할머니 생각나는 맛(칭찬입니다).', '긍정'],
  ['2026-06-27', '네이버', 3, '간판이 없어서 그냥 지나쳤다가 지도 다시 보고 찾았어요. 1층에 입구 안내 좀 해주세요.', '불만'],
  ['2026-06-28', '방명록', 5, '의자에 붙은 QR로 조명 견적 받아봤어요. 카페가 쇼룸이라니 신기한 경험.', '긍정'],
  ['2026-07-01', '네이버', 4, '장마철에 뽀송한 2층 아지트. 근데 결제할 때 오래 걸리는 건 여전하네요.', '중립'],
  ['2026-07-03', '인스타', 4, '디저트가 소금빵이랑 케이크뿐이라 아쉬워요. 흑임자 디저트 나오면 무조건 갑니다.', '중립'],
  ['2026-07-04', '네이버', 5, '무화과 바스크 오픈런 성공! 20개 한정이라 11시엔 가야 해요.', '긍정'],
  ['2026-07-05', '네이버', 5, '회의 되는 카페 찾다가 정착했습니다. 조용하고 와이파이 빵빵.', '긍정'],
  ['2026-07-08', '네이버', 4, '폭염에 자몽에이드 미쳤다. 근데 2층까지 올라오면 땀범벅이라 입구에 안내판+선풍기라도 있으면.', '중립'],
  ['2026-07-09', '인스타', 5, '쇼룸 겸 카페 컨셉 천재적. 커피도 진심이라 더 좋다. 팔로우함.', '긍정'],
  ['2026-07-10', '네이버', 3, '아이스 메뉴가 부족해요. 폭염엔 빙수나 아포가토 같은 게 있었으면.', '불만'],
  ['2026-07-11', '네이버', 5, '토요일 오후에도 조용해요. 메종 드 성수 웨이팅하다 포기하고 왔는데 여기가 훨씬 낫네요.', '긍정'],
  ['2026-07-11', '방명록', 4, '케이크 또 품절… 평일에도 팔아주세요 사장님. 두 번 헛걸음했어요.', '중립'],
  ['2026-07-12', '인스타', 5, '흑임자 크림라떼 = 성수 최고 시그니처. 인정할 수밖에 없음.', '긍정'],
];

// ---------- 재고 스냅샷 (오늘 2026-07-13 월 휴무 아침 기준) ----------
const INVENTORY = [
  // item, unit, stock, daily_usage, reorder_point, lead_time, supplier, last_ordered, note
  ['블렌드 원두', 'kg', 4.2, 1.1, 3.0, 2, '로우스터리 서울', '2026-07-08', null],
  ['싱글오리진 원두(에티오피아)', 'kg', 1.6, 0.3, 1.0, 3, '로우스터리 서울', '2026-07-01', '아메리카노 +500원 옵션용'],
  ['우유', 'L', 9, 7.5, 15, 1, '서울우유 성수대리점', '2026-07-12', '매일 아침 배송. 주말 사용량 +40%'],
  ['흑임자 페이스트', 'kg', 1.7, 0.9, 2.5, 4, '흑향 흑임자농원(국산)', '2026-06-30', '대표 메뉴(흑임자 크림라떼) 원료 — 대체 불가'],
  ['크림치즈', 'kg', 5.5, 1.3, 4.0, 2, '배민상회', '2026-07-06', '주말 바스크 치즈케이크에 집중 사용'],
  ['생무화과', 'kg', 0.4, 3.2, 4.0, 3, '성수 청과', '2026-07-09', '주말 한정 케이크용. 신선재고라 이월 불가 — 매주 목요일까지 발주'],
  ['쑥가루', 'kg', 2.1, 0.25, 1.0, 5, '강화도 농협', '2026-06-20', null],
  ['수제 자몽청', 'kg', 2.6, 1.9, 5.0, 3, '직접 담금(자몽 사입)', '2026-07-05', '폭염 이후 사용량 2배 ↑. 담근 뒤 숙성 2일 필요'],
  ['16oz 테이크아웃 컵', '개', 180, 26, 150, 2, '쿠팡 비즈', '2026-07-04', null],
  ['시더우드 디퓨저 오일', '병', 1, 0.03, 0.5, 7, '안도공간 자재몰', '2026-06-07', '시그니처 향 — 떨어지면 공간 정체성 타격'],
];

// ---------- 실행 ----------
async function main() {
  const client = await pool.connect();
  try {
    console.log('🏗  스키마 생성 (drop & create)…');
    await client.query(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));

    const days = buildDays();

    console.log(`📅 일별 매출 ${days.length}일 삽입…`);
    for (const d of days) {
      await client.query(
        'insert into cafe_daily_sales (date, customers, revenue, weather, note) values ($1,$2,$3,$4,$5)',
        [d.date, d.customers, d.revenue, d.weather, d.note],
      );
      for (const r of d.rows) {
        await client.query(
          'insert into cafe_menu_sales (date, menu, category, qty, unit_price, amount) values ($1,$2,$3,$4,$5,$6)',
          [r.date, r.menu, r.category, r.qty, r.unit_price, r.amount],
        );
      }
    }

    console.log(`💬 리뷰 ${REVIEWS.length}건 삽입…`);
    for (const [date, source, rating, content, sentiment] of REVIEWS) {
      await client.query(
        'insert into cafe_reviews (date, source, rating, content, sentiment) values ($1,$2,$3,$4,$5)',
        [date, source, rating, content, sentiment],
      );
    }

    console.log(`📦 재고 ${INVENTORY.length}품목 삽입…`);
    for (const row of INVENTORY) {
      await client.query(
        'insert into cafe_inventory (item, unit, stock, daily_usage, reorder_point, lead_time_days, supplier, last_ordered, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        row,
      );
    }

    // ---------- 검증 요약 ----------
    const sales = await client.query('select count(*)::int n, round(avg(customers),1) avg_c, sum(revenue)::bigint rev from cafe_daily_sales');
    const menus = await client.query('select count(*)::int n from cafe_menu_sales');
    const top = await client.query('select menu, sum(amount)::bigint amt, sum(qty)::int q from cafe_menu_sales group by menu order by amt desc');
    const mismatch = await client.query(`
      select count(*)::int n from cafe_daily_sales d
      where d.revenue <> (select coalesce(sum(m.amount),0) from cafe_menu_sales m where m.date = d.date)`);

    console.log('\n===== 시드 완료 =====');
    console.log(`영업일 ${sales.rows[0].n}일 · 일평균 손님 ${sales.rows[0].avg_c}명 · 총매출 ${Number(sales.rows[0].rev).toLocaleString()}원`);
    console.log(`메뉴 판매 행 ${menus.rows[0].n}개 · 리뷰 ${REVIEWS.length}건 · 재고 ${INVENTORY.length}품목`);
    console.log(`일매출↔메뉴합계 불일치: ${mismatch.rows[0].n}건 (0이어야 정상)`);
    console.log('\n메뉴별 누적 매출 순위:');
    for (const r of top.rows) console.log(`  ${r.menu.padEnd(14)} ${Number(r.amt).toLocaleString()}원 (${r.q}개)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
