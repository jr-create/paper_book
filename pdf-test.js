/* =============================================================================
 * pdf-test.js —— 用 Node 内置模块自造 PDF，验证 pdf.js 的文本 / 目录提取能力
 * -----------------------------------------------------------------------------
 * 运行：  node pdf-test.js
 * 只使用 Node 内置模块：fs / path / zlib / vm(不用) —— 不下载任何外部资源。
 *
 * 用例（至少 4 个，实际 7 个）：
 *   1. 基础：2 页，Helvetica + WinAnsiEncoding，字面量字符串 + 经典 xref 表；
 *      3 条 /Outlines，指向第 1 / 2 / 1 页（含 /Dest 数组与 /A /GoTo 两种写法）。
 *   2. Flate 压缩 + 交叉引用流 + /ObjStm 对象流 + PNG Predictor。
 *   3. 中文：/Type0 + /Identity-H + /ToUnicode（bfchar 与 bfrange 数组形式）。
 *   4. 无目录 + 故意写坏 startxref：验证字节扫描兜底，outline 必须是 []。
 *   5. 增量更新（trailer /Prev 链）：新版内容对象必须覆盖旧版。
 *   6. 过滤器与编码补充：ASCIIHexDecode、[/ASCII85Decode /FlateDecode] 链、
 *      RunLengthDecode、TIFF Predictor(2)、简单字体 /Encoding /Differences。
 *   7. 预定义 CJK CMap：GBK-EUC-H / UniGB-UCS2-H（无 /ToUnicode，Word/WPS 导出常见）。
 *   8. 错误路径：/Encrypt 加密文档与非 PDF 输入都必须抛出可读的中文错误。
 * =========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* --------------------------- 从 pdf.js 取出 pdfExtract ------------------------ */
/* pdf.js 是普通脚本（非 ES module），这里用 new Function 求值并取回全局函数，
   避免给 pdf.js 添加 module.exports（会破坏它作为浏览器脚本的纯净性）。 */
const PDF_JS_PATH = path.join(__dirname, 'pdf.js');
const pdfSource = fs.readFileSync(PDF_JS_PATH, 'utf8');
const pdfExtract = new Function(pdfSource + '\n;return pdfExtract;')();

/* --------------------------------- 小工具 ----------------------------------- */

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}
function hex(n, width) { return n.toString(16).toUpperCase().padStart(width, '0'); }
/** JS 字符串 → UTF-16BE 十六进制（用于 PDF 的 /Title 等） */
function utf16hex(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0xFFFF) {
      const v = c - 0x10000;
      out += hex(0xD800 + (v >> 10), 4) + hex(0xDC00 + (v & 0x3FF), 4);
    } else out += hex(c, 4);
  }
  return out;
}
/** 双字节大端十六进制（内容流里的 <....> 字符串） */
function hex2(codes) { return codes.map(c => hex(c, 4)).join(''); }

/** PDF 字节流拼装器：记录每个对象的偏移，方便生成 xref */
class PB {
  constructor() {
    this.chunks = [];
    this.len = 0;
    this.offsets = new Map();
  }
  push(buf) { this.chunks.push(buf); this.len += buf.length; return this.len; }
  raw(str) { return this.push(Buffer.from(str, 'latin1')); }
  obj(num, body) {
    const off = this.len;
    this.offsets.set(num, off);
    this.raw(`${num} 0 obj\n${body}\nendobj\n`);
    return off;
  }
  /** data 为 Buffer，dictExtra 形如 '/Length 12 /Filter /FlateDecode' 之外的东西 */
  stream(num, dictExtra, data) {
    const off = this.len;
    this.offsets.set(num, off);
    this.raw(`${num} 0 obj\n<< ${dictExtra} /Length ${data.length} >>\nstream\n`);
    this.push(data);
    this.raw('\nendstream\nendobj\n');
    return off;
  }
  bytes() { return Buffer.concat(this.chunks); }
  /** 经典 xref 表（subsections: [[start, count], ...]） */
  xrefTable(entries, subsections) {
    const off = this.len;
    this.raw('xref\n');
    for (const [start, count] of subsections) {
      this.raw(`${start} ${count}\n`);
      for (let i = 0; i < count; i++) {
        const num = start + i;
        const e = entries.get(num);
        if (!e || e.free) this.raw('0000000000 65535 f \n');
        else this.raw(`${String(e.offset).padStart(10, '0')} 00000 n \n`);
      }
    }
    return off;
  }
}

function pdfHeader(b) {
  b.raw('%PDF-1.7\n');
  b.push(Buffer.from([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));  // 二进制标记注释
}

/** PNG Predictor(Up, type=2) 编码，用于验证 pdf.js 的 predictor 还原 */
function pngUpEncode(data, rowLen) {
  const out = [];
  let prev = new Uint8Array(rowLen);
  for (let p = 0; p < data.length; p += rowLen) {
    const row = data.subarray(p, p + rowLen);
    out.push(2); // filter type = Up
    for (let i = 0; i < rowLen; i++) out.push((row[i] - prev[i]) & 0xFF);
    prev = row;
  }
  return Buffer.from(out);
}

/** ASCII85 编码（测试用，配合 pdf.js 的 ASCII85Decode） */
function a85Encode(buf) {
  let out = '';
  let i = 0;
  for (; i + 4 <= buf.length; i += 4) {
    const v = ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3];
    if (v === 0) { out += 'z'; continue; }
    let chunk = '', t = v;
    for (let k = 0; k < 5; k++) { chunk = String.fromCharCode(33 + (t % 85)) + chunk; t = Math.floor(t / 85); }
    out += chunk;
  }
  const rem = buf.length - i;
  if (rem > 0) {
    const pad = Buffer.alloc(4); buf.copy(pad, 0, i, i + rem);
    let t = ((pad[0] << 24) >>> 0) + (pad[1] << 16) + (pad[2] << 8) + pad[3];
    let chunk = '';
    for (let k = 0; k < 5; k++) { chunk = String.fromCharCode(33 + (t % 85)) + chunk; t = Math.floor(t / 85); }
    out += chunk.slice(0, rem + 1);
  }
  return out + '~>';
}

