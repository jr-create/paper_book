/* ============================================================================
 * 浏览器探针（无头 Chrome 用）
 *
 * 它和 index.html 的主程序处在同一个 realm：经典脚本的顶层 const/let/function
 * 都是全 realm 共享的绑定，所以这里可以直接读/调 state、GEO、hiPx、pageSliceHi...
 * ——不需要把任何东西挂到 window 上，也不需要改主程序。
 *
 * 只测量、不改行为；全部同步执行（无 await），避免 rAF 在两次测量之间插进来重画。
 * ========================================================================== */
(function(){
  const R = {};
  const cv = document.getElementById("cv");
  const g  = cv.getContext("2d");
  const dev = v => Math.round(v * DPR);

  /* ---- 像素统计：maxd = 相邻像素最大亮度跳变（锐利度）, glyphH = 字身高度 ---- */
  function stats(rx, ry, rw, rh){
    const x = Math.max(0, Math.min(cv.width  - 1, dev(rx)));
    const y = Math.max(0, Math.min(cv.height - 1, dev(ry)));
    const w = Math.max(1, Math.min(cv.width  - x, dev(rw)));
    const h = Math.max(1, Math.min(cv.height - y, dev(rh)));
    let d;
    try { d = g.getImageData(x, y, w, h); } catch(e){ return { err: String(e && e.message) }; }
    const p = d.data;
    let ink = 0, maxd = 0, best = 0, run = 0;
    for (let j = 0; j < h; j++){
      let rowInk = 0;
      for (let i = 0; i < w; i++){
        const o = (j*w + i)*4;
        const l  = p[o]*0.299 + p[o+1]*0.587 + p[o+2]*0.114;
        if (l < 120){ ink++; rowInk++; }
        if (i + 1 < w){
          const o2 = o + 4;
          const l2 = p[o2]*0.299 + p[o2+1]*0.587 + p[o2+2]*0.114;
          const dd = Math.abs(l - l2);
          if (dd > maxd) maxd = dd;
        }
      }
      if (rowInk > 0){ run++; if (run > best) best = run; } else run = 0;
    }
    return { win: w+"×"+h, ink, inkFrac: +(ink/(w*h)).toFixed(4),
             maxd: +maxd.toFixed(1), glyphH: best };
  }
  const rectOf = el => { const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; };

  /* ---- 渲染路径计数：顶层 function 声明是 window 属性，替换它就等于插桩 ---- */
  let sliceHits = 0, fullHits = 0;
  const _slice = window.pageSliceHi, _full = window.pageFullHi;
  if (_slice) window.pageSliceHi = function(){ sliceHits++; return _slice.apply(null, arguments); };
  if (_full)  window.pageFullHi  = function(){ fullHits++;  return _full.apply(null, arguments); };
  R.instrumented = !!(_slice && _full);

  /* ---- 把画面稳定在一页正文上（清掉动画/悬停的干扰） ---- */
  function settle(sheet){
    state.mode = "thickness";
    state.demo = null; state.turn = null; state.fling = null; state.drag = null;
    state.hover = null; state.fan.bands = 0; state.fan.spread = 0; state.pan = null;
    state.sheetF = sheet; state.sheet = sheet;
  }
  /* 把右页（recto）的页面中心推到视口中心 —— 放大后要读的就是这一块 */
  function focusRecto(){
    const sceneCenter = (rectoX() - GEO.blockX) + GEO.pageW/2;   // recto 中心（场景坐标）
    const wantBlockX  = W/2 - sceneCenter;
    state.panX += wantBlockX - GEO.blockX;
    applyView(); updateStacks();
    return { blockX: +GEO.blockX.toFixed(1), wantBlockX: +wantBlockX.toFixed(1),
             rectoCx: +(rectoX() + GEO.pageW/2).toFixed(1), W: W };
  }
  /* 正文区域：按「页面局部坐标」取窗，再映射到屏幕并与画布求交 */
  const LB = { x0:0.22, x1:0.72, y0:0.18, y1:0.58 };
  function bodyBand(){
    const rx = rectoX();
    const bx = rx + GEO.pageW*LB.x0, by = GEO.pageY + GEO.pageH*LB.y0;
    const bw = GEO.pageW*(LB.x1-LB.x0), bh = GEO.pageH*(LB.y1-LB.y0);
    const ix = Math.max(bx, 0), iy = Math.max(by, 0);
    const iw = Math.min(bx+bw, W) - ix, ih = Math.min(by+bh, H) - iy;
    if (iw <= 2 || ih <= 2) return null;
    return stats(ix, iy, iw, ih);
  }
  const rectoIdx = () => clamp(state.sheet*2 + 1, 0, book.pages - 1);

  /* =================== A. 面板隐藏（真实 CSS 网格） =================== */
  const app = document.getElementById("app");
  const head = document.querySelector("header.top");
  const aside = document.querySelector("aside.side");
  const cs = el => getComputedStyle(el);

  setPanel("top", true); setPanel("side", true);
  R.panels = { base: { cv: { w: cv.clientWidth, h: cv.clientHeight },
                       header: rectOf(head), aside: rectOf(aside),
                       rows: cs(app).gridTemplateRows, cols: cs(app).gridTemplateColumns,
                       headerDisplay: cs(head).display, asideDisplay: cs(aside).display,
                       fitPageW: +GEO.fitPageW.toFixed(1), pageY: +GEO.pageY.toFixed(1) } };
  setPanel("top", false);
  R.panels.noTop = { cv: { w: cv.clientWidth, h: cv.clientHeight },
                     headerH: rectOf(head).h, headerDisplay: cs(head).display,
                     rows: cs(app).gridTemplateRows,
                     pageY: +GEO.pageY.toFixed(1), sceneH: +GEO.sceneH.toFixed(1) };
  setPanel("top", true); setPanel("side", false);
  R.panels.noSide = { cv: { w: cv.clientWidth, h: cv.clientHeight },
                      asideW: rectOf(aside).w, asideDisplay: cs(aside).display,
                      cols: cs(app).gridTemplateColumns,
                      fitPageW: +GEO.fitPageW.toFixed(1) };
  setPanel("side", true); setPanel("top", false);
  R.panels.noTopOnly = { cv: { w: cv.clientWidth, h: cv.clientHeight } };
  setPanel("side", false);
  R.panels.none = { cv: { w: cv.clientWidth, h: cv.clientHeight },
                    win: { w: innerWidth, h: innerHeight },
                    rows: cs(app).gridTemplateRows, cols: cs(app).gridTemplateColumns };
  setPanel("top", true); setPanel("side", true);
  R.panels.restored = { cv: { w: cv.clientWidth, h: cv.clientHeight },
                        headerH: rectOf(head).h, asideW: rectOf(aside).w,
                        fitPageW: +GEO.fitPageW.toFixed(1) };

  /* ---- 悬浮控件：必须可见、可点中（顶栏能隐藏，所以它是唯一的入口） ---- */
  const fb = document.getElementById("floatbar");
  const fr = fb.getBoundingClientRect();
  const bIn = document.getElementById("btnZoomIn").getBoundingClientRect();
  const hitEl = document.elementFromPoint(bIn.left + bIn.width/2, bIn.top + bIn.height/2);
  R.floatbar = { rect: rectOf(fb), opacity: cs(fb).opacity, z: cs(fb).zIndex,
                 hitTag: hitEl ? (hitEl.id || hitEl.tagName) : null,
                 inView: fr.left >= 0 && fr.top >= 0 && fr.right <= innerWidth && fr.bottom <= innerHeight };

  /* ---- 真按钮：点一下「＋」必须真的放大 ---- */
  const z0 = state.zoom;
  document.getElementById("btnZoomIn").click();
  R.btnZoom = { from: z0, to: state.zoom, pctText: document.getElementById("btnZoomFit").textContent };
  resetView();

  /* =================== B. 放大后的渲染：清晰度 =================== */
  settle(20); resetView(); draw();
  const geo1 = { zoom: state.zoom, pageW: +GEO.pageW.toFixed(1), pageH: +GEO.pageH.toFixed(1),
                 Tstack: +GEO.Tstack.toFixed(1), sheet: state.sheet, canPan: canPan(),
                 hiPx: Math.round(hiPx) };
  R.zoom1 = { geo: geo1, band: bodyBand(), fullHits, sliceHits };
  const loRef = pageCanvas(rectoIdx());        // 1× 低清位图（对照组用）

  sliceHits = 0; fullHits = 0;
  zoomPreset(3);
  settle(20);
  const foc = focusRecto();
  draw();                                  // 同步画，紧接着同步读像素
  const geo3 = { zoom: state.zoom, pageW: +GEO.pageW.toFixed(1), pageH: +GEO.pageH.toFixed(1),
                 Tstack: +GEO.Tstack.toFixed(1), sheet: state.sheet, canPan: canPan(),
                 sceneW: +GEO.sceneW.toFixed(1), hiPx: Math.round(hiPx) };
  const band3 = bodyBand();
  R.zoom3 = { geo: geo3, focus: foc, band: band3, fullHits, sliceHits,
              cache: { n: HICACHE.size }, pageAt3: { dw: Math.round(GEO.pageW*DPR), dh: Math.round(GEO.pageH*DPR) } };

  /* ---- 对照组：把 1/6 尺寸的极低清位图放大画到 3× 页面——一定糊 ---- */
  const rx3 = rectoX();
  const lo = document.createElement("canvas");
  lo.width = Math.round(GEO.pageW / 6); lo.height = Math.round(GEO.pageH / 6);
  const lg = lo.getContext("2d");
  lg.scale(1 / 6, 1 / 6);
  paintPage(lg, rectoIdx(), GEO.pageW, GEO.pageH);
  g.save(); g.beginPath(); g.rect(rx3, GEO.pageY, GEO.pageW, GEO.pageH); g.clip();
  g.imageSmoothingEnabled = true;
  g.drawImage(lo, rx3, GEO.pageY, GEO.pageW, GEO.pageH);
  g.restore();
  R.blur3 = { band: bodyBand() };

  /* ---- 切片缓存不许随放大大下去 ---- */
  zoomPreset(5); settle(20); focusRecto(); draw();
  R.zoom5 = { pageW: +GEO.pageW.toFixed(1), pageH: +GEO.pageH.toFixed(1),
              wholePagePx: Math.round(GEO.pageW*DPR) * Math.round(GEO.pageH*DPR),
              band: bodyBand(), hiPx: Math.round(hiPx), fullHits, sliceHits };

  /* ---- 缩回 1× 应当回到原样（幂等） ---- */
  resetView(); settle(20); draw();
  R.back1 = { zoom: state.zoom, pageW: +GEO.pageW.toFixed(1), pageY: +GEO.pageY.toFixed(1),
              blockX: +GEO.blockX.toFixed(1), panX: state.panX, panY: state.panY,
              band: bodyBand() };

  /* =================== C. 回归：drawPageAt 的分派（我改过这里） =================== */
  R.accept = document.getElementById("file").accept;
  R.env = { dpr: DPR, win: innerWidth + "×" + innerHeight, canvasPx: cv.width + "×" + cv.height };

  let imgCalls = 0;
  const _img = window.drawImagePage;
  if (_img) window.drawImagePage = function(idx){ imgCalls++; return _img.apply(null, arguments); };

  // 造两个「图像页」（内容不重要，只看分派）：一个在右页（可见），一个在左页
  const li = clamp(state.sheet*2, 0, book.pages-1), ri = rectoIdx();
  const fake = { kind: "jpeg", width: 60, height: 80, bytes: new Uint8Array([0xFF,0xD8,0xFF,0xD9]) };
  const hadL = book.imgPages.has(li), hadR = book.imgPages.has(ri);
  const oldL = book.imgPages.get(li), oldR = book.imgPages.get(ri);
  book.imgPages.set(li, fake); book.imgPages.set(ri, fake);

  resetView(); settle(20);
  imgCalls = 0; draw();
  R.imgAt1x = { callsRight: imgCalls, note: "1× 两页都在视口内，应各画一次" };

  zoomPreset(3); settle(20); focusRecto();
  imgCalls = 0; draw();
  R.imgAt3x = { callsRight: imgCalls, leftOnScreen: (GEO.pageX + GEO.pageW > 0),
                note: "3× 时左页被推到屏幕外，应只剩右页被画" };

  // 还原，别污染后面的状态
  const restoreImg = () => {
    if (hadL) book.imgPages.set(li, oldL); else book.imgPages.delete(li);
    if (hadR) book.imgPages.set(ri, oldR); else book.imgPages.delete(ri);
  };
  restoreImg(); resetView();

  console.log("PROBEJSON " + JSON.stringify(R));
})();
