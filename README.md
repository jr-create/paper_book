# 书口 · 把「厚度」还给电子书

一款单文件网页阅读器：把电子书渲染成一本可以「摸到厚度」的纸质书。

## 特性

- **书口厚度**：左右纸叠随阅读进度此消彼长，细密纸页线 + 书口弧面，一眼看出读到哪
- **章节分带**：书口侧缘按章分色带并标注章号，点一下跳到那一章
- **多格式导入**：TXT / Markdown / HTML / EPUB / PDF（拖入或选择文件）
- **PDF 原版渲染（Koodo 式）**：页面按原始版面交给内嵌的 Mozilla pdf.js 渲染成位图，
  矢量页放大时按 DPR×zoom 重新栅格化，不发糊；目录分章与页面渲染共用一套书口交互
- **纸感细节**：翻页动画、书脊阴影、页眉页码、深色阅读桌面
- **零依赖单文件**：index.html 即全部，双击即用；pdf.js 内嵌其中

## 使用

直接用浏览器打开 `index.html`，拖入文件即可导入。快捷键：`←`/`→` 翻页，拖动左右书口快翻。

## 测试

```
node test-logic.js    # 逻辑回归（166 项）
node pdf-test.js      # PDF 解析器回归（64 项）
node browser-test.js  # 无头 Chrome 端到端（33 项）
```

## 架构

- `index.html` — 单文件交付物（原版主程序 + 内嵌 pdf.js + PDF 原版渲染补丁）
- `pdf.js` — 自研 PDF 文本/目录解析器（可读源码，经 `inline-pdf.js` 内联进 index.html）
- `pdf.min.js` / `pdf.worker.min.js` — Mozilla pdf.js 3.11.174 渲染内核
- `test-logic.js` / `pdf-test.js` / `browser-test.js` — 三套回归

## 许可

MIT
