// 하버 카페 경쟁사 분석 PPT 생성 스크립트
// 실행: NODE_PATH=$(npm root -g) node make-competitors-pptx.js
const pptxgen = require("pptxgenjs");
const path = require("path");

const OUT = path.join(__dirname, "competitors.pptx");

// ── 팔레트 (말차 × 크림, 깔끔한 톤) ──────────────────────────────
const INK = "1F2C24"; // 진한 제목 텍스트
const BODY = "45514A"; // 본문
const MUTED = "8A9188"; // 캡션/키커
const PAPER = "F6F3EB"; // 밝은 배경(웜 크림)
const CARD = "FFFFFF";
const LINEC = "E3DFD2"; // 얇은 테두리
const DARKBG = "24382D"; // 커버/클로징 배경(딥 파인)
const PANEL = "2F4A3A"; // 다크 슬라이드 패널
const MATCHA = "7FA75B"; // 밝은 말차(우리 강조)
const MATCHA_D = "3E6647"; // 딥 말차(리더 바/헤더)
const SAGE = "BCC6AE"; // 경쟁사 바(뮤트)
const GOLD = "C7A45E"; // 포인트(키커/칩)
const CREAM_T = "F2EFE3"; // 다크 배경 위 텍스트
const CREAM_M = "A9B8A3"; // 다크 배경 위 보조 텍스트
const CORAL = "BC5F4A"; // 격차 숫자(경고 1회만)
const TINT = "ECF1DF"; // 우리 행 하이라이트

const FONT = "Apple SD Gothic Neo";

const makeShadow = () => ({ type: "outer", color: "3A3A30", blur: 7, offset: 2, angle: 135, opacity: 0.14 });

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.author = "하버 카페";
pres.title = "하버 카페 경쟁 카페 분석";

// 공통: 키커 + 타이틀 헤더
function header(slide, kicker, title, dark = false) {
  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0.6, y: 0.5, w: 0.09, h: 0.09, fill: { color: GOLD },
  });
  slide.addText(kicker, {
    x: 0.78, y: 0.38, w: 6, h: 0.32, margin: 0, fontFace: FONT,
    fontSize: 10.5, charSpacing: 3, bold: true,
    color: dark ? GOLD : MUTED, valign: "middle",
  });
  slide.addText(title, {
    x: 0.6, y: 0.72, w: 8.8, h: 0.55, margin: 0, fontFace: FONT,
    fontSize: 29, bold: true, color: dark ? CREAM_T : INK, valign: "middle",
  });
}

// 공통: 푸터 (문서명 + 페이지 번호)
function footer(slide, num, dark = false) {
  slide.addText("하버 카페 · 경쟁 카페 분석", {
    x: 0.6, y: 5.26, w: 3.5, h: 0.24, margin: 0, fontFace: FONT,
    fontSize: 8.5, color: dark ? "7E9280" : MUTED, valign: "middle",
  });
  slide.addText(num, {
    x: 9.0, y: 5.26, w: 0.4, h: 0.24, margin: 0, fontFace: FONT,
    fontSize: 9, color: dark ? "7E9280" : MUTED, align: "right", valign: "middle",
  });
}

