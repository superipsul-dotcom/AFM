# 🔮 AI 해몽가 (Dream Reader)

당신의 꿈을 OpenAI가 풀이해 주는 미니 풀스택 웹앱입니다. 두 가지 페르소나(신비로운 점술가 / MZ 친구)로 꿈을 해몽하고, **길몽·흉몽·반길몽** 판정과 **오늘의 한 줄 조언**을 받아 보세요.

## 기능

- **두 가지 페르소나**
  - 🔮 **신비로운 점술가** — 고풍스럽고 신비로운 말투("별들이 속삭이길...")
  - 😎 **MZ세대 친구** — 반말 섞인 친근한 요즘 말투("오 이거 완전 길몽각ㅋㅋ")
- **길몽 / 흉몽 / 반길몽 판정** — 색상 배지로 한눈에 확인
- **해몽 본문** — 선택한 페르소나 말투로
- **오늘의 한 줄 조언** — 강조 박스로 표시
- 밤하늘 무드의 다크 + 보라/남색 디자인, 모바일 반응형

## 실행 방법

```bash
# 1) 의존성 설치
npm install

# 2) OpenAI API 키 설정 (둘 중 하나 선택)
#   (A) .env 파일 사용
cp .env.example .env        # 그 후 .env 안의 OPENAI_API_KEY= 에 키를 채워 넣기
#   (B) 환경변수로 직접 전달
#   OPENAI_API_KEY=sk-... npm start

# 3) 서버 시작
npm start
```

이후 **터미널에 표시되는 주소**(기본 http://localhost:7777)로 접속하세요.

> 시작 포트(7777)가 사용 중이면 빈 포트(7778, 7779 …)로 **자동 변경**되고, 실제 주소가 터미널에 출력됩니다.
> 포트를 직접 지정하려면 `PORT=8080 npm start` 처럼 실행하세요.
> (macOS 에서 7000·5000 포트는 AirPlay 수신 기능이 점유하고 있어 기본값에서 피했습니다.)

## 동작 방식

- 프론트엔드(`index.html` + `client.js`)가 `POST /api/interpret` 로 `{ dream, persona }` 를 보냅니다.
- 백엔드(`server.js`)가 OpenAI Chat Completions(`gpt-4o-mini`)를 `response_format: json_object` 로 호출해 구조화된 결과(`verdict`, `interpretation`, `advice`)를 받아 반환합니다.
- **API 키는 서버 환경변수에서만 읽으며, 클라이언트로 절대 노출되지 않습니다.**

## 파일 구조

```
dream-reader/
├── server.js        # Express 백엔드 (OpenAI 프록시)
├── index.html       # UI (인라인 CSS)
├── client.js        # 프론트 로직 (fetch)
├── package.json
├── .env.example     # 키 템플릿 (.env 로 복사해서 사용)
├── .gitignore
└── README.md
```

## 참고

- 본 앱의 해몽은 재미와 위로를 위한 것이며, 의학적·심리적 진단이 아닙니다.
- API 키가 설정되지 않은 상태에서 해몽을 요청하면 안내 메시지(503)가 표시됩니다.
