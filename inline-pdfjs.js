/* 把 Mozilla pdf.js（渲染内核）内嵌进 index.html：
 *   - pdf.min.js   → 紧跟在自有解析器（pdf.js）后面的 <script> 块
 *   - pdf.worker.min.js → <script type="text/plain" id="pdfjs-worker-src">（运行时 Blob-URL 化）
 * index.html 是单文件交付物，这两个压缩文件是它的可读源码 —— 改了它们必须重跑本脚本。
 * 注意：自有解析器块仍是块 1（inline-pdf.js 管它）；本脚本管块 2 和 worker 块。
 */
const fs = require("fs");
const html = fs.readFileSync("index.html", "utf8");
const lib = fs.readFileSync("pdf.min.js", "utf8").trim();
const worker = fs.readFileSync("pdf.worker.min.js", "utf8").trim();

const WORKER_ID = 'id="pdfjs-worker-src"';
const workerBlock = `<script type="text/plain" ${WORKER_ID}>\n${worker}\n</script>`;
const libBlock = "<script>\n" + lib + "\n</script>";

let out = html;
// 1) worker 块：存在就整体替换，不存在就插到第一个 <script> 之前
const wr = new RegExp(`<script type="text/plain" id="pdfjs-worker-src">[\\s\\S]*?</script>`);
if (wr.test(out)) out = out.replace(wr, () => workerBlock);
else {
  const i = out.indexOf("<script>");
  if (i < 0) { console.error("没找到任何 script 块"); process.exit(1); }
  out = out.slice(0, i) + workerBlock + "\n" + out.slice(i);
}
// 2) lib 块：自有解析器块（第一个 <script>）后面插入/替换
const LR = /(<script>\n\/\* Mozilla pdf\.js[\s\S]*?<\/script>\n)/;
if (LR.test(out)) out = out.replace(LR, () => libBlock + "\n");
else {
  const m = out.match(/<script>\n[\s\S]*?<\/script>/);      // 第一个 script 块 = 自有解析器
  if (!m) { console.error("没找到自有解析器块"); process.exit(1); }
  const end = out.indexOf(m[0]) + m[0].length;
  out = out.slice(0, end) + "\n" + libBlock + out.slice(end);
}
if (out === html) { console.error("没有任何改动"); process.exit(1); }
fs.writeFileSync("index.html", out);
console.log("已内联：pdf.min.js", lib.length, "字节 + worker", worker.length, "字节 → index.html", html.length, "→", out.length, "字节");
