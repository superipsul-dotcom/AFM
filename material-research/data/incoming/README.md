# data/incoming/ — 주간 업데이트 드롭 폴더 (클라우드 → 레포 → 로컬 브릿지)

매주 월요일 리서치(클라우드 트리거)는 사용자 PC의 `localhost:3011`에 직접 닿을 수 없다.
그래서 **import 포맷 JSON 한 개**를 이 폴더에 커밋(`material-research/data/incoming/자재DB-YYYY-MM-DD.json`)하면,
사용자가 레포를 pull 한 뒤 로컬 앱이 자동으로 흡수한다.

## 흡수 시점
- **서버 부팅 시** 자동 (`node server.js` → `ingestIncomingDir()`)
- **수동/즉시**: 서버가 떠 있는 상태에서 `POST /api/materials/sync`

흡수되면 항목은 `materials.json`에 멱등 UPSERT 되고 변경은 `changelog.json`에 기록되며,
처리된 봉투 파일은 `processed/`(git 무시)로 이동한다. import는 멱등이라 재처리해도 중복이 생기지 않는다.

## 파일 포맷 (`POST /api/materials/import` 와 동일)
```jsonc
{
  "source": "research",
  "note": "2026-W27 주간 단가 갱신",
  "items": [
    {
      "trade": "바닥공사", "category": "바닥재", "subcategory": "강마루",
      "name": "동화자연마루 나투스강", "spec": "7.5T 광폭", "unit": "M2",
      "brands": ["동화자연마루"], "price": { "min": 41000, "max": 63000 },
      "grade": "중급", "use": "거실 바닥", "notes": "출처: ○○몰 / 2026-06-30"
    }
  ]
}
```
- 매칭 키: `id`(있으면 우선) → 없으면 `trade + name + spec`
- 신규=insert(`new`), 가격변동=update(`price_up`/`price_down`), 규격·브랜드 변경=`update`, 동일=무시
- 최상위가 배열(`[ {...}, ... ]`)이어도 되며, 이때 `source`는 `research`로 간주한다.
