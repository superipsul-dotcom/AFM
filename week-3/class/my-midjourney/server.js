// ========================================
// MyMidjourney 🎨 - 나만의 AI 화가 백엔드 서버
// OpenAI gpt-image-1 이미지 생성 API 프록시
// ========================================

const express = require('express');
const path = require('path');

// .env 파일이 있으면 자동 로드 (Node 20.6+ 내장 기능, 별도 의존성 불필요)
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.join(__dirname, '.env'));
  }
} catch (_) {
  /* .env 파일이 없으면 무시 — 환경변수로 직접 넘겨도 됨 */
}

const app = express();
const PORT = process.env.PORT || 3000;

// OpenAI 설정 (키는 환경변수로만 읽음 — 코드/클라이언트에 절대 하드코딩 금지)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_URL = 'https://api.openai.com/v1/images/generations';

// 사용할 이미지 생성 모델
// ⚙️ 더 높은 품질이 필요하면 'gpt-image-1.5' 또는 'gpt-image-2' 로 교체 가능
const IMAGE_MODEL = 'gpt-image-1';
// 이미지 품질: 'low'(가장 저렴·빠름) | 'medium' | 'high'  — 'low' 도 충분히 예쁩니다
const IMAGE_QUALITY = 'low';
const IMAGE_SIZE = '1024x1024';
const MAX_IMAGES = 4; // 한 번에 생성 가능한 최대 장수
const PER_IMAGE_TIMEOUT_MS = 50000; // 장당 타임아웃(장수에 비례해 늘림)

// ========================================
// 🎨 미리 정해둔 화풍(스타일) 프리셋
// 각 프리셋의 영어 suffix 가 사용자 프롬프트 뒤에 붙습니다.
// (이미지 모델은 상세한 영어 스타일 묘사를 가장 잘 따릅니다)
// ========================================
const STYLE_PRESETS = {
  ghibli:     { label: '지브리풍 애니메이션', suffix: 'in the style of Studio Ghibli, hand-drawn anime, soft pastel colors, warm cinematic lighting, whimsical and dreamy atmosphere, highly detailed' },
  watercolor: { label: '수채화 일러스트',     suffix: 'delicate watercolor painting, soft bleeding colors, textured paper, gentle dreamy mood, hand-painted illustration' },
  cyberpunk:  { label: '사이버펑크 네온',     suffix: 'cyberpunk style, glowing neon lights, dark futuristic city, rain reflections, cinematic sci-fi atmosphere, highly detailed' },
  oil:        { label: '유화 명화',           suffix: 'classical oil painting, thick visible brush strokes, rich deep colors, museum masterpiece, dramatic lighting' },
};
const DEFAULT_STYLE = 'ghibli';

app.use(express.json({ limit: '1mb' }));

// 정적 파일 서빙 (같은 폴더의 index.html 등)
app.use(express.static(path.join(__dirname)));

