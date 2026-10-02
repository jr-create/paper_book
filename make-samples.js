/* Kookit 格式样张生成器：FB2 / DOCX / MOBI / CBZ / CBT（最小手工构造，零第三方依赖） */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "_browser");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const save = (name, data) => { fs.writeFileSync(path.join(ROOT, name), data); console.log("  生成", name, (data.length || data.byteLength), "字节"); };

/* ---------------- FB2 ---------------- */
const fb2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info><book-title>测试的小说</book-title><author><first-name>张</first-name><last-name>三</last-name></author></title-info></description>
  <body>
    <section><title><p>第一章 起点</p></title>
      <p>清晨的雾还没有散去，村庄安静地卧在山脚下。少年背起行囊，踏上了通往远方的路。</p>
      <p>路边的野花开得正好。他停下来看了看天色，继续前行。</p>
    </section>
    <section><title><p>第二章 山谷</p></title>
      <p>山谷里有一条小溪，溪水清澈见底。他在溪边歇脚，喝了几口甘甜的溪水。</p>
      <p>远处传来鸟鸣。他知道，目的地快到了。</p>
    </section>
  </body>
</FictionBook>`;
save("sample.fb2", fb2);

/* ---------------- DOCX（真实 zip 结构） ---------------- */
/* 计算 zip 条目 */
function zipStore(entries){
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunks = [], central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const [name, text] of entries){
    const nb = enc.encode(name), db = enc.encode(text), c = crc32(db);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nb, db);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + db.length;
  }
  const cs = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cs.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cs, eocd]);
}

const w = (s) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${s}</w:body></w:document>`;
const wp = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const docXml = w(
  wp("Kookit 引擎 DOCX 集成测试文档") +
  wp("第一段：mammoth 库把 Word 文档转换为 HTML，Kookit 引擎再把它渲染成章节。") +
  wp("第二段：书口项目把这个 HTML 转换为段落流，交给原有的分页与绘制管线。") +
  wp("第三段：如果这一行出现在页面上，说明 DOCX 导入链路完全打通。")
);
const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
save("sample.docx", zipStore([["[Content_Types].xml", ct], ["_rels/.rels", rels], ["word/document.xml", docXml]]));

