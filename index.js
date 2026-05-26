const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");
const FormData = require("form-data");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

async function getTenantAccessToken() {
  if (!APP_ID || !APP_SECRET) {
    throw new Error("缺少 APP_ID / APP_SECRET 环境变量");
  }

  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: APP_ID,
      app_secret: APP_SECRET,
    }),
  });

  const json = await resp.json();
  if (json.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${json.msg} (${json.code})`);
  }
  return json.tenant_access_token;
}

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
  const richText = replaceVariables(template?.richTextHtml || "", data || {});
  const tableHtml = buildTableHtml(template, rows);
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
      <h1>${title}</h1>
      <section class="rich-text">${richText}</section>
      ${tableHtml}
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

async function uploadToFeishu(pdfBuffer, tenantAccessToken, appToken) {
  const form = new FormData();
  form.append("file_name", `record_${Date.now()}.pdf`);
  form.append("parent_type", "bitable_file");
  form.append("parent_node", appToken);
  form.append("size", String(pdfBuffer.length));
  form.append("file", pdfBuffer, {
    filename: "record.pdf",
    contentType: "application/pdf",
  });

  const resp = await fetch("https://open.feishu.cn/open-apis/drive/v1/medias/upload_all", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const json = await resp.json();
  if (json.code !== 0) {
    throw new Error(`上传失败: ${json.msg || "unknown"} (code=${json.code})`);
  }
  return json.data.file_token;
}

app.post("/render", async (req, res) => {
  try {
    const { data, rows, template, appToken } = req.body || {};
    if (!appToken) return res.status(400).json({ error: "缺少 appToken" });

    const tenantAccessToken = await getTenantAccessToken();
    const pdfBuffer = template
      ? await renderPdfFromTemplate(template, data || {}, rows || [])
      : await renderPdfBuffer(data || {});
    const fileToken = await uploadToFeishu(pdfBuffer, tenantAccessToken, appToken);

    res.json({ fileToken });
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