const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

async function renderPdfBuffer(data) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  const rows = Object.entries(data || {})
    .map(([k, v]) => `<tr><td>${k}</td><td>${String(v ?? "")}</td></tr>`)
    .join("");

  const html = `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        body { font-family: Arial, "Microsoft YaHei", sans-serif; padding: 24px; }
        h2 { margin: 0 0 16px; }
        table { border-collapse: collapse; width: 100%; font-size: 12px; }
        td { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
        td:first-child { width: 35%; background: #f7f7f7; font-weight: 600; }
      </style>
    </head>
    <body>
      <h2>多维表记录导出</h2>
      <table>${rows}</table>
    </body>
  </html>`;

  await page.setContent(html, { waitUntil: "networkidle0" });
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();
  return pdf;
}

function escapeHtml(input = "") {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function replaceVariables(input, data) {
  return String(input || "").replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key) => {
    const fieldName = String(key).trim();
    return escapeHtml((data || {})[fieldName] || "");
  });
}

function renderTextElement(el, data) {
  const html = replaceVariables(el?.text || "", data || {});
  return `<div style="${baseElementStyle(el)}font-size:${el.fontSize || 14}px;font-weight:${el.fontWeight || 400};color:${escapeHtml(
    el.color || "#111"
  )};">${html}</div>`;
}

