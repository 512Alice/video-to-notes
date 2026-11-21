// B站/小红书/YouTube 学习笔记助手 - YouTube 字幕请求钩子（运行在页面 MAIN world）
// 播放器播放/开启字幕时会请求 /api/timedtext（带 PoToken 校验参数）。
// 这里把响应正文缓存到 window.__bnYtSubs，抓取时直接复用，绕开 PoToken 限制。

(() => {
  if (window.__bnYtHook) return;
  window.__bnYtHook = true;

  const store = (window.__bnYtSubs = window.__bnYtSubs || []);
  // v3.7.94：除了播放器字幕请求 /api/timedtext，也缓存"显示文稿"面板的 youtubei/v1/get_transcript 响应
  const isSubUrl = (u) => typeof u === 'string' &&
    (u.indexOf('/api/timedtext') >= 0 || u.indexOf('/youtubei/v1/get_transcript') >= 0);

  function push(url, body) {
    try {
      if (!body || String(body).trim().length < 20) return;
      store.push({ url: String(url), body: String(body), t: Date.now() });
      while (store.length > 8) store.shift();
    } catch (e) { /* 忽略 */ }
  }

  // 1) fetch
  try {
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
          const a0 = args[0];
          const url = typeof a0 === 'string' ? a0 : (a0 && a0.url);
          if (isSubUrl(url)) {
            p.then((r) => {
              try { r.clone().text().then((t) => push(url, t)).catch(() => {}); } catch (e) { /* 忽略 */ }
            }).catch(() => {});
          }
        } catch (e) { /* 忽略 */ }
        return p;
      };
    }
  } catch (e) { /* 忽略 */ }

  // 2) XMLHttpRequest
  try {
    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSend = XP.send;
    XP.open = function (method, url) {
      try { this.__bnSubUrl = url; } catch (e) { /* 忽略 */ }
      return origOpen.apply(this, arguments);
    };
    XP.send = function () {
      try {
        const u = this.__bnSubUrl;
        if (isSubUrl(u)) {
          this.addEventListener('load', () => {
            try { push(u, this.responseText); } catch (e) { /* 忽略 */ }
          });
        }
      } catch (e) { /* 忽略 */ }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* 忽略 */ }
})();