// ════════════════════════ 1. 표지 ════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: DARKBG };

  // 모티프: 오른쪽 라떼/말차 원형
  s.addShape(pres.shapes.OVAL, { x: 6.9, y: -1.5, w: 4.8, h: 4.8, fill: { color: MATCHA, transparency: 84 } });
  s.addShape(pres.shapes.OVAL, { x: 8.35, y: 1.15, w: 2.15, h: 2.15, fill: { color: MATCHA, transparency: 68 } });
  s.addShape(pres.shapes.OVAL, {
    x: 7.15, y: 3.05, w: 1.55, h: 1.55,
    fill: { color: DARKBG, transparency: 100 }, line: { color: GOLD, width: 1.25 },
  });
  s.addShape(pres.shapes.OVAL, { x: 8.6, y: 3.95, w: 0.4, h: 0.4, fill: { color: GOLD } });

  s.addShape(pres.shapes.RECTANGLE, { x: 0.7, y: 1.42, w: 0.1, h: 0.1, fill: { color: GOLD } });
  s.addText("HARBOR CAFE — COMPETITIVE REVIEW", {
    x: 0.9, y: 1.3, w: 6, h: 0.34, margin: 0, fontFace: FONT,
    fontSize: 11, charSpacing: 3.5, bold: true, color: GOLD, valign: "middle",
  });

  s.addText("주변 경쟁 카페 분석", {
    x: 0.68, y: 1.85, w: 7.6, h: 0.95, margin: 0, fontFace: FONT,
    fontSize: 47, bold: true, color: CREAM_T, valign: "middle",
  });
  s.addText("반경 500m 상권 · 카페 4곳 비교와 하버 카페의 차별화 전략", {
    x: 0.7, y: 2.95, w: 6.6, h: 0.4, margin: 0, fontFace: FONT,
    fontSize: 13.5, color: CREAM_M, valign: "middle",
  });

  s.addText("2026. 07  |  하버 카페 마케팅", {
    x: 0.7, y: 4.9, w: 4, h: 0.3, margin: 0, fontFace: FONT,
    fontSize: 10, color: "8FA08C", valign: "middle",
  });
}

// ════════════════════════ 2. 시장 개요 ════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: PAPER };
  header(s, "MARKET OVERVIEW", "시장 개요");

  const cards = [
    { label: "반경 500m 내 카페", big: "4곳", bigSize: 40, desc: "하버 카페 포함, 도보 5분 생활권 경쟁" },
    { label: "평균 아메리카노 가격", big: "4,500원", bigSize: 40, desc: "경쟁가 4,000~5,000원 사이에 밀집" },
    { label: "핵심 고객층", big: "직장인 · 대학생", bigSize: 23, desc: "오피스·캠퍼스 혼합 상권" },
  ];
  cards.forEach((c, i) => {
    const x = 0.6 + i * 2.99;
    s.addShape(pres.shapes.RECTANGLE, { x, y: 1.6, w: 2.82, h: 2.25, fill: { color: CARD }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x, y: 1.6, w: 0.07, h: 2.25, fill: { color: MATCHA } });
    s.addText(c.label, {
      x: x + 0.3, y: 1.88, w: 2.3, h: 0.3, margin: 0, fontFace: FONT,
      fontSize: 10.5, bold: true, charSpacing: 0.5, color: MUTED, valign: "middle",
    });
    s.addText(c.big, {
      x: x + 0.3, y: 2.22, w: 2.35, h: 0.85, margin: 0, fontFace: FONT,
      fontSize: c.bigSize, bold: true, color: INK, valign: "middle",
    });
    s.addText(c.desc, {
      x: x + 0.3, y: 3.18, w: 2.28, h: 0.55, margin: 0, fontFace: FONT,
      fontSize: 10.5, color: BODY, valign: "top",
    });
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 4.42, w: 0.09, h: 0.09, fill: { color: GOLD } });
  s.addText("가격 차이는 크지 않은 상권 — 승부는 시그니처 메뉴와 인지도에서 갈린다.", {
    x: 0.82, y: 4.28, w: 8.5, h: 0.38, margin: 0, fontFace: FONT,
    fontSize: 13, bold: true, color: INK, valign: "middle",
  });

  footer(s, "02");
}

