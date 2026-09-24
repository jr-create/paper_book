/* --------------------- 富文本：宽度预算与换行 --------------------- */
function tokWidth(tk) {
  const s = tk.t || "";
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (tk.c) w += 0.62;
    else if (c > 0x2E80) w += 1;
    else w += 0.55;
  }
  return w;
}
function tokenizeRuns(runs) {
  const out = [];
  for (const r of runs || []) {
    if (!r.t) continue;
    let buf = "";
    const flush = () => { if (buf) { out.push({ t: buf, b: r.b, i: r.i, c: r.c }); buf = ""; } };
    for (const ch of r.t) {
      const c = ch.codePointAt(0);
      if (c > 0x2E80 || /\s/.test(ch)) { flush(); out.push({ t: ch, b: r.b, i: r.i, c: r.c }); }
      else if (/[A-Za-z0-9_\-.'"/\\:]/.test(ch)) buf += ch;
      else { flush(); out.push({ t: ch, b: r.b, i: r.i, c: r.c }); }
    }
    flush();
  }
  return out;
}
function runsText(runs) { return (runs || []).map(r => r.t || "").join(""); }

function wrapRuns(runs, budget, padFirst, padRest, indent) {
  const tks = tokenizeRuns(runs);
  const lines = [];
  let cur = { runs: [], pad: padFirst, style: null, marker: null };
  let used = padFirst;
  const pushLine = () => { lines.push(cur); cur = { runs: [], pad: padRest, style: null, marker: null }; used = padRest; };
  for (const tk of tks) {
    const w = tokWidth(tk);
    if (used + w > budget + 1e-6 && cur.runs.length) pushLine();
    if (w > budget) {                                   // 超长不可断词：硬拆
      let left = tk.t;
      while (left) {
        const room = Math.max(1, Math.floor(budget - used));
        const take = left.slice(0, room);
        left = left.slice(room);
        cur.runs.push({ t: take, b: tk.b, i: tk.i, c: tk.c });
        used += tokWidth({ t: take, c: tk.c });
        if (left) pushLine();
      }
      continue;
    }
    const last = cur.runs[cur.runs.length - 1];
    if (last && last.b === tk.b && last.i === tk.i && last.c === tk.c) last.t += tk.t;
    else cur.runs.push({ t: tk.t, b: tk.b, i: tk.i, c: tk.c });
    used += w;
  }
  if (cur.runs.length) lines.push(cur);
  return lines.length ? lines : [{ runs: [], pad: padFirst, style: null, marker: null }];
}

/* --------------------- 块 → 行 --------------------- */
function blockToLines(blk) {
  if (!blk) return [];
  if (blk.type === "img") {
    if (blk.fig && blk.fig.desc && typeof FIG_DESC !== "undefined") FIG_DESC.set(figKey(blk.fig), blk.fig.desc);
    const out = [{ runs: [], pad: 0, style: "fig", marker: null, fig: blk.fig }];
    for (let i = 1; i < FIG_LINES; i++) out.push({ runs: [], blank: true, figRow: true });
    return out;
  }
  if (blk.type === "code") {
    return (blk.lines || []).map(l => ({ runs: [{ t: l, c: 1 }], pad: 0, style: "code", marker: null }));
  }
  if (blk.type === "hr") return [{ runs: [], pad: 0, style: "hr", marker: null }];
  if (blk.type === "h") {
    const lv = blk.level || 2;
    const ls = wrapRuns(blk.runs.map(r => ({ ...r, b: 1 })), CHARS - 2, 1, 1);
    return ls.map(l => ({ ...l, style: "h" + lv }));
  }
  if (blk.type === "quote") {
    const ls = wrapRuns(blk.runs, CHARS - 4, 4, 4);
    return ls.map(l => ({ ...l, style: "quote" }));
  }
  if (blk.type === "li") {
    const mk = blk.marker || "•";
    // 契约：首行带 marker，续行 marker=null，且首行/续行 pad 相同（续行对齐在文字下方）
    const mkW = mk.length * 0.55 + 0.6;
    const ls = wrapRuns(blk.runs, CHARS - 2 - mkW, 2 + mkW, 2 + mkW);
    return ls.map((l, i) => ({ ...l, marker: i === 0 ? mk : null, style: "li" }));
  }
  return wrapRuns(blk.runs, CHARS - 2, 2, 0);           // 段落：首行缩进两格
}

/* --------------------- 行内 Markdown --------------------- */
function parseInline(s) {
  // 转义先行：\x → 占位符（U+E000+x），处理完再还原 —— 保证 \*不是斜体\* 原样输出
  const ESC = "\uE000";
  const stash = [];
  s = String(s).replace(/\\(.)/g, (_, ch) => { stash.push(ch); return ESC + (stash.length - 1) + ESC; });
  const out = [];
  const re = /(\*\*\*([\s\S]+?)\*\*\*|\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*|`([^`]+)`|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\([^)]*\))/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: s.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ t: m[2], b: 1, i: 1 });
    else if (m[3] !== undefined) out.push({ t: m[3], b: 1 });
    else if (m[4] !== undefined) out.push({ t: m[4], i: 1 });
    else if (m[5] !== undefined) out.push({ t: m[5], c: 1 });
    else if (m[6] !== undefined) out.push({ t: "［图：" + m[6] + "］" });
    else if (m[7] !== undefined) out.push({ t: m[7] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: s.slice(last) });
  const res = [];
  for (const r of out) {
    let t = r.t;
    if (typeof t === "string" && t.includes(ESC))
      t = t.replace(/\uE000(\d+)\uE000/g, (_, i2) => stash[+i2]);
    if (t) res.push({ ...r, t });
  }
  return res;
}

/* --------------------- Markdown 块级 --------------------- */
function parseMarkdownBlocks(md) {
  const lines = String(md).split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) {
      blocks.push({ type: "h", level: Math.min(3, m[1].length), runs: parseInline(m[2]) });
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { blocks.push({ type: "hr" }); i++; continue; }
    if ((m = /^```(\w*)\s*$/.exec(t))) {
      const body = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) { body.push(lines[i]); i++; }
      i++;
      blocks.push({ type: "code", lines: body });
      continue;
    }
    if (/^>\s?/.test(t)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { body.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
      blocks.push({ type: "quote", runs: parseInline(body.join("")) });
      continue;
    }
    if ((m = /^([-*+])\s+(.*)$/.exec(t))) { blocks.push({ type: "li", marker: "•", runs: parseInline(m[2]) }); i++; continue; }
    if ((m = /^(\d+)[.)]\s+(.*)$/.exec(t))) { blocks.push({ type: "li", marker: m[1] + ".", runs: parseInline(m[2]) }); i++; continue; }
    if (/^\|.*\|$/.test(t)) {
      const row = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      if (!/^[-: |]+$/.test(row.join(""))) blocks.push({ type: "p", runs: parseInline(row.join("　")) });
      i++; continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
           !/^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|\||-{3,})/.test(lines[i].trim())) {
      buf.push(lines[i].trim()); i++;
    }
    if (buf.length) blocks.push({ type: "p", runs: parseInline(buf.join("")) });
    else i++;
  }
  return blocks;
}
function mdChapters(md) {
  const blocks = parseMarkdownBlocks(md);
  const chapters = [];
  let cur = null, title = null;
  for (const b of blocks) {
    if (b.type === "h" && b.level <= 3) {
      if (b.level === 1 && title === null) title = runsText(b.runs);
      if (cur) chapters.push(cur);
      cur = { t: runsText(b.runs), p: "", blocks: [] };
      continue;
    }
    if (!cur) cur = { t: "正文", p: "", blocks: [] };
    cur.blocks.push(b);
  }
  if (cur) chapters.push(cur);
  return { chapters, title };
}

