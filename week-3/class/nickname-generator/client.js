// ========================================
// AI 별명 생성기 - 프론트엔드 로직 (순수 바닐라 JS)
// 서버 엔드포인트:
//   GET  /api/styles    -> { success, data: { styles: [{key,label}], defaultStyle } }
//   POST /api/nickname  -> body { name, personality, hobby, style }
//                          { success, data: { nicknames: [{name, reason}], style } }
//   POST /api/character -> body { nickname, reason, personality, hobby }
//                          { success, data: { image: "data:image/png;base64,..." } }
// ========================================

(function () {
  'use strict';

  // ---- DOM 참조 ----
  const form = document.getElementById('nickname-form');
  const nameInput = document.getElementById('name');
  const personalityInput = document.getElementById('personality');
  const hobbyInput = document.getElementById('hobby');
  const styleOptions = document.getElementById('style-options');
  const submitBtn = document.getElementById('submit-btn');
  const submitSpinner = document.getElementById('submit-spinner');
  const submitLabel = document.getElementById('submit-label');
  const formError = document.getElementById('form-error');
  const resultSection = document.getElementById('result-section');

  // 현재 선택된 스타일 key (기본값은 /api/styles 로 채워짐)
  let selectedStyle = null;

  // 마지막으로 별명을 생성할 때 쓴 입력 (캐릭터 이미지 생성에 함께 사용)
  let lastInput = { name: '', personality: '', hobby: '' };

  // ---- 유틸: 폼 에러 표시/숨김 ----
  function showError(msg) {
    formError.textContent = msg;
    formError.classList.remove('hidden');
  }
  function clearError() {
    formError.textContent = '';
    formError.classList.add('hidden');
  }

  // ---- 유틸: 로딩 상태 토글 ----
  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    if (isLoading) {
      submitSpinner.classList.remove('hidden');
      submitLabel.textContent = '별명 짓는 중…';
    } else {
      submitSpinner.classList.add('hidden');
      submitLabel.textContent = '✨ 별명 생성하기';
    }
  }

  // ---- 스타일 버튼 렌더링 ----
  function renderStyleButtons(styles, defaultStyle) {
    styleOptions.innerHTML = '';
    selectedStyle = defaultStyle || (styles[0] && styles[0].key) || null;

    styles.forEach(function (s) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.styleKey = s.key;
      btn.textContent = s.label;
      btn.className = styleButtonClass(s.key === selectedStyle);
      btn.addEventListener('click', function () {
        selectedStyle = s.key;
        // 모든 버튼 클래스 갱신
        Array.prototype.forEach.call(styleOptions.children, function (child) {
          child.className = styleButtonClass(child.dataset.styleKey === selectedStyle);
        });
      });
      styleOptions.appendChild(btn);
    });
  }

  // 스타일 버튼 클래스 (선택 여부에 따라 색상 변경)
  function styleButtonClass(active) {
    const base =
      'rounded-full px-3.5 py-1.5 text-xs font-semibold border transition select-none ';
    return active
      ? base + 'bg-purple-500 text-white border-purple-500 shadow-sm'
      : base + 'bg-white text-slate-600 border-slate-200 hover:border-purple-300 hover:text-purple-600';
  }

  // ---- 스타일 목록 불러오기 ----
  function loadStyles() {
    fetch('/api/styles')
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json && json.success && json.data && Array.isArray(json.data.styles)) {
          renderStyleButtons(json.data.styles, json.data.defaultStyle);
        } else {
          styleOptions.innerHTML =
            '<span class="text-xs text-red-400">스타일 목록을 불러오지 못했어요.</span>';
        }
      })
      .catch(function () {
        styleOptions.innerHTML =
          '<span class="text-xs text-red-400">스타일 목록을 불러오지 못했어요. (서버 연결 확인)</span>';
      });
  }

  // ---- HTML 이스케이프 (XSS 방지: AI 응답을 텍스트로 안전 출력) ----
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- 클립보드 복사 (navigator.clipboard + execCommand 폴백) ----
  function copyToClipboard(text) {
    // 1순위: 최신 Clipboard API (https 또는 localhost 환경)
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // 폴백: 임시 textarea + execCommand (file:// 직접 열기 등 대비)
    return new Promise(function (resolve, reject) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy 실패'));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---- 복사 버튼 클릭 핸들러 (피드백 포함) ----
  function handleCopyClick(btn, text) {
    copyToClipboard(text)
      .then(function () {
        const original = btn.dataset.originalLabel || btn.textContent;
        btn.dataset.originalLabel = original;
        btn.textContent = '복사됨! ✓';
        btn.classList.add('bg-green-500', 'text-white', 'border-green-500');
        btn.classList.remove('bg-white', 'text-purple-600', 'border-purple-200');
        setTimeout(function () {
          btn.textContent = original;
          btn.classList.remove('bg-green-500', 'text-white', 'border-green-500');
          btn.classList.add('bg-white', 'text-purple-600', 'border-purple-200');
        }, 1400);
      })
      .catch(function () {
        const original = btn.dataset.originalLabel || btn.textContent;
        btn.dataset.originalLabel = original;
        btn.textContent = '복사 실패 😢';
        setTimeout(function () {
          btn.textContent = original;
        }, 1400);
      });
  }

  // ---- 다운로드 파일명 안전화 ----
  function safeFileName(name) {
    const cleaned = String(name).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
    return (cleaned || 'character') + '.png';
  }

  // ---- 캐릭터 이미지 생성 버튼 클릭 핸들러 ----
  function handleCharacterClick(btn, charArea, nick) {
    btn.disabled = true;
    btn.textContent = '그리는 중…';

    // 로딩 표시
    charArea.classList.remove('hidden');
    charArea.innerHTML =
      '<div class="flex items-center gap-2 text-xs text-slate-500 py-3">' +
      '<span class="spinner h-4 w-4 rounded-full border-2 border-pink-200 border-t-pink-500"></span>' +
      "<span>✏️ '" +
      escapeHtml(nick.name) +
      "' 캐릭터를 그리는 중… (20~30초 걸려요)</span>" +
      '</div>';

    fetch('/api/character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname: nick.name,
        reason: nick.reason || '',
        personality: lastInput.personality,
        hobby: lastInput.hobby,
      }),
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, json: json };
        });
      })
      .then(function (result) {
        const json = result.json;
        if (result.ok && json && json.success && json.data && json.data.image) {
          renderCharacterImage(charArea, json.data.image, nick.name);
        } else {
          const msg = (json && json.message) || '캐릭터 이미지를 만들지 못했어요.';
          charArea.innerHTML = '<p class="text-xs text-red-500 py-2">' + escapeHtml(msg) + '</p>';
        }
      })
      .catch(function () {
        charArea.innerHTML =
          '<p class="text-xs text-red-500 py-2">서버에 연결하지 못했어요. 서버가 실행 중인지 확인해 주세요.</p>';
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = '🎨 다시 그리기';
      });
  }

  // ---- 생성된 캐릭터 이미지 + 다운로드 버튼 렌더 ----
  function renderCharacterImage(charArea, dataUrl, nickname) {
    charArea.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'mt-1 flex flex-col items-center gap-2';

    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = nickname + ' 캐릭터';
    img.className =
      'card-enter w-full max-w-xs rounded-2xl border border-purple-100 bg-white shadow-md shadow-purple-100/60';

    const dl = document.createElement('a');
    dl.href = dataUrl;
    dl.download = safeFileName(nickname);
    dl.textContent = '💾 이미지 저장';
    dl.className =
      'inline-flex items-center rounded-lg border border-purple-200 bg-white px-3 py-1.5 text-xs font-semibold text-purple-600 transition hover:bg-purple-50 active:scale-95';

    wrap.appendChild(img);
    wrap.appendChild(dl);
    charArea.appendChild(wrap);
  }

  // ---- 결과 카드 렌더링 ----
  function renderResults(nicknames) {
    resultSection.innerHTML = '';

    // 결과 헤더
    const heading = document.createElement('h2');
    heading.className = 'text-lg font-bold text-slate-700 px-1';
    heading.textContent = '🎉 추천 별명 ' + nicknames.length + '개';
    resultSection.appendChild(heading);

    nicknames.forEach(function (nick, idx) {
      const card = document.createElement('div');
      card.className =
        'card-enter bg-white/85 backdrop-blur rounded-2xl shadow-md shadow-purple-100/60 p-4 flex flex-col gap-3';
      card.style.animationDelay = idx * 60 + 'ms';

      // 상단 행: (별명 + 이유) + 버튼 그룹
      const topRow = document.createElement('div');
      topRow.className = 'flex items-start justify-between gap-3';

      // 왼쪽: 별명 + 이유
      const textWrap = document.createElement('div');
      textWrap.className = 'min-w-0 flex-1';
      const reasonHtml = nick.reason
        ? '<p class="mt-0.5 text-sm text-slate-500 break-words">' + escapeHtml(nick.reason) + '</p>'
        : '';
      textWrap.innerHTML =
        '<p class="text-base font-bold text-purple-700 break-words">' +
        escapeHtml(nick.name) +
        '</p>' +
        reasonHtml;

      // 오른쪽: 버튼 그룹 (복사 + 캐릭터)
      const btnGroup = document.createElement('div');
      btnGroup.className = 'shrink-0 flex flex-col gap-1.5';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = '복사';
      copyBtn.className =
        'rounded-lg border border-purple-200 bg-white px-3 py-1.5 text-xs font-semibold text-purple-600 transition hover:bg-purple-50 active:scale-95';
      copyBtn.addEventListener('click', function () {
        handleCopyClick(copyBtn, nick.name);
      });

      const charBtn = document.createElement('button');
      charBtn.type = 'button';
      charBtn.textContent = '🎨 캐릭터';
      charBtn.className =
        'rounded-lg border border-pink-200 bg-white px-3 py-1.5 text-xs font-semibold text-pink-600 transition hover:bg-pink-50 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed';

      // 캐릭터 이미지가 들어갈 영역 (생성 전엔 숨김)
      const charArea = document.createElement('div');
      charArea.className = 'hidden';

      charBtn.addEventListener('click', function () {
        handleCharacterClick(charBtn, charArea, nick);
      });

      btnGroup.appendChild(copyBtn);
      btnGroup.appendChild(charBtn);
      topRow.appendChild(textWrap);
      topRow.appendChild(btnGroup);

      card.appendChild(topRow);
      card.appendChild(charArea);
      resultSection.appendChild(card);
    });

    // 결과로 부드럽게 스크롤
    heading.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- 폼 제출 핸들러 ----
  function handleSubmit(e) {
    e.preventDefault();
    clearError();

    const name = nameInput.value.trim();
    const personality = personalityInput.value.trim();
    const hobby = hobbyInput.value.trim();

    // 클라이언트 측 1차 검증
    if (!name || !personality || !hobby) {
      showError('이름, 성격, 취미를 모두 입력해 주세요.');
      return;
    }

    // 캐릭터 이미지 생성 때 함께 쓰도록 이번 입력을 보관
    lastInput = { name: name, personality: personality, hobby: hobby };

    setLoading(true);

    fetch('/api/nickname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        personality: personality,
        hobby: hobby,
        style: selectedStyle,
      }),
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, json: json };
        });
      })
      .then(function (result) {
        const json = result.json;
        if (result.ok && json && json.success && json.data && Array.isArray(json.data.nicknames)) {
          renderResults(json.data.nicknames);
        } else {
          const msg = (json && json.message) || '별명을 생성하지 못했어요. 잠시 후 다시 시도해 주세요.';
          showError(msg);
        }
      })
      .catch(function () {
        showError('서버에 연결하지 못했어요. 서버가 실행 중인지 확인해 주세요.');
      })
      .finally(function () {
        setLoading(false);
      });
  }

  // ---- 초기화 ----
  form.addEventListener('submit', handleSubmit);
  loadStyles();
})();
