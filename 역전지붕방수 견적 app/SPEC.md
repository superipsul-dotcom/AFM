# 역전지붕방수 견적 앱 — SPEC (v1)

원본: `동삭동 역전지붕방수 견적서 260630.xlsx` (안도공간 역전지붕공사 견적서 템플릿 V5 계열).
엑셀의 시트 구조(견적입력 → DB 216행 → 소비자용 견적서/내역서/발주서/자재소개/표지)를 **단일 index.html 앱**으로 재현한다.
**계산 결과는 엑셀과 1원 단위(부동소수 오차 ±1)로 일치해야 한다.** 아래 "수용 테스트" 참조.

---

## 1. 회사 상수

- 회사명: **(주)안도공간** / 安堵空間
- 주소: 서울 성동구 성수이로 147 아이에스비즈타워, 1201호
- 대표전화: 02-2088-7151 / HP: 010-3246-2251, 010-9070-7304 / FAX: 0504-269-7304
- 이메일: contact@andospace.com
- 표지 기본 문구: `1. 전체 주간공사 기준입니다.` / `2. 용전용수 지원 조건입니다.` / `3. 견적 외 공사 미 포함입니다.`

## 2. 견적 입력 모델 (estimate JSON)

```js
{
  id, createdAt, updatedAt,
  info: { title:'', address:'', date:'YYYY-MM-DD', manager:'', leadSource:'', customerContact:'', requestDate:'', note:'' },
  zones: [ // 최대 5개 (A~E구역), 각 구역:
    { label:'옥상', floor: 0/*바닥면적 m²*/, parapetLen: 0/*파라펫 길이 m*/, parapetH: 0/*파라펫 높이 m*/,
      finish:'쇄석'|'타일'|'우드'|'조경', wallFinish:'없음'|'스테인리스'|'함석'|'crc보드' }
  ],
  sel: {
    sanding:'아니오'|'예',            // 철거공사(바닥샌딩)
    cornerBead:'없음'|'삼각면귀 30각'|'젤리밴드'|'weldano 3000',
    siliconEa: 10,                    // 우레탄실리콘 (ea)
    primer:'아니오'|'예',             // 바닥면 프라이머 (예 → 바탕면정리 + 프라이머 두 항목 활성)
    ownerSupplied:'아니오'|'예',      // 단열재 지급자재 (예 → XPS 바닥/벽체 재료비 합계=0, 노무만)
    membrane:'없음'|'아덱스 WPM 003 ROOFTOP'|'Sikalastic 590'|'우레탄방수'|'adhero 1000'|'adhero 3000'|'weldano 3000'|'Bituthene 3000'|'지정시트',  // 1차방수
    xps1:'100T', xps2:'150T',         // XPS 두께 1P/2P (바닥): 없음|50T|70T|80T|100T|120T|150T|200T
    xpsWall:'30T벽',                  // 없음|30T벽|70T벽
    vaporBarrier:'SIGA'|'프로클리마', // 투습방수지
    tape:'SIGA'|'프로클리마',         // 기밀테이프
    drainBoard:'잡자재'|'티푸스',     // 배수판
    fabric:'잡자재'|'티푸스',         // 부직포
    gravelPack:'톤백'|'소분포장',     // 쇄석 포장
    trenchFloorEa: 6, trenchSideEa: 0,
    tileSub:'잡자재 사 페데스탈'|'페이그란 페데스탈',      // 타일 부자재 (타일면적>0일 때)
    tileFinish:'20T타일(중국산)'|'20T타일(유럽산)',        // 타일 마감재
    woodFinish:'합성데크'|'없음',                          // 우드 마감재 (우드면적>0 → 페데스탈+각관 자동)
  },
  temp: { // ④ 가설공사
    equipment: [ {name:'크레인(50톤) 0.5일', qty:1}, ... ],  // 장비 카탈로그에서 추가하는 동적 리스트
    forkliftQty: 2,                       // 지게차 80,000/대
    waste:'폐기물 1ton'|'폐기물 2.5ton'|'없음', wasteQty: 1,  // 550,000 / 900,000
    freight:'서울·경기'|'지방',           // 500,000 / 1,000,000 (수량 1 고정)
  },
  addl: { acMove:'아니오', insulDoor:'아니오', flowerbed:'아니오', fireDoor:'아니오',
          floorFrame:'아니오', raise:'아니오', crack:'아니오' },   // ⑤ 추가공사 예/아니오
  customItems: [ // 추가공사 직접 입력 (엑셀의 "추가공사 AI 입력란" 대체)
    { work:'벽체 단열 추가', name:'XPS 가등급 100T 900*1800 / 벽체 추가단열 (연질폼 포함)', unit:'m2', qty:6,
      matPrice:10340, matSurKey:'xpsFloor', labPrice:10000, labSurKey:'wallFinishLab', subPrice:8200, subSurKey:null }
  ],
  surcharges: { // ⑥ 할증률 (기본값)
    primary:{mat:1.2, lab:1.2},      // 1차 방수 (바탕면정리·삼각면귀·프라이머·1차방수에 적용)
    sanding:{mat:0.05, lab:0.05},
    xpsFloor:{mat:0.1},              // XPS 바닥 재료 (노무할증은 0.03 고정)
    xpsWallLab:{lab:0.05},           // XPS 벽체 노무
    sheet:{mat:0.05, lab:0.05},      // 투습방수지 + 기밀테이프
    drain:{mat:0.05, lab:0.05},      // 배수판 + 부직포
    gravelFinish:{mat:0.1, lab:0.1}, // 쇄석 + 트렌치 + 우레탄실리콘
    wallFinish:{mat:0.05, lab:0.05}, // 벽체마감(스테인리스/함석) — ※crc보드는 pedestalSub(0) 사용 (엑셀 동작 재현)
    pedestalSub:{mat:0, lab:0},      // 부자재(페데스탈) + crc보드
    finishMat:{mat:0, lab:0},        // 마감재(타일/데크)
    insulDoor:{mat:0, lab:0}, flowerbed:{mat:0, lab:0}, fireDoor:{mat:0, lab:0},
    floorFrame:{mat:-0.5, lab:-0.5}, raise:{mat:0, lab:0}, crack:{mat:0, lab:0},
  },
  rates: { indirectMat:0.025, indirectLab:0.03, genAdmin:0.10, design:0, profit:0.10, taxInvoice:'예'|'아니오' },
  siteNotes: [true/false × 8] + customNotes:[string],  // §7 특이사항
  siteCond: { under100:'아니오', floors:'1-5층'|'6-10층'|'10층 이상', craneOk:'가능'|'불가능', region:'서울·경기'|'지방' },
}
```

## 3. 파생 수량 (엑셀 견적입력 시트 재현)

- `floorSum` = Σ zones.floor (엑셀 G9)
- `parapetLen` = Σ zones.parapetLen (G10)
- `wallArea` = Σ (zone.parapetLen × zone.parapetH) (B18=26.52 샘플)
- `waterproofArea` = floorSum + wallArea (B15, 총 방수면적)
- `tapeLen` = parapetLen × 2 (기밀테이프 m)
- `gravelArea` = Σ floor of zones with finish=쇄석 / `tileArea` = …타일 / `woodArea` = …우드 / 조경 = 비용 미계상
- `wallStain/wallHamseok/wallCrc` = Σ (len×h) of zones by wallFinish (없음 = 미계상)
- 배수판·부직포 수량 = **floorSum 전체** (마감 종류 무관, B19=G9)
- XPS 1P·2P 수량 = 각각 floorSum (같은 두께 선택 시 해당 항목 수량 = floorSum×2 로 합산됨)

## 4. 항목 DB (ITEM_DB)

행 공통 계산 (엑셀 DB 시트의 열 구조):
```
matFinal = matPrice × (1 + matSur)   // 최종단가1
labFinal = labPrice × (1 + labSur)   // 최종단가2
subFinal = subPrice × (1 + subSur)   // 최종단가3 (subSurKey 없으면 subPrice 그대로)
matTotal = qty × matFinal   (※ ownerSupplied=예 이고 xps 카테고리면 matTotal=0, 단가 표시는 유지)
labTotal = qty × labFinal
subTotal = qty × subFinal
rowTotal = matTotal + labTotal + subTotal
```
**계산 중간에 반올림 금지** (표시할 때만 `Math.round` + `toLocaleString('ko-KR')`).

아래 JSON을 그대로 코드에 내장한다. `qty`: 수량 소스 코드, `on`: 활성 조건.
qty 코드: `WP`=waterproofArea, `FLOOR`=floorSum, `WALL`=wallArea, `PLEN`=parapetLen, `TAPE`=tapeLen,
`GRAVEL`/`TILE`/`WOOD`=마감별 면적, `W_STAIN`/`W_HAM`/`W_CRC`=벽체마감 면적, `N`=직접 수량 입력, `ONE`=1식.

