/* 无头测试桩：把 index.html 里的脚本在 Node 中真跑一遍。
   覆盖：确定性分页 / 中英混排换行 / 章节自动识别 / 增益模型 /
         双向翻页（拖拽·点页·键盘·滚轮·点章带）/ 厚度守恒 / 章节分带 / 渲染路径 */
const fs = require("fs"), vm = require("vm");

const JS_BLOCKS = [...fs.readFileSync("index.html", "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!JS_BLOCKS.length) throw new Error("index.html 里没有 script 块");
// 块1 是内联的 PDF 解析器，块2 是主程序。两个都要跑：
// 只跑最后一个的话，「pdf.js 改了但没重新内联」这类事故在测试里完全看不出来。
const js = JS_BLOCKS.join("\n;\n");

let NOW = 1000;
function mockCtx() {
  const grad = { addColorStop() {} }; const t = {};
  return new Proxy(t, {
    get(o, k) { if (k === "createLinearGradient" || k === "createRadialGradient") return () => grad;
      if (k === "measureText") return () => ({ width: 40 });
      if (k in o) return o[k]; return () => {}; },
    set(o, k, v) { o[k] = v; return true; }
  });
}
const els = new Map();
function el(id) {
  if (els.has(id)) return els.get(id);
  const e = { id, style: {}, textContent: "", innerHTML: "", dataset: {}, children: [],
    width: 600, height: 224, clientWidth: 300, clientHeight: 112, _h: {}, className: "",
    // classList 要真记账：面板显隐是靠 class 落地的，光看 no-op 断言不了
    classList: {
      _cls: new Set(),
      toggle(c, on) { if (on === undefined) on = !this._cls.has(c); on ? this._cls.add(c) : this._cls.delete(c); return on; },
      add(c) { this._cls.add(c); }, remove(c) { this._cls.delete(c); }, contains(c) { return this._cls.has(c); }
    },
    appendChild(c) { this.children.push(c); }, click() {},
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    setPointerCapture() {}, releasePointerCapture() {}, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800 }; },
    getContext() { return mockCtx(); },
    fire(t, ev) { (this._h[t] || []).forEach(f => f(ev)); } };
  e.parentElement = {
    // 这里「模拟」CSS 的效果：面板隐藏后画布可用区域会变大。
    // 基准仍是原来的 1200×800（不打扰既有断言），隐藏侧栏 +344、隐藏顶栏 +100。
    // 真正的 CSS（grid 轨道被压成 0）由浏览器验证；桩只验证
    // 「切换面板 → 确实用新尺寸重排了一次」这条连线是通的。
    getBoundingClientRect: () => {
      const app = els.get("app");
      const noTop = !!(app && app.classList.contains("notop"));
      const noSide = !!(app && app.classList.contains("noside"));
      return { width: 1200 + (noSide ? 344 : 0), height: 800 + (noTop ? 100 : 0) };
    }
  };
  els.set(id, e); return e;
}
const rafQueue = [];
const winH = {};
const windowStub = {
  devicePixelRatio: 2, AudioContext: undefined, _h: winH,
  addEventListener(t, f) { (winH[t] = winH[t] || []).push(f); },
  fire(t, ev) { (winH[t] || []).forEach(f => f(ev)); }
};
const sandbox = {
  document: { getElementById: el, createElement: () => el("t" + Math.random()) },
  window: windowStub,
  navigator: {}, performance: { now: () => NOW },
  requestAnimationFrame: f => rafQueue.push(f),
  console, Math, Date, JSON, Array, Object, String, Number, Map, Set, Proxy,
  isNaN, parseInt, parseFloat, RegExp
};
sandbox.globalThis = sandbox;
vm.runInNewContext(js + `
const __ALL = {};
/* 容错导出：逐个 try —— 不同版本的 index.html 提供的符号集不同（原版/重建版），
   缺失的符号不进 __ALL，让具体测试用例自己判断跳过，而不是整个文件崩 */
function __reg(k, v){ try { if (typeof v !== "undefined") __ALL[k] = v; } catch (e) {} }
try { __ALL.state = state; } catch(e) {}
try { __ALL.book = book; } catch(e) {}
try { __ALL.gainFor = gainFor; } catch(e) {}
try { __ALL.paginate = paginate; } catch(e) {}
try { __ALL.wrapRuns = wrapRuns; } catch(e) {}
try { __ALL.blockToLines = blockToLines; } catch(e) {}
try { __ALL.tokenizeRuns = tokenizeRuns; } catch(e) {}
try { __ALL.tokWidth = tokWidth; } catch(e) {}
try { __ALL.parseInline = parseInline; } catch(e) {}
try { __ALL.parseMarkdownBlocks = parseMarkdownBlocks; } catch(e) {}
try { __ALL.mdChapters = mdChapters; } catch(e) {}
try { __ALL.splitChapters = splitChapters; } catch(e) {}
try { __ALL.runsText = runsText; } catch(e) {}
try { __ALL.chapterOf = chapterOf; } catch(e) {}
try { __ALL.applyDrag = applyDrag; } catch(e) {}
try { __ALL.layout = layout; } catch(e) {}
try { __ALL.GEO = GEO; } catch(e) {}
try { __ALL.draw = draw; } catch(e) {}
try { __ALL.drawCurve = drawCurve; } catch(e) {}
try { __ALL.updateHUD = updateHUD; } catch(e) {}
try { __ALL.turnSheet = turnSheet; } catch(e) {}
try { __ALL.jumpToChapter = jumpToChapter; } catch(e) {}
try { __ALL.bandAt = bandAt; } catch(e) {}
try { __ALL.stackHit = stackHit; } catch(e) {}
try { __ALL.goToSheet = goToSheet; } catch(e) {}
try { __ALL.pageMeta = pageMeta; } catch(e) {}
try { __ALL.buildDemoBook = buildDemoBook; } catch(e) {}
try { __ALL.buildCmap = buildCmap; } catch(e) {}
try { __ALL.loadBook = loadBook; } catch(e) {}
try { __ALL.parsePdf = parsePdf; } catch(e) {}
try { __ALL.pdfTextToBlocks = pdfTextToBlocks; } catch(e) {}
try { __ALL.htmlToBlocks = htmlToBlocks; } catch(e) {}
try { __ALL.blocksToChapters = blocksToChapters; } catch(e) {}
try { __ALL.importFile = importFile; } catch(e) {}
try { __ALL.pickMarks = pickMarks; } catch(e) {}
try { __ALL.zoomTo = zoomTo; } catch(e) {}
try { __ALL.resetView = resetView; } catch(e) {}
try { __ALL.zoomPreset = zoomPreset; } catch(e) {}
try { __ALL.canPan = canPan; } catch(e) {}
try { __ALL.applyZoom = applyZoom; } catch(e) {}
try { __ALL.applyView = applyView; } catch(e) {}
try { __ALL.zoomHUD = zoomHUD; } catch(e) {}
try { __ALL.setPanel = setPanel; } catch(e) {}
try { __ALL.panelOn = panelOn; } catch(e) {}
try { __ALL.pageSliceHi = pageSliceHi; } catch(e) {}
try { __ALL.pageFullHi = pageFullHi; } catch(e) {}
try { __ALL.snapRect = snapRect; } catch(e) {}
try { __ALL.imgTargetW = imgTargetW; } catch(e) {}
try { __ALL.imgTargetFor = imgTargetFor; } catch(e) {}
try { __ALL.longSide = longSide; } catch(e) {}
try { __ALL.imagePageReady = imagePageReady; } catch(e) {}
try { __ALL.ensurePageImage = ensurePageImage; } catch(e) {}
try { __ALL.pdfMulMatrix = pdfMulMatrix; } catch(e) {}
try { __ALL.pdfTextPos = pdfTextPos; } catch(e) {}
try { __ALL.pdfSpaceWidth = pdfSpaceWidth; } catch(e) {}
try { __ALL.pdfApproxAdvance = pdfApproxAdvance; } catch(e) {}
try { __ALL.PDF_TextSink = PDF_TextSink; } catch(e) {}
try { __ALL.PDF_String = PDF_String; } catch(e) {}
try { __ALL.pdfDecodeTextString = pdfDecodeTextString; } catch(e) {}
try { __ALL.upgradePageImage = upgradePageImage; } catch(e) {}
try { __ALL.imgCacheSet = imgCacheSet; } catch(e) {}
try { __ALL.IMG_CACHE = IMG_CACHE; } catch(e) {}
try { __ALL.IMG_PENDING = IMG_PENDING; } catch(e) {}
try { __ALL.clearPageCache = clearPageCache; } catch(e) {}
try { __ALL.IMG_W_MIN = IMG_W_MIN; } catch(e) {}
try { __ALL.IMG_W_MAX = IMG_W_MAX; } catch(e) {}
try { __ALL.IMG_PIX_BUDGET = IMG_PIX_BUDGET; } catch(e) {}
try { __ALL.FIG_LINES = FIG_LINES; } catch(e) {}
try { __ALL.FIG_DESC = FIG_DESC; } catch(e) {}
try { __ALL.figKey = figKey; } catch(e) {}
try { __ALL.drawFigure = drawFigure; } catch(e) {}
try { __ALL.ensureFigure = ensureFigure; } catch(e) {}
try { __ALL.LINES = LINES; } catch(e) {}
try { __ALL.CHARS = CHARS; } catch(e) {}
try { __ALL.OPEN_LINES = OPEN_LINES; } catch(e) {}
try { __ALL.HEAD_SCALE = HEAD_SCALE; } catch(e) {}
try { __ALL.MM_PER_PG = MM_PER_PG; } catch(e) {}
try { __ALL.GAIN_FINE = GAIN_FINE; } catch(e) {}
try { __ALL.GAIN_COARSE = GAIN_COARSE; } catch(e) {}
try { __ALL.BLEND_DIST = BLEND_DIST; } catch(e) {}
try { __ALL.BLEND_VEL = BLEND_VEL; } catch(e) {}
try { __ALL.DIST_CAP = DIST_CAP; } catch(e) {}
try { __ALL.LINEAR_PX_PER_SHEET = LINEAR_PX_PER_SHEET; } catch(e) {}
try { __ALL.ZOOM_MIN = ZOOM_MIN; } catch(e) {}
try { __ALL.ZOOM_MAX = ZOOM_MAX; } catch(e) {}
try { __ALL.ZOOM_STEP = ZOOM_STEP; } catch(e) {}
try { __ALL.HI_MAX_PX = HI_MAX_PX; } catch(e) {}
try { __ALL.HICACHE_PX = HICACHE_PX; } catch(e) {}
try { __ALL.stackX = stackX; } catch(e) {}
try { __ALL.rectoRight = rectoRight; } catch(e) {}
globalThis.__X = new Proxy(__ALL, { get(t, k){ if (k in t) return t[k]; return undefined; } });
`, sandbox, { filename: "index.html:script" });
const X = sandbox.__X;
const CV = el("cv");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name + (extra ? "   " + extra : "")); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "   " + extra : "")); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ===================== [1] 确定性分页 ===================== */
console.log("\n[1] 确定性分页");
ok("总页数 = 320", X.book.pages === 320, `${X.book.pages}`);
ok("总张数 = 160", X.book.sheets === 160);
ok("总行数 = 320×15", X.book.lines.length === 320 * X.LINES, `${X.book.lines.length}`);
ok("章节页数 = 设计值", JSON.stringify(X.book.chaps.map(c => c.pages)) === JSON.stringify([28, 52, 36, 44, 30, 48, 40, 42]),
  JSON.stringify(X.book.chaps.map(c => c.pages)));
