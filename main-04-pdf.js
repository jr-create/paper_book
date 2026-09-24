/* --------------------- PDF：目录 → 章节（pickMarks） --------------------- */
const PDF_HEAD_RE = /^\s{0,4}(第\s*[0-9零一二三四五六七八九十百千万〇]+\s*[章回节卷篇部]|Chapter\s+\d+|[0-9]{1,3}(\.[0-9]{1,3}){0,2})\s*[:：、.．]?\s*\S*/;
function dedupe(arr) {
  const seen = new Set(), out = [];
  for (const o of arr) {
    const k = o.page + "|" + (o.title || "");
    if (seen.has(k)) continue;
    seen.add(k); out.push(o);
  }
  return out;
}
/* 目录条目上百条全画到书口上每段不到 1 像素 → 按层级抽样到 ≤cap 条 */
function pickMarks(outline, pageCount, cap) {
  const max = cap || 40;
  const list = (outline || []).filter(o => o && typeof o.page === "number" && o.page >= 0 && o.page < pageCount);
  if (!list.length) return [];
  const depths = [...new Set(list.map(o => o.depth || 1))].sort((a, b) => a - b);
  for (const d of depths) {
    const valid = dedupe(list.filter(o => (o.depth || 1) === d).slice().sort((a, b) => a.page - b.page));
    if (valid.length >= 2) {
      if (valid.length <= max) return valid;
      const step = valid.length / max;
      const out = [];
      for (let i = 0; i < max; i++) out.push(valid[Math.min(valid.length - 1, Math.round(i * step))]);
      return dedupe(out);
    }
  }
  return dedupe(list.slice().sort((a, b) => a.page - b.page));
}

/* --------------------- PDF 文本 → 块（后备文本重排用） --------------------- */
function pdfTextToBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const t = buf.join("").trim();
    if (t) blocks.push({ type: "p", runs: [{ t }] });
    buf = [];
  };
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) { flush(); continue; }
    if (PDF_HEAD_RE.test(s) && s.length <= 40) { flush(); blocks.push({ type: "h", level: 2, runs: [{ t: s, b: 1 }] }); continue; }
    if (/^\s{2,}\S/.test(raw) && /[{}();=<>]/.test(s)) { flush(); blocks.push({ type: "code", lines: [raw] }); continue; }
    buf.push(s);
  }
  flush();
  return blocks.length ? blocks : [{ type: "p", runs: [{ t: "" }] }];
}

/* --------------------- PDF：Koodo 式原版渲染 --------------------- */
async function parsePdfRendered(buf, r) {
  const n = (r && r.info && r.info.pageCount) || 0;
  if (!n) throw new Error("PDF 里没有页面");
  const marks = pickMarks(r.outline, n);
  const desc = i => ({ kind: "pdfjs", page: i + 1, width: 0, height: 0 });
  const chapters = [];
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const from = marks[i].page, to = (i + 1 < marks.length ? marks[i + 1].page : n);
      chapters.push({
        t: (marks[i].title || "").replace(/\s+/g, " ").trim().slice(0, 40) || ("第 " + (i + 1) + " 节"),
        p: "", imgPages: Array.from({ length: Math.max(1, to - from) }, (_, k) => desc(from + k))
      });
    }
  } else {
    const PER = 20;
    for (let p = 0; p < n; p += PER)
      chapters.push({
        t: "第 " + (chapters.length + 1) + " 节", p: "",
        imgPages: Array.from({ length: Math.min(PER, n - p) }, (_, k) => desc(p + k))
      });
  }
  if (typeof PDFJS !== "undefined") {
    PDFJS.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (typeof pdfjsBoot === "function") pdfjsBoot().catch(() => {});
  }
  const title = (r && r.info && r.info.title || "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
  const note = "原版页面模式 · 按原始版面渲染" + n + " 页"
    + (marks.length >= 2 ? " · 按目录分 " + marks.length + " 章" : " · 无目录，按每 20 页分节");
  return { chapters, title, note };
}

