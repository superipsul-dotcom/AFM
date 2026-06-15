// ========================================
// 🪙 코인 트래커 - 프론트엔드 로직
// 서버(server.js)의 /api/prices, /api/search 와 통신
// ========================================

(function () {
  'use strict';

  // ---------- 설정 ----------
  var STORAGE_KEY = 'coinTracker.watchlist';
  var FAV_KEY = 'coinTracker.favorites';
  var DEFAULT_COINS = ['bitcoin', 'ethereum', 'solana', 'ripple', 'dogecoin'];
  var REFRESH_INTERVAL_MS = 30 * 1000; // 30초마다 자동 갱신
  var SEARCH_DEBOUNCE_MS = 350;
  // 기간 키 → 표시 라벨 (등락률 옆에 붙는다)
  var RANGE_LABEL = { day: '24시간', week: '7일', month: '30일' };

  // ---------- DOM ----------
  var searchInput = document.getElementById('searchInput');
  var addBtn = document.getElementById('addBtn');
  var refreshBtn = document.getElementById('refreshBtn');
  var suggestBox = document.getElementById('suggest');
  var lastUpdatedEl = document.getElementById('lastUpdated');
  var contentEl = document.getElementById('content');
  var errorBanner = document.getElementById('errorBanner');
  var rangeTabs = document.getElementById('rangeTabs');

  // ---------- 상태 ----------
  var watchlist = loadWatchlist(); // 코인 id 배열
  var favorites = loadFavorites(); // 즐겨찾기 코인 id 배열 (맨 위로 정렬)
  var currentRange = 'day'; // 추이 기간: 'day' | 'week' | 'month'
  var chartData = {}; // { id: [[t,p],...] } — 현재 기간의 스파크라인 데이터
  var chartsLoading = true; // 차트 로딩 중 여부 (시작 직후 fetchCharts 를 호출하므로 true)
  var lastCoins = []; // 마지막으로 받은 시세 데이터 (시세 재요청 없이 재렌더용)
  var lastPrices = {}; // { id: price } — 깜빡임 비교용
  var searchTimer = null;
  var refreshTimer = null;
  var isFetching = false;

  // ========================================
  // localStorage 관리
  // ========================================
  function loadWatchlist() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_COINS.slice();
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        // 중복 제거 + 빈값 제거
        var seen = {};
        var out = [];
        arr.forEach(function (id) {
          var k = String(id).trim().toLowerCase();
          if (k && !seen[k]) {
            seen[k] = true;
            out.push(k);
          }
        });
        return out;
      }
    } catch (e) {
      /* 무시하고 기본값 사용 */
    }
    return DEFAULT_COINS.slice();
  }

  function saveWatchlist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
    } catch (e) {
      /* 저장 실패는 치명적이지 않으므로 무시 */
    }
  }

  function loadFavorites() {
    try {
      var raw = localStorage.getItem(FAV_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.map(function (id) { return String(id).trim().toLowerCase(); }).filter(Boolean);
      }
    } catch (e) {
      /* 무시 */
    }
    return [];
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    } catch (e) {
      /* 무시 */
    }
  }

  function isFav(id) {
    return favorites.indexOf(id) !== -1;
  }

  // 즐겨찾기 토글 — 네트워크 호출 없이 즉시 재정렬/재렌더
  function toggleFav(id) {
    var idx = favorites.indexOf(id);
    if (idx === -1) favorites.push(id);
    else favorites.splice(idx, 1);
    saveFavorites();
    if (lastCoins.length) renderCards(lastCoins);
  }

  // ========================================
  // 유틸
  // ========================================
  function formatKRW(value) {
    if (value === null || value === undefined || isNaN(value)) return '₩ -';
    // 1원 미만 코인(예: 일부 밈코인)은 소수점 표기, 그 외는 정수 콤마
    var num;
    if (value < 1) {
      num = Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 6 });
    } else {
      num = Math.round(value).toLocaleString('ko-KR');
    }
    return '₩ ' + num;
  }

  function formatChange(change) {
    if (change === null || change === undefined || isNaN(change)) {
      return { text: '–', cls: 'flat', arrow: '' };
    }
    var fixed = Number(change).toFixed(2);
    if (change > 0) return { text: '+' + fixed + '%', cls: 'up', arrow: '▲' };
    if (change < 0) return { text: fixed + '%', cls: 'down', arrow: '▼' };
    return { text: '0.00%', cls: 'flat', arrow: '–' };
  }

  function nowTimeString() {
    var d = new Date();
    var p = function (n) {
      return n < 10 ? '0' + n : '' + n;
    };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function showError(msg) {
    errorBanner.textContent = '⚠️ ' + msg;
    errorBanner.classList.add('show');
  }
  function clearError() {
    errorBanner.classList.remove('show');
    errorBanner.textContent = '';
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 현재 선택된 기간에 맞는 등락률 값을 고른다
  function changeForRange(coin) {
    if (currentRange === 'week') return coin.change7d;
    if (currentRange === 'month') return coin.change30d;
    return coin.change24h;
  }

  // 가격 추이 스파크라인을 인라인 SVG 로 생성 (외부 차트 라이브러리 불필요)
  // points: [[timestamp, price], ...] / changeVal: 색상 방향 결정용(상승=초록, 하락=빨강)
  function sparklineHTML(points, changeVal) {
    if (!points || points.length < 2) {
      var msg = chartsLoading ? '추이 불러오는 중…' : '추이 데이터 없음';
      return '<div class="spark-empty">' + msg + '</div>';
    }

    var prices = points.map(function (pt) {
      return Array.isArray(pt) ? pt[1] : pt;
    });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var range = max - min || 1; // 0 division 방지(평평한 경우)
    var W = 100;
    var H = 32;
    var n = prices.length;

    var coords = prices
      .map(function (p, i) {
        var x = (i / (n - 1)) * W;
        var y = H - ((p - min) / range) * H;
        return x.toFixed(2) + ',' + y.toFixed(2);
      })
      .join(' ');

    // 색상 방향: 등락률이 있으면 그 부호로, 없으면 마지막 vs 첫 값으로 판단
    var up;
    if (typeof changeVal === 'number' && !isNaN(changeVal)) up = changeVal >= 0;
    else up = prices[n - 1] >= prices[0];
    var color = up ? 'var(--up)' : 'var(--down)';

    // currentColor 트릭으로 카드별 gradient id 충돌 없이 라인+면적 채우기
    // vector-effect 로 비균등 스케일에도 선 두께를 일정하게 유지
    return (
      '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
      'style="color:' + color + '" aria-hidden="true">' +
      '<polygon fill="currentColor" fill-opacity="0.13" points="0,' + H + ' ' + coords + ' ' + W + ',' + H + '" />' +
      '<polyline fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="' + coords + '" />' +
      '</svg>'
    );
  }

  // ========================================
  // 시세 가져오기 + 카드 렌더
  // ========================================
  function fetchPrices(isManual) {
    if (watchlist.length === 0) {
      renderEmpty();
      lastUpdatedEl.textContent = nowTimeString();
      return;
    }

    if (isFetching) return; // 중복 호출 방지
    isFetching = true;

    if (isManual) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '갱신 중…';
    }

    // 첫 로딩(카드가 아직 없을 때)만 풀스크린 로딩 표시
    if (!document.querySelector('.grid')) {
      renderLoading();
    }

    var url = '/api/prices?ids=' + encodeURIComponent(watchlist.join(','));

    fetch(url)
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.body || r.body.success !== true) {
          var msg =
            (r.body && r.body.message) ||
            '시세를 가져오지 못했어요. 잠시 후 다시 시도해 주세요.';
          showError(msg);
          // 기존 카드가 있으면 유지, 없으면 에러 상태 표시
          if (!document.querySelector('.grid')) {
            renderErrorState(msg);
          }
          return;
        }
        clearError();
        lastCoins = r.body.data || []; // 재렌더(즐겨찾기 토글/기간 전환/차트 도착)용으로 보관
        renderCards(lastCoins);
        lastUpdatedEl.textContent = nowTimeString();
      })
      .catch(function (err) {
        var msg = '서버에 연결하지 못했어요. 네트워크 상태를 확인해 주세요.';
        showError(msg);
        if (!document.querySelector('.grid')) {
          renderErrorState(msg);
        }
        // 콘솔에는 상세 로그
        if (window.console) console.error('fetchPrices 오류:', err);
      })
      .then(function () {
        isFetching = false;
        if (isManual) {
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ 새로고침';
        }
      });
  }

  function renderLoading() {
    contentEl.innerHTML =
      '<div class="state"><span class="spinner"></span><div style="margin-top:12px">시세를 불러오는 중…</div></div>';
  }

  function renderErrorState(msg) {
    contentEl.innerHTML =
      '<div class="state"><span class="emoji">📡</span>' +
      escapeHtml(msg) +
      '<div style="margin-top:14px"><button id="retryBtn" class="btn-refresh">다시 시도</button></div></div>';
    var retry = document.getElementById('retryBtn');
    if (retry) retry.addEventListener('click', function () { fetchPrices(true); });
  }

  function renderEmpty() {
    contentEl.innerHTML =
      '<div class="state"><span class="emoji">🪙</span>' +
      '추적 중인 코인이 없어요.<br />위 검색창에서 코인을 추가해 보세요!' +
      '<div style="margin-top:14px"><button id="restoreBtn" class="btn-add">기본 코인 추가</button></div></div>';
    var restore = document.getElementById('restoreBtn');
    if (restore) {
      restore.addEventListener('click', function () {
        watchlist = DEFAULT_COINS.slice();
        saveWatchlist();
        fetchPrices(true);
        fetchCharts();
      });
    }
  }

  function renderCards(coins) {
    if (!coins || coins.length === 0) {
      // 서버가 빈 배열을 줬을 때(잘못된 id 등)
      contentEl.innerHTML =
        '<div class="state"><span class="emoji">🤔</span>' +
        '시세 데이터를 찾지 못했어요.<br />코인 id 가 올바른지 확인해 주세요.</div>';
      return;
    }

    // CoinGecko 응답에 없는 id(잘못 추가된 코인) 정리: 응답에 온 id 만 watchlist 에 유지
    var returnedIds = {};
    coins.forEach(function (c) { returnedIds[c.id] = true; });

    var grid = document.querySelector('.grid');
    if (!grid) {
      contentEl.innerHTML = '<div class="grid"></div>';
      grid = document.querySelector('.grid');
    }

    // watchlist 순서대로 정렬해서 표시
    var byId = {};
    coins.forEach(function (c) { byId[c.id] = c; });
    var ordered = watchlist
      .map(function (id) { return byId[id]; })
      .filter(Boolean);
    // watchlist 에 없지만 응답에 있는 코인(혹시 모를 케이스)도 뒤에 붙임
    coins.forEach(function (c) {
      if (watchlist.indexOf(c.id) === -1) ordered.push(c);
    });

    // 즐겨찾기를 맨 앞으로 (각 그룹 내에서는 기존 watchlist 순서 유지)
    var favsFirst = ordered.filter(function (c) { return isFav(c.id); });
    var others = ordered.filter(function (c) { return !isFav(c.id); });
    ordered = favsFirst.concat(others);

    var html = ordered
      .map(function (coin) {
        var changeVal = changeForRange(coin); // 선택된 기간(일/주/월)의 등락률
        var ch = formatChange(changeVal);
        var prev = lastPrices[coin.id];
        var flashCls = '';
        if (typeof prev === 'number' && typeof coin.price === 'number' && prev !== coin.price) {
          flashCls = coin.price > prev ? ' flash-up' : ' flash-down';
        }
        var cardStateCls =
          ch.cls === 'up' ? ' up' : ch.cls === 'down' ? ' down' : '';
        var fav = isFav(coin.id);

        return (
          '<div class="card' + cardStateCls + (fav ? ' fav' : '') + flashCls + '" data-id="' + escapeHtml(coin.id) + '">' +
          '<button class="card-fav' + (fav ? ' on' : '') + '" data-fav="' + escapeHtml(coin.id) + '" title="' +
          (fav ? '즐겨찾기 해제' : '즐겨찾기') + '">' + (fav ? '★' : '☆') + '</button>' +
          '<button class="card-del" data-del="' + escapeHtml(coin.id) + '" title="삭제">✕</button>' +
          '<div class="card-head">' +
          (coin.image
            ? '<img src="' + escapeHtml(coin.image) + '" alt="" />'
            : '') +
          '<div>' +
          '<div class="card-name">' + escapeHtml(coin.name) + '</div>' +
          '<div class="card-symbol">' + escapeHtml(coin.symbol) + '</div>' +
          '</div>' +
          '</div>' +
          '<div class="card-price">' + formatKRW(coin.price) + '</div>' +
          '<span class="card-change ' + ch.cls + '">' +
          (ch.arrow ? '<span>' + ch.arrow + '</span>' : '') +
          '<span>' + ch.text + '</span>' +
          '</span>' +
          '<span class="change-period">/ ' + RANGE_LABEL[currentRange] + '</span>' +
          sparklineHTML(chartData[coin.id], changeVal) +
          '</div>'
        );
      })
      .join('');

    grid.innerHTML = html;

    // 현재 가격을 다음 비교용으로 저장
    coins.forEach(function (c) {
      if (typeof c.price === 'number') lastPrices[c.id] = c.price;
    });

    // 삭제 버튼 바인딩
    var delBtns = grid.querySelectorAll('[data-del]');
    Array.prototype.forEach.call(delBtns, function (btn) {
      btn.addEventListener('click', function () {
        removeCoin(btn.getAttribute('data-del'));
      });
    });

    // 즐겨찾기 버튼 바인딩
    var favBtns = grid.querySelectorAll('[data-fav]');
    Array.prototype.forEach.call(favBtns, function (btn) {
      btn.addEventListener('click', function () {
        toggleFav(btn.getAttribute('data-fav'));
      });
    });
  }

  // ========================================
  // 코인 추가 / 삭제
  // ========================================
  function addCoin(id) {
    var key = String(id).trim().toLowerCase();
    if (!key) return;
    if (watchlist.indexOf(key) !== -1) {
      // 중복 추가 방지
      showError('이미 추가된 코인이에요: ' + key);
      setTimeout(clearError, 2000);
      return;
    }
    watchlist.push(key);
    saveWatchlist();
    hideSuggest();
    searchInput.value = '';
    fetchPrices(true);
    fetchCharts(); // 새 코인의 추이 차트도 함께 로드
  }

  function removeCoin(id) {
    var idx = watchlist.indexOf(id);
    if (idx !== -1) {
      watchlist.splice(idx, 1);
      delete lastPrices[id];
      delete chartData[id];
      // 즐겨찾기에 있었으면 같이 제거
      var fidx = favorites.indexOf(id);
      if (fidx !== -1) {
        favorites.splice(fidx, 1);
        saveFavorites();
      }
      saveWatchlist();
      if (watchlist.length === 0) {
        renderEmpty();
        lastUpdatedEl.textContent = nowTimeString();
      } else {
        // 카드를 다시 그리기 위해 즉시 갱신
        fetchPrices(true);
      }
    }
  }

  // ========================================
  // 검색 (디바운스)
  // ========================================
  function onSearchInput() {
    var q = searchInput.value.trim();
    if (searchTimer) clearTimeout(searchTimer);

    if (!q) {
      hideSuggest();
      return;
    }

    showSuggestLoading();
    searchTimer = setTimeout(function () {
      runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
  }

  function runSearch(q) {
    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.body || r.body.success !== true) {
          renderSuggestMessage(
            (r.body && r.body.message) || '검색에 실패했어요.'
          );
          return;
        }
        renderSuggest(r.body.data || []);
      })
      .catch(function () {
        renderSuggestMessage('검색 중 서버 연결에 실패했어요.');
      });
  }

  function showSuggestLoading() {
    suggestBox.innerHTML = '<div class="suggest-loading">검색 중…</div>';
    suggestBox.classList.add('show');
  }

  function renderSuggestMessage(msg) {
    suggestBox.innerHTML = '<div class="suggest-empty">' + escapeHtml(msg) + '</div>';
    suggestBox.classList.add('show');
  }

  function renderSuggest(items) {
    if (!items || items.length === 0) {
      renderSuggestMessage('일치하는 코인이 없어요.');
      return;
    }

    var html = items
      .map(function (it) {
        var already = watchlist.indexOf(it.id) !== -1;
        var rank =
          it.market_cap_rank != null
            ? '<span class="s-rank">#' + escapeHtml(it.market_cap_rank) + '</span>'
            : '';
        return (
          '<div class="suggest-item' + (already ? ' added' : '') + '" data-add="' +
          escapeHtml(it.id) + '">' +
          (it.thumb ? '<img src="' + escapeHtml(it.thumb) + '" alt="" />' : '') +
          '<span class="s-name">' + escapeHtml(it.name) +
          '<span class="s-sym">' + escapeHtml(it.symbol) + '</span></span>' +
          (already ? '<span class="s-rank">추가됨</span>' : rank) +
          '</div>'
        );
      })
      .join('');

    suggestBox.innerHTML = html;
    suggestBox.classList.add('show');

    var items2 = suggestBox.querySelectorAll('[data-add]');
    Array.prototype.forEach.call(items2, function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-add');
        if (watchlist.indexOf(id) !== -1) return; // 이미 추가됨
        addCoin(id);
      });
    });
  }

  function hideSuggest() {
    suggestBox.classList.remove('show');
    suggestBox.innerHTML = '';
  }

  // 입력창의 텍스트를 그대로 id 로 추가 시도 (검색 없이 정확한 id 를 아는 경우)
  function addFromInput() {
    var q = searchInput.value.trim();
    if (!q) {
      searchInput.focus();
      return;
    }
    // 공백이 없으면 CoinGecko id 형태로 보고 바로 추가, 아니면 검색 실행
    if (/^[a-z0-9-]+$/i.test(q)) {
      addCoin(q.toLowerCase());
    } else {
      runSearch(q);
    }
  }

  // ========================================
  // 추이 차트 (스파크라인) — 30초 틱마다가 아니라
  // 로드 / 기간 전환 / 수동 새로고침 / 코인 추가 시에만 호출 (호출량 최소화)
  // ========================================
  function fetchCharts() {
    if (watchlist.length === 0) return;
    var rangeAtRequest = currentRange; // 응답 도착 시점에 기간이 바뀌었으면 버리기 위해 기록
    chartsLoading = true;

    fetch('/api/charts?ids=' + encodeURIComponent(watchlist.join(',')) + '&range=' + currentRange)
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (rangeAtRequest !== currentRange) return; // 사용자가 그새 기간을 바꿈 → 무시
        chartsLoading = false;
        // 차트는 부가 기능이라 실패해도 조용히 무시(시세 카드는 정상 동작)
        if (!r.ok || !r.body || r.body.success !== true) {
          if (lastCoins.length) renderCards(lastCoins); // "추이 데이터 없음" 문구로 갱신
          return;
        }
        chartData = r.body.data || {};
        if (lastCoins.length) renderCards(lastCoins);
      })
      .catch(function () {
        if (rangeAtRequest !== currentRange) return;
        chartsLoading = false;
        if (lastCoins.length) renderCards(lastCoins);
      });
  }

  // 기간(일/주/월) 전환
  function setRange(range) {
    if (!RANGE_LABEL[range] || range === currentRange) return;
    currentRange = range;
    chartData = {}; // 이전 기간 차트는 버림 → 새 데이터 도착 전까지 "불러오는 중" 표시
    chartsLoading = true; // 즉시 재렌더 시 "불러오는 중" 문구가 보이도록
    updateRangeTabs();
    // 등락률 %·색상은 이미 받아둔 데이터로 즉시 전환, 스파크라인만 새로 로드
    if (lastCoins.length) renderCards(lastCoins);
    fetchCharts();
  }

  function updateRangeTabs() {
    if (!rangeTabs) return;
    var tabs = rangeTabs.querySelectorAll('[data-range]');
    Array.prototype.forEach.call(tabs, function (t) {
      if (t.getAttribute('data-range') === currentRange) t.classList.add('active');
      else t.classList.remove('active');
    });
  }

  // ========================================
  // 자동 갱신 타이머
  // ========================================
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function () {
      fetchPrices(false);
    }, REFRESH_INTERVAL_MS);
  }

  // ========================================
  // 이벤트 바인딩
  // ========================================
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromInput();
    }
  });
  addBtn.addEventListener('click', addFromInput);
  refreshBtn.addEventListener('click', function () {
    fetchPrices(true);
    fetchCharts();
  });

  // 기간(일/주/월) 탭 클릭
  if (rangeTabs) {
    rangeTabs.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-range]') : null;
      if (btn) setRange(btn.getAttribute('data-range'));
    });
  }

  // 바깥 클릭 시 드롭다운 닫기
  document.addEventListener('click', function (e) {
    if (!suggestBox.contains(e.target) && e.target !== searchInput) {
      hideSuggest();
    }
  });

  // ========================================
  // 시작
  // ========================================
  updateRangeTabs();
  fetchPrices(false);
  fetchCharts();
  startAutoRefresh();
})();
