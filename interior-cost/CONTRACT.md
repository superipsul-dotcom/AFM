# 인테리어 현장 비용관리 앱 — 공유 API 계약 (server.js ↔ index.html 공통)

> 이 문서는 백엔드/프론트 에이전트가 **반드시 1:1로 맞춰야 하는 계약**이다.
> 단위/형식 불일치가 가장 흔한 버그 → 아래 규칙을 엄수.
> **v2 에서 일정(캘린더)·견적서·관리(마스터)가 추가됐다. v1 엔드포인트/동작은 100% 그대로 보존한다.**

## 공통 규칙
- 응답은 **raw JSON** (성공 응답에 `{success,data}` 봉투 쓰지 않음). 단 DELETE 는 `{ "success": true }`.
- 금액(`amount`,`budget`,`unit_price`,`planned_cost` 등)은 **원(KRW) 정수**. pg BIGINT 는 서버에서 `Number()` 변환.
- 수량(`qty`)만 소수 허용(numeric). 그 외 금액은 정수.
- 모든 DATE 컬럼은 **`to_char(col,'YYYY-MM-DD')` 문자열**로 직렬화 (JS Date 타임존 하루밀림 방지).
- `API_BASE_URL = '/api'` 상대경로. localhost 하드코딩 금지.
- **퍼센트(집행률/진행률)는 프론트에서 직접 계산**한다. 서버가 rate 를 줘도 UI 는 `spent/budget`, `elapsed/total` 로 재계산해 단위혼동을 차단.
- **견적 금액/세금은 서버가 계산해 `totals` 로 내려주고, 프론트도 동일 공식으로 표시**(아래 계산식 일치).

---

# v1 (기존 — 그대로 유지)

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
| **status** | text default '진행' | **(v2)** 견적/진행/완료/보류 |
| **tags** | text default '' | **(v2)** 자유 태그(콤마구분 문자열) |

### interior_costs  (비용 내역)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE | |
| date | date NOT NULL | 지출일 |
| amount | bigint NOT NULL CHECK>0 | 금액(원) |
| category | text NOT NULL | 비용 카테고리 |
| process | text | 공정 카테고리 |
| manager | text | 집행 담당자명 |
| vendor | text | 거래처 |
| memo | text | |
| created_at | timestamptz default now() | |
| **schedule_id** | bigint REFERENCES interior_schedule(id) ON DELETE SET NULL | **(v2)** 어느 일정(공정 태스크)에 속하는 비용인지. nullable. |

## 카테고리 기본값 (셀렉트 옵션 / interior_categories 시드값)
- **비용 카테고리(cost):** 자재비, 인건비, 장비/공구, 운반/물류, 폐기물처리, 가설/안전, 외주(하도급), 경비(식대/유류), 임대료, 기타
- **공정 카테고리(process):** 철거, 설비, 전기, 목공, 미장/방수, 타일, 도장/도배, 바닥, 주방/가구, 욕실, 창호/도어, 조명, 준공/청소, 기타

## v1 엔드포인트

### 현장
- `GET    /api/sites` → 현장 배열 (created_at 최신순). **(v2) status, tags 필드 포함.**
- `POST   /api/sites` → body `{name, client, address, manager, budget, start_date, end_date, status?, tags?}`.
  - 서버가 `sites/<안전화된 현장명>/receipts/` 폴더를 **실제 생성**하고 `folder` 컬럼에 경로 저장. name 중복 시 409.
- `PUT    /api/sites/:id` → 동일 필드(+status,tags) 수정.
- `DELETE /api/sites/:id` → `{success:true}`. costs/schedule/estimates 는 CASCADE 삭제. **폴더/파일은 보존**.

### 비용
- `GET    /api/sites/:id/costs` → 비용 배열 (date DESC, created_at DESC). **(v2) schedule_id 포함.**
- `POST   /api/sites/:id/costs` → body `{date, amount, category, process, manager, vendor, memo, schedule_id?}` → 201.
- `PUT    /api/costs/:id` → 동일 필드(+schedule_id) 수정, 없으면 404.
- `DELETE /api/costs/:id` → `{success:true}`, 없으면 404.

### 요약/계산
- `GET /api/sites/:id/summary` → (아래 v2 확장 필드 포함):
```json
{
  "budget": 50000000,
  "spent": 12300000,
  "remaining": 37700000,
  "rate": 0.25,
  "byCategory": [{"category":"자재비","total":8000000}],
  "byProcess":  [{"process":"목공","total":5000000}],
  "schedule": { "start_date":"2026-06-01","end_date":"2026-08-31",
    "totalDays":91,"elapsedDays":27,"remainingDays":64,"progressRate":0.30,"dday":64 },

  "estimateTotal": 48000000,
  "byProcessPlan": [{"process":"목공","total":8000000}],
  "scheduleAgg": { "taskCount": 5, "plannedTotal": 30000000, "doneCount": 2 }
}
```
  - spent = 비용 합계. remaining = budget - spent. rate = budget>0? spent/budget : null.
  - **(v2) estimateTotal** = 이 현장의 **확정(confirmed)** 견적 total. 없으면 null.
  - **(v2) byProcessPlan** = 확정 견적의 **공정별 합계**(estimate_items.process GROUP BY, 빈 공정은 '미분류'). 없으면 [].
  - **(v2) scheduleAgg** = `{taskCount, plannedTotal(=Σ planned_cost), doneCount(status='완료' 수)}`. 일정 없으면 0/0/0.

### 내보내기
- `GET /api/sites/:id/export` → 비용 CSV. `sites/<현장폴더>/costs-export.csv` 저장 + UTF-8 BOM + Content-Disposition. 컬럼: 날짜,금액,비용카테고리,공정,담당자,거래처,메모.

---

# v2 확장 — 일정 / 견적 / 관리

## 새 테이블

### interior_staff  (담당자/직원 마스터)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| name | text NOT NULL UNIQUE | 직원명 |
| role | text default '' | 직책(현장소장/기사/디자이너/사무 등) |
| phone | text default '' | 연락처 |
| active | boolean default true | 사용 여부 |
| created_at | timestamptz default now() | |

### interior_vendors  (거래처 마스터)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| name | text NOT NULL UNIQUE | 거래처명 |
| kind | text default '' | 구분(자재상/하도급/장비임대/기타) |
| phone | text default '' | |
| memo | text default '' | |
| active | boolean default true | |
| created_at | timestamptz default now() | |

### interior_categories  (비용/공정 카테고리 — 편집 가능)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| kind | text NOT NULL CHECK (kind IN ('cost','process')) | 분류 |
| name | text NOT NULL | 카테고리명 |
| sort_order | int default 0 | 정렬 |
| active | boolean default true | |
| created_at | timestamptz default now() | |
- UNIQUE(kind, name).
- **시드:** 부팅 시 위 "카테고리 기본값"을 kind별 sort_order 0..N 으로 INSERT (`ON CONFLICT (kind,name) DO NOTHING`). 이미 있으면 무시.

### interior_schedule  (일정 — 공정 단위 태스크)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE | |
| title | text NOT NULL | 작업명(예: 주방 목공) |
| process | text default '' | 공정 카테고리 |
| start_date | date NOT NULL | |
| end_date | date NOT NULL | start<=end |
| status | text default '예정' | 예정/진행/완료/지연 |
| planned_cost | bigint default 0 CHECK>=0 | 계획 비용(원) |
| staff | text default '' | 담당자명 |
| color | text default '' | 캘린더 표시색(hex, 빈값=공정색 자동) |
| memo | text default '' | |
| sort_order | int default 0 | |
| created_at | timestamptz default now() | |

### interior_estimates  (견적서 헤더)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint REFERENCES interior_sites(id) ON DELETE CASCADE | 현장(필수: 현장 종속 생성) |
| title | text NOT NULL default '견적서' | |
| client_name | text default '' | 견적 받는 고객명 |
| client_contact | text default '' | 고객 연락처 |
| estimate_date | date | 견적일 |
| valid_until | date | 유효기간 |
| vat_mode | text default 'exclusive' | exclusive(별도)/inclusive(포함)/none(없음) |
| vat_rate | numeric default 0.10 | 부가세율 |
| discount | bigint default 0 CHECK>=0 | 할인액(원) |
| status | text default 'draft' | draft/confirmed |
| memo | text default '' | 비고/특이사항 |
| created_at | timestamptz default now() | |

### interior_estimate_items  (견적 항목)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| estimate_id | bigint NOT NULL REFERENCES interior_estimates(id) ON DELETE CASCADE | |
| process | text default '' | 공정/구분 |
| name | text NOT NULL | 품목/내역 |
| spec | text default '' | 규격 |
| qty | numeric NOT NULL default 1 CHECK>=0 | 수량 |
| unit | text default '' | 단위(개/m²/식/m/통 등) |
| unit_price | bigint NOT NULL default 0 CHECK>=0 | 단가(원) |
| amount | bigint NOT NULL default 0 | = round(qty*unit_price). **서버 계산 저장.** |
| memo | text default '' | |
| sort_order | int default 0 | 표시 순서 |

### 마이그레이션 규칙
- 새 테이블은 `CREATE TABLE IF NOT EXISTS`. 컬럼 추가(interior_costs.schedule_id, interior_sites.status/tags)는 **`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`** 로 기존 데이터 보존.
- interior_costs.schedule_id FK 는 interior_schedule 생성 **이후** 추가(순서 주의). ADD COLUMN IF NOT EXISTS 후 별도 FK 는 생략 가능(앱 레벨 검증). 단순화를 위해 schedule_id 는 `bigint`(앱에서 검증), 또는 가능하면 FK ON DELETE SET NULL.

## 견적 금액/세금 계산식 (서버·프론트 동일)
```
amount(항목)        = round(qty * unit_price)                  // 정수원
subtotal            = Σ amount
discounted          = max(0, subtotal - discount)
vat_mode = 'exclusive': supplyAmount = discounted
                        vat          = round(discounted * vat_rate)
                        total        = discounted + vat
vat_mode = 'inclusive': total        = discounted
                        supplyAmount = round(total / (1 + vat_rate))
                        vat          = total - supplyAmount
vat_mode = 'none'     : supplyAmount = discounted; vat = 0; total = discounted
```
- 응답 `totals` 객체: `{ subtotal, discount, supplyAmount, vat, total }` (모두 정수원).

## v2 엔드포인트

### 담당자 (staff)
- `GET    /api/staff` → 배열 (active DESC, name ASC). `?all=1` 이면 비활성 포함, 기본은 active만.
- `POST   /api/staff` → `{name, role?, phone?}` → 201. name 중복 409.
- `PUT    /api/staff/:id` → `{name, role, phone, active}` → 200, 없으면 404, 중복 409.
- `DELETE /api/staff/:id` → `{success:true}`, 없으면 404. (실삭제. 비용/일정의 staff 는 텍스트라 영향 없음)

### 거래처 (vendors) — staff 와 동형
- `GET /api/vendors` (`?all=1`), `POST /api/vendors` `{name, kind?, phone?, memo?}`, `PUT /api/vendors/:id` `{name,kind,phone,memo,active}`, `DELETE /api/vendors/:id`.

### 카테고리 (categories)
- `GET    /api/categories` → 항상 객체 `{ "cost":[{id,name,sort_order,active}], "process":[...] }` (각 sort_order ASC, active만; `?all=1` 이면 비활성 포함).
- `POST   /api/categories` → `{kind:'cost'|'process', name}` → 201. UNIQUE(kind,name) 위반 409. kind 값 검증(400).
- `PUT    /api/categories/:id` → `{name?, sort_order?, active?}` → 200, 404.
- `DELETE /api/categories/:id` → `{success:true}`, 404. (기존 비용/일정의 텍스트 값엔 영향 없음)

### 일정 (schedule)
- `GET    /api/sites/:id/schedule` → 해당 현장 일정 배열 (start_date ASC, sort_order ASC, id ASC). 각 항목:
  `{id, site_id, title, process, start_date, end_date, status, planned_cost, actual_cost, staff, color, memo, sort_order, created_at}`
  - **actual_cost** = 이 schedule_id 로 연결된 interior_costs.amount 합계(서버 계산, 정수). 연결 없으면 0.
- `POST   /api/sites/:id/schedule` → `{title, process?, start_date, end_date, status?, planned_cost?, staff?, color?, memo?, sort_order?}` → 201. start<=end 검증(400). 현장 없으면 404.
- `PUT    /api/schedule/:id` → 동일 필드 수정 → 200, 404.
- `DELETE /api/schedule/:id` → `{success:true}`, 404. (연결된 비용의 schedule_id 는 SET NULL → 비용 자체는 보존)
- `GET    /api/sites/:id/schedule.ics` → **text/calendar** 다운로드(현장 일정 전체). all-day VEVENT: `DTSTART;VALUE=DATE`, `DTEND;VALUE=DATE`(종료일+1, exclusive), `SUMMARY=[공정] title`, `DESCRIPTION`(담당자/상태/계획비용/메모). UID 안정값(`schedule-<id>@interior-cost`). Content-Disposition 파일명 `<현장명>-schedule.ics`. (프론트는 이 URL 우선, 실패 시 클라이언트가 동일 포맷으로 Blob 생성)

### 비용 (확장)
- POST/PUT 비용 body 에 `schedule_id`(nullable, 정수문자열/숫자/null) 허용. 값이 있으면 **같은 현장의 schedule** 인지 검증 → 아니면 400 또는 null 처리(권장: 같은 현장 아니면 400 `잘못된 일정 연결`). 응답 cost 에 `schedule_id` 포함(없으면 null).

