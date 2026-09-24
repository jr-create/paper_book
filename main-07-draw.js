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
function drawStack(x, y, w, h, isRead) {
  const g = ctx;
  g.save();
  g.fillStyle = isRead ? "#e8dfc9" : "#f2ebd9";
  g.fillRect(x, y, w, h);
  g.fillStyle = "rgba(90,80,64,.15)";
  const n = Math.max(8, Math.min(60, book.pages));
  const step = h / n;
  for (let i = 1; i < n; i++) g.fillRect(x, y + i * step, w, 0.6);
  g.restore();
}
function drawFan() {
  if (!book.chaps.length) return;
  const w = Math.max(3, GEO.leftWBase * 0.9);
  const cur = bandAt(GEO.pageX - 1, GEO.pageY + GEO.pageH / 2);
  book.chaps.forEach((C, i) => {
    const y0 = GEO.pageY + GEO.pageH * (C.start / Math.max(1, book.pages));
    const y1 = GEO.pageY + GEO.pageH * ((C.start + C.pages) / Math.max(1, book.pages));
    // 已读章在左书口，未读章在右书口
    const readSide = (C.start + C.pages) <= state.sheetF * 2 + 1;
    const x = readSide ? GEO.pageX - w : rectoX();
    ctx.fillStyle = (cur && i === cur.chapter) ? "rgba(196,164,108,.95)"
      : (i % 2 ? "rgba(120,105,80,.55)" : "rgba(150,132,100,.55)");
    ctx.fillRect(x, y0 + 0.5, w, Math.max(1, y1 - y0 - 1));
  });
  state.fan.bands = book.chaps.length;
}
function drawBoardEdges() {
  const g = ctx;
  g.save();
  g.strokeStyle = "rgba(70,60,45,.35)"; g.lineWidth = 1;
  g.strokeRect(GEO.pageX, GEO.pageY, GEO.pageW, GEO.pageH);
  g.strokeRect(rectoX(), GEO.pageY, GEO.pageW, GEO.pageH);
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
  g.fillStyle = "#d8d0bd"; g.fillRect(0, 0, GEO.W, GEO.H);
  const leftIdx = clamp(state.sheet * 2, 0, Math.max(0, book.pages - 1));
  const rightIdx = clamp(state.sheet * 2 + 1, 0, Math.max(0, book.pages - 1));
  drawStack(GEO.blockX, GEO.pageY, GEO.leftW, GEO.pageH, true);
  drawStack(rectoRight() + 2, GEO.pageY, GEO.rightW, GEO.pageH, false);
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
  g.strokeStyle = "rgba(90,80,64,.5)"; g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const gain = gainFor(t * DIST_CAP, 0);
    const x = t * el.width, y = el.height - gain / GAIN_COARSE * el.height * 0.9;
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