/** TIFF Predictor(2) 编码：每行内按字节做差分 */
function tiffEncode(data, rowLen) {
  const out = Buffer.alloc(data.length);
  for (let base = 0; base < data.length; base += rowLen) {
    for (let i = 0; i < rowLen && base + i < data.length; i++) {
      out[base + i] = i === 0 ? data[base] : (data[base + i] - data[base + i - 1]) & 0xFF;
    }
  }
  return out;
}

/** RunLengthDecode 编码（测试用） */
function runLengthEncode(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let n = 1;
    while (i + n < buf.length && n < 127 && buf[i + n] === buf[i]) n++;
    if (n >= 2) {                       // 重复段：128+ 表示重复
      out.push(257 - n, buf[i]);
      i += n;
    } else {
      let j = 0;                        // 字面量段
      while (i + j < buf.length && j < 127 &&
             !(i + j + 1 < buf.length && buf[i + j] === buf[i + j + 1])) j++;
      out.push(j - 1);
      for (let k = 0; k < j; k++) out.push(buf[i + k]);
      i += j;
    }
  }
  out.push(128);
  return Buffer.from(out);
}

/* ============================================================================
 * 用例 1：基础（经典 xref + 字面量字符串 + 标准字体 + 目录）
 * ========================================================================== */
async function test1() {
  console.log('\n[用例 1] 基础：经典 xref 表 / Helvetica WinAnsi / 目录 3 条');
  const b = new PB();
  pdfHeader(b);

  const page1 =
    'BT /F1 24 Tf 72 700 Td (Chapter One) Tj ET\n' +
    'BT /F1 12 Tf 72 680 Td (Hello World of PDF) Tj ET\n' +
    'BT /F1 12 Tf 72 660 Td [(Part) -300 (A)] TJ ET';
  const page2 =
    'BT /F1 24 Tf 72 700 Td (Chapter Two) Tj ET\n' +
    'BT /F1 12 Tf 72 680 Td (Second page body text) Tj ET\n' +
    'BT /F1 12 Tf 14 TL 72 620 Td (Line via Td) Tj T* (Line via Tstar) Tj ET';

  b.obj(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R >>');
  // /Resources 只挂在 Pages 节点上，用来验证沿父节点继承
  b.obj(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 612 792] ' +
           '/Resources << /Font << /F1 7 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b.stream(4, '', Buffer.from(page1, 'latin1'));
  b.obj(5, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>');
  b.stream(6, '', Buffer.from(page2, 'latin1'));
  b.obj(7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  b.obj(8, '<< /Title (PDF Test Document) /Author (Codex Agent) /Producer (pdf-test.js) >>');
  b.obj(9, '<< /Type /Outlines /First 10 0 R /Last 12 0 R /Count 3 >>');
  b.obj(10, `<< /Title <FEFF${utf16hex('第一章 概述')}> /Parent 9 0 R /Next 11 0 R ` +
            '/Dest [3 0 R /XYZ 0 792 0] >>');
  b.obj(11, '<< /Title (Chapter Two) /Parent 9 0 R /Prev 10 0 R /Next 12 0 R /Dest [5 0 R /Fit] >>');
  b.obj(12, '<< /Title (Chapter One Again) /Parent 9 0 R /Prev 11 0 R ' +
            '/A << /S /GoTo /D [3 0 R /Fit] >> >>');

  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 13]]);
  b.raw('trailer\n<< /Size 13 /Root 1 0 R /Info 8 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  console.log('  pages   =', JSON.stringify(res.pages.map(p => p.text)));
  console.log('  outline =', JSON.stringify(res.outline));
  console.log('  info    =', JSON.stringify(res.info));

  check('页数为 2', res.pages.length === 2, res.pages.length);
  const t0 = res.pages[0].text, t1 = res.pages[1].text;
  check('第 1 页含 "Chapter One"', t0.includes('Chapter One'), t0);
  check('第 1 页含 "Hello World of PDF"', t0.includes('Hello World of PDF'), t0);
  check('第 1 页 TJ 负调整插入空格（"Part A"）', t0.includes('Part A'), t0);
  check('第 1 页按行分隔', t0.split('\n').length >= 3, JSON.stringify(t0));
  check('第 2 页含 "Chapter Two"', t1.includes('Chapter Two'), t1);
  check('第 2 页含 "Second page body text"', t1.includes('Second page body text'), t1);
  check('第 2 页 T* 换行生效', t1.includes('Line via Td') && t1.includes('Line via Tstar') &&
        t1.indexOf('Line via Tstar') > t1.indexOf('Line via Td'), JSON.stringify(t1));
  check('目录条数为 3', res.outline.length === 3, JSON.stringify(res.outline));
  check('目录第 1 条标题（中文 UTF-16）', res.outline[0] && res.outline[0].title === '第一章 概述',
        res.outline[0] && res.outline[0].title);
  check('目录第 1 条页序 = 0', res.outline[0] && res.outline[0].page === 0, res.outline[0]);
  check('目录第 2 条标题/页序 = Chapter Two / 1',
        res.outline[1] && res.outline[1].title === 'Chapter Two' && res.outline[1].page === 1,
        JSON.stringify(res.outline[1]));
  check('目录第 3 条（/A /GoTo）页序 = 0',
        res.outline[2] && res.outline[2].title === 'Chapter One Again' && res.outline[2].page === 0,
        JSON.stringify(res.outline[2]));
  check('info.title', res.info.title === 'PDF Test Document', res.info.title);
  check('info.author', res.info.author === 'Codex Agent', res.info.author);
  check('info.pageCount = 2', res.info.pageCount === 2, res.info.pageCount);
}

/* ============================================================================
 * 用例 2：Flate 压缩 + 交叉引用流 + 对象流 /ObjStm + PNG Predictor
 * ========================================================================== */
async function test2() {
  console.log('\n[用例 2] 交叉引用流 + /ObjStm 对象流 + FlateDecode + Predictor');
  const b = new PB();
  pdfHeader(b);

  const page1 = 'BT /F1 18 Tf 72 750 Td (Compressed page one) Tj ET';
  const page2 = 'BT /F1 18 Tf 72 750 Td (Compressed page two) Tj ET';

  // ---- 放进对象流里的对象（1..8）----
  const inStream = [
    [1, '<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 5 0 R >> >> >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 11 0 R >>'],
    [4, '<< /Type /Page /Parent 2 0 R /Contents 12 0 R >>'],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
    [6, '<< /Type /Outlines /First 7 0 R /Last 8 0 R /Count 2 >>'],
    [7, '<< /Title (Compressed One) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>'],
    [8, '<< /Title (Compressed Two) /Parent 6 0 R /Prev 7 0 R /Dest [4 0 R /Fit] >>']
  ];
  let header = '', off = 0;
  const bodies = [];
  for (const [num, body] of inStream) {
    header += `${num} ${off} `;
    bodies.push(body);
    off += Buffer.byteLength(body, 'latin1') + 1;
  }
  const objStmRaw = Buffer.from(header + bodies.join(' '), 'latin1');
  const firstOffset = Buffer.byteLength(header, 'latin1');
  const objStmDict = `/Type /ObjStm /N ${inStream.length} /First ${firstOffset} /Filter /FlateDecode`;
  b.stream(10, objStmDict, zlib.deflateSync(objStmRaw));

  // ---- 压缩的内容流 ----
  b.stream(11, '/Filter /FlateDecode', zlib.deflateSync(Buffer.from(page1, 'latin1')));
  b.stream(12, '/Filter /FlateDecode', zlib.deflateSync(Buffer.from(page2, 'latin1')));

  // ---- 交叉引用流（对象 13），数据经 PNG Up Predictor 编码后再 Flate 压缩 ----
  const W = [1, 2, 1];
  const rowLen = W.reduce((a, c) => a + c, 0);
  const SIZE = 14;
  const xrefStreamOff = b.len;   // 该对象自身的偏移
  const rows = [];
  const pushRow = (type, f2, f3) => {
    const r = [];
    r.push(type & 0xFF);
    r.push((f2 >> 8) & 0xFF, f2 & 0xFF);
    r.push(f3 & 0xFF);
    rows.push(Buffer.from(r));
  };
  pushRow(0, 0, 255);                                  // 对象 0：空闲
  for (let i = 0; i < inStream.length; i++) pushRow(2, 10, i);  // 1..8 在对象流 10 里
  pushRow(0, 0, 0);                                    // 9：未使用
  pushRow(1, b.offsets.get(10), 0);
  pushRow(1, b.offsets.get(11), 0);
  pushRow(1, b.offsets.get(12), 0);
  pushRow(1, xrefStreamOff, 0);                        // 13：交叉引用流自身
  const rawRows = Buffer.concat(rows);
  const xrefData = zlib.deflateSync(pngUpEncode(rawRows, rowLen));

  const xrefDict = `/Type /XRef /Size ${SIZE} /W [${W.join(' ')}] /Index [0 ${SIZE}] ` +
    `/Root 1 0 R /Filter /FlateDecode ` +
    `/DecodeParms << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns ${rowLen} >>`;
  b.stream(13, xrefDict, xrefData);
  b.raw('startxref\n' + xrefStreamOff + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  console.log('  pages   =', JSON.stringify(res.pages.map(p => p.text)));
  console.log('  outline =', JSON.stringify(res.outline));

  check('页数为 2', res.pages.length === 2, res.pages.length);
  check('第 1 页文本（Flate 内容流）',
        res.pages[0].text.includes('Compressed page one'), res.pages[0].text);
  check('第 2 页文本（Flate 内容流）',
        res.pages[1].text.includes('Compressed page two'), res.pages[1].text);
  check('目录条数为 2', res.outline.length === 2, JSON.stringify(res.outline));
  check('目录第 1 条 = Compressed One / 0',
        res.outline[0] && res.outline[0].title === 'Compressed One' && res.outline[0].page === 0,
        JSON.stringify(res.outline[0]));
  check('目录第 2 条 = Compressed Two / 1',
        res.outline[1] && res.outline[1].title === 'Compressed Two' && res.outline[1].page === 1,
        JSON.stringify(res.outline[1]));
  check('info.pageCount = 2', res.info.pageCount === 2, res.info.pageCount);
}

/* ============================================================================
 * 用例 3：中文 + /ToUnicode（bfchar 与 bfrange 数组形式）
 * ========================================================================== */
async function test3() {
  console.log('\n[用例 3] 中文：Type0 / Identity-H / ToUnicode CMap');
  const b = new PB();
  pdfHeader(b);

  const TEXT = '中文测试';
  const codes = [0x0001, 0x0002, 0x0003, 0x0004];

  // ToUnicode CMap：0001 用 beginbfchar；0002-0004 用 beginbfrange 的数组形式
  const cmap =
    '/CIDInit /ProcSet findresource begin\n' +
    '12 dict begin\n' +
    'begincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n' +
    '/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    '1 beginbfchar\n<0001> <4E2D>\nendbfchar\n' +
    '1 beginbfrange\n<0002> <0004> [<6587> <6D4B> <8BD5>]\nendbfrange\n' +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';

  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] ' +
           '/Resources << /Font << /F1 5 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b.stream(4, '', Buffer.from(`BT /F1 24 Tf 72 700 Td <${hex2(codes)}> Tj ET`, 'latin1'));
  b.obj(5, '<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansSC /Encoding /Identity-H ' +
           '/DescendantFonts [6 0 R] /ToUnicode 8 0 R >>');
  b.obj(6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansSC ' +
           '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
           '/FontDescriptor 7 0 R /DW 1000 >>');
  b.obj(7, '<< /Type /FontDescriptor /FontName /NotoSansSC /Flags 4 ' +
           '/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 ' +
           '/CapHeight 700 /StemV 80 >>');
  b.stream(8, '', Buffer.from(cmap, 'latin1'));

  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 9]]);
  b.raw('trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  console.log('  pages[0].text =', JSON.stringify(res.pages[0].text));
  check('页数为 1', res.pages.length === 1, res.pages.length);
  check(`中文经 ToUnicode 正确还原为 "${TEXT}"`, res.pages[0].text.trim() === TEXT,
        JSON.stringify(res.pages[0].text));
  check('无目录时 outline 为 []', Array.isArray(res.outline) && res.outline.length === 0,
        JSON.stringify(res.outline));
}

