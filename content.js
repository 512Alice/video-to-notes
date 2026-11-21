// B站学习笔记助手 - B站页面内容脚本
// 页面右下角显示「笔记」按钮，点击打开网页式入口（自动带上当前视频链接）。
// v3.8.2：截图精度修正
//   1) 返回的矩形按 videoWidth/videoHeight 内缩，去掉播放器里的黑边（黑边会占掉半张图）；
//   2) seek 后等 requestVideoFrameCallback 真正呈现一帧再回传，并校验 readyState>=2，
//      避免截到"还没画出画面"的黑帧（这是空白图的主因）；
//   3) 播放器完整能放下就贴到导航栏下方，放不下就居中；滚动位置随矩形一起回传。
// v3.8.1：消息监听器每次注入先移除旧的再挂新的（扩展重载后旧脚本通道会失效，靠补注入救回）。

(() => {
  function sendToBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp);
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // ---------- 截图辅助 ----------

  const HIDE_SELECTORS = [
    '.bpx-player-control-wrap',
    '.bpx-player-control-bottom',
    '.bpx-player-dm-wrap',
    '.bpx-player-dm-setting',
    '.bpx-player-video-btn',
    '.bilibili-player-video-control',
    '.bilibili-player-video-danmaku',
    '.bilibili-player-video-btn'
  ];

  const NAV_H = 64;   // B 站顶部导航加播放器上方留白，贴顶时让出来的高度
  let origin = null;  // { t, paused, sx, sy }

  function hideOverlays() {
    HIDE_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        try {
          if (el.dataset.bnHidden === undefined) el.dataset.bnHidden = el.style.opacity || '';
          el.style.opacity = '0';
        } catch (e) { /* 忽略 */ }
      });
    });
  }

  function showOverlays() {
    try {
      document.querySelectorAll('[data-bn-hidden]').forEach((el) => {
        el.style.opacity = el.dataset.bnHidden || '';
        delete el.dataset.bnHidden;
      });
    } catch (e) { /* 忽略 */ }
  }

  // 播放器元素里真正显示画面的区域：<video> 默认 object-fit: contain，元素内有黑边
  function pictureRect(v) {
    const r = v.getBoundingClientRect();
    let x = r.x, y = r.y, w = r.width, h = r.height;
    const vw = Number(v.videoWidth) || 0;
    const vh = Number(v.videoHeight) || 0;
    if (vw > 0 && vh > 0 && w > 0 && h > 0) {
      const arV = vw / vh;
      const arB = w / h;
      if (arV > arB) {
        // 画面比容器更宽 → 容器上下有黑边
        const nh = w / arV;
        y = r.y + (r.height - nh) / 2;
        h = nh;
      } else if (arV < arB) {
        // 画面更窄 → 左右有黑边
        const nw = h * arV;
        x = r.x + (r.width - nw) / 2;
        w = nw;
      }
    }
    return { x, y, w, h };
  }

  function onBnMessage(msg, sender, sendResponse) {
    if (!msg) return;

    if (msg.type === 'bnRestorePlayback') {
      try {
        const v = document.querySelector('video');
        if (v && origin) {
          v.currentTime = origin.t;
          if (origin.paused === false) v.play().catch(() => {});
        }
      } catch (e) { /* 忽略 */ }
      try { window.scrollTo(origin ? origin.sx : 0, origin ? origin.sy : 0); } catch (e) { /* 忽略 */ }
      showOverlays();
      origin = null;
      try { sendResponse({ ok: true }); } catch (e) { /* 忽略 */ }
      return true;
    }

    if (msg.type !== 'bnSeekMeasure') return;

    const v = document.querySelector('video');
    if (!v) {
      try { sendResponse({ ok: false, error: '页面没有 video 元素' }); } catch (e) { /* 忽略 */ }
      return true;
    }

    // 只在第一次量的时候记录原始状态并调整滚动位置；重排后的二次量不要覆盖 origin
    if (msg.first && !origin) {
      origin = { t: v.currentTime || 0, paused: v.paused !== false, sx: window.scrollX || 0, sy: window.scrollY || 0 };
      try {
        const r0 = v.getBoundingClientRect();
        const fits = r0.height <= (window.innerHeight - NAV_H);
        const y = fits
          ? (window.scrollY || 0) + r0.top - NAV_H
          : (window.scrollY || 0) + r0.top + r0.height / 2 - (window.innerHeight || 0) / 2;
        window.scrollTo(0, Math.max(0, y));
      } catch (e) { /* 忽略 */ }
    }

    let replied = false;
    const done = (extra) => {
      if (replied) return;
      replied = true;
      const pr = pictureRect(v);
      const payload = Object.assign({
        ok: true,
        rect: pr,
        vw: window.innerWidth,
        vh: window.innerHeight,
        sx: window.scrollX || 0,
        sy: window.scrollY || 0,
        readyState: v.readyState,
        videoW: v.videoWidth || 0,
        videoH: v.videoHeight || 0,
        dpr: window.devicePixelRatio || 1
      }, extra || {});
      try { sendResponse(payload); } catch (e) { /* 忽略 */ }
    };

    try { v.pause(); } catch (e) { /* 忽略 */ }
    hideOverlays();

    const target = Math.max(0, Number(msg.time) || 0);

    // seek 落位后，等浏览器真正呈现一帧再回传；没等到（还在缓冲）就明确报错，别让空白图进库
    const settle = (onReady) => {
      let fired = false;
      const go = () => { if (fired) return; fired = true; onReady(); };
      const guard = setTimeout(go, 900);
      if (typeof v.requestVideoFrameCallback === 'function') {
        try {
          v.requestVideoFrameCallback(() => { clearTimeout(guard); go(); });
        } catch (e) { /* 忽略 */ }
      } else {
        setTimeout(() => { clearTimeout(guard); go(); }, 280);
      }
      setTimeout(go, 700); // 双保险：等太久就直接回，由 background 判定空白
    };

    const finish = () => {
      if (v.readyState >= 2) {
        setTimeout(() => done(), 120); // 给合成器一点上屏时间
        return;
      }
      // seeked 之后还没解码出画面（远端位置常见）：再给最多 2.5 秒缓冲时间，别急着判空白
      const t0 = Date.now();
      const tick = () => {
        if (v.readyState >= 2) { setTimeout(() => done(), 120); return; }
        if (Date.now() - t0 > 2500) {
          done({ ok: false, error: '该时间点未缓冲（画面还没解码出来），已跳过' });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    };

    if (Math.abs((v.currentTime || 0) - target) < 0.3) {
      settle(finish);
      return true;
    }

    const timer = setTimeout(() => settle(finish), 3000);
    v.addEventListener('seeked', function onSeeked() {
      clearTimeout(timer);
      settle(finish);
    }, { once: true });

    try {
      v.currentTime = target;
    } catch (e) {
      clearTimeout(timer);
      done({ ok: false, error: '跳转失败：' + (e && e.message ? e.message : '') });
    }
    return true;
  }

  try {
    if (window.__bnSeekHandler) chrome.runtime.onMessage.removeListener(window.__bnSeekHandler);
  } catch (e) { /* 忽略 */ }
  window.__bnSeekHandler = onBnMessage;
  try { chrome.runtime.onMessage.addListener(onBnMessage); } catch (e) { /* 忽略 */ }

  // ---------- 右下角「笔记」按钮（已存在就不重复建）----------

  if (document.getElementById('bn-fab')) return;

  const fab = document.createElement('button');
  fab.id = 'bn-fab';
  fab.textContent = '笔记';
  fab.title = '打开B站学习笔记助手（网页式入口）';
  document.body.appendChild(fab);

  fab.addEventListener('click', async () => {
    fab.disabled = true;
    fab.textContent = '打开中…';
    try {
      await sendToBg({ type: 'openApp', url: location.href });
    } finally {
      fab.disabled = false;
      fab.textContent = '笔记';
    }
  });
})();
