// B站学习笔记助手 - 网页式入口
// 输入 B 站链接 → 抓字幕 → 一键发送豆包整理（六板块结构化笔记：核心要点 / 术语表 / 易错点与疑问 / 思维导图 / 关键节点 / 原始字幕）→ 可选自动存入 Obsidian。

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

  // ---------- 发送到豆包 ----------

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

    // 发送前核对字幕开头，避免误发（B站个别视频的接口可能返回与分P不符的字幕）
    const head = state.raw.split('\n').slice(0, 3).join('\n');
    if (auto) {
      // 队列模式：不再弹 confirm（弹窗会卡住自动流程），改为把核对信息写进状态栏
      setStatus('队列自动发送《' + (state.title || '未识别') + '》｜字幕开头：' +
        state.raw.split('\n').slice(0, 2).join(' / ').slice(0, 90));
    } else if (!confirm('请先核对字幕开头是否与视频内容一致：\n\n' + head + '\n\n确认发送到豆包整理？')) {
      return;
    }

    const btn = $('#bn-send');
    btn.disabled = true;
    btn.textContent = '正在打开豆包并发送…';
    try {
      const prompt =
        '你是学习笔记助手。请把下面这段视频字幕整理成一份结构清晰、内容充实的 Obsidian Markdown 学习笔记，' +
        '直接输出笔记正文（Markdown 格式），不要输出任何多余的解释或标记。\n\n' +
        '【保真铁律｜优先级高于下面所有格式要求】\n' +
        '1) 字幕里的数字、时间、人名、专有名词、公式、条件限定（如“当…时”“仅在…”“约等于”）必须原样保留，不得改写、不得四舍五入、不得换同义词；\n' +
        '2) 只允许删除无信息量的口语冗余（“这个”“那个”“我们来看一下”“对不对”）；删除不得丢失任何数据、结论或条件；\n' +
        '3) 不确定的内容一律写成【疑问】，严禁编一个看起来合理的答案补上；\n' +
        '4) 严禁编造字幕里没有的时间戳；“关键节点”里的 [mm:ss] 必须逐条取自字幕原文。\n\n' +
        '笔记结构严格按下面六个板块输出，板块顺序和标题文字都不要改：\n\n' +
        '# 《' + (state.title || '未识别') + '》\n\n' +
        '> [!info] 整理说明\n' +
        '> 场景：学习笔记（讲解类）\n' +
        '> 保真：数据、时间、专名、公式、条件限定均与字幕一致，未改写\n' +
        '> 原文：字幕原文由插件附在笔记末尾，可随时对照\n\n' +
        '## 一、核心要点\n' +
        '按主题分成若干小节（用 ### 小标题区分），每个小节用条目列出知识点。要求：\n' +
        '- 覆盖字幕的全部主要内容，重要概念、公式、结论、原理展开讲清楚，不要只列关键词；\n' +
        '- 涉及公式、参数、电路、代码的地方完整保留；所有公式一律用标准 LaTeX 写在 ```latex 代码块内（如 I_D=I_S(e^{U_D/U_T}-1)、r_d=U_T/I_DQ），不要用普通文字描述公式；多个公式必须用换行分隔、每个公式单独占一行，严禁把多个公式连写堆在一行（如 V_{BB}=I_{BQ}R_B+U_{BEQ} I_{CQ}=\\beta I_{BQ} 这类连堆是错误的，必须分行）；\n' +
        '- 严禁用 Unicode 字符手写公式（如 ∑、∞、→、∂、≤、≥ 等），一律用 LaTeX 命令（\\sum、\\infty、\\to、\\partial、\\leq、\\frac、\\lim、\\int、\\sqrt、\\times）；严禁用 <sup>/<sub> HTML 标签表示上下标；\n' +
        '- 上下标必须写成 LaTeX：下标用 _{...}（如 $z_n$、$U_{CE}$、$I_{DQ}$），上标用 ^{...}（如 $x^2$、$e^{x}$）；物理量符号一律写成行内公式 $...$（如 $I_S$、$U_T$、$r_d$、$U_{ON}$、$Q$），不要用纯文本字母、不要连写（如 zn 应写 $z_n$）；\n' +
        '- 标准写法示例：级数 $\\sum_{n=1}^{\\infty} z_n$、极限 $\\lim_{N\\to+\\infty} S_N$、偏导数 $\\frac{\\partial^2\\varphi}{\\partial x^2}$、积分 $\\int_a^b f(x)\\,dx$、根式 $\\sqrt{x^2+y^2}$、小于等于 $\\le$；\n' +
        '- 【严禁的写法】连写物理量符号（VGS、VDS、IDSS、zn、VGD 等均错误，必须写 $V_{GS}$、$V_{DS}$、$I_{DSS}$、$z_n$、$V_{GD}$）；带下划线的半转换写法（VG_D、I_D 等均错误，必须写 $V_{GD}$、$I_D$）；分子分母连写（如 VGS(off)VGS 错误，必须写 $\\frac{V_{GS}}{V_{GS(off)}}$）；括号后直接跟数字表示幂次（如 (1-...)2 错误，必须写 ^2）；\n' +
        '- 上述公式规范对全文所有板块一律生效（核心要点、术语表、易错点与疑问、思维导图展开内容、关键节点都不例外），关键节点时间戳后的公式同样要写成标准 LaTeX；\n' +
        '- 条目按逻辑顺序组织，层次分明；每个小节只写字幕里讲过的内容，不要补充视频外的知识（确有必要补充时标【补充】）。\n\n' +
        '## 二、术语表\n' +
        '只收录这条视频实际出现的术语，按首次出现顺序排列，每条一行：\n' +
        '- **规范写法**（字幕里的叫法）：一句话解释它在这条视频里具体指什么\n' +
        '要求：同一术语只出现一次；缩写首次出现要写全称（如 MCU（微控制器））；字幕把术语念成同音词的，规范写法写正确形式、括号里保留字幕原词；本条视频没有术语时保留板块标题并写“- 无”。\n\n' +
        '## 三、易错点与疑问\n' +
        '### 易错点\n' +
        '- 视频里被明确强调的坑、容易混淆的概念、容易代错的条件（如“仅适用于小信号”“方向别反”）；只写视频里真讲到的，不要泛泛而谈。\n' +
        '### 待查疑问\n' +
        '- 【疑问】字幕没讲清、前后矛盾、或需要自己再查资料的点；只写问题，严禁编答案；没有就写“- 无”。\n\n' +
        '## 四、思维导图（点击可展开）\n' +
        '用可折叠的知识树呈现整段内容：每个核心板块一个可展开/收起的折叠块，点击标题即可展开该板块的详细解释。用 Obsidian callout 语法（渲染后是带标题的可折叠块）：\n' +
        '- 结构：3~5 个板块，覆盖视频全部核心内容；板块标题 2~6 字（如 半导体类型、PN结特性、二极管参数）；\n' +
        '- 每块展开内容为该板块的详细解释（2~4 条要点，每条把概念/原理/公式讲清楚，不要只列关键词）；\n' +
        '- 格式示例如下（内容按本视频实际主题替换）：\n' +
        '> [!note]- 半导体类型\n' +
        '> - N型半导体：掺入磷原子，失电子成固定正离子，多子是电子\n' +
        '> - P型半导体：掺入硼原子，俘获电子成固定负离子，多子是空穴\n' +
        '> - 多子与少子：多子是主要载流子，少子数量极少\n' +
        '（以上仅为格式示例，请按本视频实际内容生成）\n\n' +
        '## 五、关键节点\n' +
        '根据字幕中的 [mm:ss] 时间戳，整理视频的关键节点：重要概念、结论、公式、示例出现的时间点及该节点的一句话内容，' +
        '格式为 [mm:ss] 内容，按时间顺序排列，覆盖全部重要节点，不要只列开头结尾。' +
        '每个时间戳必须是字幕原文里真实出现过的，不许自行换算或编造。\n\n' +
        '字幕内容：\n' + state.raw;

      // v3.7.96：原始字幕另存一份——保存笔记时由 background 追加到文末（保真可追溯，且不占豆包输出长度）
      await chrome.storage.local.set({
        [PENDING_KEY]: { text: prompt, title: state.title, ts: Date.now() },
        bn_src_subs: { title: state.title || '', raw: state.raw || '', url: state.url || '', at: Date.now() }
      });
      const r = await sendToBg({ type: 'openDoubao' });
      if (!r.ok) {
        setStatus('打开豆包失败：' + r.error + '。字幕已保存，请手动打开豆包粘贴发送。');
        return;
      }
      setStatus(r.data.alreadyOpen
        ? '已刷新豆包标签页，正在自动发送…（若未登录，请先登录后手动发送）'
        : '已打开豆包网页，正在自动发送…（若未登录，请先登录后手动发送）');
      btn.textContent = '已发送，去豆包查看（如未发送可再点一次）';
      btn.disabled = false;
    } catch (e) {
      setStatus('发送失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '发送到豆包整理（六板块结构化笔记）';
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
    setStatus('已载入内置测试字幕（' + state.lines.length + ' 条），开始发送到豆包…');
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
  // 这里轮询到新链接就把链接填进上方单条输入框并自动抓字幕——"在单个的基础上逐个处理"。
  const QUEUE_KEY = 'bn_queue';
  let lastQueueSig = ''; // 队列推进标记（currentIndex:current），变化时自动填输入框并抓字幕

  async function refreshQueue() {
    const r = await sendToBg({ type: 'bnQueueGet' });
    if (!r || !r.ok || !r.data) return;
    const q = r.data;
    const st = $('#bn-queue-status');
    if (q.lastMsg) { st.textContent = q.lastMsg; st.classList.remove('err'); }
    // v3.7.95：队列处于运行状态时，抓完就自动发送（单条模式仍是人工确认）
    state.autoSend = !!q.active;
    const sig = q.active && q.current ? (q.currentIndex + ':' + q.current) : '';
    if (sig && sig !== lastQueueSig) {
      lastQueueSig = sig;
      $('#bn-url').value = q.current; // 自动把下一个链接填进单条输入框
      onStart({ auto: true });         // 自动抓字幕（与手动点「抓取字幕」同一函数）
    } else if (!sig) {
      lastQueueSig = '';
    }
  }

  async function onQueueSet() {
    const text = $('#bn-queue-input').value;
    const urls = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!urls.length) {
      $('#bn-queue-status').textContent = '请先粘贴至少一个视频链接（每行一个，支持 B 站 / 小红书 / YouTube）。';
      $('#bn-queue-status').classList.add('err');
      return;
    }
    // v3.7.71 校验：聊天/文档里复制的链接常被截断拼接（一行两个 http 或含 …），丢 p 参数会抓错分P
    const bad = urls.filter((u) => u.indexOf('…') >= 0 || (u.indexOf('http') >= 0 && u.indexOf('http') !== u.lastIndexOf('http')));
    if (bad.length) {
      $('#bn-queue-status').textContent = '以下链接被截断/拼接损坏，请重新从视频页面完整复制（每行一个完整链接）：\n' + bad.join('\n');
      $('#bn-queue-status').classList.add('err');
      return;
    }
    const r = await sendToBg({ type: 'bnQueueSet', urls });
    const st = $('#bn-queue-status');
    if (r && r.ok) {
      st.textContent = '已放入 ' + r.data.count + ' 个链接。点「开始逐个处理」：第 1 个会自动填到上方输入框并抓字幕，记完笔记自动填下一个。';
      st.classList.remove('err');
      $('#bn-queue-input').value = '';
    } else {
      st.textContent = '加入失败：' + ((r && r.error) || '未知错误');
      st.classList.add('err');
    }
    refreshQueue();
  }

  async function onQueueStart() {
    const r = await sendToBg({ type: 'bnQueueStart' });
    const st = $('#bn-queue-status');
    if (r && r.ok && r.data && r.data.url) {
      st.textContent = '开始逐个处理：已自动填入第 1 个链接，抓完字幕会直接发送给豆包，记完自动填下一个。';
      st.classList.remove('err');
      lastQueueSig = r.data.index + ':' + r.data.url; // 先置标记，再填+抓，避免轮询重复触发
      state.autoSend = true;
      $('#bn-url').value = r.data.url;
      onStart({ auto: true });
    } else {
      st.textContent = (r && r.error) || '启动失败（队列为空？）';
      st.classList.add('err');
    }
    refreshQueue();
  }

  async function onQueueSkip() {
    // 跳过当前：直接推进到下一个链接（抓字幕失败/内容不对时用）
    const r = await sendToBg({ type: 'bnQueueNext' });
    const st = $('#bn-queue-status');
    if (r && r.ok) {
      st.textContent = '已跳过当前，自动填入下一个链接…';
      st.classList.remove('err');
      refreshQueue();
    } else {
      st.textContent = (r && r.error) || '跳过失败';
      st.classList.add('err');
    }
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