### 견적 (estimates)
- `GET    /api/sites/:id/estimates` → 현장 견적 **헤더 목록** (created_at DESC). 각 항목: 헤더 필드 + `totals`(subtotal/discount/supplyAmount/vat/total) + `itemCount`. (items 본문은 미포함, 가벼운 목록)
- `GET    /api/estimates/:id` → `{ ...헤더, items:[항목 sort_order ASC], totals }` (상세).
- `POST   /api/sites/:id/estimates` → body `{title?, client_name?, client_contact?, estimate_date?, valid_until?, vat_mode?, vat_rate?, discount?, memo?, items:[{process?,name,spec?,qty,unit?,unit_price,memo?,sort_order?}]}` → 201 (헤더+항목 **트랜잭션** 생성, 각 amount 서버 계산). 현장 없으면 404. name 항목 필수.
- `PUT    /api/estimates/:id` → 동일 body. **items 는 전체 교체**(기존 삭제 후 재삽입, 트랜잭션). status 가 confirmed 여도 편집 허용(편집 후 재확정 필요). → 200, 404.
- `DELETE /api/estimates/:id` → `{success:true}`, 404. (items CASCADE)
- `POST   /api/estimates/:id/confirm` → `status='confirmed'` 로 바꾸고, **site_id 있으면 `interior_sites.budget = totals.total`** 로 UPDATE. 응답 `{ estimate: {...상세}, site: {...갱신된 현장} }`. (재확정 가능 — 금액 바뀌면 예산도 다시 맞춰짐)
- `POST   /api/estimates/:id/unconfirm` → `status='draft'`. budget 은 **되돌리지 않음**(이미 계약/집행 중일 수 있어 보존). 응답 `{estimate}`.

## 검증
- 금액(amount/budget/unit_price/planned_cost) 정수≥0, 비용 amount>0. qty≥0 수, date 유효 달력 날짜.
- 견적: items 비어도 생성 허용(빈 견적 초안). name 있는 항목만 유효, name 없는 항목은 400 또는 skip(권장: name 없으면 400).
- start_date<=end_date(현장/일정). :id 숫자 아니면 400. 없는 리소스 404. UNIQUE 위반 409. DB 에러 500+콘솔 로깅.

## 프론트 폴백 (서버 없을 때도 데모 가능)
- 기존 income_expense/v1 패턴처럼 fetch 실패(`e.status` 없음)면 localStorage 폴백. `e.status` 가 있으면(서버 응답 에러) 폴백 안 하고 throw.
- 새 도메인(staff/vendors/categories/schedule/estimates)도 각각 localStorage 키로 폴백 CRUD + 클라이언트 계산(견적 totals, schedule actual_cost, summary byProcessPlan/estimateTotal/scheduleAgg).
- 카테고리 폴백 기본값 = 위 "카테고리 기본값". 폴더 생성/CSV/.ics 서버저장은 서버 전용 → 폴백은 Blob 다운로드.

## UI 정보구조 (프론트)
- 상단 **현장 선택 바**(전역 컨텍스트) 유지. 그 아래 **탭**: `📊 요약` · `💸 비용` · `📅 일정` · `📋 견적` · `⚙️ 관리`.
- 요약/비용/일정/견적 = 선택 현장 종속. **관리 = 전역**(담당자/거래처/카테고리/현장 마스터).
- 비용·일정 입력의 담당자/거래처/카테고리는 마스터 기반 **드롭다운**(직접입력 옵션도 허용 — 마스터에 없으면 자유입력 fallback). 일정 태스크에 비용을 연결(schedule_id) 가능.
- 견적 탭: 견적 목록 + 에디터(항목 표 그리드, 행추가/삭제/순서, 실시간 합계/VAT) + **인쇄(window.print, A4 견적서 레이아웃)** + **확정** 버튼(→ 예산 연동, 요약 탭에 견적 대비 실적 반영).

---

# v3 확장 — 실무 견적 엔진 (공종 · 재료/노무/부자재 3분할 · 원가계산서 · 단가 카탈로그)

> 안도공간 **실제 견적서(.xlsm)** 를 반영. **v1·v2 의 동작/엔드포인트/스키마/UI 는 100% 보존**한다(컬럼 추가는 `ADD COLUMN IF NOT EXISTS`, 새 테이블은 `CREATE TABLE IF NOT EXISTS`). 견적을 "단순 단가" → "재료/노무/부자재 3분할 + 원가계산서 가산" 으로 확장하되, **기존 단순 모드도 그대로 동작**(use_cost_buildup=false 가 기본).

## 새 테이블: interior_catalog (단가 카탈로그 / price book)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| trade | text NOT NULL | 공종(21종 중 하나) |
| grp | text default '' | 공사내용(공종 내 하위 그룹) |
| name | text NOT NULL | 품목/상세내용(표시명) |
| unit | text default '' | 단위(M2/식/EA/M/대/인 등) |
| material_price | bigint default 0 | 재료비 단가(원) |
| labor_price | bigint default 0 | 노무비 단가(원) |
| sub_price | bigint default 0 | 부자재 단가(원) |
| product_name | text default '' | 품명(제품 스펙) |
| vendor | text default '' | 업체명 |
| code | text default '' | CODE(카테고리코드: WOOD/TILE/LIGHT 등) |
| active | boolean default true | |
| created_at | timestamptz default now() | |
- **시드:** 부팅 시 `seed/catalog.json` 의 `catalog`(562항목)을 읽어, **`interior_catalog` 가 비어 있을 때만**(`SELECT count(*)==0`) bulk INSERT(트랜잭션, 한 번에). `__dirname` 기준 `path.join(__dirname,'seed','catalog.json')`. UNIQUE 제약 없음(동일명 항목 존재 가능).
- **공종 마스터:** 서버 상수 `TRADE_MASTER`(=`catalog.json.trade_master` 21종 하드코딩)로 둔다. `interior_categories` 는 **건드리지 않는다**(CHECK 제약 변경 불필요). `GET /api/catalog/trades` 가 이 상수를 반환.

## interior_estimate_items 확장 (전부 ADD COLUMN IF NOT EXISTS)
- `trade text default ''` (공종, 그룹/소계 기준)
- `material_price bigint default 0`, `labor_price bigint default 0`, `sub_price bigint default 0`
- `catalog_id bigint` (nullable, 출처 카탈로그 id)
- **호환:** `unit_price`/`amount` 유지. 항목 저장 시 **3분할 중 하나라도 입력되면** `unit_price = material_price+labor_price+sub_price`(합산단가) 로 서버가 세팅하고 `amount = round(qty*unit_price)`. 3분할이 전부 0 이고 `unit_price` 만 들어오면 **기존 v2 동작 그대로**(amount=round(qty*unit_price)). 둘 다 서버 계산.

## interior_estimates 확장 (전부 ADD COLUMN IF NOT EXISTS) — 원가계산서 가정값
| 컬럼 | 기본값 | 의미(견적서 근거) |
|---|---|---|
| use_cost_buildup | boolean false | 원가계산서 모드 on/off |
| indirect_material_rate | numeric 0.025 | 간접재료비 = 직접재료비 × 2.5% |
| indirect_labor_rate | numeric 0.03 | 간접노무비 = 직접노무비 × 3% |
| safety_insurance_rate | numeric 0.038 | 산재보험료 = 노무비 × 3.8% |
| employment_insurance_rate | numeric 0.0087 | 고용보험료 = 노무비 × 0.87% |
| safety_mgmt_rate | numeric 0.024 | 안전관리비 = (재료비+직접노무비) × 2.4% |
| other_expense_rate | numeric 0.01 | 기타경비 = (재료비+노무비) × 1% |
| admin_rate | numeric 0.07 | 일반관리비 = 순공사원가 × 7% |
| design_rate | numeric 0.05 | 디자인비용 = 순공사원가 × 5% |
| profit_rate | numeric 0.12 | 회사이윤 = 순공사원가 × 12% |
| round_unit | bigint 0 | 제안가 라운딩 단위(0=라운딩없음, 예 1000000) |

## 원가계산서 산출식 (서버·프론트 **반드시 동일**) — use_cost_buildup=true 일 때
실제 견적서 샘플(제안가 165,000,000)과 원 단위까지 검증된 식. 모든 round 는 정수 반올림.
```
directMaterial = Σ round(qty * material_price)      // 직접재료비
directLabor    = Σ round(qty * labor_price)         // 직접노무비
subMaterial    = Σ round(qty * sub_price)           // 부자재(3)
indirectMaterial = round(directMaterial * indirect_material_rate)   // 간접재료비
indirectLabor    = round(directLabor    * indirect_labor_rate)      // 간접노무비
materialSum = directMaterial + indirectMaterial      // 재료비 소계
laborSum    = directLabor    + indirectLabor          // 노무비 소계
safetyIns  = round(laborSum * safety_insurance_rate)          // 산재보험료
employIns  = round(laborSum * employment_insurance_rate)      // 고용보험료
safetyMgmt = round((materialSum + directLabor) * safety_mgmt_rate)  // 안전관리비
otherExp   = round((materialSum + laborSum)   * other_expense_rate) // 기타경비
expenseSum = subMaterial + safetyIns + employIns + safetyMgmt + otherExp  // 경비 소계
primeCost  = materialSum + laborSum + expenseSum      // 순공사원가 합계
admin   = round(primeCost * admin_rate)              // 일반관리비
design  = round(primeCost * design_rate)             // 디자인비용
profit  = round(primeCost * profit_rate)             // 회사이윤
constructionTotal = primeCost + admin + design + profit   // 공사비합계
afterDiscount = max(0, constructionTotal - discount)
proposed = round_unit>0 ? Math.floor(afterDiscount / round_unit) * round_unit : afterDiscount  // 제안가
// VAT 는 proposed 기준으로 기존 vat_mode 식 적용:
//   exclusive: supplyAmount=proposed; vat=round(proposed*vat_rate); total=proposed+vat
//   inclusive: total=proposed; supplyAmount=round(proposed/(1+vat_rate)); vat=total-supplyAmount
//   none     : supplyAmount=proposed; vat=0; total=proposed
```
- 응답 `totals` 는 기존 키(`subtotal, discount, supplyAmount, vat, total`) 유지 + **`buildup` 객체 추가**(use_cost_buildup=true 일 때만; false 면 buildup=null, 기존 v2 그대로):
  `buildup = { directMaterial, indirectMaterial, materialSum, directLabor, indirectLabor, laborSum, subMaterial, safetyIns, employIns, safetyMgmt, otherExp, expenseSum, primeCost, admin, design, profit, constructionTotal, proposed }`
  - use_cost_buildup=true: `subtotal = Σ amount`(= directMaterial+directLabor+subMaterial 와 동일), `supplyAmount/vat/total` 은 **proposed** 기준.
- `confirm` → `interior_sites.budget = totals.total`(모드 무관, 기존과 동일).

## 새 엔드포인트 (카탈로그)
- `GET /api/catalog?trade=&q=&limit=200` → 카탈로그 배열. `trade` 정확일치 필터(옵션), `q` 는 name/grp/product_name/vendor 부분일치(ILIKE, 옵션), 기본 active만(`?all=1` 비활성 포함), limit 기본 200·최대 1000. 정렬 trade, name. 각 항목: 위 컬럼 전부(가격은 Number).
- `GET /api/catalog/trades` → `["가설공사", ...]` (서버 상수 TRADE_MASTER 21종, 정해진 순서).
- `POST /api/catalog` → `{trade,name,unit?,material_price?,labor_price?,sub_price?,grp?,product_name?,vendor?,code?}` → 201. trade·name 필수(400).
- `PUT /api/catalog/:id` → 동일 필드(+active) → 200/404.
- `DELETE /api/catalog/:id` → `{success:true}`/404 (실삭제; 견적 항목은 값 복사본이라 영향 없음).

## 견적 엔드포인트 변경 (호환 확장, 시그니처 유지)
- `POST/PUT /api/sites/:id/estimates`·`/api/estimates/:id` body:
  - 헤더에 `use_cost_buildup?` + 위 11개 rate/round 필드 허용(미전달 시 DEFAULT).
  - `items[]` 에 `trade?, material_price?, labor_price?, sub_price?, catalog_id?` 허용(기존 process/name/spec/qty/unit/unit_price/memo/sort_order 와 공존).
- `GET /api/estimates/:id`, `GET /api/sites/:id/estimates` 의 totals 에 buildup 포함, items 에 trade/3분할 포함.

## UI (견적 탭 업그레이드 — 기존 탭/레이아웃 유지하고 견적 에디터만 확장)
- 견적 에디터 항목 행: **공종(드롭다운 21)·품목·규격·단위·수량·재료비단가·노무비단가·부자재단가·행합계**. 행합계 = `qty*(material+labor+sub)`.
- **[단가 카탈로그 불러오기]** 버튼 → 모달(공종 필터 + 검색창, 562항목 페이지네이션/스크롤) → 항목 클릭 시 현재 행(또는 새 행)에 공종/품목/단위/3분할단가/`catalog_id` 자동 채움. 수량만 입력하면 됨.
- **공종별 그룹 소계**(총괄표 역할) 표시.
- **원가계산서 패널**: `use_cost_buildup` 토글 + 11개 가정율 입력 → 실시간 계산표(공사원가계산서 레이아웃: 직접재료/간접재료/.../순공사원가/일반관리비/디자인/이윤/공사비합계/제안가/VAT/총합계). 프론트 계산식 = 위 산출식과 1:1.
- **인쇄(A4)**: 항목표 + 공종 소계 + (모드면) 원가계산 요약. 확정→예산 연동 유지.
- **관리 탭**: **단가 카탈로그 관리** 섹션 추가(목록/검색/추가/수정/삭제) + 공종(trade) 카테고리 편집.
- 폴백: 카탈로그/견적 buildup 도 localStorage 폴백 지원(서버 우선). 데모는 서버 연결 가정.

---

# v4 확장 — 프로젝트 매니지먼트 (노션 "프로젝트 DB" 구조)

> 안도공간 **Notion 프로젝트 DB** 를 본떠, `interior_sites`(현장)를 **프로젝트** 엔티티로 승격. 노션식 속성 + **현장진행상태 워크플로(준비→착수→완료→마감→인수)** + **프로젝트 보드(상태별 칸반)/테이블 뷰** + **프로젝트 헤더 + 인력관리**. **v1·v2·v3 동작/엔드포인트/UI 100% 보존**(컬럼 추가는 ADD COLUMN IF NOT EXISTS). 기존 `status`(견적/진행/완료/보류)·`tags` 는 그대로 두고, 새 `progress_status` 가 노션 워크플로의 주(主) 상태가 된다.

