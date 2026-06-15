// ========================================
// 🪙 코인 트래커 - 실시간 암호화폐 시세 추적기 백엔드
// CoinGecko 무료 공개 API 프록시 (API 키 불필요)
// ========================================

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// CoinGecko 공개 API 베이스 URL (무료 등급, 인증 없음)
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// ----------------------------------------
// 간단한 in-memory 캐시
// CoinGecko 무료 등급은 rate limit 이 빡빡하므로,
// 같은 ids 조합의 /api/prices 응답을 잠시 캐싱해서
// 30초 폴링 + 다중 클라이언트 상황에서 호출 횟수를 줄인다.
// ----------------------------------------
const PRICE_CACHE_TTL_MS = 22 * 1000; // 약 22초간 캐싱 (클라이언트 폴링 30초보다 짧게)
const priceCache = new Map(); // key: 정렬된 ids 문자열, value: { data, expiresAt }

// ----------------------------------------
// 차트(추이) 설정 + 캐시
// 과거 가격 데이터는 자주 변하지 않으므로 기간별로 넉넉히 캐싱해서
// market_chart 호출(코인당 1회)이 rate limit 을 넘지 않게 한다.
// ----------------------------------------
const RANGE_DAYS = { day: 1, week: 7, month: 30 }; // 일/주/월 → CoinGecko days 파라미터
const CHART_TTL_MS = { day: 120 * 1000, week: 600 * 1000, month: 1800 * 1000 };
const CHART_MAX_POINTS = 48; // 스파크라인용 다운샘플 목표 점 개수
const chartCache = new Map(); // key: `${id}|${range}`, value: { points, expiresAt }

app.use(express.json());

// 정적 파일 서빙 (같은 폴더의 index.html, client.js 등)
app.use(express.static(path.join(__dirname)));

// ========================================
// GET /api/prices?ids=bitcoin,ethereum
// CoinGecko /coins/markets 프록시
// → 카드 UI 에 필요한 필드만 정제해서 내려준다:
//   { id, name, symbol, image, price(KRW), change24h }
// ========================================
app.get('/api/prices', async (req, res) => {
  try {
    // ids 파라미터 검증 및 정규화
    const rawIds = (req.query.ids || '').toString().trim();
    if (!rawIds) {
      return res.status(400).json({
        success: false,
        message: '조회할 코인 ids 가 필요합니다. 예) /api/prices?ids=bitcoin,ethereum',
      });
    }

    // 공백 제거 + 소문자화 + 중복/빈값 제거
    const idList = Array.from(
      new Set(
        rawIds
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )
    );

    if (idList.length === 0) {
      return res.status(400).json({
        success: false,
        message: '유효한 코인 id 가 없습니다.',
      });
    }

    // 캐시 키는 ids 를 정렬해서 만든다 (순서가 달라도 같은 조합이면 동일 캐시 사용)
    const cacheKey = [...idList].sort().join(',');
    const cached = priceCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ success: true, data: cached.data, cached: true });
    }

    // CoinGecko markets 엔드포인트 호출 (로고/이름/심볼/현재가/24h 등락률을 한 번에 제공)
    const url =
      `${COINGECKO_BASE}/coins/markets` +
      `?vs_currency=krw` +
      `&ids=${encodeURIComponent(idList.join(','))}` +
      `&price_change_percentage=24h,7d,30d` +
      `&per_page=250&page=1&sparkline=false`;

    let cgRes;
    try {
      cgRes = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
    } catch (netErr) {
      console.error('CoinGecko 네트워크 오류:', netErr);
      return res.status(502).json({
        success: false,
        message: '시세 서버(CoinGecko)에 연결하지 못했어요. 네트워크 상태를 확인해 주세요.',
      });
    }

    if (!cgRes.ok) {
      // 429 = rate limit 초과를 따로 안내
      if (cgRes.status === 429) {
        return res.status(429).json({
          success: false,
          message: '요청이 너무 많아요(CoinGecko 무료 한도). 잠시 후 다시 시도해 주세요.',
        });
      }
      console.error(`CoinGecko 응답 오류: ${cgRes.status}`);
      return res.status(502).json({
        success: false,
        message: '시세 정보를 가져오는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const raw = await cgRes.json();
    if (!Array.isArray(raw)) {
      return res.status(502).json({
        success: false,
        message: '시세 응답 형식이 올바르지 않아요. 잠시 후 다시 시도해 주세요.',
      });
    }

    // 숫자가 아니면 null 로 정규화 (CoinGecko 는 데이터가 없으면 null/undefined 를 준다)
    const num = (v) => (typeof v === 'number' && !isNaN(v) ? v : null);

    // 우리 카드 UI 형식으로 정제 (필요한 필드만)
    // 일/주/월 추이 표시를 위해 24h·7d·30d 등락률을 함께 내려준다.
    const data = raw.map((coin) => ({
      id: coin.id,
      name: coin.name,
      symbol: (coin.symbol || '').toUpperCase(),
      image: coin.image,
      price: coin.current_price, // KRW
      change24h: num(
        coin.price_change_percentage_24h_in_currency != null
          ? coin.price_change_percentage_24h_in_currency
          : coin.price_change_percentage_24h
      ),
      change7d: num(coin.price_change_percentage_7d_in_currency),
      change30d: num(coin.price_change_percentage_30d_in_currency),
    }));

    // 캐시에 저장
    priceCache.set(cacheKey, { data, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });

    return res.json({ success: true, data, cached: false });
  } catch (err) {
    console.error('서버 처리 중 오류(/api/prices):', err);
    return res.status(500).json({
      success: false,
      message: '서버에서 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
    });
  }
});

