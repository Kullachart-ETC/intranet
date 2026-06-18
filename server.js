const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'intranet-secret-key-2568',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// Email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// สร้างตาราง
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      name TEXT,
      dept TEXT,
      role TEXT DEFAULT 'user',
      email TEXT,
      manager_id INTEGER,
      start_date DATE,
      annual_leave_quota INTEGER DEFAULT 6
    );
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT, type TEXT, body TEXT,
      author TEXT, date TEXT, pinned INTEGER DEFAULT 0,
      user_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      emp_idx INTEGER, date TEXT, type TEXT, note TEXT,
      title TEXT, time_start TEXT, time_end TEXT,
      user_id INTEGER
    );
    -- เพิ่ม column ถ้ายังไม่มี (กรณี table มีอยู่แล้ว)
    ALTER TABLE events ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS time_start TEXT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS time_end TEXT;
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT, dept TEXT, color TEXT
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      room_idx INTEGER, date TEXT,
      slot TEXT, name TEXT, purpose TEXT,
      user_id INTEGER
    );
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS time_start TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS time_end TEXT;
    CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      leave_no TEXT UNIQUE,
      user_id INTEGER,
      leave_type TEXT,
      start_date TIMESTAMP,
      end_date TIMESTAMP,
      days NUMERIC,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      approver_id INTEGER,
      approved_at TIMESTAMP,
      reject_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS leave_quotas (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      year INTEGER,
      leave_type TEXT,
      quota NUMERIC DEFAULT 0,
      used NUMERIC DEFAULT 0,
      carried_over NUMERIC DEFAULT 0,
      UNIQUE(user_id, year, leave_type)
    );
  `);

  // Seed Admin
  const admin = await pool.query('SELECT id FROM users WHERE username=$1', ['admin']);
  if (admin.rows.length === 0) {
    const hash = bcrypt.hashSync('admin1234', 10);
    await pool.query(
      'INSERT INTO users (username,password,name,dept,role,email,start_date) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      ['admin', hash, 'ผู้ดูแลระบบ', 'IT', 'admin', 'admin@earth-th.com', '2020-01-01']
    );
  }

  // Seed employees
  const emp = await pool.query('SELECT COUNT(*) FROM employees');
  if (parseInt(emp.rows[0].count) === 0) {
    await pool.query(`INSERT INTO employees (name,dept,color) VALUES
      ('สมชาย ใจดี','IT','#1D9E75'),
      ('สมหญิง รักงาน','HR','#185FA5'),
      ('วิชัย เก่งมาก','Finance','#993C1D'),
      ('นิดา สวยงาม','Marketing','#993556'),
      ('ประยุทธ์ ตั้งใจ','Sales','#534AB7')`);
  }

  // Seed โพสต์
  const post = await pool.query('SELECT COUNT(*) FROM posts');
  if (parseInt(post.rows[0].count) === 0) {
    await pool.query(
      'INSERT INTO posts (title,type,body,author,date,pinned,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      ['ยินดีต้อนรับสู่ระบบ Intranet EARTH (THAILAND)','announce','ระบบ Intranet พร้อมใช้งานแล้วครับ','ผู้ดูแลระบบ',new Date().toLocaleDateString('th-TH'),1,1]
    );
  }
  console.log('Database initialized');
}

initDB().catch(console.error);

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

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  req.session.user = { id: user.id, username: user.username, name: user.name, dept: user.dept, role: user.role, email: user.email };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
});

// Static — เช็ค session ก่อนส่งไฟล์ทุกไฟล์ยกเว้น login
app.use((req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/api/')) return next();
  if (!req.session.user) return res.redirect('/login');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Route หน้าหลัก — ส่ง index.html เฉพาะ login แล้วเท่านั้น
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ======== API Users ========
app.get('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT id,username,name,dept,role,email,manager_id,start_date,annual_leave_quota FROM users ORDER BY id');
  res.json(r.rows);
});
app.post('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const { username, password, name, dept, role, email, manager_id, start_date, annual_leave_quota } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'กรอกข้อมูลให้ครบ' });
  const exists = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  if (exists.rows.length > 0) return res.status(409).json({ error: 'ชื่อผู้ใช้นี้มีแล้ว' });
  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    'INSERT INTO users (username,password,name,dept,role,email,manager_id,start_date,annual_leave_quota) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [username, hash, name, dept, role||'user', email, manager_id||null, start_date||null, annual_leave_quota||6]
  );
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) return res.status(400).json({ error: 'ไม่สามารถลบตัวเองได้' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
app.put('/api/users/:id/password', requireLogin, requireAdmin, async (req, res) => {
  const hash = bcrypt.hashSync(req.body.password, 10);
  await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, req.params.id]);
  res.json({ ok: true });
});
app.put('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  const { name, dept, role, email, manager_id, start_date, annual_leave_quota } = req.body;
  await pool.query(
    'UPDATE users SET name=$1,dept=$2,role=$3,email=$4,manager_id=$5,start_date=$6,annual_leave_quota=$7 WHERE id=$8',
    [name, dept, role, email, manager_id||null, start_date||null, annual_leave_quota||6, req.params.id]
  );
  res.json({ ok: true });
});

// ======== API Posts ========
app.get('/api/posts', requireLogin, async (req, res) => {
  const r = await pool.query('SELECT * FROM posts ORDER BY pinned DESC, id DESC');
  res.json(r.rows);
});
app.post('/api/posts', requireLogin, async (req, res) => {
  const { title, type, body, pinned } = req.body;
  const u = req.session.user;
  await pool.query(
    'INSERT INTO posts (title,type,body,author,date,pinned,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [title, type, body, `${u.name} (${u.dept})`, new Date().toLocaleDateString('th-TH'), pinned?1:0, u.id]
  );
  res.json({ ok: true });
});
app.delete('/api/posts/:id', requireLogin, async (req, res) => {
  const r = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
  const post = r.rows[0];
  if (!post) return res.status(404).json({ error: 'ไม่พบ' });
  if (post.user_id !== req.session.user.id && req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'ไม่มีสิทธิ์ลบ' });
  await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ======== API Employees ========
app.get('/api/employees', requireLogin, async (req, res) => {
  const r = await pool.query(`
    SELECT id, name, dept,
      CASE dept
        WHEN 'IT' THEN '#1D9E75'
        WHEN 'HR' THEN '#185FA5'
        WHEN 'Finance' THEN '#993C1D'
        WHEN 'Marketing' THEN '#993556'
        WHEN 'Sales' THEN '#534AB7'
        ELSE '#888888'
      END as color
    FROM users WHERE role != 'admin' ORDER BY name
  `);
  res.json(r.rows);
});

// ======== API Events ========
app.get('/api/events', requireLogin, async (req, res) => {
  const r = await pool.query('SELECT * FROM events');
  res.json(r.rows);
});
app.post('/api/events', requireLogin, async (req, res) => {
  const { emp_idx, date, type, note, title, time_start, time_end } = req.body;
  await pool.query(
    'INSERT INTO events (emp_idx,date,type,note,title,time_start,time_end,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [emp_idx, date, type, note||'', title||'', time_start||'', time_end||'', req.session.user.id]
  );
  res.json({ ok: true });
});
app.delete('/api/events/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM events WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ======== API Bookings ========
app.get('/api/bookings', requireLogin, async (req, res) => {
  const r = await pool.query('SELECT * FROM bookings');
  res.json(r.rows);
});
app.post('/api/bookings', requireLogin, async (req, res) => {
  const { room_idx, date, slot, name, purpose } = req.body;
  const existing = await pool.query('SELECT id FROM bookings WHERE room_idx=$1 AND date=$2 AND slot=$3', [room_idx, date, slot]);
  if (existing.rows.length > 0) return res.status(409).json({ error: 'ช่วงเวลานี้ถูกจองแล้ว' });
  const { time_start, time_end } = req.body;
  await pool.query('INSERT INTO bookings (room_idx,date,slot,name,purpose,user_id,time_start,time_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [room_idx, date, slot, name, purpose, req.session.user.id, time_start||'', time_end||'']);
  res.json({ ok: true });
});
app.delete('/api/bookings/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM bookings WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ======== API Leave ========
const LEAVE_TYPES = {
  sick: { name: 'ลาป่วย', quota: 30, paid: true },
  annual: { name: 'ลาพักร้อน', quota: 0, paid: true },
  personal: { name: 'ลากิจจำเป็น', quota: 5, paid: true },
  personal_special: { name: 'ลากิจพิเศษ', quota: 7, paid: false },
  maternity: { name: 'ลาคลอด', quota: 60, paid: true },
  ordain: { name: 'ลาบวช', quota: 15, paid: true },
  military: { name: 'ลาราชการทหาร', quota: 60, paid: true },
  marriage: { name: 'ลาสมรส', quota: 7, paid: true },
  work_injury: { name: 'ลาป่วยเนื่องจากงาน', quota: 30, paid: true },
  unpaid: { name: 'ลาตัดเงิน', quota: 30, paid: false }
};

// สร้างเลขที่ใบลา
async function generateLeaveNo() {
  const now = new Date();
  const year = now.getFullYear();
  const r = await pool.query('SELECT COUNT(*) FROM leave_requests WHERE EXTRACT(YEAR FROM created_at)=$1', [year]);
  const count = parseInt(r.rows[0].count) + 1;
  return `LV${year}${String(count).padStart(4,'0')}`;
}

// ดึง quota การลา
app.get('/api/leave/quota/:userId', requireLogin, async (req, res) => {
  const userId = req.params.userId;
  const year = new Date().getFullYear();
  const user = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  if (!user.rows[0]) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

  const result = {};
  for (const [type, info] of Object.entries(LEAVE_TYPES)) {
    const q = await pool.query(
      'SELECT * FROM leave_quotas WHERE user_id=$1 AND year=$2 AND leave_type=$3',
      [userId, year, type]
    );
    let quota = info.quota;
    if (type === 'annual') quota = user.rows[0].annual_leave_quota || 6;
    let row = q.rows[0];
    if (!row) {
      await pool.query(
        'INSERT INTO leave_quotas (user_id,year,leave_type,quota,used,carried_over) VALUES ($1,$2,$3,$4,0,0) ON CONFLICT DO NOTHING',
        [userId, year, type, quota]
      );
      row = { quota, used: 0, carried_over: 0 };
    }
    result[type] = {
      name: info.name,
      quota: parseFloat(row.quota),
      used: parseFloat(row.used),
      carried_over: parseFloat(row.carried_over || 0),
      remaining: parseFloat(row.quota) + parseFloat(row.carried_over || 0) - parseFloat(row.used)
    };
  }
  res.json(result);
});

// ยื่นใบลา
app.post('/api/leave', requireLogin, async (req, res) => {
  try {
    const { leave_type, start_date, end_date, days, reason } = req.body;
    const userId = req.session.user.id;
    const leaveNo = await generateLeaveNo();

    // หาผู้อนุมัติ
    const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
    const user = userResult.rows[0];
    const approverId = user.manager_id;

    await pool.query(
      'INSERT INTO leave_requests (leave_no,user_id,leave_type,start_date,end_date,days,reason,status,approver_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [leaveNo, userId, leave_type, start_date, end_date, days, reason, 'pending', approverId]
    );

    // ส่ง Email แจ้งหัวหน้า
    if (approverId) {
      const approver = await pool.query('SELECT * FROM users WHERE id=$1', [approverId]);
      if (approver.rows[0] && approver.rows[0].email && process.env.SMTP_USER) {
        const leaveInfo = LEAVE_TYPES[leave_type];
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: approver.rows[0].email,
          subject: `[ใบลา] ${user.name} ขอ${leaveInfo?.name || leave_type} ${days} วัน`,
          html: `
            <h3>มีคำขอลาใหม่รอการอนุมัติ</h3>
            <p><b>ผู้ขอลา:</b> ${user.name} (${user.dept})</p>
            <p><b>ประเภท:</b> ${leaveInfo?.name || leave_type}</p>
            <p><b>วันที่:</b> ${new Date(start_date).toLocaleDateString('th-TH')} - ${new Date(end_date).toLocaleDateString('th-TH')}</p>
            <p><b>จำนวน:</b> ${days} วัน</p>
            <p><b>เหตุผล:</b> ${reason || '-'}</p>
            <p>กรุณาเข้าระบบเพื่ออนุมัติ</p>
          `
        }).catch(e => console.log('Email error:', e.message));
      }
    }

    res.json({ ok: true, leave_no: leaveNo });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ดูใบลาของตัวเอง
app.get('/api/leave/my', requireLogin, async (req, res) => {
  const r = await pool.query(
    'SELECT lr.*, u.name as user_name, u.dept, a.name as approver_name FROM leave_requests lr LEFT JOIN users u ON lr.user_id=u.id LEFT JOIN users a ON lr.approver_id=a.id WHERE lr.user_id=$1 ORDER BY lr.created_at DESC',
    [req.session.user.id]
  );
  res.json(r.rows);
});

// ดูใบลาที่รอฉันอนุมัติ
app.get('/api/leave/pending', requireLogin, async (req, res) => {
  const r = await pool.query(
    'SELECT lr.*, u.name as user_name, u.dept, u.email as user_email FROM leave_requests lr LEFT JOIN users u ON lr.user_id=u.id WHERE lr.approver_id=$1 AND lr.status=$2 ORDER BY lr.created_at DESC',
    [req.session.user.id, 'pending']
  );
  res.json(r.rows);
});

// ดูใบลาทั้งหมด (Admin)
app.get('/api/leave/all', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query(
    'SELECT lr.*, u.name as user_name, u.dept, a.name as approver_name FROM leave_requests lr LEFT JOIN users u ON lr.user_id=u.id LEFT JOIN users a ON lr.approver_id=a.id ORDER BY lr.created_at DESC LIMIT 200'
  );
  res.json(r.rows);
});

// อนุมัติ/ไม่อนุมัติ
app.put('/api/leave/:id/approve', requireLogin, async (req, res) => {
  const { status, reject_reason } = req.body;
  const lr = await pool.query('SELECT * FROM leave_requests WHERE id=$1', [req.params.id]);
  const leave = lr.rows[0];
  if (!leave) return res.status(404).json({ error: 'ไม่พบใบลา' });
  if (leave.approver_id !== req.session.user.id && req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'ไม่มีสิทธิ์อนุมัติ' });

  await pool.query(
    'UPDATE leave_requests SET status=$1, reject_reason=$2, approved_at=NOW() WHERE id=$3',
    [status, reject_reason||null, req.params.id]
  );

  // อัปเดต quota ถ้าอนุมัติ
  if (status === 'approved') {
    const year = new Date(leave.start_date).getFullYear();
    await pool.query(
      'INSERT INTO leave_quotas (user_id,year,leave_type,quota,used,carried_over) VALUES ($1,$2,$3,0,$4,0) ON CONFLICT (user_id,year,leave_type) DO UPDATE SET used = leave_quotas.used + $4',
      [leave.user_id, year, leave.leave_type, leave.days]
    );

    // ตรวจสอบ cap 24 วัน สำหรับ annual leave
    if (leave.leave_type === 'annual') {
      const quota = await pool.query(
        'SELECT * FROM leave_quotas WHERE user_id=$1 AND year=$2 AND leave_type=$3',
        [leave.user_id, year, 'annual']
      );
      const q = quota.rows[0];
      const total = parseFloat(q.quota) + parseFloat(q.carried_over || 0);
      if (total > 24) {
        await pool.query(
          'UPDATE leave_quotas SET carried_over = GREATEST(0, 24 - quota) WHERE user_id=$1 AND year=$2 AND leave_type=$3',
          [leave.user_id, year, 'annual']
        );
      }
    }
  }

  // ส่ง Email แจ้งพนักงาน
  const userResult = await pool.query('SELECT * FROM users WHERE id=$1', [leave.user_id]);
  const user = userResult.rows[0];
  if (user && user.email && process.env.SMTP_USER) {
    const statusText = status === 'approved' ? 'อนุมัติแล้ว ✅' : 'ไม่อนุมัติ ❌';
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: user.email,
      subject: `[ใบลา ${leave.leave_no}] ${statusText}`,
      html: `
        <h3>ผลการพิจารณาใบลา ${leave.leave_no}</h3>
        <p><b>สถานะ:</b> ${statusText}</p>
        <p><b>ประเภท:</b> ${LEAVE_TYPES[leave.leave_type]?.name || leave.leave_type}</p>
        <p><b>วันที่:</b> ${new Date(leave.start_date).toLocaleDateString('th-TH')} - ${new Date(leave.end_date).toLocaleDateString('th-TH')}</p>
        ${reject_reason ? `<p><b>เหตุผลที่ไม่อนุมัติ:</b> ${reject_reason}</p>` : ''}
      `
    }).catch(e => console.log('Email error:', e.message));
  }

  res.json({ ok: true });
});

// รายงานสรุปการลาแยกฝ่าย
app.get('/api/leave/report', requireLogin, requireAdmin, async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const r = await pool.query(`
    SELECT u.dept,
      COUNT(DISTINCT u.id) as emp_count,
      COUNT(lr.id) as total_requests,
      SUM(CASE WHEN lr.status='approved' THEN lr.days ELSE 0 END) as total_days,
      SUM(CASE WHEN lr.status='approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN lr.status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN lr.status='rejected' THEN 1 ELSE 0 END) as rejected
    FROM users u
    LEFT JOIN leave_requests lr ON u.id=lr.user_id AND EXTRACT(YEAR FROM lr.created_at)=$1
    WHERE u.role != 'admin'
    GROUP BY u.dept ORDER BY u.dept
  `, [year]);
  res.json(r.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Intranet running on port', PORT));