```json
[
 {"id":"d_flower","grp":"철거공사","grpSub":"기초공사","work":"철거","name":"화단철거","unit":"식","qty":"ONE","on":"addl.flowerbed=예","mat":0,"sur":"flowerbed","lab":400000,"sub":0,"vendor":null,"cat":null},
 {"id":"d_sand","grp":"철거공사","grpSub":"기초공사","work":"바닥샌딩","name":"기존 우레탄 바닥 샌딩","unit":"m2","qty":"WP","on":"sel.sanding=예","mat":2500,"sur":"sanding","lab":15000,"sub":0},

 {"id":"r_base","grp":"역전지붕공사","grpSub":"역전지붕방수","work":"1차 방수공사","name":"바탕면 정리","unit":"m2","qty":"WP","on":"sel.primer=예","mat":500,"sur":"primary","lab":1500,"sub":0},
 {"id":"r_cb1","grp":"역전지붕공사","work":"1차 방수공사","name":"삼각면목30*30 + 실리콘취부","unit":"M","qty":"PLEN","on":"sel.cornerBead=삼각면귀 30각","mat":1450,"sur":"primary","lab":2000,"sub":0,"cat":"삼각면귀"},
 {"id":"r_cb2","grp":"역전지붕공사","work":"1차 방수공사","name":"삼각면목: 젤리밴드 + 지정 본드","unit":"M","qty":"PLEN","on":"sel.cornerBead=젤리밴드","mat":1450,"sur":"primary","lab":2000,"sub":0,"vendor":"잡자재","cat":"삼각면귀"},
 {"id":"r_cb3","grp":"역전지붕공사","work":"1차 방수공사","name":"삼각면목: 프로클리마 wedano 3000 + 지정 본드","unit":"M","qty":"PLEN","on":"sel.cornerBead=weldano 3000","mat":1450,"sur":"primary","lab":2000,"sub":0,"vendor":"프로클리마","cat":"삼각면귀"},
 {"id":"r_prim","grp":"역전지붕공사","work":"1차 방수공사","name":"바닥면 접착 증강제 도포(프라이머)","unit":"m2","qty":"WP","on":"sel.primer=예","mat":1000,"sur":"primary","lab":1500,"sub":0,"vendor":"잡자재"},
 {"id":"r_m1","grp":"역전지붕공사","work":"1차 방수공사","name":"아덱스 WPM 003 ROOFTOP","unit":"m2","qty":"WP","on":"sel.membrane=아덱스 WPM 003 ROOFTOP","mat":12925,"sur":"primary","lab":8500,"sub":0,"vendor":"잡자재","cat":"1차방수"},
 {"id":"r_m2","grp":"역전지붕공사","work":"1차 방수공사","name":"Sikalastic 590 (20kg/2회기준)","unit":"m2","qty":"WP","on":"sel.membrane=Sikalastic 590","mat":11000,"sur":"primary","lab":8500,"sub":0,"vendor":"시카","cat":"1차방수"},
 {"id":"r_m3","grp":"역전지붕공사","work":"1차 방수공사","name":"우레탄방수 / 상중하도 2~3mm","unit":"m2","qty":"WP","on":"sel.membrane=우레탄방수","mat":28600,"sur":"primary","lab":28000,"sub":0,"vendor":"삼화","cat":"1차방수"},
 {"id":"r_m4","grp":"역전지붕공사","work":"1차 방수공사","name":"프로클리마 adhero 1000 1.5m*30m","unit":"m2","qty":"WP","on":"sel.membrane=adhero 1000","mat":9288.888888888889,"sur":"primary","lab":7000,"sub":0,"vendor":"프로클리마","cat":"1차방수"},
 {"id":"r_m5","grp":"역전지붕공사","work":"1차 방수공사","name":"프로클리마 adhero 3000 1.5m*30m","unit":"m2","qty":"WP","on":"sel.membrane=adhero 3000","mat":11000,"sur":"primary","lab":7000,"sub":0,"vendor":"프로클리마","cat":"1차방수"},
 {"id":"r_m6","grp":"역전지붕공사","work":"1차 방수공사","name":"프로클리마 weldano 3000 1.5m*50m","unit":"m2","qty":"WP","on":"sel.membrane=weldano 3000","mat":20166.666666666668,"sur":"primary","lab":7000,"sub":0,"vendor":"프로클리마","cat":"1차방수"},
 {"id":"r_m7","grp":"역전지붕공사","work":"1차 방수공사","name":"Bituthene 3000","unit":"m2","qty":"WP","on":"sel.membrane=Bituthene 3000","mat":12155.000000000002,"sur":"primary","lab":9500,"sub":0,"vendor":"티푸스","cat":"1차방수"},
 {"id":"r_m8","grp":"역전지붕공사","work":"1차 방수공사","name":"지정 시트방수지","unit":"m2","qty":"WP","on":"sel.membrane=지정시트","mat":14300.000000000002,"sur":"primary","lab":8500,"sub":0,"vendor":"티푸스","cat":"1차방수"},

 {"id":"x200","grp":"역전지붕공사","work":"단열재 깔기 - 바닥","name":"XPS 가등급 200T 900*1800","unit":"m2","qty":"XPS:200T","mat":20350,"sur":"xpsFloor","lab":3500,"labSurFixed":0.03,"sub":0,"vendor":"부광스티로폴","cat":"XPS바닥"},
 {"id":"x150","grp":"역전지붕공사","work":"단열재 깔기 - 바닥","name":"XPS 가등급 150T 900*1800","unit":"m2","qty":"XPS:150T","mat":15400.000000000002,"sur":"xpsFloor","lab":3500,"labSurFixed":0.03,"sub":0,"vendor":"부광스티로폴","cat":"XPS바닥"},
 {"id":"x120","grp":"역전지붕공사","work":"단열재 깔기 - 바닥","name":"XPS 가등급 120T 900*1800","unit":"m2","qty":"XPS:120T","mat":12500,"sur":"xpsFloor","lab":3500,"labSurFixed":0.03,"sub":0,"vendor":"부광스티로폴","cat":"XPS바닥"},
 {"id":"x100","grp":"역전지붕공사","work":"단열재 깔기 - 바닥","name":"XPS 가등급 100T 900*1800","unit":"m2","qty":"XPS:100T","mat":10340,"sur":"xpsFloor","lab":3500,"labSurFixed":0.03,"sub":0,"vendor":"부광스티로폴","cat":"XPS바닥"},
 {"id":"x80","grp":"역전지붕공사","work":"단열재 깔기 - 바닥","name":"XPS 가등급 80T 900*1800","unit":"m2","qty":"XPS:80T","mat":8140.000000000001,"sur":"xpsFloor","lab":3500,"labSurFixed":0.03,"sub":0,"vendor":"부광스티로폴","cat":"XPS바닥"},
 {"id":"x70","grp":"역전지붕공사","work":"단열재 깔기 - 바닥","name":"XPS 가등급 70T 900*1800","unit":"m2","qty":"XPS:70T","mat":7130,"sur":"xpsFloor","lab":3500,"labSurFixed":0.03,"sub":0,"vendor":"부광스티로폴","cat":"XPS바닥"},
 {"id":"x50","grp":"역전지붕공사","work":"단열재 깔기 - 바닥","name":"XPS 가등급 50T 900*1800","unit":"m2","qty":"XPS:50T","mat":5100,"sur":"xpsFloor","lab":3500,"labSurFixed":0.03,"sub":0,"vendor":"부광스티로폴","cat":"XPS바닥"},
 {"id":"xw70","grp":"역전지붕공사","work":"단열재 취부 - 벽","name":"XPS 가등급 70T 900*1800 / 연질폼 포함","unit":"m2","qty":"WALL","on":"sel.xpsWall=70T벽","mat":7130,"sur":"xpsFloor","lab":10000,"labSurKey":"xpsWallLab","sub":8200,"vendor":"부광스티로폴","cat":"XPS벽체"},
 {"id":"xw30","grp":"역전지붕공사","work":"단열재 취부 - 벽","name":"XPS 가등급 30T 900*1800 / 연질폼 포함","unit":"m2","qty":"WALL","on":"sel.xpsWall=30T벽","mat":3050,"sur":"xpsFloor","lab":10000,"labSurKey":"xpsWallLab","sub":8200,"vendor":"부광스티로폴","cat":"XPS벽체"},

 {"id":"wf_st","grp":"역전지붕공사","work":"벽체마감","name":"스테인리스 마감 / 실리콘 및 양면접착제 포함","unit":"m2","qty":"W_STAIN","mat":6500,"sur":"wallFinish","lab":10000,"sub":1000,"cat":"벽체마감"},
 {"id":"wf_hs","grp":"역전지붕공사","work":"벽체마감","name":"함석 마감 / 실리콘 및 양면접착제 포함","unit":"m2","qty":"W_HAM","mat":4000,"sur":"wallFinish","lab":10000,"sub":1000,"cat":"벽체마감"},
 {"id":"wf_crc","grp":"역전지붕공사","work":"벽체마감","name":"crc보드 마감(9t) / 실리콘 및 양면접착제 포함","unit":"m2","qty":"W_CRC","mat":13500,"sur":"pedestalSub","lab":35000,"sub":1000,"cat":"벽체마감"},

 {"id":"vb_siga","grp":"역전지붕공사","work":"2차 투습방수시트지 깔기","name":"잡자재 SIGA Majcoat 투습방수지","unit":"m2","qty":"WP","on":"sel.vaporBarrier=SIGA","mat":6500,"sur":"sheet","lab":3000,"sub":0,"vendor":"잡자재","cat":"투습방수지"},
 {"id":"vb_pro","grp":"역전지붕공사","work":"2차 투습방수시트지 깔기","name":"프로클리마 Mento 3000 투습방수지","unit":"m2","qty":"WP","on":"sel.vaporBarrier=프로클리마","mat":4345,"sur":"sheet","lab":3000,"sub":0,"vendor":"프로클리마","cat":"투습방수지"},
 {"id":"tp_siga","grp":"역전지붕공사","work":"기밀테이프","name":"잡자재 SIGA 전용 기밀테이프 60mm*40m","unit":"m","qty":"TAPE","on":"sel.tape=SIGA","mat":1450,"sur":"sheet","lab":4500,"sub":0,"vendor":"잡자재","cat":"기밀테이프"},
 {"id":"tp_pro","grp":"역전지붕공사","work":"기밀테이프","name":"프로클리마 전용 기밀테이프 60mm*30m","unit":"m","qty":"TAPE","on":"sel.tape=프로클리마","mat":1830,"sur":"sheet","lab":4500,"sub":0,"vendor":"프로클리마","cat":"기밀테이프"},
 {"id":"sil","grp":"역전지붕공사","work":"우레탄실리콘","name":"우레탄실리콘(고탄성)","unit":"ea","qty":"N:siliconEa","mat":10000,"sur":"gravelFinish","lab":0,"sub":0,"cat":"우레탄실리콘"},
 {"id":"db_jap","grp":"역전지붕공사","work":"배수판","name":"잡자재 배수판 500*500","unit":"m2","qty":"FLOOR","on":"sel.drainBoard=잡자재","mat":13500,"sur":"drain","lab":2500,"sub":0,"vendor":"잡자재","cat":"배수판"},
 {"id":"db_tif","grp":"역전지붕공사","work":"배수판","name":"티푸스 배수판 500*500","unit":"m2","qty":"FLOOR","on":"sel.drainBoard=티푸스","mat":10000,"sur":"drain","lab":2200,"sub":0,"vendor":"티푸스","cat":"배수판"},
 {"id":"fb_tif","grp":"역전지붕공사","work":"부직포","name":"티푸스 부직포 300g","unit":"m2","qty":"FLOOR","on":"sel.fabric=티푸스","mat":1727.0000000000002,"sur":"drain","lab":1000,"sub":0,"vendor":"티푸스","cat":"부직포"},
 {"id":"fb_jap","grp":"역전지붕공사","work":"부직포","name":"잡자재 부직포 300g","unit":"m2","qty":"FLOOR","on":"sel.fabric=잡자재","mat":980,"sur":"drain","lab":1000,"sub":0,"vendor":"잡자재","cat":"부직포"},
 {"id":"gv_ton","grp":"역전지붕공사","work":"쇄석","name":"쇄석 두께 25mm-40mm 지정 / 높이 50~70mm / 톤백","unit":"m2","qty":"GRAVEL","on":"sel.gravelPack=톤백","mat":9000,"sur":"gravelFinish","lab":8000,"sub":0,"vendor":"유신 골재","cat":"쇄석포장"},
 {"id":"gv_small","grp":"역전지붕공사","work":"쇄석","name":"쇄석 두께 25mm-40mm 지정 / 높이 50~70mm / 소분포장","unit":"m2","qty":"GRAVEL","on":"sel.gravelPack=소분포장","mat":12000,"sur":"gravelFinish","lab":10000,"sub":0,"vendor":"유신 골재","cat":"쇄석포장"},
 {"id":"tr_f","grp":"역전지붕공사","work":"트렌치 바닥배수","name":"바닥배수 역전지붕 용 300*300","unit":"ea","qty":"N:trenchFloorEa","mat":150000,"sur":"gravelFinish","lab":25000,"sub":0,"vendor":"티푸스","cat":"트렌치"},
 {"id":"tr_s","grp":"역전지붕공사","work":"트렌치 측면배수","name":"측면배수 역전지붕 용 300*170*170","unit":"ea","qty":"N:trenchSideEa","mat":66000,"sur":"gravelFinish","lab":25000,"sub":0,"vendor":"잡자재","cat":"트렌치"},

 {"id":"pd_jap","grp":"역전지붕공사","work":"타일 페데스탈","name":"부자재: 잡자재 사 페데스탈 및 고무","unit":"m2","qty":"TILE","on":"tileArea>0 && sel.tileSub=잡자재 사 페데스탈","mat":8750,"sur":"pedestalSub","lab":1200,"sub":0,"vendor":"잡자재","cat":"마감방식"},
 {"id":"pd_pey","grp":"역전지붕공사","work":"타일 페데스탈","name":"부자재: 페이그란 페테스탈 및 고무 (스페인산)","unit":"m2","qty":"TILE","on":"tileArea>0 && sel.tileSub=페이그란 페데스탈","mat":2000,"sur":"pedestalSub","lab":1200,"sub":0,"vendor":"루비","cat":"마감방식"},
 {"id":"tl_eu","grp":"역전지붕공사","work":"타일 페데스탈","name":"페데스탈 타일 마감재: 20T 유럽산 600x600","unit":"m2","qty":"TILE","on":"tileArea>0 && sel.tileFinish=20T타일(유럽산)","mat":50400,"sur":"finishMat","lab":25000,"sub":0,"vendor":"타일판매처","cat":"마감방식"},
 {"id":"tl_cn_s","grp":"역전지붕공사","work":"타일 페데스탈","name":"페데스탈 타일 마감재: 20T 중국산 600x600(100m2 이하)","unit":"m2","qty":"TILE","on":"tileArea>0 && tileArea<=100 && sel.tileFinish=20T타일(중국산)","mat":32000,"sur":"finishMat","lab":30000,"sub":0,"vendor":"잡자재","cat":"마감방식"},
 {"id":"tl_cn_l","grp":"역전지붕공사","work":"타일 페데스탈","name":"페데스탈 타일 마감재: 20T 중국산 600x600(100m2 이상)","unit":"m2","qty":"TILE","on":"tileArea>100 && sel.tileFinish=20T타일(중국산)","mat":32000,"sur":"finishMat","lab":29000,"sub":0,"vendor":"잡자재","cat":"마감방식"},
 {"id":"wd_ped","grp":"역전지붕공사","work":"우드 페데스탈","name":"부자재: 페이그란 각관용 페테스탈 및 고무 (스페인산)","unit":"m2","qty":"WOOD","on":"woodArea>0","mat":12360,"sur":"pedestalSub","lab":1200,"sub":0,"vendor":"루비","cat":"페테스탈(봉)"},
 {"id":"wd_frame","grp":"역전지붕공사","work":"우드 페데스탈","name":"부자재: 각관 시공","unit":"m2","qty":"WOOD","on":"woodArea>0","mat":25000,"sur":"pedestalSub","lab":10000,"sub":0,"cat":"각관시공"},
 {"id":"wd_deck","grp":"역전지붕공사","work":"우드 페데스탈","name":"부자재: 합성데크","unit":"m2","qty":"WOOD","on":"woodArea>0 && sel.woodFinish=합성데크","mat":45000,"sur":"finishMat","lab":8000,"sub":0,"vendor":"대산합판","cat":"마감방식"}
]
```

