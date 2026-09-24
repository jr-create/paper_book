/* 把 pdf.js 重新内联进 index.html 的第一个 <script> 块。
   index.html 是单文件交付物，pdf.js 是它的可读源码 —— 两者必须保持同步，
   否则会出现「改了 pdf.js 但页面行为没变」这种假修复。 */
const fs = require("fs");
const html = fs.readFileSync("index.html", "utf8");
const pdf = fs.readFileSync("pdf.js", "utf8");

const parts = html.split(/(<script>[\s\S]*?<\/script>)/);
let n = 0, done = 0;
const out = parts.map(seg => {
  if (!/^<script>/.test(seg)) return seg;
  n++;
  if (n !== 1) return seg;
  done++;
  return "<script>\n" + pdf + "\n</script>";
}).join("");

if (done !== 1) { console.error("没找到第一个 script 块，未改动"); process.exit(1); }
fs.writeFileSync("index.html", out);
console.log("已内联：pdf.js", pdf.length, "字节 → index.html", html.length, "→", out.length, "字节");
