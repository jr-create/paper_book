/* 重建 index.html 的块结构（可靠识别版）。
   背景：上一版 fix-blocks.js 用 /Mozilla Foundation/ 认 pdfjsLib，而 worker.min.js
   也有同样的 Mozilla 版权头且更大，导致 lib 被误判成 worker、块被重复三份、
   真正的 lib 与主程序被挤出文件。这里改用**互斥**标记：
     worker → 含 WorkerMessageHandler
     parser → 含 "零依赖"（自有解析器头部注释）
     kernel → 含 "Koodo"
     lib    → 从 pdf.min.js 现场生成（文件里已丢失）
   顺序：worker → 解析器 → 内核 → pdfjsLib → [主程序待重建]
   结果先写临时文件，校验通过才落盘。 */
const fs = require("fs");
const html = fs.readFileSync("index.html", "utf8");
const opens = [...html.matchAll(/<script[^>]*>/g)].map(m => m.index);
const closes = [...html.matchAll(/<\/script>/g)].map(m => m.index + "</script>".length);
if (opens.length !== closes.length) { console.error("标签不配对"); process.exit(1); }

function inner(i) {
  const seg = html.slice(opens[i], closes[i]);
  return { seg, body: seg.slice(seg.indexOf(">") + 1, seg.lastIndexOf("</")) };
}
let worker = null, parser = null, kernel = null;
for (let i = 0; i < opens.length; i++) {
  const { seg, body } = inner(i);
  if (body.includes("WorkerMessageHandler")) { if (!worker) worker = seg; continue; }
  if (body.includes("Koodo")) { kernel = seg; continue; }
  if (body.includes("零依赖")) { parser = seg; continue; }
}
// lib 从源文件现场重建
const lib = "<script>\n" + fs.readFileSync("pdf.min.js", "utf8").trim() + "\n</script>";
console.log("识别:", { worker: !!worker, parser: !!parser, kernel: !!kernel });
if (!worker || !parser || !kernel) { console.error("块识别不全，放弃"); process.exit(1); }

const head = html.slice(0, opens[0]);
const tail = html.slice(closes[closes.length - 1]);   // "\n</body>\n</html>\n"
const out = head + worker + "\n" + parser + "\n" + kernel + "\n" + lib + "\n" + tail;

// 落盘前校验
const chk = {
  workerTag: (out.match(/pdfjs-worker-src/g) || []).length,   // 期望：1 标签 + 1 引用 = 2
  hasParser: out.includes("零依赖"),
  hasKernel: out.includes("Koodo"),
  hasLib: out.includes("pdfjsLib") || out.includes("getDocument"),
  opens: (out.match(/<script[^>]*>/g) || []).length,
  closes: (out.match(/<\/script>/g) || []).length,
};
console.log("校验:", chk);
if (chk.opens !== chk.closes || chk.opens !== 4) { console.error("块数不对，放弃"); process.exit(1); }
if (chk.workerTag !== 2) { console.error("worker 引用数异常，放弃"); process.exit(1); }
fs.writeFileSync("index.html", out);
console.log("已重建 index.html:", out.length, "字节（原", html.length, "）");
console.log("块顺序: worker → 解析器 → 内核 → pdfjsLib → [主程序缺失]");