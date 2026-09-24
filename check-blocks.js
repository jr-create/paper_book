/* 严格校验 index.html 四个块的身份（互斥标记、按内容而非顺序）。 */
const fs = require("fs");
const s = fs.readFileSync("index.html", "utf8");
const opens = [...s.matchAll(/<script[^>]*>/g)].map(m => m.index);
const closes = [...s.matchAll(/<\/script>/g)].map(m => m.index + 9);
const lib = fs.readFileSync("pdf.min.js", "utf8").trim();
const workerSrc = fs.readFileSync("pdf.worker.min.js", "utf8").trim();
console.log("块数:", opens.length);
for (let i = 0; i < opens.length; i++) {
  const seg = s.slice(opens[i], closes[i]);
  const body = seg.slice(seg.indexOf(">") + 1, seg.lastIndexOf("</"));
  const tag = seg.slice(0, seg.indexOf(">") + 1);
  // 与源文件逐字节比对
  const isLib = body.trim() === lib;
  const isWorker = body.trim() === workerSrc;
  const kind = isLib ? "pdfjsLib" : isWorker ? "worker(text/plain)"
    : body.includes("Koodo") ? "pdfjs内核"
    : body.includes("零依赖") ? "解析器"
    : "主程序/其它";
  console.log(` 块${i} kind=${kind} len=${body.length} tag=${tag.slice(0, 34)}`);
}
console.log("worker-src 引用数(标签1+内核引用1=2):", (s.match(/pdfjs-worker-src/g) || []).length);
console.log("总大小:", s.length);