## interior_sites 확장 (전부 ADD COLUMN IF NOT EXISTS)
| 컬럼 | 타입 | 설명(노션 속성 대응) |
|---|---|---|
| building_type | text default '' | 건물 종류(아파트/빌라/주택/상가/오피스/카페/사무실/기타) |
| floor_area | numeric default 0 | 바닥면적(m²) |
| move_in_date | date | 입주 예정일 |
| pm | text default '' | PM(담당자명) |
| construction_manager | text default '' | 시공책임(담당자명) |
| designer | text default '' | 디자이너(담당자명) |
| progress_status | text default '준비' | 현장진행상태 — **준비/착수/완료/마감/인수** 중 하나 |
- 기존 컬럼(name, client, address, manager, budget, start_date, end_date, folder, status, tags) 유지. start_date~end_date = 공사기간.
- 서버 상수 `PROGRESS_STATES = ['준비','착수','완료','마감','인수']`. PUT/POST 에서 progress_status 검증(목록 외 값 400 또는 '준비'로 보정).

## 엔드포인트 (현장=프로젝트, 호환 확장)
- `GET /api/sites` → 기존 필드 + **신규 7컬럼** + **경량 롤업** 추가: 각 현장에 `spent`(Σ interior_costs.amount, 정수), `estimateTotal`(confirmed 견적 total, 없으면 null). **N+1 금지** — LEFT JOIN/서브쿼리로 한 쿼리. (집행률은 프론트가 spent/budget 로 계산)
- `POST /api/sites`·`PUT /api/sites/:id` → body 에 building_type, floor_area, move_in_date, pm, construction_manager, designer, progress_status 허용(미전달 시 기본값/기존값 유지). 응답에 신규 필드 포함. (폴더 생성·name 중복 409 등 기존 동작 유지)
- `PATCH /api/sites/:id/status` (선택; 보드 드래그용) → body `{progress_status}` → 200/404/400. (또는 기존 PUT 로 처리해도 무방 — 프론트가 PUT 으로 progress_status 만 갱신하면 됨. 구현 단순화를 위해 **별도 PATCH 없이 PUT 재사용** 권장)
- `GET /api/sites/:id/summary` → 기존 응답에 프로젝트 헤더용으로 신규 필드 포함되도록(이미 site row 를 참조하면 자동). 변경 최소.

## UI — 프로젝트 보드 + 헤더 + 인력 (기존 5탭 보존, 탭 추가)
- **새 탭 `🗂 프로젝트`(전역, 맨 왼쪽)**: 모든 현장(프로젝트)을 노션 DB처럼 표시.
  - **칸반 보드(기본)**: `progress_status` 5단계(준비/착수/완료/마감/인수) 컬럼. 각 카드 = 프로젝트명·건물종류·바닥면적·공사기간·PM·**집행률 막대(spent/budget)**·status 뱃지. 카드 클릭 → 해당 현장 선택(전역 컨텍스트 set) + `📊 요약` 탭으로 이동. 카드의 상태 변경(드롭다운 또는 드래그 → PUT progress_status).
  - **테이블 뷰 토글**: 컬럼 = 프로젝트명/주소/건물종류/면적/입주예정일/공사기간/진행상태/PM/시공책임/디자이너/예산/집행/집행률. 정렬/상태 필터.
  - **+ 새 프로젝트** = 기존 현장 등록 폼(아래 확장본).
- **현장 등록/수정 폼 확장**: 기존 필드 + 건물종류(드롭다운)·바닥면적·입주예정일·**PM/시공책임/디자이너(담당자 마스터 드롭다운, 자유입력 fallback)**·진행상태(준비~인수). status/tags 도 유지.
- **`📊 요약` 탭 상단에 프로젝트 헤더 카드**: 프로젝트명 + 진행상태 뱃지(준비~인수) + 건물종류·바닥면적·주소·공사기간·입주예정일 + **인력(PM/시공책임/디자이너)**. (노션 프로젝트 페이지 상단 느낌)
- **인력관리 섹션**(요약 또는 관리): PM/시공책임/디자이너(담당자 마스터에서 지정) + **공종별 협력업체**(해당 현장 비용/견적에서 쓰인 vendor 목록을 공종/거래처로 묶어 표시). 신규 테이블 없이 기존 staff/vendors/costs 로 구성.
- 진행상태 뱃지 색: 준비(회색)/착수(파랑)/완료(초록)/마감(주황)/인수(보라) — 노션 색감 참고.
- 폴백(localStorage): 신규 필드/보드/롤업도 폴백 지원(서버 우선). spent/estimateTotal 폴백은 클라이언트 집계.

## 다음 단계(이번 v4 범위 밖, 메모): 노션의 리드/고객DB·발주서DB·미팅·AS 관계형 서브-DB 연동.

---

# v5 확장 — 노션 관계형 서브-DB (고객/리드 · 발주서 · 미팅 · AS)

> 노션 프로젝트 DB의 연결 데이터베이스를 구현. **v1~v4 동작/엔드포인트/UI 100% 보존**(새 테이블 CREATE IF NOT EXISTS, 컬럼 추가 ADD COLUMN IF NOT EXISTS). 고객/리드는 **전역 마스터**(staff/vendors와 동형, 프로젝트가 참조), 발주서·미팅·AS는 **프로젝트(현장) 종속**(site_id FK, CASCADE). 모든 응답 raw JSON, DELETE만 `{success:true}`, BIGINT→Number, DATE→`to_char 'YYYY-MM-DD'`. 폴백(localStorage) 지원.

## 새 테이블

### interior_clients (고객/리드 — 전역 마스터)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| name | text NOT NULL | 고객/리드명 |
| phone | text default '' | 연락처 |
| email | text default '' | |
| source | text default '' | 리드 출처(소개/홈페이지/광고/재방문/기타) |
| status | text default '리드' | 리드/상담/견적/계약/시공중/완료/보류 |
| address | text default '' | |
| memo | text default '' | |
| active | boolean default true | |
| created_at | timestamptz default now() | |
- `interior_sites` 에 `ADD COLUMN IF NOT EXISTS client_id bigint` (nullable, → interior_clients.id, FK 생략 가능·앱검증). 기존 `client` 텍스트 유지.
- 서버 상수 `CLIENT_STATES=['리드','상담','견적','계약','시공중','완료','보류']`.

### interior_orders (발주서 — 프로젝트 종속)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE | |
| order_no | text default '' | 발주번호(서버가 생성 시 `'PO-'+id` 자동 세팅) |
| vendor | text default '' | 거래처 |
| trade | text default '' | 공종 |
| title | text NOT NULL | 발주 품목/내역 |
| amount | bigint default 0 CHECK>=0 | 발주 금액(원) |
| order_date | date | 발주일 |
| due_date | date | 납기일 |
| status | text default '대기' | 대기/발주/입고/정산완료 |
| memo | text default '' | |
| created_at | timestamptz default now() | |
- 서버 상수 `ORDER_STATES=['대기','발주','입고','정산완료']`.

### interior_meetings (미팅 — 프로젝트 종속)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE | |
| meeting_date | date | 미팅일 |
| title | text NOT NULL | 제목 |
| attendees | text default '' | 참석자 |
| content | text default '' | 내용 |
| next_action | text default '' | 다음 액션 |
| created_at | timestamptz default now() | |

### interior_as (AS — 프로젝트 종속)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE | |
| received_date | date | 접수일 |
| title | text NOT NULL | 내용/제목 |
| detail | text default '' | 상세 |
| status | text default '접수' | 접수/처리중/완료/보류 |
| handled_date | date | 처리완료일 |
| staff | text default '' | 담당자 |
| cost | bigint default 0 CHECK>=0 | AS 비용(원) |
| created_at | timestamptz default now() | |
- 서버 상수 `AS_STATES=['접수','처리중','완료','보류']`.

## 엔드포인트
### 고객/리드 (전역, staff/vendors 동형)
- `GET /api/clients` (active만, `?all=1` 비활성 포함, status ASC?·name ASC). `POST /api/clients` `{name, phone?, email?, source?, status?, address?, memo?}` → 201(name 필수). `PUT /api/clients/:id` (+active). `DELETE /api/clients/:id` → `{success:true}`/404. (삭제 시 interior_sites.client_id 는 앱에서 null 처리하거나 그대로 — 단순화: 그대로 두고 프론트가 못 찾으면 미표시)

### 발주서 (프로젝트 종속)
- `GET /api/sites/:id/orders` → 배열(order_date DESC, id DESC). `POST /api/sites/:id/orders` `{vendor?,trade?,title,amount?,order_date?,due_date?,status?,memo?}` → 201(title 필수, 현장 없으면 404, **order_no='PO-'+id 자동**). `PUT /api/orders/:id` → 200/404. `DELETE /api/orders/:id`.
- status 검증(ORDER_STATES 외 '대기' 보정). amount 정수≥0.

### 미팅 (프로젝트 종속)
- `GET /api/sites/:id/meetings` (meeting_date DESC). `POST /api/sites/:id/meetings` `{meeting_date?,title,attendees?,content?,next_action?}` → 201(title 필수). `PUT /api/meetings/:id`. `DELETE /api/meetings/:id`.

### AS (프로젝트 종속)
- `GET /api/sites/:id/as` (received_date DESC). `POST /api/sites/:id/as` `{received_date?,title,detail?,status?,handled_date?,staff?,cost?}` → 201(title 필수, status AS_STATES 보정). `PUT /api/as/:id`. `DELETE /api/as/:id`.

### 현장 연동
- `POST/PUT /api/sites` body 에 `client_id?`(정수/null) 허용. `GET /api/sites`·`GET /api/sites/:id/summary` 응답에 `client_id` + **`client_name`**(interior_clients JOIN, 없으면 null) 포함.
- (선택) `GET /api/sites/:id/summary` 에 `orderCount, meetingCount, asCount, asOpenCount`(상태≠완료) 카운트 추가 — 프로젝트 헤더 뱃지용.

## UI
- **관리 탭에 `고객/리드` 마스터 섹션** 추가(목록/검색/추가/수정/삭제 + status 뱃지, staff/vendors 섹션과 동형).
- **현장 등록/수정 폼**: `고객/리드` 드롭다운(client_id, interior_clients에서 선택; 자유입력 client 텍스트도 유지). **요약 프로젝트 헤더에 고객명 표시**(client_name).
- **새 탭 `🧾 발주`(프로젝트 종속)**: 발주서 목록(발주번호·거래처·공종·품목·금액·발주일·납기일·상태뱃지) + 행 추가/수정/삭제 + 상태별 색·합계. (거래처=vendors, 공종=trades 드롭다운 재사용)
- **새 탭 `📒 미팅·AS`(프로젝트 종속)**: 상단 서브토글 2개 — **미팅**(일자·제목·참석자·내용·다음액션, 타임라인/목록 CRUD) / **AS**(접수일·내용·상태·처리일·담당자·비용, 목록 CRUD + 상태뱃지). 담당자=staff 드롭다운.
- 탭 순서: 🗂 프로젝트 · 📊 요약 · 💸 비용 · 📅 일정 · 📋 견적 · 🧾 발주 · 📒 미팅·AS · ⚙️ 관리.
- 상태 뱃지 색감(노션풍): 고객(리드 회색→계약 파랑→완료 초록), 발주(대기 회색/발주 파랑/입고 청록/정산완료 초록), AS(접수 빨강/처리중 주황/완료 초록).
- 폴백(localStorage): 4개 도메인 각각 키로 CRUD + 현장 client_id 연결. 서버 우선.

---

# v6 확장 — 현장 운영 강화 1차 (진행/완료 분리 · 견적 공종그룹/임시저장 · 캘린더 드래그/PDF · 일정 선후관계)

> 사용자 실무 요청 1차 묶음. **v1~v5 동작/엔드포인트/UI 100% 보존**(새 테이블 CREATE TABLE IF NOT EXISTS, 컬럼 ADD COLUMN IF NOT EXISTS).
> 분담: **6-2(견적)·6-3(캘린더)는 순수 프론트**(서버/DB 무변경). **6-1(진행/완료)·6-4(일정 선후관계)는 서버+프론트**.

## 6-1. 프로젝트 진행/완료 분리 + 보관 (⑨ 일부 — zip 백업은 v7)
### interior_sites 확장 (ADD COLUMN IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| archived | boolean NOT NULL default false | 보관(아카이브) 여부. true면 진행중 목록/보드에서 숨김 |
- progress_status(준비/착수/완료/마감/인수)와 **독립**. 보관은 사용자가 명시적으로 토글(자동분류 안 함). UI는 progress_status='인수'/'마감'을 "완료" 그룹으로 시각 구분할 수 있음.
### 엔드포인트 (호환 우선)
- `GET /api/sites` → **기존처럼 전체 반환(동작 불변)** + 각 행에 `archived`(boolean) 필드 추가. (기존 프론트/회귀 안전. 진행중/보관 분리는 프론트가 archived로 수행)
- `POST /api/sites`·`PUT /api/sites/:id` → body 에 `archived`(boolean) 허용. 미전달 시 기존값/false 유지.
### UI (🗂 프로젝트 탭)
- 보드/테이블 상단에 **[진행중] / [완료·보관] 토글**(기본 진행중 = archived=false). 각 카드에 **보관/복원 버튼**(PUT archived 토글). progress_status '인수'/'마감' 카드는 "완료" 톤으로 구분 표시. "정신사납지 않게" 완료 프로젝트는 기본 화면에서 빠지고 [완료·보관] 토글에서만 보임.