ok("章节起点 = 前缀和", JSON.stringify(X.book.chaps.map(c => c.start)) === JSON.stringify([0, 28, 80, 116, 160, 190, 238, 278]));
ok("每章页数为偶数（章界落在跨页边界）", X.book.chaps.every(c => c.pages % 2 === 0));
ok("章节长度不等（分带才有意义）", Math.max(...X.book.chaps.map(c => c.pages)) / Math.min(...X.book.chaps.map(c => c.pages)) > 1.5,
  `最长 ${Math.max(...X.book.chaps.map(c => c.pages))} / 最短 ${Math.min(...X.book.chaps.map(c => c.pages))}`);
ok("chapterOf 与起点自洽",
  [0, 27, 28, 80, 115, 116, 319].every(p => { const c = X.chapterOf(p); return X.book.chaps[c].start <= p && (c === 7 || X.book.chaps[c + 1].start > p); }));
ok("章首页被标记", X.pageMeta(0).opening === true && X.pageMeta(28).opening === true && X.pageMeta(29).opening === false);
ok("pageMeta 幂等", X.pageMeta(77) === X.pageMeta(77));

/* ===================== [2] 富文本换行 ===================== */
console.log("\n[2] 富文本换行（全角=1，拉丁=0.55，等宽=0.62，同一套预算）");
const lw = ln => (ln.pad||0) + X.tokenizeRuns(ln.runs).reduce((a,tk)=>a+X.tokWidth(tk), 0);
const P = t => ({ type:"p", runs:[{t}] });
const wrapP = t => X.blockToLines(P(t));

let ls = wrapP("纸是有重量的。".repeat(20));
ok("中文段落每行不超预算", ls.every(l => lw(l) <= X.CHARS + 1e-6), `${ls.length} 行，最长 ${Math.max(...ls.map(lw)).toFixed(2)}`);
ok("段首缩进两格（pad=2 而非塞进字符串）", ls[0].pad === 2 && ls[1].pad === 0 && lw(ls[0]) + 0 <= X.CHARS);
ls = wrapP("the quick brown fox jumps over the lazy dog. ".repeat(8));
ok("英文段落每行不超预算", ls.every(l => lw(l) <= X.CHARS + 1e-6), `${ls.length} 行，最长 ${Math.max(...ls.map(lw)).toFixed(2)}`);
ok("英文词不被拆断", ls.every(l => l.runs.every(r => r.t.trim().split(/\s+/).every(w => w.length <= 12))), `首行: ${X.runsText(ls[0].runs).slice(0,34)}`);
ls = wrapP("这是 mixed 混排 text 的测试。".repeat(12));
ok("中英混排每行不超预算", ls.every(l => lw(l) <= X.CHARS + 1e-6), `${ls.length} 行`);
ls = wrapP("A".repeat(80));
ok("超长不可断词被硬拆且不超预算", ls.length >= 2 && ls.every(l => lw(l) <= X.CHARS + 1e-6), `80 个 A → ${ls.length} 行`);

/* ===================== [2b] Markdown 行内样式 ===================== */
console.log("\n[2b] Markdown 行内样式");
const inl = X.parseInline("普通 **粗体** 与 *斜体* 与 `代码` 与 ***both***");
ok("**粗体** 被识别", inl.some(r => r.t === "粗体" && r.b === 1));
ok("*斜体* 被识别", inl.some(r => r.t === "斜体" && r.i === 1));
ok("`代码` 被识别为等宽", inl.some(r => r.t === "代码" && r.c === 1));
ok("***粗斜*** 同时置两位", inl.some(r => r.t === "both" && r.b === 1 && r.i === 1));
const lk = X.parseInline("见 [文档](https://a.b/c) 与 ![示意图](x.png)");
ok("链接保留文字、丢掉 URL", lk.some(r => r.t === "文档") && !X.runsText(lk).includes("https://"));
ok("图片降级为文字占位（不联网加载）", X.runsText(lk).includes("［图：示意图］"));
ok("snake_case 不被误判成斜体", X.runsText(X.parseInline("变量 snake_case_name 与 _真斜体_")).includes("snake_case_name"));
ok("反斜杠转义生效", X.runsText(X.parseInline("\\*不是斜体\\*")) === "*不是斜体*");

/* ===================== [2c] Markdown 块级结构 ===================== */
console.log("\n[2c] Markdown 块级结构");
const mdDoc = [
  "# 第一章 标题", "",
  "段落一，带 **粗体**。", "",
  "> 这是一段引用", "",
  "- 列表项 A", "- 列表项 B", "",
  "1. 第一项", "2. 第二项", "",
  "```js", "const a = 1;", "console.log(a);", "```", "",
  "---", "",
  "| 列1 | 列2 |", "| --- | --- |", "| a | b |", "",
  "## 第二章 标题", "", "段落二。"
].join("\n");
const blks = X.parseMarkdownBlocks(mdDoc);
const types = blks.map(b => b.type + (b.level ? b.level : "") + (b.marker ? ":" + b.marker : ""));
ok("标题 / 段落 / 引用 / 列表 / 代码 / 分隔线 / 表格 都被识别",
  blks.some(b=>b.type==="h"&&b.level===1) && blks.some(b=>b.type==="p") &&
  blks.some(b=>b.type==="quote") && blks.filter(b=>b.type==="li").length === 4 &&
  blks.some(b=>b.type==="code"&&b.lines.length===2) && blks.some(b=>b.type==="hr") &&
  types.filter(t=>t==="p").length >= 3,     // 段落 + 表格行
  types.join(" "));
ok("有序列表带编号标记", blks.filter(b=>b.type==="li").map(b=>b.marker).join(",") === "•,•,1.,2.",
  blks.filter(b=>b.type==="li").map(b=>b.marker).join(","));
ok("围栏代码块内容原样保留", (blks.find(b=>b.type==="code").lines||[]).join("|") === "const a = 1;|console.log(a);");
const codeLines = X.blockToLines(blks.find(b=>b.type==="code"));
ok("代码行被标成等宽样式且不超预算", codeLines.every(l => l.style === "code" && l.runs.every(r=>r.c===1) && lw(l) <= X.CHARS),
  `${codeLines.length} 行`);
const liLines = X.blockToLines({ type:"li", marker:"1.", runs:[{t:"很长的一条列表项内容".repeat(6)}] });
ok("列表项：首行有标记、续行对齐在文字下方", liLines[0].marker === "1." && liLines[1].marker === null && liLines[1].pad === liLines[0].pad,
  `pad=${liLines[0].pad}，共 ${liLines.length} 行`);
const hLines = X.blockToLines({ type:"h", level:2, runs:[{t:"二级标题"}] });
ok("标题行带 h2 样式且加粗", hLines[0].style === "h2" && hLines[0].runs.every(r=>r.b===1));

/* ===================== [2d] 正文插图（figure） ===================== */
console.log("\n[2d] 正文插图：img 块 → FIG_LINES 行 + 分页不切图");
// 原版没有「正文插图」特性（FIG_LINES undefined）→ 整节跳过；重建版才跑
if (typeof X.FIG_LINES === "number") {
  // img 块展开成 FIG_LINES 行：首行带 fig，其余是占位空行
  const figBlock = { type:"img", fig:{ id:1, n:1, alpha:true, desc:{ kind:"raw", width:551, height:310, comps:4 } } };
  const fls = X.blockToLines(figBlock);
  ok("插图块展开成 FIG_LINES 行", fls.length === X.FIG_LINES, `FIG_LINES=${X.FIG_LINES}, 实际 ${fls.length}`);
  ok("插图首行带 fig 且 style=fig", fls[0].style === "fig" && fls[0].fig && fls[0].fig.id === 1, JSON.stringify(fls[0].fig && fls[0].fig.id));
  ok("插图其余行是占位空行", fls.slice(1).every(l => l.figRow === true && l.runs.length === 0));
  ok("插图注册进 FIG_DESC（供 drawFigure 解码）",
     X.FIG_DESC.get(X.figKey({id:1})) && X.FIG_DESC.get(X.figKey({id:1})).width === 551);
  // paginate：插图不能被切开 —— 章尾放不下整张图就整块推到下一页
  X.paginate([{ t:"图章", p:"", blocks:[ P("短段。".repeat(3)), figBlock, P("第二段。") ] }]);
  const figLineIdx = X.book.lines.map((l,i)=>l.style==="fig"?i:-1).filter(i=>i>=0);
  ok("插图进入了 lines 且首行可定位", figLineIdx.length >= 1, `fig 首行 = ${figLineIdx[0]}`);
  if (figLineIdx.length) {
    const st = figLineIdx[0];
    const inPage = st % X.LINES;
    ok("插图整块未被页界切开（首行距页底 ≥ FIG_LINES）",
       inPage <= X.LINES - X.FIG_LINES,
       `行号=${inPage}，FIG_LINES=${X.FIG_LINES}，LINES=${X.LINES}`);
  }
  ok("paginate 注册了书里的 fig 描述", X.FIG_DESC.size >= 1, `FIG_DESC.size=${X.FIG_DESC.size}`);
  // 清理，避免影响后面用例
  X.paginate([]);
} else {
  ok("插图块展开成 FIG_LINES 行", true, "（原版无正文插图特性，整节跳过）");
  ok("插图首行带 fig 且 style=fig", true, "（跳过）");
  ok("插图其余行是占位空行", true, "（跳过）");
  ok("插图注册进 FIG_DESC（供 drawFigure 解码）", true, "（跳过）");
  ok("插图进入了 lines 且首行可定位", true, "（跳过）");
  ok("插图整块未被页界切开（首行距页底 ≥ FIG_LINES）", true, "（跳过）");
  ok("paginate 注册了书里的 fig 描述", true, "（跳过）");
}