### 가설공사 (grp=가설공사, grpSub=가설 및 장비대, 전부 재료비만·할증 없음·단위 "대"/"식")

장비 카탈로그 (`work:"장비대"`, temp.equipment에서 선택+수량):
```
크레인(10톤) 0.5일 500000 | 크레인(10톤) 1일 700000 | 크레인(25톤) 0.5일 600000 | 크레인(25톤) 1일 800000
크레인(50톤) 0.5일 800000 | 크레인(50톤) 1일 1100000 | 크레인(70톤) 0.5일 1100000 | 크레인(70톤) 1일 1600000
크레인(80톤) 0.5일 1400000 | 크레인(80톤) 1일 1800000 | 크레인(100톤) 1일 2200000 | 크레인(150톤) 1일 3500000
크레인(200톤) 1일 4000000 | 크레인(250톤) 1일 5000000 | 크레인(330톤) 1일 6000000 | 크레인(440톤) 1일 10000000 | 크레인(550톤) 1일 15000000
스카이(1~3.5톤) 오전/오후 400000 | 스카이(1~3.5톤) 하루(8시간) 600000 | 스카이(1~3.5톤) 추가(1시간) 150000 | 스카이(1~3.5톤) 월대 12000000
스카이(5톤/45m) 오전/오후 500000 | 스카이(5톤/45m) 하루(8시간) 700000 | 스카이(5톤/45m) 추가(1시간) 200000 | 스카이(5톤/45m) 월대 14000000
스카이(8톤/54m) 오전/오후 700000 | 스카이(8톤/54m) 하루(8시간) 900000 | 스카이(8톤/54m) 월대 17000000
스카이(17톤/58~65m) 오전/오후 900000 | 스카이(17톤/58~65m) 하루(8시간) 1200000 | 스카이(17톤/58~65m) 월대 20000000
스카이(19톤/75m) 오전/오후 1300000 | 스카이(19톤/75m) 하루(8시간) 1800000 | 스카이(19톤/75m) 월대 28000000
스카이(3톤 굴절) 오전/오후 600000 | 스카이(3톤 굴절) 하루(8시간) 800000 | 스카이(5톤 굴절) 오전/오후 800000 | 스카이(5톤 굴절) 하루(8시간) 1000000
사다리차(2~5층) 시작 1시간 120000 | 사다리차(2~5층) 추가 1시간 80000 | 사다리차(2~5층) 반나절 350000 | 사다리차(2~5층) 일대 550000
사다리차(6~7층) 시작 1시간 130000 | 사다리차(6~7층) 추가 1시간 90000 | 사다리차(6~7층) 반나절 400000 | 사다리차(6~7층) 일대 600000
사다리차(8~9층) 시작 1시간 150000 | 사다리차(8~9층) 추가 1시간 100000 | 사다리차(8~9층) 일대 650000
사다리차(10~11층) 시작 1시간 150000 | 사다리차(10~11층) 추가 1시간 100000 | 사다리차(10~11층) 반나절 450000 | 사다리차(10~11층) 일대 650000
사다리차(12~13층) 시작 1시간 150000 | 사다리차(12~13층) 추가 1시간 100000 | 사다리차(14층) 시작 1시간 170000
사다리차(15층) 시작 1시간 180000 | 사다리차(15층) 추가 1시간 100000 | 사다리차(15층) 반나절 500000 | 사다리차(15층) 일대 700000
사다리차(16층) 시작 1시간 190000 | 사다리차(17층) 시작 1시간 200000
사다리차(18층) 시작 1시간 210000 | 사다리차(18층) 추가 1시간 120000 | 사다리차(18층) 반나절 600000 | 사다리차(18층) 일대 800000
사다리차(19층) 시작 1시간 210000 | 사다리차(20층) 시작 1시간 230000 | 사다리차(21층) 시작 1시간 250000 | 사다리차(21층) 일대 900000
사다리차(22층) 시작 1시간 270000 | 사다리차(22층) 추가 1시간 120000 | 사다리차(22층) 반나절 650000
사다리차(23층) 시작 1시간 320000 | 사다리차(24층) 시작 1시간 370000 | 사다리차(24층) 추가 1시간 120000 | 사다리차(24층) 반나절 700000 | 사다리차(24층) 일대 1000000
사다리차(25층) 시작 1시간 420000 | 사다리차(25층) 추가 1시간 120000 | 사다리차(25층) 반나절 700000
```
고정 항목: 지게차 80,000/대 (forkliftQty) · 폐기물 1ton 550,000 / 2.5ton 900,000 (waste×wasteQty, work=장비대) · 운임 및 경비: 서울·경기 500,000 / 지방 1,000,000 (work=운임 및 경비, name=서울, 경기권|지방, unit=식, qty 1).

