/* =============================================================================
 * pdf.js —— 零依赖 · 纯 JavaScript · PDF 文本与目录（书签）提取器
 * -----------------------------------------------------------------------------
 * 运行环境：浏览器 与 Node 18+ 通用。
 * 只使用运行时内置能力：DecompressionStream / Blob / Response / TextDecoder /
 * String.fromCharCode 等，不 import / require 任何第三方库。
 *
 * 对外接口（普通脚本，非 ES module，不使用 export）：
 *     async function pdfExtract(arrayBuffer)
 * 返回：
 *     {
 *       pages:   [ { index: 0, text: "..." } ],       // 每页纯文本，段落之间 \n
 *       outline: [ { title: "第一章 xxx", page: 0 } ], // page 为 0 基页序号，无目录为 []
 *       info:    { title, author, pageCount }
 *     }
 * 失败时 throw new Error("可读的中文原因")。
 *
 * 已实现特性概览（详见各段中文注释）：
 *   1. 经典 xref 表 + trailer + /Prev（增量更新）；PDF 1.5+ 交叉引用流
 *      （/Type /XRef，含 /W、/Index、/Prev、/XRefStm 混合引用）。
 *   2. 对象流 /ObjStm 解压取对象。
 *   3. 兜底：xref 不可用时按字节扫描 "N G obj" 重建索引。
 *   4. 过滤器：FlateDecode（zlib 与 raw）、ASCIIHexDecode、ASCII85Decode、
 *      RunLengthDecode，以及 FlateDecode 的 PNG/TIFF Predictor。
 *   5. 页面树递归（/Count 与 /Kids 顺序），/Resources 沿父节点继承。
 *   6. 内容流文本抽取（Tf Td TD Tm T* TL Tj TJ ' " Tc Tw Tz BT ET + Do 表单递归）。
 *   7. 字符编码：/ToUnicode CMap（bfchar / bfrange 含数组形式）、Type0 双字节、
 *      简单字体单字节 + WinAnsi/MacRoman/Standard + /Differences 字形名映射，
 *      以及预定义 CJK CMap（GBK-EUC-H / UniGB-UCS2-H / B5pc-H … 用 TextDecoder 解），
 *      全部缺失时按 Latin-1 兜底。
 *   8. 目录：/Outlines → /First → /Next（递归 /First，深度上限 3，防环），
 *      /Dest（数组 / 名字）或 /A /GoTo /D；名字树递归查找。
 *   9. 加密 PDF（/Encrypt）明确抛错。
 *  10. 扫描件（无文本层）正常返回空字符串。
 *
 * 命名约定：所有辅助函数/类/常量均以 pdf / PDF_ 前缀命名，避免污染全局命名空间。
 * =========================================================================== */

'use strict';

/* ============================ 0. 基础常量与工具 ============================ */

const PDF_MAX_OBJ_DEPTH     = 64;    // 对象解析最大嵌套深度（防恶意 / 畸形文件爆栈）
const PDF_MAX_FORM_DEPTH    = 3;     // 表单 XObject 递归深度上限
const PDF_MAX_OUTLINE_DEPTH = 3;     // 目录嵌套深度上限（需求规定）
const PDF_MAX_XREF_DEPTH    = 64;    // /Prev 链最大深度
const PDF_TJ_SPACE_LIMIT    = -100;  // TJ 数组里小于该值的调整数视为一个空格

/** 抛出“用户可读”的中文错误（不会被外层包装成英文堆栈） */
function pdfError(msg) {
  const e = new Error(msg);
  e.__pdfUserError = true;
  return e;
}

function pdfIsWhite(b) {
  return b === 0x00 || b === 0x09 || b === 0x0A || b === 0x0C || b === 0x0D || b === 0x20;
}
function pdfIsDelim(b) {
  return b === 0x28 || b === 0x29 || b === 0x3C || b === 0x3E || b === 0x5B ||
         b === 0x5D || b === 0x7B || b === 0x7D || b === 0x2F || b === 0x25;
}
function pdfIsRegular(b) {
  return typeof b === 'number' && !pdfIsWhite(b) && !pdfIsDelim(b);
}
function pdfIsDigit(b) { return b >= 0x30 && b <= 0x39; }
function pdfIsHexDigit(b) {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

/** 字节数组按 Latin-1 转字符串（用于正则扫描，不做编码解释） */
function pdfBytesToLatin1(bytes) {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    s += String.fromCharCode.apply(null, sub);
  }
  return s;
}

/** 在字节流里查找 ASCII 字符串（区分大小写），返回下标或 -1 */
function pdfIndexOfBytes(bytes, str, from) {
  const n = bytes.length, m = str.length;
  if (m === 0) return from || 0;
  const c0 = str.charCodeAt(0);
  for (let i = Math.max(0, from || 0); i <= n - m; i++) {
    if (bytes[i] !== c0) continue;
    let ok = true;
    for (let j = 1; j < m; j++) { if (bytes[i + j] !== str.charCodeAt(j)) { ok = false; break; } }
    if (ok) return i;
  }
  return -1;
}
/** 从后往前查找 */
function pdfLastIndexOfBytes(bytes, str, from) {
  const m = str.length;
  for (let i = Math.min(from, bytes.length - m); i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < m; j++) { if (bytes[i + j] !== str.charCodeAt(j)) { ok = false; break; } }
    if (ok) return i;
  }
  return -1;
}
/** 字节流 position 处是否正好是 ASCII 字符串 str */
function pdfMatchAt(bytes, pos, str) {
  if (pos < 0 || pos + str.length > bytes.length) return false;
  for (let i = 0; i < str.length; i++) if (bytes[pos + i] !== str.charCodeAt(i)) return false;
  return true;
}

function pdfLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function pdfUtf16BE(bytes, start) {
  let s = '';
  for (let i = start || 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}
function pdfUtf16LE(bytes, start) {
  let s = '';
  for (let i = start || 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  return s;
}
function pdfUtf8(bytes, start) {
  const sub = bytes.subarray(start || 0);
  try { return new TextDecoder('utf-8', { fatal: false }).decode(sub); }
  catch (e) { return pdfLatin1(sub); }
}
/** 粗略判断字节序列像不像合法 UTF-8（用于 PDFDocEncoding 的近似选择） */
function pdfLooksLikeUtf8(bytes) {
  let i = 0, multi = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { i++; continue; }
    let need = 0;
    if (b >= 0xC2 && b <= 0xDF) need = 1;
    else if (b >= 0xE0 && b <= 0xEF) need = 2;
    else if (b >= 0xF0 && b <= 0xF4) need = 3;
    else return false;
    for (let k = 1; k <= need; k++) {
      if (i + k >= bytes.length) return false;
      if (bytes[i + k] < 0x80 || bytes[i + k] > 0xBF) return false;
    }
    i += need + 1; multi++;
  }
  return multi > 0;
}
/**
 * 解码 PDF 文本字符串（用于 /Info、目录 /Title 等），
 * 支持 UTF-16BE(BOM)、UTF-16LE(BOM)、UTF-8(BOM)、UTF-8 猜测、PDFDocEncoding(≈Latin-1)
 */
function pdfDecodeTextString(bytes) {
  if (!bytes || bytes.length === 0) return '';
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return pdfUtf16BE(bytes, 2);
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return pdfUtf16LE(bytes, 2);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return pdfUtf8(bytes, 3);
  if (pdfLooksLikeUtf8(bytes)) return pdfUtf8(bytes, 0);
  return pdfLatin1(bytes);
}
function pdfNum(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function pdfName(v) { return (v && v.__pdfName) ? v.name : null; }
/** 取数组第 idx 个（允许负数索引，从尾部数） */
function pdfAt(arr, idx) { return (idx < 0 ? arr[arr.length + idx] : arr[idx]); }

/* ========================== 1. 字形名 → Unicode 表 ========================= */
/* /Differences 编码里给的是字形名（如 /endash），必须查表才能得到字符。 */

const PDF_GLYPH_DATA =
  'space=20 exclam=21 quotedbl=22 numbersign=23 dollar=24 percent=25 ampersand=26 ' +
  'quotesingle=27 parenleft=28 parenright=29 asterisk=2A plus=2B comma=2C hyphen=2D ' +
  'period=2E slash=2F zero=30 one=31 two=32 three=33 four=34 five=35 six=36 seven=37 eight=38 nine=39 ' +
  'colon=3A semicolon=3B less=3C equal=3D greater=3E question=3F at=40 ' +
  'bracketleft=5B backslash=5C bracketright=5D asciicircum=5E underscore=5F grave=60 ' +
  'braceleft=7B bar=7C braceright=7D asciitilde=7E ' +
  'exclamdown=A1 cent=A2 sterling=A3 currency=A4 yen=A5 brokenbar=A6 section=A7 ' +
  'dieresis=A8 copyright=A9 ordfeminine=AA guillemotleft=AB logicalnot=AC sfthyphen=AD ' +
  'registered=AE macron=AF degree=B0 plusminus=B1 twosuperior=B2 threesuperior=B3 acute=B4 ' +
  'mu=B5 paragraph=B6 periodcentered=B7 cedilla=B8 onesuperior=B9 ordmasculine=BA ' +
  'guillemotright=BB onequarter=BC onehalf=BD threequarters=BE questiondown=BF ' +
  'Agrave=C0 Aacute=C1 Acircumflex=C2 Atilde=C3 Adieresis=C4 Aring=C5 AE=C6 Ccedilla=C7 ' +
  'Egrave=C8 Eacute=C9 Ecircumflex=CA Edieresis=CB Igrave=CC Iacute=CD Icircumflex=CE Idieresis=CF ' +
  'Eth=D0 Ntilde=D1 Ograve=D2 Oacute=D3 Ocircumflex=D4 Otilde=D5 Odieresis=D6 multiply=D7 ' +
  'Oslash=D8 Ugrave=D9 Uacute=DA Ucircumflex=DB Udieresis=DC Yacute=DD Thorn=DE germandbls=DF ' +
  'agrave=E0 aacute=E1 acircumflex=E2 atilde=E3 adieresis=E4 aring=E5 ae=E6 ccedilla=E7 ' +
  'egrave=E8 eacute=E9 ecircumflex=EA edieresis=EB igrave=EC iacute=ED icircumflex=EE idieresis=EF ' +
  'eth=F0 ntilde=F1 ograve=F2 oacute=F3 ocircumflex=F4 otilde=F5 odieresis=F6 divide=F7 ' +
  'oslash=F8 ugrave=F9 uacute=FA ucircumflex=FB udieresis=FC yacute=FD thorn=FE ydieresis=FF ' +
  'dotlessi=131 Lslash=141 lslash=142 OE=152 oe=153 Scaron=160 scaron=161 Ydieresis=178 ' +
  'Zcaron=17D zcaron=17E florin=192 circumflex=2C6 caron=2C7 breve=2D8 dotaccent=2D9 ring=2DA ' +
  'ogonek=2DB tilde=2DC hungarumlaut=2DD quotesinglbase=201A quotedblbase=201E dagger=2020 ' +
  'daggerdbl=2021 bullet=2022 ellipsis=2026 perthousand=2030 guilsinglleft=2039 guilsinglright=203A ' +
  'fraction=2044 Euro=20AC trademark=2122 minus=2212 fi=FB01 fl=FB02 ff=FB00 ffi=FB03 ffl=FB04 ' +
  'endash=2013 emdash=2014 quoteleft=2018 quoteright=2019 quotedblleft=201C quotedblright=201D ' +
  'nbspace=A0 nonbreakingspace=A0';

let PDF_GLYPH_MAP_CACHE = null;
function pdfGlyphMap() {
  if (PDF_GLYPH_MAP_CACHE) return PDF_GLYPH_MAP_CACHE;
  const map = new Map();
  // 拉丁字母与数字
  for (let i = 0; i < 26; i++) {
    map.set(String.fromCharCode(65 + i), String.fromCharCode(65 + i));
    map.set(String.fromCharCode(97 + i), String.fromCharCode(97 + i));
  }
  for (const kv of PDF_GLYPH_DATA.split(' ')) {
    if (!kv) continue;
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    map.set(kv.slice(0, eq), String.fromCharCode(parseInt(kv.slice(eq + 1), 16)));
  }
  PDF_GLYPH_MAP_CACHE = map;
  return map;
}
/** 字形名 → Unicode 字符串；支持 uniXXXX / uXXXXXX / cidNN / gNN 等常见写法 */
function pdfGlyphToUnicode(name) {
  if (!name) return '';
  const m = pdfGlyphMap();
  if (m.has(name)) return m.get(name);
  let r = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (r) return String.fromCharCode(parseInt(r[1], 16));
  r = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (r) { try { return String.fromCodePoint(parseInt(r[1], 16)); } catch (e) { return ''; } }
  if (/^(cid|g|glyph|index)\d+$/i.test(name)) return '';  // 子集字体的无意义名
  return '';
}

/* ============================ 2. 内置编码表 ============================== */

/** WinAnsi(CP1252)：0x80–0x9F 的特殊区，其余与 Latin-1 相同 */
const PDF_CP1252_HIGH = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152,
  0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A,
  0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178
};

/** MacRoman 0x80–0xFF → Unicode 码位 */
const PDF_MACROMAN_HIGH = [
  0x00C4, 0x00C5, 0x00C7, 0x00C9, 0x00D1, 0x00D6, 0x00DC, 0x00E1, 0x00E0, 0x00E2, 0x00E4, 0x00E3, 0x00E5, 0x00E7, 0x00E9, 0x00E8,
  0x00EA, 0x00EB, 0x00ED, 0x00EC, 0x00EE, 0x00EF, 0x00F1, 0x00F3, 0x00F2, 0x00F4, 0x00F6, 0x00F5, 0x00FA, 0x00F9, 0x00FB, 0x00FC,
  0x2020, 0x00B0, 0x00A2, 0x00A3, 0x00A7, 0x2022, 0x00B6, 0x00DF, 0x00AE, 0x00A9, 0x2122, 0x00B4, 0x00A8, 0x2260, 0x00C6, 0x00D8,
  0x221E, 0x00B1, 0x2264, 0x2265, 0x00A5, 0x00B5, 0x2202, 0x2211, 0x220F, 0x03C0, 0x222B, 0x00AA, 0x00BA, 0x03A9, 0x00E6, 0x00F8,
  0x00BF, 0x00A1, 0x00AC, 0x221A, 0x0192, 0x2248, 0x2206, 0x00AB, 0x00BB, 0x2026, 0x00A0, 0x00C0, 0x00C3, 0x00D5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201C, 0x201D, 0x2018, 0x2019, 0x00F7, 0x25CA, 0x00FF, 0x0178, 0x2044, 0x20AC, 0x2039, 0x203A, 0xFB01, 0xFB02,
  0x2021, 0x00B7, 0x201A, 0x201E, 0x2030, 0x00C2, 0x00CA, 0x00C1, 0x00CB, 0x00C8, 0x00CD, 0x00CE, 0x00CF, 0x00CC, 0x00D3, 0x00D4,
  0xF8FF, 0x00D2, 0x00DA, 0x00DB, 0x00D9, 0x0131, 0x02C6, 0x02DC, 0x00AF, 0x02D8, 0x02D9, 0x02DA, 0x00B8, 0x02DD, 0x02DB, 0x02C7
];

/** StandardEncoding 高区（0xA0–0xFF）字节 → 字形名 */
const PDF_STANDARD_HIGH = {
  0xA1: 'exclamdown', 0xA2: 'cent', 0xA3: 'sterling', 0xA4: 'fraction', 0xA5: 'yen',
  0xA6: 'florin', 0xA7: 'section', 0xA8: 'currency', 0xA9: 'quotesingle', 0xAA: 'quotedblleft',
  0xAB: 'guillemotleft', 0xAC: 'guilsinglleft', 0xAD: 'guilsinglright', 0xAE: 'fi', 0xAF: 'fl',
  0xB1: 'endash', 0xB2: 'dagger', 0xB3: 'daggerdbl', 0xB4: 'periodcentered', 0xB6: 'paragraph',
  0xB7: 'bullet', 0xB8: 'quotesinglbase', 0xB9: 'quotedblbase', 0xBA: 'quotedblright',
  0xBB: 'guillemotright', 0xBC: 'ellipsis', 0xBD: 'perthousand', 0xBF: 'questiondown',
  0xC1: 'grave', 0xC2: 'acute', 0xC3: 'circumflex', 0xC4: 'tilde', 0xC5: 'macron',
  0xC6: 'breve', 0xC7: 'dotaccent', 0xC8: 'dieresis', 0xCA: 'ring', 0xCB: 'cedilla',
  0xCD: 'hungarumlaut', 0xCE: 'ogonek', 0xCF: 'caron', 0xD0: 'emdash', 0xE1: 'AE',
  0xE3: 'ordfeminine', 0xE8: 'Lslash', 0xE9: 'Oslash', 0xEA: 'OE', 0xEB: 'ordmasculine',
  0xF1: 'ae', 0xF5: 'lslash', 0xF6: 'oslash', 0xF7: 'oe', 0xF8: 'germandbls'
};

/** 生成 256 项「字节 → Unicode」表 */
function pdfMakeEncodingTable(kind) {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) t[i] = '';
  for (let i = 0x20; i < 0x7F; i++) t[i] = String.fromCharCode(i);
  if (kind === 'WinAnsiEncoding') {
    for (let i = 0xA0; i < 0x100; i++) t[i] = String.fromCharCode(i);
    for (const k in PDF_CP1252_HIGH) t[+k] = String.fromCharCode(PDF_CP1252_HIGH[k]);
  } else if (kind === 'MacRomanEncoding') {
    for (let i = 0x80; i < 0x100; i++) t[i] = String.fromCharCode(PDF_MACROMAN_HIGH[i - 0x80]);
  } else { // StandardEncoding
    for (const k in PDF_STANDARD_HIGH) {
      const s = pdfGlyphToUnicode(PDF_STANDARD_HIGH[k]);
      if (s) t[+k] = s;
    }
  }
  return t;
}