/* ============================================================================
 * 用例 4：无目录 + startxref 指向错误偏移 → 字节扫描兜底
 * ========================================================================== */
async function test4() {
  console.log('\n[用例 4] 坏 xref：startxref 指向错误偏移，走字节扫描兜底');
  const b = new PB();
  pdfHeader(b);

  const page = 'BT /F1 20 Tf 72 760 Td (Fallback scan works) Tj ET\n' +
               'BT /F1 12 Tf 72 740 Td (No outline here) Tj ET';
  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');   // 故意不含 /Outlines
  b.obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] ' +
           '/Resources << /Font << /F1 5 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b.stream(4, '/Filter /FlateDecode', zlib.deflateSync(Buffer.from(page, 'latin1')));
  b.obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 6]]);
  b.raw('trailer\n<< /Size 6 /Root 1 0 R >>\n');
  // 故意写坏：startxref 指向对象 4 内部（压缩数据中间），而不是真正的 xref 偏移
  const bogus = b.offsets.get(4) + 40;
  b.raw('startxref\n' + bogus + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  console.log('  startxref 真值 =', xrefOff, ' 写入的坏值 =', bogus);
  console.log('  pages   =', JSON.stringify(res.pages.map(p => p.text)));
  console.log('  outline =', JSON.stringify(res.outline));

  check('页数为 1', res.pages.length === 1, res.pages.length);
  check('兜底扫描仍能提出文本', res.pages[0].text.includes('Fallback scan works'), res.pages[0].text);
  check('第 2 行文本也在', res.pages[0].text.includes('No outline here'), res.pages[0].text);
  check('outline 是空数组', Array.isArray(res.outline) && res.outline.length === 0,
        JSON.stringify(res.outline));
}

