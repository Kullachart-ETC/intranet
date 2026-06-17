const express = require('express');
const Database = require('better-sqlite3');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const db = new Database('intranet.db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'intranet-secret-key-2568',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 ชั่วโมง
}));

// สร้างตาราง
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    name TEXT,
    dept TEXT,
    role TEXT DEFAULT 'user'
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, type TEXT, body TEXT,
    author TEXT, date TEXT, pinned INTEGER DEFAULT 0,
    user_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emp_idx INTEGER, date TEXT, type TEXT, note TEXT,
    user_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, dept TEXT, color TEXT
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_idx INTEGER, date TEXT,
    slot TEXT, name TEXT, purpose TEXT,
    user_id INTEGER
  );
`);

// สร้าง Admin เริ่มต้น (ถ้ายังไม่มี)
const adminExists = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin1234', 10);
  db.prepare('INSERT INTO users (username,password,name,dept,role) VALUES (?,?,?,?,?)')
    .run('admin', hash, 'ผู้ดูแลระบบ', 'IT', 'admin');
}

// Seed พนักงานเริ่มต้น
const empCount = db.prepare('SELECT COUNT(*) as c FROM employees').get();
if (empCount.c === 0) {
  const ins = db.prepare('INSERT INTO employees (name,dept,color) VALUES (?,?,?)');
  ins.run('สมชาย ใจดี','IT','#1D9E75');
  ins.run('สมหญิง รักงาน','HR','#185FA5');
  ins.run('วิชัย เก่งมาก','Finance','#993C1D');
  ins.run('นิดา สวยงาม','Marketing','#993556');
  ins.run('ประยุทธ์ ตั้งใจ','Sales','#534AB7');
}

// Seed โพสต์เริ่มต้น
const postCount = db.prepare('SELECT COUNT(*) as c FROM posts').get();
if (postCount.c === 0) {
  db.prepare('INSERT INTO posts (title,type,body,author,date,pinned,user_id) VALUES (?,?,?,?,?,?,?)')
    .run('ยินดีต้อนรับสู่ระบบ Intranet','announce','ระบบ Intranet พร้อมใช้งานแล้วครับ','ผู้ดูแลระบบ',new Date().toLocaleDateString('th-TH'),1,1);
}

// ======== Middleware ========
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'เฉพาะ Admin เท่านั้น' });
}

// ======== หน้า Login ========
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  req.session.user = { id: user.id, username: user.username, name: user.name, dept: user.dept, role: user.role };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
});

// ======== Static (ต้อง login) ========
app.use((req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/api/')) return next();
  if (!req.session.user) return res.redirect('/login');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ======== API Users (Admin) ========
app.get('/api/users', requireLogin, requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,username,name,dept,role FROM users').all());
});
app.post('/api/users', requireLogin, requireAdmin, (req, res) => {
  const { username, password, name, dept, role } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'กรอกข้อมูลให้ครบ' });
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(409).json({ error: 'ชื่อผู้ใช้นี้มีแล้ว' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username,password,name,dept,role) VALUES (?,?,?,?,?)')
    .run(username, hash, name, dept, role || 'user');
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireLogin, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) return res.status(400).json({ error: 'ไม่สามารถลบตัวเองได้' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.put('/api/users/:id/password', requireLogin, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'กรอกรหัสผ่านใหม่' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, req.params.id);
  res.json({ ok: true });
});

// ======== API Posts ========
app.get('/api/posts', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM posts ORDER BY pinned DESC, id DESC').all());
});
app.post('/api/posts', requireLogin, (req, res) => {
  const { title, type, body, pinned } = req.body;
  const u = req.session.user;
  db.prepare('INSERT INTO posts (title,type,body,author,date,pinned,user_id) VALUES (?,?,?,?,?,?,?)')
    .run(title, type, body, `${u.name} (${u.dept})`, new Date().toLocaleDateString('th-TH'), pinned?1:0, u.id);
  res.json({ ok: true });
});
app.delete('/api/posts/:id', requireLogin, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'ไม่พบ' });
  if (post.user_id !== req.session.user.id && req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบ' });
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ======== API Employees ========
app.get('/api/employees', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM employees').all());
});

// ======== API Events ========
app.get('/api/events', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM events').all());
});
app.post('/api/events', requireLogin, (req, res) => {
  const { emp_idx, date, type, note } = req.body;
  db.prepare('INSERT INTO events (emp_idx,date,type,note,user_id) VALUES (?,?,?,?,?)')
    .run(emp_idx, date, type, note, req.session.user.id);
  res.json({ ok: true });
});
app.delete('/api/events/:id', requireLogin, (req, res) => {
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ======== API Bookings ========
app.get('/api/bookings', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM bookings').all());
});
app.post('/api/bookings', requireLogin, (req, res) => {
  const { room_idx, date, slot, name, purpose } = req.body;
  const existing = db.prepare('SELECT id FROM bookings WHERE room_idx=? AND date=? AND slot=?').get(room_idx, date, slot);
  if (existing) return res.status(409).json({ error: 'ช่วงเวลานี้ถูกจองแล้ว' });
  db.prepare('INSERT INTO bookings (room_idx,date,slot,name,purpose,user_id) VALUES (?,?,?,?,?,?)')
    .run(room_idx, date, slot, name, purpose, req.session.user.id);
  res.json({ ok: true });
});
app.delete('/api/bookings/:id', requireLogin, (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Intranet running on port', PORT));