const PDF_ENCODING_CACHE = new Map();
function pdfEncodingTable(kind) {
  const key = kind || 'StandardEncoding';
  if (!PDF_ENCODING_CACHE.has(key)) PDF_ENCODING_CACHE.set(key, pdfMakeEncodingTable(key));
  return PDF_ENCODING_CACHE.get(key);
}

/* ========================== 3. 对象模型与词法分析 ========================= */

class PDF_Ref     { constructor(num, gen) { this.num = num; this.gen = gen || 0; } }
class PDF_Name    { constructor(name) { this.name = name; this.__pdfName = true; } }
class PDF_String  { constructor(bytes) { this.bytes = bytes; this.__pdfString = true; } }
class PDF_Op      { constructor(op) { this.op = op; this.__pdfOp = true; } }
class PDF_Stream  { constructor(dict, raw) { this.dict = dict; this.raw = raw; this.__stream = true; } }

/**
 * PDF 词法/语法分析器：在字节流上做增量解析。
 * 支持 name / 字面量字符串 / 十六进制字符串 / 数字 / 间接引用 / 数组 / 字典 / 关键字。
 */
class PDF_Lexer {
  constructor(bytes, pos) { this.b = bytes; this.p = pos || 0; }

  atEnd() { return this.p >= this.b.length; }
  peek(o) { return this.b[this.p + (o || 0)]; }

  /** 跳过空白与 % 注释 */
  skipWs() {
    const b = this.b;
    while (this.p < b.length) {
      const c = b[this.p];
      if (pdfIsWhite(c)) { this.p++; continue; }
      if (c === 0x25) { // '%' 注释：跳到行尾
        while (this.p < b.length && b[this.p] !== 0x0A && b[this.p] !== 0x0D) this.p++;
        continue;
      }
      break;
    }
  }

  /** 读取一段常规字符（关键字 / 数字字面量的原始文本） */
  readRegularRun() {
    const b = this.b, start = this.p;
    while (this.p < b.length && pdfIsRegular(b[this.p])) this.p++;
    if (this.p === start) return '';
    return pdfLatin1(b.subarray(start, this.p));
  }

  /** 读数字：先取连续字符再 parseFloat（对畸形写法容错） */
  readNumber() {
    const b = this.b, start = this.p;
    while (this.p < b.length) {
      const c = b[this.p];
      if (pdfIsDigit(c) || c === 0x2B || c === 0x2D || c === 0x2E || c === 0x45 || c === 0x65) this.p++;
      else break;
    }
    if (this.p === start) return null;
    const s = pdfLatin1(b.subarray(start, this.p));
    const v = parseFloat(s);
    if (isNaN(v)) return 0;
    return v;
  }

  readName() {
    const b = this.b;
    if (b[this.p] !== 0x2F) return null;
    this.p++;
    let out = '';
    while (this.p < b.length && pdfIsRegular(b[this.p])) {
      let c = b[this.p++];
      if (c === 0x23 && pdfIsHexDigit(b[this.p]) && pdfIsHexDigit(b[this.p + 1])) { // '#XX'
        c = parseInt(String.fromCharCode(b[this.p], b[this.p + 1]), 16);
        this.p += 2;
      }
      out += String.fromCharCode(c);
    }
    return new PDF_Name(out);
  }

  readLiteralString() {
    const b = this.b;
    this.p++; // 跳过 '('
    const out = [];
    let depth = 1;
    while (this.p < b.length) {
      const c = b[this.p++];
      if (c === 0x5C) { // 反斜杠转义
        const e = b[this.p];
        if (e === undefined) break;
        if (e === 0x6E) { out.push(0x0A); this.p++; }
        else if (e === 0x72) { out.push(0x0D); this.p++; }
        else if (e === 0x74) { out.push(0x09); this.p++; }
        else if (e === 0x62) { out.push(0x08); this.p++; }
        else if (e === 0x66) { out.push(0x0C); this.p++; }
        else if (e === 0x28 || e === 0x29 || e === 0x5C) { out.push(e); this.p++; }
        else if (e === 0x0D) { this.p++; if (b[this.p] === 0x0A) this.p++; } // 续行
        else if (e === 0x0A) { this.p++; }
        else if (e >= 0x30 && e <= 0x37) { // 八进制
          let oct = '';
          for (let k = 0; k < 3 && b[this.p] >= 0x30 && b[this.p] <= 0x37; k++) oct += String.fromCharCode(b[this.p++]);
          out.push(parseInt(oct, 8) & 0xFF);
        } else { out.push(e); this.p++; }
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return new PDF_String(Uint8Array.from(out));
  }

  readHexString() {
    const b = this.b;
    this.p++; // 跳过 '<'
    const out = [];
    let hi = -1;
    while (this.p < b.length) {
      const c = b[this.p++];
      if (c === 0x3E) break;
      if (!pdfIsHexDigit(c)) continue;
      const v = parseInt(String.fromCharCode(c), 16);
      if (hi < 0) hi = v;
      else { out.push((hi << 4) | v); hi = -1; }
    }
    if (hi >= 0) out.push(hi << 4); // 奇数位补 0
    return new PDF_String(Uint8Array.from(out));
  }

  /**
   * 解析一个对象。遇到不认识的关键字返回 PDF_Op（内容流里的运算符）。
   * 无法解析时返回 null（调用方需检查位置是否前进）。
   */
  parseObject(depth) {
    if ((depth || 0) > PDF_MAX_OBJ_DEPTH) throw pdfError('PDF 对象嵌套过深，文件可能已损坏');
    this.skipWs();
    if (this.p >= this.b.length) return null;
    const b = this.b, c = b[this.p];

    if (c === 0x2F) return this.readName();
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x3C) {
      if (b[this.p + 1] === 0x3C) { // 字典
        this.p += 2;
        const dict = {};
        for (;;) {
          this.skipWs();
          if (this.p >= b.length) break;
          if (b[this.p] === 0x3E && b[this.p + 1] === 0x3E) { this.p += 2; break; }
          if (b[this.p] !== 0x2F) { // 畸形字典：强行跳过
            const before = this.p;
            const junk = this.parseObject((depth || 0) + 1);
            if (this.p === before) this.p++;
            if (junk === null) continue;
            continue;
          }
          const key = this.readName();
          const val = this.parseObject((depth || 0) + 1);
          dict[key.name] = val;
        }
        return dict;
      }
      return this.readHexString();
    }
    if (c === 0x5B) { // 数组
      this.p++;
      const arr = [];
      for (;;) {
        this.skipWs();
        if (this.p >= b.length) break;
        if (b[this.p] === 0x5D) { this.p++; break; }
        const before = this.p;
        const v = this.parseObject((depth || 0) + 1);
        if (this.p === before) { this.p++; continue; }
        if (v === null) continue;
        arr.push(v);
      }
      return arr;
    }
    if (c === 0x5D || c === 0x3E || c === 0x29) { this.p++; return null; }

    if (pdfIsDigit(c) || c === 0x2B || c === 0x2D || c === 0x2E) {
      const n1 = this.readNumber();
      if (n1 === null) return null;
      // 尝试识别 "N G R" 间接引用
      if (Number.isInteger(n1) && n1 >= 0) {
        const save = this.p;
        this.skipWs();
        const c2 = this.b[this.p];
        if (c2 !== undefined && (pdfIsDigit(c2) || c2 === 0x2B || c2 === 0x2D)) {
          const n2 = this.readNumber();
          if (n2 !== null && Number.isInteger(n2) && n2 >= 0) {
            this.skipWs();
            if (this.b[this.p] === 0x52 /* R */ && !pdfIsRegular(this.b[this.p + 1])) {
              this.p++;
              return new PDF_Ref(n1, n2);
            }
          }
        }
        this.p = save;
      }
      return n1;
    }

    const word = this.readRegularRun();
    if (word === '') { this.p++; return null; }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new PDF_Op(word);
  }
}

/* ============================== 4. 流过滤器 =============================== */

/** 使用运行时内置 DecompressionStream 解压 */
async function pdfDecompressWith(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw pdfError('当前运行环境不支持 DecompressionStream，无法解压 PDF 内容流');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** FlateDecode：依次尝试 zlib、raw deflate，以及跳过前导垃圾后再试 */
async function pdfInflate(input) {
  if (!input || input.length === 0) return new Uint8Array(0);
  let lastErr = null;
  try { return await pdfDecompressWith(input, 'deflate'); } catch (e) { lastErr = e; }
  try { return await pdfDecompressWith(input, 'deflate-raw'); } catch (e) { lastErr = e; }
  // 有些损坏文件在 zlib 头之前有杂字节：扫描合法 zlib 头（0x78）重试
  const end = Math.min(input.length - 2, 64);
  for (let i = 1; i <= end; i++) {
    if (input[i] !== 0x78) continue;
    const fcheck = ((input[i] << 8) | input[i + 1]) % 31;
    if (fcheck !== 0) continue;
    try { return await pdfDecompressWith(input.subarray(i), 'deflate'); } catch (e) { lastErr = e; }
  }
  throw pdfError('FlateDecode 解压失败（数据可能损坏）：' + (lastErr && lastErr.message ? lastErr.message : ''));
}

function pdfAsciiHexDecode(input) {
  const out = [];
  let hi = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x3E) break;           // '>'
    if (!pdfIsHexDigit(c)) continue;
    const v = parseInt(String.fromCharCode(c), 16);
    if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4);
  return Uint8Array.from(out);
}

