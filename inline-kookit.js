/* 把 Kookit 引擎 bundle 与接入补丁内联进 index.html（幂等，可重复运行）。
   index.html 是单文件交付物 —— kookit.bundle.js / kookit-patch.js 是可读源码，
   两者必须保持同步。引擎来源：Koodo Reader 自研 kookit 内核（同作者开源库），
   经 esbuild 打包为自包含 IIFE（underscore/rangy/jszip/fflate/js-untar/
   chardet/mammoth/marked/mhtml2html 全部内联，无运行时外部依赖）。 */
const fs = require("fs");

const html = fs.readFileSync("index.html", "utf8");
const bundle = fs.readFileSync("kookit.bundle.js", "utf8");
const patch = fs.readFileSync("kookit-patch.js", "utf8");

/* 防 </script> 提前闭合（仅出现在字符串/正则字面量中，\/ 与 / 等价）；
   防 <!-- 序列：脚本内容若出现 <!--（压缩包里 parse5/marked 等的字符串字面量），
   HTML 解析器会进入 script-data-escaped 状态，吞掉该行其余内容。
   在字面量里转义为 <\!--（JS 中 \! 与 ! 等价），对程序语义零影响。 */
const safe = s => s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

const MARK_A = "<!-- kookit-inline:start -->";
const MARK_B = "<!-- kookit-inline:end -->";

/* 幂等：先移除旧的内联段 */
const re = new RegExp(MARK_A + "[\\s\\S]*?" + MARK_B + "\\s*", "g");
let out = html.replace(re, "");

/* 文件选择器接受新格式（幂等） */
out = out.replace(
  /(<input type="file" id="file" accept=")[^"]*(")/,
  '$1.txt,.md,.markdown,.text,.html,.htm,.xhtml,.xml,.epub,.pdf,.mobi,.azw3,.azw,.prc,.fb2,.docx,.mhtml,.mht,.cbz,.cbt,.cbr,.cb7$2'
);

if (out.indexOf("</body>") < 0) { console.error("没找到 </body>，未改动"); process.exit(1); }

const block = MARK_A + "\n<script>\n" + safe(bundle) + "\n</script>\n"
  + "<script>\n" + safe(patch) + "\n</script>\n" + MARK_B + "\n";
/* 必须用函数式替换：bundle 是压缩代码，含大量 $ 序列，
   字符串替换会触发 $&/$' 等替换模式，污染内联内容 */
out = out.replace("</body>", () => block + "</body>");

fs.writeFileSync("index.html", out);
console.log("已内联：kookit bundle", bundle.length, "字节 + patch", patch.length,
  "字节 → index.html", html.length, "→", out.length, "字节");
