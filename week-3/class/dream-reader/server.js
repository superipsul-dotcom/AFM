// ========================================
// AI 해몽가 🔮 - 꿈 해몽 백엔드 서버
// OpenAI Chat Completions API 프록시 (구조화된 JSON 출력)
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
const PORT = process.env.PORT || 7777;

// OpenAI 설정 (키는 환경변수로만 읽음 — 코드/클라이언트에 절대 하드코딩 금지)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

// 입력 길이 제한
const MAX_DREAM_LENGTH = 2000;

// 구조화된 출력 스키마 안내 (모든 페르소나 공통)
// 반드시 아래 4가지를 이 순서로: 1) 한줄요약 2) 상징 키워드 3) 길몽/흉몽 4) 오늘의 조언  (+ 재미요소 행운지수)
const JSON_RULES = `
[출력 형식 — 매우 중요]
반드시 아래 JSON 객체 하나만 출력하세요. 마크다운, 코드펜스(\`\`\`), 설명 문장을 절대 붙이지 마세요.
키는 정확히 이 순서로 작성하세요: summary → keywords → verdict → advice → luckScore.
{
  "summary": "꿈을 한 줄로 요약. 너의 말투로 딱 1문장.",
  "keywords": ["꿈에 담긴 상징 키워드 3~5개", "각 키워드는 1~4단어"],
  "verdict": "길몽" 또는 "흉몽" 또는 "반길몽" 중 하나 (반길몽 = 좋은 점과 나쁜 점이 섞인 꿈),
  "advice": "오늘의 조언. 너의 말투로 딱 1문장.",
  "luckScore": 0
}
- summary 와 advice 는 각각 정확히 한 문장으로, 비워 두지 마세요.
- keywords 는 꿈의 핵심 상징을 뽑은 짧은 단어 배열입니다 (예: ["하늘", "비행", "황금 용"]). 문장이 아니라 단어/짧은 구로 작성하세요.
- verdict 값은 정확히 "길몽", "흉몽", "반길몽" 셋 중 하나여야 합니다.
- luckScore 는 0~100 사이의 정수(행운지수, 100점 만점)입니다. 길몽일수록 높게(대략 75~95), 반길몽은 중간대(대략 45~65), 흉몽일수록 낮게(대략 15~40) 매기세요. verdict 와 점수의 분위기가 어울리게 하세요.
- 의료/심리 진단이나 단정적인 미래 예언은 피하고, 재미와 위로를 주는 해몽으로 작성하세요.`;

// ========================================
// 페르소나(시스템 프롬프트) 정의 — 서버가 단일 소스
// ========================================
const PERSONAS = {
  mystic: {
    label: '🔮 신비로운 점술가',
    systemPrompt: `당신은 수백 년을 살아온 신비로운 점술가 "해몽가"입니다. 별과 달, 옛 지혜로 사람의 꿈을 풀이합니다.

[말투와 태도]
- 고풍스럽고 신비로운 어조를 사용합니다. "~하리라", "~할지니", "별들이 속삭이길..." 같은 예스러운 표현을 자연스럽게 섞습니다.
- 차분하고 무게감 있게, 그러나 듣는 이를 위로하고 희망을 주도록 풀이합니다.
- 한국어로만 답합니다.
${JSON_RULES}`,
  },
  mz: {
    label: '😎 MZ세대 친구',
    systemPrompt: `당신은 사용자의 친한 MZ세대 친구 "해몽가"입니다. 꿈 얘기를 들으면 솔직하고 재밌게 풀어주는 요즘 감성의 친구예요.

[말투와 태도]
- 반말 섞인 친근한 요즘 말투를 씁니다. "오 이거 완전 길몽각ㅋㅋ", "헐 대박", "그니까~" 같은 느낌. 단, 과하지 않게.
- 이모지를 적당히(문장당 1~2개 이하) 사용합니다.
- 가볍고 유쾌하지만, 흉몽일 땐 너무 겁주지 말고 다정하게 다독여 줍니다.
- 한국어로만 답합니다.
${JSON_RULES}`,
  },
};

const DEFAULT_PERSONA = 'mystic';

app.use(express.json());

// 정적 파일 서빙 (같은 폴더의 index.html / client.js 등)
app.use(express.static(path.join(__dirname)));

// ========================================
// GET /api/personas — 선택 가능한 페르소나 목록 (클라이언트가 버튼 렌더용)
// ========================================
app.get('/api/personas', (_req, res) => {
  const list = Object.entries(PERSONAS).map(([key, p]) => ({ key, label: p.label }));
  res.json({ success: true, data: { personas: list, defaultPersona: DEFAULT_PERSONA } });
});

