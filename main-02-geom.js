/* --------------------- 增益模型（契约：[4] 节） ---------------------
   gainFor(dist, vel)：
     静止(0,0) → GAIN_FINE
     极速(0,9999) → GAIN_COARSE（速度项独占整个增益差）
     距离单独(9999,0) → FINE + (COARSE-FINE)*DIST_CAP（DIST_CAP 是占比系数）
     慢拖(120,120) < 0.13
     对速度单调不减
   组合取 max（谁的影响大听谁的），保证各项断言同时成立。 */
function gainFor(dist, vel) {
  dist = Math.max(0, dist || 0);
  vel = Math.max(0, vel || 0);
  const dTerm = Math.min(dist, 900) / 900 * DIST_CAP;       // 距离项封顶 DIST_CAP
  const vTerm = Math.min(vel, 4000) / 4000;                  // 速度项饱和点 4000
  return Math.min(GAIN_COARSE, GAIN_FINE + (GAIN_COARSE - GAIN_FINE) * Math.max(dTerm, vTerm));
}

/* --------------------- 书口几何（契约：[7] 节） ---------------------
   leftW + rightW ≡ Tstack（厚度守恒）
   开头 leftW=0；结尾 rightW=0
   pageX = blockX + leftW（书口在左边时页面被纸堆顶开）
   stackX(page, isRead)：把「第 page 页」映射到书口 x 坐标（章带正解）
   bandAt(x, y)：书口上的点 → 章（反解） */
function layout() {
  // W/H 取画布父容器（stage）的布局矩形：面板显隐改变 stage 的可用区。
  // 测试桩把动态值挂在 parentElement.getBoundingClientRect 上，两边一致。
  const cv0 = document.getElementById("cv");
  const src = (cv0 && cv0.parentElement) || document.getElementById("stage") || cv0;
  const rect = src && src.getBoundingClientRect ? src.getBoundingClientRect() : null;
  const w = (rect && rect.width) || 1200;
  const h = (rect && rect.height) || 800;
  GEO.W = w; GEO.H = h;
  GEO.DPR = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  const pad = Math.min(48, w * 0.03);
  // 先估一个书厚，页宽 = (可用宽 - 两侧纸叠) 分给两页；再用高度校核
  const stackEst = Math.max(4, book.pages * MM_PER_PG * ((h - pad * 2) / 210) * 0.5);
  let pw = (w - pad * 2 - stackEst * 2) / 2.3, ph = pw * 1.42;
  const maxH = h - pad * 2;
  if (ph > maxH) { ph = maxH; pw = ph / 1.42; }
  GEO.fitPageW = pw;
  const z = state.zoom || 1;
  GEO.pageW = pw * z; GEO.pageH = ph * z;
  GEO.Tstack = Math.max(4, book.pages * MM_PER_PG * (GEO.pageH / 210) * 0.5);
  const stack = GEO.Tstack;
  GEO.leftWBase = stack; GEO.rightWBase = stack;
  GEO.gutter = Math.max(6, GEO.pageW * 0.055);
  GEO.sceneW = GEO.pageW * 2 + GEO.gutter + stack * 2;
  GEO.sceneH = GEO.pageH;                          // 内容高（面板显隐改变的是视口 h）
  GEO.blockX = (w - GEO.sceneW) / 2 + state.panX;
  // 厚度守恒：leftW+rightW≡Tstack；sheet=sheets-1 时 rightW=0（用 sheets-1 归一）
  const denom = Math.max(1, book.sheets - 1);
  GEO.leftW = stack * clamp(state.sheetF / denom, 0, 1);
  GEO.rightW = stack - GEO.leftW;
  GEO.pageX = GEO.blockX + GEO.leftW;
  GEO.pageY = (h - GEO.sceneH) / 2 + state.panY;
  GEO.spineX = GEO.pageX + GEO.pageW + GEO.gutter / 2;
  const cv = document.getElementById("cv");
  if (cv) {
    const tw = Math.round(w * GEO.DPR), th = Math.round(h * GEO.DPR);
    if (cv.width !== tw || cv.height !== th) {
      cv.width = tw; cv.height = th;
      if (cv.style) { cv.style.width = w + "px"; cv.style.height = h + "px"; }
    }
  }
  return GEO;
}

const rectoX = () => GEO.pageX + GEO.pageW + GEO.gutter;
/* 章带正解：已读页落在左书口（pageX 向左展开），未读页落在右书口（右页右缘向右展开） */
const stackX = (page, isRead) => {
  const frac = clamp(page / Math.max(1, book.pages), 0, 1);
  if (isRead) return GEO.pageX - GEO.leftWBase * (1 - frac);
  return rectoRight() + GEO.rightWBase * frac;
};
const rectoRight = () => GEO.pageX + GEO.pageW + GEO.gutter + GEO.pageW;   // 右页右缘
const rectoIdx = () => clamp(state.sheet * 2 + 1, 0, Math.max(0, book.pages - 1));

/* 反解：书口上的点 → { chapter }（与 stackX 严格互逆）
   左书口（已读）：x = pageX - leftWBase*(1 - p/pages)  →  p = (1-(pageX-x)/leftWBase)*pages
   右书口（未读）：x = rectoRight() + rightWBase*(p/pages) → p = ((x-rectoRight())/rightWBase)*pages */
function bandAt(x, y) {
  if (!book.chaps.length) return null;
  let page;
  if (x <= GEO.pageX + 1) {
    const frac = clamp((GEO.pageX - x) / Math.max(1, GEO.leftWBase), 0, 1);
    page = Math.round((1 - frac) * book.pages);
  } else {
    const frac = clamp((x - rectoRight()) / Math.max(1, GEO.rightWBase), 0, 1);
    page = Math.round(frac * book.pages);
  }
  return { chapter: chapterOf(clamp(page, 0, book.pages - 1)), page };
}
