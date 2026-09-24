/* 浏览器探针（原版兼容版）：只测原版拥有的功能
   翻页（按钮/滚轮）、章带跳转、厚度守恒、渲染清晰度、章带可见性 */
(function(){
  let R = {};
  function report(){
    try { console.log("PROBEJSON " + JSON.stringify(R)); }
    catch(e){ console.log("PROBEJSON " + JSON.stringify({ fatal: "stringify: " + String(e) })); }
  }
  try {
  const cv = document.getElementById("cv");
  const g = cv.getContext("2d");
  const dev = v => Math.round(v * DPR);
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
  function settle(sheet){
    state.mode = "thickness";
    state.demo = null; state.turn = null; state.fling = null; state.drag = null;
    state.hover = null; state.fan.spread = 0;
    state.sheetF = sheet; state.sheet = sheet;
  }
  const rectoIdx = () => clamp(state.sheet*2 + 1, 0, Math.max(0, book.pages - 1));
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
  R.env = { dpr: DPR, win: innerWidth + "×" + innerHeight, canvasPx: cv.width + "×" + cv.height };

  /* 翻页：按钮 */
  const prev = document.getElementById("btnPrev"), next = document.getElementById("btnNext");
  settle(50); draw();
  if (prev) { prev.onclick(); R.prevWorks = state.sheet === 49; }
  if (next) { next.onclick(); R.nextWorks1 = state.sheet === 50; next.onclick(); R.nextWorks2 = state.sheet === 51; }
  settle(50); turnSheet(1); R.turnSheet = state.sheet === 51;

  /* 滚轮翻页 */
  settle(50); draw();
  cv.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, cancelable: true }));
  R.wheelFwd = state.sheet > 50;
  cv.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true }));
  R.wheelBack = state.sheet < 51;

  /* 厚度守恒 */
  settle(0); layout(); draw();
  R.thick0 = { left: +GEO.leftW.toFixed(2), right: +GEO.rightW.toFixed(2), T: +GEO.Tstack.toFixed(2) };
  settle(159); layout(); draw();
  R.thick159 = { left: +GEO.leftW.toFixed(2), right: +GEO.rightW.toFixed(2), T: +GEO.Tstack.toFixed(2) };
  R.conserved = Math.abs((GEO.leftW + GEO.rightW) - GEO.Tstack) < 1e-6;

  /* 1× 正文清晰度 */
  settle(50); draw();
  R.band1 = bodyBand();

  /* 点章带跳章（开头位置：未读书口在右侧，包含第 2 章） */
  settle(0); layout(); draw();
  const target = 1;
  const cs = book.chaps[target].start;
  const x = stackX(cs + 1, false);
  const b = bandAt(x, GEO.pageY + GEO.pageH * 0.5);
  R.bandAt = { expected: target, got: b ? b.chapter : null, ok: !!(b && b.chapter === target) };
  if (b && b.chapter === target) { jumpToChapter(b.chapter); }
  R.jump = { sheet: state.sheet, want: Math.round(book.chaps[target].start / 2),
             ok: state.sheet === Math.round(book.chaps[target].start / 2) };

  /* 章带可见性：右书口区域应有章带像素 */
  settle(0); layout(); draw();
  const bandProbe = stats(rectoRight() + 4, GEO.pageY + GEO.pageH * 0.5, 30, 40);
  R.bandVisible = bandProbe;

  /* 文件选择器 */
  R.accept = document.getElementById("file").accept;
  } catch(e){
    R.fatal = (e && e.stack) ? String(e.stack).split(/\r?\n/).slice(0,4).join(" | ") : String(e);
  }
  report();
})();
