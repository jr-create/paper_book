/* 浏览器探针（原版兼容版）：只测原版拥有的功能
   翻页（按钮/滚轮）、章带跳转、厚度守恒、渲染清晰度、章带可见性
   + 主题切换、AI 面板、PDF 端到端导入（合成 mini PDF → parsePdf → pdf.js 渲染） */
(async function(){
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

  /* 接线检查：parsePdf 已被补丁包裹、decodePageImage 有 pdfjs 分支 */
  R.wiring = {
    parsePdfPatched: typeof parsePdf === "function" && String(parsePdf).indexOf("pdfjsBoot") >= 0,
    decodePdfjs: !!(window.decodePageImage && window.decodePageImage.__pdfjsWrap),
    pdfjsRenderPage: typeof pdfjsRenderPage === "function"
  };

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

  /* ---------- 主题 ---------- */
  const tbtn = document.getElementById("btnTheme");
  R.theme = { hasBtn: !!tbtn };
  if (tbtn) {
    R.theme.label0 = tbtn.textContent;
    R.theme.attr0 = document.documentElement.dataset.bt || "orig";
    tbtn.click();
    R.theme.label1 = tbtn.textContent;
    R.theme.attr1 = document.documentElement.dataset.bt || "orig";
    tbtn.click(); tbtn.click(); tbtn.click();          // 转回原版
    R.theme.backTo = document.documentElement.dataset.bt || "orig";
    R.theme.cycleOk = R.theme.label0 !== R.theme.label1 && R.theme.backTo === "orig";
  }

  /* ---------- AI 面板 ---------- */
  const abtn = document.getElementById("btnAI"), apanel = document.getElementById("aiPanel");
  const aout = document.getElementById("aiOut"), albtn = document.getElementById("btnAiLocal");
  R.ai = { hasBtn: !!abtn && !!apanel };
  if (abtn && apanel && albtn) {
    abtn.click();
    R.ai.panelShown = apanel.style.display !== "none";
    albtn.click();
    const txt = aout.textContent || "";
    R.ai.statsReady = txt.indexOf("总字数") >= 0 && txt.indexOf("章") >= 0;
    abtn.click();                                      // 收起
  }

  /* ---------- 面板显隐 + 整体缩放 ---------- */
  const cbtn = document.getElementById("btnChrome");
  const zin = document.getElementById("btnZoomIn"), zout = document.getElementById("btnZoomOut");
  const chipEl = document.getElementById("chromeChip"), hudEl = document.getElementById("zoomHud");
  R.chrome = { hasBtn: !!cbtn };
  R.zoom = { hasBtns: !!zin && !!zout };
  if (cbtn && window.chromeState !== undefined) {
    cbtn.click();
    R.chrome.s1 = window.chromeState();                       // 1 = 隐藏侧栏
    R.chrome.sideGone = document.querySelector("aside.side").offsetHeight === 0;
    cbtn.click();
    R.chrome.s2 = window.chromeState();                       // 2 = 全部隐藏
    R.chrome.chipShown = chipEl.style.display === "block";
    chipEl.click();
    R.chrome.restored = window.chromeState() === 0;
  }
  if (zin && window.viewState) {
    zin.click(); zin.click();
    R.zoom.zAfter = +window.viewState().z.toFixed(4);         // 1.5625
    R.zoom.tfApplied = cv.style.transform.indexOf("scale(1.5") >= 0 ||
                       cv.style.transform.indexOf("scale(1.56") >= 0;
    R.zoom.backingGrew = cv.width > cv.parentElement.clientWidth * (window.devicePixelRatio||1);
    R.zoom.hudShown = hudEl.style.display === "block";
    try { settle(50); draw(); R.zoom.drawOk = true; } catch(e){ R.zoom.drawOk = false; }
    // Ctrl+滚轮：以光标为锚继续放大
    const z0 = window.viewState().z;
    cv.dispatchEvent(new WheelEvent("wheel", { deltaY:-120, ctrlKey:true, cancelable:true }));
    R.zoom.ctrlWheelZooms = window.viewState().z > z0;
    // 普通滚轮仍翻页
    settle(50); draw();
    cv.dispatchEvent(new WheelEvent("wheel", { deltaY:-120, cancelable:true }));
    R.zoom.plainWheelTurns = state.sheet > 50 && Math.abs(window.viewState().z - z0 - 0.12) < 0.5;
    // 双击回 1×
    cv.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    R.zoom.reset = window.viewState().z === 1;
    R.zoom.hudHidden = hudEl.style.display === "none";
  }

  /* ---------- PDF 端到端：合成 mini PDF → importFile → pdf.js 渲染 ---------- */
  function buildMiniPdf(){
    const objs = [];
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>";
    objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>";
    objs[4] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 6 0 R >> >> >>";
    objs[5] = { stream: "BT /F1 24 Tf 72 720 Td (Hello Book Probe) Tj ET" };
    objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    objs[7] = { stream: "BT /F1 24 Tf 72 720 Td (Page Two 123) Tj ET" };
    let out = "%PDF-1.4\n"; const off = [];
    for (let i = 1; i <= 7; i++){
      off[i] = out.length;
      const o = objs[i];
      if (typeof o === "object") out += i + " 0 obj\n<< /Length " + o.stream.length + " >>\nstream\n" + o.stream + "\nendstream\nendobj\n";
      else out += i + " 0 obj\n" + o + "\nendobj\n";
    }
    const xr = out.length;
    out += "xref\n0 8\n0000000000 65535 f \n";
    for (let i = 1; i <= 7; i++) out += String(off[i]).padStart(10, "0") + " 00000 n \n";
    out += "trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n" + xr + "\n%%EOF";
    const u8 = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) u8[i] = out.charCodeAt(i) & 0xff;
    return u8;
  }
  try {
    /* 虚拟时间快进下，pdf.js 的 blob worker 在独立线程跑真实计算，永远赶不上
       虚拟时钟（hasDoc 一直 false）。临时禁用 Worker 强制走主线程 fake worker，
       其任务受虚拟时间调度器约束 —— 只影响本探针，不影响真实浏览器。 */
    const _RealWorker = window.Worker;
    try { window.Worker = undefined; } catch(_){}
    try {
    const u8 = buildMiniPdf();
    await importFile(new File([u8], "probe.pdf"));
    R.pdfE2E = { source: book.source, chapters: book.chaps.length,
                 pages: book.pages, imgPages: book.imgPages ? book.imgPages.size : 0 };
    // 等第一页真正渲染进 IMG_CACHE
    let rendered = false, cacheErr = null;
    for (let t = 0; t < 120; t++){
      await new Promise(r => setTimeout(r, 100));
      for (const v of IMG_CACHE.values()){
        if (v && v.width) { rendered = true; break; }
        if (v && v.error && !cacheErr) cacheErr = v.error;
      }
      if (rendered) break;
    }
    R.pdfE2E.rendered = rendered;
    if (cacheErr) R.pdfE2E.cacheErr = cacheErr;
    if (typeof PDFJS !== "undefined") R.pdfE2E.hasDoc = !!(PDFJS.doc);
    // 放大后应按更高分辨率重渲染（清缓存 + 重画）
    if (window.viewZoomTo && book.imgPages && book.imgPages.size){
      window.viewZoomTo(1.5625);
      let hi = 0;
      for (let t = 0; t < 80; t++){
        await new Promise(r => setTimeout(r, 100));
        for (const v of IMG_CACHE.values())
          if (v && v.width) hi = Math.max(hi, Math.max(v.width, v.height));
        if (hi >= 1200) break;
      }
      R.pdfE2E.hiRes = hi;               // 期望 ≈ min(2000, 900×1.5625) = 1406
      if (window.viewReset) window.viewReset();
    }
    } finally { try { window.Worker = _RealWorker; } catch(_){} }
  } catch(e) {
    R.pdfE2E = { error: String(e && e.message || e) };
  }

  } catch(e){
    R.fatal = (e && e.stack) ? String(e.stack).split(/\r?\n/).slice(0,4).join(" | ") : String(e);
  }
  report();
})();
