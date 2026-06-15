// ========================================
// 🖼️ 사진붙여넣기 모음 - 프런트엔드
// - 클립보드 붙여넣기(paste) / 파일 선택 / 드래그&드롭으로 이미지 수집
// - 썸네일 그리드 미리보기 + 삭제 / 순서 변경(버튼·드래그)
// - 페이지당 1~3장 옵션에 맞춰 jsPDF로 단일 PDF 생성 & 다운로드
// 모든 처리는 브라우저 안에서 이루어지며 서버로 이미지를 보내지 않습니다.
// ========================================

(function () {
  'use strict';

  // ----- 상태: 모은 이미지 목록 -----
  // 각 항목: { id, dataUrl, width, height, name }
  let images = [];
  let nextId = 1;

  // ----- DOM 참조 -----
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const pickBtn = document.getElementById('pickBtn');
  const clearBtn = document.getElementById('clearBtn');
  const gallery = document.getElementById('gallery');
  const countBadge = document.getElementById('countBadge');
  const makePdfBtn = document.getElementById('makePdfBtn');
  const toastEl = document.getElementById('toast');

  // ========================================
  // 토스트 메시지
  // ========================================
  let toastTimer = null;
  function toast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = 'show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = '';
    }, 2600);
  }

  // ========================================
  // 선택된 "페이지당 이미지 수" 읽기 (1~3, 기본 1)
  // ========================================
  function getPerPage() {
    const checked = document.querySelector('input[name="perPage"]:checked');
    const n = checked ? parseInt(checked.value, 10) : 1;
    return n >= 1 && n <= 3 ? n : 1;
  }

  // ========================================
  // 이미지 파일(Blob/File) → dataURL + 크기 측정 후 목록에 추가
  // ========================================
  function addImageFromBlob(blob, name) {
    return new Promise((resolve) => {
      if (!blob || !blob.type || !blob.type.startsWith('image/')) {
        resolve(false);
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = function () {
          images.push({
            id: nextId++,
            dataUrl: dataUrl,
            width: img.naturalWidth || 1,
            height: img.naturalHeight || 1,
            name: name || '이미지',
          });
          render();
          resolve(true);
        };
        img.onerror = function () {
          resolve(false);
        };
        img.src = dataUrl;
      };
      reader.onerror = function () {
        resolve(false);
      };
      reader.readAsDataURL(blob);
    });
  }

  // 여러 파일을 순차 처리하고, 추가된 개수만큼 안내
  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    let added = 0;
    for (const f of files) {
      const ok = await addImageFromBlob(f, f.name);
      if (ok) added++;
    }
    if (added > 0) {
      toast(added + '장을 추가했어요.', 'ok');
    } else {
      toast('이미지 파일만 추가할 수 있어요.', 'err');
    }
  }

  // ========================================
  // 1) 클립보드 붙여넣기 (메인 기능)
  // paste 이벤트의 clipboardData.items 에서 image/* 타입을 골라낸다.
  // ========================================
  document.addEventListener('paste', async function (e) {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;

    const items = cd.items ? Array.from(cd.items) : [];
    const imageItems = items.filter(
      (it) => it.kind === 'file' && it.type && it.type.startsWith('image/')
    );

    if (imageItems.length === 0) {
      // 이미지가 아닌(텍스트 등) 붙여넣기는 무시 — 단, 사용자가 헷갈리지 않게 살짝 안내
      const hasText = items.some((it) => it.kind === 'string');
      if (hasText) {
        toast('이미지가 아니에요. 이미지를 복사한 뒤 붙여넣어 주세요.', 'err');
      }
      return;
    }

    e.preventDefault();
    let added = 0;
    for (const it of imageItems) {
      const blob = it.getAsFile();
      const ok = await addImageFromBlob(blob, '붙여넣은 이미지');
      if (ok) added++;
    }
    if (added > 0) {
      toast('📋 ' + added + '장을 붙여넣었어요.', 'ok');
    }
  });

  // ========================================
  // 2) 파일 선택 버튼
  // ========================================
  pickBtn.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', function () {
    addFiles(this.files);
    this.value = ''; // 같은 파일 재선택 가능하도록 초기화
  });

  // ========================================
  // 3) 드래그 & 드롭
  // ========================================
  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragover');
    })
  );
  ['dragleave', 'dragend'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dragover');
    })
  );
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) {
      addFiles(dt.files);
    }
  });
  // 페이지 전체에 파일을 떨궜을 때 브라우저가 그 파일을 열어버리는 것 방지
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ========================================
  // 전체 비우기
  // ========================================
  clearBtn.addEventListener('click', () => {
    if (images.length === 0) return;
    if (confirm('모은 이미지를 모두 삭제할까요?')) {
      images = [];
      render();
      toast('모두 비웠어요.');
    }
  });

  // ========================================
  // 목록 조작: 삭제 / 위·아래 이동
  // ========================================
  function removeImage(id) {
    images = images.filter((im) => im.id !== id);
    render();
  }
  function moveImage(id, dir) {
    const i = images.findIndex((im) => im.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= images.length) return;
    const tmp = images[i];
    images[i] = images[j];
    images[j] = tmp;
    render();
  }

  // ========================================
  // 드래그로 순서 변경 (썸네일끼리)
  // ========================================
  let dragId = null;
  function onThumbDragStart(e, id) {
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    // 일부 브라우저는 데이터가 없으면 드래그를 시작하지 않음
    try { e.dataTransfer.setData('text/plain', String(id)); } catch (_) {}
    e.currentTarget.classList.add('dragging');
  }
  function onThumbDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    dragId = null;
    document.querySelectorAll('.thumb.drop-target').forEach((el) =>
      el.classList.remove('drop-target')
    );
  }
  function onThumbDragOver(e, id) {
    if (dragId === null || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drop-target');
  }
  function onThumbDragLeave(e) {
    e.currentTarget.classList.remove('drop-target');
  }
  function onThumbDrop(e, targetId) {
    e.preventDefault();
    e.currentTarget.classList.remove('drop-target');
    if (dragId === null || dragId === targetId) return;
    const from = images.findIndex((im) => im.id === dragId);
    const to = images.findIndex((im) => im.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = images.splice(from, 1);
    images.splice(to, 0, moved);
    dragId = null;
    render();
  }

  // ========================================
  // 렌더링: 갤러리 + 카운트 + 버튼 활성화 상태
  // ========================================
  function render() {
    const n = images.length;
    countBadge.textContent = n + '장';
    makePdfBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;

    if (n === 0) {
      gallery.innerHTML =
        '<div class="empty"><div class="e-ic">🖼️</div>아직 추가된 이미지가 없어요.<br>위 영역에 <b>Ctrl+V</b>로 붙여넣어 시작하세요.</div>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'grid';

    images.forEach((im, i) => {
      const cell = document.createElement('div');
      cell.className = 'thumb';
      cell.setAttribute('draggable', 'true');
      cell.title = '드래그해서 순서를 바꿀 수 있어요';

      // 순서 번호
      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = i + 1;

      // 이미지
      const imgEl = document.createElement('img');
      imgEl.src = im.dataUrl;
      imgEl.alt = im.name;

      // 도구 버튼 (위/아래/삭제)
      const tools = document.createElement('div');
      tools.className = 'tools';

      const up = document.createElement('button');
      up.type = 'button';
      up.innerHTML = '↑';
      up.title = '앞으로';
      up.disabled = i === 0;
      up.addEventListener('click', (e) => { e.stopPropagation(); moveImage(im.id, -1); });

      const down = document.createElement('button');
      down.type = 'button';
      down.innerHTML = '↓';
      down.title = '뒤로';
      down.disabled = i === images.length - 1;
      down.addEventListener('click', (e) => { e.stopPropagation(); moveImage(im.id, 1); });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.innerHTML = '✕';
      del.title = '삭제';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeImage(im.id); });

      tools.append(up, down, del);

      // 크기 메타
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = im.width + '×' + im.height;

      cell.append(idx, imgEl, tools, meta);

      // 드래그 정렬 핸들러
      cell.addEventListener('dragstart', (e) => onThumbDragStart(e, im.id));
      cell.addEventListener('dragend', onThumbDragEnd);
      cell.addEventListener('dragover', (e) => onThumbDragOver(e, im.id));
      cell.addEventListener('dragleave', onThumbDragLeave);
      cell.addEventListener('drop', (e) => onThumbDrop(e, im.id));

      grid.appendChild(cell);
    });

    gallery.innerHTML = '';
    gallery.appendChild(grid);
  }

  // ========================================
  // PDF 생성 (jsPDF)
  // A4 세로(210 x 297mm). 페이지당 1~3장을 세로로 분할 배치하고,
  // 각 이미지는 비율을 유지하며 칸 안에 contain 으로 들어간다.
  // ========================================

  // dataURL 의 이미지 포맷을 jsPDF 가 받는 문자열로 변환 (PNG/JPEG/WEBP 등)
  function detectFormat(dataUrl) {
    const m = /^data:image\/([a-zA-Z0-9.+-]+);/.exec(dataUrl || '');
    let fmt = (m && m[1] ? m[1] : 'png').toUpperCase();
    if (fmt === 'JPG') fmt = 'JPEG';
    // jsPDF addImage 가 공식 지원하는 포맷으로 한정. 그 외(WEBP 등)는 PNG 로 재인코딩.
    return ['PNG', 'JPEG'].includes(fmt) ? fmt : null;
  }

  // 지원하지 않는 포맷(webp 등)이나 안전하게 통일하고 싶을 때 canvas 로 PNG 재인코딩
  function toPngDataUrl(im) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        canvas.width = im.width;
        canvas.height = im.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch (_) {
          resolve(im.dataUrl);
        }
      };
      img.onerror = () => resolve(im.dataUrl);
      img.src = im.dataUrl;
    });
  }

  // 칸(box) 안에 이미지(비율 iw:ih)를 contain 으로 맞춘 사각형 좌표 계산
  function fitContain(iw, ih, box) {
    const scale = Math.min(box.w / iw, box.h / ih);
    const w = iw * scale;
    const h = ih * scale;
    const x = box.x + (box.w - w) / 2;
    const y = box.y + (box.h - h) / 2;
    return { x, y, w, h };
  }

  async function makePdf() {
    if (images.length === 0) {
      toast('먼저 이미지를 추가해 주세요.', 'err');
      return;
    }
    // jsPDF UMD 로드 확인
    const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (typeof jsPDFCtor !== 'function') {
      toast('PDF 라이브러리를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.', 'err');
      return;
    }

    const perPage = getPerPage();

    // UX: 처리 중 버튼 잠금
    const originalLabel = makePdfBtn.textContent;
    makePdfBtn.disabled = true;
    makePdfBtn.textContent = '⏳ 만드는 중...';

    try {
      const doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();   // 210
      const pageH = doc.internal.pageSize.getHeight();  // 297
      const margin = 12;                                 // 바깥 여백(mm)
      const gap = 8;                                     // 칸 사이 간격(mm)

      const contentW = pageW - margin * 2;
      const contentH = pageH - margin * 2;
      // 세로로 perPage 등분 (칸 사이 gap 제외)
      const slotH = (contentH - gap * (perPage - 1)) / perPage;

      for (let i = 0; i < images.length; i++) {
        const slotInPage = i % perPage;
        if (i > 0 && slotInPage === 0) doc.addPage();

        const im = images[i];

        // 포맷 결정: PNG/JPEG 면 그대로, 아니면 PNG 로 재인코딩
        let fmt = detectFormat(im.dataUrl);
        let dataUrl = im.dataUrl;
        if (!fmt) {
          dataUrl = await toPngDataUrl(im);
          fmt = 'PNG';
        }

        // 이 이미지가 들어갈 칸
        const box = {
          x: margin,
          y: margin + slotInPage * (slotH + gap),
          w: contentW,
          h: slotH,
        };

        const r = fitContain(im.width, im.height, box);
        doc.addImage(dataUrl, fmt, r.x, r.y, r.w, r.h, undefined, 'FAST');
      }

      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace('T', '_')
        .replace(/:/g, '-');
      doc.save('사진모음_' + stamp + '.pdf');

      toast('✅ PDF를 만들었어요! (' + images.length + '장 / 페이지당 ' + perPage + '장)', 'ok');
    } catch (err) {
      console.error('PDF 생성 오류:', err);
      toast('PDF를 만드는 중 문제가 발생했어요. 다시 시도해 주세요.', 'err');
    } finally {
      makePdfBtn.textContent = originalLabel;
      makePdfBtn.disabled = images.length === 0;
    }
  }

  makePdfBtn.addEventListener('click', makePdf);

  // ----- 초기 렌더 -----
  render();
})();