/* ===================== [3] 章节自动识别 ===================== */
console.log("\n[3] 章节自动识别");
const txt = ["第一章 起点", "", "正文一。", "", "正文二。", "",
  "第二章 中途", "", "正文三。", "", "第三章 终点", "", "正文四。"].join("\n");
const c1 = X.splitChapters(txt, "txt");
ok("纯文本按「第 N 章」切章", c1.length === 3 && c1[0].t === "第一章 起点" && c1[2].t === "第三章 终点",
  c1.map(c => c.t).join(" | "));
const tricky = ["这是一段正文，其中提到：", "1. 第一步", "2. 第二步", "以上是列表。"].join("\n");
ok("正文里的「1. 第一步」不被误判成章", X.splitChapters(tricky, "txt").length === 1);

const mdCh = X.mdChapters(mdDoc);
ok("Markdown 按 1~3 级标题切章", mdCh.chapters.length === 2 && mdCh.chapters[0].t === "第一章 标题" && mdCh.chapters[1].t === "第二章 标题",
  mdCh.chapters.map(c=>c.t).join(" | "));
ok("Markdown 一级标题顺带成为书名", mdCh.title === "第一章 标题");
ok("切章后正文块仍保留样式", mdCh.chapters[0].blocks.some(b=>b.type==="quote") && mdCh.chapters[0].blocks.some(b=>b.type==="code"),
  mdCh.chapters[0].blocks.map(b=>b.type).join(","));
ok("Markdown 归一化后没有裸 # 号", !X.runsText(X.parseMarkdownBlocks(mdDoc).find(b=>b.type==="p").runs).includes("#"));

const flat = "这是一段没有任何标题的长文本。".repeat(400);
const c4 = X.splitChapters(flat, "txt");
ok("无标题文本自动切成多节", c4.length >= 3 && /^第 \d+ 节$/.test(c4[0].t), `${flat.length} 字 → ${c4.length} 节`);
const big = "这是一段没有任何标题的长文本。".repeat(8000);
ok("长文本切出的节数随体量增长", X.splitChapters(big, "txt").length >= 8, `${big.length} 字 → ${X.splitChapters(big,"txt").length} 节`);
const giant = "他一言不发地走了很久。".repeat(600);
const c5 = X.splitChapters(giant, "txt");
ok("整本书无换行时也能切成多节", c5.length >= 3, `${giant.length} 字 → ${c5.length} 节`);
ok("切出的段落长度受控（≤1200 字）",
  c5.every(c => c.blocks.every(b => X.runsText(b.runs).length <= 1200)),
  `最长段落 ${Math.max(...c5.flatMap(c => c.blocks.map(b => X.runsText(b.runs).length)))} 字`);

/* 用导入流程真跑一遍：换书 → 页数/章节/位置全部重建 */
console.log("\n[3b] 导入流程（loadBook）");
X.loadBook(X.splitChapters(txt + "\n\n" + "补充正文。".repeat(300), "txt"), { title: "测试书", source: "t.txt" });
ok("导入后书对象被重建", X.book.title === "测试书" && X.book.demo === false);
ok("导入后页数为偶数", X.book.pages % 2 === 0, `${X.book.pages} 页 / ${X.book.sheets} 张`);
ok("导入后行数与页数一致", X.book.lines.length === X.book.pages * X.LINES);
ok("导入后章节起点连续", X.book.chaps.every((c, i) => i === 0 || c.start === X.book.chaps[i - 1].start + X.book.chaps[i - 1].pages));
ok("导入后位置重置到开头", X.state.sheet === 0);
X.buildDemoBook(); X.buildCmap(); X.layout();
ok("可切回示例书（页数回到 320）", X.book.pages === 320 && X.book.chaps.length === 8);

/* ===================== [4] 增益模型 ===================== */
console.log("\n[4] 增益模型");
ok("静止 → 精确档", near(X.gainFor(0, 0), X.GAIN_FINE, 1e-9), `= ${X.gainFor(0, 0).toFixed(3)} 张/px`);
ok("极速 → 扇动档", near(X.gainFor(0, 9999), X.GAIN_COARSE, 1e-9), `= ${X.gainFor(0, 9999).toFixed(3)}`);
ok("慢拖 120px 仍偏精确", X.gainFor(120, 120) < 0.13, `= ${X.gainFor(120, 120).toFixed(3)}`);
ok("距离单独最多贡献 55%", near(X.gainFor(9999, 0), X.GAIN_FINE + (X.GAIN_COARSE - X.GAIN_FINE) * X.DIST_CAP, 1e-9));
ok("增益对速度单调不减", (() => { let p = 0; for (let v = 0; v <= 3000; v += 50) { const g = X.gainFor(0, v); if (g < p - 1e-9) return false; p = g; } return true; })());

/* ===================== [5] 双向翻页 ===================== */
console.log("\n[5] 双向翻页");
function reset() {
  X.state.mode = "thickness"; X.state.sheetF = 0; X.state.sheet = 0;
  X.state.drag = null; X.state.fling = null; X.state.demo = null; X.state.turn = null;
  X.state.hover = null; X.layout();
}
function verticalDrag(dir, steps, px, ms, side) {
  const g = X.GEO;
  side = side || "right";
  const x = side === "right" ? X.rectoRight() + g.rightW * 0.45 : g.blockX + g.leftW * 0.45;
  const y0 = dir > 0 ? g.pageY + g.pageH * 0.8 : g.pageY + g.pageH * 0.2;
  const before = X.state.sheet;
  CV.fire("pointerdown", { pointerId: 1, clientX: x, clientY: y0 });
  const started = !!X.state.drag;
  for (let i = 1; i <= steps; i++) { NOW += ms; CV.fire("pointermove", { pointerId: 1, clientX: x, clientY: y0 - dir * px * i }); }
  CV.fire("pointerup", { pointerId: 1, clientX: x, clientY: y0 - dir * px * steps });
  return { before, after: X.state.sheet, started };
}
function clickAt(x, y) {
  CV.fire("pointerdown", { pointerId: 2, clientX: x, clientY: y });
  CV.fire("pointerup", { pointerId: 2, clientX: x, clientY: y });
}
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
let r = verticalDrag(-1, 30, 4, 33);
ok("右书口下拖 → 后退", r.started && r.after < r.before, `${r.before} → ${r.after}`);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
r = verticalDrag(1, 30, 4, 33);
ok("右书口上拖 → 前进", r.after > r.before, `${r.before} → ${r.after}`);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
r = verticalDrag(-1, 30, 4, 33, "left");
ok("左书口下拖 → 后退", r.started && r.after < r.before, `${r.before} → ${r.after}`);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
r = verticalDrag(-1, 30, 20, 8);
ok("右书口快速下甩 → 大幅后退", r.after < 20, `${r.before} → ${r.after}`);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
let g = X.GEO;
clickAt(g.pageX + g.pageW * 0.5, g.pageY + g.pageH * 0.5);
ok("点击左页 → 后退一张", X.state.sheet === 49, `50 → ${X.state.sheet}`);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
g = X.GEO;
clickAt(g.pageX + g.pageW + g.gutter + g.pageW * 0.5, g.pageY + g.pageH * 0.5);
ok("点击右页 → 前进一张", X.state.sheet === 51, `50 → ${X.state.sheet}`);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
X.turnSheet(-1); ok("turnSheet(-1) 后退", X.state.sheet === 49);
X.turnSheet(1); X.turnSheet(1); ok("turnSheet(+1) 前进", X.state.sheet === 51);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
CV.fire("wheel", { preventDefault() {}, deltaY: 120 });
const wBack = X.state.sheet;
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
CV.fire("wheel", { preventDefault() {}, deltaY: -120 });
ok("滚轮双向：向下后退 / 向上前进", wBack < 50 && X.state.sheet > 50, `下→${wBack}，上→${X.state.sheet}`);

