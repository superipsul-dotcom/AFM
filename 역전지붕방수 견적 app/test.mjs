// test.mjs — SPEC §9 (v1) + "V2 검증" 수용 테스트 (의존성 0, Node 순정)
// index.html 의 <script id="calc-engine"> 블록을 정규식으로 추출 → new Function 으로 실행
// (window 전역 주입, globalThis 폴백) → RoofCalc.computeEstimate 결과를 기대값(±1원)과 대조.
//
// v2 변경점: 부자재 순공사원가 포함이 '기본'(rates.subInNetCost=true) — 새 기대 grandTotal 30,133,213.8756.
//            computeEstimate(est, overrides?) 시그니처 · finishAll 체크박스 · addl 객체화.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ---- 1) calc-engine 블록 추출 (속성 허용 정규식) ----
const m = html.match(/<script id="calc-engine"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('✗ <script id="calc-engine"> 블록을 찾지 못했습니다.'); process.exit(1); }
const engineCode = m[1];

// ---- 2) 실행 (window 주입) ----
const win = {};
try {
  const runner = new Function('window', engineCode + '\n;return window;');
  runner(win);
} catch (e) {
  console.error('✗ calc-engine 실행 실패:', e && e.stack || e); process.exit(1);
}
const RC = win.RoofCalc;
if (!RC || typeof RC.computeEstimate !== 'function') { console.error('✗ window.RoofCalc.computeEstimate 없음'); process.exit(1); }