/* ============================================================================
 * 用例 5：增量更新（trailer /Prev 链）
 * ========================================================================== */
async function test5() {
  console.log('\n[用例 5] 增量更新：新版对象经 /Prev 链覆盖旧版');
  const b = new PB();
  pdfHeader(b);

  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 612 792] ' +
           '/Resources << /Font << /F1 7 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b.stream(4, '', Buffer.from('BT /F1 14 Tf 72 700 Td (Revision One Original) Tj ET', 'latin1'));
  b.obj(5, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>');
  b.stream(6, '', Buffer.from('BT /F1 14 Tf 72 700 Td (Page Two Original) Tj ET', 'latin1'));
  b.obj(7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const rev1 = new Map([
    [1, { offset: b.offsets.get(1) }], [2, { offset: b.offsets.get(2) }],
    [3, { offset: b.offsets.get(3) }], [4, { offset: b.offsets.get(4) }],
    [5, { offset: b.offsets.get(5) }], [6, { offset: b.offsets.get(6) }],
    [7, { offset: b.offsets.get(7) }]
  ]);
  const xref1 = b.xrefTable(rev1, [[0, 8]]);
  b.raw('trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n' + xref1 + '\n%%EOF\n');

  // ---- 第二版：重写对象 3（/Contents 改指新对象 8），新增对象 8 ----
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>');
  b.stream(8, '', Buffer.from('BT /F1 14 Tf 72 700 Td (Revision Two Wins) Tj ET', 'latin1'));

  const rev2 = new Map([
    [3, { offset: b.offsets.get(3) }],
    [8, { offset: b.offsets.get(8) }]
  ]);
  const xref2 = b.xrefTable(rev2, [[0, 1], [3, 1], [8, 1]]);
  b.raw('trailer\n<< /Size 9 /Root 1 0 R /Prev ' + xref1 + ' >>\nstartxref\n' + xref2 + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  console.log('  pages   =', JSON.stringify(res.pages.map(p => p.text)));

  check('页数为 2', res.pages.length === 2, res.pages.length);
  check('第 1 页取到新版内容（/Prev 链正确）',
        res.pages[0].text.includes('Revision Two Wins'), res.pages[0].text);
  check('旧版内容已被覆盖', !res.pages[0].text.includes('Revision One Original'), res.pages[0].text);
  check('第 2 页仍来自旧版 xref 段',
        res.pages[1].text.includes('Page Two Original'), res.pages[1].text);
}

/* ============================================================================
 * 用例 6：其它过滤器 + Predictor(2) + /Differences 字形名编码
 * ========================================================================== */
async function test6() {
  console.log('\n[用例 6] 过滤器补充：ASCIIHex / ASCII85+Flate / RunLength / TIFF Predictor / Differences');
  const b = new PB();
  pdfHeader(b);

  const p1 = 'BT /F2 20 Tf 72 760 Td (ABC) Tj ET';                     // A=endash B=bullet C=quotedbl
  const p2 = 'BT /F1 20 Tf 72 760 Td (ASCII85 plus Flate works) Tj ET';
  const p3 = 'BT /F1 20 Tf 72 760 Td (TIFF predictor row) Tj ET';
  const p4 = 'BT /F1 20 Tf 72 760 Td (RunLength decoded text) Tj ET';

  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 /MediaBox [0 0 612 792] ' +
           '/Resources << /Font << /F1 11 0 R /F2 12 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b.stream(4, '/Filter /ASCIIHexDecode', Buffer.from(Buffer.from(p1, 'latin1').toString('hex') + '>', 'latin1'));
  b.obj(5, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>');
  b.stream(6, '/Filter [/ASCII85Decode /FlateDecode]',
           Buffer.from(a85Encode(zlib.deflateSync(Buffer.from(p2, 'latin1'))), 'latin1'));
  b.obj(7, '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>');
  b.stream(8, `/Filter /FlateDecode /DecodeParms << /Predictor 2 /Colors 1 ` +
              `/BitsPerComponent 8 /Columns ${Buffer.byteLength(p3, 'latin1')} >>`,
           zlib.deflateSync(tiffEncode(Buffer.from(p3, 'latin1'), Buffer.byteLength(p3, 'latin1'))));
  b.obj(9, '<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>');
  b.stream(10, '/Filter /RunLengthDecode', runLengthEncode(Buffer.from(p4, 'latin1')));
  b.obj(11, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  b.obj(12, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ' +
            '/Encoding << /BaseEncoding /WinAnsiEncoding ' +
            '/Differences [65 /endash 66 /bullet 67 /quotedbl ] >> >>');

  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 13]]);
  b.raw('trailer\n<< /Size 13 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  console.log('  pages =', JSON.stringify(res.pages.map(p => p.text)));

  check('页数为 4', res.pages.length === 4, res.pages.length);
  check('/Differences 字形名映射（endash bullet quotedbl）',
        res.pages[0].text === '\u2013\u2022"', JSON.stringify(res.pages[0].text));
  check('ASCIIHexDecode', p1.includes('ABC') && res.pages[0].text.length === 3, res.pages[0].text);
  check('[/ASCII85Decode /FlateDecode] 过滤器链',
        res.pages[1].text.includes('ASCII85 plus Flate works'), res.pages[1].text);
  check('TIFF Predictor(2)',
        res.pages[2].text.includes('TIFF predictor row'), res.pages[2].text);
  check('RunLengthDecode',
        res.pages[3].text.includes('RunLength decoded text'), res.pages[3].text);
}

/* ============================================================================
 * 用例 7：预定义 CJK CMap（GBK-EUC-H / UniGB-UCS2-H）—— 无 /ToUnicode 的中文 PDF
 * ========================================================================== */
async function test7() {
  console.log('\n[用例 7] 预定义 CJK CMap：GBK-EUC-H / UniGB-UCS2-H（无 ToUnicode）');
  let canGbk = true;
  try { new TextDecoder('gbk').decode(new Uint8Array([0xD6, 0xD0])); } catch (e) { canGbk = false; }
  if (!canGbk) {
    console.log('  SKIP  当前 Node 构建的 TextDecoder 不支持 gbk（缺少完整 ICU），跳过本用例');
    return;
  }
  const b = new PB();
  pdfHeader(b);

  // 中=D6D0 文=CEC4 发=B7A2 票=C6B1（GBK 字节）
  const gbkHex = 'D6D0CEC4B7A2C6B1';
  // UniGB-UCS2-H 的字符码就是 Unicode 码值：中=4E2D 文=6587
  const ucs2Hex = '4E2D6587';

  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 595 842] ' +
           '/Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b.stream(4, '', Buffer.from(`BT /F1 20 Tf 72 760 Td <${gbkHex}> Tj ET`, 'latin1'));
  b.obj(5, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>');
  b.stream(6, '', Buffer.from(`BT /F2 20 Tf 72 760 Td <${ucs2Hex}> Tj ET`, 'latin1'));
  b.obj(7, '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /GBK-EUC-H ' +
           '/DescendantFonts [9 0 R] >>');
  b.obj(8, '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /UniGB-UCS2-H ' +
           '/DescendantFonts [9 0 R] >>');
  b.obj(9, '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /SimSun ' +
           '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>');

  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 10]]);
  b.raw('trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  console.log('  pages =', JSON.stringify(res.pages.map(p => p.text)));
  check('页数为 2', res.pages.length === 2, res.pages.length);
  check('GBK-EUC-H 双字节解码 = 中文发票', res.pages[0].text.trim() === '中文发票',
        JSON.stringify(res.pages[0].text));
  check('UniGB-UCS2-H 按 Unicode 码值解码 = 中文', res.pages[1].text.trim() === '中文',
        JSON.stringify(res.pages[1].text));
}