/* ---------------- MOBI（PalmDB + MOBI6，无压缩正文，标准 232 字节 MOBI 头） ---------------- */
function mobiBuild(){
  const title = "测试MOBI";
  const text = "第一章 云起。\u0000测试 MOBI 文档的第一段内容，章节标题以段落形式出现。\u0000第二章 风往。\u0000测试 MOBI 文档的第二段内容，验证章节抽取与分页渲染。";
  const recs = [Buffer.from(text, "utf8")];   /* 记录1..n：正文（无压缩） */
  const n = recs.length + 1;                  /* record0 + 正文记录 */

  const titleB = Buffer.from(title, "utf8");
  const REC0 = 248;                            /* PalmDOC(16) + MOBI头(232) */

  /* PDB 头（78 字节） */
  const header = Buffer.alloc(78);
  header.write("TestBook", 0, 32, "latin1");
  header.write("BOOK", 60, "latin1");
  header.write("MOBI", 64, "latin1");
  header.writeUInt16BE(n, 76);

  /* 记录偏移表：n × 8 字节 + 2 字节填充 */
  const recList = Buffer.alloc(n * 8 + 2);
  let off = 78 + n * 8 + 2;
  recList.writeUInt32BE(off, 0); recList.writeUInt8(0, 4); recList.writeUInt8(0, 5);
  off += REC0 + titleB.length;
  for (let r = 0; r < recs.length; r++){
    recList.writeUInt32BE(off, (r + 1) * 8);
    recList.writeUInt8((r + 1) >> 8, (r + 1) * 8 + 4);
    recList.writeUInt8((r + 1) & 0xFF, (r + 1) * 8 + 5);
    off += recs[r].length;
  }

  /* record0：PalmDOC 头(16) + MOBI 头(232) + 全名 */
  const rec0 = Buffer.alloc(REC0 + titleB.length);
  rec0.writeUInt16BE(1, 0);                    /* compression = 1（无压缩） */
  rec0.writeUInt16BE(0, 2);
  rec0.writeUInt32BE(Buffer.byteLength(text, "utf8"), 4);
  rec0.writeUInt16BE(recs.length, 8);          /* textRecordCount */
  rec0.writeUInt16BE(4096, 10);                /* recordSize */
  rec0.writeUInt16BE(0, 12);                   /* encryption = 0 */
  rec0.writeUInt16BE(0, 14);
  rec0.write("MOBI", 16, "latin1");
  rec0.writeUInt32BE(232, 20);                 /* MOBI 头长度（标准全量） */
  rec0.writeUInt32BE(2, 24);                   /* type = mobipocket book */
  rec0.writeUInt32BE(65001, 28);               /* text encoding = UTF-8 */
  rec0.writeUInt32BE(1, 32);                   /* uniqueID */
  rec0.writeUInt32BE(6, 36);                   /* file version */
  rec0.writeUInt32BE(0xFFFFFFFF, 40);          /* orthographicIndex */
  rec0.writeUInt32BE(0xFFFFFFFF, 44);          /* inflectionIndex */
  rec0.writeUInt32BE(0xFFFFFFFF, 48); rec0.writeUInt32BE(0xFFFFFFFF, 52);
  rec0.writeUInt32BE(0xFFFFFFFF, 56); rec0.writeUInt32BE(0xFFFFFFFF, 60);
  rec0.writeUInt32BE(0xFFFFFFFF, 64); rec0.writeUInt32BE(0xFFFFFFFF, 68);
  rec0.writeUInt32BE(0xFFFFFFFF, 72); rec0.writeUInt32BE(0xFFFFFFFF, 76);
  rec0.writeUInt32BE(0xFFFFFFFF, 80);          /* firstHuffmanRecord... */
  rec0.writeUInt32BE(0xFFFFFFFF, 84); rec0.writeUInt32BE(0xFFFFFFFF, 88);
  rec0.writeUInt32BE(0xFFFFFFFF, 92); rec0.writeUInt32BE(0xFFFFFFFF, 96);
  rec0.writeUInt32BE(0xFFFFFFFF, 100);
  rec0.writeUInt32BE(0xFFFFFFFF, 104);         /* firstBookmark */
  rec0.writeUInt32BE(0xFFFFFFFF, 108);         /* firstImage = 无 */
  rec0.write("ISLAND", 116, "latin1");         /* huffman record offset 处常见值区（保留） */
  rec0.writeUInt32BE(0, 124);                  /* EXTH flags = 无 EXTH */
  rec0.writeUInt32BE(32, 128);                 /* unknown 常见值 */
  rec0.writeUInt32BE(0xFFFFFFFF, 132);         /* firstContentRecord */
  rec0.writeUInt32BE(recs.length - 1, 136);    /* lastContentRecord（0 基，含 rec0 偏移） */
  rec0.writeUInt32BE(0xFFFFFFFF, 140); rec0.writeUInt32BE(0xFFFFFFFF, 144);
  rec0.writeUInt16BE(5, 152);                  /* minor version */
  rec0.writeUInt16BE(0, 154); rec0.writeUInt32BE(0, 156); rec0.writeUInt32BE(0, 160);
  rec0.writeUInt32BE(0, 164);                  /* DRP offset */
  rec0.writeUInt32BE(0, 168); rec0.writeUInt32BE(0, 172); rec0.writeUInt32BE(0, 176);
  rec0.writeUInt32BE(0xFFFFFFFF, 180);         /* firstCompilationDataSection */
  rec0.writeUInt32BE(0xFFFFFFFF, 184);         /* numCompilationDataSection */
  rec0.writeUInt32BE(0xFFFFFFFF, 188); rec0.writeUInt32BE(0xFFFFFFFF, 192);
  rec0.writeUInt32BE(0xFFFFFFFF, 196); rec0.writeUInt32BE(0xFFFFFFFF, 200);
  rec0.writeUInt32BE(0xFFFFFFFF, 204); rec0.writeUInt32BE(0xFFFFFFFF, 208);
  rec0.writeUInt32BE(0, 212);                  /* extraRecordDataFlags = 0（无额外字节） */
  rec0.writeUInt32BE(0xFFFFFFFF, 216);         /* INDX record = 无 */
  rec0.writeUInt32BE(REC0, 84);                /* 全名偏移（相对 record0） */
  rec0.writeUInt32BE(titleB.length, 88);       /* 全名长度 */
  titleB.copy(rec0, REC0);

  return Buffer.concat([header, recList, rec0, ...recs]);
}
save("sample.mobi", mobiBuild());

/* ---------------- CBZ / CBT ---------------- */
const W = 480, H = 640;
function bmpPage(n){
  const rowSize = (W * 3 + 3) & ~3;
  const data = Buffer.alloc(rowSize * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++){
      const p = y * rowSize + x * 3;
      data[p] = (40 + n * 50) & 0xFF; data[p + 1] = (y / H * 255) | 0; data[p + 2] = (x / W * 255) | 0;
    }
  const fh = Buffer.alloc(14), ih = Buffer.alloc(40);
  fh.write("BM", 0, "latin1"); fh.writeUInt32LE(54 + data.length, 2); fh.writeUInt32LE(54, 10);
  ih.writeUInt32LE(40, 0); ih.writeInt32LE(W, 4); ih.writeInt32LE(H, 8); ih.writeUInt16LE(1, 12); ih.writeUInt16LE(24, 14);
  ih.writeUInt32LE(data.length, 20);
  return Buffer.concat([fh, ih, data]);
}
save("sample.cbz", zipStore([["page001.bmp", bmpPage(0)], ["page002.bmp", bmpPage(1)], ["page003.bmp", bmpPage(2)]]));