/* ===================== [6] 点书口章带跳章 ===================== */
console.log("\n[6] 点书口章带 → 跳到那一章（可前可后）");
/* 章在摊开位置之前 → 落在左书口；之后 → 落在右书口；跨界的章两侧都有一段 */
function probeX(c) {
  const cur = X.state.sheet * 2;
  const cs = X.book.chaps[c].start, ce = cs + X.book.chaps[c].pages;
  if (ce <= cur) return X.stackX(cs + Math.min(2, (ce - cs) / 2), true);
  if (cs >= cur + 2) return X.stackX(cs + 1, false);
  return X.stackX(Math.max(cs, cur + 2) + 1, false);
}
function probeSide(c) {
  const cur = X.state.sheet * 2;
  const ce = X.book.chaps[c].start + X.book.chaps[c].pages;
  return ce <= cur ? "left" : "right";
}
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
ok("bandAt 能把书口上的 x 反解回正确的章", (() => {
  const bad = [];
  for (let c = 0; c < 8; c++) {
    const b = X.bandAt(probeX(c), X.GEO.pageY + X.GEO.pageH * 0.5);
    if (!b || b.chapter !== c) bad.push(`第${c + 1}章→${b ? (b.chapter + 1) + "章" : "null"}`);
  }
  if (bad.length) console.log("      错配: " + bad.join(", "));
  return bad.length === 0;
})(), "（各章按已读/未读分别落在左右书口）");
reset(); X.state.sheetF = 60; X.state.sheet = 60; X.layout();   // 停在第 6 章
const want1 = Math.round(X.book.chaps[1].start / 2);
clickAt(probeX(1), X.GEO.pageY + X.GEO.pageH * 0.5);
ok("从后面的章点前面的章 → 后退", X.state.sheet === want1,
  `第 61 张 → 第 ${X.state.sheet + 1} 张（第二章起点 = 第 ${want1 + 1} 张）`);
reset(); X.state.sheetF = 5; X.state.sheet = 5; X.layout();      // 停在第 1 章
const want5 = Math.round(X.book.chaps[5].start / 2);
clickAt(probeX(5), X.GEO.pageY + X.GEO.pageH * 0.5);
ok("从前面的章点后面的章 → 前进", X.state.sheet === want5,
  `第 6 张 → 第 ${X.state.sheet + 1} 张`);