### 추가공사 (grp=추가공사, grpSub=기타공사, 전부 ONE 식)

```
에어컨 이동 | 에어컨 이동 (해체 및 재설치) | mat 0 lab 500000 sub 0 | sur 없음 | on addl.acMove=예
단열방화문 | 갑종 단열방화문 | 700000/350000/15000 | sur insulDoor | on addl.insulDoor=예
방화문 | 갑종 일반방화문 | 450000/350000/15000 | sur fireDoor | on addl.fireDoor=예
바닥 단 프레임 | 스텐 절곡 | 300000/100000/15000 | mat·lab sur floorFrame(-0.5), sub 할증없음 | on addl.floorFrame=예
단 높임 공사 | 방화문 자리 단 높임 / 조적 및 미장 | 100000/250000/sub최종단가 10000 고정 | sur raise | on addl.raise=예
구조체 파손 및 크랙 보수 | 초속경 보수 몰탈 | 150000/250000/sub최종단가 10000 고정 | sur crack | on addl.crack=예
+ customItems (사용자 정의 행, grp=추가공사): 할증키 선택 가능(없음 포함)
```

## 5. 원가계산서 (엑셀 로직 그대로)

```
공종별 집계: 철거/역전지붕(페데스탈 포함)/가설/추가 각각 mat·lab·sub 합계
directMat   = Σ mat (공종 전체)
indirectMat = directMat × rates.indirectMat        // 간접재료비 2.5%
matSubtotal = directMat + indirectMat
directLab   = Σ lab
indirectLab = directLab × rates.indirectLab        // 간접노무비 3%
labSubtotal = directLab + indirectLab
netCost     = matSubtotal + labSubtotal            // 순공사원가 — ⚠️ 부자재(sub) 합계는 엑셀과 동일하게 미산입!
genAdmin    = netCost × rates.genAdmin             // 일반관리비 10%
design      = netCost × rates.design               // 디자인 비용 (기본 0)
profit      = netCost × rates.profit               // 회사 이윤 10%
constrTotal = netCost + genAdmin + design + profit // 공사비 합계
vat         = taxInvoice=예 ? constrTotal×0.1 : 0
grandTotal  = constrTotal + vat
perPyeong   = constrTotal / (floorSum / 3.3)       // 평당 단가 (VAT별도, 바닥면적 기준)
```
- **부자재 합계(subTotal)는 내역서·공종요약에는 표시하되 원가계산서 순공사원가에는 넣지 않는다** (엑셀 원본 동작. 원본 소비자용 견적서의 "부자재" 행은 0 고정). 다만 설정에 `부자재를 순공사원가에 포함` 토글(기본 OFF)을 두고, ON이면 netCost에 Σsub를 더한다. 토글 상태를 견적서에 표기.
- VAT 라벨: 예 → "부가가치세 (10%)" + "★★ 총합계 (VAT 포함)" / 아니오 → "부가가치세 (미진행)" + "★★ 총합계 (VAT 별도)".
- 현장 여건(§2 siteCond)은 **일반관리비율 가이드**: 권장률 = 10% + (100m²미만 +3%) + (6-10층 +2% | 10층 이상 +4%) + (크레인 불가능 +5%) + (지방 +5%). "권장률 적용" 버튼으로 rates.genAdmin에 반영(자동 반영은 하지 않음 — 엑셀도 수동).

## 6. 화면 구성 (해시 라우팅 탭)

