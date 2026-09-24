/* ============================================================================
 * 浏览器端验证（无头 Chrome）—— 只测「Node 里测不到」的那部分：
 *   1) 面板隐藏是真的 CSS 网格收缩（桩里是模拟的）
 *   2) 放大后正文是真的按目标分辨率重新栅格化（不是位图拉伸）
 *   3) 位图缓存的内存上界、以及我改过的 drawPageAt 分派
 *
 * 运行：node browser-test.js
 * 前提：本机装有 Chrome（或 Edge）。找不到就跳过并返回 0，不阻塞其它测试。
 *
 * 为什么这么写：受限沙箱下 Node 用管道接子进程输出会 EPERM，
 * 所以 chrome 的 stdout/stderr 直接重定向到**文件描述符**（不经过管道）。
 * 页面里的探针把结果打成一行 PROBEJSON，这里再解析回对象。
 * ========================================================================== */
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
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);

let pass = 0, fail = 0, skipped = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name + (extra ? "   " + extra : "")); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "   " + extra : "")); }
}
function skip(name, why) { skipped++; console.log("  SKIP  " + name + "   " + why); }

const chrome = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!chrome) {
  console.log("\n[browser] 没找到 Chrome/Edge —— 跳过浏览器端验证（HTML 逻辑已由 test-logic.js 覆盖）");
  process.exit(0);
}

/* ---- 1. 生成「主程序 + 探针」的临时页面 ---- */
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace("</body>", '<script src="browser-probe.js"></script>\n</body>');
if (!html.includes("browser-probe.js")) { console.error("注入探针失败"); process.exit(1); }
fs.writeFileSync(path.join(WORK, "app.html"), html);
fs.copyFileSync(path.join(ROOT, "browser-probe.js"), path.join(WORK, "browser-probe.js"));

/* ---- 2. 跑 Chrome：输出直接进文件描述符，绕开管道 ---- */
const logPath = path.join(WORK, "chrome.log");
const fd = fs.openSync(logPath, "w");
const page = "file:///" + path.join(WORK, "app.html").replace(/\\/g, "/");
const args = [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-crash-reporter", "--user-data-dir=" + path.join(WORK, "ud"),
  "--enable-logging=stderr", "--v=0",
  "--window-size=1400,900", "--force-device-scale-factor=2", "--hide-scrollbars",
  "--virtual-time-budget=4000", "--screenshot=" + path.join(WORK, "shot.png"), page
];
let runErr = null;
try { cp.spawnSync(chrome, args, { stdio: ["ignore", fd, fd], timeout: 120000 }); }
catch (e) { runErr = e; }
fs.closeSync(fd);

