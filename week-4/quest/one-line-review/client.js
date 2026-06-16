// ========================================
// 📝 한줄 기대평 - 프론트엔드 로직 (client.js)
// 서버의 /api/reviews 와 통신하여 목록을 표시하고 새 글을 등록한다.
// ========================================

// 서버와 동일한 검증 기준 (UX 를 위해 클라이언트에서도 1차 검사)
const MAX_MESSAGE_LEN = 100;
const MAX_NICKNAME_LEN = 20;

// 자주 쓰는 DOM 요소 캐싱
const form = document.getElementById('reviewForm');
const nicknameEl = document.getElementById('nickname');
const messageEl = document.getElementById('message');
const counterEl = document.getElementById('counter');
const submitBtn = document.getElementById('submitBtn');
const formMsg = document.getElementById('formMsg');
const listEl = document.getElementById('reviewList');
const loadingEl = document.getElementById('loading');
const countBadge = document.getElementById('countBadge');

// ----------------------------------------
// ISO 시간 문자열 → "YYYY.MM.DD HH:mm" 보기 좋게 변환
// ----------------------------------------
function formatTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ----------------------------------------
// XSS 방지용 간단 이스케이프
// 사용자가 입력한 텍스트를 innerHTML 로 넣기 전에 특수문자를 치환한다.
// ----------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ----------------------------------------
// 폼 하단 메시지 표시 (error / ok)
// ----------------------------------------
function showMsg(text, type) {
  formMsg.textContent = text;
  formMsg.className = 'form-msg' + (type ? ' ' + type : '');
}

// ----------------------------------------
// 글자 수 카운터 갱신 (100자 초과 시 강조)
// ----------------------------------------
function updateCounter() {
  const len = messageEl.value.length;
  counterEl.textContent = `${len} / ${MAX_MESSAGE_LEN}`;
  counterEl.classList.toggle('over', len > MAX_MESSAGE_LEN);
}
messageEl.addEventListener('input', updateCounter);

// ----------------------------------------
// 목록 렌더링
// 서버가 이미 "최신순"으로 내려주므로 그대로 그린다.
// ----------------------------------------
function render(reviews) {
  countBadge.textContent = `${reviews.length}개`;

  if (reviews.length === 0) {
    listEl.innerHTML = '<div class="empty">아직 기대평이 없어요. 첫 번째 한마디를 남겨보세요! 🌟</div>';
    return;
  }

  listEl.innerHTML = reviews
    .map(
      (r) => `
      <li class="review">
        <div class="top">
          <span class="nick">🙂 ${escapeHtml(r.nickname)}</span>
          <span class="time">${formatTime(r.createdAt)}</span>
        </div>
        <div class="msg">${escapeHtml(r.message)}</div>
      </li>`
    )
    .join('');
}

// ----------------------------------------
// 목록 불러오기 (GET /api/reviews)
// ----------------------------------------
async function loadReviews() {
  try {
    const res = await fetch('/api/reviews');
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '불러오기 실패');
    render(json.data);
  } catch (err) {
    listEl.innerHTML = `<div class="empty">목록을 불러오지 못했어요 😢<br>${escapeHtml(err.message)}</div>`;
  } finally {
    loadingEl.style.display = 'none'; // 로딩 안내 숨김
  }
}

// ----------------------------------------
// 새 기대평 등록 (POST /api/reviews)
// ----------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const nickname = nicknameEl.value.trim();
  const message = messageEl.value.trim();

  // --- 클라이언트 1차 검증 ---
  if (message.length === 0) {
    showMsg('기대평 내용을 입력해 주세요. ✍️', 'error');
    messageEl.focus();
    return;
  }
  if (message.length > MAX_MESSAGE_LEN) {
    showMsg(`기대평은 최대 ${MAX_MESSAGE_LEN}자까지 가능해요.`, 'error');
    return;
  }
  if (nickname.length > MAX_NICKNAME_LEN) {
    showMsg(`닉네임은 최대 ${MAX_NICKNAME_LEN}자까지 가능해요.`, 'error');
    return;
  }

  // 중복 제출 방지
  submitBtn.disabled = true;
  showMsg('등록 중... ⏳', '');

  try {
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, message }),
    });
    const json = await res.json();

    if (!res.ok || !json.success) {
      // 서버 검증 실패 메시지를 그대로 보여준다
      throw new Error(json.message || '등록에 실패했어요.');
    }

    // 성공 → 입력 초기화 + 목록 새로고침
    form.reset();
    updateCounter();
    showMsg('등록 완료! 고마워요 💛', 'ok');
    await loadReviews();
  } catch (err) {
    showMsg(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// ----------------------------------------
// 페이지 로드 시 목록 불러오기
// ----------------------------------------
updateCounter();
loadReviews();