function pdfAscii85Decode(input) {
  const out = [];
  let tuple = 0, count = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (pdfIsWhite(c)) continue;
    if (c === 0x7E) break;            // '~' 结束
    if (c === 0x7A && count === 0) {  // 'z' → 4 个 0
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 33);
    count++;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xFF, (tuple >>> 16) & 0xFF, (tuple >>> 8) & 0xFF, tuple & 0xFF);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xFF, (tuple >>> 16) & 0xFF, (tuple >>> 8) & 0xFF, tuple & 0xFF];
    for (let k = 0; k < count - 1; k++) out.push(bytes[k]);
  }
  return Uint8Array.from(out);
}

function pdfRunLengthDecode(input) {
  const out = [];
  let i = 0;
  while (i < input.length) {
    const l = input[i++];
    if (l === 128) break;
    if (l < 128) {
      for (let k = 0; k <= l && i < input.length; k++) out.push(input[i++]);
    } else {
      const b = input[i++];
      for (let k = 0; k < 257 - l; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/**
 * PNG/TIFF Predictor 还原（xref 流几乎一定会用到）。
 * /DecodeParms: /Predictor /Colors /BitsPerComponent /Columns
 */
function pdfApplyPredictor(data, parms) {
  const pred = parms ? pdfNum(parms.Predictor) : null;
  if (!pred || pred <= 1) return data;
  const colors = pdfNum(parms.Colors) || 1;
  const bpc = pdfNum(parms.BitsPerComponent) || 8;
  const columns = pdfNum(parms.Columns) || 1;
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8));   // 每像素字节数
  const rowLen = Math.ceil(colors * bpc * columns / 8);   // 每行字节数

  if (pred === 2) {
    // TIFF Predictor：同色分量之间做差分累加（仅对 8/16 位做完整实现）
    if (bpc !== 8) return data;   // 其他位深较罕见，原样返回（已在文档中说明局限）
    const rows = Math.floor(data.length / rowLen);
    const out = new Uint8Array(data);
    for (let r = 0; r < rows; r++) {
      const base = r * rowLen;
      for (let i = bpp; i < rowLen; i++) out[base + i] = (out[base + i] + out[base + i - bpp]) & 0xFF;
    }
    return out;
  }

  // PNG Predictor（10–15）：每行前面有一个字节的过滤器类型
  const out = [];
  let prev = new Uint8Array(rowLen);
  let p = 0;
  while (p < data.length) {
    const ft = data[p++];
    if (p + rowLen > data.length) {
      // 最后一行不完整：原样拷贝剩余字节
      for (let i = p; i < data.length; i++) out.push(data[i]);
      break;
    }
    const row = data.subarray(p, p + rowLen);
    p += rowLen;
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const raw = row[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const bb = prev[i];
      const cc = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + bb; break;
        case 3: v = raw + ((a + bb) >> 1); break;
        case 4: { // Paeth
          const pp = a + bb - cc;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - cc);
          v = raw + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : cc));
          break;
        }
        default: v = raw;
      }
      cur[i] = v & 0xFF;
    }
    for (let i = 0; i < rowLen; i++) out.push(cur[i]);
    prev = cur;
  }
  return Uint8Array.from(out);
}

/* ============================= 5. ToUnicode CMap ========================== */

/** 把 CMap 片段切成 <hex> / [ / ] 记号 */
function pdfCmapTokens(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '<') {
      const j = s.indexOf('>', i);
      if (j < 0) break;
      toks.push({ t: 'hex', v: s.slice(i + 1, j).replace(/\s+/g, '') });
      i = j + 1;
    } else if (c === '[') { toks.push({ t: '[' }); i++; }
    else if (c === ']') { toks.push({ t: ']' }); i++; }
    else i++;
  }
  return toks;
}
function pdfHexToBytes(hex) {
  const n = Math.floor(hex.length / 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return out;
}
/** 目标码（UTF-16BE 字符串）→ JS 字符串 */
function pdfCmapTarget(hex) {
  const bytes = pdfHexToBytes(hex);
  if (bytes.length === 0) return '';
  if (bytes.length % 2 === 1) return String.fromCharCode(bytes[0]);
  return pdfUtf16BE(bytes, 0);
}
/** big-endian 自增（bfrange 连续目标） */
function pdfIncrementBytes(bytes) {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0xFF) { bytes[i] = 0; continue; }
    bytes[i]++;
    return bytes;
  }
  return bytes;
}

/**
 * 解析 /ToUnicode CMap：beginbfchar/endbfchar、beginbfrange/endbfrange（含数组形式）。
 * 返回 { map1: 单字节码表, map2: 双字节码表, codeBytes: 推断出的取码字节数 }
 */
function pdfParseCMap(bytes) {
  const text = pdfLatin1(bytes);
  const map1 = new Map(), map2 = new Map();
  const put = (srcHex, dstHex) => {
    const code = parseInt(srcHex, 16);
    if (isNaN(code)) return;
    const target = srcHex.length <= 2 ? map1 : map2;
    target.set(code, pdfCmapTarget(dstHex));
  };
  /** 直接按码值与目标字节写入（bfrange 用） */
  const putBytes = (srcLenHex, code, dstBytes) => {
    const target = srcLenHex <= 2 ? map1 : map2;
    target.set(code, dstBytes.length % 2 === 1
      ? String.fromCharCode(dstBytes[0])
      : pdfUtf16BE(dstBytes, 0));
  };

  // ---- beginbfchar / endbfchar ----
  let pos = 0;
  for (;;) {
    const i = text.indexOf('beginbfchar', pos);
    if (i < 0) break;
    const j = text.indexOf('endbfchar', i);
    const block = text.slice(i + 'beginbfchar'.length, j < 0 ? text.length : j);
    const toks = pdfCmapTokens(block).filter(x => x.t === 'hex');
    for (let k = 0; k + 1 < toks.length; k += 2) put(toks[k].v, toks[k + 1].v);
    pos = j < 0 ? text.length : j + 1;
  }
  // ---- beginbfrange / endbfrange ----
  pos = 0;
  for (;;) {
    const i = text.indexOf('beginbfrange', pos);
    if (i < 0) break;
    const j = text.indexOf('endbfrange', i);
    const block = text.slice(i + 'beginbfrange'.length, j < 0 ? text.length : j);
    const toks = pdfCmapTokens(block);
    let k = 0;
    while (k < toks.length) {
      if (toks[k].t !== 'hex') { k++; continue; }
      const lo = toks[k].v, hi = toks[k + 1] && toks[k + 1].t === 'hex' ? toks[k + 1].v : null;
      if (hi === null) break;
      k += 2;
      if (toks[k] && toks[k].t === '[') {
        // 形式：<lo> <hi> [<d1> <d2> ...]
        k++;
        let code = parseInt(lo, 16);
        while (k < toks.length && toks[k].t !== ']') {
          if (toks[k].t === 'hex') {
            putBytes(lo.length, code, pdfHexToBytes(toks[k].v));
            code++;
          }
          k++;
        }
        if (toks[k] && toks[k].t === ']') k++;
      } else if (toks[k] && toks[k].t === 'hex') {
        // 形式：<lo> <hi> <dst>，目标是连续递增的 UTF-16BE 串
        const start = parseInt(lo, 16), end = parseInt(hi, 16);
        let dst = pdfHexToBytes(toks[k].v);
        for (let code = start; code <= end && code - start < 65536; code++) {
          putBytes(lo.length, code, dst);
          dst = pdfIncrementBytes(dst.slice());
        }
        k++;
      }
    }
    pos = j < 0 ? text.length : j + 1;
  }
  // ---- 代码空间范围（决定取码字节数）----
  let codeBytes = null;
  const csIdx = text.indexOf('begincodespacerange');
  if (csIdx >= 0) {
    const ceIdx = text.indexOf('endcodespacerange', csIdx);
    const block = text.slice(csIdx + 'begincodespacerange'.length, ceIdx < 0 ? text.length : ceIdx);
    const toks = pdfCmapTokens(block).filter(x => x.t === 'hex');
    if (toks.length > 0) codeBytes = Math.ceil(toks[0].v.length / 2);
  }
  return { map1, map2, codeBytes };
}

/* ============================== 6. 字体信息 ============================== */

/**
 * 构建简单字体（Type1/TrueType/Type3）的 256 项编码表：
 * 基础编码（/BaseEncoding 或默认）+ /Differences 字形名覆盖。
 */
async function pdfBuildSimpleEncoding(doc, fd) {
  const subtype = pdfName(await doc.resolveKey(fd, 'Subtype')) || '';
  const enc = await doc.resolveKey(fd, 'Encoding');
  let baseName = subtype === 'TrueType' ? 'WinAnsiEncoding' : 'StandardEncoding';
  let differences = null;

  if (enc instanceof PDF_Name) baseName = enc.name;
  else if (enc && typeof enc === 'object' && !enc.__stream) {
    const be = await doc.resolveKey(enc, 'BaseEncoding');
    if (be instanceof PDF_Name) baseName = be.name;
    differences = await doc.resolveKey(enc, 'Differences');
  }
  const table = pdfEncodingTable(baseName).slice();

  if (Array.isArray(differences)) {
    let code = 0;
    for (const item of differences) {
      if (typeof item === 'number') { code = item; continue; }
      if (item instanceof PDF_Name) {
        if (code >= 0 && code < 256) {
          const u = pdfGlyphToUnicode(item.name);
          table[code] = u || table[code];   // 查不到字形名时保留基础编码
        }
        code++;
      }
    }
  }
  return table;
}

/** 构建单个字体对象（含 ToUnicode、取码字节数、简单字体编码表） */
async function pdfBuildFont(doc, fd) {
  const font = { name: '', subtype: '', codeBytes: 1, toUnicode: null, encoding: null, mono: false };
  if (!fd || typeof fd !== 'object' || fd.__stream) return font;
  const sub = pdfName(await doc.resolveKey(fd, 'Subtype'));
  font.subtype = sub || '';
  const bf = pdfName(await doc.resolveKey(fd, 'BaseFont'));
  font.name = bf || '';
  // 等宽字体：只用于「估算推进宽度」时的字宽系数（0.6 vs 0.5 em）。
  // 名字里带 Mono/Courier/Consolas/Menlo 一类就当作等宽，够用且零成本。
  font.mono = /(mono|courier|consol|menlo|inconsolata|source\s*code|jetbrains|fira\s*code)/i.test(font.name);

  // 1) 有 /ToUnicode 就用它（不能假设一定存在，也不能假设一定不存在）
  const tu = await doc.resolveKey(fd, 'ToUnicode');
  if (tu instanceof PDF_Stream) {
    try {
      const data = await doc.streamData(tu);
      const cmap = pdfParseCMap(data);
      font.toUnicode = cmap;
    } catch (e) { font.toUnicode = null; }
  }

  if (font.subtype === 'Type0') {
    // 2) 复合字体：按双字节取码（Identity-H/V 及绝大多数 CMap 都是双字节）
    const cmap = font.toUnicode;
    if (cmap && cmap.map2.size === 0 && cmap.map1.size > 0) font.codeBytes = 1;
    else font.codeBytes = 2;
    // 没有 ToUnicode 时，尝试用预定义 CJK CMap 名直接解码（GBK-EUC-H 等）
    if (!cmap) {
      const encName = pdfName(await doc.resolveKey(fd, 'Encoding'));
      font.legacyEncoding = pdfLegacyCjkEncoding(encName);
    }
    // 子字体在 /DescendantFonts（这里保留引用以便后续扩展；编码本身无需它）
    font.descendant = await doc.resolveKey(fd, 'DescendantFonts');
  } else {
    // 3) 简单字体：单字节取码 + 编码表
    font.codeBytes = 1;
    try { font.encoding = await pdfBuildSimpleEncoding(doc, fd); } catch (e) { font.encoding = null; }
  }
  return font;
}

