# 국내 인테리어 자재 종합 DB (material-research)

국내 인테리어에 사용되는 **모든 자재를 한 곳에 모은 베이스라인 DB(seed)** 위에,
**매주 월요일 업데이트 에이전트**가 신규 자재·가격 변동을 *덮어쓰지 않고 누적/갱신(changelog)* 하는 구조의 자재 데이터베이스 웹앱입니다.

```
① 풍부한 자재 베이스라인(SEED, 314건)  +  ② 주간 업데이트 레이어(import API)
```

- 가격은 일반 도메인 지식 기반의 **시세 '범위'(min~max) — 기준선/추정**이며 정밀 견적이 아닙니다(`source: "seed"`).
- 출처가 붙은 정밀 단가는 매주 월요일 research 에이전트가 `POST /api/materials/import`(`source: "research"`)로 갱신합니다.

---

## 실행법

```bash
cd material-research
npm install            # express 설치
node server.js         # http://localhost:3011
```

- 포트: **3011** (interior-cost 3010과 충돌 없음). `PORT=4000 node server.js` 로 변경 가능.
- 최초 부팅 시 `data/materials.json` 이 없으면 server.js 내장 **SEED 배열(314건)** 로 자동 시드합니다.
- 영속성: 외부 DB 없이 `data/materials.json` + `data/changelog.json` (임시파일 write 후 rename 하는 **원자적 쓰기**).

---

## 파일 구조

| 파일 | 설명 |
|---|---|
| `server.js` | Express 서버 + 내장 SEED + 모든 API |
| `index.html` | 단일 파일 브라우즈/검색 UI (vanilla JS, 무프레임워크) |
| `data/materials.json` | 자재 DB (seed로 시작, 주간 누적) |
| `data/changelog.json` | 주간 업데이트 로그 |
| `package.json` / `.gitignore` | 의존성 / node_modules 무시 |

## 자재 스키마

```jsonc
{
  "id": "바닥공사-바닥재-동화자연마루-나투스강-7-5t-광폭",  // 안정적 slug (trade+category+name+spec)
  "trade": "바닥공사",        // 21공종 그룹값
  "category": "바닥재",       // 대분류
  "subcategory": "강마루",    // 중분류
  "name": "동화자연마루 나투스강",
  "spec": "7.5T 광폭",
  "unit": "M2",
  "brands": ["동화자연마루"],
  "price": { "min": 38000, "max": 60000, "unit": "M2", "note": "기준선/추정 시세(범위) — 정밀 견적 아님" },
  "grade": "중급",            // 보급|중급|고급
  "use": "거실·주방 바닥",
  "notes": "HDF 코어 강마루, 생활방수·내구성",
  "source": "seed",           // seed | research | manual
  "collected_date": "2026-06-30",
  "updated_at": "2026-06-30T..."
}
```

---

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 상태 체크 |
| GET | `/api/materials?search=&trade=&category=&subcategory=&grade=&limit=` | 필터 목록 + `total` |
| GET | `/api/materials/:id` | 단건 + 해당 자재 `history`(changelog) |
| GET | `/api/categories` | trade→category→subcategory 트리 + 카운트 |
| GET | `/api/stats` | 총건수, 대분류/공종/등급별 카운트, lastUpdated, 이번주 추가/변경 |
| POST | `/api/materials/import` | **멱등 UPSERT** — 월요일 에이전트 호출 핵심 |
| GET | `/api/changelog?since=&type=&limit=` | 주간 업데이트 피드(최신순) |
| PATCH | `/api/materials/:id` | (선택) 수동 편집 |
| DELETE | `/api/materials/:id` | (선택) 삭제 |

응답 형식: `{ success: boolean, data: any, message?, total? }`

---

## 주간 업데이트 동작 (핵심)

매주 월요일 research 에이전트가 출처 있는 단가를 모아 아래처럼 보냅니다.
베이스라인은 **보존**되고 변경분만 갱신되며, 모든 변경은 `changelog`에 기록됩니다.

### 멱등 UPSERT 규칙 — `POST /api/materials/import`

```jsonc
// body
{
  "source": "research",          // 생략 시 'research'
  "note": "2026-W27 주간 단가 갱신",
  "items": [
    {
      "trade": "바닥공사", "category": "바닥재", "subcategory": "강마루",
      "name": "동화자연마루 나투스강", "spec": "7.5T 광폭", "unit": "M2",
      "brands": ["동화자연마루"], "price": { "min": 41000, "max": 63000 },
      "grade": "중급", "use": "거실 바닥", "notes": "출처: ○○몰"
    }
  ]
}
```

- **매칭 키**: `id`(있으면 우선) → 없으면 복합키 `trade + name + spec`
- 신규 → insert (`changelog: "new"`)
- 기존 + **가격 변동** → update (`changelog: "price_up"` / `"price_down"`)
- 기존 + 규격·브랜드·등급 등 변경 → update (`changelog: "update"`)
- 동일 → **무시(unchanged)** → 같은 body 재전송 시 멱등(아무 것도 바뀌지 않음)

```jsonc
// 응답
{ "success": true,
  "data": { "imported": 1, "updated": 2, "unchanged": 5, "processed": 8, "total": 315, "changelogAdded": 3, "skipped": [] } }
```

### 월요일 import 샘플 curl

```bash
curl -s -X POST http://localhost:3011/api/materials/import \
  -H "Content-Type: application/json" \
  -d '{
    "source":"research",
    "note":"2026-W27 주간 단가",
    "items":[
      {"trade":"바닥공사","category":"바닥재","subcategory":"강마루","name":"동화자연마루 나투스강","spec":"7.5T 광폭","unit":"M2","brands":["동화자연마루"],"price":{"min":41000,"max":63000},"grade":"중급"},
      {"trade":"타일공사","category":"타일","subcategory":"포세린","name":"신규 수입 포세린","spec":"800x800","unit":"장","brands":["수입"],"price":{"min":15000,"max":30000},"grade":"중급","use":"거실 바닥"}
    ]
  }'
```

이렇게 "모든 자재를 모아놓고, 그 위에 매주 업데이트가 누적" 됩니다.
research 스킬/주간 cron은 위 엔드포인트로 결과를 POST 하기만 하면 됩니다.
