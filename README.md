# 书口 · 把「厚度」还给电子书

一款单文件网页阅读器：把电子书渲染成一本可以「摸到厚度」的纸质书。

## 特性

- **书口厚度**：左右纸叠随阅读进度此消彼长，细密纸页线 + 书口弧面，一眼看出读到哪
- **章节分带**：书口侧缘按章分色带并标注章号，点一下跳到那一章
- **多格式导入**：TXT / Markdown / HTML / HTM / XHTML / XML / EPUB / PDF / MOBI / AZW3 / AZW / FB2 / DOCX / MHTML / CBZ / CBT / CBR / CB7（拖入或选择文件）
- **Kookit 引擎（Koodo Reader 同款内核，全格式统一路线）**：全部 17 种可读格式均经
  内嵌的 kookit 解析引擎（esbuild 自包含打包，无运行时依赖）——文字格式统一转成书口
  章节数据（TXT 自带 chardet 编码探测，EPUB/MOBI/PDF 取引擎元数据作书名，EPUB 插图经
  data URL 进入原版插图管线）；PDF 由引擎 makePDF 解析目录（dest→页码）与扫描件检测、
  页面渲染沿用书口 pdf.js 原版栅格化（DPR×zoom 不发糊）；漫画 CBZ/CBT/CBR/CB7 走
  ComicRender（引擎内置 wasm 解包）逐页出图。原版解析器全部保留为回落备份
- **PDF 原版渲染（Koodo 式）**：页面按原始版面交给内嵌的 Mozilla pdf.js 渲染成位图，
  矢量页放大时按 DPR×zoom 重新栅格化，不发糊；目录分章与页面渲染共用一套书口交互
- **纸感细节**：翻页动画、书脊阴影、页眉页码、深色阅读桌面
- **零依赖单文件**：index.html 即全部，双击即用；pdf.js 与 kookit 引擎均内嵌其中

## 使用

直接用浏览器打开 `index.html`，拖入文件即可导入。快捷键：`←`/`→` 翻页，拖动左右书口快翻。

## 测试

```
node test-logic.js    # 逻辑回归（166 项）
node pdf-test.js      # PDF 解析器回归（64 项）
node browser-test.js  # 无头 Chrome 端到端（33 项）
node kookit-e2e.js    # Kookit 格式端到端（16 项：EPUB/TXT/FB2/DOCX/MOBI/MD/HTML/PDF/CBZ/CBT）
```

> 注：`kookit-e2e.js` 需先 `node inline-kookit.js` 同步内联；`make-samples.js` 的
> GBK TXT 样张需要 iconv-lite（TEMP/kookit-build 内已有，缺失时自动退化为 UTF-8）。

## 架构

- `index.html` — 单文件交付物（原版主程序 + 内嵌 pdf.js + PDF 原版渲染补丁 + 内嵌 kookit 引擎与接入补丁）
- `pdf.js` — 自研 PDF 文本/目录解析器（可读源码，经 `inline-pdf.js` 内联进 index.html）
- `pdf.min.js` / `pdf.worker.min.js` — Mozilla pdf.js 3.11.174 渲染内核
- `kookit.bundle.js` — Koodo Reader 自研 kookit 解析内核（同作者开源库，esbuild 打包为
  自包含 IIFE，含 underscore/rangy/jszip/fflate/js-untar/chardet/mammoth/marked/mhtml2html）
- `kookit-patch.js` — 书口接入补丁：kookit 章节数据 → 段落流，漫画包解包 → 图像页管线
  （可读源码，经 `inline-kookit.js` 内联进 index.html，幂等可重复运行）
- `test-logic.js` / `pdf-test.js` / `browser-test.js` / `kookit-e2e.js` — 四套回归
- `make-samples.js` — Kookit 端到端用的五份最小格式样张生成器（手工构造二进制）

## 许可

MIT
