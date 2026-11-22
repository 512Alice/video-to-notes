// B站学习笔记助手 - 网页式入口
// 输入 B 站链接 → 抓字幕 → 一键发送豆包整理（六板块结构化笔记：思维导图 / 核心要点 / 术语表 / 易错点与疑问 / 关键节点 / 原始字幕）→ 可选自动存入 Obsidian。

(() => {
  const PENDING_KEY = 'bn_pending_submit';
  const OB_CFG_KEY = 'bn_obsidian_cfg';
  const $ = (sel) => document.querySelector(sel);

  // 环境检测：页面必须通过扩展加载（chrome-extension://）才能调用扩展 API。
  // 直接双击 app.html（file://）打开时 chrome API 不存在，给出明确引导。
  const hasExtApi = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.sendMessage;
  if (!hasExtApi) {
    const statusEl = document.querySelector('#bn-status');
    if (statusEl) {
      statusEl.textContent = '当前页面是用文件方式直接打开的，无法工作。请按下面步骤使用：\n' +
        '① 在 Edge 地址栏输入 edge://extensions，打开左下角「开发人员模式」；\n' +
        '② 点「加载解压缩的扩展」，选择 bilibili-note-extension 文件夹；\n' +
        '③ 点浏览器工具栏的蓝色「B」图标打开本页面（或在 B 站视频页点右下角「笔记」按钮）。';
    }
    const startBtn = document.querySelector('#bn-start');
    const sendBtn = document.querySelector('#bn-send');
    if (startBtn) startBtn.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    return;
  }

  const state = {
    lines: null,
    title: '',
    raw: '',
    // v3.8.0：记录本次抓取所用链接，供"时间戳跳转链接 / 关键画面截图"使用
    url: '',
    // v3.7.95：队列模式下列表里还有下一个链接时，抓完字幕自动发送（不再需要手动点「发送到豆包整理」）；
    // 单条模式仍然保持"抓取→你核对→手动点发送"的人工确认，避免误发。
    autoSend: false
  };

  // 平台：bili / xhs / yt。切换键只决定默认提示与校验；实际抓取会按链接自身识别（自动纠正）。
  const PLAT_META = {
    bili: {
      name: 'B站',
      placeholder: '粘贴 B 站视频链接，如 https://www.bilibili.com/video/BV1xx411c7mD',
      hint: '支持分 P：在链接后加 &p=3 表示第 3 集（不加默认第 1 集）。'
    },
    xhs: {
      name: '小红书',
      placeholder: '粘贴小红书笔记链接，如 https://www.xiaohongshu.com/explore/xxxxx?xsec_token=...',
      hint: '请粘贴完整链接（带 xsec_token）。小红书不是每个视频都有字幕；想让抓取最稳，就先在该笔记页点右下角「笔记」按钮。'
    },
    yt: {
      name: 'YouTube',
      placeholder: '粘贴 YouTube 链接，如 https://www.youtube.com/watch?v=xxxxxxxxxxx',
      hint: 'YouTube 对字幕加了校验：请先打开该视频页、在播放器里点开「字幕 / CC」并播放几秒，再点「抓取字幕」。'
    }
  };
  let plat = 'bili';

  function setPlat(p) {
    if (!PLAT_META[p]) return;
    plat = p;
    document.querySelectorAll('.plat-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.plat === p);
    });
    const urlEl = $('#bn-url');
    if (urlEl) urlEl.placeholder = PLAT_META[p].placeholder;
    const hintEl = $('#bn-plat-hint');
    if (hintEl) hintEl.textContent = PLAT_META[p].hint;
  }

  // 按链接识别真实平台（链接和切换键不一致时以链接为准）
  function detectPlat(u) {
    const s = String(u || '');
    if (/bilibili\.com\/video\//.test(s)) return 'bili';
    if (/(xiaohongshu\.com|rednote\.com)\/(explore|discovery\/item|item|discovery)\//.test(s)) return 'xhs';
    if (/(youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/.test(s)) return 'yt';
    return '';
  }

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

  function setStatus(text) {
    const el = $('#bn-status');
    el.textContent = text;
    el.classList.remove('err');
  }

  function setFail(text) {
    const el = $('#bn-status');
    el.textContent = text;
    el.classList.add('err');
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function linesToRaw(lines) {
    return lines.map((ln) => '[' + fmtTime(ln.t) + '] ' + ln.text).join('\n');
  }

  function getP(url) {
    const m = String(url || '').match(/[?&]p=(\d+)/);
    return m ? m[1] : '';
  }

  // ---------- 抓字幕 ----------

  async function onStart(opts) {
    const auto = !!(opts && typeof opts === 'object' && opts.auto === true) || state.autoSend;
    const url = $('#bn-url').value.trim();
    const meta = PLAT_META[plat];
    if (!url) { setStatus('请先粘贴' + meta.name + '视频链接'); return; }
    const actual = detectPlat(url);
    if (!actual) {
      setStatus('链接格式不对：' + PLAT_META[plat].name + ' 需要 ' +
        (plat === 'bili' ? 'bilibili.com/video/BVxxxx'
          : plat === 'xhs' ? 'xiaohongshu.com/explore/xxxx 或 rednote.com/discovery/item/xxxx'
            : 'youtube.com/watch?v=xxxx / youtu.be/xxxx') + ' 形式的链接');
      return;
    }
    if (actual !== plat) {
      setPlat(actual); // 链接是哪家就按哪家抓，切换键跟着纠正
      setStatus('链接属于' + PLAT_META[actual].name + '，已自动切到对应平台…');
    }

    const btn = $('#bn-start');
    btn.disabled = true;
    btn.textContent = '抓取中…';
    let grabbed = false;

    // 清空上一次的字幕，避免旧内容残留被误用
    state.lines = null;
    state.title = '';
    state.raw = '';
    $('#bn-video-title').textContent = '—';
    $('#bn-count').textContent = '0';
    $('#bn-subtitle').textContent = '正在抓取…';
    $('#bn-send').disabled = true;

    try {
      setStatus('正在抓取字幕…');
      let r = null;
      if (actual === 'xhs') {
        // 小红书：优先从已打开的小红书笔记页里抓（页面上下文最稳）；
        // 没开页面时退回接口（笔记页 SSR 里直接带字幕 SRT 地址）
        try {
          r = await sendToBg({ type: 'fetchSubtitleXhsFromTab', url });
        } catch (e1) { r = null; }
        if (!r || !r.ok) {
          r = await sendToBg({ type: 'fetchSubtitleXhs', url });
        }
      } else if (actual === 'yt') {
        // YouTube：优先页面内抓（播放器开 CC 后发出的请求带 PoToken）；接口只作兜底
        try {
          r = await sendToBg({ type: 'fetchSubtitleYoutubeFromTab', url });
        } catch (e1) { r = null; }
        if (!r || !r.ok) {
          r = await sendToBg({ type: 'fetchSubtitleYoutube', url });
        }
      } else {
        // B 站：优先从已打开的 B 站视频页内抓（复用页面登录态，最可靠）；失败再走纯接口
        try {
          r = await sendToBg({ type: 'fetchSubtitleFromOpenTab' });
        } catch (e0) { /* 无已打开页面，走接口 */ }
        if (!r || !r.ok) {
          r = await sendToBg({ type: 'fetchSubtitleByUrl', url, p: getP(url) });
        }
      }
      if (!r.ok) {
        setFail('抓取失败：' + r.error + (actual === 'xhs'
          ? '（小红书不是每个视频都有字幕轨道，换一个带字幕的视频笔记试试）'
          : actual === 'yt'
            ? '（YouTube 需先打开视频页并开启「字幕/CC」播放几秒；该视频也可能本来就没字幕）'
            : '（请确认已打开该视频页面并登录 B 站；或该视频确实没生成字幕，换一个视频试试）'));
        return;
      }

      state.lines = r.data.lines;
      state.title = r.data.title;
      state.raw = linesToRaw(r.data.lines);
      state.url = url;
      $('#bn-video-title').textContent = r.data.title;
      $('#bn-count').textContent = state.lines.length;
      $('#bn-subtitle').textContent = state.raw;
      $('#bn-send').disabled = false;
      setStatus('已获取 ' + state.lines.length + ' 条字幕（约 ' + (state.raw.length / 1000).toFixed(1) + 'k 字，来源：' + r.data.source + '）。请先核对下方字幕开头确实属于该视频，再发送。');
      // v3.8.0：按开关自动截关键画面（只在已打开的 B 站页面里截，不新开标签页）
      await maybeCaptureFrames();
      grabbed = true;
    } catch (e) {
      setFail('抓取失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '抓取字幕';
      // v3.7.95：队列模式下抓完直接把这条发出去，不用再手动点「发送到豆包整理」
      if (grabbed && auto) setTimeout(() => { onSend({ auto: true }); }, 200);
    }
  }

  // ---------- v3.8.0：关键画面截图（由开关控制） ----------

  function stGet(keys) {
    return new Promise((res) => {
      try { chrome.storage.local.get(keys, (it) => res(it || {})); } catch (e) { res({}); }
    });
  }
  function stSet(obj) {
    return new Promise((res) => {
      try { chrome.storage.local.set(obj, () => res(true)); } catch (e) { res(false); }
    });
  }

  // 从字幕里挑"画面感"最强的时间点；一个都挑不到时均匀取样
  function pickFrameTimes(lines) {
    const KEY = /(这张图|图中|如图|看这里|看这个|看图|曲线|波形|特性曲线|电路|接线|接法|板子|示波|参数表|表格|示意图|画|这个位置)/;
    const cand = [];
    (lines || []).forEach((ln) => {
      const t = Number(ln && ln.t);
      if (!isFinite(t) || t <= 0) return;
      if (!KEY.test(String((ln && ln.text) || ''))) return;
      cand.push(Math.floor(t));
    });
    const out = [];
    cand.forEach((sec) => { if (!out.some((x) => Math.abs(x - sec) < 25)) out.push(sec); });
    if (out.length) return out.slice(0, 5);
    const last = (lines && lines.length) ? Number(lines[lines.length - 1].t) : 0;
    if (!isFinite(last) || last < 90) return [];
    const picked = [];
    for (let i = 1; i <= 4; i++) picked.push(Math.floor((last * i) / 5));
    return picked;
  }

  async function maybeCaptureFrames() {
    const it = await stGet({ bn_frames_on: false });
    if (!it.bn_frames_on) return;
    const baseMsg = '已获取 ' + state.lines.length + ' 条字幕（约 ' + (state.raw.length / 1000).toFixed(1) + 'k 字）。请先核对下方字幕开头确实属于该视频，再发送。';
    if (!/bilibili\.com\/video\//.test(state.url || '')) {
      setStatus(baseMsg + '｜关键画面截图只支持 B 站视频，本条跳过。');
      return;
    }
    // 每次抓字幕先清掉上一次的截图，防止串到别的视频（与"新视频记成上一个"同一套约束）
    await stSet({ bn_frames: null });
    const times = pickFrameTimes(state.lines);
    if (!times.length) {
      setStatus(baseMsg + '｜字幕里没有可用于截图的时间点，已跳过截图。');
      return;
    }
    const sendBtn = $('#bn-send');
    if (sendBtn) sendBtn.disabled = true; // 截图期间不给发送，避免图还没写完就保存
    setStatus('正在截取 ' + times.length + ' 张关键画面（只在你已打开的 B 站页面里截，不新开页面，约 ' + (times.length * 2) + ' 秒）…');
    let resp = null;
    try {
      resp = await sendToBg({ type: 'captureVideoFrames', times, videoUrl: state.url, title: state.title });
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
    const d = (resp && resp.ok && resp.data) ? resp.data : null;
    // v3.8.1：失败明细最多展示 2 条，避免状态栏被 5 条重复内容刷满
    const brief = (arr) => (!arr || !arr.length ? '' : (arr.slice(0, 2).join('；') + (arr.length > 2 ? '…（共 ' + arr.length + ' 个时间点失败）' : '')));
    if (!d || !d.frames || !d.frames.length) {
      const why = brief(d && d.errors) || ((resp && (resp.error || (resp.data && resp.data.reason))) || '未知原因');
      setStatus(baseMsg + '｜关键画面未插入（' + why + '），文字笔记不受影响。');
      return;
    }
    await stSet({ bn_frames: { frames: d.frames, url: state.url, at: Date.now() } });
    setStatus(baseMsg + '｜已截 ' + d.frames.length + ' 张关键画面，保存时会插到「关键节点」里对应时间点下面' +
      (d.injected ? '（已自动补注入页面脚本，无需刷新）' : '') +
      (d.errors && d.errors.length ? '（' + d.errors.length + ' 个时间点失败：' + brief(d.errors) + '）' : '') +
      (d.notes && d.notes.length ? '（截图尺寸与期望不符 ' + d.notes.length + ' 项：' + brief(d.notes) + '，可按尺寸判断是否被裁边）' : '') + '。');
  }

  // ---------- 整理平台（豆包 / DeepSeek，v3.8.9） ----------
  const AI_PLAT_KEY = 'bn_ai_platform';
  let aiPlat = 'doubao';

  function getAiPlat() { return aiPlat; }
  function aiPlatName(p) { return p === 'deepseek' ? 'DeepSeek' : '豆包'; }

  function applyAiPlat(p, silent) {
    aiPlat = p === 'deepseek' ? 'deepseek' : 'doubao';
    const name = aiPlatName(aiPlat);
    const btn = $('#bn-send');
    if (btn) btn.textContent = '发送到 ' + name + ' 整理（六板块结构化笔记）';
    // DeepSeek 没有"专家模式"（它的深度思考是 R1 推理，会明显变慢），该选项只对豆包生效
    const row = $('#bn-expert-row');
    if (row) row.style.display = aiPlat === 'deepseek' ? 'none' : '';
    if (!silent) {
      const st = $('#bn-status');
      if (st) {
        st.textContent = '整理平台已切换为 ' + name + '：抓完字幕点「发送到 ' + name + ' 整理」（前提是在 Edge 登录 ' +
          (aiPlat === 'deepseek' ? 'chat.deepseek.com' : 'www.doubao.com') + '）。';
        st.classList.remove('err');
      }
    }
  }

  function initAiPlat() {
    try {
      chrome.storage.local.get({ [AI_PLAT_KEY]: 'doubao' }, (it) => {
        const p = (it && it[AI_PLAT_KEY]) === 'deepseek' ? 'deepseek' : 'doubao';
        const radio = document.querySelector('input[name="bn-ai"][value="' + p + '"]');
        if (radio) radio.checked = true;
        applyAiPlat(p, true);
      });
    } catch (e) { applyAiPlat('doubao', true); }
    document.querySelectorAll('input[name="bn-ai"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        applyAiPlat(r.value, false);
        try { chrome.storage.local.set({ [AI_PLAT_KEY]: aiPlat }, () => {}); } catch (e) { /* 忽略 */ }
      });
    });
  }

  // ---------- 发送到豆包 / DeepSeek ----------

  // v3.7.95：发送加互斥锁，避免队列自动发送与手动点击叠加，一条字幕发两次
  let sending = false;

  async function onSend(opts) {
    if (sending) { setStatus('上一条还在发送中，稍等…'); return; }
    sending = true;
    try {
      return await sendNow(opts);
    } finally {
      sending = false;
    }
  }

  async function sendNow(opts) {
    const auto = !!(opts && typeof opts === 'object' && opts.auto === true);
    if (!state.raw) { setStatus('请先抓取字幕'); return; }

    const plat = getAiPlat();
    const aiName = aiPlatName(plat);

    // 发送前核对字幕开头，避免误发（B站个别视频的接口可能返回与分P不符的字幕）
    const head = state.raw.split('\n').slice(0, 3).join('\n');
    if (auto) {
      // 队列模式：不再弹 confirm（弹窗会卡住自动流程），改为把核对信息写进状态栏
      setStatus('队列自动发送《' + (state.title || '未识别') + '》｜字幕开头：' +
        state.raw.split('\n').slice(0, 2).join(' / ').slice(0, 90));
    } else if (!confirm('请先核对字幕开头是否与视频内容一致：\n\n' + head + '\n\n确认发送到 ' + aiName + ' 整理？')) {
      return;
    }

    const btn = $('#bn-send');
    btn.disabled = true;
    btn.textContent = '正在打开 ' + aiName + ' 并发送…';
    try {
      const pr = await sendToBg({ type: 'buildNotePrompt', title: state.title, raw: state.raw });
      if (!pr || !pr.ok) {
        setStatus('生成整理指令失败：' + ((pr && pr.error) || '背景页没有响应'));
        btn.disabled = false;
        btn.textContent = '发送到 ' + aiName + ' 整理（六板块结构化笔记）';
        return;
      }
      const prompt = pr.data.text;

      // v3.7.96：原始字幕另存一份——保存笔记时由 background 追加到文末（保真可追溯，且不占豆包输出长度）
      await chrome.storage.local.set({
        [PENDING_KEY]: { text: prompt, title: state.title, ts: Date.now(), platform: plat },
        bn_src_subs: { title: state.title || '', raw: state.raw || '', url: state.url || '', at: Date.now() }
      });
      const r = await sendToBg({ type: plat === 'deepseek' ? 'openDeepSeek' : 'openDoubao' });
      if (!r.ok) {
        setStatus('打开 ' + aiName + ' 失败：' + r.error + '。字幕已保存，请手动打开 ' + aiName + ' 粘贴发送。');
        return;
      }
      setStatus(r.data.alreadyOpen
        ? '已刷新 ' + aiName + ' 标签页，正在自动发送…（若未登录，请先登录后手动发送）'
        : '已打开 ' + aiName + ' 网页，正在自动发送…（若未登录，请先登录后手动发送）');
      btn.textContent = '已发送，去 ' + aiName + ' 查看（如未发送可再点一次）';
      btn.disabled = false;
    } catch (e) {
      setStatus('发送失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '发送到 ' + aiName + ' 整理（六板块结构化笔记）';
    }
  }

  // ---------- 调试：内置测试字幕（不依赖 B 站登录） ----------

  const TEST_TITLE = 'PN结的形成与半导体二极管（调试字幕）';
  const TEST_SUBTITLE = [
    '[00:00] 接下来看 PN 结',
    '[00:04] 首先要知道 N 型半导体还有 P 型半导体',
    '[00:09] 回顾 N 型半导体掺入的是磷原子',
    '[00:13] 每掺入一个磷原子这个磷原子就会丢失一个电子',
    '[00:25] 失去一个电子它就变成了正离子',
    '[00:36] 正离子在简图中表示为一个圆圈加一个大写的正号',
    '[00:43] N 型半导体里面的多子是电子',
    '[00:53] 简图画出来N型半导体里面有很多正离子',
    '[01:07] 同时里面还有很多电子用实心黑点表示',
    '[01:24] N型半导体虽然多子是电子但是还有少量空穴',
    '[01:35] 空穴用空心圈表示',
    '[01:46] 这就是N型半导体的简图',
    '[01:52] P型半导体中掺入的是硼原子',
    '[01:57] 每掺入一个硼原子他就会从旁边抢一个电子过来',
    '[02:12] 硼原子得到一个电子就变成了硼负离子',
    '[02:48] 硼负离子的表示法就是一个圆圈里面加一个负号',
    '[02:57] P型半导体里面的多子是空穴',
    '[03:04] 简图表示为很多的硼负离子和很多的空穴',
    '[03:34] P型半导体多子是空穴但还有少数自由电子',
    '[04:29] PN结：同一块硅片上制作P型和N型半导体拼接形成',
    '[04:49] 扩散本质：载流子从高浓度向低浓度运动',
    '[05:01] 固定离子不能移动只有电子和空穴可以运动',
    '[06:13] 扩散相遇的电子与空穴发生复合湮灭',
    '[06:41] 复合后形成空间电荷区又称耗尽层',
    '[06:52] 内建电场方向由N区指向P区',
    '[08:41] 内建电场阻碍多子的扩散运动',
    '[10:20] 漂移运动定义载流子在电场力作用下的运动',
    '[12:50] 动态平衡条件扩散多子数目等于漂移少子数目',
    '[16:45] 伏安特性定义改变PN结电压测量电流得到V-I关系',
    '[18:05] 正向电压定义P区电位高于N区电位',
    '[18:55] 正向外加电场削弱内建电场',
    '[22:26] 反向电压定义N区电位高于P区电位',
    '[24:05] 反向电压下外电场使空间电荷区变宽加强内建电场',
    '[27:51] 反向饱和电流反向电压足够大后电流基本保持不变',
    '[28:22] 反向击穿反向电压达到击穿电压时发生击穿击穿后可稳压',
    '[29:57] PN结电流公式 I=I_S(e^(V/U_T)-1)',
    '[30:51] 参数说明 I_S反向饱和电流 U_T常温约26mV',
    '[34:19] 击穿分类齐纳击穿和雪崩击穿',
    '[36:54] PN结核心结论具有单向导电性',
    '[37:03] 二极管定义PN结封装外壳并引出电极引线',
    '[38:21] 二极管电极P端为阳极N端为阴极',
    '[42:00] 开启电压硅管约0.5V锗管约0.1V',
    '[44:14] 导通压降硅二极管0.7V锗二极管0.2V',
    '[45:52] 温度特性温度每升高10度反向饱和电流增大一倍',
    '[50:15] 二极管参数反向饱和电流越小单向导电性越好',
    '[53:28] 二极管等效电路恒压降模型和理想二极管模型',
    '[54:09] 恒压降模型硅管导通压降取0.7V反向截止电流为0',
    '[55:10] 理想二极管模型导通压降视为0等效导线'
  ].join('\n');

  async function onDebug() {
    state.title = TEST_TITLE;
    state.raw = TEST_SUBTITLE;
    state.lines = TEST_SUBTITLE.split('\n').map((ln) => ({ text: ln }));
    $('#bn-video-title').textContent = state.title;
    $('#bn-count').textContent = state.lines.length;
    $('#bn-subtitle').textContent = state.raw;
    $('#bn-send').disabled = false;
    setStatus('已载入内置测试字幕（' + state.lines.length + ' 条），开始发送到 ' + aiPlatName(getAiPlat()) + '…');
    onSend();
  }

  // ---------- Obsidian 设置 ----------

  async function loadObCfg() {
    try {
      const items = await new Promise((resolve) => chrome.storage.local.get([OB_CFG_KEY], resolve));
      const c = items[OB_CFG_KEY] || {};
      // v3.7.92：历史配置里出现过地址被误存成 extension://xxx/app.html 的情况，
      // 这里直接显示成可用的默认地址，用户不用自己排查（保存时也会自动纠回默认）。
      const rawApi = String(c.apiUrl || '').trim();
      $('#ob-api').value = /^https?:\/\//.test(rawApi) ? rawApi : 'http://127.0.0.1:27123';
      $('#ob-key').value = c.apiKey || '';
      $('#ob-dir').value = c.dir || '';
      if (rawApi && !/^https?:\/\//.test(rawApi)) {
        const st = $('#ob-status');
        st.textContent = '检测到旧的 API 地址无效（' + rawApi + '），已自动修正为 http://127.0.0.1:27123 并写回设置。';
        st.classList.add('err');
        // 直接写回，避免用户还要再点一次「保存设置」
        try {
          const fixed = { apiUrl: 'http://127.0.0.1:27123', apiKey: c.apiKey || '', dir: c.dir || '' };
          await new Promise((resolve) => chrome.storage.local.set({ [OB_CFG_KEY]: fixed }, resolve));
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
  }

  async function saveObCfg() {
    let dir = $('#ob-dir').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const st = $('#ob-status');
    // v3.7.92：填了 Windows 绝对路径（如 C:\Users\...\Obsidian Vault\mynote）时，
    // 自动取最后一段作为 vault 内相对路径，避免每次保存都要再转换 + 用户误以为没生效。
    if (/[\\:]/.test($('#ob-dir').value.trim())) {
      const seg = String($('#ob-dir').value).replace(/\\/g, '/').split('/').filter(Boolean);
      dir = seg.length ? seg[seg.length - 1] : '';
      st.textContent = '保存目录是绝对路径，已自动改为 vault 内的相对路径「' + dir + '」。';
      st.classList.add('err');
    }
    const url = $('#ob-api').value.trim();
    let apiUrl = url || 'http://127.0.0.1:27123';
    // 校验：API 地址必须以 http:// 或 https:// 开头（曾出现误填扩展页自身地址导致 Failed to fetch）
    if (!/^https?:\/\//.test(apiUrl)) {
      st.textContent = '注意：API 地址必须以 http:// 或 https:// 开头（如 http://127.0.0.1:27123），当前值 ' + apiUrl + ' 无效，已自动改用默认地址。';
      st.classList.add('err');
      apiUrl = 'http://127.0.0.1:27123';
    }
    const cfg = {
      apiUrl: apiUrl.replace(/\/+$/, ''),
      apiKey: $('#ob-key').value.trim(),
      dir: dir
    };
    try {
      await chrome.storage.local.set({ [OB_CFG_KEY]: cfg });
      if (!cfg.apiKey) {
        st.textContent = '已保存，但没有填 API Key —— 自动保存不会生效。请到 Obsidian 的 Local REST API 设置里复制 Key 填上。';
        st.classList.add('err');
      } else {
        st.textContent = '已保存。整理完成后的笔记会自动写入 Obsidian。可点「测试连接」确认现在就能写入。';
        st.classList.remove('err');
      }
    } catch (e) {
      st.textContent = '保存设置失败：' + e.message;
      st.classList.add('err');
    }
  }

  // v3.7.92 新增：一键验证 Obsidian 连接（不用等下一次生成笔记才知道能不能写）
  async function testObConn() {
    const st = $('#ob-status');
    let base = $('#ob-api').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) base = 'http://127.0.0.1:27123';
    const key = $('#ob-key').value.trim();
    if (!key) {
      st.textContent = '请先填 API Key（Obsidian → 设置 → Local REST API → API Key）。';
      st.classList.add('err');
      return;
    }
    st.textContent = '正在测试 ' + base + ' …';
    st.classList.remove('err');
    try {
      const r = await fetch(base + '/', { headers: { 'Authorization': 'Bearer ' + key }, cache: 'no-store' });
      const t = await r.text();
      let authed = null;
      let vault = '';
      try { const j = JSON.parse(t); authed = j.authenticated; vault = j.service || ''; } catch (e) { /* 非 JSON */ }
      if (r.ok && authed === true) {
        // key 有效，再确认能读到库（GET /vault/ 返回文件列表）
        let listOk = false;
        try {
          const r2 = await fetch(base + '/vault/', { headers: { 'Authorization': 'Bearer ' + key }, cache: 'no-store' });
          listOk = r2.ok;
        } catch (e) { /* 忽略 */ }
        st.textContent = listOk
          ? '连接正常：Key 有效，Obsidian 可读可写（' + (vault || 'Local REST API') + '）。'
          : 'Key 有效，但读取笔记库失败（可能 vault 路径异常）：' + base + '/vault/';
        st.classList.toggle('err', !listOk);
      } else if (authed === false) {
        st.textContent = '能连上 Obsidian，但这个 API Key 不对。请到 Local REST API 设置里重新复制 Key。';
        st.classList.add('err');
      } else {
        st.textContent = '连接失败 HTTP ' + r.status + '：' + String(t).slice(0, 120);
        st.classList.add('err');
      }
    } catch (e) {
      st.textContent = '连不上 ' + base + '：' + e.message + '（确认 Obsidian 已打开、Local REST API 插件已启用且端口正确）';
      st.classList.add('err');
    }
  }

  async function onManualSave() {
    const content = $('#ob-manual').value;
    if (!content.trim()) {
      const st = $('#ob-manual-status');
      st.textContent = '请先粘贴笔记内容到上方文本框';
      st.classList.add('err');
      return;
    }
    const btn = $('#ob-manual-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const r = await sendToBg({
        type: 'saveNoteToObsidian',
        title: '手动笔记',
        content: content
      });
      const st = $('#ob-manual-status');
      if (r.ok) {
        st.textContent = '已保存：' + r.data.path;
        st.classList.remove('err');
      } else {
        st.textContent = '保存失败：' + r.error;
        st.classList.add('err');
      }
    } catch (e) {
      const st = $('#ob-manual-status');
      st.textContent = '保存失败：' + e.message;
      st.classList.add('err');
    }
    btn.disabled = false;
    btn.textContent = '保存到 Obsidian';
  }

  // ---------- 链接队列（v3.7.79：删掉批量状态机，回到单条界面）----------
  // 只存链接列表 + 当前序号（bn_queue）。笔记记完（content 发 bnNoteDone）后 background 自动推进，
  // v3.8.14：抓字幕、拼整理指令、发送全部搬进 background，扩展页只负责录入链接与显示进度。
  // 原来这里轮询到新链接就自己抓字幕+发送，页面一旦被 Edge 冻结，整条队列就停摆。
  const QUEUE_KEY = 'bn_queue';
  let lastQueueSig = ''; // 队列推进标记（currentIndex:current），变化时自动填输入框并抓字幕

  async function refreshQueue() {
    // 只做看板：回填当前链接、显示进度。不再触发抓取/发送，避免与后台重复发送。
    const r = await sendToBg({ type: 'bnQueueGet' });
    if (!r || !r.ok || !r.data) return;
    const q = r.data;
    const st = $('#bn-queue-status');
    if (q.lastMsg) { st.textContent = q.lastMsg; st.classList.remove('err'); }
    state.autoSend = !!q.active;
    const sig = q.current ? (q.currentIndex + ':' + q.current) : '';
    if (sig && sig !== lastQueueSig) {
      lastQueueSig = sig;
      $('#bn-url').value = q.current; // 只回填，不抓取
    } else if (!sig) {
      lastQueueSig = '';
    }
  }

  async function onQueueSet() {
    const text = $('#bn-queue-input').value;
    const urls = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const st = $('#bn-queue-status');
    if (!urls.length) {
      st.textContent = '请先粘贴至少一个视频链接（每行一个，支持 B 站 / 小红书 / YouTube）。';
      st.classList.add('err');
      return;
    }
    // 分P 范围（?p=1-8、?p=1~8）以及坏链接校验都在 background 统一做，这里原样上传
    const r = await sendToBg({ type: 'bnQueueSet', urls });
    const d = (r && r.ok) ? r.data : null;
    if (d && d.ok) {
      st.textContent = '已放入 ' + d.count + ' 个链接（分P 范围已展开）。点「开始逐个处理」：抓字幕、发送、记完接下去都在后台跑，不用守着这个页面。'
        + (d.errors && d.errors.length ? '｜跳过 ' + d.errors.length + ' 条：' + d.errors.join('；') : '');
      st.classList.remove('err');
      $('#bn-queue-input').value = '';
    } else {
      st.textContent = '加入失败：' + ((d && d.error) || (r && r.error) || '未知错误');
      st.classList.add('err');
    }
    refreshQueue();
  }

  async function onQueueStart() {
    const r = await sendToBg({ type: 'bnQueueStart' });
    const d = (r && r.ok) ? r.data : null;
    const st = $('#bn-queue-status');
    if (d && d.ok) {
      st.textContent = '队列已在后台开始：抓字幕、发给 ' + aiPlatName(getAiPlat()) + ' 都由后台完成，切到别的页面也不会停；每条记完自动继续下一条。';
      st.classList.remove('err');
    } else {
      st.textContent = '启动失败：' + ((d && d.error) || (r && r.error) || '队列为空？');
      st.classList.add('err');
    }
    refreshQueue();
  }

  async function onQueueSkip() {
    // 跳过当前：让后台把这条算作已过、直接推进下一条
    const r = await sendToBg({ type: 'bnQueueNext' });
    const d = (r && r.ok) ? r.data : null;
    const st = $('#bn-queue-status');
    if (d && d.ok) {
      st.textContent = '已跳过当前，后台接着处理下一条…';
      st.classList.remove('err');
    } else {
      st.textContent = '跳过失败：' + ((d && d.error) || (r && r.error) || '未知原因');
      st.classList.add('err');
    }
    refreshQueue();
  }

  async function onQueueClear() {
    await sendToBg({ type: 'bnQueueClear' });
    lastQueueSig = '';
    refreshQueue();
  }

  // ---------- 初始化 ----------

  // 从 URL 参数带过来的链接自动填入
  try {
    const q = new URLSearchParams(location.search);
    const u = q.get('url');
    if (u) $('#bn-url').value = u;
  } catch (e) { /* 忽略 */ }

  loadObCfg();
  initAiPlat();

  // v3.7.80：豆包专家模式开关（存 storage，content-doubao.js 发送前读取生效）
  const expertCb = $('#bn-expert');
  try {
    chrome.storage.local.get({ bn_expert: false }, (it) => { expertCb.checked = !!(it && it.bn_expert); });
  } catch (e) { /* 忽略 */ }
  expertCb.addEventListener('change', () => {
    const on = expertCb.checked;
    chrome.storage.local.set({ bn_expert: on }, () => {
      const st = $('#bn-status');
      st.textContent = on
        ? '已开启豆包专家模式：后续发送到豆包会启用「深度思考」，笔记更专业；豆包生成等待时长延长至约 1 分钟。'
        : '已关闭豆包专家模式，按普通模式发送（等待约 12 秒）。';
      st.classList.remove('err');
    });
  });

  // v3.8.0：关键画面截图 / 时间戳跳转链接 两个开关，各自独立、分别存 storage
  [
    ['#bn-ts-link', 'bn_ts_link',
      '已开启时间戳跳转：笔记「关键节点」里的 [mm:ss] 会变成可点链接，点一下跳到该视频对应画面。',
      '已关闭时间戳跳转，关键节点只保留纯文本时间。'],
    ['#bn-frames', 'bn_frames_on',
      '已开启关键画面截图：抓完字幕后会在已打开的 B 站视频页里截 3~5 张关键画面，保存时插到「关键节点」对应时间点下面（约 10 秒，不新开页面）。',
      '已关闭关键画面截图，笔记里只有文字。']
  ].forEach(([sel, key, onText, offText]) => {
    const cb = $(sel);
    if (!cb) return;
    try { chrome.storage.local.get({ [key]: false }, (it) => { cb.checked = !!(it && it[key]); }); } catch (e) { /* 忽略 */ }
    cb.addEventListener('change', () => {
      chrome.storage.local.set({ [key]: cb.checked }, () => {
        const st = $('#bn-status');
        st.textContent = cb.checked ? onText : offText;
        st.classList.remove('err');
      });
    });
  });

  $('#bn-start').addEventListener('click', onStart);
  $('#bn-send').addEventListener('click', () => onSend());
  $('#bn-debug').addEventListener('click', onDebug);
  $('#bn-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onStart();
  });

  // 平台切换键：B站 / 小红书 / YouTube
  document.querySelectorAll('.plat-tab').forEach((b) => {
    b.addEventListener('click', () => setPlat(b.dataset.plat));
  });
  // 粘贴链接后自动切到对应平台（少点一次）
  $('#bn-url').addEventListener('input', () => {
    const d = detectPlat($('#bn-url').value);
    if (d && d !== plat) setPlat(d);
  });
  setPlat('bili');
  $('#ob-save').addEventListener('click', saveObCfg);
  $('#ob-test').addEventListener('click', testObConn);
  $('#ob-manual-save').addEventListener('click', onManualSave);

  // 链接队列事件 + 轮询（storage 变化双通道）
  $('#bn-queue-set').addEventListener('click', onQueueSet);
  $('#bn-queue-start').addEventListener('click', onQueueStart);
  $('#bn-queue-skip').addEventListener('click', onQueueSkip);
  $('#bn-queue-clear').addEventListener('click', onQueueClear);
  setInterval(refreshQueue, 2000);
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[QUEUE_KEY]) refreshQueue();
    });
  } catch (e) { /* 忽略 */ }
  refreshQueue();
})();
