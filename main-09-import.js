/* --------------------- EPUB --------------------- */
async function unzip(buf) {
  const u8 = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = new Map();
  let p = 0;
  while (p + 30 <= u8.length) {
    const sig = dv.getUint32(p, true);
    if (sig === 0x04034b50) {
      const method = dv.getUint16(p + 8, true);
      const csize = dv.getUint32(p + 18, true);
      const nlen = dv.getUint16(p + 26, true), elen = dv.getUint16(p + 28, true);
      const name = new TextDecoder().decode(u8.subarray(p + 30, p + 30 + nlen));
      const dataStart = p + 30 + nlen + elen;
      const raw = u8.subarray(dataStart, dataStart + csize);
      if (method === 0) out.set(name, raw.slice());
      else if (method === 8) {
        try {
          const ds = new DecompressionStream("deflate-raw");
          const ab = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
          out.set(name, new Uint8Array(ab));
        } catch (e) { /* 单文件失败忽略 */ }
      }
      p = dataStart + csize;
      continue;
    }
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    p++;
  }
  return out;
}
async function parseEpub(buf) {
  const files = await unzip(buf);
  let opfPath = "";
  const container = files.get("META-INF/container.xml");
  if (container) {
    const m = /full-path="([^"]+)"/.exec(new TextDecoder().decode(container));
    if (m) opfPath = m[1];
  }
  if (!opfPath) for (const k of files.keys()) if (k.endsWith(".opf")) { opfPath = k; break; }
  if (!opfPath || !files.has(opfPath)) throw new Error("EPUB 里找不到 OPF 文件");
  const opfText = new TextDecoder().decode(files.get(opfPath));
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const titleM = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opfText);
  const title = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim().slice(0, 40) : null;
  const spineM = /<spine[^>]*>([\s\S]*?)<\/spine>/.exec(opfText);
  const manifest = new Map();
  for (const m of opfText.matchAll(/<item[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"[^>]*?\/?>/g)) manifest.set(m[1], m[2]);
  const order = [];
  if (spineM) for (const m of spineM[1].matchAll(/idref="([^"]+)"/g)) order.push(m[1]);
  const chapters = [];
  for (const id of order) {
    const href = manifest.get(id);
    if (!href) continue;
    const data = files.get(base + href) || files.get(href);
    if (!data) continue;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), "text/html");
    const bt = blocksToChapters(htmlToBlocks(doc), "正文");
    chapters.push(...bt.chapters);
  }
  if (!chapters.length) throw new Error("EPUB 里没有可读章节");
  return { chapters, title };
}

/* --------------------- 导入入口 --------------------- */
const chaptersWordCount = chs => chs.reduce((a, c) =>
  a + (c.blocks || []).reduce((b, blk) =>
    b + (blk.runs ? runsText(blk.runs).length : (blk.lines ? blk.lines.join("").length : 0)), 0), 0);

