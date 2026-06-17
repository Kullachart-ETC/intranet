const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('intranet.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// สร้างตาราง Database
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, type TEXT, body TEXT,
    author TEXT, date TEXT, pinned INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_idx INTEGER, date TEXT, type TEXT, note TEXT
  );
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, dept TEXT, color TEXT
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_idx INTEGER, date TEXT,
    slot TEXT, name TEXT, purpose TEXT
  );
`);

// Seed ข้อมูลพนักงานเริ่มต้น (ถ้ายังไม่มี)
const empCount = db.prepare('SELECT COUNT(*) as c FROM employees').get();
if (empCount.c === 0) {
  const insertEmp = db.prepare('INSERT INTO employees (name,dept,color) VALUES (?,?,?)');
  insertEmp.run('สมชาย ใจดี', 'IT', '#1D9E75');
  insertEmp.run('สมหญิง รักงาน', 'HR', '#185FA5');
  insertEmp.run('วิชัย เก่งมาก', 'Finance', '#993C1D');
  insertEmp.run('นิดา สวยงาม', 'Marketing', '#993556');
  insertEmp.run('ประยุทธ์ ตั้งใจ', 'Sales', '#534AB7');
}

// Seed โพสต์ตัวอย่าง (ถ้ายังไม่มี)
const postCount = db.prepare('SELECT COUNT(*) as c FROM posts').get();
if (postCount.c === 0) {
  const insertPost = db.prepare('INSERT INTO posts (title,type,body,author,date,pinned) VALUES (?,?,?,?,?,?)');
  insertPost.run('ยินดีต้อนรับสู่ระบบ Intranet บริษัท', 'announce', 'ระบบ Intranet ของบริษัทพร้อมใช้งานแล้ว สามารถใช้งานได้ทั้ง Board ประชาสัมพันธ์ ปฏิทินงาน และจองห้องประชุมได้เลยครับ', 'ฝ่าย IT', new Date().toLocaleDateString('th-TH'), 1);
}

// ====== API Posts ======
app.get('/api/posts', (req, res) => {
  res.json(db.prepare('SELECT * FROM posts ORDER BY pinned DESC, id DESC').all());
});
app.post('/api/posts', (req, res) => {
  const { title, type, body, author, date, pinned } = req.body;
  db.prepare('INSERT INTO posts (title,type,body,author,date,pinned) VALUES (?,?,?,?,?,?)')
    .run(title, type, body, author, date, pinned ? 1 : 0);
  res.json({ ok: true });
});
app.delete('/api/posts/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ====== API Employees ======
app.get('/api/employees', (req, res) => {
  res.json(db.prepare('SELECT * FROM employees').all());
});
app.post('/api/employees', (req, res) => {
  const { name, dept, color } = req.body;
  db.prepare('INSERT INTO employees (name,dept,color) VALUES (?,?,?)').run(name, dept, color);
  res.json({ ok: true });
});

// ====== API Events ======
app.get('/api/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events').all());
});
app.post('/api/events', (req, res) => {
  const { emp_idx, date, type, note } = req.body;
  db.prepare('INSERT INTO events (emp_idx,date,type,note) VALUES (?,?,?,?)')
    .run(emp_idx, date, type, note);
  res.json({ ok: true });
});
app.delete('/api/events/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ====== API Bookings ======
app.get('/api/bookings', (req, res) => {
  res.json(db.prepare('SELECT * FROM bookings').all());
});
app.post('/api/bookings', (req, res) => {
  const { room_idx, date, slot, name, purpose } = req.body;
  // ตรวจสอบว่าซ้ำไหม
  const existing = db.prepare('SELECT id FROM bookings WHERE room_idx=? AND date=? AND slot=?')
    .get(room_idx, date, slot);
  if (existing) return res.status(409).json({ error: 'ช่วงเวลานี้ถูกจองแล้ว' });
  db.prepare('INSERT INTO bookings (room_idx,date,slot,name,purpose) VALUES (?,?,?,?,?)')
    .run(room_idx, date, slot, name, purpose);
  res.json({ ok: true });
});
app.delete('/api/bookings/:id', (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Intranet running on port', PORT));