/** 单个字符码 → Unicode（ToUnicode 优先，其次编码表，最后 Latin-1 兜底） */
function pdfMapCode(font, code, singleByte) {
  if (font && font.toUnicode) {
    let s = singleByte ? font.toUnicode.map1.get(code) : font.toUnicode.map2.get(code);
    if (s == null) s = font.toUnicode.map1.get(code & 0xFF);          // 双字节表缺失时退一步
    if (s == null && singleByte) s = font.toUnicode.map2.get(code);   // 单字节取码但表是双字节键
    if (s != null) return s;
  }
  if (font && font.encoding) {
    const s = font.encoding[code & 0xFF];
    if (s) return s;
  }
  // 双字节取码且高位非 0、又完全没有映射信息：无法还原，返回空串比返回乱码更诚实
  if (!singleByte && (code >> 8) !== 0 && font && !font.toUnicode && !font.encoding) return '';
  return String.fromCharCode(code & 0xFF);
}

/** 把显示字符串（PDF_String）按字体解码成 JS 字符串 */
function pdfDecodeShow(font, bytes) {
  if (!font) return pdfLatin1(bytes);
  // 预定义 CJK CMap（GBK-EUC-H / UniGB-UCS2-H 等）且没有 ToUnicode：
  // 这类字体的字符码本身就是 GBK/EUC/Unicode 码值，可以整段交给 TextDecoder 解码
  if (!font.toUnicode && font.legacyEncoding) {
    try {
      if (font.legacyEncoding === '__ucs2__') return pdfUtf16BE(bytes, 0);
      if (!font.__cjkDecoder) font.__cjkDecoder = new TextDecoder(font.legacyEncoding, { fatal: false });
      return font.__cjkDecoder.decode(bytes);
    } catch (e) { /* 运行环境不支持该编码：继续走逐码映射 */ }
  }
  const out = [];
  if (font.codeBytes === 2) {
    let i = 0;
    for (; i + 1 < bytes.length; i += 2) out.push(pdfMapCode(font, (bytes[i] << 8) | bytes[i + 1], false));
    if (i < bytes.length) out.push(pdfMapCode(font, bytes[i], true));
  } else {
    for (let i = 0; i < bytes.length; i++) out.push(pdfMapCode(font, bytes[i], true));
  }
  return out.join('');
}

/**
 * 预定义 CJK CMap 名 → TextDecoder 标签（或 '__ucs2__' 表示码值即 Unicode）。
 * 中文 PDF（Word/WPS 导出）大量使用 GBK-EUC-H 且不带 /ToUnicode，这一步很关键。
 */
function pdfLegacyCjkEncoding(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  if (n.indexOf('ucs2') >= 0 || n.indexOf('utf16') >= 0) return '__ucs2__';
  if (n.indexOf('gbk') >= 0 || n.indexOf('gb-euc') >= 0 || n.indexOf('gbpc-euc') >= 0) return 'gbk';
  if (n === 'euc-h' || n === 'euc-v') return 'gbk';
  if (n.indexOf('b5') >= 0 || n.indexOf('cns-euc') >= 0 || n.indexOf('eten') >= 0) return 'big5';
  if (n.indexOf('rksj') >= 0 || n.indexOf('90ms') >= 0 || n.indexOf('90pv') >= 0) return 'shift_jis';
  if (n.indexOf('euc-jp') >= 0) return 'euc-jp';
  if (n.indexOf('ksc') >= 0 || n.indexOf('korean') >= 0) return 'euc-kr';
  return null;
}

/* ============================ 7. 内容流文本提取 =========================== */

/**
 * 文本输出收集器：按行累积。
 *
 * 关键点：PDF 没有「空格字符」这个概念，词距与缩进都是**位置**。
 * LaTeX / pandoc 生成的 PDF（代码块尤其明显）会把每个词单独用
 * `BT /F 9.9 Tf 183.258 0 Td[...]TJ ET` 摆到绝对坐标上，
 * 所以只按 Y 分行的解析器会把 `fn constant(n: i32)` 读成 `fnconstant(n:i32)`。
 * 这里按「上一段的结束 X」与「本段的起始 X」之间的空隙反推空格数。
 */
class PDF_TextSink {
  constructor() {
    this.lines = [];        // [{x, text}]  x = 该行首个文本段的起始 X（页面坐标）
    this.cur = '';
    this.curX = null;       // 本行首个文本段的 X
    this.curFs = 0;         // 本行首个文本段的字号
    this.curEndX = null;    // 本行最近一段的结束 X
    this.lastY = null;
    this.images = [];       // 本页画过的图像：{ name, at }（at = 画到这儿时已输出的字符数）
  }
  /** 记录一次图像绘制，位置 = 当前已输出文本的长度（行号 + 行内偏移） */
  noteImage(name) {
    const lineIdx = this.lines.length;
    this.images.push({ name, line: lineIdx, charInLine: this.cur.length });
  }
  /** 段与段之间的水平空隙 → 空格数。
      阈值是量出来的：hello-algo（LaTeX/pandoc）里**词间空隙**的分布是双峰的 ——
      代码页的紧邻词距约 0.3 em，正文页的词距集中在 1.5 em，两者之间几乎为空。
      所以 0.25~2.0 em 统一给「1 个空格」，既不漏掉紧词距，也不会把 1.5 em 放大成 2~3 个；
      更大的空隙是分栏/表格对齐，封顶即可（正文会被重新排版，多给空格没有意义）。 */
  gapSpaces(px, st) {
    if (this.cur === '') return 0;              // 行首不算词距
    const fs = Math.abs(st.size) || 1;
    const from = (this.curEndX === null) ? this.curX : this.curEndX;
    const em = (px - from) / fs;
    if (em < 0.25) return 0;                    // 同词内连写/字距
    if (em < 2.0) return 1;                     // 一个词间空格
    if (em < 3.0) return 2;
    return 3;                                   // 分栏/表格对齐，封顶
  }
  add(s) { if (s) this.cur += s; }
  newline() {
    const t = this.cur.replace(/\s+$/, '');
    if (t !== '') this.lines.push({ x: this.curX, fs: this.curFs, text: t });
    this.cur = ''; this.curX = null; this.curFs = 0; this.curEndX = null;
  }
  /** 行首 X 分布里出现最多的那个值 ≈ 版心左边距。
      用「众数」而不是「最小值」：整页都是代码时，代码块的左缘才是左边距，
      拿全局最小值会让所有缩进都变成 0。 */
  marginX() {
    if (!this.lines.length) return null;
    const cnt = new Map();
    for (const l of this.lines) {
      if (l.x === null) continue;
      const k = Math.round(l.x * 2) / 2;        // 半磅精度分桶
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    if (!cnt.size) return null;
    let best = null, bestN = -1;
    for (const [k, n] of cnt) if (n > bestN || (n === bestN && k < best)) { best = k; bestN = n; }
    return best;
  }
  finish() {
    const t = this.cur.replace(/\s+$/, '');
    if (t !== '') this.lines.push({ x: this.curX, fs: this.curFs, text: t });
    this.cur = ''; this.curX = null; this.curFs = 0; this.curEndX = null;
    while (this.lines.length && this.lines[0].text === '') this.lines.shift();
    while (this.lines.length && this.lines[this.lines.length - 1].text === '') this.lines.pop();
    if (!this.lines.length) return '';

    const margin = this.marginX();
    // 只有「确实存在版心」时才做缩进还原：至少两行的行首落在同一个 X 上。
    // 否则单行页面/整页居中标题会被当成缩进，凭空多出一片前导空格。
    const supported = margin !== null &&
      this.lines.filter(l => l.x !== null && Math.abs(l.x - margin) < 0.75).length >= 2;
    const out = [];
    for (const l of this.lines) {
      if (l.x === null || !supported) { out.push(l.text); continue; }
      // 缩进：按行首偏离左边距的量折算空格数，用**该行自己的字号**折算。
      // 上限是必要的 —— 居中的图注会偏得很远，但不该顶出十几格空白。
      const sp = pdfSpaceWidth(l.fs || 10);
      const gap = l.x - margin;
      const n = gap > sp * 0.6 ? Math.min(12, Math.max(1, Math.round(gap / sp))) : 0;
      out.push(' '.repeat(n) + l.text);
    }
    return out.join('\n');
  }
}

/** 一个空格的宽度（近似 0.5 em —— PDF 正文字体空格普遍在 0.25~0.33 em，
    但本文件这类排版里 LaTeX 的单词间隙经 Td 跳跃后约 0.5~0.6 em，取折中值最稳） */
function pdfSpaceWidth(fs) { return Math.max(0.5, fs * 0.5); }

/**
 * 估算一段文字推进了多宽（em 系数）。
 * 没有 /Widths 时用字符类别近似。**系数一律取偏小值**（拉丁 0.45、等宽 0.55、全角 0.95）：
 * 估宽只会用来算「下一段离得多远」，估大了就会越过下一段的起点、把空隙算成 0，
 * 于是 `let mut` 会被拼成 `letmut`。宁可低估 —— 低估只会让空隙偏大一点点，
 * 而多一个空格远比少一个空格轻。
 */
function pdfApproxAdvance(str, fs, font) {
  const mono = !!(font && font.mono);
  let em = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x20 || c === 0xa0) em += mono ? 0.55 : 0.25;
    else if (c >= 0x2e80 && c <= 0x9fff) em += 0.95;
    else if (c >= 0xff00 && c <= 0xff60) em += 0.95;
    else if (c >= 0x3000 && c <= 0x303f) em += 0.95;
    else em += mono ? 0.55 : 0.45;
  }
  return em * fs;
}

/** 文本矩阵平移（Td / TD / T*）：new Tlm = translate(tx,ty) × Tlm */
function pdfTextMove(st, tx, ty) {
  const m = st.tlm;
  st.tlm = [m[0], m[1], m[2], m[3], m[4] + tx * m[0] + ty * m[2], m[5] + tx * m[1] + ty * m[3]];
  st.tm = st.tlm.slice();
}

/** 矩阵相乘 m × n（PDF 约定：[a b c d e f]） */
function pdfMulMatrix(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5]
  ];
}

/** 文本矩阵 × CTM —— 页面上的真实坐标。
    这一份 PDF 每页都是 `q 1 0 0 1 72 720 cm ... BT ... Td`：
    不算 CTM 的话所有 Y 都是负的（-225、-537），整页文字等于跑到纸外。 */
function pdfTextPos(st) {
  const tm = st.tm, c = st.ctm;
  return {
    x: tm[4] * c[0] + tm[5] * c[2] + c[4],
    y: tm[4] * c[1] + tm[5] * c[3] + c[5]
  };
}

/** 输出一段文字：按页坐标判断换行 / 补词距 / 记行首 X */
function pdfSinkShowText(sink, st, str) {
  if (!str) return;
  const p = pdfTextPos(st);
  const fs = Math.abs(st.size) || 1;
  if (st.lastY === null) st.lastY = p.y;
  else if (Math.abs(p.y - st.lastY) > 0.3 * fs) { sink.newline(); st.lastY = p.y; }

  if (sink.cur === '') {
    sink.curX = p.x;                       // 行首：记下来，缩进在 finish() 里统一算
    sink.curFs = fs;
  } else {
    const n = sink.gapSpaces(p.x, st);
    if (n > 0) sink.add(' '.repeat(n));
  }
  sink.add(str);
  sink.curEndX = p.x + pdfApproxAdvance(str, fs, st.font);
}

/**
 * 渲染内容流并抽取文本。
 * 跟踪文本状态：Tf Td TD Tm T* TL Tj TJ ' " Tc Tw Tz；支持 Do 递归表单 XObject。
 */
