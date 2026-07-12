# PLAN-V2 — 다음 세션 실행 체크리스트 (오케스트레이터용)

> 배경: 2026-07-12 세션에서 v2 요청 10건 접수. **이 세션은 셸(Bash)이 하니스 오류로 전면 고장**
> (echo 포함 전 명령 exit 1, 서브에이전트도 동일) → 파일 작성만 완료. 실행·검증·이미지 수집이 남음.
> v1 앱(index.html)은 검증된 상태 그대로 미수정. 사용자 요청 원문과 해석은 SPEC.md 하단 "v2 업데이트 요구사항" 참조.

## 이미 완료 (이 폴더에 파일 존재)

- [x] `SPEC.md` 에 v2 요구사항 10건 정밀 스펙 + 새 수용 테스트 기대값 (하단 섹션)
- [x] `server.js` — Express+pg(Supabase)+bcryptjs+JWT, roof_ 3테이블 자동생성, 초대코드 가입 (week-5/community 패턴 계승)
- [x] `package.json` (deps: express/pg/bcryptjs/jsonwebtoken/dotenv), `.env` (DATABASE_URL=기존 Supabase 재사용, PORT=3015, JWT_SECRET 신규, ROOF_INVITE_CODE=ando2026), `.gitignore`
- [x] `test-server.mjs` — 서버 자동 기동 e2e 22체크 (헬스/정적/.env차단/가입·로그인/견적CRUD·작성자·메모/단가공유/404)

## 남은 작업 (순서대로)

### 1. 서버 검증 (5분)
```bash
cd '/Users/pyounghwahong/AFM/역전지붕방수 견적 app'
npm install
node test-server.mjs   # 22/22 통과할 때까지 server.js 수정
```

### 2. 자재 이미지 수집 (오케스트레이터 직접, 30~40분)
- WebSearch/WebFetch 로 제품 이미지 URL 확보 → `curl -L -o` 다운로드 → `sips -Z 640` 리사이즈 → `images/materials/` 저장 → `images/materials/manifest.json` 작성 (`{ "<imgKey>": "<파일명>" }`).
- imgKey 목록과 검색어:
  | imgKey | 검색어 |
  |---|---|
  | xps | 아이소핑크 압출법 보온판 XPS |
  | vb_siga | SIGA Majcoat 150 roof membrane |
  | vb_pro | pro clima SOLITEX MENTO 3000 |
  | tape_siga | SIGA Wigluv 60 tape |
  | tape_pro | pro clima TESCON VANA 60 |
  | drain | 조경용 배수판 500x500 (티푸스 배수판) |
  | fabric | 부직포 300g 롤 토목 |
  | gravel | 쇄석 25-40mm 톤백 |
  | silicon | 우레탄 실리콘 실란트 카트리지 |
  | trench_floor / trench_side | 티푸스코리아 역전지붕 트렌치 (tifus.co.kr) |
  | ped_jap / ped_pey / ped_wood | 타일 페데스탈 / Peygran pedestal |
  | tile | 포세린타일 600x600 20T 외장 |
  | deck | 합성목재 데크 |
  | frame | 아연도금 각관 |
  | membrane_adex | ARDEX WPM 방수 |
  | membrane_sika | Sikalastic 590 |
  | membrane_urethane | 우레탄 방수 상도 |
  | membrane_adhero | pro clima ADHERO 1000 |
  | membrane_weldano | pro clima WELDANO 3000 |
  | membrane_bituthene | GCP Bituthene 3000 |
  | corner | 삼각면목 PVC 면귀 |
  | crc | CRC보드 시멘트보드 |
  | stainless / hamseok | 스테인리스 판재 / 함석판 |
- 전부 못 구해도 됨(≥15키 목표, 총량 ≤3MB). **manifest 에 없는 키는 UI가 이미지 없이 렌더**(스펙 V2-1) → 부분 수집 OK.

### 3. UI v2 빌드 — single-react-dev 에이전트 (세션 재시작으로 기존 에이전트 ID는 소멸 → 새로 스폰)
프롬프트 요지:
- `SPEC.md` **전체**(v1 + 하단 v2 섹션) 필독. v2 10건을 `index.html` 에 반영. calc-engine 분리 구조·classic JSX runtime 유지.
- 변경 핵심: ①부자재 netCost 포함 기본(마이그레이션+토글) ②자재DB 탭+`computeEstimate(est, overrides)` ③finishAll 체크박스 ④addl 객체화(수량/단가/할증 인라인) ⑤구역 10개 ⑥헤더 [🖨 인쇄|⬇ 내보내기]→견적서·내역서·자재소개 순 결합 문서 ⑦내비 직원용/고객제출용 그룹 분리 ⑧저장목록 작성자+메모 ⑨로그인/서버 동기화(+로컬 모드 폴백, /api 계약은 server.js) ⑩자재소개 manifest 이미지.
- `test.mjs` 를 SPEC "V2 검증" 6케이스로 갱신 → `node test.mjs` 전부 통과까지 반복.
- `README.md` v2 갱신 (npm start, 로그인, 초대코드, 로컬 모드).

### 4. 통합 검증 (오케스트레이터)
```bash
node test.mjs          # 새 기대값: grandTotal 30,133,213.8756 (부자재 포함 기본)
node test-server.mjs   # 22/22
npm start &            # http://localhost:3015
```
- Playwright: 가입(초대코드 ando2026)→로그인→동삭동 샘플→총합계 **₩30,133,214** 확인→자재DB 오버라이드 저장/반영→저장목록 작성자·메모→인쇄 미리보기(견적서→내역서→자재소개 순)→자재소개 이미지 렌더. 스크린샷 `screenshots/app-v2.png`.
- 완료 후 메모리(roof-estimate-app.md) 갱신.

## 주의
- index.html 수정은 UI 에이전트만. server.js·.env 는 완성본 — 테스트 실패 시에만 손댄다.
- 기존 저장 견적(localStorage v1) 마이그레이션 경로(SPEC V2-3/4/5) 빠뜨리지 말 것.
- .env 는 커밋 금지(.gitignore 처리됨). 초대코드 변경은 .env 수정+서버 재시작.