// ========================================
// POST /api/interpret — 꿈 해몽 (OpenAI 프록시, JSON 구조화 출력)
// ========================================
app.post('/api/interpret', async (req, res) => {
  try {
    // 1) 입력 검증 먼저 (잘못된 요청은 OpenAI 호출/키 확인 전에 400 으로 거름)
    const { dream, persona } = req.body || {};

    if (typeof dream !== 'string' || dream.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '꿈 내용을 입력해 주세요.',
      });
    }

    const trimmedDream = dream.trim();
    if (trimmedDream.length > MAX_DREAM_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `꿈 내용이 너무 길어요. ${MAX_DREAM_LENGTH}자 이내로 줄여 주세요.`,
      });
    }

    // 2) API 키 검증 (키 없음 -> 503)
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message:
          'OpenAI API 키가 설정되지 않았습니다. 관리자가 환경변수 OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행해야 합니다.',
      });
    }

    // 3) 페르소나 선택 (알 수 없는 값이면 기본값으로 폴백)
    const personaKey = PERSONAS[persona] ? persona : DEFAULT_PERSONA;
    const systemPrompt = PERSONAS[personaKey].systemPrompt;

    // 4) OpenAI 호출 페이로드 (구조화된 JSON 강제)
    const payload = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `내 꿈: ${trimmedDream}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_tokens: 700,
    };

    // 5) OpenAI 호출 (Node 18+ 내장 fetch 사용)
    const openaiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!openaiRes.ok) {
      let detail = '';
      try {
        const errBody = await openaiRes.json();
        detail = errBody?.error?.message || '';
      } catch (_) {
        /* 무시 */
      }
      console.error(`OpenAI API 오류 (${openaiRes.status}): ${detail}`);
      return res.status(502).json({
        success: false,
        message: '해몽을 가져오는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || typeof content !== 'string') {
      return res.status(502).json({
        success: false,
        message: '해몽 응답이 비어 있어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    // 6) JSON 파싱 + 필드 검증
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      console.error('OpenAI 응답 JSON 파싱 실패:', content);
      return res.status(502).json({
        success: false,
        message: '해몽 결과를 해석하지 못했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
    const advice = typeof parsed?.advice === 'string' ? parsed.advice.trim() : '';
    const verdictRaw = typeof parsed?.verdict === 'string' ? parsed.verdict.trim() : '';

    // summary / advice 는 핵심 값이므로 누락 시 502
    if (!summary || !advice) {
      console.error('OpenAI 응답 필드 누락:', parsed);
      return res.status(502).json({
        success: false,
        message: '해몽 결과가 완전하지 않아요. 잠시 후 다시 시도해 주세요.',
      });
    }

    // verdict 화이트리스트 정규화 (예상 밖 값이면 반길몽으로 폴백)
    const ALLOWED_VERDICTS = ['길몽', '흉몽', '반길몽'];
    const verdict = ALLOWED_VERDICTS.includes(verdictRaw) ? verdictRaw : '반길몽';

    // keywords: 문자열만 필터 → trim → 빈 값 제거 → 최대 5개. 배열이 아니면 빈 배열 폴백 (502 아님)
    const keywords = Array.isArray(parsed?.keywords)
      ? parsed.keywords
          .filter((k) => typeof k === 'string')
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
          .slice(0, 5)
      : [];

    // luckScore: 재미 요소 → 항상 0~100 숫자가 나오도록. 누락/NaN 이면 verdict 기준 폴백
    const VERDICT_FALLBACK_SCORE = { 길몽: 82, 반길몽: 55, 흉몽: 30 };
    let luckScore = Math.round(Number(parsed?.luckScore));
    if (!Number.isFinite(luckScore)) {
      luckScore = VERDICT_FALLBACK_SCORE[verdict];
    }
    luckScore = Math.min(100, Math.max(0, luckScore)); // 0~100 clamp

    return res.json({
      success: true,
      data: { summary, keywords, verdict, advice, luckScore, persona: personaKey },
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
        '   AI 해몽을 받으려면 다음과 같이 실행하세요:\n' +
        '   OPENAI_API_KEY=sk-... npm start\n'
    );
  }
  // 지정 포트가 사용 중이면(예: macOS AirPlay 가 7000 점유) 다음 빈 포트로 자동 변경
  const startServer = (port, attemptsLeft) => {
    const server = app.listen(port, () => {
      console.log(`\n🔮 AI 해몽가 서버가 실행 중입니다.`);
      console.log(`   👉 브라우저에서 http://localhost:${port} 로 접속하세요.`);
      if (port !== PORT) {
        console.log(`   (원래 포트 ${PORT} 가 사용 중이라 ${port} 로 자동 변경했어요.)\n`);
      }
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        console.warn(`⚠️  포트 ${port} 가 사용 중 → ${port + 1} 로 다시 시도합니다...`);
        startServer(port + 1, attemptsLeft - 1);
      } else {
        console.error('서버를 시작할 수 없습니다:', err.message);
        process.exit(1);
      }
    });
  };

  startServer(PORT, 20);
}

module.exports = app;