async function pdfRenderContent(doc, bytes, resources, fontMap, sink, ctx) {
  if (!bytes || bytes.length === 0) return;
  const lexer = new PDF_Lexer(bytes, 0);
  const ops = [];
  const st = {
    font: null, size: 0, leading: 0, charSpacing: 0, wordSpacing: 0, hscale: 100,
    tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0], lastY: null,
    ctm: (ctx && ctx.ctm) ? ctx.ctm.slice() : [1, 0, 0, 1, 0, 0],   // 当前变换矩阵（页面坐标 ← 内容流坐标）
    pageX: 0, curEndX: null,
    gstack: []                 // q/Q 图形状态栈（CTM 必须跟着存/取）
  };

  const showString = (val) => {
    if (!(val instanceof PDF_String)) return;
    pdfSinkShowText(sink, st, pdfDecodeShow(st.font, val.bytes));
  };

  for (;;) {
    lexer.skipWs();
    if (lexer.p >= bytes.length) break;
    const before = lexer.p;
    let tok = null;
    try { tok = lexer.parseObject(0); } catch (e) { tok = null; }
    if (lexer.p === before) { lexer.p++; continue; }   // 防死循环
    if (tok === null) continue;

    if (!(tok instanceof PDF_Op)) { ops.push(tok); if (ops.length > 1024) ops.shift(); continue; }

    const op = tok.op;
    switch (op) {
      case 'q':
        st.gstack.push(st.ctm.slice());
        break;
      case 'Q':
        if (st.gstack.length) st.ctm = st.gstack.pop();
        break;
      case 'cm': {
        const v = ops.slice(-6).map(pdfNum);
        if (v.length === 6 && v.every(x => x !== null)) st.ctm = pdfMulMatrix(v, st.ctm);
        break;
      }
      case 'BT':
        st.tm = [1, 0, 0, 1, 0, 0]; st.tlm = st.tm.slice();
        break;
      case 'ET':
        break;
      case 'Tf': {
        const nm = ops.length >= 2 && pdfAt(ops, -2) instanceof PDF_Name ? pdfAt(ops, -2).name : null;
        const sz = pdfNum(pdfAt(ops, -1));
        st.font = nm !== null ? (fontMap.get(nm) || null) : null;
        if (sz !== null) st.size = sz;
        break;
      }
      case 'Td': pdfTextMove(st, pdfNum(pdfAt(ops, -2)) || 0, pdfNum(pdfAt(ops, -1)) || 0); break;
      case 'TD': {
        const ty = pdfNum(pdfAt(ops, -1)) || 0;
        st.leading = -ty;
        pdfTextMove(st, pdfNum(pdfAt(ops, -2)) || 0, ty);
        break;
      }
      case 'Tm': {
        const v = ops.slice(-6).map(pdfNum);
        if (v.length === 6 && v.every(x => x !== null)) {
          st.tm = v.slice(); st.tlm = v.slice();
        }
        break;
      }
      case 'T*': pdfTextMove(st, 0, -st.leading); break;
      case 'TL': st.leading = pdfNum(pdfAt(ops, -1)) || 0; break;
      case 'Tc': st.charSpacing = pdfNum(pdfAt(ops, -1)) || 0; break;
      case 'Tw': st.wordSpacing = pdfNum(pdfAt(ops, -1)) || 0; break;
      case 'Tz': { const z = pdfNum(pdfAt(ops, -1)); st.hscale = z === null ? 100 : z; break; }
      case 'Tj': showString(pdfAt(ops, -1)); break;
      case "'": pdfTextMove(st, 0, -st.leading); showString(pdfAt(ops, -1)); break;
      case '"': {
        const aw = pdfNum(pdfAt(ops, -3)), ac = pdfNum(pdfAt(ops, -2));
        if (aw !== null) st.wordSpacing = aw;
        if (ac !== null) st.charSpacing = ac;
        pdfTextMove(st, 0, -st.leading);
        showString(pdfAt(ops, -1));
        break;
      }
      case 'TJ': {
        const arr = pdfAt(ops, -1);
        if (Array.isArray(arr)) {
          for (const el of arr) {
            if (typeof el === 'number') {
              // TJ 里的负调整数表示字间空隙，通常 < -100 时插入一个空格
              if (el < PDF_TJ_SPACE_LIMIT) sink.add(' ');
            } else if (el instanceof PDF_String) {
              pdfSinkShowText(sink, st, pdfDecodeShow(st.font, el.bytes));
            }
          }
        }
        break;
      }
      case 'Do': {
        // 递归表单 XObject（很多 PDF 会把正文放进 Form 里）；图像则记录下来，
        // 记的是「画到这儿时已经输出了多少字」—— 这是把图插回正文顺序的唯一线索。
        const nm = pdfAt(ops, -1) instanceof PDF_Name ? pdfAt(ops, -1).name : null;
        if (nm && ctx.depth < PDF_MAX_FORM_DEPTH) {
          try {
            const xo = await doc.resolveResource(resources, 'XObject', nm);
            if (xo instanceof PDF_Stream) {
              const sub = pdfName(await doc.resolveKey(xo.dict, 'Subtype'));
              if (sub === 'Form' && !ctx.seen.has(xo)) {
                ctx.seen.add(xo);
                const data = await doc.streamData(xo);
                const formRes = (await doc.resolveKey(xo.dict, 'Resources')) || resources;
                const formFonts = await doc.buildFonts(formRes);
                const sub2 = { depth: ctx.depth + 1, seen: ctx.seen, ctm: st.ctm.slice() };
                await pdfRenderContent(doc, data, formRes, formFonts, sink, sub2);
              } else if (sub === 'Image') {
                sink.noteImage(nm);
              }
            }
          } catch (e) { /* 单个表单失败不影响整页 */ }
        }
        break;
      }
      case 'BI': {
        // 内联图像：跳过直到 EI（图像数据是二进制，不能当运算符解析）
        const b = lexer.b;
        let i = lexer.p;
        while (i < b.length - 1) {
          if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === 0 || pdfIsWhite(b[i - 1]))) {
            const nx = b[i + 2];
            if (nx === undefined || pdfIsWhite(nx) || pdfIsDelim(nx)) { i += 2; break; }
          }
          i++;
        }
        lexer.p = i;
        break;
      }
      default:
        break;
    }
    ops.length = 0;
  }
}

/* ============================== 8. 文档解析器 ============================ */

class PDF_Document {
  constructor(bytes) {
    this.bytes = bytes;
    this.xref = new Map();          // 对象号 → {type:1 偏移} / {type:2 ObjStm} / {type:0 空闲}
    this.cache = new Map();         // 对象号 → 已解析对象
    this.scanned = null;            // 兜底扫描得到的 对象号 → 字节偏移
    this.embedded = new Map();      // 兜底扫描时从 ObjStm 里索引出的 对象号 → {stm, idx}
    this.trailer = {};              // 合并后的 trailer 字典
    this.usedFallback = false;
    this.pageList = [];             // [{dict, num}]
    this.pageNumToIndex = new Map();// 页对象号 → 0 基页序号
    this.catalog = null;
  }

  /* ---------------------------- 8.1 加载与 xref --------------------------- */

  async load() {
    const sx = this.findStartXref();
    let ok = false;
    if (sx !== null) {
      try { ok = await this.readXrefSection(sx, 0, new Set()); } catch (e) { ok = false; }
    }
    // xref 不可用 / 没有 Root：退化为字节扫描
    if (!ok || this.xref.size === 0 || !this.trailer.Root) {
      await this.scanObjectsFallback();
    }
    if (this.trailer.Encrypt) {
      throw pdfError('该 PDF 已加密（/Encrypt），当前版本不支持加密文档，请先解密后再试');
    }
  }

  /** 从文件尾部找 startxref */
  findStartXref() {
    const b = this.bytes;
    const from = Math.max(0, b.length - 4096);
    const idx = pdfLastIndexOfBytes(b, 'startxref', b.length - 1);
    if (idx < 0) return null;
    const lexer = new PDF_Lexer(b, idx + 'startxref'.length);
    lexer.skipWs();
    const n = lexer.readNumber();
    if (n === null || n < 0 || n >= b.length) return null;
    return n;
  }

  /**
   * 读取一段 xref（经典表或交叉引用流），并顺着 /Prev、/XRefStm 链继续。
   * 新版本（先处理）优先：已存在的条目不会被旧版本覆盖。
   */
  async readXrefSection(offset, depth, visited) {
    if (offset === null || offset === undefined || offset < 0 || offset >= this.bytes.length) return false;
    if (depth > PDF_MAX_XREF_DEPTH || visited.has(offset)) return false;
    visited.add(offset);

    const lexer = new PDF_Lexer(this.bytes, offset);
    lexer.skipWs();
    const word = lexer.readRegularRun();

    if (word === 'xref') {
      // ---------- 经典交叉引用表 ----------
      const local = new Map();
      for (;;) {
        lexer.skipWs();
        if (lexer.p >= this.bytes.length) break;
        if (pdfMatchAt(this.bytes, lexer.p, 'trailer')) { lexer.p += 7; break; }
        const start = lexer.readNumber();
        lexer.skipWs();
        const count = lexer.readNumber();
        if (start === null || count === null || count < 0 || count > 2000000) return false;
        for (let i = 0; i < count; i++) {
          lexer.skipWs();
          const off = lexer.readNumber();
          lexer.skipWs();
          const gen = lexer.readNumber();
          lexer.skipWs();
          const type = lexer.readRegularRun();
          if (off === null || gen === null) return false;
          const num = start + i;
          if (type === 'n') local.set(num, { type: 1, offset: off, gen });
          else local.set(num, { type: 0 });
        }
      }
      this.mergeEntries(local);
      lexer.skipWs();
      const trailer = lexer.parseObject(0);
      if (trailer && typeof trailer === 'object' && !trailer.__stream) {
        this.mergeTrailer(trailer);
        // 混合引用：/XRefStm 指向同代的交叉引用流（补全被压缩对象）
        const xs = pdfNum(trailer.XRefStm);
        if (xs !== null) {
          try { await this.readXrefStreamAt(xs, local, false); } catch (e) { /* 忽略 */ }
          this.mergeEntries(local);
        }
        const prev = pdfNum(trailer.Prev);
        if (prev !== null) { try { await this.readXrefSection(prev, depth + 1, visited); } catch (e) { /* 忽略 */ } }
      }
      return true;
    }

    // ---------- 交叉引用流（PDF 1.5+）----------
    const obj = await this.parseObjectAt(offset, null);
    if (obj && obj.__stream) {
      const type = pdfName(await this.resolveKey(obj.dict, 'Type'));
      if (type === 'XRef' || obj.dict.W) {
        const local = new Map();
        await this.readXrefStreamObject(obj, local);
        this.mergeEntries(local);
        this.mergeTrailer(obj.dict);
        const prev = pdfNum(await this.resolveKey(obj.dict, 'Prev'));
        if (prev !== null) { try { await this.readXrefSection(prev, depth + 1, visited); } catch (e) { /* 忽略 */ } }
        return true;
      }
    }
    return false;
  }

  /** 解析 /XRef 流并在指定偏移处读取（混合引用用） */
  async readXrefStreamAt(offset, local) {
    const obj = await this.parseObjectAt(offset, null);
    if (obj && obj.__stream) await this.readXrefStreamObject(obj, local);
  }

