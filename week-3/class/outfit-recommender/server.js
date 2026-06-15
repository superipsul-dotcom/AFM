// ========================================
// 👕 날씨 기반 옷차림 추천 - 백엔드 서버
// OpenWeatherMap 날씨 API 프록시 + 옷차림 추천 로직
// ========================================
//
// ★★★ 이 프로젝트의 핵심 학습 포인트 ★★★
// 외부 날씨 API 키(OPENWEATHER_API_KEY)는 "오직 이 서버"에서만 다룬다.
// 프론트엔드(index.html)는 외부 날씨 API 주소도, API 키도 전혀 알지 못한다.
// 프론트는 우리 서버의 GET /recommend 만 호출하고, 서버가 대신 OpenWeatherMap을
// 호출한 뒤 가공된 결과만 돌려준다. 이렇게 해야 키가 브라우저로 새어 나가지 않는다.
// ========================================

const express = require('express');
const path = require('path');

// .env 파일이 있으면 자동 로드 (Node 20.6+ 내장 기능, 별도 의존성 불필요)
// dotenv 같은 패키지 없이도 .env 의 값이 process.env 로 들어온다.
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.join(__dirname, '.env'));
  }
} catch (_) {
  /* .env 파일이 없으면 무시 — 환경변수로 직접 넘겨도 동작한다 */
}

const app = express();
const PORT = process.env.PORT || 4090;

// ----------------------------------------
// OpenWeatherMap 설정
// ----------------------------------------
// API 키는 환경변수로만 읽는다. (코드/클라이언트에 절대 하드코딩 금지!)
// .trim() 으로 혹시 모를 끝 공백/줄바꿈을 제거한다.
const OPENWEATHER_API_KEY = (process.env.OPENWEATHER_API_KEY || '').trim();
// 5일/3시간 예보 엔드포인트. 오늘·내일·모레를 한 번의 호출로 받기 위해 forecast 를 쓴다.
// (무료 플랜 포함 — 3시간 간격 40개 슬롯을 돌려준다.)
const OPENWEATHER_FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

// 키가 있으면 실시간 모드, 없으면 데모 모드로 동작한다.
const IS_DEMO = !OPENWEATHER_API_KEY;

// ========================================
// 🌡️ 기온 구간 → 옷차림 매핑 테이블
// ========================================
// 한국 표준 "기온별 옷차림 가이드".
// 위에서부터 가장 더운 구간 → 가장 추운 구간 순으로 정렬해 두고,
// pickOutfit(temp) 가 위에서부터 "기온 >= min" 인 첫 구간을 골라준다.
// 각 구간: min(이 온도 이상이면 해당), headline(짧은 한마디), items(추천 의류), emoji.
const OUTFIT_TABLE = [
  {
    min: 28,
    label: '28°C 이상',
    headline: '한여름! 반팔·반바지 OK ☀️',
    items: ['민소매', '반팔', '반바지', '린넨 소재'],
    emoji: '🥵',
  },
  {
    min: 23,
    label: '23~27°C',
    headline: '따뜻해요, 가볍게 입어요 👕',
    items: ['반팔', '얇은 셔츠', '면바지'],
    emoji: '😎',
  },
  {
    min: 20,
    label: '20~22°C',
    headline: '선선한 봄가을 날씨 🍃',
    items: ['얇은 가디건', '긴팔', '면바지', '청바지'],
    emoji: '🙂',
  },
  {
    min: 17,
    label: '17~19°C',
    headline: '얇은 겉옷 하나 챙기세요 🧶',
    items: ['얇은 니트', '맨투맨', '가디건'],
    emoji: '🍂',
  },
  {
    min: 12,
    label: '12~16°C',
    headline: '쌀쌀해요, 자켓 추천 🧥',
    items: ['자켓', '가디건', '야상', '청바지'],
    emoji: '🌥️',
  },
  {
    min: 9,
    label: '9~11°C',
    headline: '코트가 필요한 날씨 🧣',
    items: ['트렌치코트', '코트', '히트텍', '니트'],
    emoji: '🌬️',
  },
  {
    min: 5,
    label: '5~8°C',
    headline: '춥습니다, 따뜻하게 ❄️',
    items: ['코트', '히트텍', '두꺼운 니트', '기모바지', '목도리'],
    emoji: '🥶',
  },
  {
    min: -Infinity, // 4°C 이하 (그 아래 전부)
    label: '4°C 이하',
    headline: '패딩 필수! 단단히 입으세요 🧥',
    items: ['패딩', '두꺼운 코트', '목도리', '기모 제품', '장갑'],
    emoji: '🧊',
  },
];

