'use strict';

(() => {
  const API_PRINTS = '/api/prints';
  const API_EVENTS = '/api/events';
  const API_CLEAR = '/api/clear';
  const API_CONFIG = '/api/config';
  const PREFS_KEY = 'liuhen.prefs.v1';
  const UNLOCK_KEY = 'liuhen.unlock.v1';
  const VIEW_KEY = 'liuhen.view.v1';
  const SECRET_NAME = 'lantz';
  const MEMORIAL_CODE = '2411';

  const VIEWS = {
    classic: {
      title: '谁来过 · 一面脚印墙',
      description: '一面留给路过者的墙。写下名字，在墙上按下一枚爪印。',
      theme: '#d8c9b2',
      mark: '留痕录',
      label: 'pageTitle',
      wallWord: '脚印墙'
    },
    '2411': {
      title: '罗文学校2411纪念墙',
      description: '罗文学校2411纪念墙：白墙、蓝天与爪印，留给每一位来过的人。',
      theme: '#eaf7ff',
      mark: '2411',
      label: 'pageTitle2411',
      wallWord: '纪念墙'
    }
  };

  const STYLES = {
    cat:  { label: '猫爪', symbol: '#paw-cat' },
    dog:  { label: '狗爪', symbol: '#paw-dog' },
    bear: { label: '熊爪', symbol: '#paw-bear' },
    rainbow: { label: '五彩', symbol: '#paw-cat-rainbow' }
  };

  const INKS = {
    soot:     { label: '松烟', hex: '#302a24' },
    cinnabar: { label: '朱砂', hex: '#b0442f' },
    indigo:   { label: '靛青', hex: '#405d72' },
    moss:     { label: '苔绿', hex: '#596a45' },
    ochre:    { label: '赭石', hex: '#9f6b35' }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const pad2 = (value) => String(value).padStart(2, '0');

  const wall = $('#wall');
  const printsLayer = $('#prints');
  const emptyState = $('#empty');
  const emptyTitle = $('#emptyTitle');
  const emptySub = $('#emptySub');
  const form = $('#stampForm');
  const nameInput = $('#visitorName');
  const stampBtn = $('#stampBtn');
  const stampLabel = $('#stampLabel');
  const stampBtnPaw = $('#stampBtnPaw');
  const soundBtn = $('#soundBtn');
  const ghost = $('#ghost');
  const ghostUse = $('#ghostUse');
  const countNum = $('#countNum');
  const liveStatus = $('#liveStatus');
  const liveText = $('#liveText');
  const announcer = $('#announcer');
  const toast = $('#toast');
  const toastText = $('#toastText');
  const pawButtons = $$('.paw-option');
  const rainbowBtn = $('.paw-option[data-style="rainbow"]');
  const inkOptions = $('.ink-options');
  const inkChoices = $$('.ink-choice');
  const inkInputs = $$('input[name="ink"]');
  const intro = $('#intro');
  const backBtn = $('#backBtn');
  const viewPanels = $$('[data-view-panel]');
  const metaThemeColor = $('#metaThemeColor');
  const metaDescription = $('#metaDescription');
  const sceneVeil = $('#sceneVeil');
  const sceneMark = $('#sceneMark');
  const clearBtn = $('#clearBtn');
  const clearModal = $('#clearModal');
  const clearForm = $('#clearForm');
  const clearPassword = $('#clearPassword');
  const clearConfirm = $('#clearConfirm');
  const clearError = $('#clearError');
  const clearPanel = $('.modal__panel', clearModal);
  const bgm = $('#bgm');
  const musicToggle = $('#musicToggle');
  const musicState = $('#musicState');

  let prints = [];
  let selectedStyle = 'cat';
  let selectedInk = 'soot';
  let soundOn = true;
  let rainbowUnlocked = false;
  let wallReady = false;
  let loading = true;
  let submitting = false;
  let retryMode = false;
  let refreshPromise = null;
  let eventSource = null;
  let sseOpened = false;
  let liveState = 'connecting';
  let mutationVersion = 0;
  let toastTimer = 0;
  let audioCtx = null;
  let noiseBuffer = null;
  let currentView = 'classic';
  let viewSwitching = false;
  let viewSwapTimer = 0;
  let clearOpen = false;
  let clearingWall = false;
  let clearInFlight = false;
  let clearAnimating = false;
  let modalLastFocus = null;
  let musicPausedByUser = false;
  let musicDesired = false;
  let musicRequest = 0;
  let musicFadeFrame = 0;
  let liveMode = true;
  let pollMs = 30000;
  let pollTimer = 0;

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cleanName(raw) {
    const value = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return Array.from(value).slice(0, 12).join('') || '无名氏';
  }

  function numeric(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizePrint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const timestamp = Number(raw.t);
    const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
    if (!id || !Number.isFinite(timestamp)) return null;
    return {
      id,
      n: cleanName(raw.n),
      s: STYLES[raw.s] ? raw.s : 'cat',
      c: INKS[raw.c] ? raw.c : 'soot',
      x: clamp(numeric(raw.x, 50), 8, 92),
      y: clamp(numeric(raw.y, 50), 16, 80),
      z: Math.round(clamp(numeric(raw.z, 68), 56, 82)),
      r: clamp(numeric(raw.r, 0), -11, 11),
      t: timestamp
    };
  }

  function normalizeList(list) {
    const seen = new Set();
    return list
      .map(normalizePrint)
      .filter((print) => {
        if (!print || seen.has(print.id)) return false;
        seen.add(print.id);
        return true;
      })
      .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  }

  function fullTime(timestamp) {
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (error) {
      return new Date(timestamp).toLocaleString();
    }
  }

  function shortTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    if (sameDay) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}.${pad2(date.getDate())}`;
    }
    return `${date.getFullYear()}.${date.getMonth() + 1}`;
  }

  function makeSpecks(id) {
    const fragment = document.createDocumentFragment();
    const random = seededRandom(hashString(id));
    for (let i = 0; i < 3; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 47 + random() * 12;
      const speck = document.createElement('span');
      speck.className = 'print__speck';
      speck.style.left = `${50 + Math.cos(angle) * radius}%`;
      speck.style.top = `${50 + Math.sin(angle) * radius}%`;
      speck.style.width = `${1.4 + random() * 2.2}px`;
      speck.style.height = speck.style.width;
      fragment.appendChild(speck);
    }
    return fragment;
  }

  function makePrint(print, isNew = false) {
    const element = document.createElement('div');
    element.className = 'print'
      + (print.x < 30 ? ' is-left-edge' : '')
      + (print.x > 70 ? ' is-right-edge' : '')
      + (isNew ? ' is-new' : '');
    element.dataset.id = print.id;
    element.style.setProperty('--x', `${print.x}%`);
    element.style.setProperty('--y', `${print.y}%`);
    element.style.setProperty('--sz', print.z);
    element.style.setProperty('--rot', `${print.r}deg`);
    element.style.color = INKS[print.c].hex;
    element.setAttribute('aria-label', `${print.n}，${fullTime(print.t)}来过`);

    const specks = document.createElement('div');
    specks.className = 'print__specks';
    specks.setAttribute('aria-hidden', 'true');
    specks.appendChild(makeSpecks(print.id));

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('print__paw');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', STYLES[print.s].symbol);
    svg.appendChild(use);

    const tag = document.createElement('div');
    tag.className = 'print__tag';
    const name = document.createElement('span');
    name.className = 'print__name';
    name.textContent = print.n;
    const time = document.createElement('time');
    time.className = 'print__time';
    time.dateTime = new Date(print.t).toISOString();
    time.textContent = shortTime(print.t);
    tag.append(name, time);

    element.append(specks, svg, tag);
    return element;
  }

  function addPrintLocal(print, animate = true) {
    if (!print || prints.some((item) => item.id === print.id)) return false;
    prints.push(print);
    prints.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    printsLayer.appendChild(makePrint(print, animate));
    mutationVersion += 1;
    return true;
  }

  function removePrints(ids) {
    const idSet = new Set(ids.map((id) => String(id)));
    if (idSet.size === 0) return false;
    const before = prints.length;
    prints = prints.filter((print) => !idSet.has(print.id));
    $$('.print', printsLayer).forEach((element) => {
      if (idSet.has(element.dataset.id)) element.remove();
    });
    if (prints.length !== before) mutationVersion += 1;
    return prints.length !== before;
  }

  function renderAll() {
    const fragment = document.createDocumentFragment();
    prints.forEach((print) => fragment.appendChild(makePrint(print)));
    printsLayer.replaceChildren(fragment);
  }

  function setLive(state) {
    if (liveState === state) return;
    liveState = state;
    liveStatus.classList.remove('live--connecting', 'live--online', 'live--offline', 'live--polling');
    liveStatus.classList.add(`live--${state}`);
    const labels = {
      online: '已连接',
      offline: '连接断开',
      connecting: '连墙中',
      polling: '自动同步'
    };
    const label = labels[state] || '连墙中';
    liveText.textContent = label;
    liveStatus.setAttribute('aria-label', `墙面同步状态：${label}`);
  }

  function updateStampButton() {
    let label = '按个爪印';
    let disabled = false;

    if (loading) {
      label = retryMode ? '正在重连…' : '正在连墙…';
      disabled = true;
    } else if (!wallReady) {
      label = '重新连墙';
      disabled = false;
    } else if (submitting) {
      label = '正在按…';
      disabled = true;
    }

    stampBtn.disabled = disabled;
    stampLabel.textContent = label;
    stampBtn.setAttribute('aria-busy', String(loading || submitting));
  }

  function updateWallState() {
    const wallWord = (VIEWS[currentView] || VIEWS.classic).wallWord;
    wall.classList.toggle('is-ready', wallReady);
    wall.classList.toggle('is-loading', loading);
    wall.classList.toggle('is-submitting', submitting);
    wall.setAttribute('aria-busy', String(loading));
    wall.setAttribute('aria-disabled', String(!wallReady || loading || submitting));

    if (loading) {
      wall.setAttribute('aria-label', `${wallWord}正在载入，请稍候。`);
    } else if (!wallReady) {
      wall.setAttribute('aria-label', `${wallWord}暂时没有连上，请用下方的按钮重新连接。`);
    } else if (submitting) {
      wall.setAttribute('aria-label', '正在把这枚爪印按到墙上，请稍候。');
    } else {
      wall.setAttribute(
        'aria-label',
        prints.length === 0
          ? `${wallWord}，还没有爪印。点击任意位置或按回车留下一枚爪印。`
          : `${wallWord}，当前有 ${prints.length} 枚爪印。点击任意位置或按回车再留一枚。`
      );
    }

    if (!wallReady || submitting) wall.classList.remove('is-hovering');
  }

  function renderEmptyState() {
    if (loading) {
      emptyTitle.textContent = '正在看看谁来过…';
      emptySub.textContent = '正在同步墙上的爪印';
    } else if (!wallReady) {
      emptyTitle.textContent = '墙暂时没有回应';
      emptySub.textContent = '检查网络后，按下面的按钮重连';
    } else {
      emptyTitle.textContent = '墙上还没有人来过';
      emptySub.textContent = '第一枚爪印，等你来按';
    }
  }

  function syncUI({ bump = false } = {}) {
    countNum.textContent = pad2(prints.length);
    wall.classList.toggle('has-prints', prints.length > 0);
    if (bump) {
      countNum.classList.remove('is-bumping');
      void countNum.offsetWidth;
      countNum.classList.add('is-bumping');
    }
    updateWallState();
    renderEmptyState();
    updateStampButton();
  }

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // 没解锁过就不认 rainbow，避免旧记录把界面顶到一个不存在的爪型上。
      if (parsed && STYLES[parsed.style] && (parsed.style !== 'rainbow' || rainbowUnlocked)) {
        selectedStyle = parsed.style;
      }
      if (parsed && INKS[parsed.ink]) selectedInk = parsed.ink;
      if (parsed && typeof parsed.sound === 'boolean') soundOn = parsed.sound;
    } catch (error) {
      /* Preferences are optional. */
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        style: selectedStyle,
        ink: selectedInk,
        sound: soundOn
      }));
    } catch (error) {
      /* Private mode may reject storage. */
    }
  }

  /* ---------------- 隐藏爪型 ---------------- */

  function revealRainbowButton({ animate = true } = {}) {
    if (!rainbowBtn) return;
    rainbowBtn.hidden = false;
    if (!animate) return;
    rainbowBtn.classList.remove('is-revealing');
    void rainbowBtn.offsetWidth;
    rainbowBtn.classList.add('is-revealing');
  }

  function loadUnlock() {
    try {
      rainbowUnlocked = window.localStorage.getItem(UNLOCK_KEY) === '1';
    } catch (error) {
      rainbowUnlocked = false;
    }
    if (rainbowUnlocked) revealRainbowButton({ animate: false });
  }

  function unlockRainbow() {
    if (rainbowUnlocked) return false;
    rainbowUnlocked = true;
    try {
      window.localStorage.setItem(UNLOCK_KEY, '1');
    } catch (error) {
      /* 存不下就只在这次会话里生效 */
    }
    revealRainbowButton();
    announcer.textContent = '解锁了隐藏爪型：五彩猫爪。';
    showToast('解锁隐藏爪型：五彩猫爪', 5200);
    return true;
  }

  function checkSecretCode() {
    if (rainbowUnlocked) return;
    if (nameInput.value.trim().toLowerCase() !== SECRET_NAME) return;
    if (unlockRainbow()) setStyle('rainbow');
  }

  /* ---------------- 名字必填 ---------------- */

  function readName() {
    return String(nameInput.value == null ? '' : nameInput.value).trim();
  }

  function flagMissingName() {
    nameInput.classList.remove('is-invalid');
    void nameInput.offsetWidth;
    nameInput.classList.add('is-invalid');
    nameInput.setAttribute('aria-invalid', 'true');
    nameInput.focus();
    showToast('先写下你的名字，再按爪印。');
    announcer.textContent = '还没有名字。写下名字之后才能在这里留下爪印。';
  }

  function clearNameFlag() {
    nameInput.classList.remove('is-invalid');
    nameInput.removeAttribute('aria-invalid');
  }

  function setStyle(style, { persist = true } = {}) {
    if (!STYLES[style]) return;
    if (style === 'rainbow' && !rainbowUnlocked) return;
    selectedStyle = style;
    pawButtons.forEach((button) => {
      const active = button.dataset.style === style;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    stampBtnPaw.setAttribute('href', STYLES[style].symbol);
    ghostUse.setAttribute('href', STYLES[style].symbol);
    if (inkOptions) inkOptions.classList.toggle('is-muted', style === 'rainbow');
    if (persist) savePrefs();
  }

  function setInk(ink, { persist = true } = {}) {
    if (!INKS[ink]) return;
    selectedInk = ink;
    inkInputs.forEach((input) => {
      input.checked = input.value === ink;
    });
    inkChoices.forEach((choice) => {
      const input = $('input', choice);
      choice.classList.toggle('is-active', Boolean(input && input.checked));
    });
    stampBtn.style.setProperty('--stamp-ink', INKS[ink].hex);
    ghost.style.color = INKS[ink].hex;
    if (persist) savePrefs();
  }

  function updateSoundButton() {
    soundBtn.classList.toggle('is-muted', !soundOn);
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.title = soundOn ? '落印声：开' : '落印声：关';
  }

  function randomSpot() {
    if (prints.length === 0) {
      return {
        x: 54 + Math.random() * 12,
        y: 42 + Math.random() * 14
      };
    }

    let best = { x: 50, y: 48 };
    let bestScore = -1;
    for (let attempt = 0; attempt < 44; attempt += 1) {
      const candidate = {
        x: 11 + Math.random() * 78,
        y: 19 + Math.random() * 58
      };
      let nearest = Infinity;
      prints.forEach((print) => {
        const dx = (print.x - candidate.x) * 1.2;
        const dy = print.y - candidate.y;
        nearest = Math.min(nearest, Math.hypot(dx, dy));
      });
      if (nearest > bestScore) {
        bestScore = nearest;
        best = candidate;
      }
    }
    return best;
  }

  function showToast(message, duration = 3800) {
    window.clearTimeout(toastTimer);
    toastText.textContent = message;
    toast.classList.add('is-visible');
    toast.setAttribute('aria-hidden', 'false');
    toastTimer = window.setTimeout(() => {
      toast.classList.remove('is-visible');
      toast.setAttribute('aria-hidden', 'true');
    }, duration);
  }

  /* ---------------- 两面墙：经典 / 2411 纪念墙 ---------------- */

  function prefersReducedMotion() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function jumpToTop() {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previous;
  }

  function storeView(view) {
    try {
      if (view === '2411') window.sessionStorage.setItem(VIEW_KEY, view);
      else window.sessionStorage.removeItem(VIEW_KEY);
    } catch (error) {
      /* 存不下就只在这次会话里生效 */
    }
  }

  function loadView() {
    let view = 'classic';
    try {
      if (window.sessionStorage.getItem(VIEW_KEY) === '2411') view = '2411';
    } catch (error) {
      view = 'classic';
    }
    applyView(view, { instant: true });
  }

  function applyView(view, { instant = false } = {}) {
    const meta = VIEWS[view] || VIEWS.classic;
    const key = VIEWS[view] ? view : 'classic';
    currentView = key;
    document.body.dataset.view = key;
    document.title = meta.title;
    if (metaThemeColor) metaThemeColor.setAttribute('content', meta.theme);
    if (metaDescription) metaDescription.setAttribute('content', meta.description);
    if (sceneMark) sceneMark.textContent = meta.mark;
    if (intro) intro.setAttribute('aria-labelledby', meta.label);
    if (instant) document.body.classList.add('is-view-instant');
    viewPanels.forEach((panel) => {
      const active = panel.dataset.viewPanel === key;
      panel.setAttribute('aria-hidden', String(!active));
      if (active) panel.removeAttribute('inert');
      else panel.setAttribute('inert', '');
    });
    storeView(key);
    if (instant) {
      // 刷新后停留在 2411 时不自动播放：浏览器要求先有一次用户操作。
      if (bgm) {
        cancelMusicFade();
        bgm.pause();
        musicDesired = false;
        musicPausedByUser = false;
        setMusicState('paused');
      }
      // 初次进入时直接落在目标主题，不做第二段位移动画。
      window.requestAnimationFrame(() => document.body.classList.remove('is-view-instant'));
    }
  }

  function switchView(view, { announce = true } = {}) {
    if (viewSwitching) return;
    if (!VIEWS[view] || view === currentView) return;
    const reduce = prefersReducedMotion();
    viewSwitching = true;
    window.clearTimeout(viewSwapTimer);

    // 在输入/点击的用户手势里立即开始或暂停，避免 setTimeout 之后被自动播放策略拦下。
    syncMusicForView(view);

    sceneMark.textContent = VIEWS[view].mark;
    sceneVeil.classList.add('is-on');
    document.body.classList.add('is-view-leaving');

    const fadeOut = reduce ? 30 : 430;
    const fadeIn = reduce ? 40 : 600;

    viewSwapTimer = window.setTimeout(() => {
      applyView(view);
      jumpToTop();
      document.body.classList.remove('is-view-leaving');
      window.setTimeout(() => sceneVeil.classList.remove('is-on'), reduce ? 10 : 120);
      viewSwapTimer = window.setTimeout(() => {
        viewSwitching = false;
        if (!announce) return;
        announcer.textContent = view === '2411'
          ? '已切换到罗文学校2411纪念墙。'
          : '已回到谁来过。';
        showToast(view === '2411'
          ? '已切换到罗文学校2411纪念墙'
          : '已回到「谁来过」', 3200);
      }, fadeIn);
    }, fadeOut);
  }

  function checkMemorialCode() {
    if (readName() !== MEMORIAL_CODE) return;
    nameInput.value = '';
    clearNameFlag();
    nameInput.blur();
    if (currentView === '2411' && !viewSwitching) {
      showToast('已经在罗文学校2411纪念墙上了。', 2600);
      return;
    }
    switchView('2411');
  }

  /* ---------------- 2411 背景音乐 ---------------- */

  function setMusicState(mode) {
    if (!musicToggle || !musicState) return;
    const playing = mode === 'playing';
    let label = '点击播放';
    if (mode === 'playing') label = '播放中';
    else if (mode === 'loading') label = '加载中…';
    else if (mode === 'error') label = '无法播放';
    else if (mode === 'paused' && musicPausedByUser) label = '已暂停';

    musicToggle.classList.toggle('is-playing', playing);
    musicToggle.setAttribute('aria-pressed', String(playing));
    musicState.textContent = label;
    const title = `${playing ? '暂停' : '播放'}背景音乐《毕业通知》`;
    musicToggle.title = title;
    musicToggle.setAttribute('aria-label', title);
  }

  function cancelMusicFade() {
    if (!musicFadeFrame) return;
    window.cancelAnimationFrame(musicFadeFrame);
    musicFadeFrame = 0;
  }

  function fadeMusicIn() {
    if (!bgm) return;
    cancelMusicFade();
    const target = 0.55;
    const startedAt = window.performance.now();
    bgm.volume = 0;
    const step = (now) => {
      if (!bgm || bgm.paused || bgm.ended) {
        musicFadeFrame = 0;
        return;
      }
      const progress = Math.min(1, (now - startedAt) / 1200);
      bgm.volume = target * (0.12 + 0.88 * progress);
      if (progress < 1) musicFadeFrame = window.requestAnimationFrame(step);
      else musicFadeFrame = 0;
    };
    musicFadeFrame = window.requestAnimationFrame(step);
  }

  async function playMusic() {
    if (!bgm) return;
    const request = ++musicRequest;
    musicDesired = true;
    cancelMusicFade();
    bgm.volume = 0;
    setMusicState('loading');

    try {
      await bgm.play();
      if (request !== musicRequest) {
        if (!musicDesired) bgm.pause();
        return;
      }
      musicPausedByUser = false;
      fadeMusicIn();
      setMusicState('playing');
    } catch (error) {
      if (request !== musicRequest) return;
      setMusicState(error && error.name === 'NotAllowedError' ? 'blocked' : 'error');
    }
  }

  function pauseMusic({ byUser } = {}) {
    if (!bgm) return;
    musicRequest += 1;
    musicDesired = false;
    if (typeof byUser === 'boolean') musicPausedByUser = byUser;
    cancelMusicFade();
    if (!bgm.paused) bgm.pause();
    setMusicState('paused');
  }

  function syncMusicForView(view) {
    if (!bgm) return;
    if (view === '2411') {
      if (musicPausedByUser) {
        musicDesired = false;
        setMusicState('paused');
      } else {
        playMusic();
      }
    } else {
      pauseMusic();
    }
  }

  function handleMusicToggle() {
    if (!bgm) return;
    if (bgm.paused) {
      musicPausedByUser = false;
      playMusic();
    } else {
      pauseMusic({ byUser: true });
    }
  }

  if (bgm) {
    bgm.volume = 0;
    bgm.addEventListener('play', () => setMusicState('playing'));
    bgm.addEventListener('playing', () => setMusicState('playing'));
    bgm.addEventListener('pause', () => {
      cancelMusicFade();
      setMusicState('paused');
    });
    bgm.addEventListener('error', () => setMusicState('error'));
  }
  if (musicToggle) {
    musicToggle.addEventListener('click', handleMusicToggle);
  }

  /* ---------------- 一键清墙 ---------------- */

  function setClearError(message) {
    clearError.textContent = message || '';
    if (message) clearPassword.setAttribute('aria-invalid', 'true');
    else clearPassword.removeAttribute('aria-invalid');
  }

  function shakeClearPanel() {
    clearPanel.classList.remove('is-error');
    void clearPanel.offsetWidth;
    clearPanel.classList.add('is-error');
  }

  function openClearModal() {
    if (clearOpen || viewSwitching) return;
    clearOpen = true;
    modalLastFocus = document.activeElement;
    clearPassword.value = '';
    setClearError('');
    clearConfirm.disabled = false;
    clearConfirm.textContent = '确认清墙';
    clearPanel.classList.remove('is-error');
    clearModal.removeAttribute('inert');
    clearModal.setAttribute('aria-hidden', 'false');
    clearModal.classList.add('is-open');
    document.body.classList.add('is-modal-open');

    const focusPassword = () => {
      if (!clearOpen) return;
      clearPassword.focus({ preventScroll: true });
    };
    window.requestAnimationFrame(focusPassword);
    window.setTimeout(() => {
      if (clearOpen && document.activeElement !== clearPassword) focusPassword();
    }, 120);
  }

  function closeClearModal(force = false) {
    if (!clearOpen) return;
    if (clearingWall && !force) return;
    clearOpen = false;
    clearModal.classList.remove('is-open');
    clearModal.setAttribute('aria-hidden', 'true');
    clearModal.setAttribute('inert', '');
    document.body.classList.remove('is-modal-open');
    if (modalLastFocus && typeof modalLastFocus.focus === 'function') {
      modalLastFocus.focus();
    }
    modalLastFocus = null;
  }

  async function animateClear() {
    if (clearAnimating) return;
    clearAnimating = true;
    try {
      const cards = $$('.print', printsLayer);
      cards.forEach((card) => card.classList.add('is-clearing'));
      if (cards.length) await wait(440);
      prints = [];
      printsLayer.replaceChildren();
      mutationVersion += 1;
      syncUI({ bump: true });
      announcer.textContent = '这面墙已经清空了。';
    } finally {
      clearAnimating = false;
    }
  }

  async function requestWallClear(password) {
    clearInFlight = true;
    try {
      const data = await fetchJson(API_CLEAR, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      }, 12000);
      if (!data || data.ok !== true) {
        throw apiError('清墙没有完成，请再试一次。', 0);
      }
      await animateClear();
      window.setTimeout(() => {
        if (wallReady) refreshWall({ mode: 'silent' });
      }, 700);
      return true;
    } catch (error) {
      if (wallReady) refreshWall({ mode: 'silent' });
      throw error;
    } finally {
      clearInFlight = false;
    }
  }

  function apiError(message, status = 0) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  async function fetchJson(url, options = {}, timeoutMs = 9000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(options.headers || {})
        }
      });
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      if (!response.ok) {
        const message = data && typeof data.message === 'string'
          ? data.message
          : '墙那边出了点小状况，再试一次。';
        throw apiError(message, response.status);
      }
      return data;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw apiError('等太久了，网络好像有点慢。', 0);
      }
      if (error && typeof error.status === 'number') throw error;
      throw apiError('连不上墙，检查网络再试一次。', 0);
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function loadSyncConfig() {
    try {
      const data = await fetchJson(API_CONFIG, { method: 'GET' }, 6000);
      if (!data || typeof data.live !== 'boolean') return;
      liveMode = data.live;
      const interval = Number(data.pollMs);
      if (Number.isFinite(interval)) pollMs = clamp(interval, 2500, 60000);
    } catch (error) {
      // 老版本后端没有 /api/config，继续按 SSE 模式运行。
    }
  }

  function startPolling() {
    window.clearInterval(pollTimer);
    pollTimer = 0;
    if (liveMode) return;
    pollTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!wallReady) return;
      refreshWall({ mode: 'silent' });
    }, pollMs);
  }

  async function fetchPrints() {
    const data = await fetchJson(API_PRINTS, { method: 'GET' }, 9000);
    if (!data || !Array.isArray(data.prints)) {
      throw apiError('墙上的爪印没有读懂，再试一次。', 0);
    }
    return normalizeList(data.prints);
  }

  async function refreshWall({ mode = 'silent' } = {}) {
    if (refreshPromise) return refreshPromise;

    if (mode === 'initial' || mode === 'retry') {
      loading = true;
      retryMode = mode === 'retry';
      wallReady = false;
      if (liveState !== 'online') setLive('connecting');
      syncUI();
    }

    const versionAtStart = mutationVersion;

    refreshPromise = (async () => {
      try {
        const list = await fetchPrints();

        // A live event arrived while this snapshot was in flight. Keep the
        // newer on-screen state and try once more shortly instead of
        // clobbering it with an older snapshot.
        if (mode === 'silent' && mutationVersion !== versionAtStart) {
          window.setTimeout(() => {
            if (wallReady) refreshWall({ mode: 'silent' });
          }, 1600);
          return true;
        }

        const previous = prints;
        const changed = mode === 'initial'
          || previous.length !== list.length
          || list.some((print, index) => print.id !== previous[index].id);
        prints = list;
        if (changed) renderAll();
        loading = false;
        wallReady = true;
        retryMode = false;
        if (!liveMode) setLive('polling');
        syncUI();
        if (mode === 'initial') {
          announcer.textContent = prints.length
            ? `墙上有 ${prints.length} 枚爪印。`
            : '墙上还没有爪印，第一枚留给你。';
        }
        return true;
      } catch (error) {
        loading = false;
        retryMode = false;
        if (mode === 'silent' && wallReady) {
          updateWallState();
          updateStampButton();
          if (!liveMode) setLive('offline');
          return false;
        }
        wallReady = false;
        if (liveState !== 'online') setLive('offline');
        updateWallState();
        renderEmptyState();
        updateStampButton();
        if (mode === 'retry') {
          showToast(error && error.message ? error.message : '还是没连上，稍后再试。');
        }
        return false;
      } finally {
        refreshPromise = null;
      }
    })();

    return refreshPromise;
  }

  function parseEventData(event) {
    try {
      return JSON.parse(event.data);
    } catch (error) {
      return null;
    }
  }

  function handleRemoteStamp(event) {
    const data = parseEventData(event);
    if (!data || !data.print) return;
    if (!wallReady) {
      refreshWall({ mode: 'silent' });
      return;
    }

    if (Array.isArray(data.removed) && data.removed.length) {
      removePrints(data.removed);
    }

    const print = normalizePrint(data.print);
    if (!print) return;
    const added = addPrintLocal(print, true);
    syncUI({ bump: added });
  }

  function handleStreamClear() {
    if (!wallReady || clearInFlight || clearAnimating) return;
    // 别人清墙时也走同一段淡出动画，避免爪印突然消失。
    animateClear();
  }

  function connectEvents() {
    if (!liveMode || eventSource) return;
    if (typeof window.EventSource !== 'function') {
      liveMode = false;
      startPolling();
      setLive('polling');
      return;
    }

    let source;
    try {
      source = new EventSource(API_EVENTS);
    } catch (error) {
      liveMode = false;
      startPolling();
      setLive('polling');
      return;
    }
    eventSource = source;

    source.addEventListener('open', () => {
      const firstOpen = !sseOpened;
      sseOpened = true;
      setLive('online');
      if (!wallReady || !firstOpen) refreshWall({ mode: 'silent' });
    });

    source.addEventListener('ready', (event) => {
      setLive('online');
      const data = parseEventData(event);
      if (data && Number.isFinite(Number(data.count)) && wallReady && Number(data.count) !== prints.length) {
        refreshWall({ mode: 'silent' });
      }
    });

    source.addEventListener('stamp', handleRemoteStamp);
    source.addEventListener('clear', handleStreamClear);

    source.addEventListener('error', () => {
      setLive('offline');
      if (source.readyState === 2) {
        source.close();
        if (eventSource === source) eventSource = null;
        window.setTimeout(connectEvents, 5000);
      }
    });
  }

  function playStampSound() {
    if (!soundOn) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      if (!audioCtx) audioCtx = new AudioContextClass();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const now = audioCtx.currentTime;

      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(150, now);
      oscillator.frequency.exponentialRampToValueAtTime(52, now + 0.19);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      oscillator.connect(gain);
      gain.connect(audioCtx.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.26);

      if (!noiseBuffer) {
        const length = Math.floor(audioCtx.sampleRate * 0.085);
        noiseBuffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < length; i += 1) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.4);
        }
      }
      const source = audioCtx.createBufferSource();
      source.buffer = noiseBuffer;
      const filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1150;
      const noiseGain = audioCtx.createGain();
      noiseGain.gain.value = 0.045;
      source.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(audioCtx.destination);
      source.start(now);
    } catch (error) {
      soundOn = false;
      updateSoundButton();
    }
  }

  async function submitStamp(position, { fromButton = false } = {}) {
    if (!wallReady || loading || submitting || viewSwitching) return;

    // 名字必填：空白名字不再落成"无名氏"。
    const name = readName();
    if (!name) {
      flagMissingName();
      return;
    }

    submitting = true;
    syncUI();

    try {
      const payload = {
        n: name,
        s: selectedStyle,
        c: selectedInk,
        x: clamp(numeric(position.x, 50), 8, 92),
        y: clamp(numeric(position.y, 50), 16, 80)
      };
      const data = await fetchJson(API_PRINTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, 10000);

      if (!data || !data.print) {
        throw apiError('墙没有把这枚爪印收下，再试一次。', 0);
      }
      if (Array.isArray(data.removed) && data.removed.length) {
        removePrints(data.removed);
      }
      const print = normalizePrint(data.print);
      if (!print) {
        throw apiError('墙返回了一枚看不懂的爪印，再试一次。', 0);
      }

      addPrintLocal(print, true);
      syncUI({ bump: true });
      stampBtn.classList.remove('is-stamped');
      void stampBtn.offsetWidth;
      stampBtn.classList.add('is-stamped');
      playStampSound();
      announcer.textContent = `${print.n}的爪印留在了墙上，现在共有 ${prints.length} 枚爪印。`;

      if (fromButton && window.matchMedia('(max-width:640px)').matches) {
        nameInput.blur();
      }
    } catch (error) {
      showToast(error && error.message ? error.message : '没能按上这枚爪印，再试一次。');
    } finally {
      submitting = false;
      syncUI();
    }
  }

  function handleWallClick(event) {
    if (!wallReady || loading || submitting) return;
    if (event.button != null && event.button !== 0) return;

    if (event.detail === 0) {
      submitStamp(randomSpot());
      return;
    }

    const rect = wall.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    submitStamp({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100
    });
  }

  // Wall interactions
  wall.addEventListener('click', handleWallClick);
  wall.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target !== wall) return;
    event.preventDefault();
    if (!wallReady || loading || submitting) return;
    submitStamp(randomSpot());
  });

  if (window.matchMedia('(hover:hover) and (pointer:fine)').matches) {
    wall.addEventListener('pointermove', (event) => {
      if (!wallReady || loading || submitting) return;
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const rect = wall.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
      ghost.style.left = `${x}px`;
      ghost.style.top = `${y}px`;
      wall.classList.add('is-hovering');
    });
    wall.addEventListener('pointerleave', () => {
      wall.classList.remove('is-hovering');
    });
    wall.addEventListener('blur', () => {
      wall.classList.remove('is-hovering');
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (loading || submitting) return;
    if (!wallReady) {
      refreshWall({ mode: 'retry' });
      return;
    }
    submitStamp(randomSpot(), { fromButton: true });
  });

  pawButtons.forEach((button) => {
    button.addEventListener('click', () => setStyle(button.dataset.style));
  });

  nameInput.addEventListener('input', () => {
    clearNameFlag();
    checkSecretCode();
    checkMemorialCode();
  });

  inkInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) setInk(input.value);
    });
  });

  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    updateSoundButton();
    savePrefs();
    if (soundOn) playStampSound();
  });

  if (backBtn) {
    backBtn.addEventListener('click', () => switchView('classic'));
  }

  /* ---------------- 清墙按钮与密码框 ---------------- */

  if (clearBtn) {
    clearBtn.addEventListener('click', openClearModal);
  }

  $$('[data-clear-close]', clearModal).forEach((target) => {
    target.addEventListener('click', () => closeClearModal());
  });

  clearPassword.addEventListener('input', () => setClearError(''));

  clearModal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusables = $$('button:not([disabled]), input:not([disabled])', clearModal)
      .filter((element) => element.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !clearOpen) return;
    event.preventDefault();
    closeClearModal();
  });

  clearForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (clearingWall) return;

    const password = clearPassword.value.trim();
    if (!password) {
      setClearError('请输入管理密码。');
      shakeClearPanel();
      clearPassword.focus();
      return;
    }

    clearingWall = true;
    clearConfirm.disabled = true;
    clearConfirm.textContent = '正在清墙…';
    setClearError('');

    try {
      await requestWallClear(password);
      clearingWall = false;
      closeClearModal(true);
      showToast('整面墙已经清空。', 4200);
    } catch (error) {
      setClearError(error && error.message ? error.message : '清墙没有成功，请再试一次。');
      shakeClearPanel();
      clearPassword.focus();
      clearPassword.select();
    } finally {
      clearingWall = false;
      clearConfirm.disabled = false;
      clearConfirm.textContent = '确认清墙';
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!loading) refreshWall({ mode: 'silent' });
    if (liveMode && !eventSource) connectEvents();
  });

  window.addEventListener('online', () => {
    if (!loading) refreshWall({ mode: 'silent' });
    if (liveMode && !eventSource) connectEvents();
  });

  window.addEventListener('offline', () => {
    setLive('offline');
  });

  // Fallback refresh for SSE mode. Netlify polling mode uses startPolling().
  window.setInterval(() => {
    if (!liveMode || document.visibilityState !== 'visible') return;
    if (wallReady && (!eventSource || eventSource.readyState !== 1)) {
      refreshWall({ mode: 'silent' });
    }
  }, 30000);

  // Keep relative date labels correct if the page stays open across midnight.
  let lastDay = new Date().toDateString();
  window.setInterval(() => {
    const today = new Date().toDateString();
    if (today === lastDay) return;
    lastDay = today;
    $$('.print', printsLayer).forEach((element) => {
      const print = prints.find((item) => item.id === element.dataset.id);
      const time = $('.print__time', element);
      if (print && time) time.textContent = shortTime(print.t);
    });
  }, 60000);

  async function boot() {
    loadView();
    loadUnlock();
    loadPrefs();
    setStyle(selectedStyle, { persist: false });
    setInk(selectedInk, { persist: false });
    updateSoundButton();
    setLive('connecting');
    loading = true;
    syncUI();

    await loadSyncConfig();
    await refreshWall({ mode: 'initial' });
    if (liveMode) {
      connectEvents();
    } else {
      startPolling();
      if (wallReady) setLive('polling');
    }
    document.documentElement.dataset.boot = 'ready';
  }

  boot();
})();