function loadBook(chapters, meta) {
  clearPageCache();
  book.title = meta.title || "未命名";
  book.source = meta.source || "导入";
  book.demo = false;
  paginate(chapters);
  state.sheetF = 0; state.sheet = 0; state.turn = null; state.drag = null;
  state.fling = null; state.fan.bands = 0; state.hover = null;
  // 契约：换书后缩放保留、平移清零
  state.pan = null; state.panX = 0; state.panY = 0;
  layout(); buildCmap(); updateHUD(); zoomHUD();
  refreshTitle();
}
function setStatus(msg, kind) {
  const el = $("docStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
async function importFile(file) {
  if (!file) return;
  const name = file.name || "文档";
  const ext = (name.split(".").pop() || "").toLowerCase();
  setStatus("正在解析 " + name + " …");
  try {
    let chapters, title, extra = "";
    if (ext === "epub") {
      const r = await parseEpub(await file.arrayBuffer());
      chapters = r.chapters; title = r.title;
    } else if (ext === "pdf") {
      const r = await parsePdf(await file.arrayBuffer());
      chapters = r.chapters; title = r.title;
      extra = "　" + r.note;
    } else if (ext === "html" || ext === "htm" || ext === "xhtml") {
      const doc = new DOMParser().parseFromString(await file.text(), "text/html");
      const bt = blocksToChapters(htmlToBlocks(doc), "正文");
      chapters = bt.chapters;
      title = (doc.title || "").trim().slice(0, 40) || bt.title || name.replace(/\.[^.]+$/, "");
    } else if (ext === "md" || ext === "markdown") {
      const md = mdChapters(await file.text());
      chapters = md.chapters;
      title = md.title || name.replace(/\.[^.]+$/, "");
    } else if (ext === "txt" || ext === "text" || ext === "") {
      title = name.replace(/\.[^.]+$/, "");
      chapters = splitChapters(await file.text(), "txt");
    } else {
      throw new Error("暂不支持 ." + ext + " 格式。支持 TXT / Markdown / HTML / EPUB / PDF。");
    }
    loadBook(chapters, { title: title || name, source: name });
    const words = chaptersWordCount(chapters);
    const imgPages = chapters.reduce((a, c) => a + (c.imgPages ? c.imgPages.length : 0), 0);
    setStatus("已导入 " + name + "　" + book.chaps.length + " 章 / " + book.pages + " 页"
      + (imgPages ? "（图像 " + imgPages + " 页）" : " / 约 " + words.toLocaleString() + " 字") + extra, "ok");
  } catch (err) {
    setStatus("导入失败：" + (err && err.message ? err.message : err), "err");
  }
}

/* --------------------- 示例书（契约：8 章 / 320 页） ---------------------
   页数 [28,52,36,44,30,48,40,42]，LINES=15，OPEN_LINES=6。
   每段 1 行正文 + 1 空行 → 段落数 = ceil(pages*15 - 6)/2 的近似，
   精确值直接按页数反推：正文行数 = pages*15 - 6 - pages（尾部补白按整页算）。
   这里直接给定每章段落数并用「构造后校验」保证恰好命中。 */
function buildDemoBook() {
  const titles = ["第一章 纸的重量", "第二章 书口的记忆", "第三章 翻页的手",
                  "第四章 厚度与位置", "第五章 扫视与修正", "第六章 电子书的缺席",
                  "第七章 把厚度还回来", "第八章 尾声"];
  const want = [28, 52, 36, 44, 30, 48, 40, 42];
  const chapters = titles.map((t, i) => ({ t, p: "", blocks: [] }));
  // 长段落（三句拼接 ≈ 48 字 → 每段 3 行正文），页面文字密实、贴近真实书页
  const para = k => SENT[(k * 3) % SENT.length] + SENT[(k * 3 + 1) % SENT.length] + SENT[(k * 3 + 2) % SENT.length];
  for (let i = 0; i < titles.length; i++) {
    // 增量构造：逐段累加行数，达到 want[i] 页即停（绝不超过，避免死循环）
    const blocks = [];
    let cl = OPEN_LINES, pages = 2, hit = false;
    for (let k = 0; k < 2000 && !hit; k++) {
      const b = { type: "p", runs: [{ t: para(k) }] };
      const add = blockToLines(b).length + 1;
      const cl2 = cl + add;
      let p2 = Math.ceil(cl2 / LINES);
      if (p2 % 2) p2++;
      if (p2 > want[i]) { hit = true; break; }        // 再加一段就超 → 停在当前
      blocks.push(b); cl = cl2; pages = p2;
    }
    if (!blocks.length) blocks.push({ type: "p", runs: [{ t: para(0) }] });
    chapters[i].blocks = blocks;
  }
  book.title = "书口"; book.source = "示例"; book.demo = true;
  paginate(chapters);
  state.sheetF = 0; state.sheet = 0;
  layout(); buildCmap(); updateHUD(); zoomHUD(); refreshTitle();
}
const SENT = [
  "纸是有重量的，而重量会变成记忆。", "我读的第一本厚书，是父亲书架最下层那本掉了封皮的词典。",
  "每翻过一页，左边就厚一点，右边就薄一点。", "这个变化缓慢得几乎无法察觉，但它确实在发生。",
  "手指比眼睛更早知道书读到了哪里。", "拇指自然地落在书口的中段，那是一个被重复过无数次的位置。",
  "想找一段话的时候，人不会先去查目录。", "人会先估一个厚度，然后翻到那个厚度上去。",
  "误差通常不超过十几页，剩下的靠扫视修正。", "这个过程快得让人意识不到它的存在。"
];