// ════════════════════════ 3. 경쟁사 비교표 ════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: PAPER };
  header(s, "COMPETITOR COMPARISON", "경쟁사 비교");

  const hOpt = { fill: { color: MATCHA_D }, color: "F1EEE2", bold: true, fontSize: 10.5, align: "center", valign: "middle" };
  const c = (text, opts = {}) => ({ text, options: { fontSize: 10.5, color: BODY, valign: "middle", ...opts } });
  const ours = { fill: { color: TINT } };

  const rows = [
    [c("카페", hOpt), c("아메리카노", hOpt), c("시그니처", hOpt), c("인스타 팔로워", hOpt), c("강점", hOpt), c("약점", hOpt)],
    [
      c("A  빈브라더스", { bold: true, color: INK }),
      c("5,000원", { align: "center" }), c("핸드드립", { align: "center" }), c("8,200", { align: "center" }),
      c("원두 퀄리티"), c("가격 높음 · 좌석 적음"),
    ],
    [
      c("B  카페모노", { bold: true, color: INK }),
      c("4,000원", { align: "center" }), c("대용량 라떼", { align: "center" }), c("3,100", { align: "center" }),
      c("가성비"), c("디저트 약함"),
    ],
    [
      c("C  스윗아워", { bold: true, color: INK }),
      c("4,800원", { align: "center" }), c("수제 디저트", { align: "center" }), c("12,500", { align: "center", bold: true }),
      c("디저트 · 인스타 강함"), c("커피맛 평범"),
    ],
    [
      c("하버 카페 (우리)", { bold: true, color: MATCHA_D, ...ours }),
      c("4,500원", { align: "center", ...ours }), c("말차라떼", { align: "center", bold: true, ...ours }), c("2,400", { align: "center", ...ours }),
      c("균형 · 친절", ours), c("인지도 낮음 · 웨이팅", ours),
    ],
  ];

  s.addTable(rows, {
    x: 0.6, y: 1.55, w: 8.8,
    colW: [1.5, 1.15, 1.3, 1.2, 1.8, 1.85],
    rowH: [0.42, 0.55, 0.55, 0.55, 0.55],
    border: { pt: 0.75, color: LINEC },
    fill: { color: CARD },
    fontFace: FONT,
    margin: [0.04, 0.08, 0.04, 0.08],
  });

  s.addShape(pres.shapes.RECTANGLE, { x: 0.6, y: 4.68, w: 0.09, h: 0.09, fill: { color: GOLD } });
  s.addText("C는 디저트·인스타, B는 가성비 — 우리의 '균형 + 친절'은 방향은 맞지만 아직 약하다.", {
    x: 0.82, y: 4.54, w: 8.5, h: 0.38, margin: 0, fontFace: FONT,
    fontSize: 13, bold: true, color: INK, valign: "middle",
  });

  footer(s, "03");
}