  /**
   * 交叉引用流条目解析：/W [w1 w2 w3]、/Index [start count ...]
   * 每行三字段：类型、字段二、字段三。
   */
  async readXrefStreamObject(stream, local) {
    const data = await this.streamData(stream);
    const dict = stream.dict;
    const W = await this.resolveKey(dict, 'W');
    if (!Array.isArray(W)) return;
    const w = W.map(x => pdfNum(x) || 0);
    const rowLen = w.reduce((a, b) => a + b, 0);
    if (rowLen <= 0) return;

    let index = await this.resolveKey(dict, 'Index');
    if (!Array.isArray(index) || index.length < 2) {
      const size = pdfNum(await this.resolveKey(dict, 'Size')) || 0;
      index = [0, size];
    }
    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const start = pdfNum(index[s]) || 0;
      const count = pdfNum(index[s + 1]) || 0;
      for (let i = 0; i < count; i++) {
        if (p + rowLen > data.length) return;
        const f = [];
        for (const width of w) {
          let v = 0;
          for (let k = 0; k < width; k++) v = v * 256 + data[p++];
          f.push(v);
        }
        const type = w[0] === 0 ? 1 : f[0];    // 类型字段宽度为 0 时默认 1
        const num = start + i;
        if (type === 0) local.set(num, { type: 0 });
        else if (type === 1) local.set(num, { type: 1, offset: f[1], gen: f[2] });
        else if (type === 2) local.set(num, { type: 2, objstm: f[1], idx: f[2] });
      }
    }
  }

  /** 合并 xref 条目：已存在的不覆盖，除非旧条目是空闲项而新条目有实体 */
  mergeEntries(local) {
    for (const [num, e] of local) {
      const old = this.xref.get(num);
      if (!old) this.xref.set(num, e);
      else if (old.type === 0 && e.type !== 0) this.xref.set(num, e);
    }
  }
  /** 合并 trailer：先到（更新版本）者优先 */
  mergeTrailer(t) {
    for (const k in t) if (!(k in this.trailer) && k !== 'W' && k !== 'Index') this.trailer[k] = t[k];
  }

  /* --------------------------- 8.2 字节扫描兜底 --------------------------- */

  /**
   * 兜底方案：直接扫描 "N G obj" 模式建立索引。
   * 同时把 /ObjStm 里的压缩对象登记进来（压缩对象无法被字节扫描直接看到）。
   */
  async scanObjectsFallback() {
    this.usedFallback = true;
    if (!this.scanned) {
      this.scanned = new Map();
      const text = pdfBytesToLatin1(this.bytes);
      const re = /(?:^|[\s>\]\)\/])(\d{1,10})[\s]+(\d{1,5})[\s]+obj\b/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const num = parseInt(m[1], 10);
        if (!isFinite(num)) continue;
        const lead = m[0].length - m[0].replace(/^[\s>\]\)\/]/, '').length;
        const off = m.index + lead;
        this.scanned.set(num, off);   // 后出现者覆盖先出现者（符合增量更新的语义）
      }
    }
    // 额外扫描 trailer 字典（用于拿 /Info 等）
    const tIdx = pdfLastIndexOfBytes(this.bytes, 'trailer', this.bytes.length - 1);
    if (tIdx >= 0 && !this.trailer.Root) {
      try {
        const lx = new PDF_Lexer(this.bytes, tIdx + 7);
        const t = lx.parseObject(0);
        if (t && typeof t === 'object' && !t.__stream) this.mergeTrailer(t);
      } catch (e) { /* 忽略 */ }
    }
    // 逐个解析扫描到的对象：找出 Catalog，并登记 ObjStm 内部对象
    const nums = Array.from(this.scanned.keys()).sort((a, b) => a - b);
    for (const num of nums) {
      let obj;
      try { obj = await this.getObj(num); } catch (e) { continue; }
      if (!obj || typeof obj !== 'object') continue;
      if (!obj.__stream && obj.Type && pdfName(obj.Type) === 'Catalog' && !this.trailer.Root) {
        this.trailer.Root = new PDF_Ref(num, 0);
      }
      if (obj.__stream && pdfName(obj.dict.Type) === 'ObjStm') {
        try {
          const data = await this.streamData(obj);
          const lexer = new PDF_Lexer(data, 0);
          const n = pdfNum(await this.resolveKey(obj.dict, 'N')) || 0;
          for (let i = 0; i < n; i++) {
            lexer.skipWs();
            const on = lexer.readNumber();
            lexer.skipWs();
            const oo = lexer.readNumber();
            if (on === null || oo === null) break;
            if (!this.embedded.has(on)) this.embedded.set(on, { stm: num, idx: i });
          }
        } catch (e) { /* 忽略 */ }
      }
    }
  }

  /* ----------------------------- 8.3 对象读取 ----------------------------- */

  /** 解析指定偏移处的 "N G obj ..." */
  async parseObjectAt(offset, expectNum) {
    const lexer = new PDF_Lexer(this.bytes, offset);
    lexer.skipWs();
    let save = lexer.p;
    const numTok = lexer.readRegularRun();
    if (!/^\d+$/.test(numTok)) return null;
    const num = parseInt(numTok, 10);
    lexer.skipWs();
    const genTok = lexer.readRegularRun();
    if (!/^\d+$/.test(genTok)) return null;
    lexer.skipWs();
    const kw = lexer.readRegularRun();
    if (kw !== 'obj') return null;
    if (expectNum !== null && expectNum !== undefined && num !== expectNum) return null;

    const obj = lexer.parseObject(0);
    lexer.skipWs();
    save = lexer.p;
    const kw2 = lexer.readRegularRun();
    if (kw2 === 'stream') {
      const raw = await this.readStreamBytes(lexer, obj);
      return new PDF_Stream(obj, raw);
    }
    lexer.p = save;
    return obj;
  }

  /** 同步版本（仅在兜底扫描里用于快速探测，不解析间接的 /Length） */
  parseObjectAtSync(num) {
    const offset = this.scanned.get(num);
    if (offset === undefined) return null;
    const lexer = new PDF_Lexer(this.bytes, offset);
    lexer.skipWs();
    const numTok = lexer.readRegularRun();
    if (!/^\d+$/.test(numTok) || parseInt(numTok, 10) !== num) return null;
    lexer.skipWs(); lexer.readRegularRun();       // gen
    lexer.skipWs();
    if (lexer.readRegularRun() !== 'obj') return null;
    const obj = lexer.parseObject(0);
    lexer.skipWs();
    const save = lexer.p;
    if (lexer.readRegularRun() === 'stream') {
      const raw = this.readStreamBytesSync(lexer, obj);
      return new PDF_Stream(obj, raw);
    }
    lexer.p = save;
    return obj;
  }

  /** 读取 stream 的原始字节：优先 /Length，校验失败则搜索 endstream */
  async readStreamBytes(lexer, dict) {
    let declared = null;
    const L = dict ? dict.Length : null;
    if (typeof L === 'number') declared = L;
    else if (L instanceof PDF_Ref) {
      try { const r = await this.resolve(L); if (typeof r === 'number') declared = r; } catch (e) { /* 忽略 */ }
    }
    return this.readStreamBytesCommon(lexer, declared);
  }
  readStreamBytesSync(lexer, dict) {
    const L = dict ? dict.Length : null;
    return this.readStreamBytesCommon(lexer, typeof L === 'number' ? L : null);
  }
  readStreamBytesCommon(lexer, declared) {
    const b = this.bytes;
    let p = lexer.p;
    if (b[p] === 0x0D) p++;
    if (b[p] === 0x0A) p++;
    const start = p;
    if (declared !== null && declared >= 0 && start + declared <= b.length) {
      let q = start + declared;
      while (q < b.length && pdfIsWhite(b[q])) q++;
      if (pdfMatchAt(b, q, 'endstream')) {
        lexer.p = q + 9;
        return b.slice(start, start + declared);
      }
    }
    // /Length 不可信：搜索 endstream
    const idx = pdfIndexOfBytes(b, 'endstream', start);
    let end = idx < 0 ? b.length : idx;
    while (end > start && (b[end - 1] === 0x0A || b[end - 1] === 0x0D)) end--;
    lexer.p = idx < 0 ? b.length : idx + 9;
    return b.slice(start, end);
  }

  /** 取对象（带缓存）；type 2 走对象流 */
  async getObj(num) {
    if (num === null || num === undefined) return null;
    if (this.cache.has(num)) return this.cache.get(num);
    this.cache.set(num, null);   // 防环
    let obj = null;
    const entry = this.xref.get(num);
    if (entry) {
      if (entry.type === 1) {
        try { obj = await this.parseObjectAt(entry.offset, num); } catch (e) { obj = null; }
      } else if (entry.type === 2) {
        try { obj = await this.getFromObjStm(entry.objstm, entry.idx); } catch (e) { obj = null; }
      }
    }
    if (!obj && this.scanned && this.scanned.has(num)) {
      try { obj = await this.parseObjectAt(this.scanned.get(num), num); } catch (e) { obj = null; }
    }
    if (!obj && this.embedded && this.embedded.has(num)) {
      const e = this.embedded.get(num);
      try { obj = await this.getFromObjStm(e.stm, e.idx); } catch (e2) { obj = null; }
    }
    this.cache.set(num, obj);
    return obj;
  }

  /** 解引用：PDF_Ref → 实际对象；数组则逐项解引用 */
  async resolve(v) {
    if (v instanceof PDF_Ref) return await this.getObj(v.num);
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) out.push(x instanceof PDF_Ref ? await this.getObj(x.num) : x);
      return out;
    }
    return v;
  }
  /** 取字典某个键并解引用 */
  async resolveKey(dict, key) {
    if (!dict || typeof dict !== 'object' || dict.__stream) return undefined;
    const v = dict[key];
    if (v === undefined) return undefined;
    return await this.resolve(v);
  }
  /** 只解引用间接引用，不动数组内部（目录目标数组必须保留页对象引用） */
  async resolveRef(v) {
    if (v instanceof PDF_Ref) return await this.getObj(v.num);
    return v;
  }
  /** 取原始值（不解引用），用于目标数组等需要保留 PDF_Ref 的场合 */
  rawKey(dict, key) {
    if (!dict || typeof dict !== 'object' || dict.__stream) return undefined;
    return dict[key];
  }
  /** 取资源字典里的具名条目（如 /Font /F1） */
  async resolveResource(resources, category, name) {
    if (!resources) return null;
    const cat = await this.resolveKey(resources, category);
    if (!cat || typeof cat !== 'object' || cat.__stream) return null;
    const v = cat[name];
    if (v === undefined) return null;
    return await this.resolve(v);
  }

  /**
   * 从 /ObjStm 对象流里取第 idx 个对象。
   * 结构：头部是 "对象号 偏移" 对，正文从 /First 之后开始。
   */
  async getFromObjStm(stmNum, idx) {
    const st = await this.getObj(stmNum);
    if (!(st instanceof PDF_Stream)) return null;
    if (!st.__objStm) {
      const data = await this.streamData(st);
      const n = pdfNum(await this.resolveKey(st.dict, 'N')) || 0;
      const first = pdfNum(await this.resolveKey(st.dict, 'First')) || 0;
      const header = new PDF_Lexer(data, 0);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        header.skipWs();
        const on = header.readNumber();
        header.skipWs();
        const oo = header.readNumber();
        if (on === null || oo === null) break;
        pairs.push({ num: on, off: oo });
      }
      const objs = new Map();
      for (let i = 0; i < pairs.length; i++) {
        const lx = new PDF_Lexer(data, first + pairs[i].off);
        let o = null;
        try { o = lx.parseObject(0); } catch (e) { o = null; }
        objs.set(i, o);
        // 同时按真实对象号缓存，便于其它地方直接命中
        if (pairs[i].num != null && !this.cache.has(pairs[i].num)) this.cache.set(pairs[i].num, o);
      }
      st.__objStm = { pairs, objs };
    }
    const s = st.__objStm;
    return s.objs.has(idx) ? s.objs.get(idx) : null;
  }

  /** 解码流（应用 /Filter 与 /DecodeParms） */
  async streamData(stream) {
    if (!stream || !stream.__stream) return new Uint8Array(0);
    if (stream.__decoded) return stream.__decoded;
    let filters = await this.resolveKey(stream.dict, 'Filter');
    let parms = await this.resolveKey(stream.dict, 'DecodeParms');
    if (filters === undefined || filters === null) { stream.__decoded = stream.raw; return stream.raw; }
    const fList = Array.isArray(filters) ? filters : [filters];
    const pList = Array.isArray(parms) ? parms : [parms];
    let data = stream.raw;
    for (let i = 0; i < fList.length; i++) {
      const f = fList[i];
      if (f === null || f === undefined) continue;
      const fname = pdfName(f) || (typeof f === 'string' ? f : null);
      let p = pList[i] !== undefined ? pList[i] : (pList.length === 1 ? pList[0] : null);
      if (p && p.__stream) p = null;
      switch (fname) {
        case 'FlateDecode': case 'Fl':
          data = await pdfInflate(data);
          data = pdfApplyPredictor(data, p);
          break;
        case 'LZWDecode': case 'LZW':
          throw pdfError('暂不支持 LZWDecode 压缩的 PDF 流');
        case 'ASCIIHexDecode': case 'AHx':
          data = pdfAsciiHexDecode(data);
          break;
        case 'ASCII85Decode': case 'A85':
          data = pdfAscii85Decode(data);
          break;
        case 'RunLengthDecode': case 'RL':
          data = pdfRunLengthDecode(data);
          break;
        case 'Crypt':
          break;  // 只有 Identity 情况才可能到这里
        default:
          if (fname) throw pdfError('暂不支持的流过滤器：' + fname);
          break;
      }
    }
    stream.__decoded = data;
    return data;
  }

  /* ------------------------------ 8.4 页面 ------------------------------- */

  async getCatalog() {
    if (this.catalog) return this.catalog;
    let root = await this.resolveKey(this.trailer, 'Root');
    if (!root || typeof root !== 'object' || root.__stream) {
      // trailer 里没有 /Root：全局搜一个 /Type /Catalog
      const candidates = this.scanned || new Map();
      for (const [num] of candidates) {
        const o = await this.getObj(num);
        if (o && !o.__stream && o.Type && pdfName(o.Type) === 'Catalog') { root = o; break; }
      }
    }
    if (!root || typeof root !== 'object') throw pdfError('PDF 结构损坏：找不到文档目录（/Root /Catalog）');
    this.catalog = root;
    return root;
  }

  /** 递归页面树，按 /Kids 顺序收集页面；/Resources 等沿父节点继承 */
  async walkPages(node, nodeNum, inherited, visited, depth) {
    if (!node || typeof node !== 'object' || node.__stream || depth > 64) return;
    const inh = Object.assign({}, inherited);
    const res = await this.resolveKey(node, 'Resources');
    if (res) inh.resources = res;
    const mb = await this.resolveKey(node, 'MediaBox');
    if (mb) inh.mediaBox = mb;
    const rot = await this.resolveKey(node, 'Rotate');
    if (rot !== undefined) inh.rotate = rot;

    const type = pdfName(await this.resolveKey(node, 'Type'));
    const kids = this.rawKey(node, 'Kids');   // 用原始数组，保留每个孩子的对象号
    if (type === 'Pages' || (Array.isArray(kids) && type !== 'Page')) {
      if (!Array.isArray(kids)) return;
      for (const kid of kids) {
        let knum = kid instanceof PDF_Ref ? kid.num : null;
        if (knum !== null) { if (visited.has(knum)) continue; visited.add(knum); }
        const kobj = await this.resolve(kid);
        await this.walkPages(kobj, knum, inh, visited, depth + 1);
      }
      return;
    }
    // 叶子页
    this.pageList.push({ dict: node, num: nodeNum, resources: inh.resources, mediaBox: inh.mediaBox });
  }

  async collectPages() {
    const catalog = await this.getCatalog();
    const pagesRoot = await this.resolveKey(catalog, 'Pages');
    const visited = new Set();
    if (pagesRoot && typeof pagesRoot === 'object') {
      const rootNum = catalog.Pages instanceof PDF_Ref ? catalog.Pages.num : null;
      if (rootNum !== null) visited.add(rootNum);
      await this.walkPages(pagesRoot, rootNum, {}, visited, 0);
    }
    // 页面树缺失或为空：扫描所有 /Type /Page 对象
    if (this.pageList.length === 0 && this.scanned) {
      const nums = Array.from(this.scanned.keys()).sort((a, b) => a - b);
      for (const num of nums) {
        const o = await this.getObj(num);
        if (o && !o.__stream && pdfName(o.Type) === 'Page') this.pageList.push({ dict: o, num, resources: await this.resolveKey(o, 'Resources') });
      }
    }
  }

  /** 单页文本 */
  async pageText(entry) {
    const contents = await this.resolveKey(entry.dict, 'Contents');
    const chunks = [];
    const pushStream = async (s) => {
      if (s instanceof PDF_Stream) {
        try { chunks.push(await this.streamData(s)); } catch (e) { /* 单流失败忽略 */ }
      }
    };
    if (contents instanceof PDF_Stream) await pushStream(contents);
    else if (Array.isArray(contents)) {
      for (const c of contents) {
        if (c instanceof PDF_Stream) await pushStream(c);
        else if (c instanceof PDF_Ref) { const r = await this.resolve(c); await pushStream(r); }
      }
    }
    if (chunks.length === 0) return '';
    let total = 0;
    for (const c of chunks) total += c.length;
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { data.set(c, off); off += c.length; }

    const fonts = await this.buildFonts(entry.resources);
    const sink = new PDF_TextSink();
    const ctx = { depth: 0, seen: new Set() };
    await pdfRenderContent(this, data, entry.resources, fonts, sink, ctx);
    return sink.finish();
  }

  /** 同 pageText，但同时回传「图是在哪一行之后画的」，用来把图插回正文顺序 */
  async pageTextAndImages(entry) {
    const contents = await this.resolveKey(entry.dict, 'Contents');
    const chunks = [];
    const pushStream = async (s) => {
      if (s instanceof PDF_Stream) {
        try { chunks.push(await this.streamData(s)); } catch (e) { /* 忽略 */ }
      }
    };
    if (contents instanceof PDF_Stream) await pushStream(contents);
    else if (Array.isArray(contents)) {
      for (const c of contents) {
        if (c instanceof PDF_Stream) await pushStream(c);
        else if (c instanceof PDF_Ref) { const r = await this.resolve(c); await pushStream(r); }
      }
    }
    if (chunks.length === 0) return { text: '', images: [] };
    let total = 0;
    for (const c of chunks) total += c.length;
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { data.set(c, off); off += c.length; }

    const fonts = await this.buildFonts(entry.resources);
    const sink = new PDF_TextSink();
    const ctx = { depth: 0, seen: new Set() };
    await pdfRenderContent(this, data, entry.resources, fonts, sink, ctx);
    const text = sink.finish();
    return { text, images: sink.images };
  }

  /** 页面资源里的字体名 → 字体信息 */
  async buildFonts(resources) {
    const map = new Map();
    if (!resources) return map;
    let fontDict;
    try { fontDict = await this.resolveKey(resources, 'Font'); } catch (e) { return map; }
    if (!fontDict || typeof fontDict !== 'object' || fontDict.__stream) return map;
    for (const key of Object.keys(fontDict)) {
      try {
        const fd = await this.resolve(fontDict[key]);
        if (fd && typeof fd === 'object' && !fd.__stream) map.set(key, await pdfBuildFont(this, fd));
      } catch (e) { /* 单个字体失败忽略 */ }
    }
    return map;
  }

  /* ------------------------------ 8.5 目录 ------------------------------- */

  /** 名字树递归查找（/Root /Names /Dests） */
  async searchNameTree(node, name, depth) {
    if (!node) return undefined;
    node = await this.resolveRef(node);
    if (!node || typeof node !== 'object' || node.__stream || depth > 16) return undefined;
    const names = this.rawKey(node, 'Names');   // 原始数组：[名字 目标 名字 目标 ...]
    if (Array.isArray(names)) {
      for (let i = 0; i + 1 < names.length; i += 2) {
        const k = names[i];
        let key = null;
        if (k instanceof PDF_String) key = pdfDecodeTextString(k.bytes);
        else if (k instanceof PDF_Name) key = k.name;
        if (key !== null && (key === name || key === '/' + name)) return names[i + 1];
      }
    }
    const kids = this.rawKey(node, 'Kids');
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        const found = await this.searchNameTree(kid, name, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  /** 名字型目标 → 目标数组 */
  async lookupNamedDest(name, catalog) {
    // 1) /Root /Dests 字典（PDF 1.1 旧写法）
    const dests = await this.resolveRef(this.rawKey(catalog, 'Dests'));
    if (dests && typeof dests === 'object' && !dests.__stream) {
      let v = dests[name];
      if (v === undefined) v = dests['/' + name];
      if (v !== undefined) return await this.destValue(v);
    }
    // 2) /Root /Names /Dests 名字树
    const names = await this.resolveRef(this.rawKey(catalog, 'Names'));
    if (names && typeof names === 'object' && !names.__stream) {
      const tree = this.rawKey(names, 'Dests');
      if (tree !== undefined) {
        const found = await this.searchNameTree(tree, name, 0);
        if (found !== undefined) return await this.destValue(found);
      }
    }
    return null;
  }
  /** 目标值可能是数组，也可能是 /D 字典（都要保留数组里的 PDF_Ref） */
  async destValue(v) {
    let r = v;
    for (let i = 0; i < 8; i++) {
      r = await this.resolveRef(r);
      if (Array.isArray(r)) return r;
      if (r && typeof r === 'object' && !r.__stream) {
        const d = this.rawKey(r, 'D');
        if (d === undefined) return null;
        r = d;
        continue;
      }
      return null;
    }
    return null;
  }

  /** 解析条目的目标 → 0 基页序号（解析不出来返回 null，不抛错） */
  async resolveNodeDest(node, catalog) {
    try {
      let dest = this.rawKey(node, 'Dest');
      if (dest === undefined || dest === null) {
        const action = await this.resolveRef(this.rawKey(node, 'A'));
        if (action && typeof action === 'object' && !action.__stream) {
          const s = pdfName(await this.resolveKey(action, 'S'));
          if (s === 'GoTo') dest = this.rawKey(action, 'D');
          else return null;     // 远程跳转等其它动作不再处理
        }
      }
      if (dest === undefined || dest === null) return null;

      // 名字型目标。注意 pypdf / LaTeX 产出的 /D 是**字符串**而不是 Name：
      //   /A << /S /GoTo /D (chapter\052\0562) >>
      // 只认 PDF_Name 会把 104 条目录全部丢掉。
      if (typeof dest === 'string' || dest instanceof PDF_Name || dest instanceof PDF_String) {
        const nm = dest instanceof PDF_Name ? dest.name
                 : dest instanceof PDF_String ? pdfDecodeTextString(dest.bytes)
                 : dest;
        const arr = await this.lookupNamedDest(nm, catalog);
        if (arr) return await this.destToPageIndex(arr);
        return null;
      }
      const resolved = await this.resolveRef(dest);
      if (Array.isArray(resolved)) {
        // 数组里第一项可能就是名字（旧格式 [ /Named /XYZ ... ]）
        const f0 = resolved[0];
        if (resolved.length && (f0 instanceof PDF_Name || f0 instanceof PDF_String || typeof f0 === 'string')) {
          const nm = f0 instanceof PDF_Name ? f0.name
                   : f0 instanceof PDF_String ? pdfDecodeTextString(f0.bytes)
                   : f0;
          const arr = await this.lookupNamedDest(nm, catalog);
          return await this.destToPageIndex(arr);
        }
        return await this.destToPageIndex(resolved);
      }
      return null;
    } catch (e) { return null; }
  }

  async destToPageIndex(dest) {
    if (!Array.isArray(dest) || dest.length === 0) return null;
    const first = dest[0];
    if (first instanceof PDF_Ref) {
      const idx = this.pageNumToIndex.get(first.num);
      return idx === undefined ? null : idx;
    }
    if (typeof first === 'number') {
      return Math.max(0, Math.min(this.pageList.length - 1, first));
    }
    return null;
  }

  /** 遍历 /Outlines：沿 /Next 走，递归 /First（深度上限 3），用 visited 防环 */
  async buildOutline() {
    const out = [];
    let catalog;
    try { catalog = await this.getCatalog(); } catch (e) { return out; }
    // 目标里存的是页**对象号**，必须先把 对象号→序号 建好，
    // 否则每一条都会因为查不到页号而被丢弃（外部调用方不该承担这个前置条件）。
    if (this.pageNumToIndex.size === 0) {
      for (let i = 0; i < this.pageList.length; i++) {
        if (this.pageList[i].num !== null) this.pageNumToIndex.set(this.pageList[i].num, i);
      }
    }
    const outlines = await this.resolveKey(catalog, 'Outlines');
    if (!outlines || typeof outlines !== 'object' || outlines.__stream) return out;

    const visited = new Set();
    const walk = async (node, nodeNum, depth) => {
      let cur = node, curNum = nodeNum;
      while (cur && typeof cur === 'object' && !cur.__stream) {
        if (curNum !== null && visited.has(curNum)) break;   // 防 /Parent 环 / 重复节点
        if (curNum !== null) visited.add(curNum);

        if (depth <= PDF_MAX_OUTLINE_DEPTH) {
          try {
            const titleRaw = await this.resolveKey(cur, 'Title');
            let title = '';
            if (titleRaw instanceof PDF_String) title = pdfDecodeTextString(titleRaw.bytes);
            else if (typeof titleRaw === 'string') title = titleRaw;
            const page = await this.resolveNodeDest(cur, catalog);
            if (title && page !== null) out.push({ title, page, depth });
          } catch (e) { /* 单条失败跳过 */ }

          const firstRef = cur.First;
          const first = await this.resolveKey(cur, 'First');
          if (first && typeof first === 'object' && !first.__stream) {
            const fnum = firstRef instanceof PDF_Ref ? firstRef.num : null;
            await walk(first, fnum, depth + 1);
          }
        }
        const nextRef = cur.Next;
        cur = await this.resolveKey(cur, 'Next');
        curNum = nextRef instanceof PDF_Ref ? nextRef.num : null;
      }
    };

    const firstRef = outlines.First;
    const first = await this.resolveKey(outlines, 'First');
    const fnum = firstRef instanceof PDF_Ref ? firstRef.num : null;
    if (first) await walk(first, fnum, 1);
    return out;
  }

  /* ------------------------------ 8.6 元信息 ------------------------------ */

  async buildInfo() {
    let title = '', author = '';
    try {
      const info = await this.resolveKey(this.trailer, 'Info');
      if (info && typeof info === 'object' && !info.__stream) {
        const t = await this.resolveKey(info, 'Title');
        if (t instanceof PDF_String) title = pdfDecodeTextString(t.bytes);
        const a = await this.resolveKey(info, 'Author');
        if (a instanceof PDF_String) author = pdfDecodeTextString(a.bytes);
      }
    } catch (e) { /* 忽略 */ }
    return { title, author, pageCount: this.pageList.length };
  }
}

/* ============================== 9. 对外接口 =============================== */

/** 内部实现 */
async function pdfExtractImpl(arrayBuffer, opts) {
  const withImages = !!(opts && opts.withImages);
  let bytes;
  if (arrayBuffer instanceof Uint8Array) bytes = arrayBuffer;
  else if (typeof ArrayBuffer !== 'undefined' && arrayBuffer instanceof ArrayBuffer) bytes = new Uint8Array(arrayBuffer);
  else if (arrayBuffer && arrayBuffer.buffer && typeof arrayBuffer.byteLength === 'number') {
    bytes = new Uint8Array(arrayBuffer.buffer, arrayBuffer.byteOffset || 0, arrayBuffer.byteLength);
  } else {
    throw pdfError('pdfExtract：请传入 ArrayBuffer（或 Uint8Array）');
  }
  if (bytes.length < 8) throw pdfError('不是有效的 PDF 文件：数据太短');
  // 允许文件头前有少量垃圾（部分生成器会加前导字节）
  const headLimit = Math.min(bytes.length, 4096);
  if (pdfLastIndexOfBytes(bytes.subarray(0, headLimit), '%PDF-', headLimit - 1) < 0) {
    throw pdfError('不是有效的 PDF 文件：未找到 %PDF- 文件头');
  }

  const doc = new PDF_Document(bytes);
  await doc.load();
  await doc.collectPages();
  for (let i = 0; i < doc.pageList.length; i++) {
    if (doc.pageList[i].num !== null) doc.pageNumToIndex.set(doc.pageList[i].num, i);
  }

  const pages = [];
  for (let i = 0; i < doc.pageList.length; i++) {
    if (withImages) {
      // 一页里既可能有正文也可能有示意图：把「图在哪一行之后画的」一并带回，
      // 上层才能把图插回正文顺序（而不是整页降级成图像模式）。
      let text = '', imgs = [];
      try {
        const r = await doc.pageTextAndImages(doc.pageList[i]);
        text = r.text; imgs = r.images;
      } catch (e) { text = ''; }
      const out = [];
      for (const im of imgs) {
        try {
          const xo = await doc.resolveResource(doc.pageList[i].resources, 'XObject', im.name);
          if (!(xo instanceof PDF_Stream)) continue;
          const info = await pdfDecodeImageObject(doc, xo, out.length);
          if (info.kind === 'jpeg' || info.kind === 'raw') {
            out.push({ line: im.line, charInLine: im.charInLine, info });
          }
        } catch (e) { /* 单张图失败不影响整页 */ }
      }
      pages.push({ index: i, text, images: out });
      continue;
    }
    let text = '';
    try { text = await doc.pageText(doc.pageList[i]); } catch (e) { text = ''; }
    pages.push({ index: i, text });
  }

  let outline = [];
  try { outline = await doc.buildOutline(); } catch (e) { outline = []; }

  const info = await doc.buildInfo();
  info.pageCount = pages.length;
  return { pages, outline, info };
}

/** 对外主函数：失败时抛出可读的中文原因。
    opts.withImages = true 时，每页额外带 images: [{line, charInLine, info}]，
    用来把页面内嵌图插回正文顺序（默认关闭，避免不需要时多花解码时间）。 */
async function pdfExtract(arrayBuffer, opts) {
  try {
    return await pdfExtractImpl(arrayBuffer, opts);
  } catch (err) {
    if (err && err.__pdfUserError) throw err;
    throw pdfError('解析 PDF 失败：' + (err && err.message ? err.message : String(err)));
  }
}

/* =========================================================================
   图像页提取 —— 给「没有文本层」的扫描件用。
   扫描件每一页本质上就是一张嵌入图片，而最常见的编码恰好是浏览器能直接解码的：
     · DCTDecode(JPEG)         → 原样取出字节，交给 createImageBitmap 解码
     · FlateDecode + 8bpc RGB/灰度 → 解出原始位图，包成 ImageData
   传真类编码（CCITTFax / JBIG2 / JPX）需要专门的解码器，这里明确标注为不支持。
   ========================================================================= */

/** 描述一页里最大的那张图 */
/**
 * 解析图像的色彩空间，得出「每像素几个分量」。
 * 支持 Device RGB/Gray/CMYK 与 [/Indexed base hival lookup]（调色板）。
 * 调色板要额外把 lookup 表读出来 —— LaTeX/pandoc 画的示意图基本都是这一种
 * （hello-algo 里 514 张图有 482 张是 /Indexed），不认它等于整本书的图都看不到。
 */
async function pdfImageColorSpace(doc, dict) {
  let csRaw = null;
  try { csRaw = await doc.resolveKey(dict, 'ColorSpace'); } catch (e) { return null; }
  if (csRaw == null) return null;
  // 可能是指向数组/名字的引用
  try { csRaw = await doc.resolveRef(csRaw); } catch (e) { /* 保持原样 */ }

  // 常见写法：直接一个名字
  if (typeof csRaw === 'string' || pdfName(csRaw) || csRaw instanceof PDF_Name) {
    const nm = pdfName(csRaw) || csRaw;
    return { kind: nm, comps: nm === 'DeviceRGB' ? 3 : nm === 'DeviceGray' ? 1 : nm === 'DeviceCMYK' ? 4 : 0 };
  }
  if (!Array.isArray(csRaw) || csRaw.length === 0) return null;

  const head = pdfName(csRaw[0]) || csRaw[0];
  if (head === 'Indexed' || head === 'I') {
    // [ /Indexed base hival lookup ]
    const base = pdfName(csRaw[1]) || csRaw[1];
    if (base !== 'DeviceRGB' && base !== 'DeviceGray') {
      return { kind: 'Indexed/' + (base || '?'), comps: 0, indexedBase: base };
    }
    const hival = pdfNum(csRaw[2]);
    if (hival === null || hival < 0) return { kind: 'Indexed', comps: 0 };
    const baseComps = base === 'DeviceRGB' ? 3 : 1;
    const need = (hival + 1) * baseComps;
    let table = null;
    const look = csRaw[3];
    if (look instanceof PDF_String) table = look.bytes;
    else {
      // lookup 也可能是流或引用
      let s = look;
      try { s = await doc.resolveRef(look); } catch (e) { /* 保持原样 */ }
      if (s instanceof PDF_String) table = s.bytes;
      else if (s && s.__stream) { try { table = await doc.streamData(s); } catch (e) { table = null; } }
    }
    if (!table || table.length < need) return { kind: 'Indexed', comps: 0, indexedBase: base };
    return { kind: 'Indexed', comps: 1, indexedBase: base, palette: table.subarray(0, need), baseComps };
  }
  // 其它数组形式（ICCBased 等）：取最后一个名字当近似
  for (let i = csRaw.length - 1; i >= 0; i--) {
    const nm = pdfName(csRaw[i]);
    if (nm) return { kind: nm, comps: nm === 'DeviceRGB' ? 3 : nm === 'DeviceGray' ? 1 : nm === 'DeviceCMYK' ? 4 : 0 };
  }
  return null;
}

/** 调色板索引位图 → RGB 三元组 */
function pdfExpandIndexed(data, w, h, cs) {
  const n = w * h, bc = cs.baseComps, pal = cs.palette;
  const out = new Uint8Array(n * 3);
  for (let i = 0, o = 0; i < n; i++) {
    const idx = data[i] * bc;
    if (bc === 3) { out[o++] = pal[idx] || 0; out[o++] = pal[idx + 1] || 0; out[o++] = pal[idx + 2] || 0; }
    else { const g = pal[data[i]] || 0; out[o++] = g; out[o++] = g; out[o++] = g; }
  }
  return out;
}

/**
 * 软掩模（/SMask）→ 把 RGB 位图合成为 RGBA。
 * 少数图（hello-algo 里 6 张）把图形画在掩模里、靠 SMask 提供透明度；
 * 不合成的话黑色会变成一整块黑斑。SMask 是 DeviceGray 8bpc 的灰度图。
 */
async function pdfApplySMask(doc, dict, rgb, w, h) {
  let sm = null;
  try { sm = await doc.resolveKey(dict, 'SMask'); } catch (e) { return null; }
  if (!sm) return null;
  if (sm instanceof PDF_Ref || (sm && sm.num !== undefined && !sm.__stream)) {
    try { sm = await doc.resolveRef(sm); } catch (e) { return null; }
  }
  if (!sm || !sm.__stream) return null;
  const sw = pdfNum(await doc.resolveKey(sm.dict, 'Width')) || 0;
  const sh = pdfNum(await doc.resolveKey(sm.dict, 'Height')) || 0;
  const sbpc = pdfNum(await doc.resolveKey(sm.dict, 'BitsPerComponent'));
  if (sbpc !== 8) return null;
  let alpha = null;
  try { alpha = await doc.streamData(sm); } catch (e) { return null; }
  if (!alpha) return null;

  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    // 掩模与图像尺寸可能不同，按比例取样
    const sy = sh === h ? y : Math.min(sh - 1, Math.floor(y * sh / h));
    for (let x = 0; x < w; x++) {
      const sx = sw === w ? x : Math.min(sw - 1, Math.floor(x * sw / w));
      const a = alpha[sy * sw + sx];
      const o = (y * w + x) * 4, i = (y * w + x) * 3;
      // 未预乘：图形区域不透明，其余透明
      out[o] = rgb[i]; out[o + 1] = rgb[i + 1]; out[o + 2] = rgb[i + 2]; out[o + 3] = a;
    }
  }
  return out;
}

