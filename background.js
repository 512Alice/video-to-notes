// B站学习笔记助手 - 后台服务工作进程
// 职责：抓取B站视频CC字幕（含AI字幕）、打开/切换到豆包网页标签页、打开网页式入口页面。
// 所有网络请求放在这里执行，可绕开页面 CORS/CSP 限制。

async function fetchJson(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ---------- B站 wbi 签名（与播放器一致，用于读取 AI 智能字幕） ----------

// MD5（RFC 1321）
function md5(input) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    return ((x >> 16) + (y >> 16) + (lsw >> 16) << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  const K = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
    5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
    4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
    6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const bytes = unescape(encodeURIComponent(String(input)));
  const len = bytes.length;
  const n = ((len + 8) >> 6) + 1;
  const blocks = new Array(n * 16).fill(0);
  for (let i = 0; i < len; i++) blocks[i >> 2] |= bytes.charCodeAt(i) << ((i % 4) * 8);
  blocks[len >> 2] |= 0x80 << ((len % 4) * 8);
  blocks[n * 16 - 2] = len * 8;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < blocks.length; i += 16) {
    const olda = a, oldb = b, oldc = c, oldd = d;
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const tmp = d;
      d = c; c = b;
      b = safeAdd(b, bitRotateLeft(safeAdd(safeAdd(a, f), safeAdd(blocks[i + g], K[j])), S[j]));
      a = tmp;
    }
    a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
  }
  return [a, b, c, d].map((w) => {
    w = w >>> 0;
    let s = '';
    for (let i = 0; i < 4; i++) s += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  }).join('');
}

const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let wbiKey = null;
let wbiFetchedAt = 0;

// 获取 wbi 签名密钥（缓存 6 小时）
async function getWbiKey() {
  const now = Date.now();
  if (wbiKey && now - wbiFetchedAt < 6 * 3600 * 1000) return wbiKey;
  const nav = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  const wbi = nav.data && nav.data.wbi_img;
  if (!wbi || !wbi.img_url || !wbi.sub_url) throw new Error('获取B站签名密钥失败');
  const imgKey = wbi.img_url.split('/').pop().split('.')[0];
  const subKey = wbi.sub_url.split('/').pop().split('.')[0];
  const mixed = imgKey + subKey;
  let key = '';
  for (const i of MIXIN_TAB) key += mixed[i];
  wbiKey = key.slice(0, 32);
  wbiFetchedAt = now;
  return wbiKey;
}