// ════════════════════════ 4. 인지도 격차 (팔로워 차트) ════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: PAPER };
  header(s, "AWARENESS GAP", "인지도 격차 — 인스타 팔로워");

  const MAXV = 12500, MAXW = 3.55;
  const bars = [
    { name: "C  스윗아워", v: 12500, color: MATCHA_D, bold: true },
    { name: "A  빈브라더스", v: 8200, color: SAGE },
    { name: "B  카페모노", v: 3100, color: SAGE },
    { name: "하버 카페", v: 2400, color: MATCHA, bold: true, us: true },
  ];
  const BARX = 2.12;
  bars.forEach((b, i) => {
    const y = 1.78 + i * 0.74;
    const w = Math.max((b.v / MAXV) * MAXW, 0.12);
    s.addText(b.name, {
      x: 0.6, y: y - 0.03, w: 1.45, h: 0.4, margin: 0, fontFace: FONT,
      fontSize: 11.5, bold: !!b.bold, color: b.us ? MATCHA_D : BODY, valign: "middle",
    });
    s.addShape(pres.shapes.RECTANGLE, { x: BARX, y, w, h: 0.34, fill: { color: b.color } });
    s.addText(b.v.toLocaleString(), {
      x: BARX + w + 0.09, y: y - 0.03, w: 0.75, h: 0.4, margin: 0, fontFace: FONT,
      fontSize: 11, bold: true, color: INK, valign: "middle",
    });
    if (b.us) {
      s.addText("우리", {
        shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.12,
        x: BARX + w + 0.75, y: y + 0.04, w: 0.5, h: 0.27,
        fill: { color: GOLD }, fontFace: FONT, fontSize: 8.5, bold: true,
        color: "FFFFFF", align: "center", valign: "middle", margin: 0,
      });
    }
  });
  // 기준선 + 축 라벨
  s.addShape(pres.shapes.LINE, { x: BARX, y: 1.68, w: 0, h: 3.15, line: { color: LINEC, width: 1 } });
  s.addText("인스타그램 팔로워 수 (명)", {
    x: BARX, y: 4.86, w: 2.6, h: 0.24, margin: 0, fontFace: FONT,
    fontSize: 9, color: MUTED, valign: "middle",
  });

  // 오른쪽 격차 카드
  s.addShape(pres.shapes.RECTANGLE, { x: 6.3, y: 1.68, w: 3.1, h: 3.15, fill: { color: CARD }, shadow: makeShadow() });
  s.addShape(pres.shapes.RECTANGLE, { x: 6.3, y: 1.68, w: 0.07, h: 3.15, fill: { color: CORAL } });
  s.addText("1위와 우리의 격차", {
    x: 6.6, y: 1.95, w: 2.6, h: 0.3, margin: 0, fontFace: FONT,
    fontSize: 10.5, bold: true, color: MUTED, valign: "middle",
  });
  s.addText("5.2배", {
    x: 6.6, y: 2.26, w: 2.6, h: 0.8, margin: 0, fontFace: FONT,
    fontSize: 44, bold: true, color: CORAL, valign: "middle",
  });
  s.addText("스윗아워 12,500  vs  하버 2,400", {
    x: 6.6, y: 3.12, w: 2.65, h: 0.3, margin: 0, fontFace: FONT,
    fontSize: 10.5, color: BODY, valign: "middle",
  });
  s.addText([
    { text: "인지도가 가장 큰 열세 축.", options: { breakLine: true } },
    { text: "인플루언서 협업으로 격차를", options: { breakLine: true } },
    { text: "좁힌다  (추천 액션 ②)", options: { bold: true, color: MATCHA_D } },
  ], {
    x: 6.6, y: 3.55, w: 2.65, h: 1.05, margin: 0, fontFace: FONT,
    fontSize: 11, color: BODY, valign: "top", paraSpaceAfter: 4,
  });

  footer(s, "04");
}

// ════════════════════════ 5. 우리의 차별화 ════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: PAPER };
  header(s, "DIFFERENTIATION", "우리의 차별화");

  // 왼쪽: 현재 위치
  s.addText("현재 위치", {
    x: 0.6, y: 1.5, w: 3.9, h: 0.35, margin: 0, fontFace: FONT,
    fontSize: 13.5, bold: true, color: INK, valign: "middle",
  });
  const items = [
    "인지도 최하위 — 팔로워 2,400명, 1위의 1/5 수준",
    "포지션은 '균형 + 친절' — 방향은 맞지만 아직 약함",
    "웨이팅은 상권 공통 약점이자 우리 리뷰 불만 1위",
  ];
  items.forEach((t, i) => {
    const y = 2.0 + i * 0.82;
    s.addShape(pres.shapes.RECTANGLE, { x: 0.62, y: y + 0.07, w: 0.09, h: 0.09, fill: { color: MATCHA } });
    s.addText(t, {
      x: 0.85, y: y - 0.05, w: 3.6, h: 0.7, margin: 0, fontFace: FONT,
      fontSize: 11.5, color: BODY, valign: "top",
    });
  });

  // 오른쪽: 차별화 카드 2장
  const cards = [
    {
      tag: "차별화 ①", title: "말차라떼 × 디저트 세트",
      desc: "시그니처에 디저트를 붙여 '디저트 강자' 스윗아워와 정면승부",
    },
    {
      tag: "차별화 ②", title: "인플루언서 협업",
      desc: "마이크로 인플루언서 3~5명으로 인지도 격차 축소 — 홍보 캠페인의 출발점",
    },
  ];
  cards.forEach((cd, i) => {
    const y = 1.5 + i * 1.78;
    s.addShape(pres.shapes.RECTANGLE, { x: 4.85, y, w: 4.55, h: 1.58, fill: { color: CARD }, shadow: makeShadow() });
    s.addShape(pres.shapes.RECTANGLE, { x: 4.85, y, w: 0.07, h: 1.58, fill: { color: MATCHA } });
    s.addText(cd.tag, {
      x: 5.15, y: y + 0.17, w: 2, h: 0.26, margin: 0, fontFace: FONT,
      fontSize: 10, bold: true, charSpacing: 1, color: GOLD, valign: "middle",
    });
    s.addText(cd.title, {
      x: 5.15, y: y + 0.44, w: 4.05, h: 0.38, margin: 0, fontFace: FONT,
      fontSize: 16.5, bold: true, color: INK, valign: "middle",
    });
    s.addText(cd.desc, {
      x: 5.15, y: y + 0.88, w: 4.0, h: 0.58, margin: 0, fontFace: FONT,
      fontSize: 10.5, color: BODY, valign: "top",
    });
  });

  footer(s, "05");
}

