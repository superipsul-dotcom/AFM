// ========================================
// AI 별명(닉네임) 생성기 ✨ - 백엔드 서버
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
const PORT = process.env.PORT || 3100;

// OpenAI 설정 (키는 환경변수로만 읽음 — 코드/클라이언트에 절대 하드코딩 금지)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

// 이미지(캐릭터) 생성용 설정
const OPENAI_IMAGE_URL = 'https://api.openai.com/v1/images/generations';
const IMAGE_MODEL = 'gpt-image-1';

// 선택 가능한 스타일 정의 (서버에서 화이트리스트로 검증 + 프롬프트 지시문 매핑)
// 클라이언트(client.js)는 이 key 값을 style 로 보내야 합니다.
const STYLES = {
  cute_animal: {
    label: '귀여운 동물 이름 스타일로',
    instruction:
      '귀여운 동물에서 영감을 받은, 사랑스럽고 포근한 느낌의 별명을 지어주세요. 동물의 특징과 사람의 성격/취미를 자연스럽게 엮어주세요.',
  },
  game_character: {
    label: '게임 캐릭터 느낌으로',
    instruction:
      '판타지/RPG 게임 캐릭터나 길드원 닉네임 같은 멋지고 개성 있는 별명을 지어주세요. 칭호나 수식어가 붙은 느낌도 좋습니다.',
  },
  korean_pun: {
    label: '한국어 라임/말장난 스타일',
    instruction:
      '한국어 발음의 라임, 언어유희, 말장난을 적극 활용한 위트 있는 별명을 지어주세요. 이름이나 취미의 발음을 재치 있게 비틀어도 좋습니다.',
  },
  chunibyo: {
    label: '중2병 감성으로',
    instruction:
      '과장되게 거창하고 진지한, 이른바 "중2병" 감성의 별명을 지어주세요. 어둠/빛/봉인/각성 같은 거대한 단어와 영어를 섞어 오글거리지만 재미있게 만들어 주세요.',
  },
  elegant: {
    label: '고급스럽고 우아하게',
    instruction:
      '품격 있고 우아하며 세련된 느낌의 별명을 지어주세요. 격조 높은 어휘를 사용해 고급스러운 인상을 주도록 합니다.',
  },
};
const DEFAULT_STYLE = 'cute_animal';

// 별명 생성 시스템 프롬프트 빌더
// OpenAI 가 반드시 정해진 JSON 스키마로만 답하도록 강하게 지시합니다.
function buildSystemPrompt(styleInstruction) {
  return `당신은 사람의 정보를 바탕으로 재치 있고 개성 넘치는 한국어 별명(닉네임)을 지어주는 전문가입니다.

[요청 스타일]
${styleInstruction}

[작성 규칙]
- 사용자의 이름, 성격, 취미를 모두 반영해 별명을 5~6개 만들어 주세요.
- 각 별명에는 한 줄짜리 짧고 재미있는 설명/이유(reason)를 붙여 주세요.
- 별명은 한국어 기준 너무 길지 않게(보통 2~10자 내외) 만들고, 부정적이거나 비하하는 표현은 절대 쓰지 마세요.
- 별명들은 서로 겹치지 않게 다양하게 만들어 주세요.

[출력 형식 — 매우 중요]
- 반드시 아래 JSON 스키마 그대로의 유효한 JSON 객체 하나만 출력하세요. 다른 텍스트, 설명, 마크다운(\`\`\`)은 절대 포함하지 마세요.
{
  "nicknames": [
    { "name": "별명", "reason": "한 줄 설명" }
  ]
}`;
}

app.use(express.json());

// 정적 파일 서빙 (같은 폴더의 index.html, client.js 등)
app.use(express.static(path.join(__dirname)));

