/* 把 main-0*.js 合并成主程序块，插到 index.html 的 pdfjsLib 块之后。
   安全约束（上次事故教训）：
     1) 先写临时文件并 node --check 通过；
     2) 用「PDFJS 内核块之后、</body> 之前」的位置定位，不用正则猜内容；
     3) 插入后立刻用 check-blocks.js 的规则复核块数与身份；
     4) 任何一步失败就放弃，绝不写坏交付文件。 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const parts = ["main-01-core.js", "main-02-geom.js", "main-03-text.js", "main-04-pdf.js",
               "main-05-image.js", "main-06-render.js", "main-07-draw.js", "main-08-events.js",
               "main-09-import.js"];
let body = "";
for (const p of parts) {
  const t = fs.readFileSync(path.join(__dirname, p), "utf8");
  body += t.trimEnd() + "\n\n";
}
// 主程序需要的前置：canvas / ctx / DPR（原主程序在文件末尾初始化）
const tail = `
/* --------------------- 画布与启动 --------------------- */
const canvasEl = document.getElementById("cv");
const ctx = canvasEl ? canvasEl.getContext("2d") : null;
const DPR = Math.min(2, window.devicePixelRatio || 1);
GEO.DPR = DPR;
/* 探针/调试兼容别名：W/H 视口 CSS 尺寸，CW/CH 画布设备尺寸 */
Object.defineProperty(globalThis, "W", { get: () => GEO.W, configurable: true });
Object.defineProperty(globalThis, "H", { get: () => GEO.H, configurable: true });
Object.defineProperty(globalThis, "CW", { get: () => canvasEl ? canvasEl.width : 0, configurable: true });
Object.defineProperty(globalThis, "CH", { get: () => canvasEl ? canvasEl.height : 0, configurable: true });
function updateStacks(){ updateHUD(); }

buildDemoBook();
draw(); drawCurve(); updateHUD();
bindEvents();

function loop(){
  // 每帧都重画：翻页动画、悬停、导入后的书口变化都依赖持续渲染
  draw(); updateHUD();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
`;
const block = "<script>\n" + body + tail + "\n</script>";

// 1) 语法检查
const tmp = path.join(__dirname, "_maincheck.js");
fs.writeFileSync(tmp, body + tail, "utf8");
const chk = cp.spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
if (chk.status !== 0) { console.error("语法检查失败:\n" + chk.stderr); process.exit(1); }
console.log("语法检查通过，主程序", (body + tail).length, "字节");

// 2) 定位插入点：先剥离已有的主程序块（幂等），再插到 pdfjsLib 之后
let html = fs.readFileSync("index.html", "utf8");
const workerSrc = fs.readFileSync("pdf.worker.min.js", "utf8").trim();
const lib = fs.readFileSync("pdf.min.js", "utf8").trim();
const stripMain = (src) => {
  const o = [...src.matchAll(/<script[^>]*>/g)].map(m => m.index);
  const c = [...src.matchAll(/<\/script>/g)].map(m => m.index + "</script>".length);
  const keep = [];
  for (let i = 0; i < o.length; i++) {
    const seg = src.slice(o[i], c[i]);
    const b = seg.slice(seg.indexOf(">") + 1, seg.lastIndexOf("</"));
    const isWorker = b.trim() === workerSrc;
    const isLib = b.trim() === lib;
    const isMain = b.includes("function paginate") || b.includes("const canvasEl");
    if (!isMain) keep.push(seg);
  }
  // 去掉主程序块后，用 head + 其余块 + tail 重建
  const headEnd = o[0];
  const tailStart = c[c.length - 1];
  return src.slice(0, headEnd) + keep.join("\n") + src.slice(tailStart);
};
html = stripMain(html);
const opens = [...html.matchAll(/<script[^>]*>/g)].map(m => m.index);
const closes = [...html.matchAll(/<\/script>/g)].map(m => m.index + "</script>".length);
if (opens.length !== 4) { console.error("剥离后应剩 4 块，实际", opens.length); process.exit(1); }
const insertAt = closes[closes.length - 1];          // 最后一块 = pdfjsLib
const out = html.slice(0, insertAt) + "\n" + block + html.slice(insertAt);

// 3) 复核：块数 5，且身份正确
const o2 = [...out.matchAll(/<script[^>]*>/g)].map(m => m.index);
const c2 = [...out.matchAll(/<\/script>/g)].map(m => m.index + "</script>".length);
if (o2.length !== 5 || c2.length !== 5) { console.error("插入后块数不对:", o2.length, c2.length); process.exit(1); }
const kinds = [];
for (let i = 0; i < o2.length; i++) {
  const seg = out.slice(o2[i], c2[i]);
  const b = seg.slice(seg.indexOf(">") + 1, seg.lastIndexOf("</"));
  // 顺序要互斥：主程序里也有 "Koodo" 字样，必须先认主程序
  kinds.push(b.trim() === workerSrc ? "worker" : b.trim() === lib ? "pdfjsLib"
    : b.includes("function paginate") || b.includes("const canvasEl") ? "主程序"
    : b.includes("Koodo") ? "内核" : b.includes("零依赖") ? "解析器" : "??");
}
console.log("插入后块:", kinds.join(" / "));
if (kinds.filter(k => k === "??").length || !kinds.includes("主程序")) { console.error("块身份异常"); process.exit(1); }
fs.writeFileSync("index.html", out);
fs.unlinkSync(tmp);
console.log("已注入主程序块 → index.html", out.length, "字节");
