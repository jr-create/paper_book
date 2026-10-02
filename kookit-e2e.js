/* Kookit 集成端到端测试：无头 Chrome 驱动 index.html 的 importFile 全链路。
   运行：node kookit-e2e.js（自动先生成样张）
   注意：会重建 _browser 目录；跑完后再跑 node browser-test.js 不受影响。 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = __dirname;
const WORK = path.join(ROOT, "_browser");
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name + (extra ? "   " + extra : "")); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "   " + extra : "")); }
}

const chrome = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!chrome) { console.log("[e2e] 没找到 Chrome/Edge —— 跳过"); process.exit(0); }

/* 1) 生成样张（make-samples 自建并独占 _browser 目录，必须最先跑） */
cp.spawnSync(process.execPath, [path.join(ROOT, "make-samples.js")], { stdio: "inherit" });

/* 2) 组装测试页（注入到最后一个 </body> —— bundle 内部字符串里也有 </body>） */
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const inject = '<script src="kk-data.js"></script>\n<script src="kk-probe.js"></script>\n</body>';
const lastBody = html.lastIndexOf("</body>");
if (lastBody < 0) { console.error("没找到 </body>"); process.exit(1); }
html = html.slice(0, lastBody) + inject + html.slice(lastBody + "</body>".length);
if (!html.includes("kk-probe.js")) { console.error("注入探针失败"); process.exit(1); }
fs.writeFileSync(path.join(WORK, "app.html"), html);

/* 样张 → base64 数据脚本（file:// 下 fetch 不可靠，直接内嵌字节） */
const b64 = f => fs.readFileSync(path.join(ROOT, "_browser", f)).toString("base64");
const dataJs = "window.__KK_DATA = {\n" +
  ["sample.fb2", "sample.docx", "sample.mobi", "sample.cbz", "sample.cbt", "sample.epub", "sample-gbk.txt", "sample.md", "sample.html", "sample.pdf"]
    .map(f => `  ${JSON.stringify(f)}: ${JSON.stringify(b64(f))}`).join(",\n") + "\n};\n";
fs.writeFileSync(path.join(WORK, "kk-data.js"), dataJs);

