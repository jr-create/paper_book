"use strict";
/* =========================================================================
   书口 · 纸质书厚度感阅读器（双页跨页版）
   -------------------------------------------------------------------------
   本块曾在 PDF 原版渲染改造中因脚本错误丢失，现依据三套回归测试
   （test-logic.js 166 条 / browser-test.js 23 条 / pdf-test.js 64 条）
   固化的行为契约重建。每个常量、每个函数签名都以测试断言为准。
   ========================================================================= */

/* ---------------------------- 常量（契约值） ---------------------------- */
const LINES = 15;                 // 每页正文行数（test: 总行数 = 320×15）
const CHARS = 24;                 // 每行全角字数预算
const OPEN_LINES = 6;             // 章首页顶部留白（放章标题）
const HEAD_SCALE = 1.6;           // 章节标题相对正文的字号倍数
const MM_PER_PG = 0.074;          // 每页物理厚度（mm）
const GAIN_FINE = 0.05;           // 增益（张/px）：静止时（test: 静止 → 精确档）
const GAIN_COARSE = 2.2;          // 增益：极速时（test: 极速 → 扇动档）
const BLEND_DIST = 120;           // 距离增益混合区（px）
const BLEND_VEL = 0.9;
const DIST_CAP = 0.25;            // 距离项在增益差里的最大占比（test: 距离单独贡献 FINE+(C-F)*DIST_CAP）
const LINEAR_PX_PER_SHEET = 3.2;
const ZOOM_MIN = 0.5, ZOOM_MAX = 6, ZOOM_STEP = 1.25;
const HI_MAX_PX = 6e6;            // 单页整页位图上限（test: 3× 时整页位图 > 6M px）
const HICACHE_PX = 18e6;
const IMG_W_MIN = 800, IMG_W_MAX = 2400, IMG_PIX_BUDGET = 26e6;
const FIG_LINES = 8;              // 正文插图占行数（test: img 块 → FIG_LINES 行）

/* ---------------------------- 状态 ---------------------------- */
const state = {
  mode: "thickness",
  sheet: 0, sheetF: 0,
  turn: null, drag: null, fling: null, hover: null,
  pan: null, panX: 0, panY: 0,
  zoom: 1,
  demo: null,
  fan: { bands: 0, spread: 0 },
  _tap: null, pinch: null
};
const book = {
  title: "书口", source: "示例",
  lines: [], chaps: [],
  imgPages: new Map(),
  pages: 0, sheets: 0,
  demo: true
};
const GEO = {
  W: 1200, H: 800, DPR: 1,
  blockX: 0, pageX: 0, pageY: 0, pageW: 0, pageH: 0,
  gutter: 0, spineX: 0, Tstack: 0,
  leftW: 0, rightW: 0,
  rightWBase: 0,                    // 右书口可用宽度
  leftWBase: 0,
  fitPageW: 0,
  sceneW: 0, sceneH: 0,
  rightWTotal: 0
};
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function $(id) {
  const e = document.getElementById(id);
  return e || { style: {}, textContent: "", className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) };
}

/* --------------------- 分页：章界落在跨页边界 --------------------- */
function paginate(chapters) {
  clearPageCache();
  if (typeof FIG_DESC !== "undefined") FIG_DESC.clear();
  _metaCache.clear();
  const lines = [], out = [];
  book.imgPages = new Map();
  let page = 0;
  for (const c of chapters) {
    const start = page;
    if (c.imgPages && c.imgPages.length) {          // 图像页（扫描件 / PDF 原版渲染）
      const n = c.imgPages.length;
      for (let i = 0; i < n; i++) book.imgPages.set(start + i, c.imgPages[i]);
      for (let i = 0; i < n * LINES; i++) lines.push({ runs: [], blank: true });
      out.push({ t: c.t, p: c.p || "", start, pages: n, img: true });
      page += n;
      continue;
    }
    const cl = [];
    for (let i = 0; i < OPEN_LINES; i++) cl.push({ runs: [], blank: true });
    const blocks = c.blocks || (c.paragraphs || []).map(t => ({ type: "p", runs: [{ t }] }));
    for (const blk of blocks) {
      const ls = blockToLines(blk);
      if (!ls.length) continue;
      if (blk.type === "img") {
        // 插图不能被页界切开：放不下就整块推到下一页
        const used = cl.length % LINES;
        if (used > 0 && LINES - used < FIG_LINES) {
          for (let i = 0; i < LINES - used; i++) cl.push({ runs: [], blank: true });
        }
        if (cl.length && !cl[cl.length - 1].blank) cl.push({ runs: [], blank: true });
        for (const l of ls) cl.push(l);
        cl.push({ runs: [], blank: true });
        continue;
      }
      if (blk.type === "code") {
        if (cl.length && !cl[cl.length - 1].blank) cl.push({ runs: [], blank: true });
        for (const l of ls) cl.push(l);
        cl.push({ runs: [], blank: true });
      } else {
        for (const l of ls) cl.push(l);
        if (blk.type !== "hr") cl.push({ runs: [], blank: true });
      }
    }
    let pages = Math.ceil(cl.length / LINES);
    if (pages % 2) pages++;
    if (pages < 2) pages = 2;
    while (cl.length < pages * LINES) cl.push({ runs: [], blank: true });
    for (const l of cl) lines.push(l);
    out.push({ t: c.t, p: c.p || "", start, pages });
    page += pages;
  }
  if (!out.length) { out.push({ t: "正文", p: "", start: 0, pages: 2 }); lines.push({ runs: [], blank: true }); }
  if (page % 2) {                                   // 总页数必须为偶数
    for (let i = 0; i < LINES; i++) lines.push({ runs: [], blank: true });
    out[out.length - 1].pages += 1;
    page += 1;
  }
  book.lines = lines; book.chaps = out;
  book.pages = page; book.sheets = page / 2;
}
const chapterOf = page => {
  for (let c = book.chaps.length - 1; c >= 0; c--) if (page >= book.chaps[c].start) return c;
  return 0;
};
/* pageMeta 幂等：同一页返回同一对象（缓存） */
const _metaCache = new Map();
function pageMeta(idx) {
  let m = _metaCache.get(idx);
  if (m) return m;
  const ch = chapterOf(idx), C = book.chaps[ch] || { start: 0, pages: 1, t: "", img: false };
  m = { ch, t: C.t, p: C.p || "", opening: idx === C.start, img: !!C.img,
        last: idx === C.start + C.pages - 1 };
  _metaCache.set(idx, m);
  return m;
}