/* tar（512 字节块，USTAR） */
function tarStore(files){
  const chunks = [];
  for (const [name, data] of files){
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf8");
    h.write("0000644\0", 100, "utf8");
    h.write("0000000\0", 108, "utf8");
    h.write("0000000\0", 116, "utf8");
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "utf8");
    h.write(String(Math.floor(Date.now() / 1000)).padStart(11, "0") + "\0", 136, "utf8");
    h.write("        ", 148, "utf8");                    /* checksum 占位 */
    h.write("0", 156, "utf8");
    h.write("ustar\000", 257, "utf8");
    h.write("00", 263, "utf8");
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    chunks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
save("sample.cbt", tarStore([["p1.bmp", bmpPage(3)], ["p2.bmp", bmpPage(4)]]));

/* ---------------- EPUB（复用 zipStore：jszip/fflate 均支持 STORE 条目） ---------------- */
function zipStoreBin(entries){
  /* zipStore 的二进制安全版：data 可为 string 或 Uint8Array/Buffer */
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, raw] of entries){
    const nb = Buffer.from(name);
    const db = (raw instanceof Uint8Array) ? Buffer.from(raw) : enc.encode(String(raw));
    const c = crc32(db);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(db.length, 18); lh.writeUInt32LE(db.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nb, db);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(db.length, 20); ch.writeUInt32LE(db.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + db.length;
  }
  const cs = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cs.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cs, eocd]);
}