function renderTableElement(el, data, rows) {
  const columns = Array.isArray(el?.columns) ? el.columns : [];
  if (columns.length === 0) return `<div style="${baseElementStyle(el)}"></div>`;
  const list = Array.isArray(rows) && rows.length > 0 ? rows : [data || {}];
  const thead = columns
    .map(
      (col) =>
        `<th style="border:1px solid #d9d9d9;padding:4px 6px;text-align:left;background:#fafafa;">${escapeHtml(
          col.title || col.fieldName || ""
        )}</th>`
    )
    .join("");
  const tbody = list
    .map((row) => {
      const tds = columns
        .map(
          (col) =>
            `<td style="border:1px solid #d9d9d9;padding:4px 6px;text-align:left;">${escapeHtml(
              row?.[col.fieldName] || ""
            )}</td>`
        )
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<div style="${baseElementStyle(el)}"><div style="font-weight:600;margin-bottom:4px;">${escapeHtml(
    el.tableTitle || "表格"
  )}</div><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

function renderImageElement(el, data) {
  const value = el?.fieldName ? data?.[el.fieldName] || "" : "";
  const src = value || el?.imageUrl || "";
  if (!src) {
    return `<div style="${baseElementStyle(el)}border:1px dashed #bbb;color:#999;display:flex;align-items:center;justify-content:center;">图片</div>`;
  }
  return `<img src="${escapeHtml(src)}" style="${baseElementStyle(el)}object-fit:contain;" />`;
}

function renderQrElement(el, data) {
  const value = el?.fieldName ? data?.[el.fieldName] || "" : "";
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(value)}`;
  return `<img src="${src}" style="${baseElementStyle(el)}object-fit:contain;" />`;
}

function renderBarcodeElement(el, data) {
  const value = el?.fieldName ? data?.[el.fieldName] || "" : "";
  const src = `https://barcode.tec-it.com/barcode.ashx?code=Code128&data=${encodeURIComponent(value)}&translate-esc=true`;
  return `<img src="${src}" style="${baseElementStyle(el)}object-fit:contain;" />`;
}

function renderLineElement(el) {
  const style = el?.lineStyle || "solid";
  const weight = Math.max(1, Number(el?.lineWeight || 1));
  return `<div style="${baseElementStyle(el)}border-top:${weight}px ${style} #333;height:0;"></div>`;
}

function baseElementStyle(el) {
  return `position:absolute;left:${Number(el?.x || 0)}px;top:${Number(el?.y || 0)}px;width:${Number(
    el?.w || 0
  )}px;height:${Number(el?.h || 0)}px;box-sizing:border-box;overflow:hidden;`;
}

function buildTableHtml(template, rows) {
  const columns = Array.isArray(template?.columns) ? template.columns : [];
  if (columns.length === 0) return "";
  const list = Array.isArray(rows) && rows.length > 0 ? rows : [{}];

  const thead = columns
    .map((col) => `<th>${escapeHtml(col.title || col.fieldName || "")}</th>`)
    .join("");

  const body = list
    .map((row) => {
      const tds = columns
        .map((col) => `<td>${escapeHtml(row?.[col.fieldName] || "")}</td>`)
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");

  const pageBreakClass = template?.pageBreakBeforeTable ? " page-break-before" : "";
  return `
    <section class="table-block${pageBreakClass}">
      <h3>${escapeHtml(template?.tableTitle || "明细表")}</h3>
      <table>
        <thead><tr>${thead}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </section>
  `;
}

function buildRenderHtml(template, data, rows) {
  const title = escapeHtml(template?.title || "排版文档");
  const isCanvasMode = Array.isArray(template?.elements);
  const pageWidth = Number(template?.page?.width || 794);
  const pageHeight = Number(template?.page?.height || 1123);

  let bodyContent = "";
  if (isCanvasMode) {
    const elements = [...(template.elements || [])].sort(
      (a, b) => Number(a?.zIndex || 0) - Number(b?.zIndex || 0)
    );
    bodyContent = elements
      .map((el) => {
        if (el.type === "text") return renderTextElement(el, data || {});
        if (el.type === "table") return renderTableElement(el, data || {}, rows || []);
        if (el.type === "image") return renderImageElement(el, data || {});
        if (el.type === "qrcode") return renderQrElement(el, data || {});
        if (el.type === "barcode") return renderBarcodeElement(el, data || {});
        if (el.type === "line") return renderLineElement(el);
        return "";
      })
      .join("");
    bodyContent = `<section class="page-canvas" style="position:relative;width:${pageWidth}px;height:${pageHeight}px;">${bodyContent}</section>`;
  } else {
    const richText = replaceVariables(template?.richTextHtml || "", data || {});
    const tableHtml = buildTableHtml(template, rows);
    bodyContent = `<h1>${title}</h1><section class="rich-text">${richText}</section>${tableHtml}`;
  }

  return `
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        @page { size: A4; margin: 18mm 14mm; }
        body { font-family: Arial, "Microsoft YaHei", sans-serif; font-size: 12px; color: #111; }
        h1 { margin: 0 0 12px; font-size: 20px; }
        h2,h3 { margin: 12px 0 8px; }
        p { margin: 6px 0; line-height: 1.6; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th, td { border: 1px solid #d9d9d9; padding: 6px 8px; text-align: left; vertical-align: top; }
        th { background: #fafafa; font-weight: 600; }
        thead { display: table-header-group; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        .page-break-before { break-before: page; page-break-before: always; }
      </style>
    </head>
    <body>
      ${bodyContent}
    </body>
  </html>`;
}

async function renderPdfFromTemplate(template, data, rows) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    const html = buildRenderHtml(template, data, rows);
    await page.setContent(html, { waitUntil: "networkidle0" });
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}

app.post("/render", async (req, res) => {
  try {
    const { data, rows, template } = req.body || {};
    const pdfBuffer = template
      ? await renderPdfFromTemplate(template, data || {}, rows || [])
      : await renderPdfBuffer(data || {});
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="document.pdf"');
    res.send(pdfBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message || "render failed" });
  }
});

app.post("/preview", async (req, res) => {
  try {
    const { data, rows, template } = req.body || {};
    const html = buildRenderHtml(template || {}, data || {}, rows || []);
    res.json({ html });
  } catch (e) {
    res.status(500).json({ error: e.message || "preview failed" });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(3000, () => {
  console.log("Backend running: http://localhost:3000");
});