## 6-2. 견적 공종 그룹/페이지 + 임시저장 (⑤ — 순수 프론트, 서버/DB 무변경)
- 견적 에디터 항목을 **공종(trade)별 접기 섹션(accordion)** 으로 묶기 + 상단 **공종 점프 칩 네비**(클릭 시 해당 그룹으로 스크롤/펼침). 공종별 소계(v3 기존) 유지.
- **작성 중 자동 임시저장**: 에디터 입력값(헤더+items)을 디바운스로 localStorage 저장. 키 `interior_estimate_draft_<siteId>_<estimateId|new>`. 에디터 진입 시 draft 있으면 **"임시저장 복원하시겠어요?"** 안내(복원/무시). 서버 저장(POST/PUT) 성공 시 해당 draft 삭제. **[임시저장]** 버튼(수동)도 제공.
- 인쇄(A4): **공종별 페이지 분할** 옵션 토글(on이면 공종 그룹마다 `page-break-before`). 기존 견적 인쇄/원가계산 레이아웃 유지.

## 6-3. 캘린더 드래그 일정생성 + 일정표 PDF (② — 순수 프론트, 기존 schedule API 사용)
- ScheduleTab 월간 캘린더: 날짜 셀에서 **mousedown→mousemove→mouseup 드래그**로 기간 선택(드래그 중 하이라이트, 역방향도 start≤end 정규화) → 마우스 업 시 **일정 생성 폼에 start_date/end_date 프리필**(모달/인라인 오픈). 단일 클릭 = 하루 일정.
- **일정표 인쇄/PDF**: ScheduleTab 상단 **[일정표 PDF]** 버튼 → window.print + @media print A4. 헤더(현장명·공사기간) + **일정 리스트(또는 간트형 막대 표)**: 작업명/공종/기간/상태/담당자. 견적 인쇄 CSS 패턴 재사용.

## 6-4. 일정 선후관계(의존성) + 딜레이 연쇄이동 (③ — 서버+프론트)
### 새 테이블 interior_schedule_deps (CREATE TABLE IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| predecessor_id | bigint NOT NULL REFERENCES interior_schedule(id) ON DELETE CASCADE | 선행 일정(이게 끝나야) |
| successor_id | bigint NOT NULL REFERENCES interior_schedule(id) ON DELETE CASCADE | 후행 일정(시작) |
| created_at | timestamptz default now() | |
- **UNIQUE(predecessor_id, successor_id)**. 자기참조 금지(pred≠succ, 400). **사이클 금지**(추가 시 succ→...→pred 경로 있으면 400). 같은 현장 일정끼리만(다르면 400). 인덱스: predecessor_id, successor_id.
### 엔드포인트
- `GET /api/sites/:id/schedule` → 각 일정에 `predecessors:[id...]`(이 일정의 선행들), `successors:[id...]`(후행들) 추가. (현장 전체 dep 1회 조회 후 매핑, N+1 금지)
- `POST /api/schedule/:id/deps` → body `{predecessor_id}` (`:id` = successor). 선행 추가. 검증(같은현장/자기참조/사이클/중복 UNIQUE 409 or 멱등). → 201 `{id, predecessor_id, successor_id}`.
- `DELETE /api/schedule/:id/deps/:predId` → (`:id`=successor, `:predId`=predecessor) 링크 삭제 → `{success:true}`/404.
- **연쇄이동**: `PUT /api/schedule/:id` 에 옵션 플래그 `cascade`(body `cascade:true`, 기본 false=기존 동작 그대로). cascade=true 이고 start_date/end_date 가 바뀌면:
  - `delta = 새 start_date − 기존 start_date`(일수). 트랜잭션으로 **모든 transitive successor**(BFS/DFS, 사이클 안전·방문체크)의 start_date/end_date 를 각각 `+delta` shift. 본 일정은 요청대로 갱신.
  - 응답에 `shifted:[{id, start_date, end_date}]`(본 일정 제외, 이동된 후속들) 포함. cascade=false 면 shifted=[] (또는 키 없음).
- 날짜 직렬화는 기존 규칙(`to_char 'YYYY-MM-DD'`). delta 계산은 UTC 자정 기준 일수 차.
### UI (ScheduleTab)
- 일정 항목/상세에 **선행·후행 표시 + [선행 추가]/[삭제]**(같은 현장 다른 일정 선택 드롭다운). **"선후관계 리스트" 뷰**(predecessor → successor 목록).
- 일정 날짜 수정 시 **"연결된 후속 일정도 함께 이동"(cascade) 체크** → PUT cascade=true. 성공 토스트 "후속 N개 함께 이동". 캘린더/막대에 의존 화살표/표식(가능하면).
- 폴백(localStorage): deps 키(`interior_schedule_deps_v1`) CRUD + 클라이언트 연쇄계산(같은 delta shift, 사이클 가드).

## 검증
- **6-4**: 철거(6/1~6/3)→전기(6/4~6/6) 선행링크 후, 철거를 6/3~6/5로 PUT(cascade=true) → 전기가 6/6~6/8 로 자동 이동(shifted 1건). 자기참조/사이클 추가 시 400. cascade=false 면 전기 불변(기존 동작).
- **6-1**: PUT archived=true → 기본 보드에서 숨김, [완료·보관] 토글에서 보임, 복원 가능. `GET /api/sites` 는 여전히 전체+archived 필드(회귀).
- **6-2/6-3**(프론트): 드래그 기간 프리필, 임시저장 복원/삭제, 공종 그룹 접기·페이지분할 인쇄, 일정표 PDF 출력.
- **v1~v5 회귀 무손상**(엔드포인트/totals/탭/폴더/CSV/.ics/카탈로그/서브DB).

---

# v7 확장 — 영수증 카메라 자동기입 (① OpenAI 비전 OCR)

> 비용 입력 시 영수증을 카메라로 촬영/업로드 → **OpenAI 비전(gpt-4o)** 이 **금액·날짜는 정확 추출**, **카테고리는 영수증 내용으로 추론(틀릴 수 있음 → 담당자가 쉽게 수정)** → 비용 폼 프리필. **v1~v6 동작/엔드포인트/UI 100% 보존**(새 엔드포인트만 추가, 새 패키지 설치 없음).

## 서버 (server.js)
- **패키지 추가 없음.** Node 18+ 내장 `fetch` 로 OpenAI REST 직접 호출. 키는 `process.env.OPENAI_API_KEY`(.env 에 이미 있음).
- **`express.json()` 본문 한도 상향**: 영수증 base64 가 크므로 JSON 파서 `limit` 을 `'15mb'` 로(기존 미들웨어 수정; 다른 라우트 영향 없음).
- **`POST /api/receipts/analyze`** body `{ image: "data:image/jpeg;base64,...", site_id? }`:
  - `interior_categories`(kind='cost') 목록을 조회해 프롬프트에 포함(현재 카테고리에 맞춰 추론).
  - OpenAI **Chat Completions**(model `gpt-4o`, `response_format {type:'json_object'}`, 이미지 = image_url 에 data URI). 시스템 지시: "한국 인테리어 현장 영수증. **amount(정수 원, 합계/총액), date(YYYY-MM-DD, 없으면 빈문자)** 는 정확히. **category 는 주어진 비용 카테고리 목록 중 가장 가까운 1개**(불명확하면 '기타'). vendor(상호), memo(주요 품목 요약), confidence(0~1)." 
  - 응답 raw JSON `{ amount, date, category, vendor, memo, confidence, model }`. amount 는 Number(정수), date 는 'YYYY-MM-DD' 또는 ''. 
  - **`OPENAI_API_KEY` 없으면 503** `{error:'OPENAI_API_KEY 미설정'}`. image 없으면 400. OpenAI 호출 실패/파싱 실패 502 `{error,detail}`. 
  - **(선택) site_id 있으면** 해당 현장 `sites/<folder>/receipts/` 에 이미지 저장(파일명 `receipt-<timestamp>.jpg`, 경로탈출 방지 기존 새니타이즈 재사용). 저장 실패해도 분석 결과는 정상 반환(베스트 에포트).
- 비용 생성(`POST /api/sites/:id/costs`)은 **기존 그대로**(영수증은 폼 프리필만; 저장은 기존 경로).

## 프론트 (index.html)
- **💸 비용 탭**의 비용 입력 영역(또는 비용 추가 모달)에 **[📷 영수증 촬영/업로드]** 버튼 + 숨김 `<input type="file" accept="image/*" capture="environment">`(모바일=후면카메라 자동).
- 선택 시: FileReader 로 **base64** → `POST /api/receipts/analyze`(현재 선택 현장 site_id 동봉) → **"영수증 분석 중…" 로딩** → 결과로 **비용 폼 프리필**:
  - **금액·날짜 = 정확 채움**. **카테고리 = AI 추정값 + "🤖 AI 추정 — 확인하세요" 뱃지**(노란 톤)로 강조(담당자가 드롭다운으로 쉽게 변경). vendor/memo 도 채움.
  - **신뢰도(confidence)** 표시, **영수증 미리보기 썸네일**. 담당자가 폼을 수정 후 기존 [저장] 으로 등록.
- 실패/키없음(503) 시 안내 토스트 + **수동 입력 폴백**(버튼은 비활성 또는 "서버 연결 필요"). 서버 OpenAI 전용 기능이라 localStorage 폴백 대상 아님(버튼만 graceful 처리).

## 검증
- 키 있으면 **합성 영수증 이미지 1장**(흰 배경에 '○○상회 / 2026-06-29 / 합계 55,000원 / 실리콘·피스' 류 텍스트를 헤드리스로 PNG 화 등)으로 **1회 실호출**(비용 최소화) → amount/date/category JSON 파싱·정수/날짜 형식 확인. 키 없으면 **503**, image 누락 **400** 구조검증.
- 프론트: 버튼→파일선택→(목 응답)으로 폼 프리필·AI추정 뱃지·썸네일 렌더, 미선택/실패 graceful. v1~v6 회귀(8탭·기존 비용입력).

---

# v8 확장 — 스케치업 물량 import 구조(⑥) + 프로젝트 zip 백업(⑨-b)

> **v1~v7 동작/엔드포인트/UI 100% 보존**(새 테이블 CREATE IF NOT EXISTS). 8-1 은 **미래의 스케치업 플러그인이 물량/치수를 보낼 "받는 쪽" 구조**(지금 플러그인은 만들지 않음 — 테이블+엔드포인트+JSON 포맷+견적 연동만 준비). 8-2 는 프로젝트 전체 데이터 zip 다운로드(유일하게 `archiver` 패키지 추가 허용).

## 8-1 스케치업/실측 물량 (interior_takeoff)
### 새 테이블 interior_takeoff (CREATE TABLE IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| site_id | bigint NOT NULL REFERENCES interior_sites(id) ON DELETE CASCADE | |
| trade | text default '' | 공종(21종 중) |
| name | text NOT NULL | 품목/부재명 |
| spec | text default '' | 규격/치수 설명 |
| unit | text default '' | 단위(M2/M/EA/식 등) |
| qty | numeric NOT NULL default 0 | 물량(수량/길이/면적) |
| source | text default 'manual' | 출처: 'sketchup' \| 'manual' |
| source_guid | text default '' | 스케치업 엔티티 식별자(추후 연동·idempotent용) |
| memo | text default '' | |
| created_at | timestamptz default now() | |
- 인덱스 site_id. qty 는 Number 로 직렬화.

### 엔드포인트
- `GET /api/sites/:id/takeoff` → 배열(created_at DESC). 
- `POST /api/sites/:id/takeoff` → **단건** `{trade?,name,spec?,unit?,qty?,source?,source_guid?,memo?}` 또는 **배치** `{items:[...]}` → 201. name 필수(배치는 각 항목 name 필수), qty≥0(기본0), source 기본 'manual'.
- `PUT /api/takeoff/:id` → 동일 필드 수정. `DELETE /api/takeoff/:id` → `{success:true}`/404.
- **`POST /api/sites/:id/import/sketchup`** (미래 플러그인 호출용; 지금은 수동/테스트) → body `{items:[{trade,name,spec?,unit?,qty,source_guid?}]}` → 전부 `source='sketchup'` 로 일괄 insert → `{imported:n, items:[...]}`. **이 JSON 포맷이 스케치업↔앱 계약**(물량/치수만; 단가·내용은 앱에서 입력). source_guid 동일값 재전송 시 멱등(있으면 update, 권장; 단순화로 매번 insert 도 허용하되 주석 명시).

### UI
- **견적 에디터**에 **[📐 물량 불러오기]** 버튼 → 현재 현장 takeoff 목록 모달 → 선택 항목을 견적 행으로 추가(trade/name/spec/unit/qty 채움, **단가는 카탈로그/수동 입력**). 
- takeoff 수동 CRUD 간단 섹션(스케치업 연동 전엔 직접 입력 — 관리 탭 또는 견적/현장 영역 적절히). 폴백 localStorage(키 `interior_takeoff_v1`).

## 8-2 프로젝트 zip 백업 (⑨-b)
- **`npm install archiver`** (zip 스트리밍; Node 내장 zip 없음 → 이 패키지만 추가). package.json dependencies 반영.
- **`GET /api/sites/:id/backup.zip`** → 해당 현장 전체를 zip 스트림으로 다운로드:
  - `data.json` = `{ site, costs, schedule(+deps), estimates(+items, totals), orders, meetings, as, takeoff, exportedAt }` (각 도메인 기존 조회 재사용).
  - `receipts/` = 현장 폴더(`sites/<folder>/receipts/`)의 영수증 이미지 전부(있으면; 경로 가드).
  - `README.txt` = 현장명/주소/백업일시/포함 항목 요약(한글).
  - 헤더 `Content-Type: application/zip`, `Content-Disposition: attachment; filename="<현장명>-backup-<YYYY-MM-DD>.zip"`. 현장 없으면 404. 스트림 오류 500.
- UI: **요약 탭 프로젝트 헤더**(또는 관리)에 **[💾 프로젝트 백업(zip)]** 버튼 → 위 URL 로 다운로드(window.location 또는 a[download]). 서버 전용(폴백은 안내).

## 검증
- 8-1: takeoff 단건/배치 POST·GET·PUT·DELETE, `import/sketchup` 배치 → source='sketchup' 확인. 견적 에디터 물량 불러오기 → 행 채움.
- 8-2: `GET /api/sites/:id/backup.zip` → 200 `application/zip`, 받은 zip unzip 시 `data.json`(site/costs/... 키 포함)·`README.txt` 존재. 없는 현장 404.
- v1~v7 회귀 무손상.