// ════════════════════════ 6. 추천 액션 ════════════════════════
{
  const s = pres.addSlide();
  s.background = { color: DARKBG };
  header(s, "NEXT ACTIONS", "추천 액션", true);

  const acts = [
    { n: "01", title: "디저트 세트 출시", desc: "객단가 상승 + 디저트 강자 스윗아워 견제", chip: null },
    { n: "02", title: "인플루언서 3~5명 협업", desc: "인지도 격차 축소 — 리뷰·태그로 신규 유입 확보", chip: "→ 홍보 편으로 이어짐" },
    { n: "03", title: "피크타임 대기 동선 개선", desc: "상권 공통 약점 해소, 우리 리뷰 불만 1위 대응", chip: null },
  ];
  acts.forEach((a, i) => {
    const x = 0.6 + i * 2.99;
    s.addShape(pres.shapes.RECTANGLE, { x, y: 1.55, w: 2.82, h: 2.75, fill: { color: PANEL } });
    s.addText(a.n, {
      x: x + 0.28, y: 1.82, w: 1.2, h: 0.5, margin: 0, fontFace: FONT,
      fontSize: 28, bold: true, color: GOLD, valign: "middle",
    });
    s.addText(a.title, {
      x: x + 0.28, y: 2.42, w: 2.3, h: 0.68, margin: 0, fontFace: FONT,
      fontSize: 15.5, bold: true, color: CREAM_T, valign: "top",
    });
    s.addText(a.desc, {
      x: x + 0.28, y: 3.14, w: 2.28, h: 0.72, margin: 0, fontFace: FONT,
      fontSize: 10.5, color: CREAM_M, valign: "top",
    });
    if (a.chip) {
      s.addText(a.chip, {
        shape: pres.shapes.ROUNDED_RECTANGLE, rectRadius: 0.12,
        x: x + 0.28, y: 3.88, w: 1.62, h: 0.3,
        fill: { color: GOLD }, fontFace: FONT, fontSize: 9, bold: true,
        color: "26352B", align: "center", valign: "middle", margin: 0,
      });
    }
  });

  s.addText("세 가지 모두 '인지도 낮음 · 웨이팅'이라는 우리 약점과 직결 — ②가 다음 홍보 캠페인의 시작점이 된다.", {
    x: 0.6, y: 4.62, w: 8.8, h: 0.35, margin: 0, fontFace: FONT,
    fontSize: 11.5, color: CREAM_M, valign: "middle",
  });

  footer(s, "06", true);
}

pres.writeFile({ fileName: OUT }).then(() => console.log("WROTE", OUT));
