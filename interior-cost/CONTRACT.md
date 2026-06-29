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
