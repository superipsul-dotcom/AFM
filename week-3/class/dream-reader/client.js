// ========================================
// AI 해몽가 - 프론트엔드 로직
// ========================================

(function () {
  "use strict";

  // DOM 참조
  const personasEl = document.getElementById("personas");
  const dreamEl = document.getElementById("dream");
  const submitBtn = document.getElementById("submit");
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const resultEl = document.getElementById("result");
  const shareCardEl = document.getElementById("shareCard");
  const scPersonaEl = document.getElementById("scPersona");
  const scDateEl = document.getElementById("scDate");
  const luckRingEl = document.getElementById("luckRing");
  const luckScoreEl = document.getElementById("luckScore");
  const summaryEl = document.getElementById("summary");
  const keywordsEl = document.getElementById("keywords");
  const badgeEl = document.getElementById("badge");
  const adviceEl = document.getElementById("advice");
  const saveImgBtn = document.getElementById("saveImg");
  const copyTxtBtn = document.getElementById("copyTxt");
  const shareNoteEl = document.getElementById("shareNote");

  // 마지막 해몽 결과 (저장/복사용)
  let lastResult = null;

  // 선택 가능한 페르소나 (서버에서 못 받아오면 쓰는 폴백 기본값)
  let personas = [
    { key: "mystic", label: "🔮 신비로운 점술가" },
    { key: "mz", label: "😎 MZ세대 친구" },
  ];
  let selectedPersona = "mystic";
  let loading = false;

  // 로딩 시 보여줄 페르소나틱한 문구
  const LOADING_TEXT = {
    mystic: "별들에게 묻는 중...",
    mz: "꿈 풀이 중... 잠만ㅋㅋ",
  };

  // verdict -> 배지 색상 클래스
  function badgeClass(verdict) {
    if (verdict === "길몽") return "good";
    if (verdict === "흉몽") return "bad";
    return "mixed"; // 반길몽 등
  }

  // key -> 페르소나 라벨 (목록에서 찾고, 없으면 key 그대로)
  function personaLabel(key) {
    const found = personas.find(function (p) {
      return p.key === key;
    });
    return found ? found.label : key;
  }

  // 행운지수 점수대별 색상 (게이지/숫자)
  function luckColor(score) {
    if (score >= 70) return "#ffd54f"; // 높음: 금빛
    if (score >= 45) return "#ffa726"; // 중간: 주황
    return "#ef5350"; // 낮음: 붉은빛
  }

  // 오늘 날짜 YYYY.MM.DD
  function todayStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "." + mm + "." + dd;
  }

  // 페르소나 카드 렌더링
  function renderPersonas() {
    personasEl.innerHTML = "";
    personas.forEach(function (p) {
      const parts = p.label.split(" ");
      const emoji = parts.shift() || "";
      const name = parts.join(" ") || p.label;

      const card = document.createElement("div");
      card.className = "persona" + (p.key === selectedPersona ? " active" : "");
      card.dataset.key = p.key;
      card.innerHTML =
        '<span class="emoji">' +
        emoji +
        '</span><span class="name">' +
        name +
        "</span>";
      card.addEventListener("click", function () {
        if (loading) return;
        selectedPersona = p.key;
        renderPersonas();
      });
      personasEl.appendChild(card);
    });
  }

  // 서버에서 페르소나 목록 받아오기 (실패해도 폴백으로 동작)
  async function loadPersonas() {
    try {
      const res = await fetch("/api/personas");
      const json = await res.json();
      if (json && json.success && json.data && Array.isArray(json.data.personas)) {
        if (json.data.personas.length > 0) {
          personas = json.data.personas;
        }
        if (json.data.defaultPersona) {
          selectedPersona = json.data.defaultPersona;
        }
      }
    } catch (_) {
      /* 폴백 목록 사용 */
    }
    renderPersonas();
  }

  function setLoading(on) {
    loading = on;
    submitBtn.disabled = on;
    if (on) {
      const text = LOADING_TEXT[selectedPersona] || "해몽하는 중...";
      statusEl.innerHTML = '<span class="spinner"></span>' + text;
    } else {
      statusEl.textContent = "";
    }
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
  }

  function clearOutputs() {
    errorEl.classList.add("hidden");
    errorEl.textContent = "";
    resultEl.classList.add("hidden");
    shareNoteEl.classList.add("hidden");
    shareNoteEl.textContent = "";
  }

  // 작은 안내 메시지 (성공/실패 공용)
  function showNote(message) {
    shareNoteEl.textContent = message;
    shareNoteEl.classList.remove("hidden");
  }

  function showResult(data) {
    lastResult = data;

    // 상단: 페르소나 라벨
    scPersonaEl.textContent = personaLabel(data.persona);
    scDateEl.textContent = todayStr();

    // 행운지수 (0~100). 숫자 카운트업 + 게이지 채우기
    const score = Math.max(0, Math.min(100, Number(data.luckScore) || 0));
    const color = luckColor(score);
    luckRingEl.style.setProperty("--ring", color);
    luckScoreEl.style.color = color;
    animateLuck(score);

    // 1) 한줄요약
    summaryEl.textContent = data.summary;

    // 2) 상징 키워드 칩 (빈 배열이면 영역 자동 숨김 — CSS :empty)
    keywordsEl.innerHTML = "";
    if (Array.isArray(data.keywords)) {
      data.keywords.forEach(function (kw) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = kw;
        keywordsEl.appendChild(chip);
      });
    }

    // 3) 길몽/흉몽 배지
    badgeEl.textContent = data.verdict;
    badgeEl.className = "badge " + badgeClass(data.verdict);

    // 4) 오늘의 조언
    adviceEl.textContent = data.advice;

    resultEl.classList.remove("hidden");
  }

  // 행운지수 게이지/숫자 애니메이션 (약 0.7초 카운트업)
  function animateLuck(target) {
    const duration = 700;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const current = Math.round(target * eased);
      luckScoreEl.textContent = current;
      luckRingEl.style.setProperty("--score", current);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  async function interpret() {
    if (loading) return; // 중복 요청 방지

    const dream = dreamEl.value.trim();
    clearOutputs();

    if (!dream) {
      showError("꿈 내용을 입력해 주세요.");
      dreamEl.focus();
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dream: dream, persona: selectedPersona }),
      });

      let json = null;
      try {
        json = await res.json();
      } catch (_) {
        /* 비정상 응답 */
      }

      if (res.ok && json && json.success && json.data) {
        showResult(json.data);
      } else {
        const msg =
          (json && json.message) ||
          "해몽을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.";
        showError(msg);
      }
    } catch (_) {
      showError("서버에 연결하지 못했어요. 네트워크 상태를 확인하고 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  // ========================================
  // 공유 카드 → 이미지 저장 / 공유 / 텍스트 복사
  // ========================================

  // 공유 카드를 PNG canvas 로 렌더 (html2canvas)
  async function renderCardCanvas() {
    if (typeof window.html2canvas !== "function") {
      throw new Error("html2canvas-missing");
    }
    return window.html2canvas(shareCardEl, {
      backgroundColor: "#0d0622", // 카드 모서리 바깥 투명영역 채움
      scale: Math.min(2, window.devicePixelRatio || 1) * 1.5, // 선명하게
      useCORS: true,
      logging: false,
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        resolve(blob);
      }, "image/png");
    });
  }

  // canvas 를 파일로 다운로드 (폴백 공통)
  function downloadCanvas(canvas) {
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "해몽결과.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function saveOrShareImage() {
    if (!lastResult || saveImgBtn.disabled) return;
    shareNoteEl.classList.add("hidden");
    saveImgBtn.disabled = true;
    const originalText = saveImgBtn.textContent;
    saveImgBtn.textContent = "이미지 만드는 중...";

    try {
      const canvas = await renderCardCanvas();

      // 1) 모바일: Web Share API 로 파일 공유 시도
      try {
        const blob = await canvasToBlob(canvas);
        if (blob && navigator.canShare) {
          const file = new File([blob], "해몽결과.png", { type: "image/png" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({
              files: [file],
              title: "🔮 AI 해몽가 결과",
              text: "내 꿈 해몽 결과 어때?",
            });
            showNote("공유 완료! ✨");
            return;
          }
        }
      } catch (shareErr) {
        // 사용자가 공유를 취소한 경우엔 다운로드까지 강제하지 않음
        if (shareErr && shareErr.name === "AbortError") {
          return;
        }
        // 그 외 공유 실패 → 아래 다운로드로 폴백
      }

      // 2) 폴백: PNG 다운로드
      downloadCanvas(canvas);
      showNote("이미지를 저장했어요. 📥");
    } catch (err) {
      if (err && err.message === "html2canvas-missing") {
        showNote(
          "이미지 저장 기능을 불러오지 못했어요. 네트워크를 확인하거나, 화면을 직접 캡처해 주세요."
        );
      } else {
        showNote("이미지를 만들지 못했어요. 잠시 후 다시 시도하거나 화면을 캡처해 주세요.");
      }
    } finally {
      saveImgBtn.disabled = false;
      saveImgBtn.textContent = originalText;
    }
  }

  // 결과를 텍스트로 클립보드에 복사
  async function copyResultText() {
    if (!lastResult) return;
    const r = lastResult;
    const lines = [
      "🔮 AI 해몽가 (" + personaLabel(r.persona) + ")",
      "",
      "📝 " + r.summary,
    ];
    if (Array.isArray(r.keywords) && r.keywords.length) {
      lines.push(
        "🔖 " +
          r.keywords
            .map(function (k) {
              return "#" + k;
            })
            .join(" ")
      );
    }
    lines.push("🔮 판정: " + r.verdict);
    lines.push("🍀 행운지수: " + r.luckScore + "/100");
    lines.push("✨ 조언: " + r.advice);
    const text = lines.join("\n");

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // 구형 폴백
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showNote("결과를 복사했어요. 📋");
    } catch (_) {
      showNote("복사하지 못했어요. 결과를 길게 눌러 직접 복사해 주세요.");
    }
  }

  // 이벤트 바인딩
  submitBtn.addEventListener("click", interpret);
  saveImgBtn.addEventListener("click", saveOrShareImage);
  copyTxtBtn.addEventListener("click", copyResultText);

  // Ctrl/Cmd + Enter 로 제출
  dreamEl.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      interpret();
    }
  });

  // 초기화
  loadPersonas();
})();