1. **📝 견적입력** — 좌측 폼(섹션 ①프로젝트 정보 ②구역별 치수+구역별 마감/벽체마감 ③자재 선택(각 셀렉트에 단가 힌트 표시) ④가설공사 ⑤추가공사(+customItems 편집 테이블) ⑥할증률/요율/현장여건/특이사항 체크), 우측 **스티키 실시간 요약 패널**(공종별 재료/노무/부자재 표 + 원가계산서 + 총합계 + 평당단가). 숫자 입력은 즉시 재계산.
2. **📄 견적서** — 소비자용: 헤더(회사 연락처) + 공사명/현장주소/견적일자/합계면적 + Ⅰ.공종별 견적 요약 표 + Ⅱ.공사원가계산서 표 + 평당 단가. 표지(제목/제출일/3문구/회사정보)도 이 탭 인쇄에 1페이지로 포함.
3. **📋 내역서** — 공종 4그룹(철거공사/역전지붕공사/가설공사/추가공사) 각각: 공사내용|SPEC.|단위|수량|재료 단가·합계|노무 단가·합계|부자재 단가·합계|합계 단가·합계, 활성 행만 + 그룹 합계 행.
4. **📦 발주서** — 활성 자재 항목을 판매처별 그룹(부광스티로폴/티푸스/프로클리마/잡자재/유신 골재/루비/대산합판/타일판매처/시카/삼화/기타(판매처 미정)): No.|자재명|포장규격|시공수량|발주수량|발주단위|단가(할증 前 원단가 mat)|금액(시공수량×원단가) + 그룹 합계. 가설공사·운임·노무성 항목(재료 0)은 제외. 발주수량 = `ROUNDUP(시공수량 / 제수)`. 카테고리별 포장 규격표:
   `XPS바닥·XPS벽체 900×1800mm 1장=1.62m² | 투습방수지 1.5m×50m 1롤=75m² | 기밀테이프 60mm×40m 1롤=40m | 배수판 500×500mm 1장=0.25m² | 부직포 2m×50m 1롤=100m² | 쇄석포장 톤백 1백=11.666666666666666m² | 트렌치 1ea | 1차방수 1롤=20m² | 삼각면귀 1m | 우레탄실리콘 1개 | 페테스탈(봉) 1봉=50개 | 각관시공 1m²≈3M(제수 0.333, 단위 M) | 마감방식·벽체마감 1m²`
5. **📖 자재소개** — 선택된 자재별 카드(공정/자재명|선택 사양|역할 및 위치|제품 특징|비고) + 견적 설명(일반: "\*견적 외 공사내용은 별도로 합의 후 시공합니다.") + 현장 특이사항(체크된 문구). 설명 데이터는 §7.
6. **🗂 저장목록** — localStorage 다중 견적: 새 견적/복제/삭제/불러오기, 최근 수정순, JSON 내보내기/가져오기, **"동삭동 샘플 불러오기"** 버튼(수용 테스트 입력값 프리셋).
7. (견적입력 내 도구) **📐 옥상 형태 계산기** — 변 길이(mm)+회전방향(우회전/좌회전) 목록, 시작방향(위/오른쪽/아래/왼쪽) → 폐합 여부 ✅/❌, 총 둘레(m), 면적(m², 신발끈 공식) + SVG 미리보기 + "구역에 적용"(선택 구역의 바닥면적·파라펫길이 입력).

공통: 각 출력 탭에 **🖨 인쇄 버튼** (`window.print()` + `@media print` — 탭 내비/입력 숨김, A4 여백, 페이지 나눔). 헤더에 현재 견적명 + 총합계 상시 표시.

## 7. 자재소개 설명 데이터 (원본 시트 그대로)

역할: XPS바닥="방수층 상부 단열층", 투습방수지="XPS 단열재 상부 투습방수층", 기밀테이프="투습방수지 이음부 기밀 처리", 배수판="투습방수지 상부 배수층", 부직포="배수판 상부 분리/필터층", 쇄석포장="최종 마감층 (하중재)", 부자재(타일)="마감재 하부 지지/높이조절", 부자재(우드)="각관 하부 지지/높이조절", 마감재(타일)="최종 마감층 (타일)", 마감재(우드)="최종 마감층 (우드데크)", 각관="데크 하부 구조재".

설명(키→텍스트|비고):
- XPS 50T: "XPS 압출법 보온판 가등급 50mm. 폐쇄기포(Closed Cell) 구조로 수분 흡수율 0.01~0.05%. 열전도율 0.027~0.031 W/m·K."|"KS M 3808 가등급"
- 70T: "…가등급 70mm. 폐쇄기포 구조로 높은 압축강도와 낮은 흡수율. 역전지붕에 최적화."|동일
- 80T: "…가등급 80mm. 폐쇄기포 구조, 수분 흡수율 0.01~0.05%. 높은 압축강도로 상부 하중 견디는 역전지붕 단열재."|동일
- 100T: "…가등급 100mm. 단열 성능 우수, 구조적 하중에 견딜 수 있는 다양한 압축강도 보유."|동일
- 120T: "…가등급 120mm. 두꺼워 열저항이 높으며 내습/방수성 우수. 고단열 적용."|동일
- 150T: "…가등급 150mm. 2겹 시공 시 단열 성능 극대화. 여름철 열 차단, 겨울철 보온 효과 탁월."|동일
- 200T: "…가등급 200mm. 최고 두께 단열재로 패시브하우스 수준의 단열 성능 확보."|동일
- 투습방수지 SIGA: "SIGA Majcoat 150 지붕용 투습/방수/방풍지 (1.5m×50m). 내부 습기 외부 배출로 결로 방지."|"스위스 SIGA사"
- 투습방수지 프로클리마: "프로클리마 Solitex Mento 3000 지붕용 투습방수지. 3중 멤브레인 구조, TEEE 필름 기반으로 방수+투습 동시 확보. 높은 인장력/내구성."|"독일 Pro Clima사"
- 기밀테이프 SIGA: "SIGA 전용 기밀테이프 60mm×40m. 겹침부 밀봉으로 기밀층 연속성 보장, 누수 방지."|"스위스 SIGA사"
- 기밀테이프 프로클리마: "프로클리마 TESCON VANA 60mm×30m. 방습+투습 2가지 기능. 목조/스틸/조적 전 면 접착 가능. 기밀층 연속성 보장."|"독일 Pro Clima사"
- 배수판 잡자재: "일반 조경용 배수판. 요철부 배수공으로 효율적 배수. 단열재 하부 배수 담당."|"일반 자재" / 티푸스: "티푸스코리아 조경용 배수판. 효율적 배수 + 단열재 보호 역할 수행."|"(주)티푸스코리아"
- 부직포 잡자재: "일반 KS 300g/m² 부직포 (2m×50m). 쇄석 미세 입자 침투 방지 필터 + 하부 레이어 보호."|"일반 자재" / 티푸스: "티푸스코리아 KS 300g/m² 부직포 (2m×50m). 쇄석 미세 입자 침투 방지 + 하부 보호."|"(주)티푸스코리아"
- 쇄석 톤백: "톤백 방식 크레인 양중, 약 5cm 두께 쇄석 포설. 단열재 고정, UV 차단, 풍압 방지. 인건비/시간 절감."|"마감: 쇄석" / 소분포장: "소분 포장 방식. 양중 장비 제약 시 적합. 수작업 비중 높아 인건비 증가."|"마감: 쇄석"
- 잡자재 사 페데스탈: "잡자재 사 페데스탈. 타일 마감 시 높이 조절 및 수평 맞춤용 지지대. 배수 공간 확보."|"타일 마감용"
- 페이그란 페데스탈(타일): "페이그란 페데스탈 (스페인산). 정밀 높이 조절 가능, 내구성 우수. 타일 수평 시공 및 배수 공간 확보."|"스페인 Peygran사"
- 페이그란 각관용(우드): "페이그란 각관용 페데스탈 (스페인산). 각관 프레임 지지 및 수평 조절. 슬랩 스페이서 포함 (1봉=50개)."|"스페인 Peygran사"
- 20T타일(유럽산): "20T 유럽산 600×600mm 외장 타일. 고강도, 내동해성 우수. 옥상 바닥 마감용." / (중국산): "20T 중국산 600×600mm 외장 타일. 옥상 바닥 마감용."
- 합성데크: "합성목재 데크. 천연목 질감 + 내후성, 내수성 확보. 각관 프레임 위 설치."|"마감: 합성데크"
- 각관 시공: "각관 프레임 시공. 합성데크 하부 지지 구조물. 페데스탈 위 설치하여 수평 확보."|"우드데크 하부 구조"

특이사항 8종 (기본 전부 false + 자유 추가):
1. \*전기,통신선의 이동작업이 필요합니다. 해당 부분은 협의 후 진행합니다.
2. \*문,창틀이 필요 높이 미만이여서, 추가작업이 필요합니다.
3. \*A/C 실외기, 태양광 등의 장비이동이 필요합니다. 해당 부분은 협의 후 진행합니다.
4. \*스카이차, 크레인 등 장비사용에 어려움이 있습니다.
5. \*현 파라펫의 구조상 벽단열작업에 어려움이 있습니다.
6. \*콘크리트 타공이 필요합니다. 타공시 전기 배관 등이 간섭되는경우, 안도공간은 해당 구간에 대해 책임지지 않습니다.
7. \* 타일마감의 경우, 자리를 잡는 시간동안 약간 움직일 수 있습니다. 이는 하자가 아니며, 간단히 수정볼 수 있습니다.
8. \*조경 및 잔디, 조경용 조적턱 등은 포함되지 않았습니다.