/* ============================================================================
 * 用例 8：错误路径（加密 PDF 明确报错、非 PDF 输入报错）
 * ========================================================================== */
async function test8() {
  console.log('\n[用例 8] 错误路径：/Encrypt 加密文档、非 PDF 输入');
  const b = new PB();
  pdfHeader(b);
  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R >>');
  b.obj(4, '<< /Filter /Standard /V 1 /R 2 /O <00112233445566778899AABBCCDDEEFF> ' +
           '/U <FFEEDDCCBBAA99887766554433221100> /P -44 >>');
  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 5]]);
  b.raw('trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n');

  let msg = '';
  try { await pdfExtract(b.bytes()); } catch (e) { msg = e.message; }
  console.log('  加密文件错误信息 =', JSON.stringify(msg));
  check('加密 PDF 抛出中文错误且提到加密', msg.includes('加密'), msg);

  let msg2 = '';
  try { await pdfExtract(Buffer.from('not a pdf at all', 'latin1')); } catch (e) { msg2 = e.message; }
  console.log('  非 PDF 错误信息 =', JSON.stringify(msg2));
  check('非 PDF 输入抛出中文错误', msg2.includes('PDF') && /[\u4e00-\u9fa5]/.test(msg2), msg2);
}

/* ============================================================================
 * 用例 9：LaTeX / pandoc（pypdf 产出）—— 绝对定位文本 + 字符串命名目标 + 层级目录
 * ----------------------------------------------------------------------------
 * 这一份真实文档（hello-algo）暴露了三个问题，全部在这里固化成回归：
 *   ① 词距与缩进是「位置」不是空格字符：
 *        BT /F1 9.9 Tf 183.258 0 Td[...]TJ ET
 *      只按 Y 分行的解析器会把 `fn constant(n: i32)` 读成 `fnconstant(n:i32)`。
 *   ② 目录目标是字符串形式的命名目标：/D (chapter\052\0562)，
 *      只认 PDF_Name 会让 104 条目录全部丢失。
 *   ④ 每页用 `q 1 0 0 1 72 720 cm` 建立坐标系，不算 CTM 的话所有 Y 都是负的。
 * ========================================================================== */