// ---- 3) 대조 프레임워크 ----
const TOL = 1.0;
let pass = 0, fail = 0;
const fails = [];
function fmt(n){ return (typeof n === 'number' && !Number.isInteger(n)) ? (Math.round(n*10000)/10000) : n; }
function approx(label, actual, expected, tol = TOL) {
  const a = Number(actual), e = Number(expected);
  const ok = Math.abs(a - e) <= tol;
  line(ok, label, ok ? `${fmt(a)}` : `기대 ${e} / 실제 ${fmt(a)} (Δ ${fmt(a - e)})`);
}
function eq(label, actual, expected) {
  const ok = actual === expected;
  line(ok, label, ok ? `${actual}` : `기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`);
}
function line(ok, label, detail) {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label.padEnd(36)} ${detail}`); }
  else { fail++; fails.push(label); console.log(`  \x1b[31m✗ ${label.padEnd(36)} ${detail}\x1b[0m`); }
}
function head(t){ console.log(`\n\x1b[1m${t}\x1b[0m`); }
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('\x1b[1m역전지붕방수 견적 — 수용 테스트 (SPEC §9 + V2)\x1b[0m');
console.log(`calc-engine 추출: ${engineCode.length.toLocaleString()} chars · ITEM_DB ${RC.ITEM_DB.length}행 · EQUIP ${RC.EQUIP_CATALOG.length}종`);

const r = RC.computeEstimate(RC.SAMPLE_DONGSAK);

// ================================================================
// [파생 수량] — v1 그대로 (finishAll 비활성 샘플)
// ================================================================
head('[파생 수량]');
approx('derived.waterproofArea', r.derived.waterproofArea, 206.52);
approx('derived.wallArea',       r.derived.wallArea,       26.52);
approx('derived.tapeLen',        r.derived.tapeLen,        176.8);
approx('derived.wallCrc',        r.derived.wallCrc,        15.6);
approx('derived.gravelArea',     r.derived.gravelArea,     180);
approx('derived.floorSum',       r.derived.floorSum,       180);

// ================================================================
// [공종별 집계 trades] — v1 그대로
// ================================================================
head('[공종별 집계 trades]');
approx('철거공사.mat',   r.trades['철거공사'].mat,   0);
approx('철거공사.lab',   r.trades['철거공사'].lab,   0);
approx('철거공사.sub',   r.trades['철거공사'].sub,   0);
approx('역전지붕공사.mat', r.trades['역전지붕공사'].mat, 12693491.6);
approx('역전지붕공사.lab', r.trades['역전지붕공사'].lab, 6018678);
approx('역전지붕공사.sub', r.trades['역전지붕공사'].sub, 233064);
approx('가설공사.mat',   r.trades['가설공사'].mat,   2910000);
approx('가설공사.lab',   r.trades['가설공사'].lab,   0);
approx('가설공사.sub',   r.trades['가설공사'].sub,   0);
approx('추가공사.mat',   r.trades['추가공사'].mat,   169884);
approx('추가공사.lab',   r.trades['추가공사'].lab,   126000);
approx('추가공사.sub',   r.trades['추가공사'].sub,   98400);

head('[tradeTotal]');
approx('tradeTotal.mat',   r.tradeTotal.mat,   15773375.6);
approx('tradeTotal.lab',   r.tradeTotal.lab,   6144678);
approx('tradeTotal.sub',   r.tradeTotal.sub,   331464);
approx('tradeTotal.total', r.tradeTotal.total, 22249517.6);

// ================================================================
// [원가계산서 cost] — V2 기본값(부자재 순공사원가 포함, subInNetCost=true)
//   netCost = matSubtotal + labSubtotal + subTotal
// ================================================================
head('[원가계산서 cost · V2 기본 = 부자재 포함]');
approx('directMat',    r.cost.directMat,    15773375.6);
approx('indirectMat',  r.cost.indirectMat,  394334.39);
approx('matSubtotal',  r.cost.matSubtotal,  16167709.99);
approx('directLab',    r.cost.directLab,    6144678);
approx('indirectLab',  r.cost.indirectLab,  184340.34);
approx('labSubtotal',  r.cost.labSubtotal,  6329018.34);
approx('subTotal',     r.cost.subTotal,     331464);
approx('netCost',      r.cost.netCost,      22828192.33);
approx('genAdmin',     r.cost.genAdmin,     2282819.233);
approx('profit',       r.cost.profit,       2282819.233);
approx('design',       r.cost.design,       0);
approx('constrTotal',  r.cost.constrTotal,  27393830.796);
approx('vat',          r.cost.vat,          2739383.0796);
approx('grandTotal',   r.cost.grandTotal,   30133213.8756);
approx('perPyeong',    r.cost.perPyeong,    502220.23126);

// ================================================================
// [개별 행 spot-check] — v1 그대로
// ================================================================
head('[개별 행 spot-check]');
const row = (id) => r.rows.find(x => x.id === id);
const x150 = row('x150');
approx('x150.qty',      x150.qty,      180);
approx('x150.matFinal', x150.matFinal, 16940);
approx('x150.matTotal', x150.matTotal, 3049200);
approx('x150.labFinal', x150.labFinal, 3605);
approx('x150.labTotal', x150.labTotal, 648900);
const xw30 = row('xw30');
approx('xw30.qty',      xw30.qty,      26.52);
approx('xw30.matTotal', xw30.matTotal, 88974.6);
approx('xw30.labTotal', xw30.labTotal, 278460);
approx('xw30.subTotal', xw30.subTotal, 217464);
const wf = row('wf_crc');
approx('wf_crc.qty',      wf.qty,      15.6);
approx('wf_crc.matTotal', wf.matTotal, 210600);
approx('wf_crc.labTotal', wf.labTotal, 546000);
approx('wf_crc.subTotal', wf.subTotal, 15600);
const tp = row('tp_siga');
approx('tp_siga.qty',      tp.qty,      176.8);
approx('tp_siga.matTotal', tp.matTotal, 269178);
approx('tp_siga.labTotal', tp.labTotal, 835380);
const gv = row('gv_ton');
approx('gv_ton.qty',      gv.qty,      180);
approx('gv_ton.matTotal', gv.matTotal, 1782000);
approx('gv_ton.labTotal', gv.labTotal, 1584000);

// ================================================================
// [발주서 orders] — v1 그대로
// ================================================================
head('[발주서 orders]');
const vend = (name) => r.orders.find(o => o.vendor === name);
const bg = vend('부광스티로폴');
approx('부광스티로폴 subtotal', bg ? bg.subtotal : NaN, 4714086);
const bgItem = (kw) => bg.items.find(i => i.name.includes(kw));
approx('  XPS 150T 발주수량(장)', bgItem('150T').orderQty, 112);
approx('  XPS 100T 발주수량(장)', bgItem('100T').orderQty, 112);
approx('  XPS 30T벽 발주수량(장)', bgItem('30T').orderQty, 17);
const tif = vend('티푸스');
approx('티푸스 subtotal', tif ? tif.subtotal : NaN, 900000);
const jj = vend('잡자재');
approx('잡자재 subtotal', jj ? jj.subtotal : NaN, 4205140);
const jjItem = (kw) => jj.items.find(i => i.name.includes(kw));
approx('  투습방수지 발주수량(롤)', jjItem('투습방수지').orderQty, 3);
approx('  기밀테이프 발주수량(롤)', jjItem('기밀테이프').orderQty, 5);
approx('  배수판 발주수량(장)',    jjItem('배수판').orderQty, 720);
approx('  부직포 발주수량(롤)',    jjItem('부직포').orderQty, 2);

// ================================================================
// [V2 케이스 1 · 레거시 토글 OFF] subInNetCost=false → v1 전체 기대값 재현
// ================================================================
head('[V2-1 · 레거시 subInNetCost=false → v1 재현]');
const eL = clone(RC.SAMPLE_DONGSAK); eL.rates.subInNetCost = false;
const rL = RC.computeEstimate(eL);
approx('netCost = 22496728.33',    rL.cost.netCost,     22496728.33);
approx('constrTotal = 26996073.996', rL.cost.constrTotal, 26996073.996);
approx('vat = 2699607.3996',        rL.cost.vat,         2699607.3996);
approx('grandTotal = 29695681.3956', rL.cost.grandTotal,  29695681.3956);
approx('perPyeong = 494928.02326',  rL.cost.perPyeong,   494928.02326);

// ================================================================
// [V2 케이스 2 · 오버라이드] computeEstimate(est, {items:{x150:{mat:16000}}})
//   → x150 matFinal = 16000 × 1.1 = 17600. 미전달 시 결과 불변.
// ================================================================
head('[V2-2 · 단가 오버라이드]');
const rOv = RC.computeEstimate(RC.SAMPLE_DONGSAK, { items:{ x150:{ mat:16000 } } });
approx('override x150.mat 기준가',   rOv.rows.find(x=>x.id==='x150').mat,      16000);
approx('override x150.matFinal',    rOv.rows.find(x=>x.id==='x150').matFinal, 17600);
approx('override x150.matTotal',    rOv.rows.find(x=>x.id==='x150').matTotal, 180*17600);
const rNoOv = RC.computeEstimate(RC.SAMPLE_DONGSAK);
approx('오버라이드 미전달 → grandTotal 불변', rNoOv.cost.grandTotal, 30133213.8756);
approx('오버라이드 미전달 → x150.matFinal 불변', rNoOv.rows.find(x=>x.id==='x150').matFinal, 16940);
// equip 오버라이드
const rEq = RC.computeEstimate(RC.SAMPLE_DONGSAK, { equip:{ '크레인(50톤) 0.5일':900000 } });
approx('override equip 크레인 → 가설.mat', rEq.trades['가설공사'].mat, 2910000 - 800000 + 900000);

// ================================================================
// [V2 케이스 3 · VAT 아니오 / 지급자재 예] — 새 기본값(부자재 포함) 기준
// ================================================================
head('[V2-3 · VAT 아니오 (부자재 포함 기본)]');
const e1 = clone(RC.SAMPLE_DONGSAK); e1.rates.taxInvoice = '아니오';
const r1 = RC.computeEstimate(e1);
approx('vat = 0', r1.cost.vat, 0);
approx('grandTotal = constrTotal', r1.cost.grandTotal, r1.cost.constrTotal);
approx('constrTotal = 27393830.796', r1.cost.constrTotal, 27393830.796);
approx('grandTotal = 27393830.796', r1.cost.grandTotal, 27393830.796);

head('[V2-3 · ownerSupplied=예 (지급자재)]');
const e2 = clone(RC.SAMPLE_DONGSAK); e2.sel.ownerSupplied = '예';
const r2 = RC.computeEstimate(e2);
const r2row = (id) => r2.rows.find(x => x.id === id);
approx('x150.matTotal = 0',   r2row('x150').matTotal, 0);
approx('x100.matTotal = 0',   r2row('x100').matTotal, 0);
approx('xw30.matTotal = 0',   r2row('xw30').matTotal, 0);
approx('x150.labTotal 불변',   r2row('x150').labTotal, 648900);
approx('xw30.labTotal 불변',   r2row('xw30').labTotal, 278460);

// ================================================================
// [V2 케이스 4 · addl 객체 확장] 크랙보수 on·qty 2
//   → 추가공사 재료 +300,000 · 노무 +500,000 · 부자재 +20,000
// ================================================================
head('[V2-4 · addl 크랙보수 on·qty 2]');
const e3 = clone(RC.SAMPLE_DONGSAK);
e3.addl.crack = { on:true, qty:2, mat:150000, lab:250000, sub:10000, surMat:0, surLab:0 };
const r3 = RC.computeEstimate(e3);
approx('추가공사.mat = 469,884', r3.trades['추가공사'].mat, 169884 + 300000);
approx('추가공사.lab = 626,000', r3.trades['추가공사'].lab, 126000 + 500000);
approx('추가공사.sub = 118,400', r3.trades['추가공사'].sub, 98400 + 20000);
const crackRow = r3.rows.find(x=>x.addlKey==='crack');
approx('크랙 행 matTotal', crackRow.matTotal, 300000);
approx('크랙 행 labTotal', crackRow.labTotal, 500000);
approx('크랙 행 subTotal', crackRow.subTotal, 20000);
// floorFrame 할증(-0.5) 재현
const e3b = clone(RC.SAMPLE_DONGSAK);
e3b.addl.floorFrame = { on:true, qty:1, mat:300000, lab:100000, sub:15000, surMat:-0.5, surLab:-0.5 };
const r3b = RC.computeEstimate(e3b);
const ffRow = r3b.rows.find(x=>x.addlKey==='floorFrame');
approx('바닥프레임 matFinal(-0.5)', ffRow.matFinal, 150000);
approx('바닥프레임 labFinal(-0.5)', ffRow.labFinal, 50000);

// ================================================================
// [V2 케이스 5 · finishAll enabled] 전체마감 쇄석/벽체 없음
//   → crc보드 행 비활성. 역전지붕 재료 12,482,891.6 · 노무 5,472,678 · 부자재 217,464
// ================================================================
head('[V2-5 · finishAll enabled (쇄석 / 없음)]');
const e4 = clone(RC.SAMPLE_DONGSAK);
e4.finishAll = { enabled:true, finish:'쇄석', wallFinish:'없음' };
const r4 = RC.computeEstimate(e4);
approx('역전지붕공사.mat = 12,482,891.6', r4.trades['역전지붕공사'].mat, 12482891.6);
approx('역전지붕공사.lab = 5,472,678',    r4.trades['역전지붕공사'].lab, 5472678);
approx('역전지붕공사.sub = 217,464',      r4.trades['역전지붕공사'].sub, 217464);
eq('wf_crc 행 비활성',                    r4.rows.some(x=>x.id==='wf_crc'), false);
approx('derived.wallCrc = 0',             r4.derived.wallCrc, 0);
approx('derived.gravelArea 불변 = 180',   r4.derived.gravelArea, 180);

// ================================================================
// [V3-1 · 구역별 자재선택 회귀] withZoneSel(zone.sel 생성, ea zones[0]만) → 수치 불변
// ================================================================
head('[V3-1 · 구역별 sel 회귀 (병합 경로, ea는 zones[0]만)]');
const eZ = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK));
eq('zones[0].sel.siliconEa = 10', eZ.zones[0].sel.siliconEa, 10);
eq('zones[1].sel.siliconEa = 0',  eZ.zones[1].sel.siliconEa, 0);
eq('zones[2].sel.siliconEa = 0',  eZ.zones[2].sel.siliconEa, 0);
eq('zones[0].sel.trenchFloorEa = 6', eZ.zones[0].sel.trenchFloorEa, 6);
eq('zones[1].sel.trenchFloorEa = 0', eZ.zones[1].sel.trenchFloorEa, 0);
const rZ = RC.computeEstimate(eZ);
approx('grandTotal 불변 30,133,213.8756', rZ.cost.grandTotal, 30133213.8756);
approx('역전지붕공사.mat 불변',   rZ.trades['역전지붕공사'].mat, 12693491.6);
approx('역전지붕공사.lab 불변',   rZ.trades['역전지붕공사'].lab, 6018678);
approx('역전지붕공사.sub 불변',   rZ.trades['역전지붕공사'].sub, 233064);
approx('tradeTotal.total 불변',   rZ.tradeTotal.total, 22249517.6);
approx('sil qty 불변 = 10',       rZ.rows.find(x=>x.id==='sil').qty, 10);
approx('tr_f qty 불변 = 6',       rZ.rows.find(x=>x.id==='tr_f').qty, 6);
approx('x150 qty 불변 = 180',     rZ.rows.find(x=>x.id==='x150').qty, 180);
approx('x100 qty 불변 = 180',     rZ.rows.find(x=>x.id==='x100').qty, 180);
approx('xw30 qty 불변 = 26.52',   rZ.rows.find(x=>x.id==='xw30').qty, 26.52);
approx('wf_crc qty 불변 = 15.6',  rZ.rows.find(x=>x.id==='wf_crc').qty, 15.6);
approx('tp_siga qty 불변 = 176.8', rZ.rows.find(x=>x.id==='tp_siga').qty, 176.8);
const bgZ = rZ.orders.find(o=>o.vendor==='부광스티로폴');
approx('부광스티로폴 subtotal 불변', bgZ?bgZ.subtotal:NaN, 4714086);
// 레거시 토글 · finishAll=true 도 병합 경로 도입 후 불변
const eZL = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); eZL.rates.subInNetCost=false;
approx('레거시(subInNetCost=false) grandTotal 29,695,681.3956', RC.computeEstimate(eZL).cost.grandTotal, 29695681.3956);
const eZF = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); eZF.finishAll={enabled:true,finish:'쇄석',wallFinish:'없음'};
approx('finishAll=true 역전지붕 mat 12,482,891.6', RC.computeEstimate(eZF).trades['역전지붕공사'].mat, 12482891.6);

// ================================================================
// [V3-2 · 병합 동등성] 전 구역 동일 sel(enabled=false) == enabled=true(est.sel 동일)
// ================================================================
head('[V3-2 · 병합 동등성 (uniform enabled=false == enabled=true)]');
const uni = clone(RC.SAMPLE_DONGSAK);
uni.zones.forEach(z=>{ z.finish='쇄석'; z.wallFinish='없음'; }); // 균일 마감 (crc 제거)
const uniT = clone(uni); uniT.finishAll={enabled:true,finish:'쇄석',wallFinish:'없음'};
const rUniT = RC.computeEstimate(uniT);                          // 전역 단일패스
const uniF = RC.withZoneSel(clone(uni)); uniF.finishAll={enabled:false,finish:'쇄석',wallFinish:'없음'};
const rUniF = RC.computeEstimate(uniF);                          // 구역별 병합
approx('grandTotal 동일',        rUniF.cost.grandTotal, rUniT.cost.grandTotal);
approx('역전지붕 mat 동일',       rUniF.trades['역전지붕공사'].mat, rUniT.trades['역전지붕공사'].mat);
approx('역전지붕 lab 동일',       rUniF.trades['역전지붕공사'].lab, rUniT.trades['역전지붕공사'].lab);
approx('tradeTotal.total 동일',  rUniF.tradeTotal.total, rUniT.tradeTotal.total);
eq('행 개수 동일', rUniF.rows.length, rUniT.rows.length);
let rowsMatch = true, rowBad = '';
rUniT.rows.forEach(rt=>{ const rf=rUniF.rows.find(x=>x.id===rt.id);
  if(!rf || Math.abs(rf.qty-rt.qty)>TOL || Math.abs(rf.rowTotal-rt.rowTotal)>TOL){ rowsMatch=false; rowBad=rt.id; } });
eq('모든 행 qty·rowTotal 동일'+(rowsMatch?'':' ['+rowBad+']'), rowsMatch, true);
let ordMatch = rUniF.orders.length===rUniT.orders.length;
rUniT.orders.forEach(ot=>{ const of=rUniF.orders.find(x=>x.vendor===ot.vendor); if(!of || Math.abs(of.subtotal-ot.subtotal)>TOL) ordMatch=false; });
eq('orders 벤더수·subtotal 동일', ordMatch, true);

// ================================================================
// [V3-3 · ea 합산] zones[1].sel.siliconEa=5 → silicon 행 qty 15, mat 165,000 (11,000/ea)
// ================================================================
head('[V3-3 · ea 구역 합산]');
const eEa = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); eEa.zones[1].sel.siliconEa=5;
const rEa = RC.computeEstimate(eEa); const silR = rEa.rows.find(x=>x.id==='sil');
approx('silicon 행 qty = 10+5+0 = 15', silR?silR.qty:NaN, 15);
approx('silicon matFinal = 11,000',    silR?silR.matFinal:NaN, 11000);
approx('silicon matTotal = 165,000',   silR?silR.matTotal:NaN, 165000);

// ================================================================
// [V3-4 · 변형 분리] zones[0].xps1=100T, zones[1..2]=50T → XPS 1P 행 2개, 각 행 = 해당 구역만 남긴 부분견적
// ================================================================
head('[V3-4 · 변형 분리 (XPS 100T vs 50T)]');
const eV = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK));
eV.zones[0].sel.xps1='100T'; eV.zones[1].sel.xps1='50T'; eV.zones[2].sel.xps1='50T'; // xps2=150T 전구역 유지
const rV = RC.computeEstimate(eV);
const x100 = rV.rows.find(x=>x.id==='x100'); const x50 = rV.rows.find(x=>x.id==='x50'); const x150v = rV.rows.find(x=>x.id==='x150');
eq('x100 행 존재', !!x100, true);
eq('x50 행 존재',  !!x50, true);
approx('x100 qty = floor_0 = 138.7',        x100?x100.qty:NaN, 138.7);
approx('x50 qty = floor_1+floor_2 = 41.3',  x50?x50.qty:NaN, 41.3);
approx('x150 qty = 전구역 180',              x150v?x150v.qty:NaN, 180);
// 부분견적 대조
const ePart0 = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); ePart0.zones=[ePart0.zones[0]]; ePart0.zones[0].sel.xps1='100T';
approx('부분견적(zone0) x100 == 병합 x100', RC.computeEstimate(ePart0).rows.find(x=>x.id==='x100').qty, x100?x100.qty:NaN);
const ePart12 = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); ePart12.zones=[ePart12.zones[1],ePart12.zones[2]];
ePart12.zones[0].sel.xps1='50T'; ePart12.zones[1].sel.xps1='50T';
approx('부분견적(zone1,2) x50 == 병합 x50', RC.computeEstimate(ePart12).rows.find(x=>x.id==='x50').qty, x50?x50.qty:NaN);

// ================================================================
// [V3-5 · coverNotes 4줄]
// ================================================================
head('[V3-5 · coverNotes]');
eq('COMPANY.coverNotes 4줄', RC.COMPANY.coverNotes.length, 4);
eq('4번째 문구', RC.COMPANY.coverNotes[3], '4. 본 견적서는 한달간 유효합니다.');
eq('migrateCoverNotes(구 3줄) → 4줄', RC.migrateCoverNotes(['1. 전체 주간공사 기준입니다.','2. 용전용수 지원 조건입니다.','3. 견적 외 공사 미 포함입니다.']).length, 4);
const customCover = ['우리 커스텀 조건 A','조건 B'];
eq('migrateCoverNotes(커스텀) 불변', JSON.stringify(RC.migrateCoverNotes(customCover)), JSON.stringify(customCover));

// ================================================================
// [V5-1 · 쇄석 마감 '없음'] gravelPack='없음' → gv_* 행 자체 미생성 (견적서·내역서·발주서 제외)
//   baseline gv_ton: qty 180 × (matFinal 9,900 + labFinal 8,800) = 3,366,000
// ================================================================
head('[V5-1 · 쇄석 마감 없음 (쇄석작업 미시공)]');
const eG = clone(RC.SAMPLE_DONGSAK); eG.sel.gravelPack='없음';
const rG = RC.computeEstimate(eG);
eq('gv_ton 행 없음',   rG.rows.some(x=>x.id==='gv_ton'), false);
eq('gv_small 행 없음', rG.rows.some(x=>x.id==='gv_small'), false);
approx('역전지붕공사.mat −1,782,000', rG.trades['역전지붕공사'].mat, 12693491.6 - 1782000);
approx('역전지붕공사.lab −1,584,000', rG.trades['역전지붕공사'].lab, 6018678 - 1584000);
approx('tradeTotal −3,366,000', rG.tradeTotal.total, 22249517.6 - 3366000);
approx('derived.gravelArea 는 유지 = 180', rG.derived.gravelArea, 180);
eq('발주서 유신골재 없음', rG.orders.some(o=>o.vendor==='유신 골재'), false);
// 구역별(병합) 경로: zones[0]만 없음 → gv_ton qty = 18.3+23 = 41.3
const eGZ = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); eGZ.zones[0].sel.gravelPack='없음';
const gvZ = RC.computeEstimate(eGZ).rows.find(x=>x.id==='gv_ton');
approx('구역별: zone0 없음 → gv_ton qty = 41.3', gvZ?gvZ.qty:NaN, 41.3);
// 전 구역 없음 → gv 행 전무
const eGZ2 = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); eGZ2.zones.forEach(z=>{ z.sel.gravelPack='없음'; });
eq('구역별: 전 구역 없음 → gv_ton 없음', RC.computeEstimate(eGZ2).rows.some(x=>x.id==='gv_ton'), false);

// ================================================================
// [V5-2 · XPS 벽체 100T] xw100: 재료 = 바닥 100T(10,340) · 노무/부자재 = 기존 벽체 취부 단가(10,000/8,200)
// ================================================================
head('[V5-2 · XPS 벽체 100T 취부]');
const dbXw100 = RC.ITEM_DB.find(x=>x.id==='xw100');
const dbX100  = RC.ITEM_DB.find(x=>x.id==='x100');
const dbXw70  = RC.ITEM_DB.find(x=>x.id==='xw70');
eq('xw100 ITEM_DB 존재', !!dbXw100, true);
approx('재료단가 = 바닥 100T 와 동일', dbXw100.mat, dbX100.mat);
approx('노무단가 = 벽체 취부 동일(10,000)', dbXw100.lab, dbXw70.lab);
approx('부자재단가 = 벽체 취부 동일(8,200)', dbXw100.sub, dbXw70.sub);
eq('labSurKey = xpsWallLab', dbXw100.labSurKey, 'xpsWallLab');
const eW = clone(RC.SAMPLE_DONGSAK); eW.sel.xpsWall='100T벽';
const rW = RC.computeEstimate(eW);
const xw100R = rW.rows.find(x=>x.id==='xw100');
eq('xw100 행 생성', !!xw100R, true);
eq('xw30 행 미생성', rW.rows.some(x=>x.id==='xw30'), false);
approx('qty = 벽면적 26.52', xw100R.qty, 26.52);
approx('matFinal = 10,340×1.1 = 11,374', xw100R.matFinal, 11374);
approx('labFinal = 10,000×1.05 = 10,500', xw100R.labFinal, 10500);
approx('matTotal = 301,638.48', xw100R.matTotal, 301638.48);
approx('labTotal = 278,460', xw100R.labTotal, 278460);
approx('subTotal = 217,464', xw100R.subTotal, 217464);
approx('역전지붕공사.mat +Δ(212,663.88)', rW.trades['역전지붕공사'].mat, 12693491.6 + (301638.48 - 88974.6));
const bgW = rW.orders.find(o=>o.vendor==='부광스티로폴');
const xw100Ord = bgW && bgW.items.find(i=>i.name.indexOf('100T')>=0 && i.name.indexOf('연질폼')>=0);
approx('발주수량 = ceil(26.52/1.62) = 17장', xw100Ord?xw100Ord.orderQty:NaN, 17);
// 지급자재 → 재료비 0 (XPS 계열)
const eWo = clone(eW); eWo.sel.ownerSupplied='예';
approx('지급자재 시 matTotal 0', RC.computeEstimate(eWo).rows.find(x=>x.id==='xw100').matTotal, 0);

// ================================================================
// [V5-3 · 투습방수지·기밀테이프·배수판·부직포 '없음'] 각 sel='없음' → 해당 행 미생성 (견적서·내역서·발주서 제외)
//   메커니즘: 각 아이템 on:"sel.X=변형" 불일치 → 쇄석과 동일. 자재소개는 if(m) 가드로 skip.
// ================================================================
head("[V5-3 · 부자재 4종 '없음' (특수현장 미시공)]");
const baseR = RC.computeEstimate(RC.SAMPLE_DONGSAK);
const noneCases = [
  { field:'vaporBarrier', id:'vb_siga', label:'투습방수지' },
  { field:'tape',         id:'tp_siga', label:'기밀테이프' },
  { field:'drainBoard',   id:'db_jap',  label:'배수판' },
  { field:'fabric',       id:'fb_jap',  label:'부직포' },
];
noneCases.forEach(c=>{
  const row0 = baseR.rows.find(x=>x.id===c.id);
  eq(`baseline ${c.id} 행 존재`, !!row0, true);
  const e = clone(RC.SAMPLE_DONGSAK); e.sel[c.field]='없음';
  const rr = RC.computeEstimate(e);
  eq(`${c.label} 없음 → ${c.id} 행 미생성`, rr.rows.some(x=>x.id===c.id), false);
  approx(`${c.label} 없음 → tradeTotal −(행 제거분)`, rr.tradeTotal.total, baseR.tradeTotal.total - row0.rowTotal);
});
// 구체 수치 스팟체크 (배수판 없음: db_jap qty180×(14175+2625)=3,024,000)
approx('db_jap rowTotal = 3,024,000', baseR.rows.find(x=>x.id==='db_jap').rowTotal, 3024000);
const eDB = clone(RC.SAMPLE_DONGSAK); eDB.sel.drainBoard='없음';
approx('배수판 없음 → 역전지붕 mat −2,551,500', RC.computeEstimate(eDB).trades['역전지붕공사'].mat, baseR.trades['역전지붕공사'].mat - 2551500);
// 4종 동시 없음 → 4개 행 모두 미생성 + 합계 차감
const eAll = clone(RC.SAMPLE_DONGSAK);
eAll.sel.vaporBarrier='없음'; eAll.sel.tape='없음'; eAll.sel.drainBoard='없음'; eAll.sel.fabric='없음';
const rAll = RC.computeEstimate(eAll);
eq('4종 동시 없음 → 4개 행 전부 미생성',
   ['vb_siga','tp_siga','db_jap','fb_jap'].every(id=>!rAll.rows.some(x=>x.id===id)), true);
const dropSum = ['vb_siga','tp_siga','db_jap','fb_jap'].reduce((s,id)=>s+baseR.rows.find(x=>x.id===id).rowTotal,0);
approx('4종 없음 → tradeTotal −합계', rAll.tradeTotal.total, baseR.tradeTotal.total - dropSum);
// 구역별(병합) 경로: zones[0]만 배수판 없음 → db_jap qty = 18.3+23 = 41.3
const eZDB = RC.withZoneSel(clone(RC.SAMPLE_DONGSAK)); eZDB.zones[0].sel.drainBoard='없음';
const dbZ = RC.computeEstimate(eZDB).rows.find(x=>x.id==='db_jap');
approx('구역별: zone0 배수판 없음 → db_jap qty = 41.3', dbZ?dbZ.qty:NaN, 41.3);

// ---- 결과 ----
console.log(`\n\x1b[1m결과: ${pass} 통과 / ${fail} 실패 (총 ${pass + fail})\x1b[0m`);
if (fail > 0) { console.log('\x1b[31m실패 항목: ' + fails.join(', ') + '\x1b[0m'); process.exit(1); }
console.log('\x1b[32m✓ 전체 통과 — 엑셀 견적서와 1원 단위(±1) 일치 · V2 신규 기대값 반영\x1b[0m');
process.exit(0);