/** 解码指定的图像 XObject（不负责挑选） */
async function pdfDecodeImageObject(doc, obj, index) {
  const base = { index, kind: 'none', width: 0, height: 0, filter: '', colorSpace: '', bpc: 0 };
  if (!obj || !obj.__stream) return base;
  const dict = obj.dict;
  const w0 = pdfNum(await doc.resolveKey(dict, 'Width')) || 0;
  const h0 = pdfNum(await doc.resolveKey(dict, 'Height')) || 0;
  if (w0 <= 0 || h0 <= 0) return base;

  let fRaw = null;
  try { fRaw = await doc.resolveKey(dict, 'Filter'); } catch (e) { /* 无滤镜 */ }
  const fList = (Array.isArray(fRaw) ? fRaw : (fRaw == null ? [] : [fRaw]))
    .map(f => pdfName(f) || (typeof f === 'string' ? f : null)).filter(Boolean);
  const last = fList.length ? fList[fList.length - 1] : null;

  let csName = null, csInfo = null;
  try {
    csInfo = await pdfImageColorSpace(doc, dict);
    csName = csInfo ? csInfo.kind : null;
    if (!csName) {
      const csRaw = await doc.resolveKey(dict, 'ColorSpace');
      if (Array.isArray(csRaw) && csRaw.length) csName = pdfName(csRaw[csRaw.length - 1]) || pdfName(csRaw[0]);
      else csName = pdfName(csRaw);
    }
  } catch (e) { /* 忽略 */ }
  let bpc = null;
  try { bpc = pdfNum(await doc.resolveKey(dict, 'BitsPerComponent')); } catch (e) { /* 忽略 */ }

  Object.assign(base, { width: w0, height: h0, filter: last || 'none',
                        colorSpace: csName || '', bpc: bpc || 0 });

  try {
    if (last === 'DCTDecode' || last === 'DCT') {
      // JPEG：只需把 DCTDecode 之前的过滤器解掉，剩下的字节就是标准 JPEG
      let bytes = obj.raw;
      for (let i = 0; i < fList.length - 1; i++) {
        const f = fList[i];
        if (f === 'ASCIIHexDecode' || f === 'AHx') bytes = pdfAsciiHexDecode(bytes);
        else if (f === 'ASCII85Decode' || f === 'A85') bytes = pdfAscii85Decode(bytes);
        else if (f === 'RunLengthDecode' || f === 'RL') bytes = pdfRunLengthDecode(bytes);
        else if (f === 'FlateDecode' || f === 'Fl') bytes = await pdfInflate(bytes);
        else return Object.assign(base, { kind: 'unsupported', note: 'DCTDecode 之前有暂不支持的过滤器 ' + f });
      }
      return Object.assign(base, { kind: 'jpeg', bytes });
    }
    if (!last || last === 'FlateDecode' || last === 'Fl') {
      if (!csInfo) return Object.assign(base, { kind: 'unsupported', note: '色彩空间 ' + (csName || '未知') + ' 暂不支持' });
      if (bpc !== 8) return Object.assign(base, { kind: 'unsupported', note: '位深 ' + bpc + ' 暂不支持' });
      const raw = await doc.streamData(obj);   // 已做 Predictor 还原

      if (csInfo.palette) {
        // 调色板：每像素 1 个索引字节，查表展开成 RGB
        if (raw.length < w0 * h0) return Object.assign(base, { kind: 'unsupported', note: '像素数据不完整' });
        const rgb = pdfExpandIndexed(raw, w0, h0, csInfo);
        const rgba = await pdfApplySMask(doc, dict, rgb, w0, h0);
        return rgba ? Object.assign(base, { kind: 'raw', comps: 4, data: rgba })
                    : Object.assign(base, { kind: 'raw', comps: 3, data: rgb });
      }
      const comps = csInfo.comps;
      if (!comps) return Object.assign(base, { kind: 'unsupported', note: '色彩空间 ' + (csName || '未知') + ' 暂不支持' });
      if (raw.length < w0 * h0 * comps) return Object.assign(base, { kind: 'unsupported', note: '像素数据不完整' });
      if (comps === 3) {
        const rgba = await pdfApplySMask(doc, dict, raw, w0, h0);
        if (rgba) return Object.assign(base, { kind: 'raw', comps: 4, data: rgba });
      }
      return Object.assign(base, { kind: 'raw', comps, data: raw });
    }
    return Object.assign(base, { kind: 'unsupported', note: '滤镜 ' + last + ' 暂不支持（传真类编码如 CCITTFax/JBIG2 需要专门解码器）' });
  } catch (e) {
    return Object.assign(base, { kind: 'unsupported', note: (e && e.message) ? e.message : String(e) });
  }
}