function epubBuild(){
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const files = [
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
    ["OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Kookit EPUB 测试书</dc:title><dc:creator>测试作者</dc:creator><dc:identifier id="bid">kookit-test-001</dc:identifier><dc:language>zh</dc:language><meta property="dcterms:modified">2024-01-01T00:00:00Z</meta></metadata><manifest><item id="ncx" href="NCX" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="img1" href="img/pic.png" media-type="image/png"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`],
    ["OEBPS/NCX", `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Kookit EPUB 测试书</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>第一章 起点</text></navLabel><content src="c1.xhtml"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>第二章 山谷</text></navLabel><content src="c2.xhtml"/></navPoint></navMap></ncx>`],
    ["OEBPS/c1.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章 起点</title></head><body><h1>第一章 起点</h1><p>清晨的雾还没有散去，村庄安静地卧在山脚下。少年背起行囊，踏上了通往远方的路。</p><p>路边的野花开得正好。</p><img src="img/pic.png" alt="图"/></body></html>`],
    ["OEBPS/img/pic.png", png1x1],
    ["OEBPS/c2.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章 山谷</title></head><body><h1>第二章 山谷</h1><p>山谷里有一条小溪，溪水清澈见底。</p><p>远处传来鸟鸣。</p></body></html>`]
  ];
  return zipStoreBin(files);
}
save("sample.epub", epubBuild());

/* ---------------- TXT（GBK 编码，验证 chardet 探测） ---------------- */
const iconv = (() => {
  try { return require("iconv-lite"); } catch (_) { }
  try { return require(process.env.TEMP + "/kookit-build/node_modules/iconv-lite"); } catch (_) { return null; }
})();
if (iconv){
  const gbk = iconv.encode("第一章 云起。\n这是 GBK 编码的测试文本，用来验证 Kookit 引擎的 chardet 探测。\n第二章 风往。\n引擎应当自动识别编码并正确解码全文。", "gbk");
  save("sample-gbk.txt", gbk);
  console.log("  （iconv-lite 可用，已生成 GBK TXT）");
} else {
  save("sample-gbk.txt", Buffer.from("第一章 云起。\n这是 GBK 编码的测试文本。\n第二章 风往。\n引擎应当自动识别编码并正确解码全文。", "utf8"));
  console.log("  （iconv-lite 不可用，GBK TXT 退化为 UTF-8 内容——探测断言跳过）");
}

/* ---------------- MD / HTML（走 Kookit MdRender / HtmlRender） ---------------- */
save("sample.md", [
  "# 第一章 甲",
  "",
  "这是 **Markdown 加粗** 的测试段落。",
  "",
  "## 第二节",
  "",
  "更多内容，验证 marked 渲染与章节切分。",
  "",
  "# 第二章 乙",
  "",
  "第二章的正文内容。",
  ""
].join("\n"));

save("sample.html", `<!doctype html>
<html><head><meta charset="utf-8"><title>Kookit HTML 测试</title></head>
<body>
  <h1>第一章 甲</h1>
  <p>这是 HTML 测试的第一段。</p>
  <p>第二段带 <b>加粗</b> 内容。</p>
  <h1>第二章 乙</h1>
  <p>第二章的正文内容。</p>
</body></html>`);

/* ---------------- PDF（4 页 + /Info 书名 + /Outlines 两章，dest 指向页对象） ---------------- */
function pdfBuild(){
  const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, "0");
  const utf16hex = s => { let out = ""; for (const ch of s){ const c = ch.codePointAt(0); if(c > 0xFFFF){ const v = c - 0x10000; out += hex(0xD800 + (v >> 10), 4) + hex(0xDC00 + (v & 0x3FF), 4); } else out += hex(c, 4); } return out; };
  class PB {
    constructor(){ this.chunks = []; this.len = 0; this.offsets = new Map(); }
    push(buf){ this.chunks.push(buf); this.len += buf.length; return this.len; }
    raw(str){ return this.push(Buffer.from(str, "latin1")); }
    obj(num, body){ const off = this.len; this.offsets.set(num, off); this.raw(num + " 0 obj\n" + body + "\nendobj\n"); return off; }
    stream(num, dictExtra, data){ const off = this.len; this.offsets.set(num, off); this.raw(num + " 0 obj\n<< " + dictExtra + " /Length " + data.length + " >>\nstream\n"); this.push(data); this.raw("\nendstream\nendobj\n"); return off; }
    bytes(){ return Buffer.concat(this.chunks); }
  }
  const b = new PB();
  b.raw("%PDF-1.7\n");
  b.push(Buffer.from([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
  const pageTexts = [
    "第一章 甲：Kookit PDF 引擎路线测试。",
    "第一页补充内容。",
    "第二章 乙：目录跳转与原版渲染验证。",
    "最后一页收尾。"
  ];
  /* 页对象 3..6，内容流 10..13，字体 5，Info 20，Outlines 21..23，Catalog 24 */
  for (let p = 0; p < 4; p++){
    const content = "BT /F1 14 Tf 50 750 Td <" + utf16hex(pageTexts[p]) + "> Tj ET";
    b.obj(3 + p, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents " + (10 + p) + " 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
    b.stream(10 + p, "", Buffer.from(content, "latin1"));
  }
  b.obj(2, "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>");
  b.obj(7, "<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /UniGB-UCS2-H >>");
  b.obj(20, "<< /Title <FEFF" + utf16hex("Kookit PDF 测试书") + "> /Producer kookit-e2e >>");
  b.obj(21, "<< /Type /Outlines /First 22 0 R /Last 23 0 R /Count 2 >>");
  b.obj(22, "<< /Title <FEFF" + utf16hex("第一章 甲") + "> /Parent 21 0 R /Next 23 0 R /Dest [3 0 R /XYZ null null null] >>");
  b.obj(23, "<< /Title <FEFF" + utf16hex("第二章 乙") + "> /Parent 21 0 R /Prev 22 0 R /Dest [4 0 R /XYZ null null null] >>");
  b.obj(24, "<< /Type /Catalog /Pages 2 0 R /Outlines 21 0 R >>");
  /* 字体引用统一为 7 0 R：重写页对象字典（覆盖 offsets，前面对象作废） */
  for (let p = 0; p < 4; p++){
    b.obj(3 + p, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents " + (10 + p) + " 0 R /Resources << /Font << /F1 7 0 R >> >> >>");
  }
  b.obj(2, "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>");
  const xrefPos = b.len;
  b.raw("xref\n0 25\n");
  b.raw("0000000000 65535 f \n");
  for (let num = 1; num <= 24; num++){
    const e = b.offsets.get(num);
    if (e === undefined && num !== 1){ /* 未定义对象写自由项 */ b.raw("0000000000 65535 f \n"); }
    else b.raw(String(e || 0).padStart(10, "0") + " 00000 n \n");
  }
  b.raw("trailer\n<< /Size 25 /Root 24 0 R /Info 20 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n");
  return b.bytes();
}
save("sample.pdf", pdfBuild());

/* ---------------- CB7（7z 容器，wasm 解包；不可用时跳过生成） ---------------- */
try {
  const Seven = require(process.env.TEMP + "/kookit-build/node_modules/7z-wasm");
  console.log("  （7z-wasm 可用——但样张走 ComicRender 引擎路线，E2E 直接用 CBZ/CBT 覆盖）");
} catch (_) { /* 7z-wasm 未安装：CB7 由引擎内部解包，无样张也不影响 */ }

console.log("样张目录：", ROOT);