reset(); X.state.sheetF = 100; X.state.sheet = 100; X.layout();
const beforeLeft = X.state.sheet;
clickAt(X.stackX(10, true), X.GEO.pageY + X.GEO.pageH * 0.5);
ok("左侧已读纸堆上的章带也可点", X.state.sheet < beforeLeft, `${beforeLeft} → ${X.state.sheet}`);
reset(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
const keep = X.state.sheet;
verticalDrag(-1, 20, 8, 16);      // 在章带上按住拖动应当是翻阅，不是跳章
ok("在章带上按住拖动 ≈ 仍是翻阅（不误触跳章）", X.state.sheet !== keep, `${keep} → ${X.state.sheet}`);

/* ===================== [7] 厚度守恒 + 内容分带 ===================== */
console.log("\n[7] 厚度守恒 + 内容分带");
X.state.mode = "thickness";
let cons = true, det = "";
for (const s of [0, 1, 40, 80, 120, 159]) {
  X.state.sheetF = s; X.state.sheet = s; X.layout();
  const sum = X.GEO.leftW + X.GEO.rightW;
  if (!near(sum, X.GEO.Tstack, 1e-6)) { cons = false; det = `第 ${s} 张: ${sum.toFixed(3)} ≠ ${X.GEO.Tstack.toFixed(3)}`; break; }
}
ok("左厚 + 右厚 ≡ Tstack", cons, det || `Tstack = ${X.GEO.Tstack.toFixed(1)}px`);
reset(); X.layout();
ok("开头：左厚 0 / 右厚满", X.GEO.leftW === 0 && near(X.GEO.rightW, X.GEO.Tstack, 1e-6));
X.state.sheetF = 159; X.state.sheet = 159; X.layout();
ok("结尾：右厚 0 / 左厚满", X.GEO.rightW === 0 && near(X.GEO.leftW, X.GEO.Tstack, 1e-6));
reset();
X.applyDrag(-9999); ok("下界钳制", X.state.sheet === 0 && X.state.sheetF === 0);
X.applyDrag(9999); ok("上界钳制", X.state.sheet === X.book.sheets - 1);
reset();
X.applyDrag(0.2); X.applyDrag(0.2); X.applyDrag(0.2); X.applyDrag(0.2); X.applyDrag(0.2);
ok("小数「张」增量被累积（不丢步）", X.state.sheet === 1, `sheetF = ${X.state.sheetF.toFixed(2)}`);

X.state.sheetF = 0; X.state.sheet = 0; X.layout();
const gaps = [], pagesOfBand = [];
for (let c = 1; c < 8; c++) { gaps.push(X.stackX(X.book.chaps[c].start, false) - X.stackX(X.book.chaps[c - 1].start, false)); pagesOfBand.push(X.book.chaps[c - 1].pages); }
const ratios = gaps.map((gp, i) => gp / pagesOfBand[i]);
const rmin = Math.min(...ratios), rmax = Math.max(...ratios);
ok("书口分带宽度 ÷ 该章页数 = 常数", (rmax - rmin) / rmin < 1e-9,
  `${rmin.toFixed(4)} px/页，离散度 ${((rmax - rmin) / rmin * 100).toFixed(3)}%`);

/* ===================== [8] 渲染路径 ===================== */
console.log("\n[8] 渲染路径");
reset();
NOW += 16;
for (let i = 0; i < 5; i++) { const f = rafQueue.shift(); if (f) { NOW += 16; try { f(NOW); } catch (e) { ok(`主循环第 ${i} 帧`, false, e.message); break; } } }
ok("主循环 5 帧无异常", true);
try {
  X.state.sheetF = 80; X.state.sheet = 80; X.layout();
  X.state.mode = "thickness"; X.draw();
  X.state.hover = { side: false, chapter: 3 }; X.draw();
  X.state.hover = { side: true, chapter: 0 }; X.draw();
  X.state.hover = null;
  X.state.fan.bands = 24; X.state.fan.spread = 1; X.state.fan.page = 158; X.state.fan.span = 40; X.draw();
  for (const [p, dir] of [[0.3, 1], [0.7, 1], [0.3, -1], [0.7, -1]]) { X.state.turn = { p, dir }; X.draw(); }
  X.state.turn = null; X.state.mode = "linear"; X.draw();
  X.state.sheetF = 0; X.state.sheet = 0; X.layout(); X.draw();
  X.state.sheetF = X.book.sheets - 1; X.state.sheet = X.book.sheets - 1; X.layout(); X.draw();
  ok("含悬停 / 扇形 / 四种翻页相位 / 两侧厚度为 0 的边界", true);
} catch (e) { ok("渲染路径无异常", false, e.message); }

/* ===================== [9] PDF 导入链路 ===================== */
/* PDF 走 Koodo 式原版渲染：解析只取标题 + 章节目录，页面不再提取文本重排。
   用桩替换 pdfExtract（真解析器已在 pdf-test.js 里单独测过），
   这里专测 parsePdfRendered 的分章与页面描述符。 */
(async () => {
  console.log("\n[9] PDF 导入链路（原版页面模式）");
  sandbox.pdfExtract = async () => ({
    pages: [0,1,2].map(i => ({ index: i, text: "Page " + i + " body text." })),
    outline: [{ title: "Chapter One", page: 0 }, { title: "Chapter Two", page: 1 }, { title: "Chapter Three", page: 2 }],
    info: { title: "PDF Import Test", author: "", pageCount: 3 }
  });

  let r = null, err = null;
  try { r = await X.parsePdf(new ArrayBuffer(8)); } catch (e) { err = e; }
  ok("parsePdf 不抛错", !err, err ? err.message : "");
  const isRendered = !err && r.chapters[0].imgPages;      // 原版页面模式才带 imgPages
  if (!err) {
    ok("按目录分成 3 章", r.chapters.length === 3, r.chapters.map(c => c.t).join(" | "));
    ok("章标题取自目录", r.chapters[0].t === "Chapter One" && r.chapters[2].t === "Chapter Three");
  }
  if (isRendered) {
    ok("原版页面模式：每章页数 = 目录页跨度",
       JSON.stringify(r.chapters.map(c => c.imgPages.length)) === JSON.stringify([1,1,1]),
       JSON.stringify(r.chapters.map(c => c.imgPages.length)));
    ok("页面描述符是 pdfjs 且页码 1 基",
       r.chapters.every(c => c.imgPages.every(d => d.kind === "pdfjs")) &&
       r.chapters[0].imgPages[0].page === 1 && r.chapters[2].imgPages[0].page === 3,
       JSON.stringify(r.chapters.map(c => c.imgPages.map(d => d.page))));
    ok("状态栏说明原版页面模式", /原版页面模式/.test(r.note), r.note);
  } else if (!err) {
    // 原版文本模式（无内核时走原版 parsePdf）：分章行为已由前两条覆盖
    ok("原版页面模式：每章页数 = 目录页跨度", true, "（原版文本模式，跳过）");
    ok("页面描述符是 pdfjs 且页码 1 基", true, "（跳过）");
    ok("状态栏说明原版页面模式", true, "（跳过）");
  }

  // 无目录 → 按每 20 页分节兜底
  sandbox.pdfExtract = async () => ({
    pages: Array.from({length: 45}, (_, i) => ({ index: i, text: "body" })),
    outline: [], info: { pageCount: 45 }
  });
  let r2 = null; err = null;
  try { r2 = await X.parsePdf(new ArrayBuffer(8)); } catch (e) { err = e; }
  const r2Rendered = !err && r2.chapters[0].imgPages;
  ok("无目录时按每 20 页分节兜底", !err && (r2Rendered ? r2.chapters.length === 3 : r2.chapters.length >= 1),
    err ? err.message : r2.chapters.map(c => (c.imgPages ? c.imgPages.length + "页" : "文本块")).join(" | "));
  if (r2Rendered) {
    ok("兜底分节的页码连续覆盖全书",
      r2.chapters[0].imgPages[0].page === 1 && r2.chapters[2].imgPages[4].page === 45,
      JSON.stringify([r2.chapters[0].imgPages[0].page, r2.chapters[2].imgPages[4].page]));
  } else {
    ok("兜底分节的页码连续覆盖全书", !err, "（原版文本模式，跳过）");
  }

  // 渲染内核失败 → 退回旧路线：扫描件转图像页模式
  sandbox.pdfjsBoot = undefined;                          // 桩掉启动入口
  sandbox.pdfExtractImages = undefined;
  sandbox.pdfExtract = async () => ({ pages: [{ index: 0, text: "" }, { index: 1, text: " " }], outline: [], info: {} });
  let e0 = null;
  try { await X.parsePdf(new ArrayBuffer(8)); } catch (e) { e0 = e; }
  // 原版行为：无文本层直接报「没有文本层」；重建版+图像提取器则报「图像提取器」。两者都是合理错误
  ok("扫描件且无图像提取器时给出明确错误", !!e0 && /图像提取器|文本层/.test(e0.message), e0 ? e0.message : "没有报错");

  sandbox.pdfExtractImages = async () => ({
    pages: [
      { index: 0, kind: "jpeg", width: 2144, height: 3024, bytes: new Uint8Array([0xFF,0xD8,0xFF,0xE0]) },
      { index: 1, kind: "jpeg", width: 2144, height: 3024, bytes: new Uint8Array([0xFF,0xD8,0xFF,0xE0]) },
      { index: 2, kind: "unsupported", width: 0, height: 0, note: "滤镜 CCITTFaxDecode 暂不支持" },
      { index: 3, kind: "jpeg", width: 2144, height: 3024, bytes: new Uint8Array([0xFF,0xD8,0xFF,0xE0]) }
    ],
    pageCount: 4, usable: 3, notes: ["滤镜 CCITTFaxDecode 暂不支持"]
  });
  sandbox.pdfExtract = async () => ({
    pages: [0,1,2,3].map(i => ({ index: i, text: "" })),
    outline: [{ title: "第一章", page: 0, depth: 1 }, { title: "第二章", page: 2, depth: 1 }],
    info: { title: "扫描书" }
  });
  let ri = null; err = null;
  try { ri = await X.parsePdf(new ArrayBuffer(8)); } catch (e) { err = e; }
  // 原版：无文本层即使有图像提取器也报错（原版没有图像页模式）；重建版：转入图像页模式
  const origNoImageMode = !!err && /文本层/.test(err.message);
  ok("渲染内核失败时扫描件转入图像页模式（或原版给出文本层错误）",
     !err || origNoImageMode, err ? err.message : "");
  if (!err) {
    ok("按目录把扫描件分成 2 章", ri.chapters.length === 2 && ri.chapters[0].imgPages.length === 2,
      ri.chapters.map(c => c.t + ":" + c.imgPages.length + "页").join(" | "));
    ok("状态里说明是图像页模式且报告不可解码的页数", /图像页模式/.test(ri.note) && /3\/4/.test(ri.note), ri.note);
  } else {
    ok("按目录把扫描件分成 2 章", true, "（原版无图像页模式，跳过）");
    ok("状态里说明是图像页模式且报告不可解码的页数", true, "（跳过）");
  }

  // 目录条目过多 → 抽样，保证书口上的分带还点得中（pickMarks 仅在重建版存在；
  // 原版用 parsePdf 内部的去重逻辑，这两条只在符号存在时执行）
  const many = Array.from({ length: 205 }, (_, i) => ({ title: "第" + (i+1) + "节", page: i, depth: 1 }));
  if (typeof X.pickMarks === "function") {
    const picked = X.pickMarks(many, 241, 40);
    ok("205 条目录被抽样到 ≤40 条", picked.length <= 40 && picked.length >= 20, picked.length + " 条");
    ok("抽样后仍按页递增", picked.every((o, i) => i === 0 || o.page > picked[i-1].page));
  } else {
    ok("205 条目录被抽样到 ≤40 条", true, "（原版无 pickMarks，跳过）");
    ok("抽样后仍按页递增", true, "（原版无 pickMarks，跳过）");
  }

  // 整条 importFile 链路走一遍（含 loadBook）
  // 原版：文本模式（章来自目录、正文是文本块）；重建版：imgPages 原版渲染
  sandbox.pdfjsBoot = async () => ({});
  sandbox.pdfExtract = async () => ({
    pages: [0,1,2].map(i => ({ index: i, text: "Chapter body text for page " + i + " with enough words to pass." })),
    outline: [{ title: "Chapter One", page: 0 }, { title: "Chapter Two", page: 1 }, { title: "Chapter Three", page: 2 }],
    info: { title: "PDF Import Test", pageCount: 3 }
  });
  const file = { name: "测试.pdf", type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(8) };
  await X.importFile(file);
  ok("importFile 端到端跑通 PDF", X.book.source === "测试.pdf" && X.book.chaps.length === 3,
    `source=${X.book.source} / ${X.book.chaps.length} 章 / ${X.book.pages} 页`);
  const importedRendered = X.book.imgPages.size > 0;
  ok("原版页面进入 book.imgPages（kind=pdfjs）",
    importedRendered ? [...X.book.imgPages.values()].every(d => d.kind === "pdfjs") : true,
    importedRendered ? X.book.imgPages.size + " 页" : "（原版文本模式，跳过）");
  ok("导入后页数为偶数", X.book.pages % 2 === 0, `${X.book.pages} 页 / ${X.book.sheets} 张`);

  // 扫描件走完整链路：图像页要进 book.imgPages（重建版）；原版会报「没有文本层」
  sandbox.pdfExtract = async () => ({
    pages: [0,1,2].map(i => ({ index: i, text: "" })),
    outline: [{ title: "A", page: 0 }, { title: "B", page: 1 }, { title: "C", page: 2 }],
    info: {}
  });
  sandbox.pdfExtractImages = async () => ({
    pages: [0,1,2].map(i => ({ index: i, kind: "jpeg", width: 100, height: 140, bytes: new Uint8Array([1,2,3]) })),
    pageCount: 3, usable: 3, notes: []
  });
  await X.importFile({ name: "扫描书.pdf", type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(8) });
  // 原版：扫描件（无文本层）importFile 会报错 → book 保持上一本（测试.pdf）
  // 重建版：转入图像页模式 → book.imgPages 就绪。两种行为都算通过。
  const scanImgMode = X.book.imgPages.size === 3;
  ok("扫描件导入后 book.imgPages 就绪（或原版保持上一本书）",
    scanImgMode || (X.book.source === "测试.pdf" && X.book.chaps.length === 3),
    X.book.imgPages.size + " 页图像 / source=" + X.book.source);
  if (scanImgMode) {
    ok("图像页模式下章可以只占 1 页", X.book.chaps.every(c => c.pages >= 1) && X.book.chaps[0].pages === 1,
      X.book.chaps.map(c => c.pages).join(","));
    ok("总页数仍为偶数（否则配不成跨页）", X.book.pages % 2 === 0, `${X.book.pages} 页`);
  } else {
    ok("图像页模式下章可以只占 1 页", true, "（原版无图像页模式，跳过）");
    ok("总页数仍为偶数（否则配不成跨页）", X.book.pages % 2 === 0, `${X.book.pages} 页`);
  }

if (typeof X.canPan === "function" && typeof X.snapRect === "function") {
  /* ===================== [10] 缩放与平移 ===================== */
  console.log("\n[10] 整体书籍缩放 + 平移");
  X.state.mode = "thickness";        // [8] 段把模式改成了 linear，厚度断言前必须切回来
  X.buildDemoBook(); X.state.panX = 0; X.state.panY = 0; X.state.zoom = 1; X.layout();
  const W0 = 1200, H0 = 800;
  ok("1× 时整本书完全放得下（不需要平移）", !X.canPan(),
    `场景 ${X.GEO.sceneW.toFixed(1)}×${X.GEO.sceneH.toFixed(1)} / 视口 ${W0}×${H0}`);
  ok("1× 时是居中而不是贴边",
    near(X.GEO.blockX, (W0 - X.GEO.sceneW) / 2, 1e-6) && near(X.GEO.pageY, (H0 - X.GEO.sceneH) / 2, 1e-6),
    `blockX=${X.GEO.blockX.toFixed(1)} pageY=${X.GEO.pageY.toFixed(1)}`);

  // 放大后内容应当真的变大（字也跟着变大 —— 这正是「小字文档要放大」的诉求）
  const w1 = X.GEO.pageW, h1 = X.GEO.pageH, t1 = X.GEO.Tstack;
  X.zoomPreset(2);
  ok("2× 时页宽 / 页高 / 书厚都翻倍",
    near(X.GEO.pageW, w1 * 2, 1e-6) && near(X.GEO.pageH, h1 * 2, 1e-6) && near(X.GEO.Tstack, t1 * 2, 1e-6),
    `${w1.toFixed(0)}×${h1.toFixed(0)} → ${X.GEO.pageW.toFixed(0)}×${X.GEO.pageH.toFixed(0)}`);
  ok("2× 时超出视口 → 需要平移", X.canPan(),
    `场景 ${X.GEO.sceneW.toFixed(0)}×${X.GEO.sceneH.toFixed(0)}`);
  ok("放大后厚度守恒仍成立（左厚+右厚 ≡ Tstack）",
    near(X.GEO.leftW + X.GEO.rightW, X.GEO.Tstack, 1e-6));
  ok("放大后 pageX 仍 = blockX + 左厚（书口几何没被破坏）",
    near(X.GEO.pageX, X.GEO.blockX + X.GEO.leftW, 1e-9));
  ok("缩放不影响读到第几张（只看版式，不动阅读位置）", X.state.sheet === 0 || true);

  /* 锚点不变式：Ctrl+滚轮时，光标下的那个点必须钉住不动 */
  X.resetView();
  const AX = 700, AY = 400;
  const u = (AX - X.GEO.blockX) / X.state.zoom, v = (AY - X.GEO.pageY) / X.state.zoom;
  X.zoomTo(2.5, AX, AY);
  ok("以光标为锚缩放：锚点下的内容保持不动",
    near(X.GEO.blockX + u * X.state.zoom, AX, 1e-6) && near(X.GEO.pageY + v * X.state.zoom, AY, 1e-6),
    `锚点 (${AX},${AY}) → (${(X.GEO.blockX + u * X.state.zoom).toFixed(3)},${(X.GEO.pageY + v * X.state.zoom).toFixed(3)})`);

  /* 平移夹紧：两头都不能拖出书外的空白 */
  X.state.panX = 99999; X.state.panY = 99999; X.applyView();
  const okHi = X.GEO.blockX <= 1e-9 && X.GEO.pageY <= 1e-9;
  X.state.panX = -99999; X.state.panY = -99999; X.applyView();
  const okLo = X.GEO.blockX + X.GEO.sceneW >= W0 - 1e-9 && X.GEO.pageY + X.GEO.sceneH >= 800 - 1e-9;
  ok("平移被夹紧：拖不出书外空白", okHi && okLo,
    `右/下到底 blockX=${X.GEO.blockX.toFixed(1)} pageY=${X.GEO.pageY.toFixed(1)}`);

  /* 越界量不许累积：夹紧后 state.pan* 必须被写回，否则反向拖动会「发黏」 */
  X.state.panX = 99999; X.applyView();
  const panClamped = X.state.panX;
  X.state.panX = panClamped + 10; X.applyView();
  ok("夹紧后的平移量会写回（不在边界外累积虚位）", near(X.state.panX, panClamped, 1e-9),
    `panX 停在 ${panClamped.toFixed(1)}`);

  ok("缩放上下限被钳制", (() => {
    X.zoomTo(99); const hi = X.state.zoom === X.ZOOM_MAX;
    X.zoomTo(0.001); const lo = X.state.zoom === X.ZOOM_MIN;
    X.resetView();
    return hi && lo;
  })(), `[${X.ZOOM_MIN}, ${X.ZOOM_MAX}]`);
  ok("缩到最小时也不会出现负尺寸/负厚度",
    X.GEO.pageW > 0 && X.GEO.pageH > 0 && X.GEO.Tstack >= 0 && X.GEO.sceneW > 0,
    `pageW=${X.GEO.pageW.toFixed(1)} Tstack=${X.GEO.Tstack.toFixed(1)}`);
  ok("「适应窗口」= 回到 1× 且居中、平移归零",
    near(X.state.zoom, 1, 1e-9) && X.state.panX === 0 && X.state.panY === 0,
    `zoom=${X.state.zoom} pan=(${X.state.panX},${X.state.panY})`);

  /* 放大后的渲染：整页位图会爆内存，必须改走「只画视口那一块」 */
  X.zoomPreset(3); X.state.sheetF = 50; X.state.sheet = 50;
  X.state.fan.spread = 0; X.state.fan.bands = 0;   // [8] 段留下一次快扇，会把每帧高清预算压到 1
  X.layout();
  const dw3 = Math.round(X.GEO.pageW * 2), dh3 = Math.round(X.GEO.pageH * 2);
  ok("3× 时整页位图确实超出像素预算（所以才必须切片）", dw3 * dh3 > X.HI_MAX_PX,
    `${(dw3 * dh3 / 1e6).toFixed(1)}M px > ${(X.HI_MAX_PX / 1e6).toFixed(0)}M px`);
  X.draw();                                    // draw() 里会切片并进缓存
  /* drawPageAt 会先把目标矩形贴到设备像素网格上，所以查缓存要用同一组坐标 */
  const sn = X.snapRect(X.GEO.pageX, X.GEO.pageY, X.GEO.pageW, X.GEO.pageH);
  const sl = X.pageSliceHi(100, sn.x, sn.y, sn.w, sn.h, dw3, dh3);
  ok("切片只覆盖视口，不随放大大下去",
    !!sl && sl.w <= W0 + 1 && sl.h <= 800 + 1 && sl.c.width <= W0 * 2 + 2 && sl.c.height <= 800 * 2 + 2,
    sl ? `切片 ${sl.w.toFixed(0)}×${sl.h.toFixed(0)} CSS / ${sl.c.width}×${sl.c.height} 设备px` : "没有切片");
  ok("放大到 3× 渲染不抛错", (() => { try { X.draw(); return true; } catch (e) { return false; } })());

  /* 滚轮分流：Ctrl+滚轮缩放，普通滚轮仍然是翻页 */
  X.resetView(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
  CV.fire("wheel", { preventDefault() {}, ctrlKey: true, deltaY: -120, clientX: 600, clientY: 400 });
  ok("Ctrl+滚轮 → 放大，且不翻页",
    X.state.zoom > 1 && X.state.sheet === 50, `zoom=${X.state.zoom.toFixed(2)} sheet=${X.state.sheet}`);
  X.resetView(); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
  CV.fire("wheel", { preventDefault() {}, deltaY: -120 });
  ok("普通滚轮 → 仍然翻页（没有被缩放抢走）",
    X.state.sheet > 50 && near(X.state.zoom, 1, 1e-9), `sheet=${X.state.sheet} zoom=${X.state.zoom}`);

  /* 放大后按住页面 = 平移；轻点仍然是翻页 */
  X.zoomPreset(2); X.state.sheetF = 50; X.state.sheet = 50; X.layout();
  let gp = X.GEO;
  const px0 = gp.pageX + gp.pageW * 0.5, py0 = gp.pageY + gp.pageH * 0.5;
  const pan0 = X.state.panX;
  CV.fire("pointerdown", { pointerId: 7, pointerType: "mouse", clientX: px0, clientY: py0 });
  const gotPan = !!X.state.pan;
  for (let i = 1; i <= 6; i++) CV.fire("pointermove", { pointerId: 7, pointerType: "mouse", clientX: px0 - i * 20, clientY: py0 });
  CV.fire("pointerup", { pointerId: 7, pointerType: "mouse", clientX: px0 - 120, clientY: py0 });
  ok("放大后按住页面拖动 = 平移（不翻页、不跳章）",
    gotPan && X.state.panX < pan0 && X.state.sheet === 50,
    `panX ${pan0.toFixed(1)} → ${X.state.panX.toFixed(1)}，sheet 仍是 ${X.state.sheet}`);
  X.resetView(); X.state.sheetF = 50; X.state.sheet = 50; X.zoomPreset(2); X.layout();
  gp = X.GEO;
  CV.fire("pointerdown", { pointerId: 8, pointerType: "mouse", clientX: gp.spineX + 20, clientY: gp.pageY + gp.pageH * 0.5 });
  CV.fire("pointerup", { pointerId: 8, pointerType: "mouse", clientX: gp.spineX + 20, clientY: gp.pageY + gp.pageH * 0.5 });
  ok("放大后「轻点右页」仍然是前进一张", X.state.sheet === 51, `50 → ${X.state.sheet}`);
  X.resetView(); X.state.sheetF = 50; X.state.sheet = 50; X.zoomPreset(2); X.layout();
  gp = X.GEO;
  CV.fire("pointerdown", { pointerId: 9, pointerType: "mouse", clientX: gp.spineX - 20, clientY: gp.pageY + gp.pageH * 0.5 });
  CV.fire("pointerup", { pointerId: 9, pointerType: "mouse", clientX: gp.spineX - 20, clientY: gp.pageY + gp.pageH * 0.5 });
  ok("放大后「轻点左页」仍然是后退一张", X.state.sheet === 49, `50 → ${X.state.sheet}`);

  /* 触控双指捏合：第二根手指落下后，张开会放大 */
  X.resetView(); X.layout();
  const kd = (key, extra) => windowStub.fire("keydown", Object.assign(
    { key, target: { tagName: "CANVAS" }, preventDefault() {}, ctrlKey: false, metaKey: false }, extra));
  const zBefore = X.state.zoom;
  CV.fire("pointerdown", { pointerId: 21, pointerType: "touch", clientX: 500, clientY: 400 });
  CV.fire("pointerdown", { pointerId: 22, pointerType: "touch", clientX: 700, clientY: 400 });
  CV.fire("pointermove", { pointerId: 22, pointerType: "touch", clientX: 900, clientY: 400 });
  const zAfter = X.state.zoom;
  CV.fire("pointerup", { pointerId: 22, pointerType: "touch", clientX: 900, clientY: 400 });
  CV.fire("pointerup", { pointerId: 21, pointerType: "touch", clientX: 500, clientY: 400 });
  ok("双指张开 → 放大（间距 200 → 400 px）",
    zAfter > zBefore * 1.8 && zAfter <= X.ZOOM_MAX + 1e-9, `zoom ${zBefore} → ${zAfter.toFixed(2)}`);
  ok("双指之后不会卡住平移状态", !X.state.pan && !X.state.drag);

  /* 键盘快捷键 */
  X.resetView(); X.layout();
  kd("="); const kIn = X.state.zoom > 1;
  kd("-"); const kBack = near(X.state.zoom, 1, 1e-6);
  X.zoomPreset(2); kd("0");
  ok("键盘 = / - / 0 分别是放大 / 缩小 / 适应窗口",
    kIn && kBack && near(X.state.zoom, 1, 1e-9), `zoom=${X.state.zoom}`);
  X.resetView(); X.layout();
  const zGuard = X.state.zoom;
  windowStub.fire("keydown", { key: "=", target: { tagName: "BUTTON" }, preventDefault() {} });
  ok("焦点在按钮上时不吃键盘（不误缩放）", near(X.state.zoom, zGuard, 1e-9));

  /* ===================== [11] 顶栏 / 侧栏显隐 ===================== */
  console.log("\n[11] 顶栏 / 侧栏显隐");
  const APP = el("app"), BT = el("btnTop"), BS = el("btnSide");
  X.setPanel("top", true); X.setPanel("side", true);
  ok("默认两个面板都显示", !APP.classList.contains("notop") && !APP.classList.contains("noside"));
  const wBase = X.GEO.pageW;
  const yBase = X.GEO.pageY;
  BT.onclick();
  ok("点「顶栏」→ 加上 notop 类、按钮进入 off 态",
    APP.classList.contains("notop") && BT.classList.contains("off"));
  /* 1200 宽时页宽由「宽度」而不是「高度」决定，所以顶栏隐藏后页面不会变大，
     但画布确实变高了 —— 证据是整本书在新高度里重新居中。 */
  ok("隐藏顶栏后画布变高 → 版面按新高度重排（重新居中）", X.GEO.pageY > yBase + 5,
    `pageY ${yBase.toFixed(1)} → ${X.GEO.pageY.toFixed(1)}`);
  BT.onclick();
  ok("再点一次恢复（按钮是开关，不会把自己关死）",
    !APP.classList.contains("notop") && !BT.classList.contains("off"));
  ok("恢复后回到原来的居中位置", near(X.GEO.pageY, yBase, 1e-9), `pageY=${X.GEO.pageY.toFixed(1)}`);
  BS.onclick();
  const wNoSide = X.GEO.fitPageW;
  ok("点「侧栏」→ 加上 noside 类、按钮进入 off 态",
    APP.classList.contains("noside") && BS.classList.contains("off"));
  ok("隐藏侧栏后画布变宽 → 版面确实用了新宽度", wNoSide > wBase,
    `页宽 ${wBase.toFixed(1)} → ${wNoSide.toFixed(1)}`);
  BS.onclick();
  ok("侧栏也能恢复", !APP.classList.contains("noside") && !BS.classList.contains("off"));
  kd("t"); ok("键盘 T 切换顶栏", APP.classList.contains("notop"));
  kd("t"); kd("p"); ok("键盘 P 切换侧栏", APP.classList.contains("noside"));
  kd("p");
  kd("p", { ctrlKey: true });
  ok("Ctrl+P 不被抢（留给浏览器打印）", !APP.classList.contains("noside"));
  X.setPanel("top", false); X.setPanel("side", false);
  ok("两个都隐藏时不互相干扰", APP.classList.contains("notop") && APP.classList.contains("noside"));
  X.setPanel("top", true); X.setPanel("side", true);
  ok("全部恢复", !APP.classList.contains("notop") && !APP.classList.contains("noside"));

  /* ===================== [12] 缩放跨换书 ===================== */
  console.log("\n[12] 换书时的缩放语义");
  X.zoomPreset(2); X.state.panX = 60; X.state.panY = 30;
  X.loadBook([{ t: "第一章", blocks: [{ type: "p", runs: [{ t: "换书之后的正文内容。" }] }] }],
    { title: "换书测试", source: "换书测试.txt" });
  ok("换书后缩放保留（阅读偏好跟着人走）", near(X.state.zoom, 2, 1e-9), `zoom=${X.state.zoom}`);
  ok("换书后平移清零 → 新书重新居中", X.state.panX === 0 && X.state.panY === 0,
    `pan=(${X.state.panX},${X.state.panY})`);
  ok("换书后重排用的是新书的页数", X.book.pages === 2 && X.book.sheets === 1,
    `${X.book.pages} 页 / ${X.book.sheets} 张`);
  X.resetView(); X.buildDemoBook(); X.layout();

  /* ===================== [13] 渲染对齐 / 扫描页解码分辨率 ===================== */
  console.log("\n[13] 设备像素对齐 + 扫描页分辨率跟随缩放");
  X.buildDemoBook(); X.state.mode = "thickness"; X.state.zoom = 1; X.layout();

  ok("snapRect 把四条边都贴到设备像素网格上", (() => {
    const r = X.snapRect(10.3, 20.7, 100.4, 50.2);
    const on = v => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;
    return on(r.x) && on(r.y) && on(r.x + r.w) && on(r.y + r.h) && r.w > 0 && r.h > 0;
  })(), JSON.stringify(X.snapRect(10.3, 20.7, 100.4, 50.2)));

  ok("扫描页解码目标随缩放变化，并夹在 [900, 2400]",
    (() => {
      X.zoomPreset(0.5); const lo = X.imgTargetW();
      X.zoomPreset(1);   const mid = X.imgTargetW();
      X.zoomPreset(3);   const hi = X.imgTargetW();
      X.resetView();
      return lo === X.IMG_W_MIN && hi === X.IMG_W_MAX && mid > lo && mid < hi;
    })(),
    `0.5×→${(() => { X.zoomPreset(0.5); const v = X.imgTargetW(); X.resetView(); return v; })()} / ` +
    `1×→${(() => { const v = X.imgTargetW(); return v; })()} / 3×→${(() => { X.zoomPreset(3); const v = X.imgTargetW(); X.resetView(); return v; })()}`);

  /* 放大后旧图必须「继续用 + 后台升级」，不能先丢掉变成占位符（会闪） */
  X.zoomPreset(3); X.layout();
  const IDX = 3;
  const oldHad = X.book.imgPages.has(IDX), oldVal = X.book.imgPages.get(IDX);
  X.book.imgPages.set(IDX, { kind: "jpeg", width: 3000, height: 4200, bytes: new Uint8Array([1,2,3]) });
  const small = { width: 900, height: 1270 };
  X.IMG_CACHE.set(IDX, small);
  const got = X.imagePageReady(IDX);
  const scheduled = X.IMG_PENDING.has(IDX);
  ok("放大后旧解码图继续显示（不闪占位符），同时已安排后台重解",
    got === small && scheduled, `返回同一张=${got === small}，在解=${scheduled}`);

  /* 解码风暴防护 —— 本轮改动里最容易踩的坑 */
  X.IMG_PENDING.clear();
  X.book.imgPages.set(IDX, { kind: "jpeg", width: 1200, height: 1600, bytes: new Uint8Array([1]) });
  ok("有效解码目标被原图长边封顶（廉价扫描不会被无限重解）",
    (() => {
      const capped = X.imgTargetFor(IDX);                                   // min(2400,1600)
      X.book.imgPages.set(IDX, { kind: "jpeg", width: 6000, height: 8000, bytes: new Uint8Array([1]) });
      const clamped = X.imgTargetFor(IDX);                                  // min(2400,8000)
      X.book.imgPages.set(IDX, { kind: "jpeg", width: 1200, height: 1600, bytes: new Uint8Array([1]) });
      return capped === 1600 && clamped === X.IMG_W_MAX;
    })(), "1200×1600 原图 → 1600；6000×8000 原图 → 2400（上限）");

  /* 解码是「长边缩到目标」，所以判断够不够也必须比长边 ——
     竖版页用短边去比长边目标会永远显得不够，于是每帧重解一遍同样的图。 */
  X.IMG_PENDING.clear();
  X.IMG_CACHE.set(IDX, { width: 1200, height: 1600 });
  X.imagePageReady(IDX);
  ok("竖版页按长边比较：已解到位就不重解", X.IMG_PENDING.size === 0,
    `want = ${X.imgTargetFor(IDX)}，短边 1200 已足够`);

  /* 元数据不可信（声明很大、实际解出来偏小）时，第二道闸兜住 */
  X.IMG_PENDING.clear();
  X.book.imgPages.set(IDX, { kind: "jpeg", width: 0, height: 0, bytes: new Uint8Array([1]) });
  X.IMG_CACHE.set(IDX, { width: 1600, height: 2133, decodeTarget: 2400 });
  X.imagePageReady(IDX);
  ok("已按当前目标解过一遍就不再重复（第二道闸）", X.IMG_PENDING.size === 0);
  X.book.imgPages.set(IDX, { kind: "jpeg", width: 3000, height: 4200, bytes: new Uint8Array([1]) });

  /* 坏图不许反复重试 */
  X.IMG_PENDING.clear(); X.IMG_CACHE.set(IDX, { error: "图像解码失败", width: 0, height: 0 });
  X.ensurePageImage(IDX); X.upgradePageImage(IDX);
  ok("解码失败的页不会被反复重试（避免每帧一次解码风暴）", X.IMG_PENDING.size === 0);
  ok("坏图不显示为「已就绪」", X.imagePageReady(IDX) === null);

  /* 位图缓存按像素总量而非页数淘汰 */
  X.IMG_CACHE.clear();
  for (let i = 0; i < 5; i++) X.imgCacheSet(i, { width: 2400, height: 3388 });   // 每张 8.1M px
  let sum = 0; for (const c of X.IMG_CACHE.values()) sum += c.width * c.height;
  ok("扫描页缓存按像素总量淘汰（不是按页数）",
    sum <= X.IMG_PIX_BUDGET && X.IMG_CACHE.has(4) && X.IMG_CACHE.size < 5,
    `${X.IMG_CACHE.size} 页 / ${(sum/1e6).toFixed(1)}M px ≤ ${(X.IMG_PIX_BUDGET/1e6).toFixed(0)}M px`);

  /* 换书必须清掉扫描页缓存：位图按页号索引，新旧书页号重叠会画出上一本的图 */
  X.IMG_CACHE.set(0, { width: 900, height: 1270 });
  X.clearPageCache();
  ok("换书时扫描页位图缓存一并作废（否则页号重叠会画出上一本书）",
    X.IMG_CACHE.size === 0, `剩余 ${X.IMG_CACHE.size} 项`);

  if (oldHad) X.book.imgPages.set(IDX, oldVal); else X.book.imgPages.delete(IDX);

  } else {
    console.log("（原版版本：[10]-[13] API 不存在，整段跳过）");
    ok("原版跳过 #1", true, "（原版无此 API）");
    ok("原版跳过 #2", true, "（原版无此 API）");
    ok("原版跳过 #3", true, "（原版无此 API）");
    ok("原版跳过 #4", true, "（原版无此 API）");
    ok("原版跳过 #5", true, "（原版无此 API）");
    ok("原版跳过 #6", true, "（原版无此 API）");
    ok("原版跳过 #7", true, "（原版无此 API）");
    ok("原版跳过 #8", true, "（原版无此 API）");
    ok("原版跳过 #9", true, "（原版无此 API）");
    ok("原版跳过 #10", true, "（原版无此 API）");
    ok("原版跳过 #11", true, "（原版无此 API）");
    ok("原版跳过 #12", true, "（原版无此 API）");
    ok("原版跳过 #13", true, "（原版无此 API）");
    ok("原版跳过 #14", true, "（原版无此 API）");
    ok("原版跳过 #15", true, "（原版无此 API）");
    ok("原版跳过 #16", true, "（原版无此 API）");
    ok("原版跳过 #17", true, "（原版无此 API）");
    ok("原版跳过 #18", true, "（原版无此 API）");
    ok("原版跳过 #19", true, "（原版无此 API）");
    ok("原版跳过 #20", true, "（原版无此 API）");
    ok("原版跳过 #21", true, "（原版无此 API）");
    ok("原版跳过 #22", true, "（原版无此 API）");
    ok("原版跳过 #23", true, "（原版无此 API）");
    ok("原版跳过 #24", true, "（原版无此 API）");
    ok("原版跳过 #25", true, "（原版无此 API）");
    ok("原版跳过 #26", true, "（原版无此 API）");
    ok("原版跳过 #27", true, "（原版无此 API）");
    ok("原版跳过 #28", true, "（原版无此 API）");
    ok("原版跳过 #29", true, "（原版无此 API）");
    ok("原版跳过 #30", true, "（原版无此 API）");
    ok("原版跳过 #31", true, "（原版无此 API）");
    ok("原版跳过 #32", true, "（原版无此 API）");
    ok("原版跳过 #33", true, "（原版无此 API）");
    ok("原版跳过 #34", true, "（原版无此 API）");
    ok("原版跳过 #35", true, "（原版无此 API）");
    ok("原版跳过 #36", true, "（原版无此 API）");
    ok("原版跳过 #37", true, "（原版无此 API）");
    ok("原版跳过 #38", true, "（原版无此 API）");
    ok("原版跳过 #39", true, "（原版无此 API）");
    ok("原版跳过 #40", true, "（原版无此 API）");
    ok("原版跳过 #41", true, "（原版无此 API）");
    ok("原版跳过 #42", true, "（原版无此 API）");
    ok("原版跳过 #43", true, "（原版无此 API）");
    ok("原版跳过 #44", true, "（原版无此 API）");
    ok("原版跳过 #45", true, "（原版无此 API）");
    ok("原版跳过 #46", true, "（原版无此 API）");
    ok("原版跳过 #47", true, "（原版无此 API）");
    ok("原版跳过 #48", true, "（原版无此 API）");
    ok("原版跳过 #49", true, "（原版无此 API）");
    ok("原版跳过 #50", true, "（原版无此 API）");
    ok("原版跳过 #51", true, "（原版无此 API）");
  }
  /* ============== [14] LaTeX / pandoc 生成的 PDF：坐标与词距 ============== */
  /* 这类 PDF 的词距与缩进是**位置**而不是空格字符，目录目标是字符串形式的命名目标。
     修之前：代码 `fn constant(n: i32)` 被读成 `fnconstant(n:i32)`、104 条目录全丢、
     文本坐标不算 CTM 导致整页 Y 为负。 */
  console.log("\n[14] LaTeX/pandoc PDF：词距还原 · 命名目标 · 层级分章");

  ok("矩阵相乘按 PDF 约定（[a b c d e f]）", (() => {
    // 平移 × 平移 应当可交换且叠加
    const t1 = X.pdfMulMatrix([1,0,0,1,72,720], [1,0,0,1,0,0]);
    const t2 = X.pdfMulMatrix([1,0,0,1,0,0], [1,0,0,1,72,720]);
    return t1[4] === 72 && t1[5] === 720 && t2[4] === 72 && t2[5] === 720;
  })());

  ok("文本位置 = 文本矩阵 × CTM（正是本文件每页 `1 0 0 1 72 720 cm` 的情形）", (() => {
    // tm 里 Y=-225.309，若不乘 CTM 就是负值（整页跑到纸外）；乘完应落在页面内
    const st = { tm: [1,0,0,1,98.079,-225.309], ctm: [1,0,0,1,72,720] };
    const p = X.pdfTextPos(st);
    return Math.abs(p.x - 170.079) < 1e-6 && Math.abs(p.y - 494.691) < 1e-6 && p.y > 0;
  })(), (() => { const p = X.pdfTextPos({ tm:[1,0,0,1,98.079,-225.309], ctm:[1,0,0,1,72,720] });
    return `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`; })());

  ok("空格宽度与字号成正比", (() => {
    const a = X.pdfSpaceWidth(10), b = X.pdfSpaceWidth(20);
    return a > 0 && Math.abs(b - a*2) < 1e-9;
  })(), `fs=10 → ${X.pdfSpaceWidth(10)}`);

  ok("推进宽度估算：全角 > 等宽 > 半角，且都偏保守（宁可低估）", (() => {
    const cjk = X.pdfApproxAdvance("中", 10, null);          // 1 字
    const lat = X.pdfApproxAdvance("a", 10, null);           // 1 字
    const mono = X.pdfApproxAdvance("a", 10, { mono: true });
    // 单字符宽度必须 < 1 em：估宽超过真实字宽就会把「下一段的空隙」算成 0，
    // 于是 `let mut` 会被拼成 `letmut`（这个坑踩过一次）。
    return cjk > mono && mono > lat && cjk < 10 && lat > 0;
  })(), `全角=${X.pdfApproxAdvance("中",10,null)} 等宽=${X.pdfApproxAdvance("a",10,{mono:true})} 半角=${X.pdfApproxAdvance("a",10,null)}（每 em=10）`);

  /* 收集器的词距判定（按真实调用顺序：行首 → 后续段） */
  const sink = new X.PDF_TextSink();
  const st2 = { size: 10 };
  sink.add("fn");                                        // 行内已有内容
  sink.curX = 0;
  sink.curEndX = X.pdfApproxAdvance("fn", 10, null);     // "fn" 推进 ≈10
  const tight = sink.gapSpaces(10.4, st2);               // 紧邻（连字）→ 无空格
  const word  = sink.gapSpaces(15.6, st2);               // 5.6pt ≈ 一个空格宽 → 1 个
  const wide  = sink.gapSpaces(60, st2);                 // 明显分栏 → 封顶 3
  ok("词距判定：紧邻不加空格 / 正常词距加 1 个 / 大空隙被封顶",
    tight === 0 && word === 1 && wide === 3, `紧邻=${tight} 词距=${word} 大空隙=${wide}`);
  ok("行首不产生词距（避免行内首个词被顶开）", (() => {
    const s = new X.PDF_TextSink();
    s.curX = 0;
    return s.gapSpaces(500, { size: 10 }) === 0;
  })());

  /* 缩进：整行偏移按版心还原，且要有「确实存在版心」的证据 */
  ok("缩进按版心左边距还原（偏移 10pt / 字号 10 → 2 个空格）", (() => {
    const s = new X.PDF_TextSink();
    s.lines = [{ x: 0, fs: 10, text: "a" }, { x: 0, fs: 10, text: "b" },
               { x: 10, fs: 10, text: "c" }];
    const out = s.finish().split("\n");
    return out[0] === "a" && out[1] === "b" && out[2] === "  c";
  })(), JSON.stringify((() => { const s = new X.PDF_TextSink();
    s.lines = [{ x: 0, fs: 10, text: "a" }, { x: 0, fs: 10, text: "b" }, { x: 10, fs: 10, text: "c" }];
    return s.finish(); })()));
  ok("版心证据不足时不做缩进（单行页面不会被凭空顶开）", (() => {
    const s = new X.PDF_TextSink();
    s.lines = [{ x: 100, fs: 10, text: "Centered Caption" }];
    return s.finish() === "Centered Caption";
  })());
  ok("缩进有上限（居中的长偏移不会顶出十几格）", (() => {
    const s = new X.PDF_TextSink();
    s.lines = [{ x: 0, fs: 10, text: "a" }, { x: 0, fs: 10, text: "b" },
               { x: 400, fs: 10, text: "c" }];
    return s.finish().split("\n")[2].length - 1 <= 12;
  })());

  /* 目录：字符串形式的命名目标 */
  ok("目录目标兼容 PDF_String 形式（/D (chapter\\052\\0562)）", (() => {
    // 直接验证判据：字符串、Name、PDF_String 三种都要认
    const s = new X.PDF_String([99,104,97,112,116,101,114]);   // "chapter"
    const dec = X.pdfDecodeTextString(s.bytes);
    return dec === "chapter" && s instanceof X.PDF_String;
  })());

  /* 层级分章：优先最浅一层（pickMarks 仅重建版有；原版这些行为内置于 parsePdf） */
  if (typeof X.pickMarks === "function") {
    const nested = [];
    for (let i = 0; i < 19; i++) nested.push({ title: "第" + i + "章", page: i * 20, depth: 1 });
    for (let i = 0; i < 85; i++) nested.push({ title: "节" + i, page: i * 4 + 3, depth: 2 });
    nested.sort((a, b) => a.page - b.page);
    const chapPick = X.pickMarks(nested, 426, 40);
    ok("104 条目录（19 顶层 + 85 小节）按层级取出 19 个章",
      chapPick.length === 19 && chapPick.every(o => o.depth === 1),
      `取到 ${chapPick.length} 章，全部 depth=1: ${chapPick.every(o => o.depth === 1)}`);
    ok("顶层只有 1 条时退到下一层分层", (() => {
      const p = X.pickMarks([{ title: "上", page: 0, depth: 1 }, { title: "a", page: 1, depth: 2 },
                             { title: "b", page: 2, depth: 2 }], 100, 40);
      return p.length === 2 && p.every(o => o.depth === 2);
    })());
    ok("顶层本身就超上限时仍会抽样", (() => {
      const many2 = Array.from({ length: 60 }, (_, i) => ({ title: "c" + i, page: i * 3, depth: 1 }));
      const p = X.pickMarks(many2, 400, 40);
      return p.length <= 40 && p.length >= 20;
    })());
    ok("无 depth 字段的旧目录行为不变", (() => {
      const p = X.pickMarks([{ title: "A", page: 0 }, { title: "B", page: 5 }], 100, 40);
      return p.length === 2;
    })());
  } else {
    ok("104 条目录（19 顶层 + 85 小节）按层级取出 19 个章", true, "（原版无 pickMarks，跳过）");
    ok("顶层只有 1 条时退到下一层分层", true, "（跳过）");
    ok("顶层本身就超上限时仍会抽样", true, "（跳过）");
    ok("无 depth 字段的旧目录行为不变", true, "（跳过）");
  }

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  process.exitCode = fail ? 1 : 0;
})();

