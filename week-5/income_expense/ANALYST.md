# 💰 가계부 분석 에이전트 (analyst.mjs)

가계부 앱이 쌓은 **똑같은 Supabase DB**(`transactions`, `budgets`)에 접속해서,
말로 물어보면 AI가 직접 SQL을 만들어 조회하고 분석/조언까지 해주는 에이전트입니다.

```
[가계부 앱으로 데이터 쌓기] → [에이전트가 Supabase 접속] → [질문]
   → DB 조회(read-only SQL) + AI 분석 → [맞춤형 답변]
```

## 실행

```bash
cd week-5/income_expense
npm install              # 이미 설치되어 있으면 생략 (pg, dotenv 사용)

# 단발 질문
node analyst.mjs "이번 달 얼마 썼어?"
npm run ask -- "교통비 월평균 얼마야?"

# 대화형 모드 (종료: exit / quit)
node analyst.mjs
```

> 자격증명은 `.env`의 `DATABASE_URL`, `OPENAI_API_KEY`에서만 읽습니다(코드 하드코딩 없음).
> `.env`는 `.gitignore`로 깃에서 제외됩니다.

## 물어볼 수 있는 질문 예시

**기본 조회** — "이번 달 얼마 썼어?", "식비로 가장 많이 쓴 날이 언제야?", "교통비 월평균 얼마야?"
**패턴 분석** — "주중 vs 주말 지출 비교해줘", "요일별로 지출이 가장 많은 날은?", "카테고리별 비율 알려줘"
**절약 조언** — "줄일 수 있는 소비 추천해줘", "이번 달 50만원 예산이면 남은 예산 얼마야?", "이 속도로 쓰면 연말까지 얼마 쓸 것 같아?"

비교를 곁들이면 답이 더 유용합니다: "이번 달 식비 얼마야? 지난달이랑 비교해줘"

## 동작 방식 & 안전장치

- **에이전트 루프**: OpenAI(gpt-4o-mini)의 tool-calling으로 모델이 `run_sql` 도구를 호출 → DB 조회 결과를 다시 모델에 전달 → 자연어 답변. 필요하면 SQL을 여러 번 실행합니다.
- 🔒 **읽기 전용 보장**:
  - `SELECT`/`WITH`로 시작하는 단일 쿼리만 허용
  - `INSERT/UPDATE/DELETE/DROP/ALTER...` 등 변경 키워드 차단
  - `READ ONLY` 트랜잭션 + `statement_timeout` 8초 + 결과 200행 제한

즉 에이전트는 **내 데이터를 읽고 분석만** 하며, 절대 수정하지 않습니다.
