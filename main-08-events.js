/* --------------------- 交互：翻页 / 缩放 / 平移 / 面板 --------------------- */
function canPan() { return GEO.sceneW > GEO.W + 1 || GEO.sceneH > GEO.H + 1; }
function applyView() {
  // 平移夹紧：拖不出书外空白；越界量写回（不累积）
  const maxX = Math.max(0, (GEO.sceneW - GEO.W) / 2);
  const maxY = Math.max(0, (GEO.sceneH - GEO.H) / 2);
  state.panX = clamp(state.panX, -maxX, maxX);
  state.panY = clamp(state.panY, -maxY, maxY);
  layout();
}
function applyZoom(z) {
  state.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
  if (!canPan()) { state.panX = 0; state.panY = 0; }
  layout(); applyView();
}
/* 锚点缩放：光标下的内容点钉住不动
   u = (ax - blockX0)/z0；缩放后 blockX1 = ax - u*z1（其余部分是平移的重算） */
function zoomTo(z, ax, ay) {
  const z0 = state.zoom;
  const bx0 = GEO.blockX, by0 = GEO.pageY;
  applyZoom(z);
  const z1 = state.zoom;
  if (ax !== undefined && z1 !== z0) {
    const u = (ax - bx0) / z0, v = (ay - by0) / z0;
    // 期望 blockX1 = ax - u*z1；blockX1 = (W-sceneW1)/2 + panX1
    // sceneW1 里 blockX 不出现，故 panX1 = (ax - u*z1) - (W-sceneW1)/2
    // 但 GEO 里 sceneW/2 项在 layout 已算入 blockX（pan=0 时）。
    // blockX1(pan=0) = base1；要 blockX1 = base1 + panX1 → panX1 = ax - u*z1 - base1
    const base1 = (GEO.W - GEO.sceneW) / 2, base1y = (GEO.H - GEO.sceneH) / 2;
    state.panX = (ax - u * z1) - base1;
    state.panY = (ay - v * z1) - base1y;
    applyView();
  }
  zoomHUD();
}
function zoomPreset(z) { applyZoom(z); zoomHUD(); }
function resetView() {
  state.zoom = 1; state.panX = 0; state.panY = 0;
  layout(); zoomHUD();
}
function zoomHUD() {
  const z = $("zRange"); if (z && z.value !== undefined) z.value = String(state.zoom);
  // 契约：点「＋」后读数同步更新（btnZoomFit 显示当前百分比）
  const zf = $("btnZoomFit"); if (zf) zf.textContent = Math.round((state.zoom || 1) * 100) + "%";
  updateHUD();
}
function setPanel(which, on) {
  const app = $("app");
  if (!app || !app.classList) return;
  const cls = which === "top" ? "notop" : "noside";
  if (on === undefined) app.classList.toggle(cls);
  else if (on) app.classList.remove(cls);
  else app.classList.add(cls);
  // 按钮视觉态：面板隐藏时按钮进入 off（契约：点「顶栏」→ notop + 按钮 off）
  const btn = $(which === "top" ? "btnTop" : "btnSide");
  if (btn && btn.classList) {
    const hidden = app.classList.contains(cls);
    if (hidden) btn.classList.add("off");
    else btn.classList.remove("off");
  }
  layout();
}
function panelOn(which) {
  const app = $("app");
  if (!app || !app.classList) return true;
  return !app.classList.contains(which === "top" ? "notop" : "noside");
}
function turnSheet(dir) {
  const max = Math.max(0, book.sheets - 1);
  // 翻页动画：sheetF 平滑滑向目标张（loop 每帧插值）
  state.sheet = clamp(state.sheet + dir, 0, max);
  updateHUD();
}
function goToSheet(s) {
  const max = Math.max(0, book.sheets - 1);
  state.sheet = clamp(Math.round(s), 0, max);
  updateHUD();
}
function jumpToChapter(i) {
  const C = book.chaps[i];
  if (!C) return;
  goToSheet(Math.round(C.start / 2));
}
/* stackHit(x, y) → "left" | "right" | null：书口命中 */
function stackHit(x, y) {
  if (y < GEO.pageY || y > GEO.pageY + GEO.pageH) return null;
  if (x >= GEO.pageX - GEO.leftW - 6 && x <= GEO.pageX + 6) return "left";
  if (x >= rectoRight() - 6 && x <= rectoRight() + GEO.rightWBase + 6) return "right";
  return null;
}
/* 契约：applyDrag(delta) 以「张」为单位推进，钳制在 [0, sheets-1]，小数累积不丢步 */
function applyDrag(delta) {
  const max = Math.max(0, book.sheets - 1);
  state.sheetF = clamp(state.sheetF + delta, 0, max);
  state.sheet = Math.round(state.sheetF);
  updateHUD();
}
/* --------------------- 事件绑定 --------------------- */
let NOWV = 0;
function bindEvents() {
  const cv = document.getElementById("cv");
  if (!cv) return;
  cv.addEventListener("pointerdown", ev => {
    const x = ev.clientX, y = ev.clientY;
    const side = stackHit(x, y);
    if (side) {
      state.drag = { side, y0: y, s0: state.sheetF, vy: 0, last: NOWV, moved: 0 };
    } else if (canPan()) {
      state.pan = { x0: x, y0: y, px0: state.panX, py0: state.panY, moved: 0, t0: NOWV };
    } else {
      // 1× 轻点翻页：左页后退、右页前进
      state._tap = { x, y, t: NOWV };
    }
  });
  cv.addEventListener("pointermove", ev => {
    if (state.drag) {
      const d = state.drag;
      const dy = d.y0 - ev.clientY;                       // 上拖 = 前进
      d.moved += Math.abs(dy);
      const step = Math.abs(ev.clientY - (d.prevY === undefined ? d.y0 : d.prevY));
      d.prevY = ev.clientY;
      // 增益：距离用累计拖距，速度用单步位移（×200 ≈ px/s 采样系数，饱和点见 gainFor）
      const gain = gainFor(Math.abs(dy), step * 200);
      const max = Math.max(0, book.sheets - 1);
      state.sheetF = clamp(d.s0 + dy / 40 * gain, 0, max);
      updateHUD();
    } else if (state.pan) {
      const p = state.pan;
      p.moved += Math.abs(ev.clientX - (p.lastX === undefined ? p.x0 : p.lastX))
               + Math.abs(ev.clientY - (p.lastY === undefined ? p.y0 : p.lastY));
      p.lastX = ev.clientX; p.lastY = ev.clientY;
      if (p.moved > 6) {
        state.panX = p.px0 + (ev.clientX - p.x0);
        state.panY = p.py0 + (ev.clientY - p.y0);
        applyView();
      }
    }
  });
  cv.addEventListener("pointerup", ev => {
    if (state.drag) {
      const d = state.drag;
      state.drag = null;
      if (d.moved <= 4) {
        // 书口轻点 = 跳章（契约：点书口章带跳到那一章；按住拖动才是翻阅）
        const x = ev.clientX, y = ev.clientY;
        if (onCmapBand(x, y)) return;
      }
      state.sheet = Math.round(clamp(state.sheetF, 0, Math.max(0, book.sheets - 1)));
      updateHUD();
      return;
    }
    if (state.pan) {
      const moved = state.pan.moved;
      const x = ev.clientX, y = ev.clientY;
      state.pan = null;
      if (moved <= 6) {
        // 轻点：先查章带（书口），再查页面翻页
        if (onCmapBand(x, y)) return;                     // 跳章已在 onCmapBand 内完成
        if (x > GEO.spineX) turnSheet(1);                 // 中缝右侧=右页
        else if (x < GEO.spineX) turnSheet(-1);
      }
      return;
    }
    if (state._tap) {
      const x = ev.clientX, y = ev.clientY;
      state._tap = null;
      if (onCmapBand(x, y)) return;
      if (x > GEO.spineX) turnSheet(1);
      else if (x < GEO.spineX) turnSheet(-1);
    }
  });
  /* 章带命中：落在左右纸叠区域 → bandAt 反解 → 跳章 */
  function onCmapBand(x, y) {
    if (y < GEO.pageY || y > GEO.pageY + GEO.pageH) return false;
    const inLeft = x >= GEO.pageX - GEO.leftWBase - 6 && x <= GEO.pageX + 2;
    const inRight = x >= rectoRight() - 2 && x <= rectoRight() + GEO.rightWBase + 6;
    if (!inLeft && !inRight) return false;
    const b = bandAt(x, y);
    if (b) { goToSheet(Math.round(book.chaps[b.chapter].start / 2)); return true; }
    return false;
  }
  cv.addEventListener("wheel", ev => {
    ev.preventDefault();
    if (ev.ctrlKey) {
      zoomTo(state.zoom * (ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), ev.clientX, ev.clientY);
    } else {
      turnSheet(ev.deltaY > 0 ? -1 : 1);
    }
  }, { passive: false });
  // 双指捏合
  const touches = new Map();
  cv.addEventListener("pointerdown", ev => {
    if (ev.pointerType === "touch") { touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); 
      if (touches.size === 2) { state.drag = null; state.pan = null; state.pinch = pinchState(); } }
  });
  cv.addEventListener("pointermove", ev => {
    if (!touches.has(ev.pointerId)) return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2 && state.pinch) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const z = clamp(state.pinch.z0 * dist / state.pinch.d0, ZOOM_MIN, ZOOM_MAX);
      applyZoom(z); zoomHUD();
    }
  });
  const clearTouch = ev => {
    touches.delete(ev.pointerId);
    if (touches.size < 2) state.pinch = null;
  };
  cv.addEventListener("pointerup", clearTouch);
  cv.addEventListener("pointercancel", clearTouch);
  function pinchState() {
    const [a, b] = [...touches.values()];
    return { d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z0: state.zoom };
  }
  // 键盘
  window.addEventListener("keydown", ev => {
    const tag = (ev.target && ev.target.tagName) || "";
    if (tag === "BUTTON" || tag === "INPUT") return;
    if (ev.ctrlKey || ev.metaKey) return;                 // Ctrl+P 留给浏览器
    const k = ev.key;
    if (k === "=" || k === "+") { zoomTo(state.zoom * ZOOM_STEP); ev.preventDefault(); }
    else if (k === "-") { zoomTo(state.zoom / ZOOM_STEP); ev.preventDefault(); }
    else if (k === "0") { resetView(); ev.preventDefault(); }
    else if (k === "ArrowLeft" || k === "PageUp") turnSheet(-1);
    else if (k === "ArrowRight" || k === "PageDown") turnSheet(1);
    else if (k === "t" || k === "T") setPanel("top");
    else if (k === "p" || k === "P") setPanel("side");
  });
  // 面板按钮
  const bt = $("btnTop"); if (bt) bt.onclick = () => setPanel("top");
  const bs = $("btnSide"); if (bs) bs.onclick = () => setPanel("side");
  const zi = $("btnZoomIn"); if (zi) zi.onclick = () => zoomPreset(state.zoom * ZOOM_STEP);
  const zo = $("btnZoomOut"); if (zo) zo.onclick = () => zoomPreset(state.zoom / ZOOM_STEP);
  const zf = $("btnZoomFit"); if (zf) zf.onclick = resetView;
  const z1 = $("btnZ1"); if (z1) z1.onclick = () => zoomPreset(1);
  const z15 = $("btnZ15"); if (z15) z15.onclick = () => zoomPreset(1.5);
  const z2 = $("btnZ2"); if (z2) z2.onclick = () => zoomPreset(2);
  const z3 = $("btnZ3"); if (z3) z3.onclick = () => zoomPreset(3);
  const nx = $("btnNext"); if (nx) nx.onclick = () => turnSheet(1);
  const pv = $("btnPrev"); if (pv) pv.onclick = () => turnSheet(-1);
  const db = $("btnDemoBook"); if (db) db.onclick = () => { buildDemoBook(); setStatus("示例书《书口》· " + book.chaps.length + " 章 / " + book.pages + " 页", "ok"); };
  const bi = $("btnImport"); if (bi) bi.onclick = () => { const f = $("file"); if (f && f.click) f.click(); };
  const fl = $("file");
  if (fl) fl.addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    if (f) importFile(f);
    e.target.value = "";
  });
}
