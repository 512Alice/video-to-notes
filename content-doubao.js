// B站学习笔记助手 - 豆包网页内容脚本
// 职责：检测到 B站页传来的待发送内容（chrome.storage.local 的 bn_pending_submit）后，
// 自动填入豆包输入框并发送；发送后监控豆包的回答，整理完成自动保存到 Obsidian；
// 任一环节页面结构不支持时，自动复制到剪贴板并给出明确提示。

(() => {
  const PENDING_KEY = 'bn_pending_submit';
  // 每次注入都全新初始化：扩展重载后旧脚本实例失效但 window.__bnLoaded 标志残留，
  // 若沿用"已加载则复用"逻辑，新脚本会被失效的旧函数拦截导致本页永不再工作。
  // 防重复由以下机制保证：pending 消费（发送前即删除）+ window.__bnWatching（同页只监控一次）。
  window.__bnLoaded = true;
  console.log('[B站笔记助手] v3.7.88 内容脚本已注入 ' + location.host + ' | textarea=' + document.querySelectorAll('textarea').length + ' | contenteditable=' + document.querySelectorAll('[contenteditable]').length + ' | role=textbox=' + document.querySelectorAll('[role="textbox"]').length);

  // 找到可见的输入框，覆盖多种形态：textarea / contenteditable / role=textbox / 带"发消息"占位符
  function findEditor() {
    const visible = (el) => el.offsetParent !== null;

    let els = Array.from(document.querySelectorAll('textarea')).filter(visible);
    if (els.length) return els[0];

    els = Array.from(document.querySelectorAll('[contenteditable]')).filter(visible);
    if (els.length) return els[els.length - 1];

    els = Array.from(document.querySelectorAll('[role="textbox"]')).filter(visible);
    if (els.length) return els[els.length - 1];

    els = Array.from(document.querySelectorAll('textarea, [contenteditable], [role="textbox"]')).filter((el) => {
      if (!visible(el)) return false;
      const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
      return /(发消息|输入|提问|发送|ask|message)/i.test(ph);
    });
    if (els.length) return els[els.length - 1];

    return null;
  }

  // 向受控组件写入文本（兼容 React 及 ProseMirror 等编辑器）
  function setEditorText(editor, text) {
    editor.focus();
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return editor.value.length > 0;
    }
    // contenteditable：用 execCommand 模拟真实输入（对 React 受控组件更可靠）
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
    } catch (e) { /* 走 textContent 兜底 */ }
    if (editor.textContent.length === 0) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return editor.textContent.length > 0;
  }

  // 尝试点击发送按钮（向后遍历，发送按钮一般在右下角 DOM 靠后）
  function clickSendButton() {
    const cands = [];
    document.querySelectorAll('button').forEach((b) => cands.push(b));
    document.querySelectorAll('[role="button"]').forEach((b) => cands.push(b));
    const pick = cands.reverse().find((b) => {
      if (b.offsetParent === null) return false;
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '') + ' ' + (b.getAttribute('data-testid') || '');
      return /发送|^send|发送消息/i.test(label);
    });
    if (pick) { pick.click(); return true; }
    return false;
  }

  // v3.7.80：豆包专家模式（深度思考）——探测输入区附近的"深度思考/专家模式"开关并点击。
  // 选择器用文本模糊匹配（豆包界面按钮文案/aria-label/data-testid），找不到开关时无害返回 false。
  function tryEnableExpertMode() {
    try {
      const re = /深度思考|专家模式|专业模式/i;
      const all = Array.from(document.querySelectorAll('button, [role="button"], [class*="mode"], [class*="think"]'));
      const el = all.find((b) => {
        if (b.offsetParent === null) return false;
        const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '') + ' ' + (b.getAttribute('data-testid') || '');
        return re.test(label);
      });
      if (el) { el.click(); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  // 在输入框上模拟回车（部分版本豆包用 Enter 发送）
  function pressEnter(editor) {    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      editor.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      }));
    });
  }

  // 输入框是否已被清空（发送成功后豆包会清空输入框）
  function editorEmpty(editor) {
    if (!editor) return true;
    return editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT'
      ? !editor.value
      : !editor.textContent.trim();
  }

  // 请求后台用 CDP 发送真实回车（React 受控组件只响应 isTrusted=true 的真实事件）
  function pressEnterReal() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'pressEnterReal' }, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp);
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  function copyFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e) {
      return false;
    }
  }

  function showTip(text) {
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:340px;padding:10px 14px;' +
      'background:#fff;border:1px solid #d0d3d6;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);' +
      'font:12px/1.6 "Microsoft YaHei",sans-serif;color:#1f2329;white-space:pre-wrap;';
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 10000);
  }

  // ---------- 抓取豆包的回答 ----------

  // HTML 实体解码
  function decodeHtml(s) {
    const t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }
  // 去掉标签只留文本（用于提取代码/标题内容）
  function stripTags(s) {
    return String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  }
  // v3.7.82：公式子树还原（KaTeX / MathJax / MathML / 自定义渲染 通用）——按括号配对取完整公式子树，
  // 用 DOMParser 解析后递归还原 \frac / 上下标 / 根号，避免分子分母、上下标在剥标签时粘连（9049、B1 这类）。
  // 优先级：<annotation>（LaTeX 源码）> aria-label > DOM 结构递归还原 > 渲染文本。
  // v3.7.83：容器识别改为「结构特征探测」——不依赖 class 名（豆包可能用 katex/MathJax/formula/latex 之外的
  // 自定义容器），只要子树内含 <annotation/<mfrac/mjx-frac/<msub/mjx-sub/<msup/mjx-sup/<msqrt/num/den 结构就还原。
  // v3.7.86：容器识别收紧（原规则会把普通正文块整块吞成一个公式）：
  // 1) 类名必须按独立 token 匹配——原 `tex` 会命中 `text-sm`，`den` 会命中 `hidden`；
  // 2) 含段落/标题/中文正文的容器不再当公式，而是继续向内寻找真正的公式根。
  const MATH_CLASS_RE = /class="[^"]*(?<![\w-])(?:katex(?![\w-])|katex-display|mathjax|formula|latex|tex)(?![\w])[^"]*"/i;
  const MATH_STRUCT_RE = /<annotation|<mfrac|<msub|<msup|<msubsup|<msqrt|<mroot|<munderover|<munder|<mover|<semantics|mjx-(?:mfrac|frac|msub|sub|msup|sup|msqrt|sqrt|munderover|underover|num|den)|class="[^"]*(?<![\w-])(?:mfrac|mord|mbin|mrel|mop|mopen|mclose|frac|sqrt)(?![\w])[^"]*"/i;
  function hasNumDen(full) {
    return /class="[^"]*(?<![\w-])num(?![\w])[^"]*"/i.test(full) &&
      /class="[^"]*(?<![\w-])den(?![\w])[^"]*"/i.test(full);
  }
  // 普通内容容器（含块级元素 / 中文正文 / 多个公式）不是公式根
  function looksLikeMathSubtree(full) {
    if (/<(?:p|h[1-6]|li|ul|ol|blockquote|pre|table|tr|td|th|section|article|main|header|footer)\b/i.test(full)) return false;
    if (/[㐀-鿿　-〿＀-￯]/.test(stripTags(full))) return false;
    if ((full.match(/<annotation/gi) || []).length > 1) return false;
    return MATH_STRUCT_RE.test(full) || hasNumDen(full);
  }
  function findMathEnd(html, fromIdx) {
    let depth = 1;
    const scan = /<\/(span|div|math|mjx-container)>|<(span|div|math|mjx-container)\b[^>]*>/g;
    scan.lastIndex = fromIdx;
    let am;
    while ((am = scan.exec(html))) {
      if (am[0].startsWith('</')) depth--;
      else depth++;
      if (depth === 0) return am.index + am[0].length;
    }
    return -1;
  }
  function mathHtmlToMath(html) {
    const openRe = /<(span|div|math|mjx-container)\b[^>]*>/g;
    const out = [];
    let m;
    while ((m = openRe.exec(html))) {
      const tag = m[1];
      const openStr = m[0];
      const end = findMathEnd(html, openRe.lastIndex);
      if (end < 0) break;
      const full = html.slice(m.index, end);
      const isMathTag = tag === 'math' || tag === 'mjx-container';
      const isMathCls = MATH_CLASS_RE.test(openStr);
      if (!isMathTag && !isMathCls && !looksLikeMathSubtree(full)) {
        // v3.7.86：只跳过当前开标签，继续扫描其子节点——外层容器里可能藏着真正的公式根
        openRe.lastIndex = m.index + m[0].length;
        continue;
      }
      out.push({ start: m.index, end, full });
      openRe.lastIndex = end;
    }
    if (!out.length) return html;
    let res = '', prev = 0;
    for (const k of out) {
      res += html.slice(prev, k.start) + katexSpanToMath(k.full);
      prev = k.end;
    }
    return res + html.slice(prev);
  }
  // v3.7.88：控制词后紧跟字母时补空格（\capB → \cap B）。
  // 必须先把完整的字母串取出来，再按“最长已知命令前缀”切分；若直接写成
  // 正则交替 + 预查，回溯会把 \int 拆成 \in t、把 \notin 拆成 \not in。
  const LATEX_CMD_NAMES = [
    // 结构/字体
    'frac', 'sqrt', 'overline', 'begin', 'end', 'left', 'right',
    'mathbb', 'mathcal', 'mathfrak', 'mathbf', 'mathsf', 'mathtt', 'mathit', 'mathrm', 'boldsymbol', 'text',
    'hat', 'check', 'bar', 'dot', 'ddot', 'tilde', 'acute', 'grave', 'vec',
    // 希腊字母
    'alpha', 'beta', 'gamma', 'delta', 'varepsilon', 'epsilon', 'zeta', 'eta',
    'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi',
    'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
    'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
    // 大运算符/关系符/箭头/集合/杂项
    'bigcup', 'cup', 'cap', 'sum', 'prod', 'int', 'iint', 'iiint', 'oint', 'infty',
    'to', 'ne', 'neq', 'leq', 'geq', 'emptyset', 'varnothing', 'cdots', 'ldots', 'mid',
    'partial', 'times', 'pm', 'setminus', 'in', 'notin', 'subset', 'supset',
    'subseteq', 'supseteq', 'nsubseteq', 'nsupseteq', 'nleq', 'ngeq', 'nless', 'ngtr', 'cdot', 'circ',
    'Rightarrow', 'Leftrightarrow', 'leftrightarrow', 'forall', 'exists', 'nabla',
    'angle', 'triangle', 'langle', 'rangle', 'perp', 'top', 'oplus', 'otimes', 'odot',
    'ast', 'star', 'bullet', 'simeq', 'approx', 'equiv', 'sim', 'cong', 'propto',
    'll', 'gg', 'prec', 'succ', 'parallel', 'nparallel', 'lceil', 'rceil', 'lfloor', 'rfloor',
    'wedge', 'vee', 'neg', 'ell', 'hbar', 'Re', 'Im', 'wp', 'dagger', 'ddagger',
    // 函数名（KaTeX 把 sin/lim 等渲染成文本算子，还原时要补反斜杠）
    'lim', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'sup', 'inf',
    'det', 'dim', 'ker', 'hom', 'arg', 'deg', 'gcd', 'mod', 'bmod', 'Pr',
  ];
  function spaceLatexCommands(tex) {
    return tex.replace(/\\([A-Za-z]+)/g, (m, word) => {
      if (LATEX_CMD_NAMES.indexOf(word) >= 0) return m; // 本身是完整命令，别切
      let best = '';
      for (const cmd of LATEX_CMD_NAMES) {
        if (word.startsWith(cmd) && cmd.length > best.length) best = cmd;
      }
      return best ? '\\' + best + ' ' + word.slice(best.length) : m;
    });
  }
  function katexSpanToMath(full) {
    const ann = /<annotation[^>]*>([\s\S]*?)<\/annotation>/.exec(full);
    if (ann && ann[1] && ann[1].trim()) return '$' + ann[1].trim() + '$';
    const label = /aria-label="([^"]*)"/.exec(full);
    if (label && label[1]) return '$' + label[1] + '$';
    try {
      const doc = new DOMParser().parseFromString(full, 'text/html');
      const root = doc.body.firstElementChild || doc.body;
      // v3.7.88：豆包有时只输出 KaTeX 的 HTML 层（没有 MathML/annotation），
      // 此时必须按 KaTeX 的 vlist 布局还原，不能按 DOM 顺序拼文本。
      const isKatexHtml = /class="[^"]*\bkatex-html\b/.test(full);
      let tex = (isKatexHtml ? katexNodeToLatex(root) : mathNodeToLatex(root)).replace(/\s+/g, ' ').trim();
      // 负号叠加层的规范化输出
      tex = tex.replace(/\\not=/g, '\\ne')
        .replace(/\\not</g, '\\nless')
        .replace(/\\not>/g, '\\ngtr')
        .replace(/\\not\\in(?![A-Za-z])/g, '\\notin')
        .replace(/\\not\\leq/g, '\\nleq')
        .replace(/\\not\\geq/g, '\\ngeq')
        .replace(/\\not\\subseteq/g, '\\nsubseteq');
      // 控制词后紧跟字母会被当成更长的命令（\capB 解析失败），补空格
      tex = spaceLatexCommands(tex);
      if (tex) return '$' + tex + '$';
    } catch (e) { /* 解析失败走渲染文本 */ }
    const txt = stripTags(full);
    return txt ? '$' + txt + '$' : '';
  }
  // v3.7.85：公式内 Unicode 运算符/符号 → LaTeX（豆包渲染的文本层用 Unicode，Obsidian 不渲染，必须转命令）
  function unicodeToLatex(s) {
    return String(s)
      // 先把文字层里的 LaTeX 特殊字符转义（必须在下面插入命令之前做，
      // 否则会把新插入的反斜杠/花括号再转义一次）
      .replace(/\u200b/g, '')
      .replace(/\\/g, '\\backslash ')
      .replace(/\{/g, '\\{').replace(/\}/g, '\\}')
      .replace(/\$/g, '\\$').replace(/&/g, '\\&').replace(/#/g, '\\#')
      .replace(/%/g, '\\%').replace(/_/g, '\\_')
      // 大运算符/集合/关系
      .replace(/⋃/g, '\\bigcup').replace(/∪/g, '\\cup').replace(/∩/g, '\\cap')
      .replace(/∑/g, '\\sum').replace(/∏/g, '\\prod').replace(/∫/g, '\\int')
      .replace(/∬/g, '\\iint').replace(/∭/g, '\\iiint').replace(/∮/g, '\\oint')
      .replace(/∞/g, '\\infty').replace(/∅/g, '\\emptyset').replace(/⋯/g, '\\cdots')
      .replace(/…/g, '\\ldots').replace(/⋮/g, '\\vdots').replace(/⋱/g, '\\ddots')
      .replace(/→/g, '\\to').replace(/←/g, '\\leftarrow').replace(/↑/g, '\\uparrow')
      .replace(/↓/g, '\\downarrow').replace(/↦/g, '\\mapsto')
      .replace(/⇒/g, '\\Rightarrow').replace(/⇐/g, '\\Leftarrow')
      .replace(/⇔/g, '\\Leftrightarrow').replace(/↔/g, '\\leftrightarrow')
      .replace(/−/g, '-').replace(/≠/g, '\\neq').replace(/≤/g, '\\leq').replace(/≥/g, '\\geq')
      .replace(/⩽/g, '\\leqslant').replace(/⩾/g, '\\geqslant')
      .replace(/≰/g, '\\nleq').replace(/≱/g, '\\ngeq').replace(/≮/g, '\\nless').replace(/≯/g, '\\ngtr')
      .replace(/≈/g, '\\approx').replace(/≡/g, '\\equiv').replace(/≅/g, '\\cong')
      .replace(/∼/g, '\\sim').replace(/∝/g, '\\propto').replace(/≃/g, '\\simeq')
      .replace(/≪/g, '\\ll').replace(/≫/g, '\\gg').replace(/≺/g, '\\prec').replace(/≻/g, '\\succ')
      .replace(/≲/g, '\\lesssim').replace(/≳/g, '\\gtrsim')
      .replace(/∈/g, '\\in').replace(/∉/g, '\\notin').replace(/∋/g, '\\ni')
      .replace(/⊂/g, '\\subset').replace(/⊃/g, '\\supset')
      .replace(/⊆/g, '\\subseteq').replace(/⊇/g, '\\supseteq')
      .replace(/⊄/g, '\\not\\subset').replace(/⊅/g, '\\not\\supset')
      .replace(/⊈/g, '\\nsubseteq').replace(/⊉/g, '\\nsupseteq')
      .replace(/∖/g, '\\setminus').replace(/∣/g, '\\mid').replace(/∥/g, '\\parallel')
      .replace(/∦/g, '\\nparallel').replace(/⊥/g, '\\perp').replace(/⊤/g, '\\top')
      .replace(/⋅/g, '\\cdot').replace(/∘/g, '\\circ').replace(/×/g, '\\times')
      .replace(/÷/g, '\\div').replace(/±/g, '\\pm').replace(/∓/g, '\\mp')
      .replace(/∗/g, '\\ast').replace(/⋆/g, '\\star').replace(/∙/g, '\\bullet')
      .replace(/⊕/g, '\\oplus').replace(/⊗/g, '\\otimes').replace(/⊙/g, '\\odot')
      .replace(/∂/g, '\\partial').replace(/√/g, '\\sqrt')
      .replace(/∀/g, '\\forall').replace(/∃/g, '\\exists').replace(/∇/g, '\\nabla')
      .replace(/∧/g, '\\wedge').replace(/∨/g, '\\vee').replace(/¬/g, '\\neg')
      .replace(/∠/g, '\\angle').replace(/△/g, '\\triangle')
      .replace(/⟨/g, '\\langle').replace(/⟩/g, '\\rangle')
      .replace(/⌈/g, '\\lceil').replace(/⌉/g, '\\rceil')
      .replace(/⌊/g, '\\lfloor').replace(/⌋/g, '\\rfloor')
      .replace(/ℓ/g, '\\ell').replace(/ℏ/g, '\\hbar')
      .replace(/ℜ/g, '\\Re').replace(/ℑ/g, '\\Im').replace(/℘/g, '\\wp')
      .replace(/†/g, '\\dagger').replace(/‡/g, '\\ddagger')
      .replace(/ℝ/g, '\\mathbb{R}').replace(/ℕ/g, '\\mathbb{N}').replace(/ℤ/g, '\\mathbb{Z}')
      .replace(/ℚ/g, '\\mathbb{Q}').replace(/ℂ/g, '\\mathbb{C}')
      // 希腊字母（KaTeX HTML 文字层直接给 Unicode）
      .replace(/α/g, '\\alpha').replace(/β/g, '\\beta').replace(/γ/g, '\\gamma')
      .replace(/δ/g, '\\delta').replace(/ε/g, '\\varepsilon').replace(/ϵ/g, '\\epsilon')
      .replace(/ζ/g, '\\zeta').replace(/η/g, '\\eta').replace(/θ/g, '\\theta').replace(/ϑ/g, '\\vartheta')
      .replace(/ι/g, '\\iota').replace(/κ/g, '\\kappa').replace(/λ/g, '\\lambda').replace(/μ/g, '\\mu')
      .replace(/ν/g, '\\nu').replace(/ξ/g, '\\xi').replace(/π/g, '\\pi').replace(/ϖ/g, '\\varpi')
      .replace(/ρ/g, '\\rho').replace(/ϱ/g, '\\varrho').replace(/σ/g, '\\sigma').replace(/ς/g, '\\varsigma')
      .replace(/τ/g, '\\tau').replace(/υ/g, '\\upsilon').replace(/φ/g, '\\varphi').replace(/ϕ/g, '\\phi')
      .replace(/χ/g, '\\chi').replace(/ψ/g, '\\psi').replace(/ω/g, '\\omega')
      .replace(/Γ/g, '\\Gamma').replace(/Δ/g, '\\Delta').replace(/Θ/g, '\\Theta')
      .replace(/Λ/g, '\\Lambda').replace(/Ξ/g, '\\Xi').replace(/Π/g, '\\Pi')
      .replace(/Σ/g, '\\Sigma').replace(/Υ/g, '\\Upsilon').replace(/Φ/g, '\\Phi')
      .replace(/Ψ/g, '\\Psi').replace(/Ω/g, '\\Omega')
      .replace(/′/g, "'").replace(/″/g, "''");
  }
  function mathNodeToLatex(root) {
    let out = '';
    for (const c of root.childNodes) {
      if (c.nodeType === 3) { out += unicodeToLatex(c.textContent); continue; }
      const t = (c.tagName || '').toUpperCase();
      const cls = (c.className && c.className.toString) ? c.className.toString() : '';
      if (t === 'ANNOTATION') return c.textContent.trim(); // 有 LaTeX 源码直接返回
      if (t === 'MFRAC' || (t === 'SPAN' && /\bmfrac\b/.test(cls)) || t === 'MJX-FRAC') {
        const kids = c.children;
        if (kids && kids[0] && kids[1]) { out += '\\frac{' + mathNodeToLatex(kids[0]) + '}{' + mathNodeToLatex(kids[1]) + '}'; continue; }
      }
      if (t === 'MSUB' || (t === 'SPAN' && /\bmsub\b/.test(cls)) || t === 'MJX-SUB') {
        const kids = c.children;
        if (kids && kids[0] && kids[1]) { out += mathNodeToLatex(kids[0]) + '_{' + mathNodeToLatex(kids[1]) + '}'; continue; }
      }
      if (t === 'MSUP' || (t === 'SPAN' && /\bmsup\b/.test(cls)) || t === 'MJX-SUP') {
        const kids = c.children;
        if (kids && kids[0] && kids[1]) { out += mathNodeToLatex(kids[0]) + '^{' + mathNodeToLatex(kids[1]) + '}'; continue; }
      }
      if (t === 'MSUBSUP' || t === 'MJX-SUBSUP') {
        const kids = c.children;
        if (kids && kids[0] && kids[1] && kids[2]) { out += mathNodeToLatex(kids[0]) + '_{' + mathNodeToLatex(kids[1]) + '}^{' + mathNodeToLatex(kids[2]) + '}'; continue; }
      }
      // v3.7.85：munderover/mover/munder（⋃_{i=1}^{n}、∑、∫ 的上下限结构）→ base_{下}^{上}
      if (t === 'MUNDEROVER' || t === 'MJX-MUNDEROVER' || (t === 'SPAN' && /\bmunderover\b/.test(cls))) {
        const kids = c.children;
        if (kids && kids[0] && kids[1] && kids[2]) {
          // kids[0] 已经是还原后的 LaTeX，不能再过一次转义
          out += mathNodeToLatex(kids[0]) + '_{' + mathNodeToLatex(kids[1]) + '}^{' + mathNodeToLatex(kids[2]) + '}';
          continue;
        }
      }
      if (t === 'MSQRT' || (t === 'SPAN' && /\bsqrt\b/.test(cls)) || t === 'MJX-SQRT') {
        out += '\\sqrt{' + mathNodeToLatex(c) + '}'; continue;
      }
      out += mathNodeToLatex(c);
    }
    return out;
  }
  // v3.7.88：KaTeX "HTML-only" 渲染（无 annotation）的结构还原。
  // KaTeX 把上下标和分数放在 vlist 排版层里，DOM 顺序是 [下标/分母][分数线][上标/分子]，
  // 按 DOM 顺序拼文本会得到 Bi、21、\bigcupi=1n 这类错误；这里按每行的 top 位置还原上下关系。
  function katexClsOf(el) {
    return (el && el.className && el.className.toString) ? el.className.toString() : '';
  }
  function katexTopOf(row) {
    const m = /top:\s*(-?[\d.]+)em/.exec((row.getAttribute && row.getAttribute('style')) || '');
    return m ? parseFloat(m[1]) : null;
  }
  function katexRowsOf(el) {
    const vlist = el.querySelector && el.querySelector('.vlist');
    if (!vlist) return [];
    return Array.from(vlist.children).filter((row) => katexTopOf(row) !== null);
  }
  function katexChildrenToLatex(el) {
    let s = '';
    for (const kid of el.childNodes) s += katexNodeToLatex(kid);
    return s;
  }
  function katexScriptsToLatex(el) {
    const rows = katexRowsOf(el);
    if (!rows.length) return '';
    let sub = null;
    let sup = null;
    if (rows.length >= 2) {
      const sorted = rows.slice().sort((a, b) => katexTopOf(a) - katexTopOf(b));
      sup = sorted[0]; // top 更负 = 位置更高 = 上标
      sub = sorted[sorted.length - 1];
    } else if (/\bvlist-t2\b/.test(katexClsOf(el.querySelector('.vlist-t')))) {
      sub = rows[0]; // 有深度 = 下标（x_i）；否则是上标（x^2）
    } else {
      sup = rows[0];
    }
    let s = '';
    if (sub) s += '_{' + katexChildrenToLatex(sub) + '}';
    if (sup) s += '^{' + katexChildrenToLatex(sup) + '}';
    return s;
  }
  function katexHasCls(el, name) {
    const cls = katexClsOf(el);
    return !!cls && (' ' + cls.replace(/\s+/g, ' ') + ' ').indexOf(' ' + name + ' ') >= 0;
  }
  function katexRowHasDirectCls(row, name) {
    for (const kid of row.children || []) {
      if (katexHasCls(kid, name)) return true;
    }
    return false;
  }
  function katexFracParts(el) {
    // 只跳过本层的分数线行：分子里嵌套分数的分数线在更深层，
    // 用 querySelector 会把整个分子行误删（\frac{\frac{1}{2}}{3} → 321）。
    const rows = katexRowsOf(el).filter((row) => !katexRowHasDirectCls(row, 'frac-line'));
    if (rows.length < 2) return null;
    rows.sort((a, b) => katexTopOf(a) - katexTopOf(b)); // 更负 = 分子
    return [katexChildrenToLatex(rows[0]), katexChildrenToLatex(rows[1])];
  }
  function katexFracToLatex(el) {
    const parts = katexFracParts(el);
    return parts ? '\\frac{' + parts[0] + '}{' + parts[1] + '}' : '';
  }
  // \binom 在 KaTeX HTML 里是 mopen + “没有分数线”的 mfrac + mclose，
  // 按 \frac 还原会凭空多出一条分数线。
  function katexBinomToLatex(el) {
    const kids = Array.from(el.children || []);
    if (kids.length !== 3) return '';
    const open = kids[0];
    const frac = kids[1];
    const close = kids[2];
    if (!katexHasCls(open, 'mopen') || !katexHasCls(frac, 'mfrac') || !katexHasCls(close, 'mclose')) return '';
    if (frac.querySelector && frac.querySelector('.frac-line')) return '';
    if ((open.textContent || '').trim() !== '(' || (close.textContent || '').trim() !== ')') return '';
    const parts = katexFracParts(frac);
    return parts ? '\\binom{' + parts[0] + '}{' + parts[1] + '}' : '';
  }
  function katexSqrtToLatex(el) {
    const rootEl = el.querySelector('.root');
    const index = rootEl ? katexChildrenToLatex(rootEl) : '';
    // 取根号自己的 vlist（.root 里的 vlist 是根指数）
    let main = null;
    for (const kid of el.children || []) {
      if (katexHasCls(kid, 'vlist-t')) { main = kid; break; }
    }
    let rad = '';
    if (main) {
      for (const row of katexRowsOf(main)) {
        if (katexRowHasDirectCls(row, 'hide-tail')) continue; // 根号符号行
        rad += katexChildrenToLatex(row);
      }
    } else {
      rad = katexChildrenToLatex(el);
    }
    return index ? '\\sqrt[' + index + ']{' + rad + '}' : '\\sqrt{' + rad + '}';
  }
  function katexOverlineToLatex(el) {
    const rows = katexRowsOf(el).filter((row) => !katexRowHasDirectCls(row, 'overline-line'));
    return rows.length ? '\\overline{' + katexChildrenToLatex(rows[0]) + '}' : '';
  }
  // KaTeX 非伸缩重音：\hat 等用文字层，\vec 的箭头是 SVG；宽重音在 .svg-align 行里
  const KATEX_ACCENT_CMD = {
    '^': 'hat', 'ˇ': 'check', 'ˉ': 'bar', '˙': 'dot', '¨': 'ddot',
    '~': 'tilde', '˜': 'tilde', '´': 'acute', '`': 'grave',
    vec: 'vec', widehat: 'widehat', widetilde: 'widetilde',
  };
  function katexDirectChild(row, name) {
    for (const kid of row.children || []) {
      if (katexHasCls(kid, name)) return kid;
    }
    return null;
  }
  function katexAccentToLatex(el) {
    let base = '';
    let accent = '';
    for (const row of katexRowsOf(el)) {
      const body = katexDirectChild(row, 'accent-body');
      if (body) {
        const txt = (body.textContent || '').trim();
        if (txt) accent = txt;
        else if (body.querySelector && body.querySelector('.overlay, svg')) accent = 'vec'; // htmlToMd 会先删 svg，.overlay 仍在
        continue; // 重音行不算基字符
      }
      if (katexHasCls(row, 'svg-align')) {
        // 宽重音行本身就是 .svg-align；按 viewBox 高度区分：帽子 239/300，波浪 260/286。
        // htmlToMd 先删了 svg，高度保存在 data-katex-vb 标记里（直接调 katexSpanToMath 时读 svg）。
        let h = 0;
        const marker = row.querySelector && row.querySelector('[data-katex-vb]');
        if (marker) h = parseFloat(marker.getAttribute('data-katex-vb')) || 0;
        if (!h) {
          const svg = row.querySelector && row.querySelector('svg');
          const vb = (svg && svg.getAttribute && svg.getAttribute('viewBox')) || '';
          const hm = /^0 0 [\d.]+ ([\d.]+)$/.exec(vb);
          h = hm ? parseFloat(hm[1]) : 0;
        }
        if (h === 239 || h === 300) accent = 'widehat';
        else if (h === 260 || h === 286) accent = 'widetilde';
        continue; // SVG 重音行不是基字符
      }
      base += katexChildrenToLatex(row);
    }
    const cmd = KATEX_ACCENT_CMD[accent];
    return cmd ? '\\' + cmd + '{' + base + '}' : base;
  }
  // \sum\limits / \overset / \underset：KaTeX 用 .op-limits 的 vlist 表示上下限
  function katexOpLimitsToLatex(el) {
    const rows = katexRowsOf(el);
    if (rows.length < 2) return '';
    let baseRow = null;
    for (const row of rows) {
      if (row.querySelector && row.querySelector('.mop')) { baseRow = row; break; }
    }
    if (!baseRow) {
      baseRow = rows.slice().sort((a, b) => Math.abs(katexTopOf(a) + 3) - Math.abs(katexTopOf(b) + 3))[0];
    }
    const baseTop = katexTopOf(baseRow);
    const base = katexChildrenToLatex(baseRow);
    let sub = '';
    let sup = '';
    for (const row of rows) {
      if (row === baseRow) continue;
      const tex = katexChildrenToLatex(row);
      if (katexTopOf(row) < baseTop) sup = tex;
      else sub = tex;
    }
    const isBigOp = /^\\(sum|prod|int|iint|iiint|oint|bigcup|bigcap|bigvee|bigwedge|lim|max|min|sup|inf|det|gcd|Pr|sin|cos|tan|log|ln|exp)$/.test(base);
    if (isBigOp) return base + (sub ? '_{' + sub + '}' : '') + (sup ? '^{' + sup + '}' : '');
    if (sup) return '\\overset{' + sup + '}{' + base + '}';
    if (sub) return '\\underset{' + sub + '}{' + base + '}';
    return base;
  }
  // \underbrace / \overbrace：外层 munder/mover 的 body 行里还嵌一层带 .stretchy 花括号的 munder/mover
  function katexUnderOverToLatex(el, isUnder) {
    const rows = katexRowsOf(el);
    if (rows.length < 2) return '';
    const sorted = rows.slice().sort((a, b) => katexTopOf(a) - katexTopOf(b)); // 从上到下
    const bodyRow = isUnder ? sorted[0] : sorted[sorted.length - 1];
    const labelRow = isUnder ? sorted[sorted.length - 1] : sorted[0];
    const inner = bodyRow.querySelector && bodyRow.querySelector(isUnder ? '.munder' : '.mover');
    if (!inner || !(inner.querySelector && inner.querySelector('.brace-left, .brace-right, .brace-center'))) return '';
    const content = katexRowsOf(inner)
      .filter((row) => !katexHasCls(row, 'svg-align')) // 花括号行本身带 .svg-align
      .map((row) => katexChildrenToLatex(row))
      .join('');
    const label = katexChildrenToLatex(labelRow);
    return (isUnder ? '\\underbrace{' : '\\overbrace{') + content + '}' + (isUnder ? '_{' : '^{') + label + '}';
  }
  const KATEX_FONT_CMDS = ['mathbb', 'mathcal', 'mathfrak', 'mathbf', 'mathsf', 'mathtt', 'mathit', 'mathrm', 'boldsymbol'];
  const KATEX_OP_NAMES = [
    'lim', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'sup', 'inf',
    'det', 'dim', 'ker', 'hom', 'arg', 'deg', 'gcd', 'mod', 'bmod', 'Pr',
  ];
  function katexCellRowsOf(col) {
    const vlist = col.querySelector && col.querySelector('.vlist');
    if (!vlist) return [];
    const cells = [];
    for (const row of Array.from(vlist.children)) {
      const top = katexTopOf(row);
      if (top === null) continue;
      const tex = katexChildrenToLatex(row);
      if (tex.trim()) cells.push({ top, tex });
    }
    return cells;
  }
  function katexTableToLatex(el) {
    const cols = Array.from(el.children || []).filter((kid) => /\bcol-align-/.test(katexClsOf(kid)));
    if (!cols.length) return '';
    const colCells = cols.map(katexCellRowsOf);
    // 各列同行的 top 相同；按 top 升序（从上到下）排版，避免按 DOM 列优先拼接
    const tops = [];
    for (const cells of colCells) {
      for (const c of cells) {
        if (!tops.some((t) => Math.abs(t - c.top) < 0.05)) tops.push(c.top);
      }
    }
    tops.sort((a, b) => a - b);
    return tops.map((top) => colCells.map((cells) => {
      const hit = cells.find((c) => Math.abs(c.top - top) < 0.05);
      return hit ? hit.tex : '';
    }).join(' & ')).join(' \\\\ ');
  }
  function katexArrayToLatex(el) {
    const table = el.querySelector && el.querySelector('.mtable');
    if (!table) return '';
    // 定界符必须是直接子元素；表格之外还有可见内容时放弃，避免丢内容
    for (const kid of el.children || []) {
      if (katexHasCls(kid, 'mopen') || katexHasCls(kid, 'mclose')) continue;
      if (kid === table || (kid.contains && kid.contains(table))) continue;
      if ((kid.textContent || '').trim()) return '';
    }
    const openEl = Array.from(el.children || []).find((kid) => katexHasCls(kid, 'mopen'));
    const closeEl = Array.from(el.children || []).find((kid) => katexHasCls(kid, 'mclose'));
    const open = openEl ? (openEl.textContent || '').trim() : '';
    const close = closeEl ? (closeEl.textContent || '').trim() : '';
    let env = 'matrix';
    if (open === '{' && close === '') env = 'cases';
    else if (open === '{' && close === '}') env = 'Bmatrix';
    else if (open === '(' && close === ')') env = 'pmatrix';
    else if (open === '[' && close === ']') env = 'bmatrix';
    else if (open === '|' && close === '|') env = 'vmatrix';
    else if (open === '‖' && close === '‖') env = 'Vmatrix';
    const body = katexTableToLatex(table);
    if (!body) return '';
    return '\\begin{' + env + '}' + body + '\\end{' + env + '}';
  }
  function katexHasNotOverlay(el) {
    return !!(el.querySelector && el.querySelector('.rlap, .llap'));
  }
  function katexNodeToLatex(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      const t = node.textContent;
      if (!t) return '';
      return unicodeToLatex(t);
    }
    if (node.nodeType !== 1) return '';
    const tag = (node.tagName || '').toUpperCase();
    if (tag === 'SVG' || tag === 'PATH' || tag === 'STYLE') return '';
    const cls = katexClsOf(node);
    // 纯排版空元素（支撑、分数线、零宽空位、负号叠加层）不产生 LaTeX
    if (/(?:^|\s)(?:strut|pstrut|vlist-s|frac-line|nulldelimiter|mspace|rlap|llap|fix)(?:\s|$)/.test(cls)) return '';
    if (/\bmsupsub\b/.test(cls)) return katexScriptsToLatex(node);
    if (/\bmfrac\b/.test(cls)) return katexFracToLatex(node);
    if (/\bmtable\b/.test(cls)) {
      const body = katexTableToLatex(node);
      return body ? '\\begin{matrix}' + body + '\\end{matrix}' : '';
    }
    if (katexHasCls(node, 'minner')) {
      const arr = katexArrayToLatex(node);
      if (arr) return arr;
    }
    if (katexHasCls(node, 'mord')) {
      const binom = katexBinomToLatex(node);
      if (binom) return binom;
    }
    if (/\bsqrt\b/.test(cls)) return katexSqrtToLatex(node);
    if (/\boverline\b/.test(cls)) return katexOverlineToLatex(node);
    if (/\baccent\b/.test(cls)) return katexAccentToLatex(node);
    if (katexHasCls(node, 'op-limits')) return katexOpLimitsToLatex(node);
    if (katexHasCls(node, 'munder')) {
      const under = katexUnderOverToLatex(node, true);
      if (under) return under;
    }
    if (katexHasCls(node, 'mover')) {
      const over = katexUnderOverToLatex(node, false);
      if (over) return over;
    }
    if (katexHasCls(node, 'delimsizing')) {
      const d = (node.textContent || '').trim();
      if (d === '{') return '\\{';
      if (d === '}') return '\\}';
      if (d === '‖') return '\\|';
    }
    if (/\bmop\b/.test(cls)) {
      // KaTeX 把 sin/lim/Pr 渲染成文本算子，还原时要补反斜杠；∑/∫ 等符号交给 unicodeToLatex
      const name = (node.textContent || '').replace(/\s+/g, '');
      if (KATEX_OP_NAMES.indexOf(name) >= 0) return '\\' + name;
    }
    if (/\bmrel\b/.test(cls) && katexHasNotOverlay(node)) {
      // \not= / \notin：负号叠加层包在 rlap/llap 里，跳过它并给关系符补 \not。
      // 只在外层 mrel 加一次——内层 mrel 是斜杠包装本身，再递归会得到 \not\not=。
      let base = '';
      for (const kid of node.childNodes) {
        if (kid.nodeType === 1 && katexHasNotOverlay(kid)) continue;
        base += katexNodeToLatex(kid);
      }
      if (base) return '\\not' + base;
      // 宽关系符（\not\subset 等）的负号单独占一个 base，关系符在下一个 base，
      // 这里先补 \not，后面的关系符会紧跟上来。
      return '\\not';
    }
    for (const name of KATEX_FONT_CMDS) {
      if (katexHasCls(node, name)) return '\\' + name + '{' + katexChildrenToLatex(node) + '}';
    }
    if (katexHasCls(node, 'text')) return '\\text{' + katexChildrenToLatex(node) + '}';
    let inner = '';
    for (const kid of node.childNodes) inner += katexNodeToLatex(kid);
    return inner;
  }
  // 把豆包回答节点的 innerHTML 还原成 Markdown（innerText 会丢失 #、-、``` 等标记，导致 Obsidian 格式全乱）
  function htmlToMd(html) {
    let s = String(html || '');
    // 0) 丢弃页面渲染辅助区：<style>/<svg>（豆包"思维导图"渲染的 CSS/SVG 会污染 Markdown，必须先删）
    s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    // SVG 本身要删，但 KaTeX 宽重音（\widehat/\widetilde）的形状信息只在 svg 的 viewBox 里；
    // 删前把高度挂到空标记上，公式还原时用来区分帽子/波浪。
    s = s.replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, (m, attrs) => {
      const vb = /viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(attrs);
      return vb ? '<span data-katex-vb="' + vb[1] + '"></span>' : '';
    });
    // 1) 代码块（含 mermaid/latex）：<pre>…</pre> → ```lang … ```
    s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => {
      // 移除 pre 内豆包页面渲染的语言标签 div（如 <div class="language-latex">latex</div>），避免混入代码内容
      inner = inner.replace(/<div[^>]*class="[^"]*language-[\w-]+"[^>]*>[\s\S]*?<\/div>/gi, '');
      const cls = /class="[^"]*language-([\w-]+)/.exec(inner) || [];
      const lang = cls[1] || '';
      let code = stripTags(inner).replace(/\n+$/, '').trim();
      // 兜底：若首行仍是语言名（latex/mermaid），去掉
      const firstLine = (code.split('\n')[0] || '').trim();
      if (firstLine === lang || firstLine === 'latex' || firstLine === 'mermaid') {
        code = code.split('\n').slice(1).join('\n').trim();
      }
      return '\n```' + lang + '\n' + code + '\n```\n';
    });
    // 2) 行内代码 → `code`
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, c) => '`' + stripTags(c) + '`');
    // 3) 公式：优先取 <annotation> 里的标准 LaTeX，其次 aria-label，最后按 DOM 结构还原
    // v3.7.81/82：KaTeX 是嵌套 span，非贪婪正则匹配到第一个 </span> 会截断子树；
    // 且豆包可能用 MathJax/MathML 渲染（mjx-*、<math>），必须按括号配对取完整子树再递归还原
    s = mathHtmlToMath(s);
    // 4) 标题 → # …（先处理，避免后面 stripTags 破坏）
    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, t) => '\n' + '#'.repeat(+n) + ' ' + stripTags(t) + '\n');
    // 5) 加粗/斜体
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (m, t) => '**' + stripTags(t) + '**');
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (m, t) => '*' + stripTags(t) + '*');
    // 6) 无序列表项 → - 条目
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, t) => '- ' + stripTags(t) + '\n');
    // 6.5) 上标/下标（<sup>2</sup> → ^{2}、<sub>1</sub> → _{1}，保住平方/指数语义，防止 x² 退化成 x2）
    s = s.replace(/<sup>([^<]*)<\/sup>/gi, '^{$1}');
    s = s.replace(/<sub>([^<]*)<\/sub>/gi, '_{$1}');
    // 7) 段落/换行/表格行
    s = s.replace(/<\/p>/gi, '\n\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (m, t) => stripTags(t).replace(/\s+/g, ' | ').trim() + '\n');
    s = s.replace(/<th[^>]*>|<\/th>/gi, '');
    s = s.replace(/<td[^>]*>|<\/td>/gi, '');
    // 7.5) 引用块 → > 行（保留 Obsidian callout 折叠语法，如 > [!note]- 标题，渲染为可点击展开的折叠块）
    s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inner) => {
      const txt = stripTags(inner).replace(/&nbsp;/g, ' ');
      return txt.split('\n').map((ln) => (ln.trim() ? '> ' + ln.trim() : '>')).join('\n') + '\n';
    });
    // 8) 移除剩余标签
    s = s.replace(/<[^>]*>/g, '');
    s = s.replace(/&nbsp;/g, ' ');
    s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    // 9) 清理多余空行，去掉每行多余缩进
    s = s.replace(/\n{3,}/g, '\n\n');
    s = s.split('\n').map((ln) => ln.replace(/\s+$/g, '')).join('\n');
    // 10) 过滤豆包界面残留文案（思维导图渲染区的按钮/错误提示/品牌文案），清理零宽字符
    s = s.split('\n').filter((ln) => {
      const l = ln.trim();
      if (l.includes('生成失败') || l.includes('预览查看代码') || l.includes('豆包你的 AI 助手') || l.includes('助力每日工作学习')) return false;
      return true;
    }).join('\n');
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
    // 11) 删除代码块前独立成行的语言名（豆包偶发在 ```latex/```mermaid 前多输出一行 "latex"/"mermaid"）
    s = s.replace(/^latex\s*\n(?=```latex)/gim, '');
    s = s.replace(/^mermaid\s*\n(?=```mermaid)/gim, '');
    return s.trim();
  }

  // 判定内容是否"明显的用户消息/字幕"：以 [mm:ss] 时间戳开头，且不含任何 Markdown 标记（#、```、|）
  // 豆包 AI 笔记回答会带 ## 标题/```mermaid/表格分隔符，字幕/用户消息没有 → 不保存
  function looksLikeUserMsg(t) {
    const s = String(t || '').trim();
    if (!/^\[\d{1,2}:\d{2}\]/.test(s)) return false;
    if (/[#`|]/.test(s)) return false;
    return true;
  }

  // v3.7.86：修正轮回答专用判定——修正行以 [mm:ss] 开头、不含 #/```/|，会被 looksLikeUserMsg
  // 误判成"字幕回显"丢弃。修正回答只要含至少一条时间戳行，就应交给 mergeFixLines 处理。
  function looksLikeFixAnswer(t) {
    const s = String(t || '').trim();
    return s.length > 20 && /\[\d{1,2}:\d{2}\]/.test(s);
  }

  // 判定内容是否"笔记特征"：含 Markdown 标题（#）、代码块（```）、或核心要点/术语表/易错点/思维导图/关键节点等关键词
  // 豆包侧边栏历史对话列表、页面杂鱼文本不含这些特征 → 不保存
  function looksLikeNote(t) {
    const s = String(t || '');
    if (/#{1,6}\s/.test(s)) return true;
    if (s.includes('```')) return true;
    if (s.includes('核心要点') || s.includes('术语表') || s.includes('易错点') ||
        s.includes('思维导图') || s.includes('关键节点')) return true;
    return false;
  }

  // 内容指纹：去空白后的长度 + 开头 60 字 —— 同一回答的不同快照（结尾/换行有细微差异）视为同一条
  function sig(t) {
    const s = String(t || '').replace(/\s+/g, '').trim();
    return s.length + ':' + s.slice(0, 60);
  }

  // v3.7.98：串号防线——下一条的笔记正文被写成上一条视频的内容。
  // extractAnswerText 靠"最后一次出现的《标题》"截取，新回答尚未输出时这个截取点会落到
  // 上一条回答的标题上，整段旧笔记被当成"本次结果"。两道确定性校验：
  // ①发送前记录页面当前回答的指纹（基线），文本与基线完全一致 = 新回答还没出现，继续等；
  // ②回答里的笔记标题必须与本次视频标题一致，不一致就不写盘（宁可等超时，也不写错文件）。
  function noteTitleOf(t) {
    const s = String(t || '');
    const hs = s.match(/^#+\s*《([^》\n]{1,80})》/gm) || [];
    if (hs.length) {
      const last = hs[hs.length - 1].match(/《([^》\n]{1,80})》/);
      if (last) return last[1].trim();
    }
    const all = s.match(/《([^》\n]{1,80})》/g) || [];
    if (all.length) return all[all.length - 1].replace(/[《》]/g, '').trim();
    return '';
  }

  function normTitle(x) {
    return String(x || '').replace(/[《》【】「」\s"'“”‘’·、,.:：;；!！?？()（）\-—_/\\|]/g, '');
  }

  // 最长公共连续子串长度：中文里 4 字连续相同，足以认定是同一个视频标题
  function commonRun(a, b) {
    const s1 = normTitle(a), s2 = normTitle(b);
    if (!s1 || !s2) return 0;
    let best = 0;
    for (let i = 0; i < s1.length; i++) {
      for (let j = i + best + 1; j <= s1.length; j++) {
        if (s2.indexOf(s1.slice(i, j)) >= 0) best = j - i;
        else break;
      }
    }
    return best;
  }

  function titleMatches(noteTitle, title) {
    const a = normTitle(noteTitle), b = normTitle(title);
    if (!a || !b) return true; // 缺一边不拦，避免把正常笔记误杀
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    return commonRun(a, b) >= 4;
  }

  // 从页面提取"最后一条 AI 回答"文本（多候选选择器，兼容豆包页面结构变化）
  function extractAnswerText() {
    const STATE_RE = /(正在|思考|整理|生成|分析中|稍等|请稍候|加载中|回答中|努力|输入中)/;
    const sels = [
      '[data-testid*="assistant"]',
      '[data-testid*="answer"]',
      '[data-testid*="bot"]',
      '[class*="assistant"]',
      '[class*="answer"]',
      '[class*="message"][class*="bot"]',
      '[class*="message"][class*="ai"]',
      '[class*="markdown"]',
      '[class*="rich-text"]',
      '[class*="chat-content"]',
      '[class*="reply-content"]',
      '[class*="bot-answer"]',
      '[class*="message-content"]'
    ];
    for (const sel of sels) {
      try {
        const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
          if (el.offsetParent === null && el.getClientRects().length === 0) return false;
          // 排除输入框及其内部内容（避免把发送到输入框的字幕当成回答）
          if (el.closest && el.closest('[contenteditable], textarea, [role="textbox"]')) return false;
          // 排除用户消息（提示词+字幕回显），只保留 AI 回答
          if (el.closest && el.closest('[class*="user-message"], [class*="message-user"], [class*="user-message-content"], [data-testid*="user"], [class*="mine"], [class*="self"]')) return false;
          return true;
        });
        if (nodes.length) {
          // 拼接所有匹配节点的 HTML 并还原成 Markdown（豆包回答可能被拆成多个区块：核心要点/思维导图/关键节点）
          // 用 innerHTML+转换而非 innerText：保住 ## 标题、- 列表、```mermaid 代码块、公式等格式
          const raw = nodes.map((n) => htmlToMd(n.innerHTML || ''));
          let t = raw.filter((txt) => {
            if (txt.includes('字幕内容：')) return false;
            if (txt.includes('你是学习笔记助手')) return false;
            if (txt.includes('请把下面这段')) return false;
            return true;
          }).join('\n\n').trim();
          // 从"最后一次出现"的起始标志（# 《标题》/《标题》/## 核心要点）开始截取：
          // 每条笔记回答都以这三者之一开头，最后一次出现 = 最新一条回答的起点，
          // 上一条/上上条历史回答、用户消息（公式修正请求）、UI 残留全部切掉；
          // v3.7.85：加裸《 标志——豆包最新回答若不带 # 前缀，只认 # 《 会把截取点落到更早的历史回答上；
          // 截取点若落在 '# 《' 内部（丢了 # 前缀），回退到 # 保持标题格式
          // v3.7.96：六板块模板新增「一、核心要点」起始标志——豆包偶尔会漏掉 # 《标题》 行，
          // 只认 # 《 会把截取点落到更早的历史回答上
          const START_MARKERS = ['# 《', '《', '## 一、核心要点', '## 核心要点'];
          let cutAt = -1;
          for (const mk of START_MARKERS) {
            const idx = t.lastIndexOf(mk);
            if (idx > cutAt) cutAt = idx;
          }
          if (cutAt > 0 && t.slice(cutAt - 2, cutAt) === '# ') cutAt -= 2;
          if (cutAt > 0) t = t.slice(cutAt);
          // 截掉回答末尾豆包页面的"推荐提问/相关问题"（在最后一条 [mm:ss] 时间戳之后，或挤在同一行混入）
          const tsLines = t.split('\n');
          let lastTs = -1;
          for (let i = 0; i < tsLines.length; i++) {
            if (/^\[\d{1,2}:\d{2}\]/.test(tsLines[i].trim())) lastTs = i;
          }
          if (lastTs >= 0) {
            // 若最后一条时间戳行内混入了推荐问句（" 如何/ 怎样/ 为什么/ 哪些/ 是什么/ 怎么" 开头），在该位置截掉
            const lastLine = tsLines[lastTs];
            const q = /(\s(?:如何|怎样|为什么|哪些|是什么|怎么)\S)/.exec(lastLine);
            if (q && q.index > 6) tsLines[lastTs] = lastLine.slice(0, q.index);
            t = tsLines.slice(0, lastTs + 1).join('\n');
          }
          // 过滤加载/状态类短文本，避免把"正在整理中…"当成回答
          // v3.7.96：六板块结构化笔记比原三板块长（术语表+易错点），上限由 8000 提到 16000；
          // 字幕回显仍被上面"字幕内容："等提示词特征过滤，不会被误当成回答
          if (t.length > 20 && t.length <= 16000 && !(t.length < 200 && STATE_RE.test(t))) return t;
        }
      } catch (e) { /* 尝试下一个选择器 */ }
    }
    // 兜底：取最后一个"不含用户消息特征"的较长文本块（用户消息含提示词/字幕内容，AI 回答不含）
    try {
      const big = Array.from(document.querySelectorAll('div, section, main, article, [class*="message"]')).filter((el) => {
        if (el.offsetParent === null && el.getClientRects().length === 0) return false;
        if (el.closest && el.closest('[contenteditable], textarea, [role="textbox"]')) return false;
        const tt = (el.innerText || el.textContent || '').trim();
        if (tt.length <= 200 || tt.length > 16000) return false;
        if (tt.includes('字幕内容：')) return false;
        if (tt.includes('你是学习笔记助手')) return false;
        if (tt.includes('请把下面这段')) return false;
        return true;
      });
      if (big.length) {
        // 用 innerHTML 还原 Markdown 格式（保标题/列表/代码块），而非 innerText 纯文本
        const t = htmlToMd(big[big.length - 1].innerHTML || '');
        if (t.length > 200) return t;
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  // 豆包整理完成后，把回答保存到 Obsidian；未配置 Obsidian 时静默，其他失败复制兜底
  // 把笔记里的 ```latex 代码块转成 Obsidian 原生公式（$$...$$），由 Obsidian 内置 MathJax 渲染。
  // 零依赖、零网络、零第三方插件：Obsidian 内置渲染器必然可用，公式必然显示。
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

  // v3.7.97：行内公式收尾规整——修掉逐符号转换遗留的三类坏形态：
  // ① $ 被插进花括号内部（g_{$m}、V_{GS$(TH)}、R_{D$}）；
  // ② 整条等式被切成碎片 $（$V_{CC}=$U_{RD}$+$U_{O}$）；
  // ③ 半包公式（$V=-$IR_{D}+V_{CC}$、$V_{DSQ}=$V_{DD}-...）。
  // 只做"删多余 $ / 合并纯数学碎片"，不主动给新符号加 $；$$ 块、代码块、行内代码原样保护。
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
        // a / gap / b 都非空且不含中文或句读，才算完整两对；空段或中文段留给半包修复步骤
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
    // $A$B$：半包邻接两片（A、B 都是纯数学串）→ 合并成 $AB$
    const math = '[^$一-鿿，。；：、！？]*';
    let prev;
    do {
      prev = line;
      line = line.replace(new RegExp('\\$(' + math + ')\\$(' + math + ')\\$', 'g'), (m, a, b) => '$' + a + b + '$');
    } while (line !== prev);
    return line;
  }

  function fixHalfWrapped(line) {
    // 删除紧贴数学运算符边界的游离 $（误闭合 / 误开启）
    line = line.replace(/(?<=[=+\-−×÷/^,(\[{_])\$/g, '');
    line = line.replace(/\$(?=[=+\-−×÷/^,)\]}_])/g, '');
    return line;
  }

  // v3.7.99：行内 `$` 数量为奇数时的兜底。
  // 回答被截断会留下单边 `$`（"等价恒流条件：$V_{GD}"），单个 $ 会让该行之后全被当成公式。
  // 若最后一个 `$` 后面只剩纯数学字符 → 补一个 `$` 收口；否则删掉这个游离 `$`（退化成普通文本，不乱码）。
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
    // v3.7.99：按行处理，不再用正则整篇抢 `$$` 块。
    // 旧实现对 `$$[\s\S]*?$$` 全篇懒惰配对，一旦某行行内多出一个 `$`（如 \frac{V_{DD}}{R_{D}$$}$），
    // 这个假 `$$` 会和后面几十行后的真 `$$` 配成一块，整段正文被当公式保护 → 坏 `$$` 永不被修，
    // 而且渲染时正文被吞进公式块（"部分乱码"的直接原因）。
    // 新规则：只有行首 `$$` 才算块边界；行内出现的 `$$` 一律折成 `$`；代码块/块级公式原样保留。
    const keep = [];
    const lines = String(md || '').split('\n');
    const out = [];
    let inFence = false;
    let inDisplay = false;
    for (const raw of lines) {
      const t = raw.trim();
      if (/^(```|~~~)/.test(t)) { inFence = !inFence; out.push(raw); continue; }
      if (inFence) { out.push(raw); continue; }
      // 行首 `$$`：块级公式边界，原样保留
      if (/^\$\$/.test(t)) {
        // 同一行闭合（$$公式$$）算完整块，不改；否则视为块开始/结束
        const closedSameLine = /^\$\$[\s\S]*\$\$\s*$/.test(t) && t.length > 4;
        if (!closedSameLine) inDisplay = !inDisplay;
        out.push(raw);
        continue;
      }
      if (inDisplay) { out.push(raw); continue; }
      // 行内出现 `$$` = 行内公式被多插了 `$`，折成单个 `$`
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
    const exclude = new Set(['is','ok','ai','tv','pc','usb','url','app','git','zip','pdf','exe','md','css','js','html','api','key','vip','qq','wx','up','b','to','of','in','on','at','the','and','for','with','as','by','or','an','be','it','no','yes','do','go','we','my','me','he','she','his','her','you','your','this','that','these','those','from','into','out','over','under','about','not','but','so','if','then','than','are','was','were','can','may','must','will','would','shall','have','has','had','does','did','etc','eg','ie','vs','mv','kv','uv','mw','kw','hz','khz','mhz','ghz','ma','ua','ms','us','ns','min','cm','mm','km','kg','mf','uf','nf','pf','cos','sin','tan','arg','ln','log','exp','re','im','lim','max','sec','csc','cot','res','tanh','coth','arctan','arcsin','arccos','det','dim','ker','inf','sup','grad','div','curl','mos','pm','nm','pn','cc','ce','be','cb','ac','dc','tp','mcu','fpga','bjt','fet','igbt','i2c','spi','uart','gpio','ttl','cmos','led','lcd','oled','di','da','io','pid','plc','rs','ocr','free','store','bank','goal','end']);
    // v3.7.53：希腊字母 → LaTeX 命令映射（α0 → \alpha_0 等）
    const greekCmd = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', θ: 'theta', λ: 'lambda', μ: 'mu', φ: 'phi', ψ: 'psi', ω: 'omega', σ: 'sigma', ε: 'epsilon', π: 'pi', τ: 'tau', η: 'eta', κ: 'kappa', ν: 'nu', ξ: 'xi', ρ: 'rho' };
    // 排除代码块（```...```）、公式块（$$...$$）、行内代码（`...`）；v3.7.47 起单 $ 公式也分割，避免已生成的 $\mathrm{Re}(z)$ 内部再被转出嵌套 $ 
    const parts = src.split(/(\$\$[\s\S]*?\$\$|```[\s\S]*?```|`[^`\n]*`|\$[^$\n]+\$)/g);
    let out = parts.map((p, i) => {
      // v3.7.86：公式块/代码块内部一律原样保留。此前的"公式内 2~3 字母补下标"会把
      // $\frac{1}{2}mv^2$ 改成 m_v、$dx$ 改成 d_x，是公式错误的主要来源之一。
      if (i % 2 === 1) return p;
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
    // v3.7.97：转换出口再跑一遍收尾规整，清掉花括号内 $、碎片 $ 与半包
    return sanitizeInlineMath(out);
  }

  // v3.7.56：公式残留形态检测——不认符号认形状，供"豆包二次修复"闭环使用（检测器稳定，修复交给懂语义的豆包）
  function detectMathResidue(md) {
    // v3.7.93：只认"硬错误"，并且跳过代码块——之前的规则会把
    // ①```latex 块里合法的 LaTeX（V_{GS}、GS 等）当成残留  ②PN 结、AI 字幕这类大写缩写当成裸符号，
    // 于是每篇笔记都被判定"有残留"→ 反复发修正请求 → 多等几十秒。这是"莫名其妙反复修正"的根因。
    const hits = [];
    let inFence = false;
    for (const line of String(md || '').split('\n')) {
      const t0 = line.trim();
      if (/^(```|~~~)/.test(t0)) { inFence = !inFence; continue; }
      if (inFence) continue; // 代码块/公式块内部一律不管（合法 LaTeX 就写在这里）
      if (!t0) continue;
      const plain = line
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')
        .replace(/\$[^$\n]*\$/g, ' ')
        .replace(/`[^`\n]*`/g, ' ');
      if (!plain.trim()) continue;
      // 1) 裸 Unicode 数学符号（本该写 \sum \infty \partial \int \sqrt 等）
      if (/[∑∞∂∫√±∓≤≥≠∪∩⊆⊂∅∠⊥∥]/.test(plain)) { hits.push(t0.slice(0, 80)); continue; }
      // 2) 裸希腊字母
      if (/[αβγδθλμφψωσπτνκηξε]/.test(plain)) { hits.push(t0.slice(0, 80)); continue; }
      // 3) 未包 $ 的裸下标写法（V_GS、U_CE、I_B）
      if (/(?<![A-Za-z0-9_$\\])[A-Za-z]{1,3}_[A-Za-z0-9]{1,4}(?![A-Za-z0-9])/.test(plain)) { hits.push(t0.slice(0, 80)); continue; }
      // 4) 未包 $ 的"符号 = 数值"（VGS=3.5、R1=10）
      if (/(?<![A-Za-z0-9$\\])[A-Z]{1,4}[a-z]{0,2}\d{0,2}\s*=\s*[-+]?[0-9]/.test(plain)) { hits.push(t0.slice(0, 80)); continue; }
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
  // v3.7.75：豆包偶发输出裸 [!note]（缺 > 前缀）→ 补成标准 callout（否则 Obsidian 不渲染折叠块）
  function fixCallouts(md) {
    let s = String(md || '');
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

  // v3.7.66：批量队列完成信号——通知 background 推进下一个视频（带 batchId 精确匹配，跳过旧项延迟完成的误标）
  function notifyDone(ok, t, errMsg, bId) {
    try {
      chrome.runtime.sendMessage({ type: 'bnNoteDone', ok, title: t || '', error: errMsg || '', batchId: bId || '' }, () => {});
    } catch (e) { /* 忽略 */ }
  }

  async function finishAnswer(content, title, batchId, skipConvert) {
    // v3.7.45：修复 callout 折叠渲染 + 清理尾部自问自答 + 补回标题行
    // v3.7.87：skipConvert=true 用于保存"已转换过的原稿"（如修正轮超时回退），避免二次转换
    if (!skipConvert) {
      content = inlineSymbolsToMath(latexBlocksToDisplay(mindmapToTD(fixCallouts(content))));
      if (!/^# 《/.test(content)) content = '# 《' + (title || 'B站笔记') + '》\n\n' + content;
    }
    // v3.7.57：定向反馈闭环（替代 v3.7.56 的整篇重发）——本地消毒器先做掉有限形状，
    // 只剩极少残留时：①若本回答是上一轮修正行（短回答）→ 按 [mm:ss] 前缀合并回原笔记；②否则检测残留 → 只发残留行给豆包（快）
    const fixBase = window.__bnFixBase;
    if (fixBase) {
      window.__bnFixBase = null;
      const merged = mergeFixLines(fixBase, content);
      if (merged) {
        content = merged;
      } else {
        // v3.7.86：合并失败不能丢原笔记——回退保存修正前的本地消毒版本
        content = fixBase;
        showTip('豆包修正行无法匹配回原笔记，已保存本地消毒后的版本。');
      }
    }
    // v3.7.99：写盘前对最终全文再做一次消毒。修正行是豆包手写的，可能自带碎片 $、行内 `$$`，
    // 合并回原笔记后不会再经过转换管线；这是"改了还有乱码"的最后一个漏点。
    // 消毒是幂等的（合法公式逐字不变），skipConvert 的已转换原稿再跑一遍也不会被改坏。
    content = sanitizeInlineMath(content);
    const residue = detectMathResidue(content);
    const rounds = window.__bnFixRounds || 0;
    // v3.7.93：单行残留不值得再等豆包一轮（本地消毒器已经尽力），只有 ≥2 行明显硬错误才发修正请求
    if (residue.length >= 2 && rounds < 1) {
      window.__bnFixRounds = rounds + 1;
      const fixLines = residue.map((r) => r.split('\n')[0].trim()).filter(Boolean).slice(0, 4);
      const fixPrompt = '【公式修正请求】下面每一行里的公式都必须改成 Obsidian 可渲染的标准 LaTeX：\n' +
        '1) 每个公式必须用 $...$ 包裹（如 $U_{I}=0$、$I_{BQ}=\\frac{V_{BB}-U_{BEQ}}{R_B}$），禁止输出不带 $ 的裸 LaTeX（U_{I}=0 错误，必须写 $U_{I}=0$）；\n' +
        '2) 下标用 _{...}（如 $z_{n}$、$V_{GS}$）、上标用 ^{...}、分数用 \\frac{}{}、求和 \\sum、极限 \\lim、积分 \\int、偏导 \\partial、无穷 \\infty；\n' +
        '3) 禁止嵌套下标（U_{C_{EQ}} 错误，必须压平成 $U_{CEQ}$）；禁止连写（VGS 错误，必须写 $V_{GS}$）；多个公式必须换行分隔；\n' +
        '4) 只输出修正后的行，一行对应一行，原样保留 [mm:ss] 前缀和中文内容，禁止改写或增删任何中文文字，不要输出任何其他内容：\n\n' + fixLines.join('\n');
      showTip('检测到 ' + residue.length + ' 行公式待修正，正在让豆包定向修正（只需几秒）……');
      window.__bnFixBase = content; // 存原笔记，修正回答回来后按前缀合并
      window.__bnFixAt = Date.now(); // v3.7.92：记时间，修正轮 90 秒没等到就回退保存原稿（别让用户干等 5 分钟）
      chrome.storage.local.set({ [PENDING_KEY]: { text: fixPrompt, title: title || '', ts: Date.now(), batchId: batchId || '' } });
      return;
    }
    let resp = null;
    try {
      // v3.7.87：内容已在本函数开头完成转换，标记 preprocessed，background 不再重复跑转换管线
      resp = await chrome.runtime.sendMessage({ type: 'saveNoteToObsidian', title: title || '', content, preprocessed: true, attachSubs: true });
    } catch (e) {
      resp = { ok: false, error: e.message };
    }
    if (resp && resp.ok) {
      window.__bnFixRounds = 0; // 修复轮数清零，允许下一个视频独立重试
      const w = (resp.data && resp.data.warn) ? '\n注意：' + resp.data.warn : '';
      showTip('笔记已自动写入 Obsidian：' + resp.data.path + w + '\n可到 Obsidian 中查看。');
      notifyDone(true, title, '', batchId);
      return;
    }
    const err = (resp && resp.error) || '未知错误';
    if (err === '__NOT_CONFIGURED__') {
      // 未配置 REST API 时，参照 Bili Clipper 用 obsidian:// 协议直接创建笔记（无需 API Key/插件配置）
      try {
        const safeName = String(title || 'B站笔记').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || 'B站笔记';
        const uri = 'obsidian://new?file=' + encodeURIComponent(safeName + '.md') + '&content=' + encodeURIComponent(content);
        await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'openUri', uri }, () => resolve()));
        window.__bnFixRounds = 0; // v3.7.86：完成即清零，避免下一视频继承修正轮数
        showTip('已通过 obsidian:// 协议创建笔记：' + safeName + '\n（若 Obsidian 未响应，请在设置→第三方集成中允许 obsidian:// 链接）');
        notifyDone(true, title, '', batchId);
      } catch (e) {
        window.__bnFixRounds = 0; // v3.7.86：流程结束即清零
        copyFallback(content);
        showTip('Obsidian 未配置且协议打开失败，笔记已复制到剪贴板，可粘贴到 Obsidian 保存。');
        notifyDone(false, title, e.message, batchId);
      }
      return;
    }
    window.__bnFixRounds = 0; // v3.7.86：流程结束即清零
    copyFallback(content);
    showTip('笔记已复制到剪贴板，但 Obsidian 写入未成功：' + err +
      '\n\n补救：打开扩展页「Obsidian 自动保存设置」，点「测试连接」确认能写入（已配好会显示成功），再到「手动保存到 Obsidian」把内容粘进去保存一次。');
    notifyDone(false, title, err, batchId);
  }

  // 发送成功后监控豆包的回答：文本稳定后视为整理完成
  // v3.7.39：监控结束（保存/超时）即释放 __bnWatching，允许连续处理下一个视频。
  // 此前标志在第一次监控后永久锁死，导致第二个视频发送后无人监控、笔记不生成。
  // v3.8.6：豆包"还在生成中"探测。之前只按"文本 12 秒没变化"判完成，长笔记中途停顿（写公式、
  // 分段渲染）会被当成写完 → 立刻触发公式修正请求 → 你看到"输出一半就开始改公式"。
  // 这里只要页面上还挂着"停止生成"一类控件，就绝不判定完成。选择器不命中时返回 false（不误拦）。
  function isGenerating() {
    try {
      const sel = [
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop"]',
        '[aria-label*="停止生成"]',
        '[class*="stop-generat"]',
        '[data-testid*="stop"]'
      ];
      for (let i = 0; i < sel.length; i++) {
        if (document.querySelector(sel[i])) return true;
      }
      // 兜底：豆包的"停止生成"按钮可能只挂图标、没有可匹配的类名，按按钮自身的无障碍文本再查一遍。
      // 用整串精确匹配，避免页面上常驻的"停止"类文案造成永久拦截。
      const btns = document.querySelectorAll('button, [role="button"]');
      for (let i = 0; i < btns.length; i++) {
        const b = btns[i];
        const raw = (b.getAttribute && b.getAttribute('aria-label')) || b.innerText || b.textContent || '';
        const t = String(raw).replace(/\s+/g, '').trim();
        if (t === '停止' || t === '停止生成' || t === '停止回答' || t === 'Stop' || t === 'Stopgenerating') return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function watchAnswer(title, batchId, baseSig) {
    if (window.__bnWatching) return; // 同一页面只监控一次，防止多实例重复写文件
    window.__bnWatching = true;
    window.__bnGenOff = false; // 新一次监控重新启用"生成中不落盘"检测
    let answer = '';
    let stable = 0;
    let guard = 0;
    let pendingDrop = null; // { len, guard }：文本骤降待确认，防止半截笔记误保存
    let staleLog = 0;
    let titleLog = 0;
    let mismScene = false; // 出现过"标题不一致"（疑似上一条），超时时据此给出准确提示
    let confirmHit = 0; // v3.8.6：判定达标要连续两次采样都成立才落盘（多给一轮，防半截）
    let genStuck = 0;   // v3.8.6：连续命中"生成中"的次数，超过 40 轮判定为选择器误判并放行
    const release = () => { window.__bnWatching = false; };
    // 修正轮回答只有 [mm:ss] 行、没有笔记标题，不做标题校验
    const isFix = () => !!window.__bnFixBase;
    const titleOk = (t) => {
      if (isFix() || !title) return true;
      const nt = noteTitleOf(t);
      if (!nt) return true;
      return titleMatches(nt, title);
    };
    const tick = () => {
      // v3.7.93：修正轮不等满 5 分钟——45 秒没收到修正回答就保存原稿，
      // 否则页面看起来"已经生成完了"，实际插件还在傻等，用户以为没保存。
      if (window.__bnFixBase && window.__bnFixAt && Date.now() - window.__bnFixAt > 45000) {
        const base = window.__bnFixBase;
        window.__bnFixBase = null;
        window.__bnFixAt = 0;
        window.__bnFixRounds = 0;
        if (base) {
          showTip('等待豆包修正超时（90 秒），已保存本地消毒后的笔记。');
          finishAnswer(base, title, batchId, true);
          release();
          return;
        }
      }
      if (guard++ > 100) { // 约 5 分钟超时
        // v3.7.86：修正轮超时不能丢原笔记——回退保存修正前的本地消毒版本
        const base = window.__bnFixBase;
        window.__bnFixBase = null;
        if (base) {
          showTip('等待豆包修正超时，已保存本地消毒后的笔记。');
          finishAnswer(base, title, batchId, true); // 原稿已转换过，不再二次转换
          release();
          return;
        }
        if (mismScene) {
          // v3.7.98：明确告知这是"防串号"拦截，而不是卡住——用户对静默失败零容忍
          showTip('5 分钟内没有出现与本视频标题一致的新回答（豆包页可能还停在上一条笔记）。\n为避免把上一条存成本条，本次未写入 Obsidian。\n请确认豆包已回复本视频后再点一次发送。');
          notifyDone(false, title, '新回答未出现（回答仍上一条），未写入以防串号', batchId);
        } else {
          showTip('等待豆包整理超时。请复制豆包的回答，到扩展页「手动保存」粘贴保存。');
          notifyDone(false, title, '等待豆包整理超时', batchId);
        }
        release();
        return;
      }
      const t = extractAnswerText();
      // v3.7.98：基线拦截——与发送前完全一致，说明豆包还没开始写新回答，
      // 此刻抓到的是上一条视频的完整笔记（这就是"新视频笔记记成上一个"的直接原因）。
      if (baseSig && !isFix() && t && sig(t) === baseSig) {
        if (staleLog++ % 5 === 0) console.log('[B站笔记助手] 仍是发送前的旧回答（新回答尚未出现），继续等待');
        answer = '';
        stable = 0;
        pendingDrop = null;
        setTimeout(tick, 3000);
        return;
      }
      console.log('[B站笔记助手] 监控回答: 文本长度=' + (t ? t.length : 0) + ' 稳定次数=' + stable + ' 是否变化=' + (t !== answer) + ' 骤降待确认=' + (pendingDrop ? '是' : '否'));
      // v3.7.63：骤降延迟确认——豆包分块渲染/公式代码块切换时 innerText 会短暂减少，
      // 立即保存会截到半截笔记。先登记 pendingDrop，下一轮若文本回升视为渲染抖动并取消；
      // 仍低才确认完成（修正轮回答短，保持立即保存）。
      if (pendingDrop) {
        if (t && t.length > pendingDrop.len * 1.5) {
          pendingDrop = null;
          answer = t;
          stable = 0;
          console.log('[B站笔记助手] 文本回升，取消骤降判定（渲染抖动），继续监控');
        } else if (guard - pendingDrop.guard >= 1) {
          const isFixRound = !!(window.__bnFixBase);
          // v3.8.6：骤降确认时若豆包仍在生成，不判完成（否则半截笔记会立刻触发公式修正）
          if (!isFixRound && isGenerating()) {
            pendingDrop = null;
            console.log('[B站笔记助手] 文本骤降但豆包仍在生成中，取消完成判定，继续等待');
            setTimeout(tick, 3000);
            return;
          }
          const target = isFixRound ? (t || answer) : answer;
          const titlePass = titleOk(target);
          if (!isFixRound && target && !titlePass && titleLog++ % 5 === 0) {
            mismScene = true;
            console.log('[B站笔记助手] 回答标题与本次视频不一致（疑似上一条），暂不保存：' + noteTitleOf(target) + ' ≠ ' + title);
          }
          if (isFixRound ? looksLikeFixAnswer(target) : (target.length > 200 && sig(target) !== lastSavedSig && !looksLikeUserMsg(target) && looksLikeNote(target) && titlePass)) {
            lastSavedSig = sig(target);
            console.log('[B站笔记助手] 骤降确认完成，保存内容长度=' + target.length + (isFixRound ? '（修正轮）' : ''));
            finishAnswer(target, title, batchId);
            release();
            return;
          }
          pendingDrop = null;
        }
      } else if (t && t !== answer) {
        if (t.length < answer.length * 0.5) {
          // 文本骤降：豆包回答完成后页面重排/新元素出现，选择器指向变化
          const isFixRound = !!window.__bnFixBase;
          if (isFixRound) {
            // v3.7.57：修正轮（__bnFixBase 存在）时，骤降后的 t 才是修正行，保存 t 并合并回原笔记
            // v3.7.86：修正行会被 looksLikeUserMsg 误判成字幕，改用 looksLikeFixAnswer
            const target = t;
            if (looksLikeFixAnswer(target)) {
              lastSavedSig = sig(target);
              console.log('[B站笔记助手] 修正轮回答完成（文本骤降），保存内容长度=' + target.length);
              finishAnswer(target, title, batchId);
              release();
              return;
            }
          } else {
            // 首次骤降：登记待确认，不立即保存（防半截）
            pendingDrop = { len: t.length, guard };
            console.log('[B站笔记助手] 文本骤降，等待 1 轮确认防止截取半截笔记…');
          }
        } else {
          answer = t;
          stable = 0;
        }
      } else if (t && t === answer) {
        stable++;
      }
      // 完整笔记通常超过 200 字；短文本（状态提示、占位）不判定完成
      // v3.7.57：修正轮用宽松条件（短回答也判定，合并回原笔记）
      // v3.7.93：专家模式稳定阈值 20 -> 8（3 秒一 tick，即 24 秒无变化就落盘）
      // v3.8.6：①页面上还有"停止生成"就以还在写对待，文本停多久都不判定完成——这是"输出一半就开始改公式"的根因
      //        ②长笔记（>=1200 字）稳定阈值再 +6（普通 30 秒 / 专家 42 秒），短笔记仍 12 / 24 秒
      //        ③判定达标要连续两次采样都成立才落盘，多给一轮确认
      const isFixRound = !!window.__bnFixBase;
      if (!isFixRound && !window.__bnGenOff && isGenerating()) {
        genStuck++;
        if (genStuck <= 40) {
          if (t) answer = t;
          confirmHit = 0;
          console.log('[B站笔记助手] 豆包仍在生成中（第 ' + genStuck + ' 次），继续等待，不落盘');
          setTimeout(tick, 3000);
          return;
        }
        // 连续 2 分钟都命中，基本可以判定是选择器误伤（页面上有常驻节点），
        // 本轮监控改为纯文本阈值判定，避免每 2 分钟才检查一次导致落盘越来越慢
        window.__bnGenOff = true;
        genStuck = 0;
        console.log('[B站笔记助手] 生成检测连续 40 轮仍命中，判定为误伤，本次监控改用纯文本阈值');
      }
      const baseNeed = (window.__bnExpertMode === true) ? 8 : 4;
      const stableNeed = baseNeed + ((answer || '').length >= 1200 ? 6 : 0);
      const titlePass = titleOk(answer);
      if (!isFixRound && answer && !titlePass && titleLog++ % 5 === 0) {
        mismScene = true;
        console.log('[B站笔记助手] 回答标题与本次视频不一致（疑似上一条），暂不保存：' + noteTitleOf(answer) + ' ≠ ' + title);
      }
      const hitOk = isFixRound
        ? (stable >= 2 && looksLikeFixAnswer(answer))
        : (answer.length > 200 && stable >= stableNeed && sig(answer) !== lastSavedSig && !looksLikeUserMsg(answer) && looksLikeNote(answer) && titlePass);
      if (!pendingDrop && hitOk) {
        confirmHit++;
        if (confirmHit < 2) {
          console.log('[B站笔记助手] 判定达标，再确认一轮（连续两次采样都不变才落盘）');
          setTimeout(tick, 3000);
          return;
        }
        lastSavedSig = sig(answer);
        console.log('[B站笔记助手] 判定完成，尝试写入 Obsidian，内容长度=' + answer.length);
        finishAnswer(answer, title, batchId);
        release();
        return;
      }
      if (!hitOk) confirmHit = 0;
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 4000);
  }

  // ---------- 发送主流程 ----------

  let dead = false;
  // 全局去重标记：同一段豆包回答只自动保存一次（扩展发送流程与持续自动保存共用）
  let lastSavedSig = '';
  async function trySend() {
    if (document.visibilityState !== 'visible') return; // 隐藏标签页不发送（多个豆包页时防重复发送）
    // v3.8.5：发送互斥。storage.onChanged 与 1 秒轮询可能同时进来，两次都读到同一条 pending
    // 就会把同一条字幕发两遍（豆包重新整理一遍 = 你看到的"重复"）。置位是同步的，挡得住并发。
    if (window.__bnSending) return;
    window.__bnSending = true;
    try {
      let items = null;
      try {
        items = await new Promise((resolve) => chrome.storage.local.get([PENDING_KEY], resolve));
      } catch (e) {
        // 扩展重载后旧脚本实例的上下文失效：停止轮询，避免反复报错
        dead = true;
        console.log('[B站笔记助手] 扩展上下文已失效（扩展被重载过），旧脚本停止轮询');
        return;
      }
      const pending = items ? items[PENDING_KEY] : null;
      if (!pending || !pending.text) return;

      const text = pending.text;
      const title = pending.title || '';
      const batchId = pending.batchId || '';

      const editor = findEditor();
      if (!editor) {
        // 页面可能还在加载（新打开的豆包页 React 未渲染完输入框）：保留 pending，等待下一轮轮询重试
        console.log('[B站笔记助手] 未找到豆包输入框（页面可能仍在加载），保留待发送，等待重试…');
        return;
      }
      // v3.8.5：等删除真正完成再继续。原来不 await，下一轮轮询可能在删除生效前又读到同一条
      // pending，于是同一份字幕被第二次写进输入框并再次发送。
      await new Promise((resolve) => chrome.storage.local.remove(PENDING_KEY, resolve));

      // v3.7.80：豆包专家模式（深度思考）——发送前读开关，尝试点击豆包页"深度思考/专家模式"按钮；
      // 启用后 watchAnswer 的稳定判定阈值延长（专家模式输出慢，防止误判完成截半）
      try {
        const ex = await new Promise((resolve) => chrome.storage.local.get({ bn_expert: false }, resolve));
        window.__bnExpertMode = !!(ex && ex.bn_expert);
        if (window.__bnExpertMode) {
          const ok = tryEnableExpertMode();
          console.log('[B站笔记助手] 豆包专家模式 ' + (ok ? '已启用（深度思考）' : '未找到深度思考开关，按普通模式发送') + '，等待时长延长至 1 分钟');
        }
      } catch (e) { /* 读取开关失败按普通模式 */ }

      // v3.7.86：只有公式修正请求才沿用上一轮的修正基准；新一轮普通任务（下一个视频/手动发送）
      // 必须清掉遗留的 __bnFixBase/__bnFixRounds，否则上一视频的修正轮状态会污染下一个视频
      if (text.indexOf('【公式修正请求】') === 0) {
        window.__bnFixRounds = 1; // 修正请求本身已消耗一轮
      } else {
        window.__bnFixBase = null;
        window.__bnFixAt = 0;
        window.__bnFixRounds = 0;
      }

      // v3.7.98：发送前记录页面当前"最后一条回答"的指纹。此时回答区还是上一条视频的笔记，
      // 用它作基线，新回答没出现之前绝不落盘，避免续存上一条。
      let baseSig = '';
      if (text.indexOf('【公式修正请求】') !== 0) {
        try {
          const b = extractAnswerText();
          baseSig = b ? sig(b) : '';
          if (baseSig) console.log('[B站笔记助手] 记录发送前回答基线：长度=' + b.length);
        } catch (e) { /* 取不到基线则退化为仅靠标题校验 */ }
      }

      if (!setEditorText(editor, text)) {
        console.log('[B站笔记助手] 输入框写入失败');
        copyFallback(text);
        showTip('自动填写失败，字幕已复制到剪贴板，请手动粘贴到豆包输入框后发送。');
        return;
      }

      setTimeout(() => {
        let started = false;
        const startWatch = () => {
          if (!started) {
            started = true;
            showTip('已自动发送到豆包，正在整理笔记…完成后将尝试自动保存。');
            console.log('[B站笔记助手] 已发送字幕到豆包，开始监控回答');
            watchAnswer(title, batchId, baseSig);
          }
        };
        const stillHasText = () => !editorEmpty(editor);
        if (clickSendButton()) {
          startWatch();
          return;
        }
        pressEnter(editor);
        // v3.8.5：判定"是否已发出"的宽限从 1.2 秒放宽到 2.5 秒。豆包反应慢时，点完后
        // 输入框要过一会儿才清空，原来的 1.2 秒会误判成没发出，于是再按一次回车 → 发两条。
        setTimeout(() => {
          if (!stillHasText()) { startWatch(); return; }
          // 合成键盘事件通常不被 React 响应 → 用 CDP 发送真实回车（isTrusted=true）
          // CDP 回车前重新聚焦输入框（tab 激活/欢迎页切换可能丢失焦点）
          try { editor.focus(); } catch (e) {}
          pressEnterReal().then(() => {
            setTimeout(() => {
              if (!stillHasText()) { startWatch(); return; }
              pressEnter(editor);
              setTimeout(() => {
                if (!stillHasText()) {
                  console.log('[B站笔记助手] 发送未成功（输入框仍有内容）');
                  copyFallback(text);
                  showTip('自动发送未成功，字幕已复制到剪贴板，请手动粘贴到豆包输入框后发送。');
                } else {
                  startWatch();
                }
              }, 2500);
            }, 2500);
          });
        }, 2500);
      }, 600);
    } finally {
      window.__bnSending = false;
    }
  }
  window.__bnTrySend = trySend;

  // ---------- 持续自动保存：用户手动在豆包提问/整理，回答完成后自动写入 Obsidian ----------
  // 不依赖扩展发送流程：只要豆包页面出现"新的 AI 回答"并稳定完成，就自动保存。
  // 同一回答只保存一次（用文本特征标记去重），短文本/状态提示不保存。
  function startAutoSave() {
    if (window.__bnAutoSave) return;
    window.__bnAutoSave = true;
    let prev = '';
    let stable = 0;
    let guard = 0;
    const tick = () => {
      if (guard++ > 600) return; // 30 分钟上限
      const t = extractAnswerText();
      console.log('[B站笔记助手] 自动保存监控: 文本长度=' + (t ? t.length : 0) + ' 稳定=' + stable + ' 变化=' + (t !== prev));
      if (t && t !== prev) {
        if (t.length < prev.length * 0.5) {
          // 文本骤降 = 上一轮回答完成、新回答开始：把上一轮足够长的回答保存
          if (prev.length > 200 && sig(prev) !== lastSavedSig && !looksLikeUserMsg(prev) && looksLikeNote(prev)) {
            lastSavedSig = sig(prev);
            console.log('[B站笔记助手] 自动保存（回答完成-骤降），长度=' + prev.length);
            finishAnswer(prev, '豆包笔记');
          }
          prev = '';
          stable = 0;
        } else {
          prev = t;
          stable = 0;
        }
      } else if (t && t === prev) {
        stable++;
        if (prev.length > 200 && stable >= 2 && sig(prev) !== lastSavedSig && !looksLikeUserMsg(prev) && looksLikeNote(prev)) {
          lastSavedSig = sig(prev);
          console.log('[B站笔记助手] 自动保存（回答稳定），长度=' + prev.length);
          finishAnswer(prev, '豆包笔记');
          prev = '';
          stable = 0;
        }
      }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 6000);
  }
  // 已停用（v3.7.33）：持续自动保存会与扩展发送流程重复生成"豆包笔记"文件。
  // 只保留扩展发送流程（视频标题命名）的自动保存。
  // startAutoSave();

  // 页面加载完成后轮询 + 监听 storage 变化（覆盖已打开豆包页再触发的情况）
  let tries = 0;
  const poll = () => {
    // v3.7.39：轮询上限放宽到 300 次（约 5 分钟），防止豆包页临时不可见时 pending 发送卡死
    if (dead || tries++ >= 300) return;
    trySend();
    setTimeout(poll, 1000);
  };
  setTimeout(poll, 800);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PENDING_KEY]) trySend();
  });
})();