// ========================================
// POST /api/generate — OpenAI 이미지 생성 프록시
// body: { prompt: string, style?: string, count?: number(1~4) }
// ========================================
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, style, count } = req.body || {};

    // 입력 검증 — prompt 는 비어있지 않은 문자열이어야 함
    // (요청 자체의 유효성이므로 API 키 검증보다 먼저 확인합니다)
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '그리고 싶은 장면을 한 줄 이상 입력해 주세요.',
      });
    }

    // API 키 검증
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message:
          'OPENAI_API_KEY 가 설정되지 않았습니다. .env 파일에 OPENAI_API_KEY 를 입력한 뒤 서버를 다시 실행해 주세요.',
      });
    }

    // 스타일 선택 (없거나 알 수 없는 값이면 기본 화풍 사용)
    const styleKey = STYLE_PRESETS[style] ? style : DEFAULT_STYLE;
    const preset = STYLE_PRESETS[styleKey];

    // 최종 프롬프트 = 사용자 입력 + 미리 정해둔 화풍 묘사
    const finalPrompt = `${prompt.trim()}, ${preset.suffix}`;

    // 생성 장수 (1 ~ MAX_IMAGES, 기본 1)
    let n = parseInt(count, 10);
    if (!Number.isFinite(n)) n = 1;
    n = Math.min(MAX_IMAGES, Math.max(1, n));

    // 요청이 너무 오래 걸리면 중단 (장수가 많을수록 더 오래 걸림)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(90000, n * PER_IMAGE_TIMEOUT_MS));

    let openaiRes;
    try {
      // OpenAI 이미지 생성 호출 (Node 18+ 내장 fetch 사용)
      openaiRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: finalPrompt,
          n,
          size: IMAGE_SIZE,
          quality: IMAGE_QUALITY,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        console.error('OpenAI 요청 시간 초과');
        return res.status(504).json({
          success: false,
          message: '이미지 생성이 너무 오래 걸려 중단했어요. 장수를 줄이거나 잠시 후 다시 시도해 주세요.',
        });
      }
      throw e;
    }
    clearTimeout(timer);

    if (!openaiRes.ok) {
      // 오류 본문에서 error 정보를 최대한 파싱
      let errType = '';
      let errMsg = '';
      try {
        const errBody = await openaiRes.json();
        errType = errBody?.error?.type || errBody?.error?.code || '';
        errMsg = errBody?.error?.message || '';
      } catch (_) {
        /* 무시 */
      }
      console.error(`OpenAI API 오류 (${openaiRes.status}) ${errType}: ${errMsg}`);

      const blob = `${errType} ${errMsg}`;

      // 특수 케이스별 친절한 한국어 안내
      if (/insufficient_quota|billing|exceeded_quota/i.test(blob)) {
        return res.status(502).json({
          success: false,
          message:
            'OpenAI 크레딧(잔액)이 부족합니다. https://platform.openai.com/settings/organization/billing 에서 결제 정보를 확인해 주세요.',
        });
      }
      if (openaiRes.status === 401 || /invalid_api_key|invalid_authentication/i.test(blob)) {
        return res.status(502).json({
          success: false,
          message: 'OpenAI API 키가 올바르지 않아요. .env 의 OPENAI_API_KEY 를 확인해 주세요.',
        });
      }
      if (/content_policy|moderation|safety|rejected/i.test(blob)) {
        return res.status(502).json({
          success: false,
          message: '요청이 콘텐츠 정책에 의해 거부되었어요. 다른 장면으로 다시 시도해 주세요.',
        });
      }
      return res.status(502).json({
        success: false,
        message: '이미지를 생성하는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const data = await openaiRes.json();
    // gpt-image-1 은 각 이미지를 base64(b64_json)로 반환 → 바로 표시 가능한 data URI 로 변환
    const imageUrls = (Array.isArray(data?.data) ? data.data : [])
      .map((it) => it && it.b64_json)
      .filter(Boolean)
      .map((b) => `data:image/png;base64,${b}`);

    if (imageUrls.length === 0) {
      console.error('OpenAI 응답에 이미지 데이터가 없습니다:', JSON.stringify(data).slice(0, 300));
      return res.status(502).json({
        success: false,
        message: '이미지를 받지 못했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    return res.json({
      success: true,
      data: {
        imageUrls,
        count: imageUrls.length,
        style: styleKey,
        styleLabel: preset.label,
        finalPrompt,
      },
    });
  } catch (err) {
    console.error('서버 처리 중 오류:', err);
    return res.status(500).json({
      success: false,
      message: '서버에서 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
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
  if (!OPENAI_API_KEY) {
    console.warn(
      '\n⚠️  경고: 환경변수 OPENAI_API_KEY가 설정되지 않았습니다.\n' +
        '   이미지를 생성하려면 .env 파일에 OPENAI_API_KEY를 넣거나 다음과 같이 실행하세요:\n' +
        '   OPENAI_API_KEY=sk-... node server.js\n'
    );
  }
  app.listen(PORT, () => {
    console.log(`🎨 MyMidjourney 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  });
}

module.exports = app;
