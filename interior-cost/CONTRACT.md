# 인테리어 현장 비용관리 앱 — 공유 API 계약 (server.js ↔ index.html 공통)

> 이 문서는 백엔드/프론트 에이전트가 **반드시 1:1로 맞춰야 하는 계약**이다.
> 단위/형식 불일치가 가장 흔한 버그 → 아래 규칙을 엄수.

## 공통 규칙
- 응답은 **raw JSON** (성공 응답에 `{success,data}` 봉투 쓰지 않음). 단 DELETE 는 `{ "success": true }`.
- 금액(`amount`,`budget` 등)은 **원(KRW) 정수**. pg BIGINT 는 서버에서 `Number()` 변환.
- 모든 DATE 컬럼은 **`to_char(col,'YYYY-MM-DD')` 문자열**로 직렬화 (JS Date 타임존 하루밀림 방지).
- `API_BASE_URL = '/api'` 상대경로. localhost 하드코딩 금지.
- **퍼센트(집행률/진행률)는 프론트에서 직접 계산**한다. 서버가 rate 를 줘도 UI 는 `spent/budget`, `elapsed/total` 로 재계산해 단위혼동을 차단.

## DB 테이블 (Supabase 공유 프로젝트 → prefix `interior_` 로 충돌 방지)

### interior_sites  (현장)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| name | text NOT NULL UNIQUE | 현장명 |
| client | text | 발주처/고객 |
| address | text | 현장 주소 |
| manager | text | 현장 담당자명 |
| budget | bigint CHECK>=0 | 견적비(프로젝트 예산, 원) |
| start_date | date | 착공일 |
| end_date | date | 준공(예정)일 |
| folder | text | 서버가 생성한 현장 폴더 경로(상대) |
| created_at | timestamptz default now() | |

### interior_costs  (비용 내역)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE | |
| date | date NOT NULL | 지출일 |
| amount | bigint NOT NULL CHECK>0 | 금액(원) |
| category | text NOT NULL | 비용 카테고리(아래) |
| process | text | 공정 카테고리(아래) |
| manager | text | 집행 담당자명 |
| vendor | text | 거래처 |
| memo | text | |
| created_at | timestamptz default now() | |

## 카테고리 (셀렉트 옵션)
- **비용 카테고리(category):** 자재비, 인건비, 장비/공구, 운반/물류, 폐기물처리, 가설/안전, 외주(하도급), 경비(식대/유류), 임대료, 기타
- **공정 카테고리(process):** 철거, 설비, 전기, 목공, 미장/방수, 타일, 도장/도배, 바닥, 주방/가구, 욕실, 창호/도어, 조명, 준공/청소, 기타

## 엔드포인트

### 현장
- `GET    /api/sites` → 현장 배열 (created_at 최신순). 각 항목에 위 interior_sites 필드.
- `POST   /api/sites` → body `{name, client, address, manager, budget, start_date, end_date}`.
  - 서버가 `sites/<안전화된 현장명>/receipts/` 폴더를 **실제 생성**하고 `folder` 컬럼에 경로 저장. (현장명 새니타이즈: `/ \ .. : * ? " < > |` 및 제어문자 → `_`, 한글/공백 허용, 앞뒤 공백 trim. 경로 탈출 방지.)
  - name 중복 시 409 + 메시지.
- `PUT    /api/sites/:id` → 동일 필드 수정. (name 변경 시 폴더는 그대로 둬도 됨)
- `DELETE /api/sites/:id` → `{success:true}`. interior_costs 는 CASCADE 삭제. **폴더/파일은 보존**(자료 유실 방지).

### 비용
- `GET    /api/sites/:id/costs` → 해당 현장 비용 배열 (date 최신순, 동일 date면 created_at 최신순).
- `POST   /api/sites/:id/costs` → body `{date, amount, category, process, manager, vendor, memo}` → 생성 row(201).
- `PUT    /api/costs/:id` → 동일 필드 수정, 없으면 404.
- `DELETE /api/costs/:id` → `{success:true}`, 없으면 404.

### 요약/계산 (핵심)
- `GET /api/sites/:id/summary` → 다음 형태:
```json
{
  "budget": 50000000,
  "spent": 12300000,
  "remaining": 37700000,
  "rate": 0.25,
  "byCategory": [{"category":"자재비","total":8000000}],
  "byProcess":  [{"process":"목공","total":5000000}],
  "schedule": {
    "start_date":"2026-06-01","end_date":"2026-08-31",
    "totalDays": 91, "elapsedDays": 27,
    "remainingDays": 64, "progressRate": 0.30, "dday": 64
  }
}
```
  - spent = 해당 현장 비용 합계. remaining = budget - spent. rate = budget>0? spent/budget : null (소수).
  - schedule: totalDays = end-start (일), elapsedDays = clamp(today-start, 0..totalDays), remainingDays = end-today, progressRate = total>0? elapsed/total : null, dday = end_date - today (정수, 양수=남음/음수=초과). 오늘은 서버 CURRENT_DATE 기준.

### 내보내기
- `GET /api/sites/:id/export` → 해당 현장 비용을 CSV로 만들어 `sites/<현장폴더>/costs-export.csv` 에 저장하고, `text/csv; charset=utf-8` 로 응답(파일 다운로드, `Content-Disposition`). **UTF-8 BOM** 붙여 엑셀 한글 안깨지게. 컬럼: 날짜,금액,비용카테고리,공정,담당자,거래처,메모.

## 검증
- amount 양의 정수, category 필수, date 유효한 달력 날짜, start_date<=end_date(권장). 위반 400+메시지.
- :id 숫자 아니면 400. 없는 리소스 404. DB 에러 500+콘솔 로깅.

## 프론트 폴백 (서버 없을 때도 데모 가능)
- 기존 income_expense 패턴처럼 fetch 실패 시 localStorage 폴백. 폴더 생성/CSV 내보내기는 서버 전용이므로, 폴백 모드에선 CSV를 브라우저 Blob 다운로드로 대체. summary/계산은 클라이언트 계산.
