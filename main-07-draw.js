/* --------------------- 高清缓存与页面绘制分派 --------------------- */
const HICACHE = new Map();
let hiPx = 0;
function pageCanvas(idx) {
  const tw = Math.max(1, Math.round(GEO.pageW * GEO.DPR));
  const th = Math.max(1, Math.round(GEO.pageH * GEO.DPR));
  const key = "p" + idx + "@" + tw + "x" + th;          // 缓存按目标尺寸：放大后旧 1× 位图不再命中
  let c = HICACHE.get(key);
  if (!c) {
    // 换尺寸时清掉同页旧缓存，避免像素预算被旧尺寸占着
    for (const k of [...HICACHE.keys()]) if (k.startsWith("p" + idx + "@")) {
      const old = HICACHE.get(k); hiPx -= old.width * old.height; HICACHE.delete(k);
    }
    c = document.createElement("canvas");
    c.width = tw; c.height = th;
    const g = c.getContext("2d");
    g.scale(GEO.DPR, GEO.DPR);
    paintPage(g, idx, GEO.pageW, GEO.pageH);
    if (tw * th <= HI_MAX_PX) {
      HICACHE.set(key, c); hiPx += tw * th;
      while (hiPx > HICACHE_PX && HICACHE.size > 1) {
        const k = HICACHE.keys().next().value, v = HICACHE.get(k);
        hiPx -= v.width * v.height; HICACHE.delete(k);
      }
    }
  }
  return c;
}
function pageFullHi(idx) { return pageCanvas(idx); }
/* 契约：pageSliceHi(idx, x, y, w, h, dw, dh) 返回 {x,y,w,h,c}，
   切片只覆盖视口（w/h ≤ 视口），设备像素 ≤ 视口×DPR */
function pageSliceHi(idx, x, y, w, h, dw, dh) {
  // 切片必须与视口求交：切片尺寸不随放大大下去（契约：≤ 视口 CSS 尺寸）
  const ix = Math.max(0, x), iy = Math.max(0, y);
  const iw = Math.max(1, Math.min(x + w, GEO.W) - ix);
  const ih = Math.max(1, Math.min(y + h, GEO.H) - iy);
  const R = snapRect(ix, iy, iw, ih);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(R.w * GEO.DPR));
  c.height = Math.max(1, Math.round(R.h * GEO.DPR));
  const g = c.getContext("2d");
  g.scale(GEO.DPR, GEO.DPR);
  g.translate(-R.x, -R.y);
  paintPage(g, idx, GEO.pageW, GEO.pageH);
  return { x: R.x, y: R.y, w: R.w, h: R.h, c };
}
function drawPageAt(idx, x, y, w, h) {
  // 视口外跳过（契约：3× 时左页被推出视口 → 只画右页；对图像页同样生效）
  if (x + w <= 0 || x >= GEO.W) return;
  if (book.imgPages && book.imgPages.has(idx)) { drawImagePage(idx, x, y, w, h); return; }
  const R = snapRect(x, y, w, h);
  const need = R.w * GEO.DPR * R.h * GEO.DPR;
  if (need > HI_MAX_PX) {
    const sl = pageSliceHi(idx, R.x, R.y, R.w, R.h);
    ctx.drawImage(sl.c, sl.x, sl.y, sl.w, sl.h);
  } else {
    ctx.drawImage(pageFullHi(idx), R.x, R.y, R.w, R.h);
  }
}

/* --------------------- 书脊 / 纸叠 / 章带 --------------------- */
function drawSpine() {
  const g = ctx.createLinearGradient(GEO.pageX + GEO.pageW - GEO.gutter * 0.5, 0, GEO.pageX + GEO.pageW + GEO.gutter * 1.1, 0);
  g.addColorStop(0, "rgba(60,50,38,.30)");
  g.addColorStop(0.5, "rgba(60,50,38,.10)");
  g.addColorStop(1, "rgba(60,50,38,.26)");
  ctx.fillStyle = g;
  ctx.fillRect(GEO.pageX + GEO.pageW - GEO.gutter * 0.5, GEO.pageY, GEO.gutter * 1.6, GEO.pageH);
}
/* 纸叠：页面外侧的「已读/未读」纸堆——层状线条 + 侧边渐变，纸的厚度感 */
function drawStack(x, y, w, h, isRead) {
  if (w < 0.5) return;
  const g = ctx;
  g.save();
  // 纸叠基底
  const grad = g.createLinearGradient(x, 0, x + w, 0);
  if (isRead) { grad.addColorStop(0, "#f4ecd9"); grad.addColorStop(1, "#c9bda0"); }
  else        { grad.addColorStop(0, "#cfc4a8"); grad.addColorStop(1, "#f4ecd9"); }
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  // 层状纸页线
  g.fillStyle = "rgba(120,105,80,.22)";
  const n = clamp(Math.round(w / 2.2), 6, 46);
  for (let i = 1; i < n; i++) {
    const xx = x + w * i / n;
    g.fillRect(xx, y + 2, 0.7, h - 4);
  }
  // 外缘阴影
  const edge = g.createLinearGradient(isRead ? x : x + w - 3, 0, isRead ? x + 3 : x + w, 0);
  edge.addColorStop(0, "rgba(60,50,38,.25)");
  edge.addColorStop(1, "rgba(60,50,38,0)");
  g.fillStyle = edge;
  g.fillRect(isRead ? x : x + w - 3, y, 3, h);
  g.restore();
}
function drawFan() {
  if (!book.chaps.length) return;
  // 章带画在纸叠侧缘内（宽度与纸叠一致，避免伸出纸叠外的色块）
  const w = Math.max(3, Math.min(GEO.leftWBase, GEO.rightWBase) - 2);
  const cur = bandAt(GEO.pageX - 1, GEO.pageY + GEO.pageH / 2);
  book.chaps.forEach((C, i) => {
    const y0 = GEO.pageY + GEO.pageH * (C.start / Math.max(1, book.pages));
    const y1 = GEO.pageY + GEO.pageH * ((C.start + C.pages) / Math.max(1, book.pages));
    // 已读章在左书口，未读章在右书口（与 stackX 同一几何）
    const readSide = (C.start + C.pages) <= state.sheetF * 2 + 1;
    const x = readSide ? GEO.pageX - w : rectoRight() + 2;
    ctx.fillStyle = (cur && i === cur.chapter) ? "rgba(224,180,106,.95)"
      : (i % 2 ? "rgba(160,138,100,.75)" : "rgba(190,166,120,.75)");
    ctx.fillRect(x, y0 + 0.5, w - 1, Math.max(1, y1 - y0 - 1));
  });
  state.fan.bands = book.chaps.length;
}
function drawBoardEdges() {
  const g = ctx;
  g.save();
  g.strokeStyle = "rgba(70,60,45,.4)"; g.lineWidth = 1;
  g.strokeRect(GEO.pageX + 0.5, GEO.pageY + 0.5, GEO.pageW - 1, GEO.pageH - 1);
  g.strokeRect(rectoX() + 0.5, GEO.pageY + 0.5, GEO.pageW - 1, GEO.pageH - 1);
  g.restore();
}