---

# v9 확장 — 노션 협력업체 import(④) + 단가 카탈로그 자동수집(⑧)

> v1~v8 100% 보존(컬럼 ADD COLUMN IF NOT EXISTS). 9-1 = 안도공간 노션 "협력업체 DB"(공정/기술력 보존)를 interior_vendors 로 가져오기. 9-2 = research 스킬(주간 웹 단가 리서치) 결과를 interior_catalog 로 반영하는 import 경로. **실제 데이터 적재는 Claude 가 노션/웹에서 읽어 import 엔드포인트로 수행**(서버에 노션/외부 토큰 불필요).

## 9-1 협력업체(vendors) 확장 + import (④)
### interior_vendors 확장 (ADD COLUMN IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| trade | text default '' | 공정(노션 '공정 이름') |
| grade | text default '' | 기술력/등급(노션 '기술력' 콤마 문자열, 예 '상,고가') |
- 기존 name/kind/phone/memo/active 유지. **노션 매핑**: 업체명→name, 자재/시공→kind, 연락처→phone, 공정이름→trade, 기술력→grade, 업체설명+성명직급+최근거래현장/날짜→memo.
### 엔드포인트
- GET/POST/PUT `/api/vendors` 응답·body 에 `trade`, `grade` 포함(기존 시그니처 확장, 미전달 시 기존값/'').
- **POST /api/vendors/import** body `{items:[{name, kind?, phone?, trade?, grade?, memo?}]}` → **name 기준 upsert**(있으면 update, 없으면 insert; name 없는 항목 skip) → 200 `{imported, updated, total}`.
### UI
- 관리탭 거래처 섹션 폼/목록에 `trade`(공정)·`grade`(기술력) 필드 추가. 기존 CRUD/검색 그대로. 폴백 localStorage 에도 trade/grade 보존.

## 9-2 단가 카탈로그 import (⑧)
### interior_catalog 확장 (ADD COLUMN IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| source | text default 'manual' | 단가 출처('research'/'manual'/업체명 등) |
| price_date | date | 단가 기준일(리서치 수집일, YYYY-MM-DD) |
### 엔드포인트
- **POST /api/catalog/import** body `{items:[{trade,name,unit?,material_price?,labor_price?,sub_price?,grp?,product_name?,vendor?,code?,source?,price_date?}]}` → **중복(trade+name+product_name 동일) 회피**: 있으면 가격/source/price_date update, 없으면 insert. → 200 `{imported, updated, total}`. trade·name 필수 항목만 반영.
- 기존 GET/POST/PUT `/api/catalog` 응답·body 에 source/price_date 포함(확장).
### research 스킬 연계 (Claude 가 SKILL.md 수정)
- `.claude/skills/research/SKILL.md` 에 "interior-cost 카탈로그 반영" 단계 추가: 리서치 결과를 위 import 포맷으로 `POST /api/catalog/import`(배포된 interior-cost URL; 로컬 localhost:3010), source='research', price_date=수집일.
### UI
- 관리탭 카탈로그 섹션에 source/price_date 표시(있으면). 자동 수집은 research 스킬/cron, 수동 추가는 기존 그대로.

## 검증
- 9-1: vendors trade/grade CRUD, `/api/vendors/import` upsert(신규 insert + 동일 name 재import 시 update).
- 9-2: `/api/catalog/import` 신규/중복 upsert, source/price_date 반영. 기존 catalog GET 회귀.
- v1~v8 회귀 무손상.

---

# v10 확장 — 발주 자동생성 + 필요시기 알림 + 발주서 PDF (⑦)

> 견적 물량·일정을 읽어 발주서를 미리 만들고(담당자 확인·수정), 필요시기 도래 시 앱 내 알림. **카톡/문자 실발송은 보류**(PDF + 앱 내 알림만). v1~v9 100% 보존.

## interior_orders 확장 (ADD COLUMN IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| need_date | date | **필요시기**(자재가 현장에 있어야 하는 날). 자동생성 시 추론, 담당자 수정 가능 |
| auto_generated | boolean default false | 자동생성된 초안 표시 |
- 기존 order_no/vendor/trade/title/amount/order_date/due_date/status/memo 유지.

## 자동생성 (견적+일정 기반)
- **POST /api/sites/:id/orders/auto-generate** body `{estimate_id?}`(미전달 시 해당 현장 최신 **confirmed** 견적) →
  - 견적 항목을 **trade(공종)별로 그룹**핑 → 공종당 발주 초안 1건:
    - `title='{공종} 자재 발주'`, `trade=공종`, `amount=`공종 재료비 합(Σ material_price×qty; 3분할 없으면 Σ amount), `vendor=''`, `status='대기'`, `auto_generated=true`, `order_no='PO-'+id`(생성 후).
    - `need_date` = 그 공종 일정(interior_schedule.process=공종)의 **가장 이른 start_date − 3일**(리드타임). 해당 공종 일정 없으면 null.
  - 응답 `{generated:n, orders:[...]}`. confirmed 견적 없으면 **404** `{error:'확정된 견적이 없습니다'}`. (재실행 시 중복 생성 — 담당자가 정리; auto_generated=true 기존분을 먼저 지우는 `?replace=1` 옵션 제공: replace=1이면 그 현장의 auto_generated=true·status='대기' 발주 삭제 후 재생성)
- 자동생성 후에도 발주는 **기존 PUT/DELETE 로 자유 수정·삭제**(vendor 지정, need_date 조정 등).

## 필요시기 알림 (앱 내)
- **GET /api/sites/:id/summary** 에 `orderDueSoon`(need_date ≤ today+7 AND status NOT IN ('입고','정산완료') 인 발주 수) + `orderOverdue`(need_date < today AND 동일 미완료) 추가.
- (선택) **GET /api/orders/alerts?within=7** → 전역(모든 현장) 임박 발주 배열 `{id,site_id,site_name,title,trade,need_date,dday,status}`(need_date ASC). 헤더 알림용.
- 카톡/문자 실발송 없음(보류). 알림 = 앱 내 배지/리스트 + PDF.

## 발주서 PDF
- 프론트 `window.print` + @media print A4 발주서: 공급자(안도공간)/현장/발주번호/거래처/공종/품목/금액/발주일/납기/필요시기 + 합계. 단건 또는 목록.

## UI (🧾 발주 탭)
- **[⚡ 발주 자동생성]** 버튼(확정 견적 기반) → 생성된 공종별 발주 초안 목록 표시(`auto_generated` 뱃지). 재생성은 replace 확인.
- 발주 행/폼에 **need_date(필요시기)** 추가 + **임박 강조**: D-7 이내 주황, 지남(overdue) 빨강, D-day 표기.
- **[🖨 발주서 PDF]** 버튼(단건/목록).
- 발주 탭 상단/프로젝트 헤더에 **임박 발주 배지**(orderDueSoon/overdue). 폴백 localStorage 도 need_date/auto 보존 + 클라 임박계산.

## 검증
- auto-generate: 확정 견적 → 공종별 발주 초안 생성(amount=공종 재료비합, need_date=일정−3일), confirmed 없으면 404, replace=1 재생성.
- summary orderDueSoon/overdue 카운트. PDF 버튼 렌더. v1~v9 회귀.

---

# v11 확장 — 캘린더 드래그 이동/고도화(①) + 타임라인 뷰(②)

> 사용자 요청: 일정을 **드래그해서 다른 날짜로 이동**(구글/애플/노션 캘린더 UX 흡수), 상단 **타임라인 뷰**(노션 타임라인). **둘 다 순수 프론트**(서버/DB 무변경) — 기존 `PUT /api/schedule/:id`(start_date/end_date/cascade)와 `GET /api/sites/:id/schedule`(predecessors/successors 포함) 만 사용. **v1~v10 동작/엔드포인트/UI 100% 보존.**

## 11-1 캘린더 드래그 이동 + 고도화 (ScheduleTab 월간 캘린더)
- **일정 막대 드래그 이동(move)**: 캘린더에 표시된 일정 막대를 mousedown→드래그→drop 으로 **다른 날짜로 이동**. drop 날짜 기준 `delta = drop날짜 − 원래 start_date`(일수) 계산 → `start_date+delta`, `end_date+delta`(**기간/duration 유지**) 로 `PUT /api/schedule/:id`. 낙관적 UI(즉시 이동 후 PUT, 실패 시 롤백+토스트).
  - 기본 이동은 **그 일정만**(구글 캘린더식). 단, **Shift 누른 채 드롭(또는 이동 후 "후속도 함께?" 미니 확인)** 이면 `cascade:true` 로 후속까지 연쇄 이동(v6 기존 cascade 재사용). 기본 비-cascade.
- **드래그 리사이즈(resize)**: 막대 좌/우 끝 핸들을 드래그해 **start_date 또는 end_date 변경**(기간 늘이고 줄이기). start≤end 정규화. PUT.
- **클릭 동작**: 일정 막대 클릭 → 수정 폼/팝오버 오픈(기존). 빈 날짜 드래그(기존 v6 기간선택→생성)는 **그대로 유지**(막대 드래그와 충돌 안 나게: 막대 위 mousedown=이동/리사이즈, 빈 셀 mousedown=신규 기간선택).
- **캘린더 고도화(구글/애플/노션 느낌)**: 오늘 셀 강조, 주말 톤, ‹ › 월 이동 + **[오늘]** 버튼, 일정 막대 공종/상태 색, hover 시 살짝 떠오름, 한 셀에 일정 많으면 "+N 더보기". 막대에 제목+기간 말줄임. 드래그 중 고스트/하이라이트.
- 폴백(localStorage)에서도 이동/리사이즈가 클라 계산으로 동작(서버 우선). 드래그 라이브러리 없이 순수 마우스 이벤트로 구현(단일 파일·CDN 유지).

## 11-2 타임라인 뷰 (노션 타임라인 — ScheduleTab 상단 토글)
- ScheduleTab 상단에 **[📅 캘린더] / [📊 타임라인]** 뷰 토글. 기본 캘린더(기존). 타임라인 선택 시 같은 일정 데이터를 **가로 간트형 타임라인**으로 표시.
- **레이아웃(노션 타임라인 참고)**: 좌측 고정 패널 = 일정명(공종 그룹) 목록. 우측 = 가로 시간축(날짜/주 단위), 각 일정이 **start_date~end_date 위치·길이의 가로 막대**. 가로 스크롤. 상단 날짜 눈금(월/주). **오늘 세로선** 표시.
- **공종(process)별 그룹핑** 옵션(노션의 그룹 like) — 같은 공종 묶어 행 그룹. 막대 색 = 공종/상태.
- **선후관계 표시**: predecessors/successors 가 있으면 막대 사이 연결선/화살표(가능한 범위; 어려우면 막대에 🔗 표식+툴팁).
- **타임라인에서도 드래그 이동/리사이즈**(11-1 과 동일 PUT) 지원하면 베스트(가로축 픽셀↔일수 변환). 최소한 막대 클릭→수정은 제공.
- 공사기간(현장 start~end) 범위를 기본 표시 구간으로, 일정들이 그 안에 배치. 일정 없으면 빈 상태 안내.

## 검증
- 11-1: 캘린더에서 일정 막대를 다른 날짜로 드래그 → start/end 가 delta만큼 이동(기간 유지)·PUT 반영·새로고침 후 유지. 리사이즈로 기간 변경. 빈 날짜 드래그=신규(기존) 보존. cascade(shift드롭) 후속 이동.
- 11-2: 타임라인 토글 → 일정이 가로 막대로 표시(start~end 위치/길이 정확), 공종 그룹, 오늘선, 가로 스크롤. 캘린더↔타임라인 전환 무손실.
- v1~v10 회귀 무손상(8탭·기존 일정 CRUD·기간선택 생성·.ics·선후관계 cascade).

---

# v12 확장 — 비용 계산서(세금계산서) 유무 → 공급가/세금포함 집계 (③)

> 사용자 요청: 비용 등록 시 **계산서(세금계산서) 유무**를 따지고, 프로젝트 전체 비용을 **① 공급가 기준 사용비용**과 **② 세금 포함 사용비용** 두 옵션으로 본다. **v1~v11 동작/엔드포인트/UI 100% 보존**(컬럼 ADD COLUMN IF NOT EXISTS).

## 금액 해석 규칙 (서버·프론트 동일)
- 비용의 `amount` = **실제 지출(지불)액**. 계산서 발행 거래는 통상 **부가세 포함 합계(합계금액)**를 적는다고 가정.
- **계산서 있음(has_invoice=true)**: 공급가 = `round(amount / 1.1)`, 부가세 = `amount − 공급가`(매입세액, 환급 대상).
- **계산서 없음(has_invoice=false)**: 공급가 = `amount`(분리 가능한 부가세 없음), 부가세 = 0.
- 따라서:
  - **공급가 기준 사용비용(supplyTotal)** = Σ ( has_invoice ? round(amount/1.1) : amount )  ← 매입세액 제외, "실질 원가"
  - **세금 포함 사용비용(taxIncludedTotal)** = Σ amount  ← 실제 통장에서 나간 총액 (= 기존 spent 와 동일)
  - **부가세 합계(vatTotal)** = taxIncludedTotal − supplyTotal

## interior_costs 확장 (ADD COLUMN IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| has_invoice | boolean NOT NULL default false | 세금계산서(계산서) 발행 여부 |
- 기존 date/amount/category/process/manager/vendor/memo/schedule_id 유지.

## 엔드포인트
- `GET /api/sites/:id/costs`·`POST`·`PUT /api/costs/:id` → 응답·body 에 `has_invoice`(boolean) 포함(미전달 시 기존값/false 보존). amount 의미·검증(>0 정수) 불변.
- **`GET /api/sites/:id/summary`** 확장(기존 키 100% 유지 + 추가):
  - 기존 `spent`(= Σ amount = taxIncludedTotal) **그대로 유지**(회귀).
  - 신규 `spentSupply`(= supplyTotal, 공급가 기준), `spentTaxIncluded`(= spent, 명시적 별칭), `vatTotal`, `invoicedCount`(has_invoice=true 비용 수), `invoicedAmount`(has_invoice=true amount 합).
  - byCategory/byProcess 등 기존 집계 불변. (집행률은 프론트가 기존대로 spent/budget; 공급가 보기는 spentSupply/budget 로 계산)