async function test9() {
  console.log('\n[用例 9] LaTeX/pandoc：cm 坐标 + 词距/缩进 + 字符串命名目标 + 层级目录');
  const b = new PB();
  pdfHeader(b);

  // 两行「代码」：用绝对 X 摆放每个词，词距与缩进全靠位置表达
  // 行1: `fn add(n: i32) -> i32 {`  行2: `    return n + 1;`（4 空格缩进）
  // 坐标按真实排版给：10pt 字体下窄字符约 5pt 宽、一个空格也是 5pt。
  // 目标文本：  `fn add(n: i32)`   —— 词距用 5pt 的空隙表达（没有任何空格字符）
  //             `  return n`       —— 行首缩进 10pt = 2 个空格
  // 每段宽度：fn=10  add=15  n:=10  i32=15  return=30  n=5
  const codePage =
    'q 1 0 0 1 72 720 cm\n' +
    'BT /F1 10 Tf 14 -20 Td (Intro) Tj ET\n' +      // 版心左边距 = 14
    'BT /F1 10 Tf 14 -32 Td (fn) Tj ET\n' +         // 14 → 24
    'BT /F1 10 Tf 29 -32 Td (add) Tj ET\n' +        // 空隙 5pt = 一个空格
    'BT /F1 10 Tf 44 -32 Td (n:) Tj ET\n' +         // 紧跟 add（无空格）
    'BT /F1 10 Tf 59 -32 Td (i32) Tj ET\n' +        // 空隙 5pt = 一个空格
    'BT /F1 10 Tf 24 -44 Td (return) Tj ET\n' +     // 缩进 10pt = 2 个空格
    'BT /F1 10 Tf 59 -44 Td (n) Tj ET\n' +          // 空隙 5pt
    'Q\n';

  b.obj(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 20 0 R /Names 30 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 /MediaBox [0 0 612 792] ' +
           '/Resources << /Font << /F1 9 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b.stream(4, '', Buffer.from(codePage, 'latin1'));
  b.obj(5, '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>');
  b.stream(6, '', Buffer.from('BT /F1 12 Tf 72 700 Td (Second) Tj ET\n', 'latin1'));
  b.obj(7, '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>');
  b.stream(8, '', Buffer.from('BT /F1 12 Tf 72 700 Td (Third) Tj ET\n', 'latin1'));
  b.obj(9, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  // 目录：顶层 2 条 + 二级 3 条，目标全部是**字符串**形式的命名目标。
  // 分层必须走 /First 子链，不能把子节点接到父节点的 /Next 上（那样就变成同级了）。
  b.obj(20, '<< /Type /Outlines /First 21 0 R /Last 24 0 R /Count 5 >>');
  b.obj(21, '<< /Title (Chapter One) /Parent 20 0 R /First 22 0 R /Last 23 0 R /Count 2 ' +
            '/Next 24 0 R /A << /S /GoTo /D (chapter\\052\\0561) >> >>');
  b.obj(22, '<< /Title (Section 1.1) /Parent 21 0 R /Next 23 0 R ' +
            '/A << /S /GoTo /D (section\\052\\0561) >> >>');
  b.obj(23, '<< /Title (Section 1.2) /Parent 21 0 R /Prev 22 0 R ' +
            '/A << /S /GoTo /D (section\\052\\0562) >> >>');
  b.obj(24, '<< /Title (Chapter Two) /Parent 20 0 R /Prev 21 0 R /First 25 0 R /Last 25 0 R ' +
            '/Count 1 /A << /S /GoTo /D (chapter\\052\\0562) >> >>');
  b.obj(25, '<< /Title (Section 2.1) /Parent 24 0 R ' +
            '/A << /S /GoTo /D (section\\052\\0563) >> >>');

  // 名字树：键与上面的 /D 完全对应
  b.obj(31, '<< /Names [ (chapter\\052\\0561) [3 0 R /XYZ 0 792 null] ' +
            '(chapter\\052\\0562) [5 0 R /XYZ 0 792 null] ' +
            '(section\\052\\0561) [3 0 R /XYZ 0 700 null] ' +
            '(section\\052\\0562) [3 0 R /XYZ 0 600 null] ' +
            '(section\\052\\0563) [7 0 R /XYZ 0 700 null] ] >>');
  b.obj(30, '<< /Dests 31 0 R >>');

  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 32]]);
  b.raw('trailer\n<< /Size 32 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n');

  const res = await pdfExtract(b.bytes());
  const t0 = res.pages[0].text;
  console.log('  第 1 页 =', JSON.stringify(t0));
  console.log('  outline =', JSON.stringify(res.outline));

  check('① 词距按位置还原（5pt 空隙 → 1 个空格，0pt 空隙 → 不补）',
        t0.includes('fn addn: i32'), JSON.stringify(t0));
  check('① 不再出现粘连的 "fnadd"', !t0.includes('fnadd'), JSON.stringify(t0));
  check('① 行首缩进按版心左边距还原（return 行缩进 2 个字宽）',
        /\n {2}return n/.test(t0), JSON.stringify(t0));
  check('④ CTM 生效：文本进入正常页面坐标（按 Y 正确分 3 行）',
        t0.split('\n').filter(Boolean).length === 3, JSON.stringify(t0.split('\n')));

  check('② 字符串命名目标解析成功，目录 5 条', res.outline.length === 5, res.outline.length);
  check('② 命名目标指向正确页（Chapter One→0, Chapter Two→1, Section 2.1→2）',
        res.outline[0] && res.outline[0].page === 0 && res.outline[3] && res.outline[3].page === 1 &&
        res.outline[4] && res.outline[4].page === 2,
        JSON.stringify(res.outline.map(o => [o.title, o.page])));
  check('② 保留层级 depth（1/2/2/1/2）',
        JSON.stringify(res.outline.map(o => o.depth)) === JSON.stringify([1, 2, 2, 1, 2]),
        JSON.stringify(res.outline.map(o => o.depth)));

  // q/Q 必须让 CTM 正确回滚：第二个 q 块里的 cm 不应泄漏到后面
  const b2 = new PB();
  pdfHeader(b2);
  const leaky =
    'q 1 0 0 1 100 500 cm\nBT /F1 10 Tf 0 0 Td (Translated) Tj ET\nQ\n' +
    'BT /F1 10 Tf 0 10 Td (AfterRestore) Tj ET\n';
  b2.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b2.obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] ' +
            '/Resources << /Font << /F1 5 0 R >> >> >>');
  b2.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  b2.stream(4, '', Buffer.from(leaky, 'latin1'));
  b2.obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const e2 = new Map();
  for (const [num, off] of b2.offsets) e2.set(num, { offset: off });
  const x2 = b2.xrefTable(e2, [[0, 6]]);
  b2.raw('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + x2 + '\n%%EOF\n');
  const r2 = await pdfExtract(b2.bytes());
  const rt = r2.pages[0].text;
  console.log('  q/Q 用例 =', JSON.stringify(rt));
  check('④ Q 之后 CTM 正确回滚（两行不因平移而并成一行）',
        rt.includes('Translated') && rt.includes('AfterRestore') &&
        rt.indexOf('AfterRestore') > rt.indexOf('Translated'), JSON.stringify(rt));
}