const log = fs.readFileSync(logPath, "utf8");
const m = log.match(/PROBEJSON (\{.*?\})", source:/s) || log.match(/PROBEJSON (\{.*\})/);
if (!m) {
  console.log("\n[browser] 页面没有回传 PROBEJSON —— 浏览器端验证未完成");
  if (runErr) console.log("  启动错误：" + runErr.message);
  console.log("  chrome.log 片段：");
  console.log(log.split(/\r?\n/).filter(l => /ERROR|CONSOLE|Uncaught/.test(l)).slice(0, 6).map(l => "    " + l).join("\n"));
  process.exit(1);
}
const R = JSON.parse(m[1].replace(/\\"/g, '"'));

/* ---- 3. 断言 ---- */
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n[browser] 无头 Chrome · DPR=" + R.env.dpr + " · 窗口 " + R.env.win + " · 画布 " + R.env.canvasPx);

console.log("\n[A] 顶栏 / 侧栏隐藏（真实 CSS 网格，不是桩里模拟的）");
const P = R.panels;
ok("隐藏顶栏：header 真的不占位（display:none 且高度 0）",
  P.noTop.headerDisplay === "none" && P.noTop.headerH === 0,
  `display=${P.noTop.headerDisplay} h=${P.noTop.headerH}`);
ok("隐藏顶栏：画布确实变高", P.noTop.cv.h > P.base.cv.h,
  `${P.base.cv.h} → ${P.noTop.cv.h}px`);
ok("隐藏侧栏：aside 真的不占位（display:none 且宽度 0）",
  P.noSide.asideDisplay === "none" && P.noSide.asideW === 0,
  `display=${P.noSide.asideDisplay} w=${P.noSide.asideW}`);
ok("隐藏侧栏：画布确实变宽", P.noSide.cv.w > P.base.cv.w,
  `${P.base.cv.w} → ${P.noSide.cv.w}px`);
ok("隐藏侧栏后正文排版真的用了新宽度（页变大）", P.noSide.fitPageW > P.base.fitPageW,
  `页宽 ${P.base.fitPageW} → ${P.noSide.fitPageW}px`);
ok("两个都隐藏：画布正好铺满窗口",
  P.none.cv.w === P.none.win.w && P.none.cv.h === P.none.win.h,
  `画布 ${P.none.cv.w}×${P.none.cv.h} / 窗口 ${P.none.win.w}×${P.none.win.h}`);
ok("再点一次完整复原（尺寸与排版都回到原样）",
  P.restored.cv.w === P.base.cv.w && P.restored.cv.h === P.base.cv.h &&
  P.restored.headerH === P.base.header.h && P.restored.asideW === P.base.aside.w &&
  P.restored.fitPageW === P.base.fitPageW,
  `${P.restored.cv.w}×${P.restored.cv.h}，页宽 ${P.restored.fitPageW}`);

console.log("\n[B] 悬浮控件：顶栏可隐藏，所以它必须永远点得到");
ok("悬浮控件在视口内", R.floatbar.inView, `rect=${R.floatbar.rect.w}×${R.floatbar.rect.h}`);
ok("悬浮控件没被书页盖住（elementFromPoint 命中按钮本体）",
  R.floatbar.hitTag === "btnZoomIn", `命中=${R.floatbar.hitTag}`);
ok("点「＋」真的放大，并且读数同步更新",
  R.btnZoom.to > R.btnZoom.from && R.btnZoom.pctText === "125%",
  `${R.btnZoom.from} → ${R.btnZoom.to}，读数 ${R.btnZoom.pctText}`);

console.log("\n[C] 放大后的正文清晰度（同一块正文区域的像素统计）");
const z1 = R.zoom1, z3 = R.zoom3, bl = R.blur3, z5 = R.zoom5;
ok("1× 时整本书放得下，不需要平移", !z1.geo.canPan, `页 ${z1.geo.pageW}×${z1.geo.pageH}px`);
ok("1× 走整页缓存路径", z1.fullHits >= 2 && z1.sliceHits === 0, `full=${z1.fullHits} slice=${z1.sliceHits}`);
ok("3× 时页面大于视口 → 需要平移", z3.geo.canPan && z3.geo.sceneW > 1034, `场景宽 ${z3.geo.sceneW}px`);
ok("3× 自动改走「视口切片」路径（不再缓存整页位图）",
  z3.sliceHits >= 1 && z3.fullHits === 0, `full=${z3.fullHits} slice=${z3.sliceHits}`);
const scale = z3.band.glyphH / z1.band.glyphH;
ok("3× 时字身高度真的约为 3 倍（字确实变大了）",
  scale > 2.6 && scale < 3.4, `字身 ${z1.band.glyphH} → ${z3.band.glyphH} 设备px（${scale.toFixed(2)}×）`);
ok("3× 时边缘对比度不低于 1×（不是糊的）",
  z3.band.maxd >= z1.band.maxd * 0.8, `最大跳变 ${z1.band.maxd} → ${z3.band.maxd} / 255`);
ok("3× 远优于「把低清缩略图放大」的对照（笔画实心度：墨色像素远多于糊图）",
  z3.band.ink > bl.band.ink * 2,
  `对照：maxd=${bl.band.maxd}、墨色像素=${bl.band.ink}（本程序：maxd=${z3.band.maxd}、墨色=${z3.band.ink}）`);

console.log("\n[D] 位图缓存的内存上界");
ok("5× 时整页位图会达到不可接受的体积（所以才必须切片）",
  z5.wholePagePx > 6e6, `单页整页位图 ${(z5.wholePagePx / 1e6).toFixed(1)}M px ≈ ${(z5.wholePagePx * 4 / 1048576).toFixed(0)}MB`);
ok("5× 仍然走切片路径，且缓存像素总量被压在预算内",
  z5.fullHits === 0 && z5.hiPx <= 18e6 * 1.3,
  `缓存 ${(z5.hiPx / 1e6).toFixed(1)}M px ≈ ${(z5.hiPx * 4 / 1048576).toFixed(0)}MB`);
ok("缩回 1× 后画面与像素统计完全复原（缩放幂等）",
  R.back1.zoom === 1 && near(R.back1.pageW, z1.geo.pageW, 1e-6) &&
  R.back1.panX === 0 && R.back1.panY === 0 &&
  R.back1.band.glyphH === z1.band.glyphH && R.back1.band.maxd === z1.band.maxd,
  `字身 ${R.back1.band.glyphH}、maxd ${R.back1.band.maxd}，与 1× 一致`);

console.log("\n[E] 回归：drawPageAt 分派（图像页 + 视口外跳过）");
ok("1× 两页都在视口内 → 图像页各画一次", R.imgAt1x.callsRight === 2, `调用 ${R.imgAt1x.callsRight} 次`);
ok("3× 左页被推出视口 → 只画右页（新加的跳过生效，且对图像页同样成立）",
  R.imgAt3x.callsRight === 1 && R.imgAt3x.leftOnScreen === false,
  `调用 ${R.imgAt3x.callsRight} 次，左页在屏内=${R.imgAt3x.leftOnScreen}`);
ok("文件选择器已接受 PDF（原先漏了 .pdf，只能用拖入）",
  /\.pdf/.test(R.accept), R.accept);

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n===== ${pass} passed, ${fail} failed${skipped ? ", " + skipped + " skipped" : ""} =====`);
process.exitCode = fail ? 1 : 0;