## UI (💸 비용 탭 / 📊 요약)
- 비용 입력 폼에 **[계산서 있음] 체크/토글**(has_invoice). 비용 목록 행에 계산서 뱃지(있음=초록 "계산서", 없음=회색 "미발행").
- 요약(또는 비용 탭 상단)에 **[공급가 기준] / [세금 포함] 보기 토글**:
  - 세금포함(기본·기존): 집행액 = spent. 공급가: 집행액 = spentSupply.
  - 선택 보기에 따라 집행액·집행률·잔여 표시가 바뀌도록(프론트 계산, 단위혼동 차단). 부가세 합계(vatTotal)·계산서 발행 건수도 작게 표기.
- 폴백(localStorage): has_invoice 저장 + 클라에서 supplyTotal/taxIncludedTotal/vatTotal 계산.

## 검증
- has_invoice CRUD(생성/수정/보존). summary: 계산서 있음 1건(amount=110,000)+없음 1건(amount=50,000) → spent=160,000, spentSupply=round(110000/1.1)+50000=100,000+50,000=150,000, vatTotal=10,000, invoicedCount=1. 기존 spent/byCategory 회귀.
- UI: 계산서 토글·뱃지, 공급가/세금포함 보기 전환 시 집행액 변화. v1~v11 회귀.

---

# v13 확장 — 로그인/회원가입 + 팀(워크스페이스) 멀티테넌트 (⑤)

> 사용자 결정: **지금은 안도공간 단일 팀(기존 데이터 전부 귀속, 팀원 공유)**, **나중에 팀별/회사별 분리(유료 SaaS)**. **회원가입은 초대코드 필요**(공개 배포 시 회사 데이터 보호). 초대코드 = 팀 가입 열쇠.
> **v1~v12 데이터·동작 100% 보존**(컬럼 ADD COLUMN IF NOT EXISTS, 기존 행 전부 기본팀으로 backfill → 로그인하면 기존 현장 2개·협력업체 283개 그대로 보임). 새 패키지: **bcryptjs, jsonwebtoken** (npm install).

## 새 테이블
### interior_teams (팀/워크스페이스 = 테넌트)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| name | text NOT NULL | 팀/회사명 |
| invite_code | text NOT NULL UNIQUE | 가입 초대코드 |
| plan | text default 'free' | 요금제(향후) |
| created_at | timestamptz default now() | |
- **시드**: 부팅 시 기본팀 "안도공간" 없으면 생성. invite_code = `process.env.INTERIOR_INVITE_CODE || 'ANDO-2026'`. 이 팀 id 를 DEFAULT_TEAM_ID 로 확보(기존 데이터 backfill 대상).

### interior_users
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| email | text NOT NULL UNIQUE | 로그인 이메일(소문자 정규화) |
| password_hash | text NOT NULL | bcryptjs 해시 |
| name | text NOT NULL default '' | 표시명 |
| team_id | bigint NOT NULL REFERENCES interior_teams(id) | 소속 팀 |
| role | text NOT NULL default 'member' | member/admin(향후) |
| created_at | timestamptz default now() | |

## 기존 테이블에 team_id (ADD COLUMN IF NOT EXISTS + backfill)
- 대상(소유 엔티티): **interior_sites, interior_staff, interior_vendors, interior_categories, interior_catalog, interior_clients** 에 `team_id BIGINT`.
- **backfill**: 부팅 시 `UPDATE <t> SET team_id = DEFAULT_TEAM_ID WHERE team_id IS NULL`(각 테이블). → 기존 데이터 전부 안도공간 팀 귀속.
- 자식 테이블(costs/schedule/schedule_deps/estimates/estimate_items/orders/meetings/as/takeoff)은 team_id 안 붙임 — **부모 site/parent 통해 귀속**(소유검증으로 스코핑).

## 인증 (JWT)
- `JWT_SECRET = process.env.JWT_SECRET || '<dev기본>'`. 토큰 payload `{ userId, teamId }`, 만료 적당(예 30d).
- **POST /api/auth/signup** `{email, password, name?, invite_code}` → invite_code 로 팀 조회(없으면 400 `초대코드가 올바르지 않습니다`), email 중복 409, password 길이검증(≥6, 400), bcrypt 해시 → users INSERT(team_id=그 팀) → 201 `{token, user:{id,email,name,team_id,team_name,role}}`.
- **POST /api/auth/login** `{email, password}` → 이메일 조회+bcrypt compare, 실패 401 `이메일 또는 비밀번호가 올바르지 않습니다` → 200 `{token, user}`.
- **GET /api/auth/me** (Bearer) → `{user}` (팀명 포함). 토큰 없음/만료 401.
- **auth 미들웨어**: 모든 `/api/*` 보호. **예외**: `/api/auth/login`, `/api/auth/signup`(비보호). 정적(GET 비-/api, SPA 셸)은 비보호(앱이 로그인화면 직접 렌더). 헤더 `Authorization: Bearer <token>` 검증 → `req.userId`, `req.teamId`. 없거나 무효 401 `{error:'인증이 필요합니다'}`.

## 팀 스코핑 (멀티테넌트 — 단일팀이라 현재는 동작 동일, 미래 자동 격리)
- **sites**: `GET /api/sites`·`GET /api/sites/:id/summary` 등 목록/집계 → `WHERE team_id = req.teamId`. `POST /api/sites` → team_id=req.teamId 세팅. `GET/PUT/DELETE /api/sites/:id` 및 **모든 `/api/sites/:id/*`**(costs/schedule/estimates/orders/meetings/as/takeoff/export/backup.zip/schedule.ics/orders.auto-generate/import.sketchup/receipts 저장) → 시작에서 **site.team_id === req.teamId 확인(아니면 404)**. 헬퍼 `assertSiteOwned(siteId, teamId)` 권장.
- **전역 마스터(staff/vendors/categories/catalog/clients)**: GET → `WHERE team_id=req.teamId`(+기존 active 필터 유지). POST/import → team_id=req.teamId. PUT/DELETE/:id → team_id 일치 검증(아니면 404). `GET /api/catalog/trades`(상수)·카탈로그/벤더 import 도 team_id 적용.
- **자식 by id**(PUT/DELETE `/api/costs/:id`,`/api/schedule/:id`(+/deps),`/api/estimates/:id`,`/api/orders/:id`,`/api/meetings/:id`,`/api/as/:id`,`/api/takeoff/:id`, confirm/unconfirm 등) → child→site 조인으로 site.team_id===req.teamId 검증(아니면 404). 헬퍼로 일괄.
- **receipts/analyze**: site_id 주어지면 소유검증.

## 프론트 (index.html)
- **AuthScreen**(로그인/회원가입 탭): 로그인(email,password) / 회원가입(email,password,name,**초대코드**). 제출 → `/api/auth/*` → 성공 시 토큰 localStorage(키 `interior_token`) 저장 + 사용자 상태 set + 앱 진입. 에러 메시지 표시(초대코드 오류/중복/로그인실패).
- **api 레이어**: 모든 요청 헤더에 토큰 있으면 `Authorization: Bearer`. 응답 **401 이면 토큰 삭제 + AuthScreen 으로**(세션만료). (기존 `if(e.status) throw e` 폴백 패턴 유지.)
- **앱 게이트**: 부팅 시 토큰 있으면 `GET /api/auth/me` → 200 앱 진입 / 401 AuthScreen / **네트워크 실패(서버 다운, e.status 없음) → 기존 오프라인 데모모드**(로그인 없이 localStorage, "데모(오프라인)" 배너) — 락아웃 방지·기존 동작 보존. 토큰 없으면 AuthScreen(단, 서버 자체가 unreachable 이면 데모모드 허용).
- **헤더**: 로그인 시 우측에 사용자명·팀명 + **[로그아웃]**(토큰 삭제→AuthScreen). 
- 기존 8탭/전 기능은 로그인 후 그대로.

## 검증
- 부팅 backfill: 기본팀 생성·기존 sites/vendors/catalog team_id 채워짐.
- 회원가입(초대코드 'ANDO-2026') → 201 토큰 → 그 사용자가 **기존 현장 2개 + 협력업체 283개** 조회됨(backfill+스코핑 정확). 잘못된 초대코드 400. email 중복 409. 로그인/잘못된 비번 401. /me. 토큰 없이 GET /api/sites 401.
- 격리: throwaway 2번째 팀(다른 invite_code 임시 시드 또는 INSERT) 사용자 → sites/vendors 0건(격리 증명) 후 정리.
- 프론트: 토큰 없으면 AuthScreen, 로그인 후 앱·헤더 사용자/팀·로그아웃, 서버다운 시 데모모드. v1~v12 전부 로그인 후 정상(8탭).
- **회귀 절대**: 로그인한 안도공간 사용자에게 기존 데이터가 그대로 보여야 함(backfill 누락=데이터 사라짐 → 반드시 e2e 확인).

---

# v14 확장 — 드래그 리프레시 수정(#15) + 집행분석 드릴다운(#17) + 일정 협력업체·사용내역(#18)