/* 旧文本重排路线（fallback） */
async function parsePdfTextMode(buf, r, pages, pagesText, pdfTitle) {
  const pageBlocks = pages.map((p, pi) => pdfTextToBlocks(pagesText[pi] || ""));
  let chapters = [], note = "";
  const marks = pickMarks(r.outline, pages.length);
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const from = marks[i].page, to = (i + 1 < marks.length ? marks[i + 1].page : pages.length);
      const t = (marks[i].title || "").replace(/\s+/g, " ").trim().slice(0, 40) || ("第 " + (i + 1) + " 节");
      const blocks = [];
      for (let p = from; p < to; p++) for (const b of pageBlocks[p]) blocks.push(b);
      chapters.push({ t, p: "", blocks });
    }
    note = "按 PDF 目录分 " + marks.length + " 章";
  } else {
    const PER = 8;
    for (let p = 0; p < pages.length; p += PER) {
      const to = Math.min(pages.length, p + PER);
      const first = (pagesText[p] || "").split("\n").map(s => s.trim()).find(s => s.length > 1) || "";
      const blocks = [];
      for (let q = p; q < to; q++) for (const b of pageBlocks[q]) blocks.push(b);
      chapters.push({ t: first.slice(0, 26) || ("第 " + (chapters.length + 1) + " 节"), p: "", blocks });
    }
    note = "无目录，按每 " + PER + " 页分节";
  }
  chapters = chapters.filter(c => c.blocks.length);
  if (!chapters.length) throw new Error("PDF 里没有提取到可用文本");
  note += "（后备文本重排模式）";
  return { chapters, title: pdfTitle || null, note };
}

async function pdfImageMode(buf, r, baseTitle) {
  if (typeof pdfExtractImages !== "function") throw new Error("PDF 图像提取器未载入");
  const im = await pdfExtractImages(buf);
  const all = im.pages || [];
  if (!all.length) throw new Error("PDF 里没有页面");
  if (!im.usable) throw new Error("这个 PDF 既没有文本层，页面图像也无法解码" + (im.notes.length ? "：" + im.notes[0] : ""));
  const title = (baseTitle || "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
  const marks = pickMarks(r.outline, all.length);
  const chapters = [];
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const from = marks[i].page, to = (i + 1 < marks.length ? marks[i + 1].page : all.length);
      chapters.push({
        t: (marks[i].title || "").replace(/\s+/g, " ").trim().slice(0, 40) || ("第 " + (i + 1) + " 节"),
        p: "", imgPages: all.slice(from, to)
      });
    }
  } else {
    const PER = 20;
    for (let p = 0; p < all.length; p += PER)
      chapters.push({ t: "第 " + (chapters.length + 1) + " 节", p: "", imgPages: all.slice(p, Math.min(all.length, p + PER)) });
  }
  const skipped = all.length - im.usable;
  const note = "图像页模式（无文本层）· " + im.usable + "/" + all.length + " 页可显示"
    + (skipped ? "，" + skipped + " 页编码不支持" : "")
    + (marks.length >= 2 ? " · 按目录分 " + marks.length + " 章" : " · 无目录，按每 20 页分节");
  return { chapters, title, note };
}

async function parsePdf(buf) {
  if (typeof pdfExtract !== "function") throw new Error("PDF 解析器未载入");
  // 解析只做两件事：元数据 + 章节目录。页面按原始版面交给内嵌 pdf.js 渲染。
  const r = await pdfExtract(buf);
  const pages = (r && r.pages) || [];
  if (!pages.length) throw new Error("PDF 里没有页面");
  const pagesText = pages.map(p => (p && typeof p.text === "string") ? p.text : "");
  const totalChars = pagesText.join("").replace(/\s/g, "").length;
  const pdfTitle = (r.info && r.info.title || "").replace(/\s+/g, " ").trim().slice(0, 40);
  try {
    return await parsePdfRendered(buf, r);
  } catch (e) {
    if (totalChars < 20) return await pdfImageMode(buf, r, pdfTitle);
    return await parsePdfTextMode(buf, r, pages, pagesText, pdfTitle);
  }
}