## 8. 기술 요구사항

- **단일 `index.html`** (더블클릭으로 열림, file:// 동작). React 18 UMD + ReactDOM UMD + Babel Standalone + Tailwind CDN. **JSX는 classic runtime** (babel-standalone에서 automatic runtime이면 백지 화면 나는 알려진 gotcha 있음 — `data-presets` 확인, React 전역 참조).
- 폰트: Pretendard CDN (없으면 system-ui 폴백). 오프라인이어도 앱은 동작해야 함(폰트/Tailwind는 열화 허용… 단, Tailwind CDN 미로드 시를 대비해 핵심 레이아웃이 깨지지 않게 최소한의 `<style>` 폴백은 선택사항).
- **계산 엔진 분리**: `<script id="calc-engine">`(플레인 JS, JSX/Babel 금지)에 `window.RoofCalc = { ITEM_DB, EQUIP_CATALOG, PACK_SPECS, DESCRIPTIONS, SAMPLE_DONGSAK, newEstimate(), computeEstimate(est) }` 정의. React 코드는 이 전역을 소비만 한다. (node 테스트가 이 블록을 추출해 실행한다.)
- `computeEstimate(est)` 반환: `{ derived:{floorSum,parapetLen,wallArea,waterproofArea,tapeLen,gravelArea,tileArea,woodArea,wallStain,wallHam,wallCrc}, rows:[{...item, qty, matFinal, labFinal, subFinal, matTotal, labTotal, subTotal, rowTotal, grp}], trades:{철거공사:{mat,lab,sub,total},...}, tradeTotal:{mat,lab,sub,total}, cost:{directMat,indirectMat,matSubtotal,directLab,indirectLab,labSubtotal,subTotal,netCost,genAdmin,design,profit,constrTotal,vat,grandTotal,perPyeong}, orders:[{vendor, items:[{name,pack,qty,orderQty,orderUnit,unitPrice,amount}], subtotal}] }`
- 저장: localStorage `ando-roof-estimates-v1` = `{estimates:[...], activeId}`. 모든 입력 변경 500ms 디바운스 자동 저장. JSON 파일 내보내기/가져오기.
- 접근성/UX: 숫자 입력은 콤마 표시, 셀렉트에 단가 힌트(예: `weldano 3000 — 재료 20,167/노무 7,000`), 활성 항목 수 뱃지, 인쇄 시 배경색 유지(`print-color-adjust`).
- 세련되고 밀도 있는 실무 UI (안도공간 = 인테리어/건축 회사, 톤: 차분한 네이비/그레이 + 앰버 포인트).

## 9. 검증 (필수 — 빌드 후 반드시 실행·통과)

`test.mjs` (Node, 의존성 0): index.html에서 `<script id="calc-engine">` 블록을 정규식으로 추출 → `new Function`으로 `window={}` 주입 실행 → `RoofCalc.computeEstimate(RoofCalc.SAMPLE_DONGSAK)` 결과를 아래 기대값과 비교 (허용 오차 ±1):

SAMPLE_DONGSAK 입력: 공사명 "신축 역전지붕공사", 주소 "평택 동삭동 867-7", 담당 "홍평화"; 구역 A(옥상 138.7/52/0.3, 쇄석, crc보드), B(2층 18.3/17.3/0.3, 쇄석, 없음), C(3층 23/19.1/0.3, 쇄석, 없음); sanding 아니오, cornerBead 없음, siliconEa 10, primer 아니오, ownerSupplied 아니오, membrane 없음, xps1 100T, xps2 150T, xpsWall 30T벽, vaporBarrier SIGA, tape SIGA, drainBoard 잡자재, fabric 잡자재, gravelPack 톤백, trenchFloorEa 6, trenchSideEa 0; 가설: 크레인(50톤) 0.5일×1 + 사다리차(6~7층) 반나절×1, 지게차 2, 폐기물 1ton×1, 운임 지방; 추가공사 전부 아니오; customItems 2건(§2 예시의 XPS 100T 6m² + XPS 150T 6m²: 150T는 matPrice 15400.000000000002, labPrice 10000, labSurKey wallFinishLab→G48=0.05 적용, subPrice 8200); 요율 기본값, taxInvoice 예.
※ customItems의 할증: mat=xpsFloor(0.1), lab=벽체마감 노무할증(0.05), sub=없음 — 최종단가 100T: 11,374/10,500/8,200, 150T: 16,940/10,500/8,200.

기대값:
```
derived: waterproofArea 206.52 | wallArea 26.52 | tapeLen 176.8 | wallCrc 15.6 | gravelArea 180 | floorSum 180
trades.철거공사 = {0, 0, 0}
trades.역전지붕공사 = {mat 12693491.6, lab 6018678, sub 233064}
trades.가설공사 = {mat 2910000, lab 0, sub 0}
trades.추가공사 = {mat 169884, lab 126000, sub 98400}
tradeTotal = {mat 15773375.6, lab 6144678, sub 331464, total 22249517.6}
cost: directMat 15773375.6 | indirectMat 394334.39 | matSubtotal 16167709.99
      directLab 6144678 | indirectLab 184340.34 | labSubtotal 6329018.34
      netCost 22496728.33 | genAdmin 2249672.833 | profit 2249672.833 | design 0
      constrTotal 26996073.996 | vat 2699607.3996 | grandTotal 29695681.3956 | perPyeong 494928.02326
orders: 부광스티로폴 subtotal 4714086 (XPS150T 발주 112장·XPS100T 112장·XPS30T벽 17장)
        티푸스 900000 | 잡자재 4205140 (투습 3롤, 기밀 5롤, 배수판 720장, 부직포 2롤)
개별 행 spot-check: x150 {qty 180, matFinal 16940, matTotal 3049200, labFinal 3605, labTotal 648900}
                    xw30 {qty 26.52, matTotal 88974.6, labTotal 278460, subTotal 217464}
                    wf_crc {qty 15.6, matTotal 210600, labTotal 546000, subTotal 15600}
                    tp_siga {qty 176.8, matTotal 269178, labTotal 835380}
                    gv_ton {qty 180, matTotal 1782000, labTotal 1584000}
```
추가 케이스 2개: (1) taxInvoice=아니오 → vat 0, grandTotal=constrTotal. (2) ownerSupplied=예 → x150·x100·xw30 matTotal 0 (labTotal 불변).
전부 통과할 때까지 수정. 앱 내 `설정 > 🧪 자가검증` 버튼도 동일 검증을 실행해 ✓/✗ 목록 표시.

---
---

# v2 업데이트 요구사항 (2026-07-12 사용자 요청 10건)

v1은 완성·검증됨(73/73). 아래는 **v2 변경분**. 충돌 시 v2가 v1을 이긴다.
백엔드(server.js, PORT 3015)는 이미 작성 완료 — API 계약은 server.js 주석 참조 (봉투 `{success,data,message}`, Bearer JWT).

## V2-3. ⚠️ 부자재 순공사원가 **포함이 기본** (사용자: v1의 미산입은 엑셀 원본 오류였음)

- `rates.subInNetCost` 기본 **true** (v1 견적 로드 시 필드 없으면 true 로 마이그레이션).
- 원가계산서에 "부자재" 행 추가: `subTotal = Σ부자재`, `netCost = matSubtotal + labSubtotal + subTotal`.
- 토글(⑥ 요율 패널)은 유지하되 라벨 "부자재 순공사원가 포함 (기본 ON, OFF=구 엑셀 방식)".
- **새 기본 수용 테스트 기대값** (동삭동 샘플, 그 외 입력 동일):
```
netCost 22828192.33 | genAdmin 2282819.233 | profit 2282819.233 | design 0
constrTotal 27393830.796 | vat 2739383.0796 | grandTotal 30133213.8756
perPyeong 502220.23126
```
- 레거시 케이스: `subInNetCost=false` → v1 기대값(constrTotal 26996073.996, grandTotal 29695681.3956) 그대로 통과해야 함.
- 소비자용 견적서의 "부자재" 행은 이제 실제 Σ부자재(예: 331,464)를 표시.

## V2-2. 💰 자재DB 탭 (단가 오버라이드)

- 새 직원용 탭 `💰 자재DB`: ITEM_DB 전 행을 공종>공사내용 그룹으로 표시 — 항목명/단위/기본단가(재료·노무·부자재) + **오버라이드 입력칸** + 행별 초기화. 장비 카탈로그(EQUIP_CATALOG) 단가도 동일하게.
- 오버라이드 저장 구조: `{ items: { <itemId>: {mat?, lab?, sub?} }, equip: { <장비명>: <단가> } }`.
- 서버 모드: GET/PUT `/api/prices` (팀 공유, 마지막 수정자 표시). 로컬 모드: localStorage `ando-roof-price-overrides-v1`.
- **계산 엔진 시그니처 변경**: `computeEstimate(est, overrides?)` — 있으면 해당 항목 단가를 교체 후 동일 계산. 오버라이드된 행은 UI에 뱃지(●수정됨) 표시. 견적은 스냅샷 없이 **항상 현재 오버라이드로 계산**(보존이 필요한 확정본은 V2-7 내보내기 파일이 담당).
- test.mjs: overrides 미전달 시 기존 결과 불변 + `{items:{x150:{mat:16000}}}` 전달 케이스 1개(해당 행 matFinal=16000×1.1=17600) 추가.

## V2-4. ☑️ "전체 마감방식 동일" 체크박스

- `est.finishAll = { enabled: true, finish:'쇄석', wallFinish:'없음' }` (새 견적 기본 enabled=true).
- enabled=true → 구역 행의 개별 마감/벽체마감 셀렉트 숨김, 섹션 상단에 공통 셀렉트 2개 표시. 계산 시 모든 구역에 finishAll 적용.
- enabled=false → v1처럼 구역별 셀렉트. **동삭동 샘플은 enabled=false** (A구역만 crc보드라서).
- 마이그레이션: 필드 없으면 enabled=false 로 로드(기존 견적 값 보존).

## V2-5. 추가공사 항목 확장 (체크 시 단가·수량·할증 인라인 편집)

- `addl` 를 객체 맵으로 변경: `addl[key] = { on:false, qty:1, mat:<기본>, lab:<기본>, sub:<기본>, surMat:<⑥기본>, surLab:<⑥기본> }` (키·기본값은 v1 §4 추가공사 표 그대로. 단높임/크랙보수의 sub 는 최종단가 10000 고정이던 것 → sub=10000·할증 0 으로 초기화).
- 체크 ON 시 해당 행 아래로 수량/재료단가/노무단가/부자재단가/재료할증/노무할증 입력칸 확장. 계산은 항목 로컬 값 사용 (⑥ 패널 값은 초기 기본값 역할).
- 마이그레이션: v1의 `'예'/'아니오'` 문자열 → `{on, qty:1, 기본단가}` 변환.
- 샘플(전부 아니오)은 결과 불변.

## V2-6. 구역 최대 5 → **10** (A~J구역).

## V2-7. 🖨 인쇄 · ⬇ 내보내기 (헤더 버튼)

- 헤더 상단 **총액 표시 왼쪽**에 `[🖨 인쇄] [⬇ 내보내기]` 버튼.
- 문서 구성·순서(둘 다 동일): **① 표지+견적서 → ② 내역서 → ③ 자재소개** (각 섹션 `page-break-before`). 발주서·견적입력 등 직원용은 미포함.
- 인쇄: 숨김 combined 컨테이너를 print CSS 로 노출 → `window.print()` (사용자가 대화상자에서 PDF 저장 가능).
- 내보내기: 같은 3문서를 **완전 독립형 HTML 파일**로 다운로드 (인라인 스타일, 이미지는 가능하면 data URI 인라인 — file:// 로컬 모드 등 fetch 불가 시 이미지 생략하고 진행). 파일명 `견적서_<공사명>_<YYMMDD>.html`.

## V2-8. 직원용/고객 제출용 UI 분리

- 내비를 두 그룹으로 시각 분리(그룹 라벨 + 구분선):
  - **직원용**: 📝 견적입력 · 💰 자재DB · 📦 발주서 · 🗂 저장목록
  - **고객 제출용**: 📄 견적서 · 📋 내역서 · 📖 자재소개
- 순서·위치 변경 포함. 고객 제출용 탭은 화면에서도 "제출용 문서" 느낌의 프레임(종이 카드)으로.

## V2-9. 저장 견적: 작성자 + 특이사항 메모

- 저장목록 각 행: 제목, **작성자(creatorName)**, 마지막 수정자, 수정일, **메모(특이사항) 인라인 편집**(blur 시 저장), meta.grandTotal 요약.
- 서버 모드: 서버가 creator/updater 계산. 로컬 모드: `estimate.creatorName = '(로컬)'`, memo 는 로컬 저장.

## V2-10. 🔐 로그인/가입 + 서버 동기화 (server.js 는 완성되어 있음 — 프론트만 연동)

- 부팅 시 `GET /api/health` (1.5s 타임아웃):
  - 성공 → **서버 모드**: 토큰(localStorage `ando-roof-token`) 없거나 `/api/auth/me` 401 이면 로그인/가입 화면(이메일·비밀번호·이름·초대코드. 초대코드는 가입에만). 로그인 후: 견적 목록/저장/단가 전부 서버 API 사용. 헤더에 사용자명 + 로그아웃.
  - 실패 또는 `location.protocol==='file:'` → **로컬 모드**: v1 localStorage 동작 유지 + 상단 배너 "로컬 모드 — 서버 미접속 (npm start → http://localhost:3015)". 로그인 UI 숨김.
- 서버 모드 최초 로그인 시 localStorage 에 v1 견적이 있으면 "로컬 견적 N건을 서버로 업로드할까요?" 1회 제안(수락 시 POST 반복 후 로컬 표시 정리).
- 저장 시 `meta = { grandTotal, floorSum, address, date }` 함께 전송(목록 표시용).
- API 봉투/엔드포인트는 server.js 와 test-server.mjs 참조. 401 수신 시 토큰 폐기 후 로그인 화면.

## V2-1. 🖼 자재소개 이미지

- 규칙: `images/materials/manifest.json` = `{ "<imgKey>": "<파일명>" }`. 자재소개 카드는 부팅 시 manifest 를 fetch(실패 시 조용히 무시)하고, 항목의 imgKey 가 manifest 에 있으면 `<img src="images/materials/<파일명>">` 표시 (없으면 이미지 없이 v1 그대로 — **파일 부재가 앱을 깨면 안 됨**).
- DESCRIPTIONS 각 항목에 imgKey 부여: `xps`(모든 두께 공통), `vb_siga`, `vb_pro`, `tape_siga`, `tape_pro`, `drain`, `fabric`, `gravel`, `silicon`, `trench_floor`, `trench_side`, `ped_jap`, `ped_pey`, `ped_wood`, `tile`, `deck`, `frame`, `membrane_adex`, `membrane_sika`, `membrane_urethane`, `membrane_adhero`, `membrane_weldano`, `membrane_bituthene`, `corner`, `crc`, `stainless`, `hamseok`.
- 이미지 파일 수집(웹 검색→다운로드→`sips -Z 640` 리사이즈)은 **오케스트레이터가 별도 수행** — UI 는 manifest 규약만 구현. 인쇄/내보내기 문서에도 이미지 포함(있을 때만).

## V2 검증 (test.mjs 갱신)

1. 기본(부자재 포함) 동삭동 기대값 ↑V2-3 — grandTotal 30,133,213.8756 등.
2. 레거시 토글 OFF → v1 전체 기대값 재현.
3. 오버라이드 케이스 (V2-2).
4. VAT 아니오 / 지급자재 예 케이스 유지(새 기본값 기준으로 수치 갱신: VAT 아니오 → grandTotal=constrTotal 27,393,830.796).
5. addl 확장 케이스 1개: 크랙보수 on qty 2 → 재료 300,000·노무 500,000·부자재 20,000 가산 확인.
6. finishAll enabled 케이스 1개: 샘플에서 finishAll={enabled:true, finish:'쇄석', wallFinish:'없음'} 으로 바꾸면 crc보드 행 비활성 → 역전지붕 재료비 12,482,891.6 (=12,693,491.6−210,600), 노무 5,472,678, 부자재 217,464 (crc 부자재 15,600 제외) 확인.
서버는 `node test-server.mjs` (작성 완료, 22 체크) — npm install 후 실행.

---

# V3 업데이트 요구사항 (2026-07-12, 사용자 5건 — v2 완료 직후 접수)

> 서버(server.js/.env)는 V3에서 **무변경**(견적 data 블롭은 서버에 불투명). test-server.mjs 32/32 유지 확인만.

## V3-1. ⬇ 내보내기 = PDF 다운로드 (①)

- 헤더 [⬇ 내보내기]를 **PDF 파일 다운로드**로 변경. 독립형 HTML 내보내기는 **제거**(사용자 명시 — "html은 없어도 되"). 저장목록의 "현재 견적 JSON 내보내기/가져오기"는 별개 기능이므로 유지.
- 구현: html2pdf.js CDN(`https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js`)을 **첫 클릭 시 지연 로드**(script 태그 주입, 로드 프라미스 캐시. 초기 페이지 로드에 추가 부담 금지).
- 흐름: buildCombinedDoc(표지→견적서→내역서→자재소개, 이미지 data URI 인라인 — 기존 doExport의 이미지 인라인 로직 재사용) → 화면 밖 숨은 컨테이너에 주입 → `html2pdf().set({ margin:[10,8], filename, image:{type:'jpeg',quality:0.95}, html2canvas:{scale:2,useCORS:true}, jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}, pagebreak:{mode:['css','legacy']} })` → 기존 `.page-break` CSS와 연동 → `save()` 후 컨테이너 제거.
- 파일명: `안도공간_견적서_<공사명 또는 '무제'>_<YYMMDD>.pdf` (파일명 불가 문자 치환).
- 진행 UX: 생성 중 버튼 비활성 + "PDF 생성 중…" 라벨. 완료/실패 후 원복.
- CDN 로드 실패(오프라인 등) 시 alert("오프라인 상태라 PDF 모듈을 불러올 수 없습니다. 네트워크 연결 후 다시 시도하세요.") 후 중단 — HTML 폴백 없음.

## V3-2. 고객문서 탭 내 개별 인쇄버튼 제거 (②)

- 견적서/내역서/자재소개 탭 내부의 개별 🖨 인쇄 버튼(PrintBtn 사용처) 전부 제거 — 헤더 [🖨 인쇄]만 남긴다. PrintBtn 컴포넌트가 미사용이 되면 삭제.
- CustomerFrame 안내문구의 "또는 각 문서의 인쇄 버튼을 이용하세요" 부분 삭제(상단 버튼 안내만 유지).

## V3-3. 유입경로 셀렉트 (③)

- `info.leadSource`: TextInput → Select. 옵션: `''`(선택), `티푸스`, `잡자재`, `패시브협회`, `기타`.
- 저장분 데이터 보존: 현재 값이 옵션 목록 밖의 비어있지 않은 문자열이면 그 값을 임시 옵션으로 함께 렌더(사용자가 다른 옵션 선택 시 자연 소멸). migrate에서 값 변형 금지.

## V3-4. 구역별 자재선택 (④) — 엔진+UI 핵심 변경

**데이터 모델**
- `zones[i].sel` 추가 — 구조는 `est.sel`과 동일(전 필드). `z.finish`/`z.wallFinish`는 기존 필드 그대로 유지.
- `est.sel`은 (a) `finishAll.enabled=true`일 때 단일 자재선택으로 사용, (b) 새 구역 생성 시 템플릿.

**엔진 집계 규칙 (수치 재현의 핵심)**
- `finishAll.enabled=true`: 기존 v2 경로 그대로 (est.sel 단일, computeDerived의 fa 마감 사용) — 변경 없음.
- `enabled=false`: 각 구역이 자기 `z.sel`·`z.finish`·`z.wallFinish`로 (아이템 × 선택변형)별 **수량 기여**를 만들고, 같은 (아이템, 변형)의 기여는 **반올림·할증 적용 이전에 합산**해 한 행으로 병합한다. 행 생성 이후의 반올림/할증/단가(오버라이드 포함)/발주 포장 계산은 기존 로직 그대로 병합된 수량에 적용.
  - 면적류: 해당 구역의 floor/parapet 기여로 기존 산정식을 구역 스코프로 적용해 합산.
  - ea류(`siliconEa`, `trenchFloorEa`, `trenchSideEa`): 구역 값의 합.
  - 결과: **모든 구역이 동일 sel이면 v2와 완전 동일한 rows/orders/cost** (수용 기준).
  - 구역별 변형이 다르면(예: XPS 100T vs 50T) 변형별로 행이 분리되고, 각 행 수량 = 그 변형을 고른 구역들만 남긴 부분 견적의 수량과 일치해야 한다.

**마이그레이션 (migrate)**
- `zone.sel` 없으면 `est.sel` 딥카피로 생성하되, **ea 3필드는 zones[0]에만 원값, 나머지 구역은 0** (동삭동 샘플 grandTotal 30,133,213.8756 불변이 수용 기준).
- coverNotes 등 다른 필드 마이그레이션과 독립.

**finishAll 토글 전환 시**
- ON→OFF: `zone.sel` 없는 구역만 `est.sel` 카피 생성(ea는 zones[0]에만 — 위 규칙). 이미 있으면 보존.
- OFF→ON: `est.sel = zones[0].sel 딥카피`, 단 ea 3필드는 **전 구역 합**. (균일 선택이었다면 총액 불변)

**UI**
- 구역 테이블(② 구역별 치수)에서 **마감/벽체마감 컬럼을 양쪽 모드 모두 제거** (구역명/바닥/파라펫/높이/삭제만 남김).
- `enabled=true`: 기존처럼 체크박스 옆 공통 마감/벽체마감 셀렉트 + ③ 자재선택 카드 1개(est.sel 바인딩).
- `enabled=false`: 구역 수만큼 **"③ 자재선택 — <구역명>"** 카드 반복(zones 순서). 각 카드 최상단에 그 구역의 마감/벽체마감 셀렉트(z.finish/z.wallFinish 바인딩), 이어서 기존 자재 필드 전부(z.sel 바인딩). 카드에 구역명 뱃지로 시각 구분.
- 구역 추가: 새 zone.sel = est.sel 딥카피(ea 0). 구역 삭제: zone.sel 동반 삭제.
- 실시간 요약/발주/내역/견적서는 병합 행 기준(행이 변형별로 늘어날 수 있음 외 변경 없음).

## V3-5. 견적 조건 문구 추가 (⑤)

- coverNotes 기본값·동삭동 샘플: 기존 3줄 뒤에 `'4. 본 견적서는 한달간 유효합니다.'` 추가.
- migrate: 저장분 coverNotes가 **구 기본 3줄과 정확히 일치**할 때만 새 4줄로 교체(커스텀 배열은 불변).

## V3 검증 (test.mjs에 추가 — 기존 케이스는 수치 불변 유지)

1. **회귀**: 동삭동 샘플 migrate 후 `zones[].sel` 생성(ea는 zones[0]만) + grandTotal **30,133,213.8756** (±1) + 레거시 토글 29,695,681.3956 + finishAll=true 12,482,891.6 전부 그대로.
2. **병합 동등성**: 전 구역 동일 sel(enabled=false)의 rows/orders/cost == enabled=true(est.sel 동일) 결과와 완전 동일(행 단위 비교).
3. **ea 합산**: 샘플에서 zones[1].sel.siliconEa=5 → silicon 행 qty 15, mat 165,000(11,000/ea).
4. **변형 분리**: zones[0].sel.xps1p='100T', zones[1..2]='50T' → XPS 1P 행 2개, 각 행 수량 == 해당 구역만 남긴 부분 견적의 수량과 일치.
5. **coverNotes**: 기본/샘플 4줄, 구 3줄 저장분 migrate → 4줄, 커스텀 배열 불변.
6. **인앱 자가검증(저장목록 탭)** 목록에 위 1·3 유형 체크 반영.

---

# V4 업데이트 (2026-07-12, 사용자 4건 + 배포)

1. **인쇄/PDF 통합 (가로)**: html2pdf 래스터 내보내기 제거 → 헤더 단일 [🖨 인쇄 · PDF] 버튼 = 결합 문서(견적서→내역서→자재소개)를 **A4 landscape** `@page` 로 인쇄 다이얼로그에 띄움. "PDF로 저장" 선택 시 인쇄 품질(벡터) 그대로. `.doc` max-width 1040px.
2. **견적서 평당 단가 삭제** (QuoteTab·결합 문서). 엔진 `cost.perPyeong` 과 견적입력 우측 요약(내부용)·자가검증은 유지.
3. **자재소개 이미지 폴백**: manifest fetch 실패(file:// 등) 시 내장 `FALLBACK_MANIFEST`(27키, `<imgKey>.jpg` 규약) 사용. — 사용자가 본 "이미지 사라짐"의 원인은 file:// 실행에서 fetch 차단.
4. **가입 초대코드 제거**: UI 필드·server.js 검증(503/403)·test-server 케이스 삭제 → 31체크. `ROOF_INVITE_CODE` env 불사용.
5. **Vercel**: `vercel.json`(@vercel/node server.js + 정적 index.html/images 라우트), server.js `require.main` 가드 + `module.exports = app`. env: `DATABASE_URL`, `JWT_SECRET`.