/* --------------------- 主绘制 --------------------- */
function draw() {
  const g = ctx;
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvasEl.width, canvasEl.height);
  g.save();
  g.scale(GEO.DPR, GEO.DPR);
  // 深色阅读桌面背景（原版样式）
  const desk = g.createRadialGradient(GEO.W / 2, GEO.H / 2, GEO.H * 0.2, GEO.W / 2, GEO.H / 2, GEO.W * 0.75);
  desk.addColorStop(0, "#3a3227");
  desk.addColorStop(1, "#241f18");
  g.fillStyle = desk;
  g.fillRect(0, 0, GEO.W, GEO.H);
  const leftIdx = clamp(state.sheet * 2, 0, Math.max(0, book.pages - 1));
  const rightIdx = clamp(state.sheet * 2 + 1, 0, Math.max(0, book.pages - 1));
  // 桌面上的书投影
  g.save();
  g.shadowColor = "rgba(0,0,0,.5)"; g.shadowBlur = 26; g.shadowOffsetY = 10;
  g.fillStyle = "#f7f2e7";
  g.fillRect(GEO.pageX - 2, GEO.pageY - 2, GEO.pageW + GEO.gutter + GEO.pageW + 4, GEO.pageH + 4);
  g.restore();
  // 左右纸叠（在页面下方一层）
  drawStack(GEO.blockX, GEO.pageY, GEO.leftW, GEO.pageH, true);
  drawStack(rectoRight() + 2, GEO.pageY, GEO.rightW, GEO.pageH, false);
  // 双页
  drawPageAt(leftIdx, GEO.pageX, GEO.pageY, GEO.pageW, GEO.pageH);
  drawPageAt(rightIdx, rectoX(), GEO.pageY, GEO.pageW, GEO.pageH);
  drawSpine();
  drawBoardEdges();
  drawFan();
  g.restore();
}
function drawCurve() {
  const el = document.getElementById("curve");
  if (!el || !el.getContext) return;
  const g = el.getContext("2d");
  g.clearRect(0, 0, el.width, el.height);
  // 网格底
  g.strokeStyle = "rgba(255,255,255,.06)"; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo(0, el.height * i / 4); g.lineTo(el.width, el.height * i / 4); g.stroke();
  }
  // 增益曲线：慢速精确、快速粗略
  const grad = g.createLinearGradient(0, 0, el.width, 0);
  grad.addColorStop(0, "#e0b46a");
  grad.addColorStop(1, "#c4893a");
  g.strokeStyle = grad; g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const gain = gainFor(t * 900, 0);
    const x = t * el.width, y = el.height - gain / GAIN_COARSE * el.height * 0.86 - 2;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}
function updateHUD() {
  const tot = Math.max(1, book.sheets);
  const cur = clamp(Math.round(state.sheetF), 0, tot);
  const el = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  el("pSheet", (cur + 1) + " / " + tot);
  el("pPage", (clamp(state.sheet * 2 + 1, 1, book.pages)) + " / " + book.pages);
  el("pPct", Math.round(cur / tot * 100) + "%");
  el("pChap", (book.chaps[chapterOf(clamp(state.sheet * 2, 0, book.pages - 1))] || {}).t || "");
  el("zPct", Math.round((state.zoom || 1) * 100) + "%");
  el("mmL", (book.pages * MM_PER_PG * (cur / tot)).toFixed(1) + "mm");
  el("mmR", (book.pages * MM_PER_PG * (1 - cur / tot)).toFixed(1) + "mm");
  const gl = $("gGain"); if (gl) gl.textContent = gainFor(0, 0).toFixed(3);
}
function refreshTitle() {
  const t = $("docTitle");
  if (t) t.textContent = "《" + book.title + "》· " + book.chaps.length + " 章 / " + book.pages + " 页";
}
function buildCmap() {
  const el = $("cmap");
  if (!el || !el.appendChild) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  book.chaps.forEach((c, i) => {
    const d = document.createElement("div");
    d.className = "band";
    d.style.top = (c.start / Math.max(1, book.pages) * 100) + "%";
    d.style.height = (c.pages / Math.max(1, book.pages) * 100) + "%";
    d.title = c.t;
    el.appendChild(d);
  });
}
