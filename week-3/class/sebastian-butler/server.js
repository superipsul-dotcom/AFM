// ========================================
// 세바스찬 🎩 - 집사 비서 챗봇 백엔드 서버
// OpenAI Chat Completions API 프록시
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
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

// 집사 비서 "세바스찬" 시스템 프롬프트
const SYSTEM_PROMPT = `당신은 "세바스찬(Sebastian)"이라는 이름의, 충성스럽고 품격 있는 한국어 집사 비서입니다.

[성격과 태도]
- 충성스럽고 침착하며, 대화 곳곳에 은근하고 절제된 위트를 담습니다.
- 사용자를 항상 "주인님"이라고 부릅니다.
- 결코 무례하거나 들뜨지 않으며, 어떤 부탁에도 품위를 잃지 않습니다.

[말투]
- 항상 한국어로, 격식 있고 정중한 존댓말을 사용합니다.
- "분부대로 하겠습니다", "기꺼이 돕겠습니다", "그리하시지요" 같은 집사다운 표현을 자연스럽게 섞습니다.
- 정중하되 장황하지 않게, 핵심은 간결하게 전합니다.

[전문분야]
- 일정 관리, 할 일(To-Do) 정리, 하루·한 주 루틴 설계, 라이프스타일 비서 역할.
- 할 일이나 일정을 정리할 때는 반드시 우선순위를 매겨 "1. / 2. / 3." 형태의 목록으로 제안합니다.
- 응답 끝에는 다음에 무엇을 도와드릴지 가볍게 여쭙거나 한 가지를 제안하며 마무리합니다.

[중요한 한계]
- 당신은 AI 비서이며, 실제 캘린더·알람·외부 앱을 직접 제어하거나 알림을 보낼 수는 없습니다.
- 대신 정리·제안·조언으로 주인님을 돕습니다. 사용자가 오해할 수 있는 부탁에는 이 점을 정중히 안내하세요.
- 모르는 정보를 지어내지 않습니다. 확실하지 않으면 솔직하게 말씀드립니다.`;

app.use(express.json());

// 정적 파일 서빙 (같은 폴더의 index.html 등)
app.use(express.static(path.join(__dirname)));

// ========================================
// POST /api/chat — OpenAI 프록시
// ========================================
app.post('/api/chat', async (req, res) => {
  try {
    // API 키 검증
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message:
          'OpenAI API 키가 설정되지 않았습니다. 환경변수 OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행해 주세요.',
      });
    }

    const { messages } = req.body;

    // 입력 검증
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'messages 배열이 필요합니다.',
      });
    }

    // 클라이언트 메시지를 OpenAI 포맷으로 정제 (role/content 만 허용)
    const cleanMessages = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));

    if (cleanMessages.length === 0) {
      return res.status(400).json({
        success: false,
        message: '유효한 대화 메시지가 없습니다.',
      });
    }

    // 시스템 프롬프트를 맨 앞에 추가
    const payload = {
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...cleanMessages],
      temperature: 0.7,
      max_tokens: 600,
    };

    // OpenAI 호출 (Node 18+ 내장 fetch 사용)
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
        message: '응답을 가져오는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      });
    }

    const data = await openaiRes.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return res.status(502).json({
        success: false,
        message: '응답이 비어 있습니다. 잠시 후 다시 시도해 주세요.',
      });
    }

    return res.json({ success: true, data: { reply } });
  } catch (err) {
    console.error('서버 처리 중 오류:', err);
    return res.status(500).json({
      success: false,
      message: '서버에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
});

// ========================================
// 에러 핸들링 미들웨어
// ========================================
app.use((err, _req, res, _next) => {
  console.error('처리되지 않은 오류:', err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ========================================
// 서버 시작 (로컬) / Vercel 등에서는 app export
// ========================================
if (require.main === module) {
  if (!OPENAI_API_KEY) {
    console.warn(
      '\n⚠️  경고: 환경변수 OPENAI_API_KEY가 설정되지 않았습니다.\n' +
        '   AI 응답을 받으려면 다음과 같이 실행하세요:\n' +
        '   OPENAI_API_KEY=sk-... node server.js\n'
    );
  }
  app.listen(PORT, () => {
    console.log(`🎩 세바스찬이 http://localhost:${PORT} 에서 주인님을 기다리고 있습니다.`);
  });
}

module.exports = app;