// 기온(섭씨)을 받아 해당하는 옷차림 구간을 찾아준다.
// 테이블이 높은 온도 → 낮은 온도 순이라 위에서부터 "temp >= min" 첫 항목을 고르면 된다.
function pickOutfit(temp) {
  const t = Number(temp);
  // 숫자가 아니면 가장 무난한 중간 구간(17~19°C)으로 안전하게 처리
  const safeTemp = Number.isFinite(t) ? t : 18;
  return OUTFIT_TABLE.find((zone) => safeTemp >= zone.min) || OUTFIT_TABLE[OUTFIT_TABLE.length - 1];
}

app.use(express.json());

// 정적 파일 서빙 (같은 폴더의 index.html 등)
app.use(express.static(path.join(__dirname)));

// 한글 → 영문 도시 별칭 맵.
// OpenWeatherMap 은 한글 도시명("부산")을 잘 못 찾으므로, 주요 도시는
// 서버에서 영문으로 바꿔 조회한다. (이 변환 로직도 백엔드에 둔다 — 프론트는 몰라도 됨)
const KO_CITY_ALIAS = {
  서울: 'Seoul', 부산: 'Busan', 인천: 'Incheon', 대구: 'Daegu',
  대전: 'Daejeon', 광주: 'Gwangju', 울산: 'Ulsan', 세종: 'Sejong',
  수원: 'Suwon', 고양: 'Goyang', 용인: 'Yongin', 성남: 'Seongnam',
  청주: 'Cheongju', 전주: 'Jeonju', 천안: 'Cheonan', 제주: 'Jeju',
  춘천: 'Chuncheon', 강릉: 'Gangneung', 포항: 'Pohang', 창원: 'Changwon',
};

