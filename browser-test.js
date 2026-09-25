/* browser-test.js 原版兼容版：断言对应 browser-probe.js 原版探针的输出 */
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
if (!chrome) {
  console.log("\n[browser] 没找到 Chrome/Edge —— 跳过浏览器端验证");
  process.exit(0);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace("</body>", '<script src="browser-probe.js"></script>\n</body>');
if (!html.includes("browser-probe.js")) { console.error("注入探针失败"); process.exit(1); }
fs.writeFileSync(path.join(WORK, "app.html"), html);
fs.copyFileSync(path.join(ROOT, "browser-probe.js"), path.join(WORK, "browser-probe.js"));

const logPath = path.join(WORK, "chrome.log");
const fd = fs.openSync(logPath, "w");
const page = "file:///" + path.join(WORK, "app.html").replace(/\\/g, "/");
try {
  cp.spawnSync(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-crash-reporter", "--user-data-dir=" + path.join(WORK, "ud"),
    "--allow-file-access-from-files", "--window-size=1400,900", "--hide-scrollbars",
    "--enable-logging=stderr", "--v=0",
    "--virtual-time-budget=120000", "--screenshot=" + path.join(WORK, "shot.png"), page
  ], { stdio: ["ignore", fd, fd], timeout: 180000 });
} catch (e) { /* 忽略 */ }
fs.closeSync(fd);

const log = fs.readFileSync(logPath, "utf8");
const m = log.match(/PROBEJSON (\{.*\})/);
if (!m) {
  console.log("\n[browser] 页面没有回传 PROBEJSON —— 浏览器端验证未完成");
  console.log(log.split(/\r?\n/).filter(l => /ERROR|CONSOLE|Uncaught/.test(l)).slice(0, 6).map(l => "    " + l).join("\n"));
  process.exit(1);
}
const R = JSON.parse(m[1].replace(/\\"/g, '"'));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n[browser] 无头 Chrome · DPR=" + R.env.dpr + " · 窗口 " + R.env.win + " · 画布 " + R.env.canvasPx);

console.log("\n[A] 翻页路径");
ok("「上一张」按钮后退一张", R.prevWorks === true);
ok("「下一张」按钮前进两张（点击两次）", R.nextWorks1 === true && R.nextWorks2 === true);
ok("turnSheet(1) 前进", R.turnSheet === true);
ok("滚轮向上前进", R.wheelFwd === true);
ok("滚轮向下后退", R.wheelBack === true);

console.log("\n[B] 厚度守恒");
ok("开头：左厚 0 / 右厚满",
  R.thick0.left === 0 && near(R.thick0.right, R.thick0.T, 1e-6),
  `左 ${R.thick0.left} / 右 ${R.thick0.right} / T ${R.thick0.T}`);
ok("结尾：右厚 0 / 左厚满",
  R.thick159.right === 0 && near(R.thick159.left, R.thick159.T, 1e-6),
  `左 ${R.thick159.left} / 右 ${R.thick159.right} / T ${R.thick159.T}`);
ok("左厚 + 右厚 ≡ Tstack（159 张处）", R.conserved === true);

console.log("\n[C] 渲染与章带");
ok("1× 正文有墨迹（文字真实画出）", R.band1 && R.band1.ink > 500, `墨色像素 ${R.band1 && R.band1.ink}`);
ok("1× 正文边缘锐利（maxd ≥ 100）", R.band1 && R.band1.maxd >= 100, `maxd ${R.band1 && R.band1.maxd}`);
ok("章带正解：stackX(章2 页) 反解回第 2 章", R.bandAt && R.bandAt.ok === true,
  `期望 ${R.bandAt && R.bandAt.expected}，得到 ${R.bandAt && R.bandAt.got}`);
ok("点章带跳到那一章", R.jump && R.jump.ok === true,
  `sheet=${R.jump && R.jump.sheet}，期望 ${R.jump && R.jump.want}`);
ok("右书口章带可见（有金色色带像素）",
  (R.bandVisible && R.bandVisible.ink > 0) || (R.bandVisible && R.bandVisible.maxd > 30),
  `ink=${R.bandVisible && R.bandVisible.ink}, maxd=${R.bandVisible && R.bandVisible.maxd}`);
ok("文件选择器已接受 PDF", /\.pdf/.test(R.accept), R.accept);

console.log("\n[D] PDF 渲染接线");
ok("parsePdf 已接 pdfjs 内核", R.wiring && R.wiring.parsePdfPatched === true);
ok("decodePageImage 已补 pdfjs 分支", R.wiring && R.wiring.decodePdfjs === true);
ok("pdfjsRenderPage 可用", R.wiring && R.wiring.pdfjsRenderPage === true);
ok("PDF 端到端：导入成功且走图像页管线",
  R.pdfE2E && R.pdfE2E.source === "probe.pdf" && R.pdfE2E.imgPages === 2,
  JSON.stringify(R.pdfE2E));
ok("PDF 端到端：pdf.js 真实渲染出页面", R.pdfE2E && R.pdfE2E.rendered === true);
ok("放大后按更高分辨率重渲染（不发糊）", R.pdfE2E && R.pdfE2E.hiRes >= 1200,
  R.pdfE2E ? "hiRes=" + R.pdfE2E.hiRes + "px（期望≈1406）" : "无数据");

console.log("\n[E] 主题与 AI 面板");
ok("主题按钮循环切换并回到原版", R.theme && R.theme.cycleOk === true,
  R.theme ? `${R.theme.label0} → ${R.theme.label1} → ${R.theme.backTo}` : "无数据");
ok("AI 面板可展开", R.ai && R.ai.panelShown === true);
ok("AI 本机分析出统计与关键词", R.ai && R.ai.statsReady === true);

console.log("\n[F] 面板显隐 + 缩放");
ok("面板三态循环（侧栏 → 全隐 → 恢复）",
  R.chrome && R.chrome.s1 === 1 && R.chrome.s2 === 2 && R.chrome.restored === true,
  R.chrome ? `s1=${R.chrome.s1} s2=${R.chrome.s2} 恢复=${R.chrome.restored}` : "无数据");
ok("隐藏后悬浮把手出现", R.chrome && R.chrome.chipShown === true);
ok("隐藏侧栏确实收起", R.chrome && R.chrome.sideGone === true);
ok("＋/＋ 两次 → 1.56×，transform 已应用", R.zoom && R.zoom.zAfter === 1.5625 && R.zoom.tfApplied === true,
  R.zoom ? "z=" + R.zoom.zAfter : "无数据");
ok("放大后 backing 同步变大（重绘不模糊）", R.zoom && R.zoom.backingGrew === true);
ok("放大后 HUD 显示", R.zoom && R.zoom.hudShown === true);
ok("放大后 draw 不抛错", R.zoom && R.zoom.drawOk === true);
ok("Ctrl+滚轮继续放大", R.zoom && R.zoom.ctrlWheelZooms === true);
ok("普通滚轮仍翻页", R.zoom && R.zoom.plainWheelTurns === true);
ok("双击恢复 1× 且 HUD 隐藏", R.zoom && R.zoom.reset === true && R.zoom.hudHidden === true);

if (!fail) fs.rmSync(WORK, { recursive: true, force: true });
else console.log("  [browser] 有失败项，现场保留于 _browser/（chrome.log / shot.png）");
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exitCode = fail ? 1 : 0;