// ========================================
// GET /api/styles — 선택 가능한 스타일 목록 (클라이언트가 동적으로 그릴 수 있도록 제공)
// ========================================
app.get('/api/styles', (_req, res) => {
  const styles = Object.entries(STYLES).map(([key, value]) => ({
    key,
    label: value.label,
  }));
  return res.json({ success: true, data: { styles, defaultStyle: DEFAULT_STYLE } });
});

// ========================================
// POST /api/nickname — OpenAI 프록시 (별명 생성)
// body: { name, personality, hobby, style }
// ========================================
app.post('/api/nickname', async (req, res) => {
  try {
    // API 키 검증
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message:
          'OpenAI API 키가 설정되지 않았습니다. 환경변수 OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행해 주세요.',
      });
    }

    const { name, personality, hobby, style } = req.body || {};

    // 입력 검증 (이름/성격/취미가 비어있으면 400)
    const nameVal = typeof name === 'string' ? name.trim() : '';
    const personalityVal = typeof personality === 'string' ? personality.trim() : '';
    const hobbyVal = typeof hobby === 'string' ? hobby.trim() : '';

    if (!nameVal || !personalityVal || !hobbyVal) {
      return res.status(400).json({
        success: false,
        message: '이름, 성격, 취미를 모두 입력해 주세요.',
      });
    }

    // 입력 길이 제한 (과도한 입력 방지)
    if (nameVal.length > 40 || personalityVal.length > 200 || hobbyVal.length > 200) {
      return res.status(400).json({
        success: false,
        message: '입력이 너무 깁니다. 조금 더 짧게 작성해 주세요.',
      });
    }

    // 스타일 화이트리스트 검증 (없거나 모르는 값이면 기본값 사용)
    const styleKey = typeof style === 'string' && STYLES[style] ? style : DEFAULT_STYLE;
    const styleInstruction = STYLES[styleKey].instruction;

    // 사용자 입력을 담은 user 메시지
    const userContent = `이름: ${nameVal}
성격: ${personalityVal}
취미: ${hobbyVal}

위 사람에게 어울리는 별명을 만들어 주세요.`;

    const payload = {
      model: MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt(styleInstruction) },
        { role: 'user', content: userContent },
      ],
      temperature: 0.9,
      max_tokens: 700,
      // 별명 목록이 안정적으로 JSON 파싱되도록 강제
      response_format: { type: 'json_object' },
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
        message: '별명을 생성하는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const data = await openaiRes.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();

    if (!raw) {
      return res.status(502).json({
        success: false,
        message: 'AI 응답이 비어 있어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    // JSON 파싱 (response_format 으로 JSON 보장되지만 안전하게 try-catch)
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      console.error('OpenAI 응답 JSON 파싱 실패:', raw);
      return res.status(502).json({
        success: false,
        message: 'AI 응답 형식을 해석하지 못했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    // nicknames 배열 정제 (name/reason 문자열만 통과)
    const nicknames = Array.isArray(parsed?.nicknames)
      ? parsed.nicknames
          .filter((n) => n && typeof n.name === 'string' && n.name.trim())
          .map((n) => ({
            name: n.name.trim(),
            reason: typeof n.reason === 'string' ? n.reason.trim() : '',
          }))
      : [];

    if (nicknames.length === 0) {
      return res.status(502).json({
        success: false,
        message: '별명을 만들지 못했어요. 입력을 조금 바꿔 다시 시도해 주세요.',
      });
    }

    return res.json({
      success: true,
      data: { nicknames, style: styleKey },
    });
  } catch (err) {
    console.error('서버 처리 중 오류:', err);
    return res.status(500).json({
      success: false,
      message: '서버에서 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
    });
  }
});

// 별명에 맞는 캐릭터 이미지 프롬프트 빌더
// 아트 스타일을 "디즈니 + 일본 애니 + 손그림 스케치"로 서버에 고정합니다.
function buildCharacterPrompt({ nickname, reason, personality, hobby }) {
  const parts = [];
  parts.push(`A single original character whose nickname is "${nickname}".`);
  if (reason) parts.push(`The nickname's meaning/vibe: ${reason}.`);
  if (personality) parts.push(`Personality: ${personality}.`);
  if (hobby) parts.push(`Hobby: ${hobby}.`);
  parts.push(
    'Art style: a charming blend of Disney animation and Japanese anime, drawn as a hand-sketched pencil illustration — ' +
      'expressive large eyes, clean confident line art, soft graphite shading, visible sketch strokes, ' +
      'character concept-art look on off-white paper.'
  );
  parts.push(
    'A single cute and friendly character, upper body, centered. ' +
      'No text, no letters, no watermark, no speech bubble, no border.'
  );
  return parts.join(' ');
}

// ========================================
// POST /api/character — OpenAI 이미지 API 프록시 (별명에 맞는 캐릭터 생성)
// body: { nickname, reason, personality, hobby }
// 아트 스타일(디즈니+일본 애니+스케치)은 서버에 고정되어 있습니다.
// ========================================
app.post('/api/character', async (req, res) => {
  try {
    // API 키 검증
    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message:
          'OpenAI API 키가 설정되지 않았습니다. 환경변수 OPENAI_API_KEY를 설정한 뒤 서버를 다시 실행해 주세요.',
      });
    }

    const { nickname, reason, personality, hobby } = req.body || {};

    // 입력 검증 (별명은 필수)
    const nicknameVal = typeof nickname === 'string' ? nickname.trim() : '';
    if (!nicknameVal) {
      return res.status(400).json({
        success: false,
        message: '캐릭터를 만들 별명이 필요합니다.',
      });
    }
    if (nicknameVal.length > 60) {
      return res.status(400).json({
        success: false,
        message: '별명이 너무 깁니다.',
      });
    }

    // 부가 정보(선택) — 길이 제한 후 프롬프트에 반영
    const reasonVal = typeof reason === 'string' ? reason.trim().slice(0, 300) : '';
    const personalityVal = typeof personality === 'string' ? personality.trim().slice(0, 200) : '';
    const hobbyVal = typeof hobby === 'string' ? hobby.trim().slice(0, 200) : '';

    const prompt = buildCharacterPrompt({
      nickname: nicknameVal,
      reason: reasonVal,
      personality: personalityVal,
      hobby: hobbyVal,
    });

    const payload = {
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
    };

    // OpenAI 이미지 API 호출 (Node 18+ 내장 fetch). 생성에 20~40초 걸릴 수 있습니다.
    const imgRes = await fetch(OPENAI_IMAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!imgRes.ok) {
      let detail = '';
      try {
        const errBody = await imgRes.json();
        detail = errBody?.error?.message || '';
      } catch (_) {
        /* 무시 */
      }
      console.error(`OpenAI 이미지 API 오류 (${imgRes.status}): ${detail}`);
      return res.status(502).json({
        success: false,
        message: '캐릭터 이미지를 생성하는 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    const data = await imgRes.json();
    const b64 = data?.data?.[0]?.b64_json;

    if (!b64) {
      return res.status(502).json({
        success: false,
        message: '이미지 응답이 비어 있어요. 잠시 후 다시 시도해 주세요.',
      });
    }

    // data URL 로 감싸 클라이언트가 바로 <img>/다운로드에 쓰도록 전달 (gpt-image-1 은 PNG 반환)
    return res.json({
      success: true,
      data: { image: `data:image/png;base64,${b64}` },
    });
  } catch (err) {
    console.error('캐릭터 생성 처리 중 오류:', err);
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
        '   별명을 생성하려면 다음과 같이 실행하세요:\n' +
        '   OPENAI_API_KEY=sk-... node server.js\n' +
        '   (또는 .env 파일에 OPENAI_API_KEY=sk-... 한 줄을 넣으세요)\n'
    );
  }
  app.listen(PORT, () => {
    console.log(`✨ 별명 생성기 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  });
}

module.exports = app;