/* 3) 页面探针：驱动 importFile → 等状态栏落定 → 回传结果 */
const probe = `
(function(){
  const R = { engine: !!(window.Kookit && window.Kookit.BookHelper && window.Kookit.BookHelper.getRendition), cases: {} };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const bytesOf = b64 => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  async function importAndWait(name){
    const u8 = bytesOf(window.__KK_DATA[name]);
    const file = new File([u8], name);
    let syncErr = "";
    try { window.importFile(file); } catch(e){ syncErr = "SYNC-ERR:" + String(e && e.message || e); }
    console.log("KKPROG call " + name + " syncErr=" + syncErr + " status@0=" + document.getElementById("docStatus").textContent.slice(0, 50));
    /* 终态判定：状态栏出现本文件的「已导入 <name>」且 book.source 已切换，
       或出现明确的失败信息。不能用「任意已导入消息」——上一个文件
       迟到的完成消息会造成快照错位 */
    const esc = name.replace(/[^\w.-]/g, "\\$&");
    const reDone = new RegExp("已导入\\s*" + esc);
    /* 虚拟时钟配平（已验证）：400×100ms = 每例 4 万虚拟 ms */
    for (let i = 0; i < 400; i++){
      await wait(100);
      const st = document.getElementById("docStatus").textContent;
      if (reDone.test(st) && book.source === name){ await wait(300); return st; }
      if (/导入失败|暂不支持|Kookit 解析失败/.test(st)){ await wait(300); return st; }
    }
    /* 宽限终检：真实工作常在最后一轮轮询后才落定 */
    await wait(1500);
    const st2 = document.getElementById("docStatus").textContent;
    if (reDone.test(st2) || book.source === name) return st2;
    return "TIMEOUT: " + st2;
  }
  function snapshot(){
    /* paginate 后章节条目只含 {t,p,start,pages}，正文固化在全局 book.lines；
       fig 行带 fig.src（data: URL），可断言插图管线是否吃到了图片 */
    let firstPara = "", figSrc = "";
    for(const ln of (book.lines || [])){
      if(ln.fig && ln.fig.src && !figSrc){ figSrc = String(ln.fig.src).slice(0, 30); continue; }
      const t = ln.runs && ln.runs[0] && ln.runs[0].t;
      if(t && !ln.blank && !firstPara){ firstPara = String(t).slice(0, 40); }
      if(firstPara && figSrc) break;
    }
    return {
      title: book.title, chaps: book.chaps.length, pages: book.pages,
      imgPages: book.imgPages ? book.imgPages.size : 0,
      figs: (window.__epubFigs ? window.__epubFigs.size : 0),
      figSrc, firstPara
    };
  }
  const tag2 = n => n.split(".")[1];
  (async function(){
    const prog = s => console.log("KKPROG " + s);
    window.addEventListener("unhandledrejection", e => prog("unhandled-rejection: " + String(e.reason && e.reason.message || e.reason).slice(0, 120)));
    window.addEventListener("error", e => prog("window-error: " + String(e.message).slice(0, 120)));
    const body = String(window.importFile);
    prog("start, engine=" + R.engine + ", isWrapper=" + body.includes("_orig(file)") + ", patched=" + (window.importFile && window.importFile.__kookitPatched) + ", bodyHead=" + body.slice(0, 160).replace(/\\n/g, "|"));

    /* 全量导入：样张名 → 结果标签 */
    const CASES = [
      ["sample.epub","epub"],["sample-gbk.txt","txt"],["sample.fb2","fb2"],
      ["sample.docx","docx"],["sample.mobi","mobi"],["sample.md","md"],
      ["sample.html","html"],["sample.pdf","pdf"],["sample.cbz","cbz"],["sample.cbt","cbt"]
    ];
    for (const [name, tag] of CASES){
      prog("import " + name);
      const status = await importAndWait(name);
      R.cases[tag] = Object.assign({ status }, snapshot());
      prog("import " + name + " -> " + status.slice(0, 60));
    }
    console.log("KKTESTJSON " + JSON.stringify(R));
  })();
})();
`;
fs.writeFileSync(path.join(WORK, "kk-probe.js"), probe);

/* 4) 无头 Chrome */
const logPath = path.join(WORK, "chrome.log");
const fd = fs.openSync(logPath, "w");
const page = "file:///" + path.join(WORK, "app.html").replace(/\\/g, "/");
try {
  cp.spawnSync(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-crash-reporter", "--user-data-dir=" + path.join(WORK, "ud"),
    "--allow-file-access-from-files", "--window-size=1400,900", "--hide-scrollbars",
    "--enable-logging=stderr", "--v=0",
    "--virtual-time-budget=600000", "--screenshot=" + path.join(WORK, "kk-shot.png"), page
  ], { stdio: ["ignore", fd, fd], timeout: 360000 });
} catch (e) { /* 忽略 */ }
fs.closeSync(fd);