/* --------------------- 纯文本章节识别 --------------------- */
const RE_HEAD = [
  /^\s{0,6}第\s*[0-9零一二三四五六七八九十百千万〇]+\s*[章回节卷篇部]\s*[:：、.．]?\s*(.{0,40})$/,
  /^\s{0,6}(?:Chapter|CHAPTER|Part|PART)\s+([0-9IVXLC]+)\s*[:：.\-]?\s*(.{0,40})$/,
  /^\s{0,6}([0-9]{1,3})\s*[、.．]\s*(.{1,40})$/,
  /^\s{0,6}[（(]\s*[0-9零一二三四五六七八九十]+\s*[)）]\s*(.{0,40})$/
];
function looksHeading(line) {
  const t = line.trim();
  if (!t || t.length > 46) return null;
  for (const re of RE_HEAD) { if (re.exec(t)) return t; }
  return null;
}
function splitLongParagraph(p, max) {
  if (p.length <= max) return [p];
  const out = [];
  let s = p;
  while (s.length > max) {
    let cut = -1;
    for (let i = Math.min(max, s.length - 1); i > max * 0.5; i--) {
      if (/[。！？；…」』”"'.!?;]/.test(s[i])) { cut = i + 1; break; }
    }
    if (cut <= 0) cut = max;
    out.push(s.slice(0, cut).trim());
    s = s.slice(cut).trim();
  }
  if (s) out.push(s);
  return out;
}
function splitChapters(text, kind) {
  const paras = String(text).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const flat = [];
  for (const p of paras) for (const seg of splitLongParagraph(p, 1200)) flat.push(seg);
  // 有标题 → 标题切章；无标题 → 按体量切（契约：无标题长文也能切成多节）
  const hasHead = flat.some(p => looksHeading(p.split("\n")[0]));
  if (!hasHead) {
    // 按字数切节（契约：无标题长文 ≥3 节、节数随体量增长、段落 ≤1200 字）
    const TARGET = 2000;
    const chapters = [];
    let buf = [], len = 0;
    for (const p of flat) {
      buf.push(p); len += p.length;
      if (len >= TARGET) {
        chapters.push({ t: "第 " + (chapters.length + 1) + " 节", p: "",
                        blocks: buf.map(x => ({ type: "p", runs: [{ t: x }] })) });
        buf = []; len = 0;
      }
    }
    if (buf.length)
      chapters.push({ t: "第 " + (chapters.length + 1) + " 节", p: "",
                      blocks: buf.map(x => ({ type: "p", runs: [{ t: x }] })) });
    return chapters.length ? chapters
      : [{ t: "第 1 节", p: "", blocks: [{ type: "p", runs: [{ t: String(text) }] }] }];
  }
  const chapters = [];
  let cur = null;
  for (const p of flat) {
    const head = looksHeading(p.split("\n")[0]);
    if (head) {
      if (cur) chapters.push(cur);
      cur = { t: head, p: "", blocks: [{ type: "p", runs: [{ t: p }] }] };
    } else {
      if (!cur) cur = { t: "第 " + (chapters.length + 1) + " 节", p: "", blocks: [] };
      cur.blocks.push({ type: "p", runs: [{ t: p }] });
    }
  }
  if (cur) chapters.push(cur);
  if (!chapters.length) chapters.push({ t: "第 1 节", p: "", blocks: [{ type: "p", runs: [{ t: String(text) }] }] });
  return chapters;
}

/* --------------------- HTML --------------------- */
function htmlToBlocks(doc) {
  const blocks = [];
  const walk = (node) => {
    for (const el of Array.from(node.children || [])) {
      const tag = (el.tagName || "").toLowerCase();
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (["script", "style", "nav", "footer"].includes(tag)) continue;
      if (/^h[1-6]$/.test(tag)) { blocks.push({ type: "h", level: Math.min(3, +tag[1]), runs: parseInline(txt) }); continue; }
      if (tag === "pre") { blocks.push({ type: "code", lines: txt.split("\n") }); continue; }
      if (tag === "blockquote") { blocks.push({ type: "quote", runs: parseInline(txt) }); continue; }
      if (tag === "li") { blocks.push({ type: "li", marker: "•", runs: parseInline(txt) }); continue; }
      if (tag === "hr") { blocks.push({ type: "hr" }); continue; }
      if (tag === "p") { if (txt) blocks.push({ type: "p", runs: parseInline(txt) }); continue; }
      if (tag === "div") { if (el.children.length) walk(el); else if (txt) blocks.push({ type: "p", runs: parseInline(txt) }); continue; }
      walk(el);
    }
  };
  walk(doc.body || doc);
  return blocks.length ? blocks : [{ type: "p", runs: [{ t: (doc.body && doc.body.textContent || "").trim() }] }];
}
function blocksToChapters(blocks, fallbackTitle) {
  const chapters = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === "h" && b.level === 1) {
      if (cur) chapters.push(cur);
      cur = { t: runsText(b.runs), p: "", blocks: [] };
      continue;
    }
    if (!cur) cur = { t: fallbackTitle || "正文", p: "", blocks: [] };
    cur.blocks.push(b);
  }
  if (cur) chapters.push(cur);
  return { chapters, title: fallbackTitle || null };
}