// ========================================
// GET /recommend?city=Seoul
// 도시 이름을 받아 오늘·내일·모레 3일치 날씨 + 옷차림 추천을 돌려준다.
// 키가 없으면 503으로 죽이지 않고 "데모 모드"(샘플 데이터)로 응답한다.
// 응답: { success, demo, notice?, data: { city, days: [ {label, date, temp,
//        feelsLike, description, weatherEmoji, outfit}, ... ] } }
// ========================================
app.get('/recommend', async (req, res) => {
  try {
    // 도시 이름 (기본값 Seoul). 사용자가 입력한 원본은 안내 메시지에 그대로 쓴다.
    const city = (req.query.city || 'Seoul').toString().trim() || 'Seoul';
    // 실제 조회에 쓸 이름: 한글 주요 도시면 영문으로 변환, 아니면 그대로.
    const queryCity = KO_CITY_ALIAS[city] || city;

    // ----------------------------------------
    // 🧪 데모 모드: API 키가 없을 때
    // ----------------------------------------
    // 키가 없어도 즉시 결과를 볼 수 있도록 고정 샘플 데이터(18°C 맑음)로
    // 옷차림 로직을 그대로 태워서 응답한다. demo: true 를 함께 내려보내
    // 프론트가 "샘플 데이터입니다" 안내 배지를 띄울 수 있게 한다.
    if (IS_DEMO) {
      // 오늘·내일·모레 3일치 샘플. 기온을 일부러 다르게 줘서 카드 3개가
      // 서로 다른 옷차림으로 보이도록 한다.
      const samples = [
        { label: '오늘', temp: 18, description: '맑음 (샘플)', icon: '01d' },
        { label: '내일', temp: 24, description: '구름 조금 (샘플)', icon: '02d' },
        { label: '모레', temp: 12, description: '흐림 (샘플)', icon: '04d' },
      ];
      const todaySec = Math.floor(Date.now() / 1000);
      const days = samples.map((s, i) => ({
        label: s.label,
        date: new Date((todaySec + i * 86400) * 1000).toISOString().slice(0, 10),
        temp: s.temp,
        feelsLike: s.temp,
        description: s.description,
        weatherEmoji: iconToEmoji(s.icon),
        outfit: pickOutfit(s.temp),
      }));
      return res.json({
        success: true,
        demo: true,
        notice:
          '샘플 데이터입니다. 서버에 OPENWEATHER_API_KEY 를 설정하면 실시간 날씨로 동작합니다.',
        data: { city, days },
      });
    }

    // ----------------------------------------
    // 🌍 실시간 모드: OpenWeatherMap 직접 호출 (서버에서만!)
    // ----------------------------------------
    // units=metric → 섭씨, lang=kr → 날씨 설명을 한글로 받는다.
    // appid(키)는 여기 서버에서만 붙는다. 프론트는 이 URL을 절대 모른다.
    const url =
      `${OPENWEATHER_FORECAST_URL}?q=${encodeURIComponent(queryCity)}` +
      `&appid=${OPENWEATHER_API_KEY}&units=metric&lang=kr`;

    // 외부 API 호출 (Node 18+ 내장 fetch 사용 — 별도 패키지 불필요)
    const weatherRes = await fetch(url);

    // 도시를 못 찾은 경우(404) → 친절한 한글 메시지로 400
    if (weatherRes.status === 404) {
      return res.status(400).json({
        success: false,
        message: `'${city}' 도시를 찾을 수 없어요. 도시 이름을 다시 확인해 주세요. (예: Seoul, Busan, 서울)`,
      });
    }

    // 키 오류(401) → 서버 설정 문제이므로 502로 안내
    if (weatherRes.status === 401) {
      console.error('OpenWeatherMap 인증 오류(401): API 키가 올바르지 않습니다.');
      return res.status(502).json({
        success: false,
        message: '날씨 서비스 인증에 실패했어요. 서버 관리자에게 API 키 설정을 확인해 달라고 알려주세요.',
      });
    }

    // 그 외 실패(5xx 등) → 502
    if (!weatherRes.ok) {
      console.error(`OpenWeatherMap 오류 (${weatherRes.status})`);
      return res.status(502).json({
        success: false,
        message: '날씨 정보를 가져오는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const forecast = await weatherRes.json();
    const resolvedCity = forecast?.city?.name || city;

    // 3시간 간격 예보를 오늘·내일·모레 3일치로 가공
    const days = buildDailyForecast(forecast);

    // 가공 결과가 비어 있으면(예상치 못한 응답) 502
    if (days.length === 0) {
      console.error('예보 데이터를 가공하지 못했습니다:', forecast?.cod, forecast?.message);
      return res.status(502).json({
        success: false,
        message: '날씨 예보 데이터가 올바르지 않아요. 잠시 후 다시 시도해 주세요.',
      });
    }

    return res.json({
      success: true,
      demo: false,
      data: {
        city: resolvedCity,
        days,
      },
    });
  } catch (err) {
    // 네트워크 자체가 실패한 경우 등 (fetch throw)
    console.error('날씨 요청 처리 중 오류:', err);
    return res.status(502).json({
      success: false,
      message: '날씨 서버에 연결하지 못했어요. 인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요.',
    });
  }
});

// OpenWeatherMap 아이콘 코드(예 '01d', '10n')를 보기 좋은 이모지로 매핑.
// 코드 앞 두 자리가 날씨 종류를 나타낸다.
function iconToEmoji(icon) {
  const code = (icon || '').slice(0, 2);
  const map = {
    '01': '☀️', // 맑음
    '02': '🌤️', // 구름 조금
    '03': '⛅', // 구름
    '04': '☁️', // 흐림
    '09': '🌧️', // 소나기
    '10': '🌦️', // 비
    '11': '⛈️', // 천둥번개
    '13': '❄️', // 눈
    '50': '🌫️', // 안개
  };
  return map[code] || '🌡️';
}

// ========================================
// 📅 5일/3시간 예보 → 오늘·내일·모레 3일치로 가공
// ========================================
// OpenWeatherMap forecast 는 3시간 간격(하루 8개) 슬롯을 돌려준다.
// 도시의 현지 시간대(city.timezone, 초 단위 UTC offset)를 적용해 "현지 날짜"별로
// 묶은 뒤, 각 날에서 정오(12시)에 가장 가까운 슬롯을 그 날의 대표 날씨로 고른다.
function buildDailyForecast(forecast) {
  const tz = Number(forecast?.city?.timezone) || 0; // 현지 UTC offset(초)
  const list = Array.isArray(forecast?.list) ? forecast.list : [];

  // unix(초) → 현지 시각 Date (offset 더한 뒤 UTC getter 로 읽으면 현지 시각이 된다)
  const toLocal = (unixSec) => new Date((unixSec + tz) * 1000);
  const localDateKey = (unixSec) => toLocal(unixSec).toISOString().slice(0, 10); // YYYY-MM-DD
  const localHour = (unixSec) => toLocal(unixSec).getUTCHours();

  // 3시간 슬롯들을 현지 날짜별로 묶기
  const byDate = {};
  for (const item of list) {
    if (!item || typeof item.dt !== 'number') continue;
    const key = localDateKey(item.dt);
    (byDate[key] = byDate[key] || []).push(item);
  }

  // 도시 현지 기준 '오늘' 0시의 unix 초 (여기서부터 +0/+1/+2 일이 오늘/내일/모레)
  const nowLocalSec = Math.floor(Date.now() / 1000) + tz;
  const labels = ['오늘', '내일', '모레'];
  const days = [];

  for (let i = 0; i < 3; i++) {
    const key = new Date((nowLocalSec + i * 86400) * 1000).toISOString().slice(0, 10);
    let entries = byDate[key];

    // 늦은 밤이라 '오늘' 남은 슬롯이 없으면, 가장 가까운 미래 슬롯을 오늘 대표로 사용
    if ((!entries || entries.length === 0) && i === 0 && list.length > 0) {
      entries = [list[0]];
    }
    if (!entries || entries.length === 0) continue;

    // 정오(12시)에 가장 가까운 슬롯을 그 날의 대표로 선택
    let pick = entries[0];
    for (const e of entries) {
      if (Math.abs(localHour(e.dt) - 12) < Math.abs(localHour(pick.dt) - 12)) pick = e;
    }

    const temp = pick?.main?.temp;
    if (typeof temp !== 'number') continue;

    days.push({
      label: labels[i],
      date: key,
      temp: Math.round(temp),
      feelsLike: Math.round(pick?.main?.feels_like ?? temp),
      description: pick?.weather?.[0]?.description || '정보 없음',
      weatherEmoji: iconToEmoji(pick?.weather?.[0]?.icon || ''),
      outfit: pickOutfit(temp),
    });
  }

  return days;
}

// ========================================
// 에러 핸들링 미들웨어 (혹시 위에서 못 잡은 오류)
// ========================================
app.use((err, _req, res, _next) => {
  console.error('처리되지 않은 오류:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했어요.' });
});

// ========================================
// 서버 시작 (로컬) / Vercel 등에서는 app export
// ========================================
if (require.main === module) {
  if (IS_DEMO) {
    console.warn(
      '\n⚠️  OPENWEATHER_API_KEY 가 없어 "데모 모드"로 실행됩니다.\n' +
        '   실시간 날씨를 받으려면 .env 에 키를 넣거나 다음처럼 실행하세요:\n' +
        '   OPENWEATHER_API_KEY=발급받은키 node server.js\n' +
        '   (키 발급은 https://openweathermap.org 에서 무료로 가능합니다)\n'
    );
  }
  app.listen(PORT, () => {
    const mode = IS_DEMO ? '🧪 데모 모드' : '🌍 실시간 모드';
    console.log(`👕 옷차림 추천 서버가 http://localhost:${PORT} 에서 실행 중입니다. [${mode}]`);
  });
}

module.exports = app;
