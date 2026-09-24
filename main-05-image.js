/* --------------------- 图像页 / 插图：缓存与解码 --------------------- */
const IMG_CACHE = new Map(); const IMG_TIMEOUT = 12000;
const IMG_PENDING = new Set();
let imgPx = 0;
const longSide = o => Math.max((o && o.width) || 0, (o && o.height) || 0);

function imgTargetW() { return clamp(Math.round(GEO.pageW * GEO.DPR), IMG_W_MIN, IMG_W_MAX); }
/* pdfjs 矢量页没有原图上限（放大就该重渲染）；扫描页被原图长边封顶 */
function imgTargetFor(idx) {
  const d = book.imgPages && book.imgPages.get(idx);
  if (!d) return imgTargetW();
  if (d.kind === "pdfjs") return imgTargetW();
  const nat = Math.max(d.width || 0, d.height || 0);
  return nat ? Math.min(imgTargetW(), nat) : imgTargetW();
}
function imgTargetForKey(key, d) {
  if (d && d.kind === "pdfjs") return imgTargetW();
  const nat = d ? Math.max(d.width || 0, d.height || 0) : 0;
  return nat ? Math.min(imgTargetW(), nat) : imgTargetW();
}
const FIG_DESC = new Map();
function figKey(fig) { return "f" + (fig && fig.id); }

function imgCacheSet(key, c) {
  const px = (c.width || 0) * (c.height || 0);
  const old = IMG_CACHE.get(key);
  if (old) { imgPx -= (old.width || 0) * (old.height || 0); IMG_CACHE.delete(key); }
  IMG_CACHE.set(key, c); imgPx += px;
  while (IMG_CACHE.size > 1 && imgPx > IMG_PIX_BUDGET) {
    const k = IMG_CACHE.keys().next().value, v = IMG_CACHE.get(k);
    imgPx -= (v.width || 0) * (v.height || 0); IMG_CACHE.delete(k);
  }
}
function clearPageCache() { IMG_CACHE.clear(); imgPx = 0; HICACHE.clear(); hiPx = 0; }

function loadImageEl(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("图像解码失败"));
    im.src = url;
  });
}
async function decodePageImage(key, d, target) {
  let url = null;
  try {
    if (d.kind === "pdfjs") return await pdfjsRenderPage(d.page, target || IMG_W_MIN);
    let src = null;
    if (d.kind === "jpeg") {
      url = URL.createObjectURL(new Blob([d.bytes], { type: "image/jpeg" }));
      src = await loadImageEl(url);
    } else if (d.kind === "raw") {
      const W = d.width, H = d.height, comps = d.comps, data = d.data;
      const rgba = new Uint8ClampedArray(W * H * 4);
      for (let i = 0, p = 0; i < W * H; i++) {
        let r, g, b;
        if (comps === 1) { r = g = b = data[i]; }
        else if (comps === 3) { r = data[i * 3]; g = data[i * 3 + 1]; b = data[i * 3 + 2]; }
        else { const c = data[i * 4], m = data[i * 4 + 1], y = data[i * 4 + 2], k = data[i * 4 + 3];
               r = 255 - Math.min(255, c + k); g = 255 - Math.min(255, m + k); b = 255 - Math.min(255, y + k); }
        rgba[p++] = r; rgba[p++] = g; rgba[p++] = b; rgba[p++] = 255;
      }
      const raw = document.createElement("canvas"); raw.width = W; raw.height = H;
      raw.getContext("2d").putImageData(new ImageData(rgba, W, H), 0, 0);
      src = raw;
    } else throw new Error("不支持的图像编码");
    const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
    if (!iw || !ih) throw new Error("图像尺寸无效");
    const s = Math.min(1, (target || IMG_W_MIN) / Math.max(iw, ih));
    const cw = Math.max(1, Math.round(iw * s)), chh = Math.max(1, Math.round(ih * s));
    const c = document.createElement("canvas"); c.width = cw; c.height = chh;
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, cw, chh);
    g.drawImage(src, 0, 0, cw, chh);
    return c;
  } finally { if (url) URL.revokeObjectURL(url); }
}
function loadPageImage(idx) { loadImageByKey(idx, book.imgPages && book.imgPages.get(idx)); }
function loadImageByKey(key, d) {
  if (!d || IMG_PENDING.has(key)) return;
  IMG_PENDING.add(key);
  const target = imgTargetForKey(key, d);
  let timedOut = false;
  Promise.race([
    decodePageImage(key, d, target),
    new Promise((_, rej) => setTimeout(() => { timedOut = true; rej(new Error("图像解码超时")); }, IMG_TIMEOUT))
  ]).then(c => {
    c.decodeTarget = target;
    imgCacheSet(key, c);
  }).catch(e => {
    if (!timedOut) imgCacheSet(key, { error: (e && e.message) || String(e), width: 0, height: 0 });
  }).finally(() => { IMG_PENDING.delete(key); });
}
function ensurePageImage(idx) { if (!IMG_CACHE.has(idx)) loadPageImage(idx); }
function upgradePageImage(idx) {
  const b = IMG_CACHE.get(idx);
  if (b && b.error) return;
  loadPageImage(idx);
}
function imagePageReady(idx) {
  const b = IMG_CACHE.get(idx);
  if (!b || !b.width) return null;
  // 放大后不够用 → 后台补高清；当前这张继续用（不闪占位符）
  const want = imgTargetFor(idx);
  if (longSide(b) < want * 0.9 && (b.decodeTarget || 0) < want * 0.95) upgradePageImage(idx);
  return b;
}
function ensureFigure(key, fig) { if (!IMG_CACHE.has(key)) loadImageByKey(key, fig.desc); }
function upgradeFigure(key) {
  const b = IMG_CACHE.get(key);
  if (b && b.error) return;
  loadImageByKey(key, FIG_DESC.get(key));
}

/* --------------------- 设备像素对齐 --------------------- */
function snapRect(x, y, w, h) {
  const d = GEO.DPR || 1;
  const s = v => Math.round(v * d) / d;
  const x0 = s(x), y0 = s(y), x1 = s(x + w), y1 = s(y + h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
