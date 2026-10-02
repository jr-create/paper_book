/* ================= Kookit 引擎接入补丁（Koodo Reader 同款解析内核） =================
   原版主程序与既有补丁一字未改。本补丁把可交由引擎的格式全部切到 Kookit 路线：
   · 文字格式 MOBI/AZW3/AZW/FB2/DOCX/MHTML + EPUB/TXT/MD/HTML/HTM/XHTML/XML
     → 引擎渲染器（MobiRender/EpubRender/Fb2Render/DocxRender/HtmlRender/MdRender/TxtRender）
     → chapterDocList → 书口章节（富文本块 or 段落流）；失败回落原版解析
   · TXT 先经 getMetadata 内的 chardet 编码探测（GBK/Big5/UTF-16 等不再乱码）
   · EPUB/MOBI 取引擎元数据（书名/作者）作为书名
   · 漫画 CBZ/CBT/CBR/CB7 → ComicRender（引擎内置 wasm 解包）→ 每页一张图
     → 书口图像页管线；CBZ/CBT 另保留 fflate/js-untar 手工解包作为回落
   · decodePageImage 补 kind:"url" 分支；pdfjs 分支显式透传 */

(function(){
  "use strict";

  /* ------------------------------------------------ Kookit 加载 */
  function getKookit(){
    return (typeof window.Kookit !== "undefined" && window.Kookit && window.Kookit.BookHelper)
      ? window.Kookit : null;
  }

  /* ------------------------------------------------ 公共配置（GeneralRender 基类要求的最小集） */
  function kkConfig(format, extra){
    return Object.assign({
      format: format,
      readerMode: "single",
      isAllowScript: "no",
      isParagraphMode: "no",
      isSpeedReading: "no",
      isReadingRuler: "no",
      isBionic: "no",
      isDarkMode: "no",
      backgroundColor: "",
      animation: "none",
      isMobile: "no",
      fullTranslationMode: "no",
      platform: "web",
      charset: "", parserRegex: "",
      getTarBuffer: null, getZipBuffer: null, getTarEntries: null, getZipEntries: null,
      filePath: "", bookKey: "", getOcrCache: null, saveOcrCache: null
    }, extra || {});
  }

  /* 隐藏挂载点：不进布局树，但 id 必须是 "page-area" ——
     引擎 GeneralRender.getDocument() 硬编码 getElementById("page-area")
     来取 iframe 文档，id 不对则 renderTo 永不 resolve */
  function kkMount(){
    let el = document.getElementById("page-area");
    if(!el){
      el = document.createElement("div");
      el.id = "page-area";
      el.setAttribute("style",
        "position:absolute;left:0;top:0;width:1024px;height:1024px;" +
        "visibility:hidden;overflow:hidden;pointer-events:none;z-index:-1;");
      document.body.appendChild(el);
    }
    return el;
  }

  /* ------------------------------------------------ 工具 */
  function runsText(runs){
    return (runs || []).map(r => r && r.t ? r.t : "").join("");
  }

  function toArrayBuffer(buf){
    if(buf instanceof ArrayBuffer) return buf;
    if(ArrayBuffer.isView(buf)) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return buf;
  }

  async function blobToDataURL(u){
    const b = await (await fetch(u)).blob();
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error("图片读取失败"));
      r.readAsDataURL(b);
    });
  }

  /* 引擎 section 的统一取 HTML：load() 可能返回字符串（FB2/foliate）、
     Promise（makeHtmlBook 系）、或对象带 createDocument() */
  async function docHTML(sec){
    try{
      if(sec && typeof sec === "object"){
        if(typeof sec.load === "function"){
          const u = await sec.load();
          if(typeof u === "string") return await (await fetch(u)).text();
        }
        if(typeof sec.createDocument === "function"){
          const d = sec.createDocument();
          return d.body ? d.body.innerHTML : d.documentElement.innerHTML;
        }
      }
    }catch(_){}
    return String(sec == null ? "" : sec);
  }

  /* section HTML → 书口块（复用原版 htmlToBlocks，含 block5 的 img 块扫描）。
     引擎产出的图片是 blob: URL —— 先统一抓成 data: URL，块扫描才能带出数据 */
  async function blocksFromHTML(raw){
    const dp = new DOMParser().parseFromString(raw, "text/html");
    const els = dp.querySelectorAll("img[src], image[href], image[xlink\\:href]");
    for(const el of els){
      const s = el.getAttribute("src") || el.getAttribute("href") || "";
      if(/^(blob:|zip:)/i.test(s)){
        try{ el.setAttribute("src", await blobToDataURL(s)); }
        catch(_){ el.removeAttribute("src"); }
      }
    }
    return (typeof window.htmlToBlocks === "function") ? window.htmlToBlocks(dp, "") : null;
  }

  function blocksToPara(chapter, paras){
    for(const b of (chapter.blocks || [])){
      if(!b) continue;
      if(b.type === "img"){ continue; }
      if(b.type === "code" && b.lines){
        for(const ln of b.lines){ const s = String(ln).trim(); if(s) paras.push(s); }
        continue;
      }
      const t = runsText(b.runs).replace(/\s+/g, " ").trim();
      if(t) paras.push(t);
    }
  }

  /* ------------------------------------------------ 文字格式：引擎 → 书口章节数据 */
  async function kookitTextParse(buf, format){
    const KK = getKookit();
    if(!KK) throw new Error("Kookit 引擎未加载");
    if(typeof KK.BookHelper.getRendition !== "function") throw new Error("引擎缺 getRendition");

    const arr = toArrayBuffer(buf);
    const rendition = KK.BookHelper.getRendition(arr, kkConfig(format), KK);
    if(!rendition || typeof rendition.renderTo !== "function") throw new Error("引擎未返回渲染器");

    /* TXT：先探测编码（内部 chardet，结果写进 rendition.charset 供 parse 使用） */
    let meta = null;
    try{ meta = (format === "TXT") ? await rendition.getMetadata(arr) : await rendition.getMetadata(); }catch(_){}

    await rendition.renderTo(kkMount());

    const chapterDocs = rendition.chapterDocList || [];
    try{ if(rendition.removeContent) rendition.removeContent(); }catch(_){}
    if(!chapterDocs.length) throw new Error("引擎未解析出章节内容");

    const chaps = [];
    for(const doc of chapterDocs){
      const raw = await docHTML(doc.text);
      let blocks = null;
      try{ blocks = await blocksFromHTML(raw); }catch(_){}
      if(blocks && blocks.length){
        /* 富文本块（含 img 块）直接交给原版 paginate（它原生吃 blocks） */
        const hasContent = blocks.some(b => b && (b.type === "img" ||
          runsText(b.runs).trim() || (b.lines && b.lines.length)));
        if(hasContent){
          chaps.push({ t: String(doc.label || "").slice(0, 40) || "正文", p: "", blocks });
          continue;
        }
      }
      /* 回落：拍平成段落流 */
      const paras = [];
      blocksToPara({ blocks: blocks || [] }, paras);
      if(!paras.length){
        raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
          .split(/(?<=[。！？!?])\s*/).forEach(s => { s = s.trim(); if(s) paras.push(s); });
      }
      if(paras.length) chaps.push({ t: String(doc.label || "").slice(0, 40) || "正文", p: "", paras });
    }
    if(!chaps.length) throw new Error("未提取到可阅读文本");

    const title = meta && (meta.name || meta.title) ? String(meta.name || meta.title).slice(0, 40) : "";
    const note  = (format === "TXT" && meta && meta.charset) ? "编码 " + meta.charset : "";
    return { chapters: chaps, title, note };
  }

  /* ------------------------------------------------ 漫画格式：ComicRender → 图像页 */
  async function kookitComicParse(buf, format){
    const KK = getKookit();
    if(!KK) throw new Error("Kookit 引擎未加载");
    const arr = toArrayBuffer(buf);
    const rendition = KK.BookHelper.getRendition(arr, kkConfig(format), KK);
    if(!rendition || typeof rendition.renderTo !== "function") throw new Error("引擎未返回渲染器");
    await rendition.renderTo(kkMount());
    const docs = rendition.chapterDocList || [];
    try{ if(rendition.removeContent) rendition.removeContent(); }catch(_){}
    if(!docs.length) throw new Error("漫画包未解析出页面");

    /* 每个 section = 一页：load() 给「包着 <img> 的页面 HTML」URL，抽 img src 即图片 URL */
    const pages = [];
    for(const doc of docs){
      let pageURL = "";
      try{ pageURL = await docHTML(doc.text); }catch(_){}
      const html = (typeof pageURL === "string" && /<img/i.test(pageURL))
        ? pageURL : await (await fetch(pageURL)).text();
      const m = html.match(/<img[^>]+src="([^"]+)"/i);
      if(m) pages.push({ kind:"url", url: m[1] });
    }
    if(!pages.length) throw new Error("漫画包中没有可用图片");
    return { imgPages: pages, imgCount: pages.length };
  }

  /* 漫画回落：CBZ/CBT 手工解包（fflate / js-untar，来自内嵌 bundle） */
  const imgType = n => /\.png$/i.test(n) ? "image/png"
    : /\.gif$/i.test(n) ? "image/gif"
    : /\.webp$/i.test(n) ? "image/webp"
    : /\.bmp$/i.test(n) ? "image/bmp" : "image/jpeg";

  async function comicParseFallback(buf, format){
    const ab = toArrayBuffer(buf);
    const entries = new Map();
    if(format === "CBZ"){
      if(!window.KookitZip || !window.KookitZip.unzipSync) throw new Error("zip 解包内核未加载");
      const files = window.KookitZip.unzipSync(new Uint8Array(ab));
      for(const n of Object.keys(files)) entries.set(n, files[n]);
    }else{
      if(typeof window.KookitUntar !== "function") throw new Error("tar 解包内核未加载");
      const files = await window.KookitUntar(ab);
      for(const f of files) if(f && f.name) entries.set(f.name, new Uint8Array(f.buffer));
    }
    if(!entries.size) throw new Error("漫画包为空");
    const names = [...entries.keys()].filter(n => /\.(jpe?g|png|gif|webp|bmp)$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric:true, sensitivity:"base" }));
    if(!names.length) throw new Error("漫画包中没有图片");
    const pages = [];
    for(const n of names)
      pages.push({ kind:"url", url: URL.createObjectURL(new Blob([entries.get(n)], { type: imgType(n) })) });
    return { imgPages: pages, imgCount: names.length };
  }

  /* ------------------------------------------------ PDF：引擎结构 + 书口 pdf.js 渲染
     Koodo 路线：引擎 makePDF（内部走全局 pdfjsLib，即书口内嵌的 Mozilla pdf.js）
     提供 元数据 / 目录(dest→页码) / 扫描件检测；每页渲染沿用书口 decodePageImage
     的 kind:"pdfjs" 分支（pdfjsRenderPage：串行队列 + DPR×zoom 高分辨率重栅格化） */
  async function kookitPdfParse(buf, password){
    const KK = getKookit();
    if(!KK) throw new Error("Kookit 引擎未加载");
    const arr = toArrayBuffer(buf);
    const rendition = KK.BookHelper.getRendition(arr,
      kkConfig("PDF", { password: password || "", isScannedPDF: "no" }), KK);
    if(!rendition || typeof rendition.parse !== "function") throw new Error("引擎未返回 PDF 渲染器");
    await rendition.parse();                    /* 只取 book 结构，无需 renderTo */
    const b = rendition.book;
    if(!b || !Array.isArray(b.sections) || !b.sections.length) throw new Error("PDF 解析失败");

    const meta = b.metadata || {};
    /* 目录（含子级）→ 扁平页码标记（dest JSON → getPageIndex） */
    const flat = [];
    (function walk(items){ for(const it of items || []){ flat.push(it); if(it.subitems && it.subitems.length) walk(it.subitems); } })(b.toc);
    const marks = [];
    for(const it of flat){
      if(!it || !it.href) continue;
      try{
        const r = await b.resolveHrefIndex(it.href);
        const p = (r && typeof r.index === "number") ? r.index : null;
        if(p !== null && p >= 0 && (marks.length === 0 || p > marks[marks.length - 1].p))
          marks.push({ p, t: String(it.label || "").replace(/\s+/g, " ").trim().slice(0, 40) || ("第 " + (marks.length + 1) + " 节") });
      }catch(_){}
    }
    const n = b.sections.length;
    const desc = i => ({ kind:"pdfjs", page:i + 1, width:0, height:0 });
    const chaps = [];
    if(marks.length >= 2){
      for(let i = 0; i < marks.length; i++){
        const from = marks[i].p, to = (i + 1 < marks.length ? marks[i + 1].p : n);
        chaps.push({ t: marks[i].t, p: "", imgPages: Array.from({ length: Math.max(1, to - from) }, (_, k) => desc(from + k)) });
      }
    }else{
      const PER = 20;
      for(let p = 0; p < n; p += PER)
        chaps.push({ t: "第 " + (chaps.length + 1) + " 节", p: "", imgPages: Array.from({ length: Math.min(PER, n - p) }, (_, k) => desc(p + k)) });
    }

    /* 把缓冲交给书口渲染管线（block2 的 PDFJS）：换书必须重建文档 */
    try{
      if(typeof PDFJS === "object" && PDFJS){
        PDFJS.buf = new Uint8Array(arr.slice(0));
        PDFJS.boot = null; PDFJS.doc = null;
        if(typeof pdfjsBoot === "function") pdfjsBoot().catch(function(){});
      }
    }catch(_){}

    const scanned = /scanned/.test(String(meta.description || ""));
    return {
      chapters: chaps,
      title: String(meta.title || "").replace(/\s+/g, " ").trim().slice(0, 40),
      note: "原版页面模式 · 按原始版面渲染" + n + " 页"
        + (marks.length >= 2 ? " · 按目录分 " + marks.length + " 章" : " · 无目录，按每 20 页分节")
        + (scanned ? " · 扫描件" : "")
    };
  }

  /* ------------------------------------------------ 格式分发表（Koodo 路线全量） */
  const KK_TEXT = {
    mobi:"MOBI", azw3:"AZW3", azw:"AZW", prc:"MOBI",
    fb2:"FB2", docx:"DOCX", mhtml:"MHTML", mht:"MHTML",
    epub:"EPUB", txt:"TXT", text:"TXT",
    md:"MD", markdown:"MD",
    html:"HTML", htm:"HTML", xhtml:"XHTML", xml:"XML"
  };
  const KK_COMIC = { cbz:1, cbt:1, cbr:1, cb7:1 };
  /* pdf 保持书口双管线（自研解析 + pdf.js 原版渲染，本就是 Koodo 式思路且更完整） */

  /* ------------------------------------------------ importFile 包装 */
  if(typeof window.importFile === "function" && !window.importFile.__kookitPatched){
    window.importFile = (function(_orig){
      return async function(file){
        if(!file) return _orig(file);
        const name = file.name || "文档";
        const ext = (name.split(".").pop() || "").toLowerCase();
        try{
          if(ext === "pdf" && getKookit()){
            window.__markImport = "called";
            setStatus("正在解析 " + name + "（Kookit 引擎 · PDF）…");
            const r = await kookitPdfParse(await file.arrayBuffer());
            loadBook(r.chapters, { title: r.title || name.replace(/\.[^.]+$/, ""), source: name });
            setStatus("已导入 " + name + "　" + book.chaps.length + " 章 / " + book.pages +
              " 页（" + r.note + "）", "ok");
            return;
          }
          if(KK_TEXT[ext] && getKookit()){
            const fmt = KK_TEXT[ext];
            window.__markImport = "called";
            setStatus("正在解析 " + name + "（Kookit 引擎 · " + fmt + "）…");
            const r = await kookitTextParse(await file.arrayBuffer(), fmt);
            loadBook(r.chapters, {
              title: r.title || name.replace(/\.[^.]+$/, ""), source: name
            });
            const words = r.chapters.reduce((a, c) => a + (c.paras
              ? c.paras.join("").length
              : (c.blocks || []).reduce((x, b) => x + (b && b.runs ? runsText(b.runs).length : 0), 0)), 0);
            setStatus("已导入 " + name + "　" + book.chaps.length + " 章 / " + book.pages +
              " 页 / 约 " + words.toLocaleString() + " 字（" + fmt + " · Kookit 引擎" +
              (r.note ? " · " + r.note : "") + "）", "ok");
            return;
          }
          if(KK_COMIC[ext] && getKookit()){
            window.__markImport = "called";
            setStatus("正在解包 " + name + "（Kookit 引擎 · " + ext.toUpperCase() + "）…");
            const ab = await file.arrayBuffer();
            let r;
            try{ r = await kookitComicParse(ab, ext.toUpperCase()); }
            catch(e){
              if(ext === "cbz" || ext === "cbt") r = await comicParseFallback(ab, ext.toUpperCase());
              else throw e;
            }
            /* 按每 30 页一章分带（书口章带太密会看不清） */
            const chaps = [];
            for(let i = 0; i < r.imgPages.length; i += 30){
              chaps.push({ t: "第 " + (chaps.length + 1) + " 部分", p: "",
                imgPages: r.imgPages.slice(i, i + 30) });
            }
            loadBook(chaps, { title: name.replace(/\.[^.]+$/, ""), source: name });
            setStatus("已导入 " + name + "　" + r.imgCount + " 页漫画 / " + book.pages +
              " 页（" + ext.toUpperCase() + " · Kookit 引擎）", "ok");
            return;
          }
        }catch(err){
          setStatus("Kookit 解析失败，回落原版逻辑…（" + (err && err.message ? err.message : err) + "）");
          // 落到底部原版逻辑
        }
        return _orig(file);
      };
    })(window.importFile);
    window.importFile.__kookitPatched = true;
  }

  /* ------------------------------------------------ loadBook 包装：段落流章节规整
     原版 paginate 认 c.paragraphs（TXT 约定）；blocks 章节原样透传 */
  if(typeof window.loadBook === "function" && !window.loadBook.__kookitPatched){
    window.loadBook = (function(_orig){
      return function(chapters, meta){
        if(Array.isArray(chapters) && chapters.length &&
           chapters.every(c => c && typeof c === "object" && !c.imgPages &&
             Array.isArray(c.paras) && !Array.isArray(c.blocks))){
          return _orig(chapters.map(c => ({
            t: c.t || "正文", p: c.p || "",
            paragraphs: c.paras.map(s => String(s))
          })), meta);
        }
        return _orig(chapters, meta);
      };
    })(window.loadBook);
    window.loadBook.__kookitPatched = true;
  }

  /* ------------------------------------------------ decodePageImage：url 图像页 */
  if(typeof window.decodePageImage === "function" && !window.decodePageImage.__kookitPatched){
    window.decodePageImage = (function(_orig){
      return async function(idx, d){
        /* pdfjs 分支显式透传：内含 pdfjsRenderPage 高分辨率重渲染路径，不受包装影响 */
        if(d && d.kind === "pdfjs") return _orig(idx, d);
        if(d && d.kind === "url" && d.url){
          const src = await loadImageEl(d.url);
          const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
          if(!iw || !ih) throw new Error("图像尺寸无效");
          const s = Math.min(1, IMG_W / Math.max(iw, ih));
          const cw = Math.max(1, Math.round(iw * s)), chh = Math.max(1, Math.round(ih * s));
          const c = document.createElement("canvas"); c.width = cw; c.height = chh;
          const g = c.getContext("2d");
          g.fillStyle = "#ffffff"; g.fillRect(0, 0, cw, chh);
          g.drawImage(src, 0, 0, cw, chh);
          return c;
        }
        return _orig(idx, d);
      };
    })(window.decodePageImage);
    window.decodePageImage.__kookitPatched = true;
  }

  /* ------------------------------------------------ 拖放提示文案 */
  try{
    const dropEl = document.getElementById("drop");
    if(dropEl) dropEl.textContent =
      "松手导入 · TXT / Markdown / HTML / EPUB / PDF / MOBI / AZW3 / AZW / FB2 / DOCX / MHTML / CBZ / CBT / CBR / CB7";
  }catch(_){}

  /* ------------------------------------------------ 调试/测试钩子 */
  window.__kkParse = kookitTextParse;
  window.__kkComic = kookitComicParse;
  window.__kkComicFallback = comicParseFallback;
  window.__kkPdf = kookitPdfParse;
})();