const log = fs.readFileSync(logPath, "utf8");
const m = log.match(/KKTESTJSON (\{.*\})/);
if (!m) {
  console.log("\n[e2e] 页面没有回传 KKTESTJSON —— 浏览器端验证未完成");
  console.log(log.split(/\r?\n/).filter(l => /KKPROG|ERROR|CONSOLE|Uncaught/.test(l)).slice(0, 12).map(l => "    " + l.replace(/^\[[^\]]+\]\s*/, "")).join("\n"));
  process.exit(1);
}
const R = JSON.parse(m[1].replace(/\\"/g, '"'));

console.log("\n[e2e] Kookit 引擎集成 · 端到端（Koodo 路线全量）");
ok("Kookit 引擎挂载（window.Kookit.BookHelper.getRendition）", R.engine === true);

const C = R.cases || {};
const st = t => (C[t] && C[t].status || "");
ok("EPUB：引擎导入成功（标题取自元数据）", /已导入/.test(st("epub")) && /Kookit EPUB 测试书/.test(C.epub.title || ""),
   `书名「${C.epub && C.epub.title}」 · ${(st("epub")||"").slice(0, 46)}`);
ok("EPUB：2 章 / 正文真实进入分页", C.epub && C.epub.chaps >= 2 && C.epub.pages > 0 && C.epub.firstPara,
   `章 ${C.epub && C.epub.chaps} · 页 ${C.epub && C.epub.pages} · 「${C.epub && C.epub.firstPara}」`);
ok("EPUB：插图进入 fig 管线（data URL）", C.epub && C.epub.figs >= 1 && /data:image/.test(C.epub.figSrc || ""),
   `fig ${C.epub && C.epub.figs} · ${C.epub && C.epub.figSrc}`);
ok("TXT：引擎导入成功", /已导入/.test(st("txt")), (st("txt")||"").slice(0, 60));
ok("TXT：章节切分 + 正文（chardet 路径不乱码）", C.txt && C.txt.pages > 0 && /第一章|云起|测试/.test(C.txt.firstPara || ""),
   `页 ${C.txt && C.txt.pages} · 「${C.txt && C.txt.firstPara}」`);
ok("FB2：导入成功", /已导入/.test(st("fb2")), (st("fb2")||"").slice(0, 46));
ok("FB2：识别出 2 章 / 有正文", C.fb2 && C.fb2.chaps >= 2 && C.fb2.pages > 0,
   `章 ${C.fb2 && C.fb2.chaps} · 页 ${C.fb2 && C.fb2.pages} · 「${C.fb2 && C.fb2.firstPara}」`);
ok("DOCX：mammoth 转换出正文", /已导入/.test(st("docx")) && C.docx.pages > 0 && /测试/.test(C.docx.firstPara || ""),
   `页 ${C.docx && C.docx.pages} · 「${C.docx && C.docx.firstPara}」`);
ok("MOBI：无 DRM PalmDOC 解析", /已导入/.test(st("mobi")) && C.mobi.pages > 0,
   `页 ${C.mobi && C.mobi.pages} · 「${C.mobi && C.mobi.firstPara}」`);
ok("MD：marked 渲染 + 章节切分", /已导入/.test(st("md")) && C.md.chaps >= 1 && C.md.pages > 0 && C.md.firstPara,
   `章 ${C.md && C.md.chaps} · 页 ${C.md && C.md.pages} · 「${C.md && C.md.firstPara}」`);
ok("HTML：引擎导入 + 正文", /已导入/.test(st("html")) && C.html.pages > 0 && C.html.firstPara,
   `页 ${C.html && C.html.pages} · 「${C.html && C.html.firstPara}」`);
ok("PDF：引擎导入（元数据书名 + 目录分章）", /已导入/.test(st("pdf")) && /Kookit PDF 测试书/.test(C.pdf.title || "") && /目录分 2 章/.test(st("pdf")),
   `书名「${C.pdf && C.pdf.title}」 · ${(st("pdf")||"").slice(0, 56)}`);
ok("PDF：图像页就绪（pdf.js 渲染管线）", C.pdf && C.pdf.imgPages >= 4,
   `图像页 ${C.pdf && C.pdf.imgPages}`);
ok("CBZ：解包 3 页图像", /已导入/.test(st("cbz")) && C.cbz.imgPages >= 3,
   `图像页 ${C.cbz && C.cbz.imgPages}`);
ok("CBT：tar 解包 2 页图像", /已导入/.test(st("cbt")) && C.cbt.imgPages >= 2,
   `图像页 ${C.cbt && C.cbt.imgPages}`);

console.log(`\n[e2e] 结果：${pass} 通过 / ${fail} 失败`);
try{ fs.copyFileSync(path.join(WORK, "kk-shot.png"), path.join(ROOT, "kk-shot.png")); }catch(_){}
process.exit(fail ? 1 : 0);
