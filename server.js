const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const REPORTS_DIR = path.resolve(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

const db = new DatabaseSync('report.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer TEXT,
    product TEXT,
    amount REAL,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    path TEXT,
    created_at TEXT
  );
`);

app.get('/health', (req, res) => {
  res.json({ status: "ok" });
});

function getReportData() {
  const totalOrdersRes = db.prepare('SELECT COUNT(*) as count FROM orders').get();
  const totalRevenueRes = db.prepare('SELECT SUM(amount) as total FROM orders').get();
  
  const topProducts = db.prepare(`
    SELECT product, SUM(amount) as revenue 
    FROM orders 
    GROUP BY product 
    ORDER BY revenue DESC 
    LIMIT 5
  `).all();

  const ordersPerDay = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as count, SUM(amount) as revenue
    FROM orders
    WHERE created_at >= DATETIME('now', '-7 days')
    GROUP BY DATE(created_at)
    ORDER BY date DESC
  `).all();

  const allOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();

  return {
    totalOrders: totalOrdersRes.count,
    totalRevenue: totalRevenueRes.total || 0,
    topProducts,
    ordersPerDay,
    allOrders
  };
}

async function generatePdfReport(reportId) {
  const data = getReportData();
  const today = new Date().toISOString().split('T')[0];

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Sales Report - ${today}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
        h1 { color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        .summary-box { display: flex; gap: 20px; margin-bottom: 30px; }
        .card { background: #f8f9fa; padding: 15px; border-radius: 6px; flex: 1; border: 1px solid #dee2e6; }
        .card h3 { margin: 0 0 10px 0; font-size: 14px; color: #6c757d; }
        .card p { margin: 0; font-size: 20px; font-weight: bold; color: #212529; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #dee2e6; font-size: 14px; }
        th { background-color: #f1f3f5; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        thead { display: table-header-group; }
      </style>
    </head>
    <body>
      <h1>Business Sales Report</h1>
      <p>Generated on: ${today}</p>

      <div class="summary-box">
        <div class="card">
          <h3>Total Orders</h3>
          <p>${data.totalOrders}</p>
        </div>
        <div class="card">
          <h3>Total Revenue</h3>
          <p>$${data.totalRevenue.toFixed(2)}</p>
        </div>
      </div>

      <h2>Top 5 Products by Revenue</h2>
      <table>
        <thead>
          <tr><th>Product</th><th>Revenue</th></tr>
        </thead>
        <tbody>
          ${data.topProducts.map(p => `<tr><td>${p.product}</td><td>$${p.revenue.toFixed(2)}</td></tr>`).join('')}
        </tbody>
      </table>

      <h2>All Orders Ledger</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>Customer</th><th>Product</th><th>Amount</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${data.allOrders.map(o => `<tr><td>${o.id}</td><td>${o.customer}</td><td>${o.product}</td><td>$${o.amount.toFixed(2)}</td><td>${o.created_at}</td></tr>`).join('')}
        </tbody>
      </table>
    </body>
    </html>
  `;

  const filePath = path.join(REPORTS_DIR, `${reportId}.pdf`);
  
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html);
    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
    });
    await browser.close();
  } catch (err) {
    console.error("Playwright PDF generation error:", err);
    throw err;
  }

  return filePath;
}

app.post('/reports', async (req, res) => {
  const force = req.body?.force === true;
  const today = new Date().toISOString().split('T')[0];

  if (!force) {
    const existing = db.prepare(`
      SELECT * FROM reports 
      WHERE DATE(created_at) = ? 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(today);

    if (existing) {
      return res.status(200).json({
        id: existing.id,
        file: `/reports/${existing.id}/file`,
        message: "Returned existing report for today (Idempotent)"
      });
    }
  }

  const reportId = 'rep_' + Math.random().toString(36).substring(2, 9);
  
  try {
    const filePath = await generatePdfReport(reportId);
    db.prepare("INSERT INTO reports (id, path, created_at) VALUES (?, ?, DATETIME('now'))")
      .run(reportId, filePath);
    return res.status(201).json({
      id: reportId,
      file: `/reports/${reportId}/file`
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to generate PDF", details: err.message });
  }
});

app.get('/reports/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json({
    id: report.id,
    created_at: report.created_at,
    fileLink: `/reports/${report.id}/file`
  });
});

app.get('/reports/:id/file', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report || !fs.existsSync(report.path)) {
    return res.status(404).json({ error: "File not found on disk" });
  }
  res.sendFile(report.path);
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});