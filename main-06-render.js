/* --------------------- 绘制：正文页 / 插图 / 图像页 --------------------- */
function serifStack() { return '"Songti SC","SimSun","Noto Serif CJK SC",Georgia,serif'; }
function monoStack() { return 'Consolas,"Courier New",monospace'; }

function drawHRule(g, k, padX, padT, lh, fs, W) {
  const y = padT + lh * k + lh * 0.5;
  g.strokeStyle = "rgba(90,80,64,.35)";
  g.lineWidth = Math.max(0.6, GEO.H / 1400);
  g.beginPath(); g.moveTo(padX + fs * 2, y); g.lineTo(W - padX - fs * 2, y); g.stroke();
}
function drawRichLine(g, ln, k, padX, padT, lh, fs, W) {
  const y = padT + lh * k + lh * 0.72;
  let x = padX + (ln.pad || 0) * fs * 0.5;
  if (ln.marker) {
    g.fillStyle = "#6a5f4d"; g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.font = `${fs}px ${serifStack()}`;
    g.fillText(ln.marker, x, y);
    x += (ln.marker.length * 0.55 + 0.6) * fs;
  }
  for (const r of ln.runs || []) {
    const fam = r.c ? monoStack() : serifStack();
    const sz = ln.style === "h1" ? fs * HEAD_SCALE : (ln.style === "h2" ? fs * 1.3 : (ln.style === "h3" ? fs * 1.15 : fs));
    g.font = `${r.i ? "italic " : ""}${r.b ? "bold " : ""}${sz}px ${fam}`;
    g.fillStyle = ln.style === "quote" ? "#5f5646" : "#2a231c";
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    let tw = 0;
    for (const ch of r.t) tw += sz * (r.c ? 0.62 : (ch.codePointAt(0) > 0x2E80 ? 1 : 0.55));
    if (ln.style === "code") { g.fillStyle = "#ece5d4"; g.fillRect(x - 2, y - sz * 0.85, tw + 4, sz * 1.2); g.fillStyle = "#2a231c"; }
    g.fillText(r.t, x, y);
    x += tw;
  }
}
const FIG_ALPHA_BG = "#ffffff";
function drawFigure(g, ln, k, padX, padT, lh, fs, W) {
  const fig = ln.fig;
  if (!fig) return;
  const key = figKey(fig);
  const R = snapRect(padX, padT + lh * k, W - padX * 2, lh * FIG_LINES - lh * 0.35);
  const bmp = IMG_CACHE.get(key);
  g.save();
  if (bmp && bmp.width) {
    const s = Math.min(R.w / bmp.width, R.h / bmp.height);
    const dw = Math.max(1, bmp.width * s), dh = Math.max(1, bmp.height * s);
    const dx = Math.round((R.x + (R.w - dw) / 2) * GEO.DPR) / GEO.DPR;
    const dy = Math.round((R.y + (R.h - dh) / 2) * GEO.DPR) / GEO.DPR;
    if (fig.alpha) { g.fillStyle = FIG_ALPHA_BG; g.fillRect(dx, dy, dw, dh); }
    g.drawImage(bmp, dx, dy, dw, dh);
  } else if (bmp && bmp.error) {
    g.fillStyle = "#8d8271"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `${Math.max(6, fs * 0.8)}px ${serifStack()}`;
    g.fillText("（这一张示意图解码失败）", R.x + R.w / 2, R.y + R.h / 2);
  } else {
    g.strokeStyle = "rgba(90,80,64,.28)"; g.lineWidth = Math.max(0.6, GEO.H / 1400);
    g.strokeRect(R.x, R.y, R.w, R.h);
    g.fillStyle = "#9a8f7d"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `${Math.max(6, fs * 0.78)}px ${serifStack()}`;
    g.fillText("图 " + (fig.n || "") + "（正在解码…）", R.x + R.w / 2, R.y + R.h / 2);
    ensureFigure(key, fig);
  }
  g.restore();
}
function drawImagePage(idx, x, y, w, h) {
  const R = snapRect(x, y, w, h);
  const bmp = imagePageReady(idx);
  const g = ctx;
  g.save();
  if (bmp) {
    const s = Math.min(R.w / bmp.width, R.h / bmp.height);
    const dw = bmp.width * s, dh = bmp.height * s;
    const dx = Math.round((R.x + (R.w - dw) / 2) * GEO.DPR) / GEO.DPR;
    const dy = Math.round((R.y + (R.h - dh) / 2) * GEO.DPR) / GEO.DPR;
    g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 6;
    g.fillStyle = "#f7f2e7"; g.fillRect(dx, dy, dw, dh);
    g.shadowBlur = 0;
    g.drawImage(bmp, dx, dy, dw, dh);
  } else {
    g.fillStyle = "#f7f2e7"; g.fillRect(R.x, R.y, R.w, R.h);
    g.strokeStyle = "rgba(90,80,64,.2)"; g.lineWidth = 1; g.strokeRect(R.x, R.y, R.w, R.h);
    g.fillStyle = "#9a8f7d"; g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `${Math.max(9, R.h * 0.045)}px ${serifStack()}`;
    g.fillText("正在解码图像…", R.x + R.w / 2, R.y + R.h / 2);
    ensurePageImage(idx);
  }
  g.restore();
}
function paintPage(g, idx, W, H) {
  const padX = W * 0.085, padT = H * 0.10, padB = H * 0.075;
  const fs = Math.min((W - padX * 2) / (CHARS * 0.98), (H - padT - padB) / (LINES * 1.55));
  const lh = (H - padT - padB) / LINES;
  const m = pageMeta(idx);
  if (m.img && book.imgPages.has(idx)) { drawImagePage(idx, 0, 0, W, H); return; }
  g.save();
  // 纸面：轻微上下渐变，中间略亮（纸张质感）
  const paper = g.createLinearGradient(0, 0, 0, H);
  paper.addColorStop(0, "#f8f3e6");
  paper.addColorStop(0.5, "#fdfaf1");
  paper.addColorStop(1, "#f3edde");
  g.fillStyle = paper;
  g.fillRect(0, 0, W, H);
  // 页眉：左「书口」右「已读百分比」（原版样式）
  const pctTxt = Math.round(clamp(idx / Math.max(1, book.pages - 1), 0, 1) * 100) + "%";
  g.fillStyle = "#8d8271";
  g.font = `${Math.max(7, fs * 0.62)}px ${serifStack()}`;
  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  g.fillText("书口", padX, padT - lh * 0.55);
  g.textAlign = "right";
  g.fillText(pctTxt, W - padX, padT - lh * 0.55);
  // 页眉下的细分隔线
  g.strokeStyle = "rgba(120,105,80,.35)";
  g.lineWidth = 0.7;
  g.beginPath(); g.moveTo(padX, padT - lh * 0.32); g.lineTo(W - padX, padT - lh * 0.32); g.stroke();
  if (m.opening && m.t) {
    g.fillStyle = "#2a231c"; g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.font = `bold ${fs * HEAD_SCALE}px ${serifStack()}`;
    g.fillText(m.t, padX, padT + lh * 3);
  }
  const figRows = new Set();
  for (let k = 0; k < LINES; k++) {
    if (figRows.has(k)) continue;
    const ln = book.lines[idx * LINES + k];
    if (!ln) continue;
    if (ln.style === "fig") {
      drawFigure(g, ln, k, padX, padT, lh, fs, W);
      for (let j = 1; j < FIG_LINES && k + j < LINES; j++) figRows.add(k + j);
      continue;
    }
    if (ln.style === "hr") { drawHRule(g, k, padX, padT, lh, fs, W); continue; }
    drawRichLine(g, ln, k, padX, padT, lh, fs, W);
  }
  g.fillStyle = "#8d8271"; g.textAlign = "center"; g.textBaseline = "alphabetic";
  g.font = `${Math.max(8, fs * 0.72)}px ${serifStack()}`;
  g.fillText(String(idx + 1), W / 2, H - padB * 0.5);
  g.restore();
}