// 生成带 wbi 签名的播放器接口 URL（与 B 站网页播放器一致）
async function wbiPlayerApi(aid, cid) {
  const key = await getWbiKey();
  const params = { aid: String(aid), cid: String(cid), wts: String(Math.floor(Date.now() / 1000)) };
  const sorted = Object.keys(params).sort()
    .map((k) => k + '=' + encodeURIComponent(params[k].replace(/[!'()*]/g, '')))
    .join('&');
  const w_rid = md5(sorted + key);
  return 'https://api.bilibili.com/x/player/wbi/v2?' + sorted + '&w_rid=' + w_rid;
}

// 把字幕 body 数组转成带时间戳的行
function toLines(body) {
  const lines = (Array.isArray(body) ? body : [])
    .map((x) => ({
      t: Number(x.from) || 0,
      text: String(x.content || '').trim()
    }))
    .filter((x) => x.text);
  if (!lines.length) throw new Error('字幕内容为空');
  return lines;
}

// 给定 aid+cid 查询播放器字幕列表并抓取（优先中文，含 AI 中文）
async function getSubtitleByAidCid(aid, cid) {
  let subs = [];
  // 1) 与 B 站播放器一致的 wbi 签名请求（读取 AI 智能字幕）
  try {
    const api = await wbiPlayerApi(aid, cid);
    const player = await fetchJson(api);
    subs = (player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
  } catch (e) { /* 继续兜底 */ }
  // 2) 兜底：无签名 v2 接口
  if (!subs.length) {
    try {
      const player = await fetchJson('https://api.bilibili.com/x/player/v2?aid=' + aid + '&cid=' + cid);
      subs = (player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
    } catch (e) { /* 忽略 */ }
  }
  if (!subs.length) throw new Error('没有读到字幕：该视频/分P 可能未生成AI字幕，或 Edge 未登录 B 站账号（AI智能字幕需登录才能读取）。请确认已登录，或换有字幕的视频');

  const score = (s) => {
    const lan = (s.lan || '').toLowerCase();
    const doc = (s.lan_doc || '').toLowerCase();
    if (lan === 'zh-cn' || lan === 'zh-hans' || lan === 'zh-hant') return 5;
    if (lan === 'ai-zh') return 4;
    if (lan.indexOf('zh') === 0) return 3;
    if (doc.indexOf('中文') >= 0 || doc.indexOf('简体') >= 0 || doc.indexOf('繁体') >= 0) return 3;
    if (lan.indexOf('ai') === 0) return 2;
    return 1;
  };
  subs.sort((a, b) => score(b) - score(a));
  // 优先选择字幕地址中含当前 cid 的条目（B站偶发把其他分P/视频的字幕混入列表）
  const cidStr = String(cid);
  const matched = subs.filter((s) => s.subtitle_url && String(s.subtitle_url).indexOf(cidStr) >= 0);
  const ordered = matched.length ? matched : subs;
  // 参照 Bili Clipper 的做法：按优先级逐个尝试下载字幕文件。
  // CC 字幕（UP 上传，lan=zh-CN）无需登录即可下载；AI 字幕未登录会 403，跳过继续试下一个。
  let lastErr = null;
  for (const s of ordered) {
    const raw = s.subtitle_url || '';
    const url = raw.indexOf('//') === 0 ? 'https:' + raw : raw;
    if (url.indexOf('http') !== 0) continue;
    try {
      const data = await fetchJson(url);
      const lines = toLines(data.body);
      if (lines.length) return { lines, source: s.lan_doc || s.lan || '字幕' };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  if (lastErr) throw new Error('字幕文件下载失败（' + lastErr.message + '）。若为 403：AI 智能字幕需登录 B 站才能读取，可尝试有 CC 字幕的视频或先登录 B 站');
  throw new Error('没有读到可用的字幕：该视频/分P 可能未生成字幕，或仅 AI 字幕且 Edge 未登录 B 站');
}

// 从 B 站页面内抓字幕（当前分P，播放器已加载字幕优先）
async function fetchSubtitle(msg) {
  const { bvid, aid, cid, candidateUrl } = msg || {};

  if (candidateUrl && /^https:\/\//.test(candidateUrl)) {
    try {
      const data = await fetchJson(candidateUrl);
      return { lines: toLines(data.body), source: '播放器已加载字幕' };
    } catch (e) { /* 继续尝试接口 */ }
  }

  let realAid = aid, realCid = cid;
  if (!realAid || !realCid) {
    if (!bvid) throw new Error('缺少视频ID');
    const view = await fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
    if (view.code !== 0 || !view.data) throw new Error('获取视频信息失败：' + (view.message || 'code=' + view.code));
    realAid = view.data.aid;
    realCid = view.data.cid;
  }
  const sub = await getSubtitleByAidCid(realAid, realCid);
  return { lines: sub.lines, source: sub.source };
}

// 从任意 B 站链接抓字幕（网页入口使用；支持 ?p=N 指定分P）
async function fetchSubtitleByUrl(msg) {
  const { url, p } = msg || {};
  const m = String(url || '').match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (!m) throw new Error('链接中未找到 BV 号，请粘贴形如 https://www.bilibili.com/video/BVxxxx 的链接');
  const bvid = m[1];
  const view = await fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
  if (view.code !== 0 || !view.data) throw new Error('获取视频信息失败：' + (view.message || 'code=' + view.code));
  const d = view.data;
  const pages = d.pages || [];
  const pi = Math.max(0, (parseInt(p, 10) || 1) - 1);
  const target = pages[pi] || pages[0];
  const aid = d.aid;
  const cid = target ? target.cid : d.cid;
  // v3.7.40：多P合集优先用分P小标题（pages[i].part）作为笔记标题
  let title = d.title;
  if (pages.length > 1 && target && target.part) {
    const part = String(target.part).trim();
    if (part && !/^(第\s*\d+\s*集?|P\s*\d+|\d+)$/i.test(part)) title = part;
    else title = d.title + '（P' + (pi + 1) + '/' + pages.length + '）';
  }
  const sub = await getSubtitleByAidCid(aid, cid);
  return { lines: sub.lines, source: sub.source, title, bvid, aid, cid, totalPages: pages.length };
}

// ==================== 小红书（rednote / xiaohongshu）视频字幕 ====================
// 小红书网页把笔记数据写在 SSR 的 __INITIAL_STATE__ 里，视频 AI 字幕是
// note.video.media.subtitles["zh-CN"][0].url —— 一个 .srt 文件（域 sns-subtitle-*.rednotecdn.com）。
// 笔记页 HTML 可直接请求（无需登录），字幕 SRT 也可直接下载。整段被塞成字符串，
// 所以 HTML 里是 \" 和 \u002F 转义，先反转义再取 URL。

function isXhsUrl(u) {
  return /(xiaohongshu\.com|rednote\.com)\/(explore|discovery\/item|item|discovery)\//.test(String(u || ''));
}

// 反转义被二重编码的 JSON 片段
function unescJsonText(s) {
  return String(s || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003D/g, '=')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n');
}

// SRT → [{t, text}]（t 为秒）
function srtToLines(srt) {
  const blocks = String(srt || '').replace(/\r/g, '').split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const rows = b.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!rows.length) continue;
    const tm = rows.find((x) => /\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(x));
    if (!tm) continue;
    const g = tm.match(/(\d{2}):(\d{2}):(\d{2})[,.]\d{3}/);
    const sec = (+g[1]) * 3600 + (+g[2]) * 60 + (+g[3]);
    const txt = rows
      .filter((x) => x !== tm && !/^\d+$/.test(x))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (txt) out.push({ t: sec, text: txt });
  }
  if (!out.length) throw new Error('字幕内容为空');
  return out;
}

// 从笔记页 HTML 里取标题 + zh-CN 字幕地址
function pickXhsTitle(html) {
  const cands = [
    /"displayTitle"\s*:\s*"([^"]{2,80})"/,
    /"title"\s*:\s*"([^"]{2,80})"/,
    /<title>(.{2,80}?)\s*-\s*(?:小红书|rednote)[^<]*<\/title>/
  ];
  for (const re of cands) {
    const m = html.match(re);
    if (m && m[1]) {
      const t = unescJsonText(m[1]).trim();
      if (t && t !== '小红书' && t !== 'rednote') return t;
    }
  }
  return '';
}

function pickXhsSrtUrl(html) {
  const un = unescJsonText(html);
  // 键顺序：zh-CN（AI 中文）→ source（原始/作者字幕，language 也常是 zh-CN）→ 任意中文 → 任意 srt
  const tries = [
    /zh-CN"\s*:\s*\[\s*\{\s*"url"\s*:\s*"(https:\/\/[^"]+)"/,
    /source"\s*:\s*\[\s*\{\s*"url"\s*:\s*"(https:\/\/[^"]+)"/,
    /"url"\s*:\s*"(https:\/\/[^"]+)"\s*,\s*"language"\s*:\s*"zh/i,
    /(https:\/\/[^"'\s\\]*\.srt[^"'\s\\]*)/i
  ];
  for (const re of tries) {
    const m = un.match(re);
    if (m && m[1]) return m[1].replace(/&amp;/g, '&');
  }
  return '';
}

async function fetchSubtitleXhsByUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!isXhsUrl(url)) {
    throw new Error('不是小红书笔记链接（需形如 https://www.xiaohongshu.com/explore/xxxx 或 https://www.rednote.com/discovery/item/xxxx）');
  }
  let html = '';
  try {
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    html = await res.text();
  } catch (e) {
    throw new Error('请求小红书笔记页失败：' + (e && e.message ? e.message : e));
  }
  // 服务端对非浏览器客户端可能只回空壳首页（约 37k，不含 noteDetailMap）
  if (!html || html.length < 3000) throw new Error('小红书笔记页没有返回内容，请确认链接完整（含 xsec_token）');
  if (html.indexOf('noteDetailMap') < 0 && html.indexOf('subtitles') < 0) {
    throw new Error('小红书只返回了空壳页面（没有笔记数据），请改从已打开的小红书笔记页点「笔记」按钮抓取');
  }
  const title = pickXhsTitle(html);
  const srtUrl = pickXhsSrtUrl(html);
  if (!srtUrl) {
    throw new Error('该笔记没有可读的字幕轨道（小红书不是每个视频都有字幕）。' +
      '请在笔记里点开视频确认下方有"字幕/CC"；或换一个有字幕的视频笔记');
  }
  let srt = '';
  try {
    const r2 = await fetch(srtUrl, { credentials: 'include', cache: 'no-store' });
    srt = await r2.text();
  } catch (e) {
    throw new Error('下载字幕文件失败：' + (e && e.message ? e.message : e));
  }
  const lines = srtToLines(srt);
  return {
    lines,
    title: title || '小红书视频',
    source: '小红书 AI 字幕（SRT）'
  };
}

// 在页面上下文里执行：读 __INITIAL_STATE__ 取字幕地址并下载 SRT。
// 注入后无外部依赖（不能引用 background 里的函数）。
function xhsGrabInPage() {
  return (async () => {
    try {
      const st = window.__INITIAL_STATE__ || {};
      const dm = (st.note && st.note.noteDetailMap) || st.noteDetailMap || {};
      const ids = Object.keys(dm || {});
      let note = null;
      if (ids.length) {
        const pm = String(location.pathname).match(/(?:explore|item|discovery\/item)\/((?:[0-9a-f]{24})|[0-9a-f]{16,})/i);
        const id = pm && dm[pm[1]] ? pm[1] : ids[0];
        note = (dm[id] && dm[id].note) || (dm[ids[0]] && dm[ids[0]].note) || null;
      }
      // 兜底：从 video 节点往上找不到时，直接扫页面文本里的 srt 地址
      let subs = null;
      if (note && note.video) {
        let media = note.video.media;
        if (typeof media === 'string') { try { media = JSON.parse(media); } catch (e) { media = null; } }
        subs = (media && media.subtitles) || note.video.subtitles || null;
      }
      let srtUrl = '';
      if (subs) {
        // 优先 zh-CN（AI 中文）→ source（原始/作者字幕）→ 任意 language 含 zh 的轨道
        const order = ['zh-CN', 'source'];
        for (const k of order) {
          if (subs[k] && subs[k][0] && subs[k][0].url) { srtUrl = subs[k][0].url; break; }
        }
        if (!srtUrl) {
          for (const lg of Object.keys(subs)) {
            const arr = subs[lg] || [];
            const hit = arr.find((x) => x && x.url && /^zh/i.test(String(x.language || '')));
            if (hit) { srtUrl = hit.url; break; }
          }
        }
        if (!srtUrl) {
          for (const lg of Object.keys(subs)) {
            const arr = subs[lg] || [];
            if (arr[0] && arr[0].url) { srtUrl = arr[0].url; break; }
          }
        }
      }
      if (!srtUrl) {
        // 兜底 1：已加载的资源里找 .srt
        const perf = performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
        const hit = (perf || []).find((x) => /\.srt/.test(x.name || ''));
        if (hit) srtUrl = hit.name;
      }
      if (!srtUrl) {
        // 兜底 2：页面 HTML 里直接正则取（小红书会把字幕地址内嵌进 SSR HTML）
        const dom = document.documentElement.innerHTML
          .replace(/\\u002F/g, '/')
          .replace(/\\"/g, '"')
          .replace(/&amp;/g, '&');
        const mm = dom.match(/zh-CN"\s*:\s*\[\s*\{\s*"url"\s*:\s*"(https:\/\/[^"]+\.srt[^"]*)"/) ||
          dom.match(/(https:\/\/[^"'\s\\]*\.srt[^"'\s\\]*)/);
        if (mm) srtUrl = mm[1];
      }
      if (!srtUrl) return { ok: false, error: '页面里没有找到字幕地址（该笔记视频可能没有 AI 字幕）' };
      const r = await fetch(srtUrl, { credentials: 'include', cache: 'no-store' });
      const srt = await r.text();
      if (!srt || srt.indexOf('-->') < 0) return { ok: false, error: '字幕文件不是有效 SRT' };
      const t = (note && (note.title || note.displayTitle)) || document.title || '';
      return { ok: true, srt, title: String(t).replace(/\s*-\s*(小红书|rednote)[^ ]*$/i, '').trim() };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  })();
}

// ==================== YouTube 视频字幕 ====================
// 页面 HTML 里 ytInitialPlayerResponse.captions...captionTracks 含 baseUrl，
// 但 2024 年后 timedtext 加了 PoToken 校验：没有 pot 的请求返回 200 但内容为空。
// 所以主链路是"在用户已打开的 YouTube 页面里抓"（播放器开 CC 后发出的 timedtext URL 带 pot）。

function isYtUrl(u) {
  return /(youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/.test(String(u || ''));
}

function ytVideoId(u) {
  const s = String(u || '');
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

// 从 HTML 里按括号配对取出一段 JSON 数组（captionTracks 是标准 JSON）
function extractJsonArrayAfter(html, marker) {
  const i = String(html).indexOf(marker);
  if (i < 0) return null;
  const start = String(html).indexOf('[', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < html.length; k++) {
    const ch = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, k + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function ytPickTrack(tracks) {
  const arr = Array.isArray(tracks) ? tracks : [];
  if (!arr.length) return null;
  const zh = arr.find((t) => /^zh/i.test(String(t.languageCode || t.vssId || '')));
  if (zh) return zh;
  return arr[0];
}

// json3 格式 → [{t, text}]
function ytJson3ToLines(txt) {
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('YouTube 字幕不是有效 JSON'); }
  const out = [];
  for (const e of (j.events || [])) {
    if (!e.segs) continue;
    const s = e.segs.map((x) => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (s) out.push({ t: Math.round((e.tStartMs || 0) / 1000), text: s });
  }
  if (!out.length) throw new Error('字幕内容为空');
  return out;
}

function htmlUnescape(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
}

// srv1/xml 格式 → [{t, text}]
function ytXmlToLines(txt) {
  const out = [];
  const re = /<text\s+start="([0-9.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(txt))) {
    const body = htmlUnescape(m[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (body) out.push({ t: Math.floor(parseFloat(m[1])) , text: body });
  }
  if (!out.length) throw new Error('字幕内容为空（可能是 XML 格式未识别）');
  return out;
}

// v3.7.94：get_transcript（YouTube「显示文稿」面板接口）响应 → [mm:ss] 行。
// 结构是嵌套的 transcriptCueRenderer，逐层遍历取 cue.simpleText/runs + startOffsetMs。
function ytTranscriptToLines(body) {
  const out = [];
  let json = null;
  try { json = JSON.parse(String(body || '')); } catch (e) { return out; }
  const pad = (n) => String(n).padStart(2, '0');
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const cue = o.transcriptCueRenderer;
    if (cue && cue.cue) {
      const c = cue.cue;
      const txt = c.simpleText || (c.runs || []).map((r) => r.text || '').join('') || '';
      const ms = parseInt(cue.startOffsetMs || '0', 10) || 0;
      const sec = Math.floor(ms / 1000);
      const clean = String(txt).replace(/\s+/g, ' ').trim();
      if (clean) out.push('[' + pad(Math.floor(sec / 60)) + ':' + pad(sec % 60) + '] ' + clean);
    }
    for (const k in o) { try { walk(o[k], depth + 1); } catch (e) { /* 忽略 */ } }
  };
  walk(json, 0);
  return out;
}

// 自动识别三种响应体：json3（timedtext）、xml（timedtext）、get_transcript JSON
function ytAnyToLines(body) {
  const t = String(body || '').trim();
  if (!t) return [];
  if (t.indexOf('transcriptCueRenderer') >= 0) return ytTranscriptToLines(t);
  try { return ytBodyToLines(t); } catch (e) { return []; }
}

function ytBodyToLines(body) {
  const t = String(body || '').trim();
  if (!t) throw new Error('YouTube 返回的字幕是空的（缺少 PoToken 校验参数）');
  if (t[0] === '{') return ytJson3ToLines(t);
  return ytXmlToLines(t);
}

function ytTitleFrom(html) {
  const a = String(html).match(/"videoDetails":\{"videoId":"[^"]+","title":"((?:[^"\\]|\\.)*)"/);
  if (a) { try { return JSON.parse('"' + a[1] + '"'); } catch (e) { /* 继续 */ } }
  const b = String(html).match(/<title>([^<]{2,120})<\/title>/);
  return b ? htmlUnescape(b[1]).replace(/\s*-\s*YouTube$/, '').trim() : '';
}

// 纯接口：拿轨道列表 + 标题；字幕正文多半拿不到（被 pot 拦），失败会提示用页面内抓
async function fetchSubtitleYoutubeByUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!isYtUrl(url)) throw new Error('不是 YouTube 链接（需 youtube.com/watch?v=... 或 youtu.be/...）');
  let html = '';
  try {
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    html = await res.text();
  } catch (e) {
    throw new Error('请求 YouTube 页面失败：' + (e && e.message ? e.message : e));
  }
  if (!html || html.length < 10000) throw new Error('YouTube 页面没有返回内容');
  const title = ytTitleFrom(html);
  const tracks = extractJsonArrayAfter(html, '"captionTracks":');
  if (!tracks || !tracks.length) {
    throw new Error('该视频没有字幕轨道（YouTube 未生成字幕，或该地区/该视频不提供字幕）');
  }
  const pick = ytPickTrack(tracks);
  if (!pick || !pick.baseUrl) throw new Error('没有可用的字幕地址');
  let body = '';
  try {
    const r2 = await fetch(pick.baseUrl + '&fmt=json3', { credentials: 'include', cache: 'no-store' });
    body = await r2.text();
  } catch (e) { /* 落到下面的提示 */ }
  if (!body || !body.trim()) {
    throw new Error('YouTube 对字幕请求加了校验（PoToken），纯接口拿不到正文。' +
      '请先打开这个视频页，在播放器里点开「字幕 / CC」并播放几秒，再从该页面点「笔记」按钮抓取');
  }
  return { lines: ytAnyToLines(body), title: title || 'YouTube 视频', source: 'YouTube 字幕（接口）' };
}

// 页面内注入（MAIN world 执行，才能读到页面的 ytInitialPlayerResponse 与注入钩子）
function ytGrabInPage() {
  return (async () => {
    // v3.7.94：失败时把诊断信息一起带回（钩子是否装上、缓存几条、资源里有几条 timedtext、
    // 轨道数、CC 按钮在不在），否则只能对着一句"抓取失败"瞎猜。
    const diag = { hook: false, cache: 0, perf: 0, tracks: 0, langs: '', cc: false, player: false };
    try {
      const pr = window.ytInitialPlayerResponse || {};
      const tl = (pr.captions && pr.captions.playerCaptionsTracklistRenderer) || {};
      const tracks = tl.captionTracks || [];
      const title = (pr.videoDetails && pr.videoDetails.title) || document.title || '';
      diag.tracks = tracks.length;
      diag.langs = tracks.map((t) => String(t.languageCode || t.vssId || '')).filter(Boolean).slice(0, 6).join(' ');
      diag.hook = !!window.__bnYtHook;
      diag.cc = !!document.querySelector('.ytp-subtitles-button');
      diag.player = !!document.querySelector('.html5-video-player');

      // 0) 页面钩子缓存（播放器播放/切字幕时已抓到过正文，最可靠）
      const cache = (window.__bnYtSubs || []).filter((x) => x && x.body && x.body.length > 20 && (Date.now() - (x.t || 0)) < 30 * 60 * 1000);
      diag.cache = cache.length;
      if (cache.length) {
        const zh = cache.find((x) => /lang=zh/i.test(String(x.url || ''))) || cache[cache.length - 1];
        return { ok: true, body: zh.body, title, via: 'hook', diag };
      }

      const tryUrls = [];
      // 1) 播放器已经请求过的 timedtext（带 pot）
      try {
        const res = performance.getEntriesByType('resource') || [];
        for (const x of res) {
          const n = x.name || '';
          if (/\/api\/timedtext/.test(n)) tryUrls.push(n);
        }
      } catch (e) { /* 忽略 */ }
      diag.perf = tryUrls.length;

      // 2) 轨道 baseUrl（页面上下文再试一次）
      let pick = null;
      if (tracks.length) {
        pick = tracks.find((t) => /^zh/i.test(String(t.languageCode || t.vssId || ''))) || tracks[0];
        if (pick && pick.baseUrl) tryUrls.push(pick.baseUrl + '&fmt=json3');
      }
      if (!tryUrls.length) {
        return {
          ok: false, title, diag,
          error: tracks.length ? '还没抓到字幕请求：请在播放器里点开「字幕 / CC」并播放几秒后重试' : '该视频没有字幕轨道'
        };
      }
      for (const u of tryUrls.slice().reverse()) {
        try {
          const r = await fetch(u, { credentials: 'include' });
          const t = await r.text();
          if (t && t.trim().length > 20) {
            return { ok: true, body: t, title, via: 'fetch', diag };
          }
        } catch (e) { /* 换下一个 */ }
      }
      return { ok: false, title, diag, error: '字幕请求都被拦了（服务端返回空，需要播放器自带的 PoToken）' };
    } catch (e) {
      return { ok: false, title: '', diag, error: (e && e.message) || String(e) };
    }
  })();
}

// v3.7.94：CDP 兜底——附加调试器监听网络，直接取播放器自己发出的 timedtext 响应体。
// 这条通路在浏览器网络层，不依赖页面钩子，也不受 fetch/XHR/track 实现方式影响。
async function ytGrabViaDebugger(tabId, timeoutMs) {
  const T = { tabId };
  let attached = false;
  const seen = new Map();
  const bodies = [];
  const pending = [];
  const onEvent = (source, method, params) => {
    if (!source || source.tabId !== tabId) return;
    try {
      if (method === 'Network.responseReceived') {
        const u = (params.response && params.response.url) || '';
        // v3.7.94：同时收 timedtext 与「显示文稿」get_transcript 两种请求
        if (u.indexOf('/api/timedtext') >= 0 || u.indexOf('/youtubei/v1/get_transcript') >= 0) seen.set(params.requestId, u);
      } else if (method === 'Network.loadingFinished') {
        const u = seen.get(params.requestId);
        if (!u) return;
        pending.push(new Promise((res) => setTimeout(res, 120))
          .then(() => chrome.debugger.sendCommand(T, 'Network.getResponseBody', { requestId: params.requestId }))
          .then((r) => {
            if (!r || !r.body) return;
            const body = r.base64Encoded ? atob(r.body) : r.body;
            if (body && String(body).trim().length > 20) bodies.push({ url: u, body: String(body) });
          }).catch(() => {}));
      }
    } catch (e) { /* 忽略 */ }
  };

  try {
    await chrome.debugger.attach(T, '1.3');
    attached = true;
  } catch (e) {
    const m = (e && e.message) || String(e);
    if (/another debugger|already attached/i.test(m)) {
      throw new Error('这个标签页已被其它调试器占用，请先关掉 DevTools 再重试');
    }
    throw new Error('无法附加调试器：' + m);
  }

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.sendCommand(T, 'Network.enable', {
      maxTotalBufferSize: 20000000,
      maxResourceBufferSize: 6000000,
      maxPostDataSize: 2000
    });
    // 让播放器重新发一次字幕请求：没开就点开；已经开着就关了再开（强制重新请求）
    try {
      await chrome.debugger.sendCommand(T, 'Runtime.evaluate', {
        expression: "(function(){var b=document.querySelector('.ytp-subtitles-button');" +
          "if(!b)return 'no-cc-button';var on=b.getAttribute('aria-pressed')==='true';b.click();" +
          "if(on){setTimeout(function(){b.click();},500);}return on?'toggled':'opened';})()",
        returnByValue: true
      });
    } catch (e) { /* 忽略：点不到按钮也继续等已有请求 */ }

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 300));
      if (bodies.length) break;
    }
    await Promise.all(pending).catch(() => {});
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    if (attached) { try { await chrome.debugger.detach(T); } catch (e) { /* 忽略 */ } }
  }

  if (!bodies.length) return null;
  return bodies.find((b) => /lang=zh/i.test(b.url)) || bodies[bodies.length - 1];
}

async function fetchSubtitleYoutubeFromTab(url) {
  const vid = ytVideoId(url);
  const tabs = await chrome.tabs.query({});
  let target = (tabs || []).find((t) => t.url && isYtUrl(t.url) && vid && t.url.indexOf(vid) >= 0);
  if (!target) target = (tabs || []).find((t) => t.url && isYtUrl(t.url) && t.active);
  if (!target || target.id == null) throw new Error('没有已打开的 YouTube 视频页（请先打开这个视频）');

  const res = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    world: 'MAIN',
    func: ytGrabInPage
  });
  const out = res && res[0] && res[0].result;
  const title0 = String((out && out.title) || 'YouTube 视频').replace(/\s*-\s*YouTube$/, '').trim();

  if (out && out.ok) {
    const lines = ytAnyToLines(out.body);
    if (lines && lines.length) {
      return {
        lines,
        title: title0 || 'YouTube 视频',
        source: out.via === 'hook' ? 'YouTube 字幕（页面钩子）' : 'YouTube 字幕（页面内）'
      };
    }
  }

  // 页面内两条通路都没拿到 → 用调试器在网络层抓播放器自己的响应
  let dbgErr = '';
  try {
    const dbg = await ytGrabViaDebugger(target.id, 9000);
    if (dbg) {
      const lines = ytAnyToLines(dbg.body);
      if (lines && lines.length) {
        return { lines, title: title0 || 'YouTube 视频', source: 'YouTube 字幕（调试器网络抓取）' };
      }
      dbgErr = '抓到了字幕响应但解析不出句子';
    } else {
      dbgErr = '播放器没有发出带 PoToken 的字幕请求';
    }
  } catch (e) {
    dbgErr = (e && e.message) || String(e);
  }

  // 把所有诊断拼进错误，用户一看就知道卡在哪一环
  const d = (out && out.diag) || {};
  const detail = [
    '钩子' + (d.hook ? '已注入' : '未注入'),
    '缓存' + (d.cache || 0) + '条',
    '资源记录' + (d.perf || 0) + '条',
    '字幕轨道' + (d.tracks || 0) + (d.langs ? '（' + d.langs + '）' : ''),
    d.cc ? '有CC按钮' : '无CC按钮',
    dbgErr ? '兜底：' + dbgErr : ''
  ].filter(Boolean).join('，');
  throw new Error(((out && out.error) || '从 YouTube 页面抓取失败') + '｜诊断：' + detail +
    '｜若一直失败：刷新这个 YouTube 页面后立刻点「抓取字幕」（钩子在页面加载时就装上，能直接拿到播放器请求）');
}

// 从已打开的小红书笔记页注入抓字幕（页面上下文 = 复用浏览器网络栈与登录态）
async function fetchSubtitleXhsFromTab(url) {
  const want = String(url || '');
  const noteId = (want.match(/(?:explore|item)\/([0-9a-zA-Z]{16,})/) || [])[1] || '';
  const tabs = await chrome.tabs.query({});
  let target = (tabs || []).find((t) => t.url && isXhsUrl(t.url) && noteId && t.url.indexOf(noteId) >= 0);
  if (!target) target = (tabs || []).find((t) => t.url && isXhsUrl(t.url) && t.active);
  if (!target) target = (tabs || []).find((t) => t.url && isXhsUrl(t.url));
  if (!target || target.id == null) throw new Error('没有已打开的小红书笔记页');
  const res = await chrome.scripting.executeScript({ target: { tabId: target.id }, func: xhsGrabInPage });
  const out = res && res[0] && res[0].result;
  if (!out || !out.ok) throw new Error((out && out.error) || '从小红书页面抓取失败');
  return {
    lines: srtToLines(out.srt),
    title: out.title || '小红书视频',
    source: '小红书 AI 字幕（页面内抓取）'
  };
}

// 从已打开的 B 站视频页"页面上下文"直接抓字幕（fetch 自动带页面 cookie = 复用 Edge 登录态，
// 不依赖 background service worker 的 cookie 传递；用户已打开视频页时优先走这条路）
const MIXIN_TAB_ARR = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

async function fetchSubtitleFromOpenTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
  if (!tabs.length) throw new Error('未找到已打开的 B 站视频页面：请先在 Edge 里打开这个视频（就是你现在的视频页），再点「抓取字幕」');
  const tab = tabs[tabs.length - 1];
  if (tab.id == null) throw new Error('B 站标签页无效');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (MIXIN_TAB_ARR) => {
      // 页面上下文执行：fetch 自动带页面 cookie（登录态）。注意：不能使用 eval（B站 CSP 禁止），MD5 直接写函数体。
      function md5(input) {
        function safeAdd(x, y) { const lsw = (x & 0xffff) + (y & 0xffff); return ((x >> 16) + (y >> 16) + (lsw >> 16) << 16) | (lsw & 0xffff); }
        function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
        const K = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
        const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
        const bytes = unescape(encodeURIComponent(String(input)));
        const len = bytes.length;
        const n = ((len + 8) >> 6) + 1;
        const blocks = new Array(n * 16).fill(0);
        for (let i = 0; i < len; i++) blocks[i >> 2] |= bytes.charCodeAt(i) << ((i % 4) * 8);
        blocks[len >> 2] |= 0x80 << ((len % 4) * 8);
        blocks[n * 16 - 2] = len * 8;
        let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
        for (let i = 0; i < blocks.length; i += 16) {
          const olda = a, oldb = b, oldc = c, oldd = d;
          for (let j = 0; j < 64; j++) {
            let f, g;
            if (j < 16) { f = (b & c) | (~b & d); g = j; }
            else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
            else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * j) % 16; }
            const tmp = d;
            d = c; c = b;
            b = safeAdd(b, bitRotateLeft(safeAdd(safeAdd(a, f), safeAdd(blocks[i + g], K[j])), S[j]));
            a = tmp;
          }
          a = safeAdd(a, olda); b = safeAdd(b, oldb); c = safeAdd(c, oldc); d = safeAdd(d, oldd);
        }
        return [a, b, c, d].map((w) => {
          w = w >>> 0;
          let s = '';
          for (let i = 0; i < 4; i++) s += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
          return s;
        }).join('');
      }
      const toLines = (body) => (Array.isArray(body) ? body : [])
        .map((x) => ({ t: Number(x.from) || 0, text: String(x.content || '').trim() }))
        .filter((x) => x.text);
      return (async () => {
        const bvid = (location.href.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] || '';
        if (!bvid) return { ok: false, error: '页面未找到 BV 号' };
        let pi = parseInt((new URL(location.href)).searchParams.get('p') || '1', 10) || 1;
        const view = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { credentials: 'include' })).json();
        if (!view || view.code !== 0 || !view.data) return { ok: false, error: '获取视频信息失败：' + ((view && view.message) || 'code=' + (view && view.code)) };
        const d = view.data;
        const aid = d.aid;
        const pages = d.pages || [];
        const target = pages[pi - 1] || pages[0];
        const cid = target ? target.cid : d.cid;
        // v3.7.40：多P合集优先用分P小标题（pages[i].part）作为笔记标题
        let title = d.title;
        if (pages.length > 1 && target && target.part) {
          const part = String(target.part).trim();
          if (part && !/^(第\s*\d+\s*集?|P\s*\d+|\d+)$/i.test(part)) title = part;
          else title = d.title + '（P' + pi + '/' + pages.length + '）';
        }
        let subs = [];
        // 1) v2 接口（页面上下文带 cookie，登录态直接可用）
        try {
          const player = await (await fetch('https://api.bilibili.com/x/player/v2?aid=' + aid + '&cid=' + cid, { credentials: 'include' })).json();
          subs = (player && player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
        } catch (e) { /* 继续 */ }
        // 2) 兜底：wbi 签名播放器接口（与播放器一致）
        if (!subs.length) {
          try {
            const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })).json();
            const wi = nav.data && nav.data.wbi_img;
            if (wi && wi.img_url && wi.sub_url) {
              const mixinKey = (orig) => { let s = ''; for (const i of MIXIN_TAB_ARR) s += orig[i]; return s.slice(0, 32); };
              const imgKey = wi.img_url.split('/').pop().split('.')[0];
              const subKey = wi.sub_url.split('/').pop().split('.')[0];
              const key = mixinKey(imgKey + subKey);
              const params = { aid: String(aid), cid: String(cid), wts: String(Math.floor(Date.now() / 1000)) };
              const sorted = Object.keys(params).sort().map((k) => k + '=' + encodeURIComponent(params[k].replace(/[!'()*]/g, ''))).join('&');
              const player = await (await fetch('https://api.bilibili.com/x/player/wbi/v2?' + sorted + '&w_rid=' + md5(sorted + key), { credentials: 'include' })).json();
              subs = (player && player.data && player.data.subtitle && player.data.subtitle.subtitles) || [];
            }
          } catch (e) { /* 忽略 */ }
        }
        if (!subs.length) return { ok: false, error: '没读到字幕：该分P可能没有AI字幕，或页面登录态失效。请确认视频播放器里能显示「字幕」' };
        const score = (s) => {
          const lan = (s.lan || '').toLowerCase();
          const doc = (s.lan_doc || '').toLowerCase();
          if (lan === 'zh-cn' || lan === 'zh-hans' || lan === 'zh-hant') return 5;
          if (lan === 'ai-zh') return 4;
          if (lan.indexOf('zh') === 0) return 3;
          if (doc.indexOf('中文') >= 0 || doc.indexOf('简体') >= 0 || doc.indexOf('繁体') >= 0) return 3;
          if (lan.indexOf('ai') === 0) return 2;
          return 1;
        };
        subs.sort((a, b) => score(b) - score(a));
        const cidStr = String(cid);
        const matched = subs.filter((s) => s.subtitle_url && String(s.subtitle_url).indexOf(cidStr) >= 0);
        const ordered = matched.length ? matched : subs;
        // 参照 Bili Clipper：逐个尝试下载（CC 字幕免登录；AI 字幕未登录 403 则跳过）
        let lastErr = null;
        for (const s of ordered) {
          let raw = s.subtitle_url || '';
          const url = raw.indexOf('//') === 0 ? 'https:' + raw : raw;
          if (url.indexOf('http') !== 0) continue;
          try {
            const data = await (await fetch(url, { credentials: 'include' })).json();
            const lines = toLines(data.body);
            if (lines.length) return { ok: true, lines, source: s.lan_doc || s.lan || '字幕', title, bvid, aid, cid, totalPages: pages.length };
          } catch (e) { lastErr = e; continue; }
        }
        if (lastErr) return { ok: false, error: '字幕文件下载失败（' + lastErr.message + '）。AI 字幕需登录 B 站，可尝试有 CC 字幕的视频' };
        return { ok: false, error: '没有读到可用字幕：该分P可能无字幕，或仅 AI 字幕且页面未登录' };
      })();
    },
    args: [MIXIN_TAB_ARR]
  });
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('在 B 站页面执行抓取失败');
  if (!r.ok) throw new Error(r.error);
  return { lines: r.lines, source: r.source, title: r.title, bvid: r.bvid, aid: r.aid, cid: r.cid, totalPages: r.totalPages };
}

// v3.7.67：批量专用字幕抓取——静默新建一个后台 B 站标签页（不打扰当前页面），
// 在页面上下文带 cookie 抓指定链接的字幕（AI 智能字幕必须带 B 站登录态；background 直连 fetch 不带 cookie 会失败），抓完即关。
// v3.7.73：页面锚定重构——字幕来源严格绑定「目标视频页」：
//   ① 复用只复用「同一视频、同一分P」的已开视频页（就是你正在看的那个页面），其他 B 站页面一律不用；
//   ② 无匹配页时精确打开带 p 参数的目标视频页，等页面数据就绪（__INITIAL_STATE__ 的 bvid 匹配）才抓；
//   ③ 抓取函数改用页面自身 location.href 解析 bvid/p（不再依赖传入链接），杜绝"不知道字幕从哪来"。
  function latexBlocksToDisplay(md) {
    return String(md || '').replace(/```latex\s*\n([\s\S]*?)```/g, (m, body) => {
      let inner = body.replace(/\s+$/g, '').trim();
      if (!inner) return m;
      // 去掉可能存在的完整 LaTeX 文档外壳（documentclass/usepackage/begin/end document）
      inner = inner
        .replace(/\\documentclass[^\n]*\n?/g, '')
        .replace(/\\usepackage\{[^}]*\}[^\n]*\n?/g, '')
        .replace(/\\begin\{document\}[^\n]*\n?|\n?\\end\{document\}/g, '')
        .trim();
      // 去掉可能包裹的单个 $ 或 $$（如此前版本包装的 $公式$）
      inner = inner.replace(/^\$\$?|\$\$?$/g, '').trim();
      // v3.7.50：块内若嵌套了 $...$（豆包在 ```latex 块内又包 $），去掉多余 $，保留内部 LaTeX
      inner = inner.replace(/\$([\s\S]*?)\$/g, '$1').trim();
      return '\n$$\n' + inner + '\n$$\n';
    });
  }

  // v3.7.97：行内公式收尾规整（与 content-doubao.js 同一份逻辑）——清花括号内 $、合并纯数学碎片、修半包
  const MATH_CJK = /[一-鿿，。；：、！？]/;

  function stripDollarsInBraces(line) {
    let prev;
    do {
      prev = line;
      line = line.replace(/\{([^{}]*)\}/g, (m, inner) => '{' + inner.replace(/\$/g, '') + '}');
    } while (line !== prev);
    return line;
  }

  function mergeMathFragments(line) {
    let changed = true;
    while (changed) {
      changed = false;
      const p = line.split('$');
      if (p.length < 4) break;
      for (let i = 1; i + 2 < p.length; i += 2) {
        const gap = p[i + 1];
        if (p[i] && p[i + 2] && !MATH_CJK.test(p[i]) && !MATH_CJK.test(gap) && !MATH_CJK.test(p[i + 2])) {
          const merged = p[i] + gap + p[i + 2];
          const np = p.slice(0, i).concat([merged], p.slice(i + 3));
          line = np[0] + '$' + np.slice(1).join('$');
          changed = true;
          break;
        }
      }
    }
    return line;
  }

  function fixHalfPair(line) {
    const math = '[^$一-鿿，。；：、！？]*';
    let prev;
    do {
      prev = line;
      line = line.replace(new RegExp('\\$(' + math + ')\\$(' + math + ')\\$', 'g'), (m, a, b) => '$' + a + b + '$');
    } while (line !== prev);
    return line;
  }

  function fixHalfWrapped(line) {
    line = line.replace(/(?<=[=+\-−×÷/^,(\[{_])\$/g, '');
    line = line.replace(/\$(?=[=+\-−×÷/^,)\]}_])/g, '');
    return line;
  }

  function balanceDanglingDollar(line) {
    if ((line.match(/\$/g) || []).length % 2 === 0) return line;
    const last = line.lastIndexOf('$');
    const tail = line.slice(last + 1);
    if (tail.trim() && /^[A-Za-z0-9_{}\\^+\-−×÷/=<>,.\s]*$/.test(tail)) return line + '$';
    return line.slice(0, last) + line.slice(last + 1);
  }

  function sanitizeLineMath(line) {
    let prev;
    let cur = line;
    do {
      prev = cur;
      cur = stripDollarsInBraces(cur);
      cur = mergeMathFragments(cur);
      cur = fixHalfPair(cur);
      cur = fixHalfWrapped(cur);
      cur = balanceDanglingDollar(cur);
    } while (cur !== prev);
    return cur;
  }

  function sanitizeInlineMath(md) {
    // v3.7.99：按行处理（与 content-doubao.js 同一份逻辑）。只有行首 `$$` 才是块边界；
    // 行内出现的 `$$`（行内公式被多插一个 $）一律折成 `$`，避免假 `$$` 把后续正文吞进公式块。
    const keep = [];
    const lines = String(md || '').split('\n');
    const out = [];
    let inFence = false;
    let inDisplay = false;
    for (const raw of lines) {
      const t = raw.trim();
      if (/^(```|~~~)/.test(t)) { inFence = !inFence; out.push(raw); continue; }
      if (inFence) { out.push(raw); continue; }
      if (/^\$\$/.test(t)) {
        const closedSameLine = /^\$\$[\s\S]*\$\$\s*$/.test(t) && t.length > 4;
        if (!closedSameLine) inDisplay = !inDisplay;
        out.push(raw);
        continue;
      }
      if (inDisplay) { out.push(raw); continue; }
      let line = raw.indexOf('$$') >= 0 ? raw.split('$$').join('$') : raw;
      line = line.replace(/`[^`\n]*`/g, (m) => { keep.push(m); return '\u0001K' + (keep.length - 1) + '\u0001'; });
      line = sanitizeLineMath(line);
      line = line.replace(/\u0001K(\d+)\u0001/g, (m, i) => keep[+i]);
      out.push(line);
    }
    return out.join('\n');
  }

  // 把正文里的物理量符号（IS、UT、UD、IDQ、rd、IF、UR、fM 等纯文本）转成行内公式 $...$，
  // 自动加下标；只处理非代码块/非公式块文本，避免破坏 LaTeX 公式块与 mermaid 思维导图。
  function inlineSymbolsToMath(md) {
    // v3.7.58：入口先压平豆包的嵌套下标变体（U_{I{UO}} → U_{IUO}、{I{UO}} → {IUO}），
    // 否则后续规则会把 {UO} 拆散单独补下标，越修越乱（消毒器只能处理"形状"，嵌套必须先还原成平面）
    let s = String(md || '').split('\n').map((line) => line
      .replace(/([A-Za-z]{1,2})_\{([A-Za-z0-9]+)\{([A-Za-z0-9]+)\}\}/g, '$1_{$2$3}')
      .replace(/\{([A-Za-z0-9]+)\{([A-Za-z0-9]+)\}\}/g, '{$1$2}')
    ).join('\n');
    // v3.7.47：把 LaTeX 行内/显示定界符 \(...\)、\[...\] 统一为 $...$、$$...$$（内部已是 LaTeX，避免二次转换破坏）
    let src = s.replace(/\\\(([^\\]*)\\\)/g, (m, c) => '$' + c + '$').replace(/\\\[([^\\]*)\\\]/g, (m, c) => '$$' + c + '$$');
    // v3.7.48：偏导数符号处理（∂2 → ∂^{2}、∂x2 → ∂x^{2}、∂^{2}φ → $∂^{2}φ$）——在分割前统一公式化，避免 x2 被兜底转成下标
    src = src.replace(/∂(\d)/g, '∂^{$1}').replace(/(∂[A-Za-z])(\d)/g, '$1^{$2}');
    // 长形式先转：∂^{2}φ / ∂^{2} / ∂x^{2}（后瞻放行 $，避免相邻公式被前一个的 $ 挡住匹配）
    src = src.replace(/(?<![A-Za-z0-9_$^{])∂\^\{[^}]*\}φ?(?![A-Za-z0-9_}\\]])/g, (m) => '$' + m + '$');
    src = src.replace(/(?<![A-Za-z0-9_$^{])∂[A-Za-z]\^\{[^}]*\}(?![A-Za-z0-9_}\\]])/g, (m) => '$' + m + '$');
    // 短形式：∂φ、∂x、∂ψ 等单独符号也公式化
    src = src.replace(/(?<![A-Za-z0-9_$^{])∂(?:[A-Za-z]|φ|ψ|θ|α|β)(?![A-Za-z0-9_$}])/g, (m) => '$' + m + '$');
    // v3.7.49：复数级数/极限等文本公式 → 标准 LaTeX（∑n=1∞zn、N→+∞limSN、n→∞limzn=0）
    src = src.replace(/∑([A-Za-z])=(\d+)∞([A-Za-z]+)/g, (m, a, b, c) => '\\sum_{' + a + '=' + b + '}^{\\infty} ' + (c.length === 2 ? c[0] + '_' + c[1] : c));
    src = src.replace(/∑([A-Za-z])=(\d+)∞/g, '\\sum_{$1=$2}^{\\infty}');
    src = src.replace(/([A-Za-z])→([+-]?)∞lim([A-Za-z]+)/g, (m, a, b, c) => '\\lim_{' + a + '\\to' + (b || '') + '\\infty} ' + (c.length === 2 ? c[0] + '_' + c[1] : c));
    // v3.7.50：lim 在前写法（limN→+∞、limn→∞，可后跟 $符号$ 一体转换）、∑ 在中间写法（n=1∑∞）、希腊字母 ρ、\left$| 畸形分隔符
    src = src.replace(/lim([A-Za-z])→([+-]?)∞\$([A-Za-z]{1,3})\$/g, (m, a, b, c) => '\\lim_{' + a + '\\to' + (b || '') + '\\infty} ' + (c.length === 2 ? c[0] + '_' + c[1] : c));
    src = src.replace(/lim([A-Za-z])→([+-]?)∞/g, (m, a, b) => '\\lim_{' + a + '\\to' + (b || '') + '\\infty}');
    // v3.7.82：∑i=1n（无 ∞ 的简写，豆包未按模板输出时常见）→ \sum_{i=1}^{n}；Unicode 条件竖线 ∣ → \mid
    src = src.replace(/∑([A-Za-z])=(\d+)([A-Za-z])/g, '\\sum_{$1=$2}^{$3}');
    src = src.replace(/∑([A-Za-z])=(\d+)∞/g, '\\sum_{$1=$2}^{\\infty}');
    src = src.replace(/\$?([A-Za-z])\$?=(\d+)∑∞\$([A-Za-z0-9_{}\\=^+\-]*)\$/g, '\\sum_{$1=$2}^{\\infty} $3');
    src = src.replace(/\$?([A-Za-z])\$?=(\d+)∑∞/g, '\\sum_{$1=$2}^{\\infty}');
    src = src.replace(/∑\$([A-Za-z]{1,2})(\d*)\$/g, (m, a, b) => '\\sum ' + a + (b ? '^{' + b + '}' : ''));
    src = src.replace(/(?<![A-Za-z0-9_$])ρ(?![A-Za-z0-9_])/g, '$\\rho$');
    src = src.replace(/\\left\$([|\\(])/g, '\\left$1').replace(/\\right\$([|\\)])/g, '\\right$1');
    // 裸 LaTeX（含 \sum/\lim/\int/\frac 命令但未包 $）→ 包 $（只匹配公式字符与空格分隔的后续公式片段，避免包进中文）
    src = src.replace(/(?<![A-Za-z0-9_$])[A-Za-z0-9_{}\\=^+\-,∞]*\\(?:sum|lim|int|frac|prod)[A-Za-z0-9_{}\\=^+\-,∞]*(?:[ \t]+[A-Za-z0-9_{}\\=^+\-,∞]+)*(?![A-Za-z0-9_$])/g, (m) => '$' + m + '$');
    const symbols = [
      // v3.7.45：稳压管系列（长项在前，避免被短项截胡）
      ['IZmin', 'I_{Z\\text{min}}'], ['IZmax', 'I_{Z\\text{max}}'], ['UZIZ', 'U_Z I_Z'],
      ['PZM', 'P_{ZM}'], ['UZ', 'U_Z'], ['IZ', 'I_Z'], ['PZ', 'P_Z'], ['rZ', 'r_Z'],
      ['UBR', 'U_{BR}'], ['UON', 'U_{ON}'], ['IDQ', 'I_{DQ}'], ['ICQ', 'I_{CQ}'], ['IBQ', 'I_{BQ}'],
      ['UCEQ', 'U_{CEQ}'], ['UCE', 'U_{CE}'], ['UBE', 'U_{BE}'], ['UCC', 'U_{CC}'], ['UDD', 'U_{DD}'],
      ['VCC', 'V_{CC}'], ['VDD', 'V_{DD}'],
      ['IF', 'I_F'], ['UR', 'U_R'], ['fM', 'f_M'], ['IS', 'I_S'], ['UT', 'U_T'], ['ID', 'I_D'], ['UD', 'U_D'],
      ['rd', 'r_d'], ['rbe', 'r_{be}'], ['rce', 'r_{ce}'], ['gm', 'g_m'],
      ['uI', 'u_I'], ['uO', 'u_O'], ['uD', 'u_D'], ['id', 'i_d'], ['iD', 'i_D'],
      ['iB', 'i_B'], ['iC', 'i_C'], ['iE', 'i_E'],
      ['UO', 'U_O'], ['UI', 'U_I'], ['IO', 'I_O'], ['II', 'I_I'],
      ['IC', 'I_C'], ['IB', 'I_B'], ['IE', 'I_E'], ['UC', 'U_C'], ['UB', 'U_B'], ['UE', 'U_E'],
      ['RL', 'R_L'], ['RB', 'R_B'], ['RC', 'R_C'], ['RE', 'R_E'], ['RS', 'R_S'],
      ['CE', 'C_E'], ['CB', 'C_B'], ['CC', 'C_C'],
      ['fH', 'f_H'], ['fL', 'f_L'], ['fT', 'f_T'], ['Au', 'A_u'], ['Av', 'A_v'], ['Ai', 'A_i'],
      ['U', 'U'], ['I', 'I'], ['Q', 'Q'], ['V', 'V'], ['R', 'R'], ['C', 'C'],
      ['L', 'L'], ['P', 'P'], ['N', 'N'], ['T', 'T']
    ];
    // 通用兜底时排除的常见英文词/缩写/单位，避免误伤
    const exclude = new Set(['is','ok','ai','tv','pc','usb','url','app','git','zip','pdf','exe','md','css','js','html','api','key','vip','qq','wx','up','b','to','of','in','on','at','the','and','for','with','as','by','or','an','be','it','no','yes','do','go','we','my','me','he','she','his','her','you','your','this','that','these','those','from','into','out','over','under','about','not','but','so','if','then','than','are','was','were','can','may','must','will','would','shall','have','has','had','does','did','etc','eg','ie','vs','mv','kv','uv','mw','kw','hz','khz','mhz','ghz','ma','ua','ms','us','ns','min','cm','mm','km','kg','mf','uf','nf','pf','cos','sin','tan','arg','ln','log','exp','re','im','lim','max','sec','csc','cot','res','tanh','coth','arctan','arcsin','arccos','det','dim','ker','inf','sup','grad','div','curl','mos','pm','nm']);
    // v3.7.53：希腊字母 → LaTeX 命令映射（α0 → \alpha_0 等）
    const greekCmd = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', θ: 'theta', λ: 'lambda', μ: 'mu', φ: 'phi', ψ: 'psi', ω: 'omega', σ: 'sigma', ε: 'epsilon', π: 'pi', τ: 'tau', η: 'eta', κ: 'kappa', ν: 'nu', ξ: 'xi', ρ: 'rho' };
    // 排除代码块（```...```）、公式块（$$...$$）、行内代码（`...`）；v3.7.47 起单 $ 公式也分割，避免已生成的 $\mathrm{Re}(z)$ 内部再被转出嵌套 $ 
    const parts = src.split(/(\$\$[\s\S]*?\$\$|```[\s\S]*?```|`[^`\n]*`|\$[^$\n]+\$)/g);
    let out = parts.map((p, i) => {
      if (i % 2 === 1) {
        // v3.7.86：公式块/代码块内不再猜下标。原 v3.7.50/v3.7.51 的"2~3 字母补下标"会把
        // $\frac{1}{2}mv^2$ 改成 m_v、$dx$ 改成 d_x、$LI^2$ 改成 L_I^2，是公式错误的主要来源。
        // 只保留 v3.7.82 的确定性 Unicode 修复（不猜测语义）。
        let s = p.replace(/∑([A-Za-z])=(\d+)([A-Za-z])/g, '\\sum_{$1=$2}^{$3}');
        s = s.replace(/∣/g, '\\mid ');
        return s;
      }
      // v3.7.47：上标整体转公式（<sup> 转来的 ^）：x^{2}、re^{iθ} → $...$，保持上标语义；（ ）边界排除以保护 LaTeX 定界符 \(...\)
      p = p.replace(/(?<![A-Za-z0-9_$^{\\])[A-Za-z]{1,3}\^\{[^}]*\}(?![A-Za-z0-9_$}\\]])/g, (m) => '$' + m + '$');
      p = p.replace(/(?<![A-Za-z0-9_$^{\\])[A-Za-z]{1,3}\^\d(?![A-Za-z0-9_$^}\\]])/g, (m) => '$' + m + '$');
      for (const [raw, tex] of symbols) {
        // 前后不能是字母/数字/下划线/$，避免误伤英文单词、单位（0.7V、26mV）、已生成的 $...$ 公式
        // v3.7.46：边界排除 {} 与反斜杠——避免把豆包已输出的 LaTeX 下标（如 U_{CE}）二次包裹成 $...$（否则渲染出 U_{C_E}）
        const re = new RegExp('(?<![A-Za-z0-9_${}\\\\])' + raw + '(?![A-Za-z0-9_${}\\\\])', 'g');
        p = p.replace(re, () => '$' + tex + '$');
      }
      // v3.7.65：字母+数字下标重组（RB2 → R_{B2}、RB1 → R_{B1}）——豆包输出 R 下标 B2 时可能写成 RB2 连写（无下划线标记）。
      // 必须在驼峰规则前跑：先转 RB2 使后续 VCC 等前导不再被数字挡住；前导放宽数字（RB2RB2 连写时第二个前是 2）
      p = p.replace(/(?<![A-Za-z_$\\])([A-Z][A-Za-z]{1,3})([0-9]{1,2})/g, (m, a, b) => {
        const lower = a.toLowerCase();
        if (exclude.has(lower) || ['usb','led','lcd','oled','cmos','tft','pwm','adc','dac','spi','uart','gpio','dma','tcp','udp','http','html','css','js','json','xml','sql','pdf','doc','txt','wav','mp3','mp4','avi','jpg','png','gif','cad','cam','fps','rms','min','max','avg','sum','log','main','page','size','time','data','code','file','text','read','view','edit','note','open','save','copy','menu','tool','home','mode','auto','word','byte','bit','chip','board','pcb','www','com','cn','org','net','edge','chrome','video','user','name','key','value','type','list','item','row','col'].indexOf(lower) >= 0) return m;
        return a[0] + '_{' + a.slice(1) + b + '}';
      });
      // v3.7.56：通用形态规则——不认符号认形状：连续大写驼峰（VGS/IDSS/Cgs/Rout 等）→ $首_{余}$，排除英文缩写/单词
      // v3.7.62：后瞻排除 { } （防误伤 LaTeX 下标 {CEQ}）；后导排除 ( （把 VGS(off) 留给 off 规则，避免先被驼峰吃掉）
      p = p.replace(/(?<![A-Za-z0-9_$\{}\\])([A-Z][A-Z][A-Za-z]{1,3}|[A-Z][a-z]{1,2}[A-Z][a-z]*)(?![A-Za-z0-9_$(\\])/g, (m, w) => {
        const lower = w.toLowerCase();
        if (exclude.has(lower)) return m;
        if (['mos','cpu','usb','gps','led','lcd','oled','cmos','tft','pwm','adc','dac','i2c','spi','uart','gpio','dma','tcp','udp','http','html','css','js','json','xml','sql','pdf','doc','txt','wav','mp3','mp4','avi','jpg','png','gif','diy','ok','id','ip','sos','cad','cam','fps','rms','rout','rin','text','read','view','edit','note','open','save','copy','paste','main','page','size','time','freq','data','code','file','icon','menu','tool','home','mode','auto','slow','fast','high','low','avg','bit','byte','word','chip','board','pcb'].indexOf(lower) >= 0) return m;
        return '$' + w[0] + '_{' + w.slice(1) + '}$';
      });
      // v3.7.55：电压/电流符号族（V/I/U 开头）—— VGS(off)VGS 分数连写、VGS(off)、VG_D 半转换、I_D、VGS 等 → 标准下标 LaTeX
      p = p.replace(/(?<![A-Za-z0-9_$\\])([UVI])([A-Z]{1,3})\(off\)([UVI])([A-Z]{1,3})(?![A-Za-z0-9_$\\])/g, (m, a, b, c, d) => '$' + a + '_{' + b + '(\\mathrm{off})}/' + c + '_{' + d + '}$');
      p = p.replace(/(?<![A-Za-z0-9_$\\])([UVI])([A-Z]{1,3})\(off\)(?![A-Za-z0-9_$\\])/g, (m, a, b) => '$' + a + '_{' + b + '(\\mathrm{off})}$');
      p = p.replace(/(?<![A-Za-z0-9_$\\{])([UVI])([A-Z]{1,2})_([A-Z]{1,3})(?![A-Za-z0-9_$\\])/g, (m, a, b, c) => '$' + a + '_{' + b + c + '}$');
      p = p.replace(/(?<![A-Za-z0-9_$\\{])([UVI])_([A-Z]{1,3})(?![A-Za-z0-9_$\\])/g, (m, a, b) => b.length === 1 ? '$' + a + '_' + b + '$' : '$' + a + '_{' + b + '}$');
      p = p.replace(/(?<![A-Za-z0-9_$\\{])([UVI])([A-Z]{1,3})(?![A-Za-z0-9_$\\])/g, (m, a, b) => b.length === 1 ? '$' + a + '_' + b + '$' : '$' + a + '_{' + b + '}$');
      // v3.7.52：文本中 2~3 字母连写紧邻数学运算符（=+-−·×≤≥,，;；）时，补下标并包 $（zn=xn+iyn → $z_n$=$x_n$+$iy_n$）
      p = p.replace(/(?<![A-Za-z0-9_$^{\\])([A-Za-z]{2,3})(?=[=+\-−·×≤≥,，;；])/g, (m, w) => {
        const lower = w.toLowerCase();
        if (exclude.has(lower)) return m;
        if (['cos','sin','tan','cot','sec','csc','arg','ln','log','exp','re','im','lim','max','min','sum','prod','int','sqrt','det','dim','ker','inf','sup','text','quad','qquad','infty','partial','dots','ldots','cdot','times','leq','geq','neq'].indexOf(lower) >= 0) return m;
        return '$' + w.slice(0, -1) + '_' + w.slice(-1) + '$';
      });
      // v3.7.55：括号后直接跟数字为幂次（(1−...)2 → (1−...)^2）
      p = p.replace(/\)(\d{1,2})(?![A-Za-z0-9_])/g, ')^$1');
      // v3.7.53：绝对值 ∣...∣ → $|...|$（内部希腊字母转 LaTeX、Unicode 减号转 -）
      p = p.replace(/∣([^∣\n]+)∣/g, (m, inner) => '$|' + inner.replace(/(α|β|γ|δ|θ|λ|μ|φ|ψ|ω|σ|ε|π|τ|η|κ|ν|ξ|ρ)(\d)/g, (x, g, d) => '\\' + greekCmd[g] + '_' + d).replace(/(α|β|γ|δ|θ|λ|μ|φ|ψ|ω|σ|ε|π|τ|η|κ|ν|ξ|ρ)/g, (x, g) => '\\' + greekCmd[g]).replace(/−/g, '-') + '|$');
      // v3.7.53：文本中希腊字母转 LaTeX 命令并包 $（含下标：α0 → $\alpha_0$）
      for (const g of Object.keys(greekCmd)) {
        p = p.replace(new RegExp('(?<![A-Za-z0-9_$\\\\])' + g + '(\\d)(?![A-Za-z0-9_$\\\\])', 'g'), (m, d) => '$\\' + greekCmd[g] + '_' + d + '$');
        p = p.replace(new RegExp('(?<![A-Za-z0-9_$\\\\])' + g + '(?![A-Za-z0-9_$\\\\])', 'g'), '$\\' + greekCmd[g] + '$');
      }
      // v3.7.54：留数算子（=−Res[f(z),∞] 等）整体转 $=-\mathrm{Res}[f(z),\infty]$（∞→\infty、−→-、字母数字补下标，f(z) 保持原样）
      p = p.replace(/(?<![A-Za-z0-9_$\\])(=?[−-]?)Res\[([^\]\n]+)\]/g, (m, pre, inner) => '$' + pre.replace(/−/g, '-') + '\\mathrm{Res}[' + inner.replace(/∞/g, '\\infty').replace(/−/g, '-').replace(/([A-Za-z])(\d)/g, '$1_$2') + ']$');
      // 通用兜底：中文/标点边界处的 1~3 字母（可带数字下标）串 → $...$（数字转下标）；| 为绝对值边界、括号/逗号内（函数调用/参数表）不包
      p = p.replace(/(?<![A-Za-z0-9_$|{\[(,，\\])[A-Za-z]{1,3}[0-9]*(?![A-Za-z0-9_$|(}\],，])/g, (m) => {
        const lower = m.toLowerCase();
        if (exclude.has(lower)) return m;
        if (/^p\d+$/i.test(m)) return m; // P5、P166 等分 P 标记不转
        const num = m.match(/^([A-Za-z]+)([0-9]+)$/);
        if (num) return '$' + num[1] + '_' + num[2] + '$';
        return '$' + m + '$';
      });
      return p;
    }).join('');
    // v3.7.47：修复分割块内（已生成公式）的旧版坏格式：稳压管符号无下标、虚数单位幂次
    // v3.7.51：最后清理 $$ 独占行块内嵌套 $（裸 LaTeX 包 $ 可能把块内 \sum 又包了一层）
    out = out.replace(/^[ \t]*\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$[ \t]*$/gm, (m, body) => '$$\n' + body.replace(/\$/g, '').split('\n').map(l => l.trim()).filter(Boolean).join('\n') + '\n$$');
    out = out.replace(/\$UZ\$/g, '$U_Z$').replace(/\$IZ\$/g, '$I_Z$').replace(/\$PZ\$/g, '$P_Z$').replace(/\$rZ\$/g, '$r_Z$').replace(/\$PZM\$/g, '$P_{ZM}$');
    // v3.7.86：删除 $i_1$ → $i^1$ 规则（下标不是上标，原规则会改错公式含义）
    // v3.7.57：形状归一化（LLM 公式消毒器）——LLM 的公式变形是有限形状（业界已验证：Four Shapes / remark-math-sanitizer），
    // 不穷举符号，只归一化几种形态变体：①行内 $ 内下划线（$z_n$、$V_GS$）②裸下划线（z_n、S_N、x_1）③裸 LaTeX 下标（无 $ 的 V_{GS}）
    // v3.7.58：新增两种更深的豆包变体——④缺下划线花括号（$A{i}$、I{IO}）⑤下标套下标（U_{I{UO}} 压平为 U_{IUO}，交给豆包再修语义）
    // 防嵌套：$$ 块先占位保护；$ 内位置（奇数个 $ 后）跳过，避免已在公式里又被包一层
    const mathBlocks = [];
    out = out.replace(/\$\$[\s\S]*?\$\$/g, (m) => { mathBlocks.push(m); return '\u0001BNB' + (mathBlocks.length - 1) + '\u0001'; });
    // ⑤嵌套下标压平：X_{Y{Z}} → X_{YZ}（先于裸 LaTeX 包 $ 执行，避免拆散）
    out = out.replace(/(?<![A-Za-z0-9_$\\])([A-Za-z]{1,2})_\{([A-Za-z0-9]+)\{([A-Za-z0-9]+)\}\}/g, (m, a, b, c, off, full) => {
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m;
      return '$' + a + '_{' + b + c + '}$';
    });
    // ⑤b 下划线式二次嵌套：X_{Y_{Z}} → X_{YZ}（豆包 U_{I{UO}} 被中间规则拆成 U_{I_{UO}} 的兜底压平）
    out = out.replace(/(?<![A-Za-z0-9_$\\])([A-Za-z]{1,2})_\{([A-Za-z0-9]+)_\{([A-Za-z0-9]+)\}\}/g, (m, a, b, c, off, full) => {
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m;
      return '$' + a + '_{' + b + c + '}$';
    });
    // v3.7.65：字母+花括号数字拆分重组（RB_{1} → R_{B1}）——豆包把 R 下标 B1 写成 RB_{1}（B 与数字拆错，Obsidian 渲染成 RB₁）
    // 只重组不包 $，留给 ⑥/529 整包
    out = out.replace(/(?<![A-Za-z0-9_$\\])([A-Za-z]{2,4})_\{([0-9]{1,2})\}(?![A-Za-z0-9_])/g, (m, a, b, off, full) => {
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m;
      return a[0] + '_{' + a.slice(1) + b + '}';
    });
    // ⑦v3.7.60：裸公式=数字 → 整体包 $（U_{I}=0 → $U_{I}=0$、U_{CEQ}=12V → $U_{CEQ}=12V$），先于⑥跑避免只包半边
    out = out.replace(/(?<![A-Za-z0-9_$\\])([A-Za-z]{1,2}(?:_\{[A-Za-z0-9]{1,4}\}|_[A-Za-z0-9]{1,4})[=+\-−×÷≤≥^][0-9]+(?:\.[0-9]+)?[A-Za-z]*)(?=[^A-Za-z0-9_{}\\])/g, (m, g1, off, full) => {
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m;
      return '$' + m + '$';
    });
    // ⑧v3.7.61：行内公式紧跟 =数字（$U_{I}$=0 → $U_{I}=0$），消除豆包/转换遗留的半包（$ 在 = 前导致 =0 外露）
    out = out.replace(/\$([A-Za-z0-9_{}\\^+\-−×÷≤≥.,]+)\$([=+\-−×÷≤≥^][0-9]+(?:\.[0-9]+)?[A-Za-z]*)(?=[^A-Za-z0-9_{}$\\])/g, (m, g1, g2) => m.indexOf('$$') >= 0 ? m : '$' + g1 + g2 + '$');
    // ⑥v3.7.59：裸公式串整体包 $（豆包把多个公式压成一行：V_{BB}=I_{BQ}R_B + U_{BEQ} → $V_{BB}=I_{BQ}R_B$ + $U_{BEQ}$）
    // 连续"裸 LaTeX 下标/裸下划线 + 可选运算符"串，整体包成行内公式，避免逐个包造成一半裸一半包的残次
    // v3.7.65：后导允许 $ ——R_{B2}R_{B2}$V_{CC}$（驼峰已转）连写时不再因 $ 回溯失败，整包 $R_{B2}R_{B2}$
    out = out.replace(/(?<![A-Za-z0-9_$\\])((?:[A-Za-z]{1,2}(?:_\{[A-Za-z0-9]{1,4}\}|_[A-Za-z0-9]{1,4})(?:[=+\-−×÷≤≥^](?=[A-Za-z]{1,2}(?:_\{|_)))?)+)(?![A-Za-z0-9_\\])/g, (m, body, off, full) => {
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m;
      // v3.7.64：包 $ 的同时把 body 内下划线式（R_B）内转为花括号式（R_{B}），避免 $R_B$ 内下标裸露
      const inner = body.replace(/([A-Za-z]{1,2})_([A-Za-z]{1,4}[0-9]*)/g, '$1_{$2}');
      return '$' + inner + '$';
    });
    // ④缺下划线花括号：$A{i}$ / 裸 I{IO} → A_{i} / I_{IO}（花括号内字母数字视为下标）
    out = out.replace(/\$([A-Za-z]{1,3})\{([A-Za-z0-9]{1,4})\}\$/g, (m, a, b) => '$' + a + '_{' + b + '}$');
    out = out.replace(/(?<![A-Za-z0-9_$\\])([A-Za-z]{1,3})\{([A-Za-z0-9]{1,4})\}(?![A-Za-z0-9_$])/g, (m, a, b, off, full) => {
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m;
      return '$' + a + '_{' + b + '}$';
    });
    out = out.replace(/\$([A-Za-z]{1,2})_([A-Za-z0-9]{1,3})\$/g, (m, a, b) => '$' + a + '_{' + b + '}$');
    out = out.replace(/(?<![A-Za-z0-9_$\\])([A-Za-z]{1,2})_([A-Za-z0-9]{1,3})(?![A-Za-z0-9_$])/g, (m, a, b, off, full) => {
      if (exclude.has((a + b).toLowerCase()) || /^p\d+$/i.test(a + b)) return m;
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m; // 已在 $...$ 内，跳过防嵌套
      return '$' + a + '_{' + b + '}$';
    });
    out = out.replace(/(?<![A-Za-z0-9_$\\])([A-Za-z]{1,2})_\{([A-Za-z0-9]{1,4})\}(?!\s*\$)/g, (m, a, b, off, full) => {
      const dollars = (full.slice(0, off).match(/\$/g) || []).length;
      if (dollars % 2 === 1) return m;
      return '$' + a + '_{' + b + '}$';
    });
    out = out.replace(/\u0001BNB(\d+)\u0001/g, (m, i) => mathBlocks[+i]);
    // v3.7.87：$ 插错位置修复
    // 模式：$ 后紧跟 1~2 字母 + (content)$，且 content 结尾 $ 后面紧跟 =、-、+ 等运算符或字母
    // 此时的 $[content] 中间 $ 是多余的，删掉它，让公式真正以结尾 $ 包裹
    // 例：$P(X=0)$=1-\frac{80}{81}=\frac{1}{81}$ → 删 P(X=0) )$ 的 $ → $P(X=0)=1-\frac{80}{81}=\frac{1}{81}$
    // 只处理确定无误的场景：$ 字母 ( 内容必须包含 = 或 \ 命令，确保是数学公式
    out = out.replace(/(\$)([A-Za-z]{1,2})\(([^$\n]{1,100}?)\$(?=[=+\-−×÷≤≥\s\w])/g,
      (m, d, letter, inner) => {
        if (inner.indexOf('=') >= 0 || inner.indexOf('\\') >= 0 || inner.indexOf('\\frac') >= 0) {
          return '$' + letter + '(' + inner;
        }
        return m; // 不满足条件，保持原状
      });
    // 第二条：若上面处理后剩下 $开头 $结尾...$中间的公式内容没被包，手动包一个
    out = out.replace(/(\$)([A-Za-z]+\([^$\n]+?)(=\s*[\d\w.\-]{1,20})\s+(\$)/g,
      (m, d, head, eq, d2) => {
        return d + head + eq + d;  // 首尾 $ 合并
      });
    // v3.7.97：转换出口跑收尾规整
    return sanitizeInlineMath(out);
  }

  // v3.7.56：公式残留形态检测——不认符号认形状，供"豆包二次修复"闭环使用（检测器稳定，修复交给懂语义的豆包）
  function detectMathResidue(md) {
    const hits = [];
    const excludes = new Set(['mos','cpu','usb','gps','led','lcd','oled','cmos','tft','pwm','adc','dac','spi','uart','gpio','dma','tcp','udp','http','html','css','js','json','xml','sql','pdf','doc','txt','wav','mp3','mp4','avi','jpg','png','gif','diy','ok','id','ip','sos','cad','cam','fps','rms','rout','rin','text','read','view','edit','note','open','save','copy','paste','main','page','size','time','freq','data','code','file','icon','menu','tool','home','mode','auto','www','com','cn','org','net','edge','chrome','video','bilibili','doubao','obsidian','latex','markdown','youtube','user','name','key','value','true','false','null','error','info','type','list','item','row','col','next','prev','left','right','top','bottom','new','old','big','small','good','bad','yes','no','end','any','all','min','max','avg','sum','log','test','demo','word','byte','bit','chip','board','pcb']);
    for (const line of String(md || '').split('\n')) {
      if (!line.trim()) continue;
      const trimmed = line.trim();
      // 剔除已渲染的 $...$ / $$...$$ 块，只看"漏网"部分
      const plain = line.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ');
      if (plain.indexOf('∑') >= 0 || plain.indexOf('∞') >= 0 || plain.indexOf('∂') >= 0 || plain.indexOf('∣') >= 0 || /[αβγδθλμφψωσπτ]/.test(plain)) { hits.push(trimmed.slice(0, 80)); continue; }
      // 未包裹等号：字母串 + =（x=3、VGS=VDS）
      let m;
      const reEq = /(?<![A-Za-z0-9])([A-Za-z]{1,4})\s*=[^=]/g;
      let eqHit = false;
      while ((m = reEq.exec(plain))) { if (!excludes.has(m[1].toLowerCase())) { eqHit = true; break; } }
      if (eqHit) { hits.push(trimmed.slice(0, 80)); continue; }
      // 未包裹驼峰大写串（VGS、IDSS、Cgs）
      const reCamel = /(?<![A-Za-z0-9])([A-Z]{2,4})(?![A-Za-z0-9])/g;
      let camelHit = false;
      while ((m = reCamel.exec(plain))) { if (!excludes.has(m[1].toLowerCase())) { camelHit = true; break; } }
      if (camelHit) { hits.push(trimmed.slice(0, 80)); continue; }
      // 未包裹"字母+数字"下标（R1、C1、x0）
      const reNum = /(?<![A-Za-z0-9])([A-Za-z]{1,2}\d{1,2})(?![A-Za-z0-9])/g;
      while ((m = reNum.exec(plain))) { if (/^p\d+$/i.test(m[1])) continue; hits.push(trimmed.slice(0, 80)); break; }
    }
    return [...new Set(hits)];
  }

  // v3.7.57：把豆包返回的修正行（带 [mm:ss] 前缀）合并回原笔记；匹配失败返回 null（走本地消毒版兜底）
  function mergeFixLines(base, fixAnswer) {
    const fixLines = String(fixAnswer || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!fixLines.length) return null;
    let merged = base;
    let replaced = 0;
    for (const fl of fixLines) {
      const mm = fl.match(/^(\[\d+:\d+\])(.*)$/);
      if (mm) {
        const prefix = mm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('^' + prefix + '.*$', 'm');
        if (re.test(merged)) { merged = merged.replace(re, fl); replaced++; }
      }
    }
    return replaced > 0 ? merged : null;
  }

  // v3.7.45：修复 Obsidian callout 折叠块渲染
  // 1) 连续 callout 之间加空行分隔（否则 Obsidian 会把多个折叠块合并成一个）
  // 2) 清理豆包回答尾部的自问自答行（一行含 2 个以上中文问号的连续行）
  function fixCallouts(md) {
    let s = String(md || '');
    // v3.7.75：豆包偶发输出裸 [!note]（缺 > 前缀）→ 补成标准 callout（否则 Obsidian 不渲染折叠块）
    s = s.replace(/^\[!note\]/gm, '> [!note]');
    s = s.replace(/^(> \[!.*)$/gm, '\n$1');
    s = s.replace(/\n{3,}/g, '\n\n');
    s = s.replace(/\n+([^\n]*？[^\n]*？[^\n]*)(\n[^\n]*？[^\n]*)*\s*$/g, '');
    return s.trim();
  }

  // v3.7.43：强制思维导图竖排——
  // 1) 无论豆包输出 graph/flowchart 的什么方向，统一转成 TD；
  // 2) 加 mermaid init（flowchart.rankDir=TB）强制自上而下布局（Obsidian 某些版本对 graph TD 也会横向渲染）
  function mindmapToTD(md) {
    return String(md || '').replace(/```mermaid\s*\n([\s\S]*?)```/g, (m, body) => {
      let inner = body.replace(/\s+$/g, '').trim();
      // 去掉豆包可能自带的 init 注释，避免重复/冲突
      inner = inner.replace(/^%%\{.*\}%%\s*\n?/gm, '');
      inner = inner.replace(/^(graph|flowchart)\s+(?!TD\b|TB\b)([A-Z]{2})\b/im, '$1 TD');
      inner = '%%{init: {"flowchart": {"rankDir": "TB"}}}%%\n' + inner;
      return '```mermaid\n' + inner + '\n```';
    });
  }



// v3.7.96：原始字幕追加到笔记末尾（折叠 callout）——保真的"原文可查"。
// 不经过豆包输出，所以不受 content-doubao 的 16000 字回答上限影响。
// ---------- v3.8.0：关键画面截图 + 时间戳跳转链接 ----------

function secToMmss(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? '0' + m : String(m)) + ':' + (r < 10 ? '0' + r : String(r));
}

function withBiliTime(url, sec) {
  const u = String(url || '').trim().split('#')[0];
  if (!/bilibili\.com\/video\//i.test(u)) return u;
  if (/[?&]t=\d+/.test(u)) return u.replace(/([?&])t=\d+/, '$1t=' + sec);
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 't=' + sec;
}

async function getObsCfg() {
  const items = await chrome.storage.local.get(['bn_obsidian_cfg']);
  const c = items.bn_obsidian_cfg || {};
  let base = String(c.apiUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) base = 'http://127.0.0.1:27123';
  let dir = (c.dir || '').replace(/^\/+|\/+$/g, '');
  if (/[\\:]/.test(dir) && /[\\]/.test(dir)) {
    const seg = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    dir = seg.length ? seg[seg.length - 1] : '';
  }
  return { base, key: c.apiKey || '', dir };
}

// 往库里写二进制（PNG）。Local REST API 会在父目录不存在时自动创建（本轮已实测：PUT → 204）
async function putVaultBinary(relPath, b64, mime) {
  const { base, key } = await getObsCfg();
  if (!key) throw new Error('未填 Obsidian API Key（请先在插件页「Obsidian 自动保存设置」里保存）');
  const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const res = await fetch(base + '/vault/' + encodeURI(relPath), {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': mime || 'image/png' },
    body: bin
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return relPath;
}

// v3.8.1：扩展在 edge://extensions 重新加载后，已打开页面里的旧内容脚本 runtime 通道会失效
// （页面还在，但不再响应消息，表现为 "Receiving end does not exist"）。这里补注入一次脚本再重试。
async function injectPageScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 300));
    return true;
  } catch (e) {
    return false;
  }
}

function errMsg(e) {
  return (e && e.message) ? e.message : String(e || '');
}

async function frameStats(b64) {
  // 判断截图是不是黑帧/白帧（解码不可用时返回 null，不误杀）
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    const ow = bmp.width;
    const oh = bmp.height;
    const W = 40;
    const H = 24;
    const cv = new OffscreenCanvas(W, H);
    const cx = cv.getContext('2d');
    if (!cx) { if (bmp.close) bmp.close(); return null; }
    cx.drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();
    const d = cx.getImageData(0, 0, W, H).data;
    const n = W * H;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      s += l;
      s2 += l * l;
    }
    const mean = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    const blank = (mean < 14 || mean > 242) && sd < 6;
    return { ow, oh, mean: Math.round(mean), sd: Math.round(sd), blank };
  } catch (e) {
    return null;
  }
}

// 只在用户已打开的视频页里截图，绝不新建标签页（遵守"不后台偷开页面"）
async function captureVideoFrames({ times, videoUrl, title }) {
  const list = (Array.isArray(times) ? times : [])
    .map((x) => Math.max(0, Math.floor(Number(x) || 0)))
    .filter((x, i, a) => a.indexOf(x) === i)
    .slice(0, 5);
  if (!list.length) return { ok: false, skipped: true, reason: '没有可用时间点' };

  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: '*://www.bilibili.com/video/*' }); } catch (e) { tabs = []; }
  if (!tabs.length) return { ok: false, skipped: true, reason: '没有打开该视频的 B 站页面（不会自动新建标签页）' };

  const bv = (String(videoUrl || '').match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] || '';
  let tab = bv ? (tabs.find((t) => (t.url || '').indexOf(bv) >= 0) || null) : null;
  if (!tab) tab = tabs.find((t) => t.active) || tabs[0];

  const tabId = tab.id;
  const { dir } = await getObsCfg();
  const safeTitle = String(title || '视频').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, '_').trim().slice(0, 36) || '视频';
  const folder = (dir ? dir + '/' : '') + 'attachments/';

  let attached = false;
  let injectCount = 0;
  let overrideOn = false;
  const frames = [];
  const errors = [];
  const notes = [];
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    // 视频页在后台标签时，合成器可能被节流、截出旧帧或黑帧；开启焦点模拟让它照常出画
    try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) { /* 内核不支持则忽略 */ }

    const measure = async (sec, first) => {
      const payload = { type: 'bnSeekMeasure', time: sec, first };
      let m = null;
      try {
        m = await chrome.tabs.sendMessage(tabId, payload);
      } catch (e) {
        // 扩展重载后旧页面脚本通道会失效 → 补注入一次再重试（不新开页面）
        if (injectCount < 2 && await injectPageScript(tabId)) {
          injectCount++;
          try {
            m = await chrome.tabs.sendMessage(tabId, payload);
          } catch (e2) {
            return { __err: errMsg(e2) + '（已补注入脚本仍失败，请刷新该视频页 F5 后重试）' };
          }
        } else {
          return { __err: errMsg(e) + '（补注入脚本失败，请刷新该视频页 F5 后重试）' };
        }
      }
      if (!m) return { __err: '页面没有回传画面区域' };
      if (!m.ok) return { __err: (m.error || '页面未取到画面') };
      return m;
    };

    const snap = async (x, y, w, h) => {
      const shot = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'png',
        clip: { x, y, width: w, height: h, scale: 1 },
        fromSurface: true,
        captureBeyondViewport: false
      });
      return (shot && shot.data) ? shot.data : null;
    };

    // 先量一次：播放器比视口还高就一定截不全，先把虚拟视口撑到够高（截完撤销）
    let m0 = await measure(list[0], true);
    if (m0.__err) throw new Error(m0.__err);
    if (m0.rect && Number(m0.rect.h) > (Number(m0.vh) || 0) - 80) {
      const wantH = Math.max(600, Math.ceil(Number(m0.rect.h) + 200));
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
          width: Math.max(320, Math.ceil(Number(m0.vw) || 1280)),
          height: wantH,
          deviceScaleFactor: 1,
          mobile: false
        });
        overrideOn = true;
        await new Promise((r) => setTimeout(r, 400));
        m0 = await measure(list[0], false);
      } catch (e) {
        overrideOn = false;
      }
    }

    for (let i = 0; i < list.length; i++) {
      const sec = list[i];
      const mm = secToMmss(sec);
      const m = (i === 0 && !overrideOn) ? m0 : await measure(sec, i === 0);
      if (m.__err) { errors.push(mm + ' ' + m.__err); continue; }

      // CDP clip 用文档坐标（视口坐标 + 滚动偏移），并夹在视口范围内
      const sx = Number(m.sx) || 0;
      const sy = Number(m.sy) || 0;
      const vw = Math.max(1, Number(m.vw) || 0);
      const vh = Math.max(1, Number(m.vh) || 0);
      let x = Math.round(Number(m.rect.x) + sx);
      let y = Math.round(Number(m.rect.y) + sy);
      let w = Math.round(Number(m.rect.w));
      let h = Math.round(Number(m.rect.h));
      x = Math.max(sx, Math.min(x, sx + vw - 1));
      y = Math.max(sy, Math.min(y, sy + vh - 1));
      w = Math.max(1, Math.min(w, sx + vw - x));
      h = Math.max(1, Math.min(h, sy + vh - y));
      if (w < 120 || h < 80) { errors.push(mm + ' 画面区域太小(' + w + 'x' + h + ')'); continue; }

      let data = null;
      try { data = await snap(x, y, w, h); } catch (e) { errors.push(mm + ' 截图失败 ' + errMsg(e)); continue; }
      if (!data) { errors.push(mm + ' 截图为空'); continue; }

      let st = await frameStats(data);
      if (st && st.blank) {
        // 可能是解码还没出画面：等一会儿在同一位置再截一次
        await new Promise((r) => setTimeout(r, 600));
        try {
          const again = await snap(x, y, w, h);
          if (again) data = again;
        } catch (e) { /* 保留上一张 */ }
        st = await frameStats(data);
      }
      if (st && st.blank) {
        errors.push(mm + ' 截到黑帧/白帧（实际 ' + st.ow + '×' + st.oh + '，该时间点可能未缓冲），已丢弃');
        continue;
      }
      // 期望输出像素 = 裁剪的 CSS 尺寸 × 设备像素比（高 DPI 下输出更大是正常的，不是裁边）
      const dpr = Number(m.dpr) || 1;
      const expW = Math.round(w * dpr);
      const expH = Math.round(h * dpr);
      if (st && st.ow && (Math.abs(st.ow - expW) > 6 || Math.abs(st.oh - expH) > 6)) {
        notes.push(mm + ' 实际 ' + st.ow + '×' + st.oh + '，期望 ' + expW + '×' + expH + '（裁剪 ' + w + '×' + h + ' @' + dpr + 'x）');
      }

      const file = folder + safeTitle + '-' + mm.replace(':', '') + '.png';
      try {
        await putVaultBinary(file, data, 'image/png');
        frames.push({ sec, file });
      } catch (e) {
        errors.push(mm + ' 写入库失败 ' + errMsg(e));
      }
    }
  } catch (e) {
    return { ok: false, error: (e && e.message ? e.message : String(e)), frames, errors, notes };
  } finally {
    if (overrideOn) { try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* 忽略 */ } }
    // 把视频还回原位置与原本的播放状态，并恢复被隐藏的控件
    try { await chrome.tabs.sendMessage(tabId, { type: 'bnRestorePlayback' }); } catch (e) { /* 忽略 */ }
    if (attached) { try { await chrome.debugger.detach({ tabId }); } catch (e) { /* 忽略 */ } }
  }
  return { ok: frames.length > 0, frames, errors, notes, tabUrl: tab.url || '', injected: injectCount > 0 };
}

// 关键节点行首的 [mm:ss] → 可点击跳转链接（原文折叠块每行以 "> " 开头，不会被匹配）
function addTimestampLinks(md, url) {
  if (!/bilibili\.com\/video\//i.test(String(url || ''))) return md;
  return String(md || '').split('\n').map((ln) => {
    const m = ln.match(/^(\s*(?:[-*]\s+)?)\[(\d{1,2}):(\d{2})\](?!\()(.*)$/);
    if (!m) return ln;
    const sec = (+m[2]) * 60 + (+m[3]);
    return m[1] + '[' + m[2] + ':' + m[3] + '](' + withBiliTime(url, sec) + ')' + m[4];
  }).join('\n');
}

function buildFramesSection(frames, url) {
  if (!frames || !frames.length) return '';
  const lines = frames.map((f) => {
    const mm = secToMmss(f.sec);
    const head = url ? '[' + mm + '](' + withBiliTime(url, f.sec) + ')' : '[' + mm + ']';
    return '- ' + head + '\n  ![[' + f.file + ']]';
  });
  return '\n\n## 六、关键画面（视频截图）\n> 点时间戳可跳回原视频对应画面；图片已存到库内，离线也能看。\n' + lines.join('\n') + '\n';
}

// v3.8.4：把截图插到「关键节点」里对应时间点那一行下面（不再堆到文末）
function insertFramesInline(md, frames) {
  const text = String(md || '');
  const lines = text.split('\n');
  const res = { text, placed: [], unmatched: [], noSection: false, inlined: 0 };
  if (!frames || !frames.length) return res;

  // 找标题含「关键节点」一类字样的板块（豆包偶尔写成"关键时间点/时间节点"），
  // 范围到下一个同级或更高级标题为止，避免把文末「附：原始字幕」折叠块算进来
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(#{1,6})\s/.test(lines[i]) && /关键节点|关键时间点|时间节点|关键画面节点/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) { res.noSection = true; res.unmatched = frames.slice(); return res; }

  const startLevel = (lines[start].match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s/);
    if (h && h[1].length <= startLevel) { end = i; break; }
  }

  const items = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^(\s*)(?:[-*]\s+)?\[(\d{1,2}):(\d{2})\]/);
    if (!m) continue;
    items.push({ i, sec: (+m[2]) * 60 + (+m[3]), lead: m[1], bullet: /^\s*[-*]\s+\[/.test(lines[i]) });
  }
  if (!items.length) { res.noSection = true; res.unmatched = frames.slice(); return res; }

  const buckets = new Map();
  const push = (at, file, indent) => {
    if (!buckets.has(at)) buckets.set(at, []);
    buckets.get(at).push(indent + '![[' + file + ']]');
  };
  const indentOf = (it) => it.lead + (it.bullet ? '  ' : '');

  const last = items[items.length - 1];
  // 幂等：目标行附近已经有这张图就不重复插（重试或二次保存不会叠图）
  const hasNear = (at, file) => {
    for (let k = at + 1; k <= Math.min(at + 3, lines.length - 1); k++) {
      if (lines[k].indexOf('![[' + file + ']]') >= 0) return true;
      if (k > at + 1 && /^\s*(?:[-*]\s+)?\[\d{1,2}:\d{2}\]/.test(lines[k])) break;
    }
    return false;
  };
  frames.forEach((f) => {
    const want = Math.floor(Number(f.sec) || 0);
    let best = null;
    items.forEach((it) => {
      const d = Math.abs(it.sec - want);
      if (d <= 90 && (!best || d < best.d)) best = { it, d };
    });
    if (best) {
      if (hasNear(best.it.i, f.file)) { res.placed.push(want); return; }
      push(best.it.i, f.file, indentOf(best.it));
      res.placed.push(want);
    } else {
      if (hasNear(last.i, f.file)) { res.placed.push(want); return; }
      // 90 秒内没有对应节点：放到板块最后一条下面，仍在内容区，不塞回文末
      push(last.i, f.file, indentOf(last));
      res.unmatched.push(f);
    }
  });

  // 从后往前插，避免索引漂移；同一行内保持 frames 的原顺序
  Array.from(buckets.keys()).sort((a, b) => b - a).forEach((at) => {
    lines.splice(at + 1, 0, ...buckets.get(at));
  });

  res.text = lines.join('\n');
  res.inlined = res.placed.length + res.unmatched.length;
  return res;
}

function buildSubsSection(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const body = lines.map((l) => '> ' + l).join('\n');
  return '\n\n## 附：原始字幕（可追溯）\n> [!note]- 字幕原文（共 ' + lines.length + ' 条，点开对照）\n' + body + '\n';
}

// v3.7.96：保真自检——笔记里出现、但字幕原文里没有的 [mm:ss]，基本就是豆包编造的。
// 只报警不改内容（不阻断保存），结果拼进保存成功的提示里。
function fidelityWarn(note, raw) {
  const subs = new Set();
  const re = /\[(\d{1,2}):(\d{2})\]/g;
  let m;
  while ((m = re.exec(String(raw || ''))) !== null) subs.add((+m[1]) * 60 + (+m[2]));
  if (!subs.size) return '';
  const bad = new Set();
  const re2 = /\[(\d{1,2}):(\d{2})\]/g;
  let m2;
  while ((m2 = re2.exec(String(note || ''))) !== null) {
    const sec = (+m2[1]) * 60 + (+m2[2]);
    if (!subs.has(sec)) bad.add(m2[0]);
  }
  if (!bad.size) return '';
  const list = Array.from(bad);
  return '保真自检：笔记里有 ' + list.length + ' 个时间戳字幕中不存在（' +
    list.slice(0, 3).join('、') + '），可能被编造，请对照文末原始字幕核对';
}

async function saveNoteToObsidian({ title, content, preprocessed, attachSubs }) {
  content = String(content || '');
  // v3.7.87：自动流程的公式转换已在 content script 的 finishAnswer 中完成（preprocessed=true），
  // 这里不再重复跑——同一套启发式规则跑两遍会二次误伤公式。手动保存/旧版内容脚本没有转换流程，仍在此兜底。
  if (!preprocessed) {
    content = inlineSymbolsToMath(latexBlocksToDisplay(mindmapToTD(fixCallouts(content))));
  }
  // v3.7.81：纯文本分数（24/49、7/8 等，豆包回答渲染丢失 annotation 或字幕直出文本分数）→ LaTeX \frac{}{}，
  // 防止存成 "4924" 这种粘连数字；已是 \frac 的不会被匹配（无裸 数字/数字）；日期（如 2026/10/31）前有 / 或数字，也不误伤
  // v3.7.87：包上 $...$——裸 \frac 在 Obsidian 中不渲染；已在 $...$ 内的数字/数字不会命中（前导 $ 被排除）
  content = content.replace(/(?<![A-Za-z0-9_{}\\$/])(\d{1,3})\s*\/\s*(\d{1,3})(?![A-Za-z0-9_}\\$])/g, (m, a, b) => (+b === 0 ? m : '$\\frac{' + a + '}{' + b + '}$'));
  // v3.7.82：过滤脏行——豆包未执行模板而把格式要求当正文输出（"标题，展开 2~4 条…"等）、
  // 以及抓进笔记的豆包界面残留（"展开全部"按钮文案、页面时间戳"今天 14:47"）
  // v3.7.84：再加"朗读"按钮残留、用户手动发的「公式修正请求」整段模板（豆包回答区含用户消息时会被抓到）
  content = content.split('\n').filter((ln) => {
    const l = ln.trim();
    if (!l) return true;
    if (/展开全部|收起全部/.test(l)) return false;
    if (/^朗读\s*(朗读\s*)*$/.test(l)) return false;
    if (/^今天\s*\d{1,2}:\d{2}$/.test(l)) return false;
    if (/标题，展开|只输出缺失部分|不要输出任何多余解释|不要重复已生成的内容|按 \[mm:ss\] 内容|呈现核心知识结构|该板块详细讲解|板块标题/.test(l)) return false;
    if (/^【公式修正请求】|必须改成 Obsidian 可渲染|必须改成标准 LaTeX|下面每一行里的公式都必须|禁止输出不带|禁止嵌套下标|禁止连写|只输出修正后的行|一行对应一行|不要输出任何其他内容|禁止改写或增删任何中文/.test(l)) return false;
    return true;
  }).join('\n');
  const items = await chrome.storage.local.get(['bn_obsidian_cfg', 'bn_src_subs']);
  // v3.7.96：自动保存时把本次发送的原始字幕追加到文末（保真可追溯）；手动保存（手动粘贴）不走这条路
  let subsWarn = '';
  let framesWarn = '';
  if (attachSubs) {
    const ss = items.bn_src_subs;
    // 6 小时内且是最近一次发送的字幕才追加：队列是串行的，不会把上一条字幕串到这一篇
    if (ss && ss.raw && Date.now() - (ss.at || 0) < 6 * 3600 * 1000) {
      subsWarn = fidelityWarn(content, ss.raw); // 先自检，再追加（否则文末原文会让所有时间戳都"存在"）
      // v3.8.0：两个按钮各自独立——时间戳跳转链接 / 关键画面截图
      const opt = await chrome.storage.local.get(['bn_ts_link', 'bn_frames']);
      if (opt.bn_ts_link === true && ss.url) {
        content = addTimestampLinks(content, ss.url);
      }
      const fr = opt.bn_frames;
      // 6 小时内且属于本次发送才用：与"新视频记成上一个"同一套防串号约束
      if (fr && Array.isArray(fr.frames) && fr.frames.length && Date.now() - (fr.at || 0) < 6 * 3600 * 1000) {
        // v3.8.4：图插在「关键节点」对应时间点下面；找不到该板块才退回文末大图块
        const inl = insertFramesInline(content, fr.frames);
        if (inl.noSection) {
          content = content.replace(/\s+$/, '') + buildFramesSection(fr.frames, ss.url || fr.url || '');
          framesWarn = '没找到「关键节点」板块，' + fr.frames.length + ' 张图放在了文末';
        } else {
          content = inl.text;
          if (inl.unmatched.length) {
            const miss = inl.unmatched.map((f) => secToMmss(f.sec)).join('、');
            framesWarn = inl.unmatched.length + ' 张图 90 秒内没找到对应节点，放在关键节点板块末尾（' + miss + '）';
            if (inl.placed.length) framesWarn += '；其余 ' + inl.placed.length + ' 张已插在对应时间点下面';
          } else {
            framesWarn = inl.placed.length + ' 张图已插在关键节点对应时间点下面';
          }
        }
      }
      try { chrome.storage.local.remove('bn_frames'); } catch (e) { /* 忽略 */ }
      content = content.replace(/\s+$/, '') + buildSubsSection(ss.raw);
      try { chrome.storage.local.remove('bn_src_subs'); } catch (e) { /* 忽略 */ }
    }
  }
  const c = items.bn_obsidian_cfg || {};
  let base = String(c.apiUrl || '').trim().replace(/\/+$/, '');
  let cfgWarn = '';
  // v3.7.92：API 地址被误填成扩展页地址（extension://xxx/app.html）或留空时，
  // 之前直接 throw → 每条笔记都存不进去，用户只看到"生成完没保存"。
  // 现在自动回落到默认本地地址，并把原因带回到页面提示里。
  if (!/^https?:\/\//.test(base)) {
    cfgWarn = 'API 地址「' + base + '」不是 http(s) 地址，已自动改用 http://127.0.0.1:27123';
    base = 'http://127.0.0.1:27123';
  }
  const key = c.apiKey || '';
  if (!key) throw new Error('__NOT_CONFIGURED__'); // 未配置 Obsidian，内容脚本会静默处理
  let dir = (c.dir || '').replace(/^\/+|\/+$/g, '');
  // 兼容 Windows 绝对路径：自动转为 vault 内相对路径（取最后一段）
  if (/[\\:]/.test(dir) && /[\\]/.test(dir)) {
    const seg = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    dir = seg.length > 0 ? seg[seg.length - 1] : '';
  }
  const safe = String(title || '视频笔记').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || '视频笔记';
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = safe + '-' + ts + '.md';
  const path = dir ? dir + '/' + filename : filename;

  // v3.7.92：写入重试一次（Obsidian 冷启动/Local REST API 刚唤醒时首个请求常失败），
  // 并把每次结果写进 storage（bn_last_save），下次出问题能直接查原因。
  async function putOnce() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      return await fetch(base + '/vault/' + encodeURI(path), {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'text/markdown; charset=utf-8' },
        body: '\uFEFF' + content,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function logSave(record) {
    try { chrome.storage.local.set({ bn_last_save: record }); } catch (e) { /* 忽略 */ }
  }

  let res;
  try {
    res = await putOnce();
    if (!res.ok && res.status >= 500) {
      await new Promise((r) => setTimeout(r, 800));
      res = await putOnce();
    }
  } catch (err) {
    const timeoutHit = err && err.name === 'AbortError';
    // 超时/网络错误再试一次
    try {
      await new Promise((r) => setTimeout(r, 800));
      res = await putOnce();
    } catch (err2) {
      const e2 = err2 && err2.name === 'AbortError' ? '超时12秒' : (err2 && err2.name ? err2.name : '未知错误');
      const msg = '连接 Obsidian 失败（' + e2 + '）：' + (err2 && err2.message ? err2.message : '') +
        '｜API地址=' + base + '｜目录=' + dir + '｜Key已配置=' + (key ? '是' : '否') +
        '（请确认 Obsidian 已打开且 Local REST API 插件已启用）';
      logSave({ ok: false, ts: Date.now(), error: msg, apiUrl: base, dir: dir });
      throw new Error(msg);
    }
  }
  if (!res.ok) {
    const msg = 'Obsidian 写入失败 HTTP ' + res.status + '：请确认 Obsidian 已打开、Local REST API 插件已启用，且 API 地址与 Key 正确（当前地址 ' + base + '，目录 ' + (dir || '根目录') + '）';
    logSave({ ok: false, ts: Date.now(), error: msg, apiUrl: base, dir: dir });
    throw new Error(msg);
  }
  logSave({ ok: true, ts: Date.now(), path: path, apiUrl: base });
  // v3.7.87：返回对象与调用方统一（content-doubao / app 均读取 resp.data.path，此前返回裸字符串会显示 undefined）
  return { path, warn: [cfgWarn, subsWarn, framesWarn].filter(Boolean).join('；') };
}

// 用 CDP（chrome.debugger）向豆包页发送真实回车（合成键盘事件 React 不响应，此事件 isTrusted=true）
async function pressEnterReal() {
  const tabs = await chrome.tabs.query({ url: 'https://www.doubao.com/*' });
  const tab = tabs.find((t) => !t.pinned);
  if (!tab || tab.id == null) return { ok: false, error: '未找到豆包标签页' };
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    // CDP 回车前先聚焦输入框（tab 刚激活/欢迎页切换时焦点可能不在输入框，回车会落空）
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', {
        expression: "(function(){var el=document.querySelector('textarea,[contenteditable],[role=\"textbox\"]');if(el){el.focus();try{el.click();}catch(e){}}return true;})()"
      });
    } catch (e1) { /* 聚焦失败不阻断，继续尝试回车 */ }
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
    await chrome.debugger.detach({ tabId: tab.id });
    return { ok: true };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch (e2) { /* 忽略 */ }
    return { ok: false, error: e.message };
  }
}

// ========== 链接队列（v3.7.79：删掉批量状态机，回到单条界面）==========
// 只存"链接列表 + 当前序号"。content 保存笔记成功后发 bnNoteDone（"笔记记录完成"信号），
// 这里自动推进到下一个链接；app 页轮询到 bn_queue.current 变化后，把链接填进单条输入框并自动抓字幕。
const QUEUE_KEY = 'bn_queue';

function queueGet() {
  return new Promise((resolve) => chrome.storage.local.get([QUEUE_KEY], (it) => resolve(it[QUEUE_KEY] || null)));
}
function queueSet(q) {
  return new Promise((resolve) => chrome.storage.local.set({ [QUEUE_KEY]: q }, () => resolve()));
}

async function bnQueueSet(links) {
  // v3.7.71 校验双保险：坏链接（含 … 省略号、一行两个 http）在 background 也拦截，防丢 p 参数抓错分P
  // v3.7.89：新增小红书笔记链接（有 xsec_token，链接里天然只有一个 http）
  const okOne = (s) => {
    const t = String(s || '').trim();
    if (!t || t.indexOf('…') >= 0) return '';
    if (t.indexOf('http') < 0 || t.indexOf('http') === t.lastIndexOf('http')) {
      if (/\/video\/(BV[0-9A-Za-z]+)/.test(t)) return t;
      if (isXhsUrl(t)) return t;
      if (isYtUrl(t) && ytVideoId(t)) return t;
    }
    return '';
  };
  const urls = (links || []).map(okOne).filter(Boolean);
  if (!urls.length) return { ok: false, error: '没有有效链接（支持 B 站 / 小红书 / YouTube：BVxxxx、xiaohongshu.com/explore/xxxx、youtube.com/watch?v=xxxx）' };
  await queueSet({ links: urls, index: -1, current: '', currentIndex: -1, active: false, lastMsg: '已放入 ' + urls.length + ' 个链接，点「开始逐个处理」' });
  return { ok: true, count: urls.length };
}

async function bnQueueStart() {
  const q = await queueGet();
  if (!q || !q.links || !q.links.length) return { ok: false, error: '队列为空' };
  await queueSet({ ...q, active: true, index: -1, current: '', currentIndex: -1, lastMsg: '开始逐个处理…' });
  return bnQueueNext();
}

// 推进到下一个链接（由"笔记记录完成"信号或用户点「跳过当前」触发）
async function bnQueueNext() {
  const q = await queueGet();
  if (!q) return { ok: true };
  const next = q.index + 1;
  if (next >= q.links.length) {
    await queueSet({ ...q, active: false, index: q.links.length, current: '', currentIndex: -1, lastMsg: '全部处理完毕（共 ' + q.links.length + ' 个）' });
    return { ok: true, done: true };
  }
  const link = q.links[next];
  await queueSet({ ...q, index: next, current: link, currentIndex: next, active: true, lastMsg: '第 ' + (next + 1) + '/' + q.links.length + ' 个' });
  return { ok: true, url: link, index: next };
}

async function bnQueueClear() {
  await queueSet({ links: [], index: -1, current: '', currentIndex: -1, active: false, lastMsg: '队列已清空' });
  return { ok: true };
}

// "笔记记录完成"信号：content 保存进 Obsidian（成功/失败）后发 bnNoteDone → 自动填下一个链接
async function bnQueueOnNoteDone(msg) {
  const q = await queueGet();
  if (!q || !q.active || q.currentIndex < 0) return { ok: true };
  await queueSet({ ...q, lastMsg: (msg && msg.ok ? '笔记已记录：' : '处理失败：') + ((msg && msg.title) || '第 ' + (q.currentIndex + 1) + ' 个') });
  return bnQueueNext();
}

// 打开或切换到豆包网页（已打开则聚焦，未打开则新建标签页）
async function openDoubaoTab() {
  const url = 'https://www.doubao.com/chat/';
  const tabs = await chrome.tabs.query({ url: 'https://www.doubao.com/*' });
  const hit = tabs.find((t) => !t.pinned);
  if (hit && hit.id != null) {
    // 优先直接向已打开的豆包页注入脚本（无需刷新页面，不丢聊天记录、可连续发送）。
    // 页面已有脚本时脚本内部会跳过初始化并直接触发一次发送检查。
    try {
      await chrome.scripting.executeScript({
        target: { tabId: hit.id },
        files: ['content-doubao.js']
      });
    } catch (e) {
      // 注入失败（极少见）：退回刷新页面，确保脚本生效
      try { await chrome.tabs.reload(hit.id); } catch (e2) { /* 忽略 */ }
    }
    await chrome.tabs.update(hit.id, { active: true });
    if (hit.windowId != null) await chrome.windows.update(hit.windowId, { focused: true });
    return { alreadyOpen: true };
  }
  const created = await chrome.tabs.create({ url, active: true });
  return { alreadyOpen: false, tabId: created.id };
}

// 打开网页式入口（可携带 B 站链接参数）
function openApp(url) {
  const base = chrome.runtime.getURL('app.html');
  const target = url ? base + '?url=' + encodeURIComponent(url) : base;
  return chrome.tabs.create({ url: target, active: true });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'fetchSubtitle':
        return await fetchSubtitle(msg);
      case 'fetchSubtitleByUrl':
        return await fetchSubtitleByUrl(msg);
      case 'fetchSubtitleFromOpenTab':
        return await fetchSubtitleFromOpenTab();
      case 'fetchSubtitleXhs':
        return await fetchSubtitleXhsByUrl(msg.url);
      case 'fetchSubtitleXhsFromTab':
        return await fetchSubtitleXhsFromTab(msg.url);
      case 'fetchSubtitleYoutube':
        return await fetchSubtitleYoutubeByUrl(msg.url);
      case 'fetchSubtitleYoutubeFromTab':
        return await fetchSubtitleYoutubeFromTab(msg.url);
      case 'openDoubao':
        return await openDoubaoTab();
      case 'pressEnterReal':
        return await pressEnterReal();
      case 'saveNoteToObsidian':
        return await saveNoteToObsidian({ title: msg.title, content: msg.content, preprocessed: msg.preprocessed === true, attachSubs: msg.attachSubs === true });
      case 'bnQueueSet':
        return await bnQueueSet(msg.urls || []);
      case 'bnQueueStart':
        return await bnQueueStart();
      case 'bnQueueNext':
        return await bnQueueNext();
      case 'bnQueueClear':
        return await bnQueueClear();
      case 'bnQueueGet':
        return await queueGet();
      case 'bnNoteDone':
        // "笔记记录完成"信号 → 自动把下一个链接填进单条输入框
        return await bnQueueOnNoteDone(msg);
      case 'openUri':
        // 用浏览器打开自定义协议 URI（如 obsidian://new?...），触发 Obsidian 等本地应用处理
        await chrome.tabs.create({ url: msg.uri, active: false });
        return { opened: true };
      case 'openApp':
        return await openApp(msg.url);
      case 'captureVideoFrames':
        return await captureVideoFrames({ times: msg.times, videoUrl: msg.videoUrl, title: msg.title });
      default:
        throw new Error('未知消息类型');
    }
  })()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true; // 保持消息通道开放以支持异步响应
});

// 点击工具栏图标 → 打开网页式入口
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html'), active: true });
});