// ========================================
// GET /api/search?q=<검색어>
// CoinGecko /search 프록시
// → 코인 후보를 최대 8개까지 정제해서 내려준다:
//   { id, name, symbol, thumb, market_cap_rank }
// ========================================
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) {
      return res.status(400).json({
        success: false,
        message: '검색어(q)가 필요합니다. 예) /api/search?q=bitcoin',
      });
    }

    const url = `${COINGECKO_BASE}/search?query=${encodeURIComponent(q)}`;

    let cgRes;
    try {
      cgRes = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (netErr) {
      console.error('CoinGecko 검색 네트워크 오류:', netErr);
      return res.status(502).json({
        success: false,
        message: '검색 서버(CoinGecko)에 연결하지 못했어요. 네트워크 상태를 확인해 주세요.',
      });
    }

    if (!cgRes.ok) {
      if (cgRes.status === 429) {
        return res.status(429).json({
          success: false,
          message: '검색 요청이 너무 많아요(CoinGecko 무료 한도). 잠시 후 다시 시도해 주세요.',
        });
      }
      console.error(`CoinGecko 검색 응답 오류: ${cgRes.status}`);
      return res.status(502).json({
        success: false,
        message: '코인을 검색하는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const raw = await cgRes.json();
    const coins = Array.isArray(raw?.coins) ? raw.coins : [];

    // 상위 8개만 정제
    const data = coins.slice(0, 8).map((c) => ({
      id: c.id,
      name: c.name,
      symbol: (c.symbol || '').toUpperCase(),
      thumb: c.thumb,
      market_cap_rank: c.market_cap_rank ?? null,
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error('서버 처리 중 오류(/api/search):', err);
    return res.status(500).json({
      success: false,
      message: '서버에서 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
    });
  }
});

// ========================================
// 차트 헬퍼
// ========================================

// 포인트 배열을 목표 개수로 균등 다운샘플 (마지막 점 보존)
function downsample(points, maxPoints) {
  if (!Array.isArray(points)) return [];
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

// 한 코인의 기간별 가격 추이 가져오기 (캐시 우선)
// 반환: { id, points: [[timestamp(ms), price], ...] | null }
async function getCoinChart(id, range) {
  const cacheKey = id + '|' + range;
  const cached = chartCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { id, points: cached.points, cached: true };
  }

  const days = RANGE_DAYS[range];
  const url =
    `${COINGECKO_BASE}/coins/${encodeURIComponent(id)}/market_chart` +
    `?vs_currency=krw&days=${days}`;

  const cgRes = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!cgRes.ok) {
    const err = new Error('market_chart 응답 오류: ' + cgRes.status);
    err.status = cgRes.status;
    throw err;
  }

  const raw = await cgRes.json();
  // CoinGecko prices 형식: [[timestamp(ms), price], ...]
  const prices = Array.isArray(raw && raw.prices) ? raw.prices : [];
  const points = downsample(prices, CHART_MAX_POINTS).map((pt) => [pt[0], pt[1]]);

  chartCache.set(cacheKey, {
    points,
    expiresAt: Date.now() + (CHART_TTL_MS[range] || CHART_TTL_MS.day),
  });
  return { id, points, cached: false };
}

// ========================================
// GET /api/charts?ids=bitcoin,ethereum&range=day|week|month
// 여러 코인의 가격 추이(스파크라인용)를 한 번에 내려준다:
//   { success, range, data: { bitcoin: [[t,p],...], ... } }
// 일부 코인이 실패해도(예: 429) 그 코인만 null 로 두고 나머지는 정상 반환한다.
// ========================================
app.get('/api/charts', async (req, res) => {
  try {
    const rawIds = (req.query.ids || '').toString().trim();
    let range = (req.query.range || 'day').toString().trim().toLowerCase();
    if (!RANGE_DAYS[range]) range = 'day'; // 알 수 없는 기간은 '일'로 폴백

    if (!rawIds) {
      return res.status(400).json({
        success: false,
        message: '조회할 코인 ids 가 필요합니다. 예) /api/charts?ids=bitcoin&range=week',
      });
    }

    const idList = Array.from(
      new Set(
        rawIds
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      )
    );

    if (idList.length === 0) {
      return res.status(400).json({ success: false, message: '유효한 코인 id 가 없습니다.' });
    }

    let rateLimited = false;
    const results = await Promise.all(
      idList.map(async (id) => {
        try {
          return await getCoinChart(id, range);
        } catch (e) {
          if (e && e.status === 429) rateLimited = true;
          console.error('차트 가져오기 실패(' + id + '):', e && e.message);
          return { id, points: null }; // 실패한 코인은 null (카드는 차트 없이 표시됨)
        }
      })
    );

    const data = {};
    results.forEach((r) => {
      data[r.id] = r.points;
    });

    return res.json({
      success: true,
      range,
      data,
      rateLimited: rateLimited || undefined, // 일부라도 한도 초과면 표시
    });
  } catch (err) {
    console.error('서버 처리 중 오류(/api/charts):', err);
    return res.status(500).json({
      success: false,
      message: '추이 데이터를 가져오는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
    });
  }
});

// ========================================
// 에러 핸들링 미들웨어
// ========================================
app.use((err, _req, res, _next) => {
  console.error('처리되지 않은 오류:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했어요.' });
});

// ========================================
// 서버 시작 (로컬) / Vercel 등에서는 app export
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🪙 코인 트래커 서버 실행: http://localhost:${PORT}`);
  });
}

module.exports = app;
