const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('report.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer TEXT,
    product TEXT,
    amount REAL,
    created_at TEXT
  );
`);

db.exec('DELETE FROM orders;');

const products = ['Laptop', 'Mouse', 'Keyboard', 'Monitor', 'Desk Chair', 'Headphones'];
const customers = ['Alice Smith', 'Bob Jones', 'Charlie Brown', 'Diana Prince', 'Evan Wright'];

const insert = db.prepare(`
  INSERT INTO orders (customer, product, amount, created_at) 
  VALUES (?, ?, ?, ?)
`);

console.log('Seeding 200 orders...');
for (let i = 0; i < 200; i++) {
  const customer = customers[Math.floor(Math.random() * customers.length)];
  const product = products[Math.floor(Math.random() * products.length)];
  const amount = +(Math.random() * 195 + 5).toFixed(2);
  
  const daysAgo = Math.floor(Math.random() * 30);
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const created_at = date.toISOString().split('T')[0];

  insert.run(customer, product, amount, created_at);
}

const countRes = db.prepare('SELECT COUNT(*) as count FROM orders').get();
console.log(`Seeding complete. Total orders in DB: ${countRes.count}`);