/* ============================================================================
 * 用例 10：内嵌图 —— /Indexed 调色板 + /SMask 透明 + withImages 位置回传
 * ----------------------------------------------------------------------------
 * hello-algo 暴露的三个缺口，全部在这里固化成回归：
 *   ③b-1 内嵌图用 [ /Indexed /DeviceRGB hival <lookup> ] 调色板颜色空间，
 *        只认 DeviceRGB/DeviceGray 的话 482 张示意图全部解不出来。
 *   ③b-2 带 /SMask 的图要把黑背景合成成透明（RGBA），否则黑块压住正文。
 *   ③b-3 pdfExtract({withImages:true}) 必须回传「图画在第几行之后」，
 *        这样「上面正文、中间示意图」的页面不用整页降级成图像模式。
 * ========================================================================== */
async function test10() {
  console.log('\n[用例 10] 内嵌图：/Indexed 调色板 + /SMask 透明 + withImages 位置');
  const b = new PB();
  pdfHeader(b);

  // 2x2 像素调色板图：索引 0=白 1=红 2=蓝。每行 2 字节 + 2 字节行填充（宽度 2，无需填充）。
  const iw = 2, ih = 2;
  const rawIdx = Buffer.from([0, 1, 2, 1]);          // 白 红 / 蓝 红
  const idxZ = zlib.deflateSync(rawIdx);
  const lookup = Buffer.from([255, 0, 0, 255, 255, 255, 0, 0, 255]); // 白 红 蓝（RGB）
  // SMask：同尺寸灰度，0=全透明 255=不透明。左列透明、右列不透明。
  const smaskZ = zlib.deflateSync(Buffer.from([0, 255, 0, 255]));

  // 注意：b.stream 会自己包一层 "<< ... >>"，dictExtra 只给字典体内内容
  const imgDict =
    '/Type /XObject /Subtype /Image /Width 2 /Height 2 ' +
    '/ColorSpace [ /Indexed /DeviceRGB 2 <' + lookup.toString('hex').toUpperCase() + '> ] ' +
    '/BitsPerComponent 8 /Filter /FlateDecode /SMask 12 0 R';
  b.obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  b.obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] ' +
           '/Resources << /Font << /F1 9 0 R >> /XObject << /Im1 10 0 R >> >> >>');
  b.obj(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>');
  // 两行文本夹一张图：图在两行之间（Do 之前已输出 1 行文字）
  const content =
    'BT /F1 12 Tf 72 700 Td (Line one) Tj ET\n' +
    'q 100 0 0 100 72 500 cm /Im1 Do Q\n' +
    'BT /F1 12 Tf 72 660 Td (Line two) Tj ET\n';
  b.stream(4, '', Buffer.from(content, 'latin1'));
  b.obj(9, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  b.stream(10, imgDict, idxZ);
  // 调色板以流形式存在（reference 形式）的第二张图：索引 0=黑 1=白
  const pal2 = Buffer.from([0, 0, 0, 255, 255, 255]);
  b.stream(11, '/Filter /FlateDecode', zlib.deflateSync(pal2));
  b.stream(12, '/Type /XObject /Subtype /Image /Width 2 /Height 2 ' +
            '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', smaskZ);

  const entries = new Map();
  for (const [num, off] of b.offsets) entries.set(num, { offset: off });
  const xrefOff = b.xrefTable(entries, [[0, 13]]);
  b.raw('trailer\n<< /Size 13 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF\n');

  // ---- 不带图：文本不受影响
  const plain = await pdfExtract(b.bytes());
  check('③b 文本模式不受 withImages 改动影响（两行都在）',
        plain.pages[0].text.includes('Line one') && plain.pages[0].text.includes('Line two'),
        JSON.stringify(plain.pages[0].text));

  // ---- withImages：解出调色板图 + SMask 合成 + 位置
  const res = await pdfExtract(b.bytes(), { withImages: true });
  const imgs = res.pages[0].images || [];
  console.log('  withImages images =', JSON.stringify(imgs.map(im => ({
    line: im.line, kind: im.info && im.info.kind, w: im.info && im.info.width,
    h: im.info && im.info.height, comps: im.info && im.info.comps }))));
  check('③b withImages 检出 1 张内嵌图', imgs.length === 1, imgs.length);

  const info = imgs[0] && imgs[0].info;
  check('③b 调色板图解成 raw 且尺寸正确（2x2）',
        info && info.kind === 'raw' && info.width === 2 && info.height === 2,
        JSON.stringify(info));
  check('③b SMask 合成后是 RGBA（comps=4）',
        info && info.comps === 4, info && info.comps);
  // 数据校验：左列（透明）alpha=0，右列不透明且颜色 = 红(索引1) / 蓝(索引2)
  if (info && info.kind === 'raw' && info.comps === 4) {
    const d = info.data;
    check('③b SMask 左列 alpha=0（黑背景变透明）',
          d[3] === 0 && d[4*2+3] === 0, [d[3], d[4*2+3]]);
    // 像素按行展开。lookup 实际 = 红(索引0) 白(索引1) 蓝(索引2)。
    // rawIdx=[0,1, 2,1]：(0,0)=红 (1,0)=白 / (0,1)=蓝 (1,1)=白
    const px = (x, y) => { const o = (y*2 + x)*4; return [d[o], d[o+1], d[o+2], d[o+3]]; };
    const p00 = px(0, 0), p10 = px(1, 0), p01 = px(0, 1), p11 = px(1, 1);
    check('③b 调色板索引 0 → 红（palette 前 3 字节 255,0,0）',
          p00[0] === 255 && p00[1] === 0 && p00[2] === 0, p00);
    check('③b 调色板索引 1 → 白 255,255,255', p10[0] === 255 && p10[1] === 255 && p10[2] === 255, p10);
    check('③b 调色板索引 2 → 蓝 0,0,255', p01[0] === 0 && p01[1] === 0 && p01[2] === 255, p01);
    check('③b 不透明区 alpha=255（SMask 右列 255）', p10[3] === 255 && p11[3] === 255, [p10[3], p11[3]]);
    check('③b 透明区 alpha=0（SMask 左列 0，黑背景不再压正文）',
          p00[3] === 0 && p01[3] === 0, [p00[3], p01[3]]);
  }

  // ---- 位置：Do 执行时 "Line one" 还在行缓冲里（lines.length===0），
  //      所以 line=0 + charInLine=8 —— 用 charInLine 表达「第一行文字之后」。
  check('③b 图的位置回传：line=0 且 charInLine="Line one".length',
        imgs[0] && imgs[0].line === 0 && imgs[0].charInLine === 8,
        imgs[0] && JSON.stringify([imgs[0].line, imgs[0].charInLine]));
}

/* =================================== 主流程 ================================= */
(async function main() {
  const tests = [test1, test2, test3, test4, test5, test6, test7, test8, test9, test10];
  for (const t of tests) {
    try { await t(); }
    catch (e) {
      failed++;
      console.log('  FAIL  ' + t.name + ' 抛出异常：' + (e && e.message ? e.message : e));
      if (e && e.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'));
    }
  }
  console.log(`\n===== ${passed} passed, ${failed} failed =====`);
  if (failed > 0) process.exitCode = 1;
})();