async function pdfImageInfo(doc, entry, index) {
  const base = { index, kind: 'none', width: 0, height: 0, filter: '', colorSpace: '', bpc: 0 };
  let resources = entry.resources;
  try { if (!resources) resources = await doc.resolveKey(entry.dict, 'Resources'); } catch (e) { return base; }
  if (!resources || typeof resources !== 'object' || resources.__stream) return base;
  let xobjects = null;
  try { xobjects = await doc.resolveKey(resources, 'XObject'); } catch (e) { return base; }
  if (!xobjects || typeof xobjects !== 'object' || xobjects.__stream) return base;

  let best = null;
  for (const key of Object.keys(xobjects)) {
    let obj = null;
    try { obj = await doc.resolveRef(xobjects[key]); } catch (e) { continue; }
    if (!obj || !obj.__stream) continue;
    let subtype = null;
    try { subtype = pdfName(await doc.resolveKey(obj.dict, 'Subtype')); } catch (e) { continue; }
    if (subtype !== 'Image') continue;
    const w = pdfNum(await doc.resolveKey(obj.dict, 'Width')) || 0;
    const h = pdfNum(await doc.resolveKey(obj.dict, 'Height')) || 0;
    if (w <= 0 || h <= 0) continue;
    if (!best || w * h > best.w * best.h) best = { obj, w, h };
  }
  if (!best) return base;
  return await pdfDecodeImageObject(doc, best.obj, index);
}

/** 对外：逐页提取图像。返回 { pages:[...], pageCount:n, usable:n, notes:[...] } */
async function pdfExtractImages(arrayBuffer) {
  const doc = new PDF_Document(new Uint8Array(arrayBuffer));
  await doc.load();
  await doc.collectPages();
  const list = doc.pageList || [];
  const pages = [];
  for (let i = 0; i < list.length; i++) pages.push(await pdfImageInfo(doc, list[i], i));
  const usable = pages.filter(p => p.kind === 'jpeg' || p.kind === 'raw').length;
  const notes = [];
  const seen = new Set();
  for (const p of pages) if (p.kind === 'unsupported' && p.note && !seen.has(p.note)) { seen.add(p.note); notes.push(p.note); }
  return { pages, pageCount: pages.length, usable, notes };
}