> 사용자 추가 요청 묶음. **v1~v13 동작/엔드포인트/UI 100% 보존**(컬럼 ADD COLUMN IF NOT EXISTS). 14-1·14-2는 순수 프론트, 14-3은 서버+프론트. (견적→현장 #16은 별도 배치 v15.)

## 14-1 캘린더 드래그 이동 시 리프레시 방지 (#15 — 순수 프론트, 버그 수정)
- **현상**: v11 캘린더에서 일정 막대를 드래그해 이동하면 화면이 "리프레시"되는 느낌(전체 리렌더/스크롤 리셋/깜빡임). 원인 추정: moveTask 가 PUT 후 `onChanged()`(부모 전체 refetch/리렌더)를 호출 → 캘린더가 재마운트되며 스크롤·뷰 상태 리셋.
- **목표**: 드래그 이동/리사이즈가 **그 자리에서 부드럽게** 반영되고 화면이 튀지 않게.
  - 낙관적 `localTasks` 업데이트는 유지하되, **드래그 직후 전체 refetch(onChanged) 를 호출하지 말 것**(또는 캘린더 뷰 상태를 보존하는 조용한 동기화로). PUT 성공 시 서버 응답으로 해당 항목만 갱신, 실패 시 롤백.
  - **실제 페이지 리로드 가능성 차단**: 드래그 관련 요소가 `<form>` submit / `<a>` 기본동작 / `window.location` 을 트리거하지 않는지 점검(mouseup 핸들러에서 preventDefault). 현재 보이는 월/스크롤/펼침 상태 유지.
- 캘린더뿐 아니라 타임라인 드래그 이동도 동일하게 무-리프레시.

## 14-2 집행 분석 드릴다운 (#17 — 프론트, 기존 costs 데이터 활용)
- 요약(📊)의 **"집행 분석"** 섹션: **비용 카테고리별 / 공정별** 각 항목(막대/행)을 **클릭하면 세부 내역**이 열린다(모달 또는 인라인 패널).
  - 예: 공정별에서 **목공** 클릭 → 그 현장의 목공 공정 비용들을 **비용 카테고리별로 분해**(목공의 자재비/인건비/장비 등) + 개별 비용 항목 목록(날짜·금액·거래처·메모·계산서 여부). 합계 표시.
  - 카테고리별에서 **자재비** 클릭 → 그 카테고리 비용들을 **공정별로 분해** + 항목 목록.
- 데이터: 기존 `GET /api/sites/:id/costs`(이미 로드/조회 가능) 를 클릭한 차원으로 필터 → 반대 차원으로 group + 항목 리스트. 서버 변경 없이 프론트 집계. (원하면 비용 탭으로 점프 + 필터 적용도 가능하나, 모달 드릴다운이 1차.)
- 항목 클릭 시 해당 비용 수정 모달로 연결(선택). 빈 분류는 '미분류'.

## 14-3 일정 협력업체 등록 + 협력업체 사용내역 (#18 — 서버+프론트)
### interior_schedule 확장 (ADD COLUMN IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| vendor | text default '' | 이 작업(공정)에 투입되는 협력업체명 |
- 기존 staff(담당자) 패턴과 동형. vendor 는 텍스트(거래처 마스터명과 매칭; 자유입력도 허용).
### 엔드포인트
- 일정 GET/POST/PUT(`/api/sites/:id/schedule`, `/api/schedule/:id`) 응답·body 에 `vendor` 포함(미전달 보존). 기존 schedule 시그니처 확장만.
- **GET /api/vendors/:id/usage** → 그 거래처(이름 기준)가 **어느 현장에서 얼마 쓰였는지** 집계(팀 스코핑):
  - vendor 이름으로 `interior_costs`(WHERE vendor=name) 현장별 합계 + `interior_orders`(WHERE vendor=name) 현장별 합계 + `interior_schedule`(WHERE vendor=name) 현장별 계획비용 합계.
  - 응답 `{ vendor:{id,name,...}, totals:{costTotal, orderTotal, plannedTotal}, bySite:[{site_id, site_name, costTotal, orderTotal, plannedTotal, lastDate}] }`. 정수원. 현장은 팀 소속만. 없으면 빈 배열/0.
### UI
- **일정 수정/생성 폼**(이미지 참고: 작업명/공정/상태/시작일/종료일/담당자/계획비용/색상/메모)에 **협력업체 필드 추가**(담당자 아래/옆). **거래처 마스터(283개) 검색 Combo**(datalist, 자유입력 fallback). 캘린더/타임라인 막대·목록에 협력업체 작게 표기(선택).
- **관리 탭 거래처(협력업체) 세부**: 각 거래처 행에 **[세부/사용내역]** → 모달에 `GET /api/vendors/:id/usage` 결과: **현장별 사용액 표**(현장명·비용합·발주합·계획합·최근일) + 총계. (어느 현장에서 얼마 썼는지 한눈에.)
- 폴백(localStorage): schedule.vendor 보존 + usage 클라 집계(costs/orders/schedule 로컬 스토어에서).

## 검증
- 14-1: 캘린더/타임라인 드래그 이동 시 스크롤/뷰 유지·깜빡임 없음·실제 리로드 없음, 이동값은 정상 반영(회귀: 빈셀 생성·cascade·리사이즈 유지).
- 14-2: 집행분석 목공 클릭 → 목공 비용 카테고리 분해+항목 리스트 모달, 자재비 클릭 → 공정 분해. 합계 일치.
- 14-3: 일정에 협력업체(거래처 검색) 저장→GET 반영, /api/vendors/:id/usage 현장별 집계(costs+orders+schedule), 관리 거래처 세부 모달 표시. v1~v13 회귀.

---

# v15 확장 — 견적에서 현장 생성 (#16, 결정: "견적에서 현장 생성 + 상단 버튼 유지")

> 사용자 요청: 견적을 내면 그 세부정보로 현장이 등록되게. **결정=옵션A**: 견적에서 현장 생성 + 기존 상단 현장 수정/삭제/+등록 버튼은 **그대로 유지**(되돌리기 쉬움). **v1~v14 동작/엔드포인트/UI 100% 보존**. 현재 견적은 현장 종속(POST /api/sites/:id/estimates)이라, "견적 먼저 → 현장 자동 생성" 진입점을 추가한다(기존 "현장 먼저 → 견적" 흐름도 유지).

## 백엔드 (server.js) — 원자적 현장+견적 생성
- **POST /api/estimates/new** (인증·팀 스코핑) body `{ site:{name(필수), client?, address?, building_type?, manager?, start_date?, end_date?, move_in_date?, floor_area?, pm?, construction_manager?, designer? }, estimate:{ title?, client_name?, client_contact?, estimate_date?, valid_until?, vat_mode?, vat_rate?, discount?, memo?, use_cost_buildup?, ...율, items?:[...] } }`:
  - **트랜잭션**: ① 현장 생성(기존 POST /api/sites 로직 재사용 — team_id=req.teamId, 폴더 생성, name 중복 409) → ② 그 site_id 로 견적 생성(기존 POST estimates 로직 재사용, items amount 서버계산, status 'draft').
  - 응답 201 `{ site:{...신규현장}, estimate:{...신규견적 상세+totals} }`. 실패 시 롤백(현장만 생기는 일 없게).
  - estimate.client_name 미전달 시 site.client 로 기본. site.name 필수(없으면 400).
- 기존 /api/sites·/api/sites/:id/estimates 등은 **불변**. 새 엔드포인트만 추가(catch-all 앞, /api 인증 하).

## 프론트 (index.html)
- **견적 탭(또는 프로젝트 보드)에 [+ 견적으로 현장 만들기] 버튼**(현장 미선택 시에도 가능) → 모달:
  - **현장 정보**: 현장명(필수)·고객·주소·건물종류(드롭다운)·담당자·공사기간·입주예정일(노션식 필드 일부) + **견적 제목**(기본 '견적서').
  - 제출 → `POST /api/estimates/new` → 성공 시 **새 현장을 전역 선택** + **견적 에디터 열어 항목 입력**(3분할/카탈로그/원가계산 기존 그대로). → 이후 확정하면 기존대로 예산 연동.
- 견적 에디터/목록에서 현장 고객명(client_name)·현장 연결이 자연스럽게 보이게(기존 헤더 활용).
- 기존 "+ 현장 등록"(상단)·현장 수정/삭제 **유지**(옵션A). 폴백(localStorage): new 도 클라에서 site+estimate 생성(서버 우선).

## 검증
- POST /api/estimates/new → 현장+견적 동시 생성(트랜잭션), 응답 site/estimate, name 중복 409, site.name 없으면 400, 팀 스코핑. 생성된 현장이 GET /api/sites 에 보임, 견적이 그 현장 종속.
- 프론트: [+ 견적으로 현장 만들기] → 모달 제출 → 새 현장 선택+견적 에디터, 항목입력·확정→예산연동. 상단 현장 버튼 유지. v1~v14 회귀.

---

# v16 확장 — 타임라인 뷰 스케일(#1) + 간트식 의존성 드래그-연결/연쇄(#2)

> 사용자 요청: ① 타임라인을 월/2주/1주 단위로 끊어 보기, ② 막대 앞뒤 점으로 선후공정 연결(드래그)·연결 이동 시 연쇄·설정 간편화. 리서치(Notion 타임라인·monday·TeamGantt·GanttPro): **막대 hover 시 좌(시작)/우(종료) 연결점 → 우측 점에서 다른 막대로 드래그 = Finish-to-Start 의존성 생성**, 선행끝→후행시작 화살표, **한 태스크 이동 시 연결된 후행 자동 shift(dependency shifting)**. **둘 다 순수 프론트**(기존 API 재사용). v1~v15 100% 보존.

## 기존 백엔드 재사용(변경 없음)
- 의존성 생성: `POST /api/schedule/:id/deps` body `{predecessor_id}` (:id=후행/successor). 예: A→B 링크 = POST /api/schedule/B/deps {predecessor_id:A}. 사이클/자기참조/타현장 400.
- 의존성 삭제: `DELETE /api/schedule/:id/deps/:predId`.
- 연쇄 이동: `PUT /api/schedule/:id` body `{...dates, cascade:true}` → 모든 transitive successor 를 delta 만큼 이동, 응답 `shifted:[{id,start_date,end_date}]`.
- GET schedule 각 항목에 `predecessors:[]`/`successors:[]`.

## 16-1 타임라인 스케일 (월/2주/1주)
- ScheduleTimeline 상단에 **[월]/[2주]/[주] 스케일 토글**(기본 월). 스케일별 **하루 픽셀폭(dayW)** 과 표시 눈금:
  - 월: dayW 작게(예 24~30px)·상단 눈금 월/주. 2주: 중간(예 44px)·눈금 주/일. 주: 크게(예 80~100px)·눈금 일(요일). (값은 조정 가능, 가독성 우선)
- 스케일 바꿔도 막대 위치/길이 = start~end 정확 유지(left=경과일×dayW, width=기간×dayW). 오늘 세로선·가로 스크롤·[오늘로] 유지. 드래그 이동/리사이즈의 px↔일수 변환도 dayW 반영.

## 16-2 간트식 의존성 드래그-연결 + 연쇄 (핵심)
- **연결점(dot)**: 각 타임라인 막대에 **좌측(시작)·우측(종료) 끝 연결점**. 평소 은은하게(또는 hover 시 표시), hover 시 커서 변경.
- **드래그-연결**: **한 막대의 우측 점(종료)** 에서 mousedown → 드래그 중 점선 따라오는 커넥터 고스트 → **다른 막대(위/그 근처, 시작점 영역) 에서 mouseup** → 그 두 태스크로 **선행(예정막대)→후행 링크 생성**: `POST /api/schedule/<후행>/deps {predecessor_id:<선행>}`. 성공 토스트/실패(사이클 등 400) 토스트. **이 드래그-연결이 기존 '선행 추가' 모달을 대체하는 간편 설정**(모달/리스트는 보조로 유지).
- **연결선(화살표)**: predecessors/successors 로 **선행 막대 우측 끝 → 후행 막대 좌측 끝** SVG 커넥터(점+꺾은선+화살표). 점으로 시작/끝 강조. (v11 화살표 개선)
- **연결 삭제**: 커넥터/점 클릭 또는 후행의 선행칩 ✕ → `DELETE .../deps/...`.
- **★ 이동 연쇄(핵심 수정)**: **타임라인에서 막대를 드래그 이동하면 기본으로 `cascade:true`** 로 `PUT /api/schedule/:id` → 연결된 후행들이 함께 이동. 응답 `shifted[]` 를 localTasks 에 조용히 머지(v14 무-리프레시 방식 유지 — onChanged 전체 refetch 금지). 즉 **"앞단 하나 옮기면 다 딸려온다"** 를 타임라인에서 보장. (리사이즈는 그 태스크만; 캘린더는 기존 v14 유지 — Shift=cascade.)
- 드래그-연결 vs 드래그-이동 구분: **막대 끝 점 위 mousedown=연결**, **막대 몸통 mousedown=이동**(stopPropagation 으로 충돌 차단).

## 검증
- 16-1: 월/2주/1주 토글 → dayW/눈금 바뀌고 막대 위치·길이 정확, 오늘선·드래그 정상.
- 16-2: 막대 우측 점에서 다른 막대로 드래그 → 링크 생성(POST deps), 커넥터 화살표 표시. 앞 태스크를 드래그 이동 → **연결된 후행이 같은 delta로 함께 이동(cascade)** ·화면 리프레시 없음. 사이클 시도 400 토스트. 링크 삭제. 기존 선행 모달·캘린더 동작 회귀.
- v1~v15 회귀 무손상(8탭·로그인·드릴다운·견적→현장 등).

---

# v17 확장 — 견적/발주 공유링크 + 비밀번호 (#3, 결정: "공유링크 + 비밀번호")

> 사용자 요청: 견적·발주서를 저장해 팀별로 보고, 비밀번호 유무 옵션. 결정=**공유링크 + 비밀번호**: 저장한 견적/발주를 **로그인 없이 열람 가능한 읽기전용 공유 페이지**(외부 고객용)로 내보내고, **선택적 비밀번호**로 보호. 앱은 v13 인증 뒤에 있으므로 **공유 경로(/api/share/*)만 인증 예외**. v1~v16 100% 보존(컬럼 ADD COLUMN IF NOT EXISTS).

## 스키마 (ADD COLUMN IF NOT EXISTS)
- `interior_estimates` + `interior_orders` 각각:
  - `share_token TEXT` (nullable; 공유 시 랜덤 발급, null=비공유)
  - `share_password_hash TEXT` (nullable; 비밀번호 설정 시 bcrypt 해시, null=비번없음)
- 인덱스: 각 테이블 share_token (부분/일반).

## 엔드포인트
### 관리(인증·팀 스코핑)
- `POST /api/estimates/:id/share` body `{password?}` → share_token 없으면 crypto 랜덤 발급(있으면 유지), password 주면 bcrypt 해시 저장/빈문자면 해시 제거 → 200 `{share_token, url:'/share/estimate/'+token, hasPassword:boolean}`. (소유 team 검증, 404)
- `DELETE /api/estimates/:id/share` → share_token·해시 null(공유 해제) → `{success:true}`.
- 발주 동형: `POST /api/orders/:id/share`, `DELETE /api/orders/:id/share`.
### 공개(무인증 — 미들웨어 예외 `/api/share/*`)
- `GET /api/share/estimate/:token` → 토큰으로 견적 조회. **비번 설정돼 있으면** `{requiresPassword:true}` (데이터 미포함). 없으면 `{estimate:{헤더+items+totals}, site:{name,address,client}, supplier}` (읽기전용, team/인증 불필요). 없는 토큰 404.
- `POST /api/share/estimate/:token` body `{password}` → bcrypt 검증 실패 401, 성공 시 위 데이터. 
- 발주 동형: `GET/POST /api/share/order/:token` (발주 헤더/항목·현장명).
- 공개 응답엔 민감 내부필드(team_id 등) 제외, 견적/발주 표시에 필요한 것만.

## 프론트 (index.html)
- **견적 상세/에디터 + 발주 행에 [🔗 공유] 버튼** → 공유 모달: **비밀번호 사용 토글**(+ 입력) → `api.shareEstimate(id,{password})`/`shareOrder` → **공유 URL 표시 + 복사 버튼** + [공유 해제]. hasPassword 표시.
- **공개 공유 뷰(ShareView)**: 앱 부팅 시 URL 이 공유 경로면(`?share=estimate/<token>` 또는 `#/share/estimate/<token>` 등 택1, 문서화) **AuthGate 로그인 게이트 대신 ShareView 렌더**(무로그인). 
  - `GET /api/share/...` → requiresPassword 면 **비밀번호 입력 화면** → `POST` 검증 → 견적/발주를 **읽기전용·인쇄가능 레이아웃**(공급자 안도공간/현장/항목/금액/합계·VAT)으로 표시. 잘못된 토큰/비번 안내.
- 앱 내(로그인 상태)에서는 기존처럼 팀 전체 견적/발주 조회(이미 됨). 공유는 외부 열람용.
- api: shareEstimate/unshareEstimate/shareOrder/unshareOrder + 공개 fetchShared(무토큰). 폴백(localStorage): 공유토큰 생성·검증 클라 처리(서버 우선).

## 검증
- share: POST estimate/:id/share(비번없이)→token, GET /api/share/estimate/:token(무인증)→데이터. 비번설정 POST→GET requiresPassword→POST 비번검증(틀리면401·맞으면 데이터). unshare→GET 404. 발주 동형. 팀 소유검증(타팀 404).
- 무인증 공개 접근이 /api/share/* 만 되고 다른 /api/* 는 여전히 401(격리).
- 프론트: 공유 모달·URL복사·공유뷰(비번 프롬프트→읽기전용 견적). 앱 로그인/기존 견적·발주 회귀. v1~v16 무손상.

---

# v18 확장 — 견적 강화 A (유효기간 프리셋 #1 · 자동명명/버전 #2 · 템플릿 #3)

> 사용자 5차 요청 중 견적 관련 3개(리서치 불필요). **v1~v17 동작/엔드포인트/UI 100% 보존**(컬럼 ADD COLUMN IF NOT EXISTS, 새 테이블 CREATE IF NOT EXISTS). 팀 스코핑(v13) 준수.

## 18-1 유효기간 프리셋 (#1 — 순수 프론트)
- 견적 에디터 유효기간(valid_until) 입력 옆에 **프리셋 버튼 [1주][2주][1개월][3개월]**. 클릭 시 `valid_until = (estimate_date || 오늘) + 기간`(1주=+7d, 2주=+14d, 1개월=+1달, 3개월=+3달, 달 계산은 월 단위 add). 수동 날짜 입력도 유지. estimate_date 변경 시 프리셋 재적용은 사용자 클릭 기준.

## 18-2 견적 자동명명 + 버전 (#2 — 백엔드 소폭 + 프론트)
### interior_estimates 확장 (ADD COLUMN IF NOT EXISTS)
- `version INT NOT NULL DEFAULT 1` (견적 버전)
### 엔드포인트
- **POST /api/estimates/:id/duplicate** (인증·팀 스코핑, requireChildOwned) → 그 견적을 **복제**(헤더+items 전부 복사)해 새 견적 생성: `version = (해당 현장 같은 계열 최대 version)+1` 또는 원본 version+1, title 은 아래 자동명명 규칙에 vN 반영, status='draft'. 응답 201 `{estimate 상세+totals}`. (원본 불변)
- 기존 POST/PUT estimates 는 title 자유. 
### 자동명명 규칙 (프론트에서 생성, 서버는 받은 title 저장)
- 저장/새버전 시 title 기본 제안: **`{현장명}-{YYYYMMDD}-{HHMM}-{담당자|client_name}-v{version}`** (사용자 편집 가능). 담당자 없으면 생략. 
### UI (견적 에디터/목록)
- 저장 시 title 비었으면 위 규칙으로 자동 채움(수정 가능). **[새 버전으로 저장(v2)]** 버튼 → duplicate 호출 → 새 견적 에디터로. 견적 목록에 **버전 뱃지(v1/v2)** + 같은 계열 묶어 보기(정렬 version). 
- **권장안 안내(사용자에게 보고용, UI 툴팁/설명):** "임시저장은 자동명명으로 1건씩 쌓이고, 큰 변경은 [새 버전으로 저장]으로 v2 를 만들어 v1 과 나란히 비교·보관" — 덮어쓰기 대신 버전 누적.

## 18-3 견적 템플릿 (#3 — 백엔드 테이블 + 프론트)
### 새 테이블 interior_estimate_templates (CREATE TABLE IF NOT EXISTS, 팀 스코핑)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | bigint identity PK | |
| team_id | bigint | 팀 스코핑(v13, GET 필터/POST 세팅) |
| name | text NOT NULL | 템플릿명(예: '사무실 저가공사형','아파트 리모델링 중급형') |
| description | text default '' | 설명 |
| config | jsonb default '{}' | 원가계산 가정: {vat_mode, vat_rate, discount, use_cost_buildup, indirect_material_rate, indirect_labor_rate, safety_insurance_rate, employment_insurance_rate, safety_mgmt_rate, other_expense_rate, admin_rate, design_rate, profit_rate, round_unit} |
| items | jsonb default '[]' | 기본 공종 항목 배열 [{trade,name,spec,unit,qty,material_price,labor_price,sub_price,memo}] (예: 가설공사/청소공사/설계비 등) |
| created_at | timestamptz default now() | |
### 엔드포인트 (인증·팀 스코핑)
- `GET /api/estimate-templates` (team_id 필터), `POST` (name 필수, team_id=req.teamId), `PUT /api/estimate-templates/:id`, `DELETE /api/estimate-templates/:id` (소유검증 404). config/items JSON 검증(items 각 name 필수).
### UI
- **관리 탭(또는 견적 탭)에 템플릿 관리 섹션**: 목록/추가/수정/삭제. 템플릿 편집기 = 견적 에디터 축소판(공종 항목 그리드 + 원가계산 요율). 예시 시드는 강요 안 함(사용자가 자기 템플릿 구성).
- **견적 생성 시 [템플릿으로 시작] 드롭다운**: 선택 시 그 템플릿의 items+config 를 새 견적 에디터에 프리필(이후 자유 편집·확정→예산연동 기존대로). (v15 '견적으로 현장 만들기'와도 병행 가능하면 좋음: 템플릿 선택 → 항목 프리필)
- 폴백(localStorage): templates CRUD + 견적 프리필 클라 처리(서버 우선).

## 검증
- 18-1: 프리셋 클릭 → valid_until = 작성일+기간 정확.
- 18-2: version 컬럼·duplicate 엔드포인트(복제본 version+1·items 복사·원본 불변), 자동명명 title, 목록 버전뱃지.
- 18-3: template CRUD(팀 스코핑), 템플릿으로 견적 프리필(items+요율). 타팀 template 404.
- v1~v17 회귀 무손상(8탭·로그인·공유·타임라인·견적 확정→예산 등).

---

# v19 확장 — 일정 공사/지원 구분 + [공정|지원|전체] 필터 + 미팅 연동 (Phase B, #4)

> 사용자 요청 + 노션 리서치: 안도공간 노션 공정표는 `유형`(공정/지원/AS) 단일 select로 구분, 캘린더는 공정+지원 표시·AS 분리, 미팅은 별도 DB. → 앱은 interior_schedule 에 `kind`(공사/지원/미팅) 추가, 일정표에 [공정|지원|전체] 필터, **미팅 kind 일정은 미팅·AS 탭에 자동 연동**. **v1~v18 동작/엔드포인트/UI 100% 보존**(컬럼 ADD COLUMN IF NOT EXISTS).

## 스키마 (ADD COLUMN IF NOT EXISTS)
- `interior_schedule` + `kind TEXT NOT NULL DEFAULT '공사'` (공사/지원/미팅). 서버상수 `SCHEDULE_KINDS=['공사','지원','미팅']`(목록 외 '공사' 보정).
- `interior_meetings` + `schedule_id BIGINT` (nullable; kind='미팅' 일정에서 연동 생성된 미팅의 원본 일정 링크. 수동 미팅은 null).

## 미팅 연동 규칙 (일정 → 미팅, 단방향)
- 일정 POST/PUT 시 `kind==='미팅'` 이면 → **interior_meetings 에 연동행 upsert**(schedule_id=그 일정): meeting_date=start_date, title=schedule.title, attendees=staff, content=memo, next_action='' (기존 값 있으면 보존적으로 갱신). 
- 일정 kind 가 '미팅'→다른값으로 바뀌거나 일정 DELETE 시 → 연동된 meeting 행 삭제(schedule_id 매칭).
- 미팅·AS 탭의 미팅 목록 = interior_meetings 전체(연동행 포함). 연동행은 **"📅 일정 연동" 뱃지 + 미팅탭에서 읽기전용**(수정은 일정에서). 수동 미팅은 기존대로 CRUD.

## 엔드포인트
- 일정 GET/POST/PUT(`/api/sites/:id/schedule`, `/api/schedule/:id`) 응답·body 에 `kind` 포함(미전달 시 기본 '공사'/기존값). 미팅 연동 upsert/삭제는 위 규칙대로 서버가 처리(트랜잭션 권장). 팀 스코핑(v13) 유지.
- 미팅 GET(`/api/sites/:id/meetings`) 응답에 `schedule_id`(null 또는 링크) 포함. 연동 미팅의 직접 PUT/DELETE 는 허용하되(또는 400 안내), 기본은 프론트가 읽기전용 처리.

## UI (일정 탭)
- 일정 생성/수정 폼에 **유형(kind) 선택**: 공사(기본)/지원/미팅. (미팅 선택 시 "미팅·AS 탭에도 표시됩니다" 안내)
- 캘린더·타임라인·목록 상단에 **[공정] [지원] [전체] 필터 버튼**(기본 전체 또는 공정+지원). 공정=kind '공사'. 필터에 따라 표시 일정 제한. 미팅 kind 는 별도 색/아이콘(📅)으로 구분 표시(전체에서 보임).
- kind 별 시각 구분(공사=기존 공정색, 지원=톤 다르게, 미팅=📅). 
- 미팅·AS 탭: 미팅 목록에 연동행 "📅 일정 연동" 뱃지 표시(읽기전용). 
- 폴백(localStorage): schedule.kind 보존 + 미팅 연동(kind='미팅'→ meetings 스토어에 schedule_id 링크 upsert, 삭제 동기화) 클라 처리.

## 검증
- schedule +kind CRUD(공사/지원/미팅, 보정). 
- **미팅 연동**: kind='미팅' 일정 생성 → interior_meetings 에 schedule_id 링크행 생성(미팅탭에 표시) → 그 일정 수정(title/date) → 연동 미팅 갱신 → 일정 삭제 → 연동 미팅 삭제. kind '미팅'→'공사' 변경 시 연동 미팅 삭제.
- 필터 [공정|지원|전체] 표시 제한. 
- v1~v18 회귀(캘린더 드래그·cascade·타임라인·선후관계·일정표PDF·.ics).

---

# v20 확장 — 자료(파일 #6) + 현장사진(#7), Supabase Storage 직접 업로드 (Phase C)

> 사용자 결정: 파일 저장 = **Supabase Storage**. 노션 리서치: 자료=자료유형/담당자/URL/파일, 현장사진=날짜/공정(다중)/촬영자(자동)/특이사항/현장. **Vercel 함수 본문 4.5MB 제한 회피 위해 클라이언트가 Storage로 직접 업로드(서명 URL)**. v1~v19 100% 보존. 새 패키지 없음(내장 fetch로 Storage REST).

## 환경변수
- `SUPABASE_URL`(=.env, https://<ref>.supabase.co), `SUPABASE_SERVICE_KEY`(service_role, 서버 전용·비밀). 둘 다 없으면 업로드 엔드포인트는 **503 {error:'스토리지 미설정'}**(앱 나머지는 정상). 로컬 .env + Vercel env 에 설정.

## Storage 인프라 (server.js)
- 버킷 상수 `STORAGE_BUCKET='interior-files'`(private). 부팅 시(키 있으면) 버킷 없으면 생성: `POST {SUPABASE_URL}/storage/v1/bucket` `{id,name,public:false}` (이미 있으면 409 무시). 실패해도 앱 부팅은 계속.
- 경로 규약: `sites/{site_id}/documents/{timestamp}_{safeName}` , `sites/{site_id}/photos/{timestamp}_{safeName}`.
- **서명 업로드 URL**: `POST {SUPABASE_URL}/storage/v1/object/upload/sign/{bucket}/{path}` (Authorization: Bearer SERVICE_KEY) → 응답 `{url}`. 클라 업로드 최종 URL = `{SUPABASE_URL}/storage/v1{url}` (PUT, body=파일, header `x-upsert:true`).
- **서명 다운로드 URL**: `POST {SUPABASE_URL}/storage/v1/object/sign/{bucket}/{path}` `{expiresIn:3600}` → `{signedURL}`. 전체 = `{SUPABASE_URL}/storage/v1{signedURL}`.
- **삭제**: `DELETE {SUPABASE_URL}/storage/v1/object/{bucket}/{path}`.

## 20-2 자료 (interior_documents)
### 테이블 (CREATE IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id / site_id(FK CASCADE) | | 팀 스코핑=site 소유검증 |
| name | text NOT NULL | 자료명 |
| doc_type | text default '기타' | CAD/도면/제안서/스펙/견적/계약/기타 |
| storage_path | text default '' | Storage 경로(직접업로드 결과) |
| file_name | text default '' | 원본 파일명 |
| file_size | bigint default 0 | 바이트 |
| uploader | text default '' | 업로드 담당자(로그인 사용자명) |
| memo | text default '' | |
| created_at | timestamptz default now() | |
### 엔드포인트 (인증·팀 스코핑, site 소유검증)
- `POST /api/sites/:id/documents/sign-upload` `{file_name, content_type}` → 서명 업로드 URL + storage_path 반환(스토리지 미설정 503).
- `GET /api/sites/:id/documents` (created_at DESC). 
- `POST /api/sites/:id/documents` `{name, doc_type?, storage_path, file_name?, file_size?, memo?}` → 메타 기록 201(uploader=req 사용자명; 서버가 users 조회 or 프론트 전달값).
- `PUT /api/documents/:id`(name/doc_type/memo), `DELETE /api/documents/:id` → Storage 파일도 삭제 시도(베스트에포트) + 행 삭제.
- `GET /api/documents/:id/download` → 서명 다운로드 URL(JSON `{url}` 또는 302 redirect). 미설정/없음 처리.

## 20-3 현장사진 (interior_photos)
### 테이블 (CREATE IF NOT EXISTS)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id / site_id(FK CASCADE) | | |
| photo_date | date | 촬영일(사용자 지정, 기본 오늘) |
| processes | text default '' | 공정(다중, 콤마문자열; 노션 25종 참고) |
| storage_path | text default '' | |
| file_name | text default '' | |
| uploader | text default '' | 업로더(자동=로그인 사용자) |
| memo | text default '' | 특이사항 |
| created_at | timestamptz default now() | 업로드 시각(자동) |
### 엔드포인트 (인증·팀 스코핑)
- `POST /api/sites/:id/photos/sign-upload`(동형), `GET /api/sites/:id/photos`(photo_date DESC, created_at DESC), `POST /api/sites/:id/photos` `{photo_date?, processes?, storage_path, file_name?, memo?}`(uploader 자동, photo_date 기본 오늘), `DELETE /api/photos/:id`(Storage 삭제+행), `GET /api/photos/:id/download`(서명 URL).

## UI (프론트) — 새 탭 2개
- **📁 자료 탭**(현장 종속): 파일 선택 → sign-upload → 클라가 Storage 직접 PUT → 메타 POST. 목록(자료명/유형뱃지/파일명/크기/업로더/일시) + 다운로드(서명URL) + 수정/삭제. 자료유형 드롭다운.
- **📷 현장사진 탭**(현장 종속, 모바일 카메라): `<input accept="image/*" capture="environment">` → 업로드. **날짜/공정(다중선택 칩)** 지정, **업로더·시각 자동**. 갤러리(썸네일=서명URL) + 날짜/공정 필터 + 삭제. 
- 탭 순서에 자료·현장사진 추가(적절한 위치). 스토리지 미설정(503) 시 "관리자 설정 필요" 안내.
- 폴백(localStorage): 서버 미연결 시 메타만 로컬(파일 업로드는 서버 전용 안내).

## 검증
- (키 있을 때) sign-upload→직접 PUT→메타 POST→목록/다운로드(서명URL 열림)→삭제(Storage+행). 사진 날짜/공정/업로더자동. 팀 스코핑(타팀 site 404). 키 없으면 업로드 503, 앱 나머지 정상.
- v1~v19 회귀.
