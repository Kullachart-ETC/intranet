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

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ======== DB INIT ========
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
    CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      leave_no TEXT UNIQUE,
      user_id INTEGER,
      leave_type TEXT,
      start_datetime TIMESTAMP,
      end_datetime TIMESTAMP,
      hours NUMERIC,
      days NUMERIC,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      approver_id INTEGER,
      approved_at TIMESTAMP,
      reject_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS start_datetime TIMESTAMP;
    ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS end_datetime TIMESTAMP;
    ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS hours NUMERIC DEFAULT 0;
    CREATE TABLE IF NOT EXISTS leave_quotas (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      leave_year INTEGER,
      leave_type TEXT,
      quota NUMERIC DEFAULT 0,
      used_hours NUMERIC DEFAULT 0,
      carried_hours NUMERIC DEFAULT 0,
      UNIQUE(user_id, leave_year, leave_type)
    );
    CREATE TABLE IF NOT EXISTS annual_leave_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      work_year INTEGER,
      quota_hours NUMERIC,
      granted_at DATE,
      expires_at DATE
    );
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      original_name TEXT NOT NULL,
      dept TEXT NOT NULL,
      file_data BYTEA NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
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
  const emp = await pool.query('SELECT COUNT(*) FROM employees');
  if (parseInt(emp.rows[0].count) === 0) {
    await pool.query(`INSERT INTO employees (name,dept,color) VALUES
      ('สมชาย ใจดี','IT','#1D9E75'),
      ('สมหญิง รักงาน','HR','#185FA5'),
      ('วิชัย เก่งมาก','Finance','#993C1D'),
      ('นิดา สวยงาม','Marketing','#993556'),
      ('ประยุทธ์ ตั้งใจ','Sales','#534AB7')`);
  }
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

// ======== LEAVE HELPERS ========

// ชั่วโมงทำงานต่อวัน: 8:30-17:40 หักพัก 12:00-13:00 = 8.17 ชม.
const WORK_HOURS_PER_DAY = 8 + (10/60); // 8.1667
const WORK_START = { h: 8, m: 30 };
const WORK_END   = { h: 17, m: 40 };
const BREAK_START = { h: 12, m: 0 };
const BREAK_END   = { h: 13, m: 0 };
const MIN_LEAVE_HOURS = 0.5; // 30 นาที

// คำนวณชั่วโมงทำงานจริง (หักพักเที่ยง)
function calcWorkHours(startDT, endDT) {
  const s = new Date(startDT);
  const e = new Date(endDT);
  if (e <= s) return 0;

  let totalHours = 0;
  const cur = new Date(s);

  while (cur < e) {
    const dayEnd = new Date(cur);
    dayEnd.setHours(WORK_END.h, WORK_END.m, 0, 0);
    const dayStart = new Date(cur);
    dayStart.setHours(WORK_START.h, WORK_START.m, 0, 0);
    const breakS = new Date(cur);
    breakS.setHours(BREAK_START.h, BREAK_START.m, 0, 0);
    const breakE = new Date(cur);
    breakE.setHours(BREAK_END.h, BREAK_END.m, 0, 0);

    const segStart = cur < dayStart ? dayStart : cur;
    const segEnd   = e < dayEnd ? e : dayEnd;

    if (segEnd > segStart) {
      let hrs = (segEnd - segStart) / 3600000;
      // หักพักเที่ยง
      const overlapStart = segStart < breakS ? breakS : segStart;
      const overlapEnd   = segEnd > breakE ? breakE : segEnd;
      if (overlapEnd > overlapStart) {
        hrs -= (overlapEnd - overlapStart) / 3600000;
      }
      totalHours += Math.max(0, hrs);
    }

    // ไปวันถัดไป
    cur.setDate(cur.getDate() + 1);
    cur.setHours(WORK_START.h, WORK_START.m, 0, 0);
    if (cur.getDay() === 0) cur.setDate(cur.getDate() + 1); // ข้ามอาทิตย์
    if (cur.getDay() === 6) cur.setDate(cur.getDate() + 2); // ข้ามเสาร์
  }

  return Math.round(totalHours * 100) / 100;
}

// คำนวณ quota พักร้อน (ชั่วโมง) ตามอายุงาน
function calcAnnualQuotaHours(workYears) {
  let days = 0;
  if (workYears >= 11) days = 12;
  else if (workYears >= 10) days = 10;
  else if (workYears >= 6)  days = 9;
  else if (workYears >= 3)  days = 8;
  else if (workYears >= 2)  days = 7;
  else if (workYears >= 1)  days = 6;
  else days = 0;
  return days * WORK_HOURS_PER_DAY;
}

// คำนวณอายุงาน (ปี) ณ วันที่ระบุ
function calcWorkYears(startDate, atDate) {
  const s = new Date(startDate);
  const a = new Date(atDate);
  let years = a.getFullYear() - s.getFullYear();
  const m = a.getMonth() - s.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < s.getDate())) years--;
  return Math.max(0, years);
}

// Grant annual leave quota เมื่อครบปีทำงาน
async function grantAnnualLeaveIfDue(userId) {
  const userR = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  const user = userR.rows[0];
  if (!user || !user.start_date) return;

  const today = new Date();
  const startDate = new Date(user.start_date);
  const workYears = calcWorkYears(startDate, today);
  if (workYears < 1) return;

  // ตรวจว่า grant ปีนี้แล้วหรือยัง
  const alreadyGranted = await pool.query(
    'SELECT id FROM annual_leave_log WHERE user_id=$1 AND work_year=$2',
    [userId, workYears]
  );
  if (alreadyGranted.rows.length > 0) return;

  const quotaHours = calcAnnualQuotaHours(workYears);
  const grantedAt = new Date(startDate);
  grantedAt.setFullYear(startDate.getFullYear() + workYears);

  // วันหมดอายุ = วันเข้างาน + (workYears + 2) ปี
  const expiresAt = new Date(startDate);
  expiresAt.setFullYear(startDate.getFullYear() + workYears + 2);

  const leaveYear = grantedAt.getFullYear();

  await pool.query(
    'INSERT INTO annual_leave_log (user_id,work_year,quota_hours,granted_at,expires_at) VALUES ($1,$2,$3,$4,$5)',
    [userId, workYears, quotaHours, grantedAt, expiresAt]
  );

  // เพิ่ม quota ใน leave_quotas
  await pool.query(`
    INSERT INTO leave_quotas (user_id,leave_year,leave_type,quota,used_hours,carried_hours)
    VALUES ($1,$2,'annual',$3,0,0)
    ON CONFLICT (user_id,leave_year,leave_type)
    DO UPDATE SET quota = leave_quotas.quota + $3
  `, [userId, leaveYear, quotaHours]);

  // ตัด quota ที่หมดอายุ (ปีแรกถูกตัดเมื่อขึ้นปีที่ 3)
  if (workYears >= 3) {
    const expiredWorkYear = workYears - 2;
    const expiredLog = await pool.query(
      'SELECT * FROM annual_leave_log WHERE user_id=$1 AND work_year=$2',
      [userId, expiredWorkYear]
    );
    if (expiredLog.rows[0]) {
      const expiredLeaveYear = new Date(expiredLog.rows[0].granted_at).getFullYear();
      // ดึง quota ที่ยังเหลือของปีที่หมดอายุ
      const oldQ = await pool.query(
        'SELECT * FROM leave_quotas WHERE user_id=$1 AND leave_year=$2 AND leave_type=$3',
        [userId, expiredLeaveYear, 'annual']
      );
      if (oldQ.rows[0]) {
        const remaining = parseFloat(oldQ.rows[0].quota) - parseFloat(oldQ.rows[0].used_hours);
        if (remaining > 0) {
          // ตัดออก (set quota = used เพื่อให้ remaining = 0)
          await pool.query(
            'UPDATE leave_quotas SET quota=used_hours WHERE user_id=$1 AND leave_year=$2 AND leave_type=$3',
            [userId, expiredLeaveYear, 'annual']
          );
          console.log(`Expired annual leave for user ${userId} work_year ${expiredWorkYear}: ${remaining} hrs forfeited`);
        }
      }
    }
  }
}

// ดึง quota รวม annual leave (รวมทุกปีที่ยังไม่หมดอายุ)
async function getAnnualLeaveBalance(userId) {
  const today = new Date();
  const r = await pool.query(
    'SELECT * FROM leave_quotas WHERE user_id=$1 AND leave_type=$2 ORDER BY leave_year',
    [userId, 'annual']
  );
  let totalQuota = 0, totalUsed = 0;
  for (const row of r.rows) {
    totalQuota += parseFloat(row.quota);
    totalUsed  += parseFloat(row.used_hours);
  }
  return { quota: totalQuota, used: totalUsed, remaining: totalQuota - totalUsed };
}

const LEAVE_TYPES = {
  sick:             { name: 'ลาป่วย',               quota_days: 30,  paid: true  },
  annual:           { name: 'ลาพักร้อน',             quota_days: 0,   paid: true  },
  personal:         { name: 'ลากิจจำเป็น',           quota_days: 5,   paid: true  },
  personal_special: { name: 'ลากิจพิเศษ',            quota_days: 7,   paid: false },
  maternity:        { name: 'ลาคลอด',                quota_days: 60,  paid: true  },
  ordain:           { name: 'ลาบวช',                 quota_days: 15,  paid: true  },
  military:         { name: 'ลาราชการทหาร',          quota_days: 60,  paid: true  },
  marriage:         { name: 'ลาสมรส',                quota_days: 7,   paid: true  },
  work_injury:      { name: 'ลาป่วยเนื่องจากงาน',   quota_days: 30,  paid: true  },
  unpaid:           { name: 'ลาตัดเงิน',             quota_days: 30,  paid: false }
};

async function generateLeaveNo() {
  const now = new Date();
  const year = now.getFullYear();
  const r = await pool.query(
    'SELECT COUNT(*) FROM leave_requests WHERE EXTRACT(YEAR FROM created_at)=$1', [year]
  );
  const count = parseInt(r.rows[0].count) + 1;
  return `LV${year}${String(count).padStart(4,'0')}`;
}

// ======== MIDDLEWARE ========
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'เฉพาะ Admin เท่านั้น' });
}

// ======== AUTH ========
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  req.session.user = { id: user.id, username: user.username, name: user.name, dept: user.dept, role: user.role, email: user.email };
  res.json({ ok: true, user: req.session.user });
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
});

app.use((req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/api/')) return next();
  if (!req.session.user) return res.redirect('/login');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ======== API USERS ========
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

// ======== API POSTS ========
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

// ======== API EMPLOYEES ========
app.get('/api/employees', requireLogin, async (req, res) => {
  const r = await pool.query(`
    SELECT id, name, dept,
      CASE dept
        WHEN 'IT' THEN '#1D9E75' WHEN 'HR' THEN '#185FA5'
        WHEN 'Finance' THEN '#993C1D' WHEN 'Marketing' THEN '#993556'
        WHEN 'Sales' THEN '#534AB7' ELSE '#888888'
      END as color
    FROM users WHERE role != 'admin' ORDER BY name
  `);
  res.json(r.rows);
});

// ======== API EVENTS ========
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

// ======== API BOOKINGS ========
app.get('/api/bookings', requireLogin, async (req, res) => {
  const r = await pool.query('SELECT * FROM bookings');
  res.json(r.rows);
});
app.post('/api/bookings', requireLogin, async (req, res) => {
  const { room_idx, date, slot, name, purpose } = req.body;
  const [newStart, newEnd] = slot.split('-');
  const existing = await pool.query(
    `SELECT id FROM bookings WHERE room_idx=$1 AND date=$2
     AND SPLIT_PART(slot,'-',1) < $4 AND SPLIT_PART(slot,'-',2) > $3`,
    [room_idx, date, newStart, newEnd]
  );
  if (existing.rows.length > 0) return res.status(409).json({ error: 'ช่วงเวลานี้ทับซ้อนกับการจองที่มีอยู่' });
  await pool.query(
    'INSERT INTO bookings (room_idx,date,slot,name,purpose,user_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [room_idx, date, slot, name, purpose, req.session.user.id]
  );
  res.json({ ok: true });
});
app.delete('/api/bookings/:id', requireLogin, async (req, res) => {
  await pool.query('DELETE FROM bookings WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ======== API LEAVE ========

// ดึง quota ทั้งหมดของ user
app.get('/api/leave/quota/:userId', requireLogin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    // Grant annual leave ถ้าครบปีแล้ว
    await grantAnnualLeaveIfDue(userId);

    const userR = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
    const user = userR.rows[0];
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

    const result = {};
    const workYears = calcWorkYears(user.start_date, new Date());

    for (const [type, info] of Object.entries(LEAVE_TYPES)) {
      if (type === 'annual') {
        const bal = await getAnnualLeaveBalance(userId);
        result[type] = {
          name: info.name,
          quota_hours: bal.quota,
          used_hours: bal.used,
          remaining_hours: bal.remaining,
          quota_days: bal.quota / WORK_HOURS_PER_DAY,
          used_days: bal.used / WORK_HOURS_PER_DAY,
          remaining_days: bal.remaining / WORK_HOURS_PER_DAY,
          work_years: workYears
        };
      } else {
        const quotaHours = info.quota_days * WORK_HOURS_PER_DAY;
        const leaveYear = new Date().getFullYear();
        const q = await pool.query(
          'SELECT * FROM leave_quotas WHERE user_id=$1 AND leave_year=$2 AND leave_type=$3',
          [userId, leaveYear, type]
        );
        let row = q.rows[0];
        if (!row) {
          await pool.query(
            'INSERT INTO leave_quotas (user_id,leave_year,leave_type,quota,used_hours,carried_hours) VALUES ($1,$2,$3,$4,0,0) ON CONFLICT DO NOTHING',
            [userId, leaveYear, type, quotaHours]
          );
          row = { quota: quotaHours, used_hours: 0, carried_hours: 0 };
        }
        const quota   = parseFloat(row.quota);
        const used    = parseFloat(row.used_hours);
        const remaining = quota - used;
        result[type] = {
          name: info.name,
          quota_hours: quota,
          used_hours: used,
          remaining_hours: remaining,
          quota_days: quota / WORK_HOURS_PER_DAY,
          used_days: used / WORK_HOURS_PER_DAY,
          remaining_days: remaining / WORK_HOURS_PER_DAY
        };
      }
    }
    res.json(result);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// คำนวณชั่วโมงลา (preview ก่อนยื่น)
app.post('/api/leave/calculate', requireLogin, async (req, res) => {
  try {
    const { start_datetime, end_datetime } = req.body;
    if (!start_datetime || !end_datetime)
      return res.status(400).json({ error: 'กรุณาระบุวันเวลาเริ่มต้นและสิ้นสุด' });
    const hours = calcWorkHours(start_datetime, end_datetime);
    if (hours < MIN_LEAVE_HOURS)
      return res.status(400).json({ error: `ลาขั้นต่ำ ${MIN_LEAVE_HOURS * 60} นาที` });
    const days = hours / WORK_HOURS_PER_DAY;
    res.json({ hours: Math.round(hours*100)/100, days: Math.round(days*100)/100 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ยื่นใบลา
app.post('/api/leave', requireLogin, async (req, res) => {
  try {
    const { leave_type, start_datetime, end_datetime, reason } = req.body;
    if (!LEAVE_TYPES[leave_type]) return res.status(400).json({ error: 'ประเภทการลาไม่ถูกต้อง' });

    const hours = calcWorkHours(start_datetime, end_datetime);
    if (hours < MIN_LEAVE_HOURS)
      return res.status(400).json({ error: `ลาขั้นต่ำ ${MIN_LEAVE_HOURS * 60} นาที` });

    const days = hours / WORK_HOURS_PER_DAY;
    const userId = req.session.user.id;

    // ตรวจ quota (ยกเว้น sick, work_injury, military, unpaid ที่ไม่จำกัดเข้มงวด)
    if (leave_type === 'annual') {
      await grantAnnualLeaveIfDue(userId);
      const bal = await getAnnualLeaveBalance(userId);
      if (bal.remaining < hours)
        return res.status(400).json({ error: `วันพักร้อนไม่เพียงพอ (คงเหลือ ${(bal.remaining/WORK_HOURS_PER_DAY).toFixed(2)} วัน)` });
    }

    const leaveNo = await generateLeaveNo();
    const userR   = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
    const user    = userR.rows[0];
    const approverId = user.manager_id;

    await pool.query(
      `INSERT INTO leave_requests
        (leave_no,user_id,leave_type,start_datetime,end_datetime,hours,days,reason,status,approver_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
      [leaveNo, userId, leave_type, start_datetime, end_datetime, hours, days, reason||'', approverId]
    );

    // Email หัวหน้า
    if (approverId) {
      const approverR = await pool.query('SELECT * FROM users WHERE id=$1', [approverId]);
      const approver  = approverR.rows[0];
      if (approver && approver.email && process.env.SMTP_USER) {
        const info = LEAVE_TYPES[leave_type];
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: approver.email,
          subject: `[ใบลา] ${user.name} ขอ${info.name} ${hours.toFixed(2)} ชม. (${days.toFixed(2)} วัน)`,
          html: `
            <h3>มีคำขอลาใหม่รอการอนุมัติ</h3>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="padding:6px;font-weight:bold">ผู้ขอลา</td><td>${user.name} (${user.dept})</td></tr>
              <tr><td style="padding:6px;font-weight:bold">ประเภท</td><td>${info.name}</td></tr>
              <tr><td style="padding:6px;font-weight:bold">เริ่ม</td><td>${new Date(start_datetime).toLocaleString('th-TH')}</td></tr>
              <tr><td style="padding:6px;font-weight:bold">สิ้นสุด</td><td>${new Date(end_datetime).toLocaleString('th-TH')}</td></tr>
              <tr><td style="padding:6px;font-weight:bold">จำนวน</td><td>${hours.toFixed(2)} ชม. (${days.toFixed(2)} วัน)</td></tr>
              <tr><td style="padding:6px;font-weight:bold">เหตุผล</td><td>${reason||'-'}</td></tr>
            </table>
            <p style="margin-top:16px">กรุณาเข้าระบบเพื่ออนุมัติ</p>
          `
        }).catch(e => console.log('Email error:', e.message));
      }
    }

    res.json({ ok: true, leave_no: leaveNo, hours, days });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ดูใบลาของตัวเอง
app.get('/api/leave/my', requireLogin, async (req, res) => {
  const r = await pool.query(
    `SELECT lr.*, u.name as user_name, u.dept, a.name as approver_name
     FROM leave_requests lr
     LEFT JOIN users u ON lr.user_id=u.id
     LEFT JOIN users a ON lr.approver_id=a.id
     WHERE lr.user_id=$1 ORDER BY lr.created_at DESC`,
    [req.session.user.id]
  );
  res.json(r.rows);
});

// ดูใบลาที่รอฉันอนุมัติ
app.get('/api/leave/pending', requireLogin, async (req, res) => {
  const r = await pool.query(
    `SELECT lr.*, u.name as user_name, u.dept, u.email as user_email
     FROM leave_requests lr
     LEFT JOIN users u ON lr.user_id=u.id
     WHERE lr.approver_id=$1 AND lr.status='pending'
     ORDER BY lr.created_at DESC`,
    [req.session.user.id]
  );
  res.json(r.rows);
});

// ดูใบลาทั้งหมด (Admin)
app.get('/api/leave/all', requireLogin, requireAdmin, async (req, res) => {
  const r = await pool.query(
    `SELECT lr.*, u.name as user_name, u.dept, a.name as approver_name
     FROM leave_requests lr
     LEFT JOIN users u ON lr.user_id=u.id
     LEFT JOIN users a ON lr.approver_id=a.id
     ORDER BY lr.created_at DESC LIMIT 200`
  );
  res.json(r.rows);
});

app.get('/api/leave/report-list', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { leave_type, date_from, date_to, status, dept } = req.query;
    const conds = [], params = [];
    if (leave_type) { params.push(leave_type); conds.push(`lr.leave_type=$${params.length}`); }
    if (status)     { params.push(status);     conds.push(`lr.status=$${params.length}`); }
    if (dept)       { params.push(dept);       conds.push(`u.dept=$${params.length}`); }
    if (date_from)  { params.push(date_from);  conds.push(`lr.start_datetime::date >= $${params.length}::date`); }
    if (date_to)    { params.push(date_to);    conds.push(`lr.end_datetime::date <= $${params.length}::date`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await pool.query(
      `SELECT lr.leave_no, lr.created_at, lr.leave_type, lr.start_datetime, lr.end_datetime,
              lr.days, lr.hours, lr.status, lr.reject_reason, lr.approved_at,
              u.name as user_name, u.dept, a.name as approver_name
       FROM leave_requests lr
       LEFT JOIN users u ON lr.user_id=u.id
       LEFT JOIN users a ON lr.approver_id=a.id
       ${where}
       ORDER BY lr.created_at DESC`, params
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// อนุมัติ / ไม่อนุมัติ
app.put('/api/leave/:id/approve', requireLogin, async (req, res) => {
  try {
    const { status, reject_reason } = req.body;
    const lr    = await pool.query('SELECT * FROM leave_requests WHERE id=$1', [req.params.id]);
    const leave = lr.rows[0];
    if (!leave) return res.status(404).json({ error: 'ไม่พบใบลา' });
    if (leave.approver_id !== req.session.user.id && req.session.user.role !== 'admin')
      return res.status(403).json({ error: 'ไม่มีสิทธิ์อนุมัติ' });

    await pool.query(
      'UPDATE leave_requests SET status=$1,reject_reason=$2,approved_at=NOW() WHERE id=$3',
      [status, reject_reason||null, req.params.id]
    );

    // อัปเดต used_hours เมื่ออนุมัติ
    if (status === 'approved') {
      const leaveYear = new Date(leave.start_datetime).getFullYear();
      if (leave.leave_type === 'annual') {
        // หักจาก quota ปีเก่าสุดที่ยังเหลือก่อน
        let remaining = parseFloat(leave.hours);
        const quotas = await pool.query(
          'SELECT * FROM leave_quotas WHERE user_id=$1 AND leave_type=$2 AND quota > used_hours ORDER BY leave_year',
          [leave.user_id, 'annual']
        );
        for (const q of quotas.rows) {
          if (remaining <= 0) break;
          const avail = parseFloat(q.quota) - parseFloat(q.used_hours);
          const deduct = Math.min(avail, remaining);
          await pool.query(
            'UPDATE leave_quotas SET used_hours=used_hours+$1 WHERE id=$2',
            [deduct, q.id]
          );
          remaining -= deduct;
        }
      } else {
        await pool.query(
          `INSERT INTO leave_quotas (user_id,leave_year,leave_type,quota,used_hours,carried_hours)
           VALUES ($1,$2,$3,$4,$5,0)
           ON CONFLICT (user_id,leave_year,leave_type)
           DO UPDATE SET used_hours = leave_quotas.used_hours + $5`,
          [leave.user_id, leaveYear, leave.leave_type,
           LEAVE_TYPES[leave.leave_type].quota_days * WORK_HOURS_PER_DAY,
           leave.hours]
        );
      }
    }

    // Email พนักงาน
    const userR = await pool.query('SELECT * FROM users WHERE id=$1', [leave.user_id]);
    const user  = userR.rows[0];
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
          <p><b>วันที่:</b> ${new Date(leave.start_datetime).toLocaleString('th-TH')} - ${new Date(leave.end_datetime).toLocaleString('th-TH')}</p>
          <p><b>จำนวน:</b> ${parseFloat(leave.hours).toFixed(2)} ชม. (${parseFloat(leave.days).toFixed(2)} วัน)</p>
          ${reject_reason ? `<p><b>เหตุผลที่ไม่อนุมัติ:</b> ${reject_reason}</p>` : ''}
        `
      }).catch(e => console.log('Email error:', e.message));
    }

    res.json({ ok: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// รายงานสรุปการลา (Admin)
app.get('/api/leave/report', requireLogin, requireAdmin, async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const r = await pool.query(`
    SELECT u.dept,
      COUNT(DISTINCT u.id) as emp_count,
      COUNT(lr.id) as total_requests,
      SUM(CASE WHEN lr.status='approved' THEN lr.hours ELSE 0 END) as total_hours,
      SUM(CASE WHEN lr.status='approved' THEN lr.days  ELSE 0 END) as total_days,
      SUM(CASE WHEN lr.status='approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN lr.status='pending'  THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN lr.status='rejected' THEN 1 ELSE 0 END) as rejected
    FROM users u
    LEFT JOIN leave_requests lr ON u.id=lr.user_id
      AND EXTRACT(YEAR FROM lr.created_at)=$1
    WHERE u.role != 'admin'
    GROUP BY u.dept ORDER BY u.dept
  `, [year]);
  res.json(r.rows);
});

// ดึงข้อมูลอายุงานและ quota สำหรับแสดง
app.get('/api/leave/annual-log/:userId', requireLogin, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM annual_leave_log WHERE user_id=$1 ORDER BY work_year',
    [req.params.userId]
  );
  res.json(r.rows);
});

// ============================================================
// วิธีใช้: เพิ่มโค้ดนี้ใน server.js ก่อนบรรทัด const PORT = ...
// แล้วรันคำสั่ง: npm install multer xlsx
// ============================================================

const multer = require('multer');
const XLSX   = require('xlsx');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.includes('spreadsheet') || file.originalname.endsWith('.xlsx'))
      cb(null, true);
    else
      cb(new Error('รองรับเฉพาะไฟล์ .xlsx เท่านั้น'));
  }
});


// ======== GET /api/users/template ========
app.get('/api/users/template', requireLogin, requireAdmin, (req, res) => {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();

  // Header rows (4 rows)
  const headers = [
    ['แบบฟอร์มนำเข้าพนักงาน - Employee Import Template'],
    ['กรุณากรอกข้อมูลตั้งแต่แถวที่ 5 เป็นต้นไป'],
    ['(*) = จำเป็นต้องกรอก'],
    [
      'รหัสพนักงาน', 'ชื่อ(*)', 'นามสกุล(*)', 'Email(*)',
      'แผนก(*)', 'ตำแหน่ง', 'วันเริ่มงาน (YYYY-MM-DD)', 'ประเภทพนักงาน',
      'รหัสหัวหน้า', 'Username(*)', 'Password(*)', 'Role(*) (admin/user)',
      'โควต้าพักร้อน (ชม.)', 'โควต้าลาป่วย (ชม.)', 'โควต้าลากิจ (ชม.)', 'หมายเหตุ'
    ]
  ];

  // Example row
  const example = [
    ['10001','สมชาย','ใจดี','somchai@earth-th.com',
     'IT','Developer','2023-01-01','full-time',
     '','somchai','Pass1234','user',
     '98','','','']
  ];

  const ws = XLSX.utils.aoa_to_sheet([...headers, ...example]);
  ws['!cols'] = Array(16).fill({ wch: 18 });
  XLSX.utils.book_append_sheet(wb, ws, 'Employee_Template');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="employee_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ======== POST /api/users/bulk-upload ========
app.post('/api/users/bulk-upload', requireLogin, requireAdmin,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });

      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets['Employee_Template'];
      if (!ws)
        return res.status(400).json({ error: 'ไม่พบ sheet "Employee_Template" — กรุณาใช้ template ที่กำหนด' });

      // อ่านตั้งแต่แถว 5 (index 4) เป็นต้นไป, ข้าม header 4 แถวแรก
      const rows = XLSX.utils.sheet_to_json(ws, { range: 4, header: 1, defval: '' });

      const WORK_HOURS = 8 + (10 / 60); // 8.1667 ชม./วัน
      const results = { success: [], errors: [] };

      for (let i = 0; i < rows.length; i++) {
        const row    = rows[i];
        const rowNum = i + 5;

        // ข้ามแถวว่าง
        if (!row[0] && !row[1] && !row[9]) continue;

        const [
          empId, firstName, lastName, email,
          dept, position, startDate, empType,
          supervisorEmpId, _usernameCol, password, role,
          annualHours, sickHours, personalHours, notes
        ] = row;

        // ใช้ รหัสพนักงาน (A) เป็น username เสมอ
        const username = empId;

        // ตรวจ required fields
        const missing = [];
        if (!empId)          missing.push('รหัสพนักงาน (A)');
        if (!firstName)      missing.push('ชื่อ (B)');
        if (!lastName)       missing.push('นามสกุล (C)');
        if (!email)          missing.push('อีเมล (D)');
        if (!dept)           missing.push('แผนก (E)');
        if (!password)       missing.push('Password (K)');
        if (!role)           missing.push('Role (L)');

        if (missing.length > 0) {
          results.errors.push({ row: rowNum, error: `ขาดข้อมูล: ${missing.join(', ')}` });
          continue;
        }

        // ตรวจ role ถูกต้อง
        const roleClean = String(role).toLowerCase().trim();
        if (!['admin', 'user'].includes(roleClean)) {
          results.errors.push({ row: rowNum, error: `Role "${role}" ไม่ถูกต้อง (ต้องเป็น admin หรือ user)` });
          continue;
        }

        try {
          const hash = bcrypt.hashSync(String(password), 10);
          const name = `${String(firstName).trim()} ${String(lastName).trim()}`;
          const usernameClean = String(username).trim();

          // แปลงวันที่
          let parsedDate = null;
          if (startDate) {
            if (startDate instanceof Date) {
              parsedDate = startDate.toISOString().split('T')[0];
            } else {
              const d = new Date(startDate);
              if (!isNaN(d)) parsedDate = d.toISOString().split('T')[0];
            }
          }

          // annual_leave_quota เก็บเป็น วัน (ปัดเศษ)
          const annualH = parseFloat(annualHours) || (6 * WORK_HOURS);
          const annualDays = Math.round(annualH / WORK_HOURS);

          // UPSERT: ถ้ามีอยู่แล้วให้ทับข้อมูล
          const upsertResult = await pool.query(
            `INSERT INTO users (username,password,name,dept,role,email,start_date,annual_leave_quota)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (username) DO UPDATE SET
               password = EXCLUDED.password,
               name = EXCLUDED.name,
               dept = EXCLUDED.dept,
               role = EXCLUDED.role,
               email = EXCLUDED.email,
               start_date = EXCLUDED.start_date,
               annual_leave_quota = EXCLUDED.annual_leave_quota
             RETURNING id`,
            [usernameClean, hash, name, String(dept).trim(),
             roleClean, String(email).trim(), parsedDate, annualDays]
          );

          const userId    = upsertResult.rows[0].id;
          const leaveYear = new Date().getFullYear();

          // ตั้งค่า leave_quotas (ON CONFLICT DO NOTHING เพื่อไม่ทับข้อมูลการลาที่ใช้ไปแล้ว)
          const leaveSetup = [
            ['annual',   annualH],
            ['sick',     parseFloat(sickHours)     || 40],
            ['personal', parseFloat(personalHours) || 16],
          ];

          for (const [type, hours] of leaveSetup) {
            await pool.query(
              `INSERT INTO leave_quotas (user_id,leave_year,leave_type,quota,used_hours,carried_hours)
               VALUES ($1,$2,$3,$4,0,0) ON CONFLICT DO NOTHING`,
              [userId, leaveYear, type, hours]
            );
          }

          results.success.push({ row: rowNum, username: usernameClean, name });
        } catch (e) {
          results.errors.push({ row: rowNum, error: e.message });
        }
      }

      res.json({
        ok: true,
        total:         results.success.length + results.errors.length,
        success_count: results.success.length,
        error_count:   results.errors.length,
        success:       results.success,
        errors:        results.errors
      });

    } catch (e) {
      console.error('Bulk upload error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

// ======== API DOCUMENTS ========
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

async function isManagerOrAdmin(userId) {
  const user = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
  if (!user.rows.length) return false;
  if (user.rows[0].role === 'admin') return true;
  const managed = await pool.query('SELECT COUNT(*) FROM users WHERE manager_id=$1', [userId]);
  return parseInt(managed.rows[0].count) > 0;
}

// GET /api/documents/can-manage
app.get('/api/documents/can-manage', requireLogin, async (req, res) => {
  const ok = await isManagerOrAdmin(req.session.user.id);
  res.json({ canManage: ok });
});

// GET /api/documents - list (no file_data)
app.get('/api/documents', requireLogin, async (req, res) => {
  const { dept } = req.query;
  let q = 'SELECT d.id, d.original_name, d.dept, d.file_size, d.mime_type, d.created_at, u.name AS uploader_name FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by';
  const params = [];
  if (dept) { q += ' WHERE d.dept=$1'; params.push(dept); }
  q += ' ORDER BY d.dept, d.created_at DESC';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// POST /api/documents - upload
app.post('/api/documents', requireLogin, docUpload.single('file'), async (req, res) => {
  try {
    const canUpload = await isManagerOrAdmin(req.session.user.id);
    if (!canUpload) return res.status(403).json({ error: 'สิทธิ์ไม่เพียงพอ (admin หรือหัวหน้าแผนกเท่านั้น)' });
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    const { dept } = req.body;
    if (!dept) return res.status(400).json({ error: 'กรุณาระบุแผนก' });
    await pool.query(
      'INSERT INTO documents (original_name, dept, file_data, file_size, mime_type, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.file.originalname, dept, req.file.buffer, req.file.size, req.file.mimetype, req.session.user.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/documents/:id/download
app.get('/api/documents/:id/download', requireLogin, async (req, res) => {
  const r = await pool.query('SELECT original_name, file_data, mime_type FROM documents WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
  const doc = r.rows[0];
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.send(doc.file_data);
});

// DELETE /api/documents/:id
app.delete('/api/documents/:id', requireLogin, async (req, res) => {
  try {
    const canDelete = await isManagerOrAdmin(req.session.user.id);
    if (!canDelete) return res.status(403).json({ error: 'สิทธิ์ไม่เพียงพอ' });
    await pool.query('DELETE FROM documents WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ======== API WEBBOARD ========
async function initWebboard() {
  await pool.query(`CREATE TABLE IF NOT EXISTS webboard_posts (
    id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT,
    category TEXT DEFAULT 'general', user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS webboard_replies (
    id SERIAL PRIMARY KEY, post_id INTEGER REFERENCES webboard_posts(id) ON DELETE CASCADE,
    body TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
}
initWebboard().catch(console.error);

app.get('/api/webboard', requireLogin, async (req, res) => {
  const r = await pool.query(
    `SELECT p.*, u.name as author_name,
     (SELECT COUNT(*) FROM webboard_replies r WHERE r.post_id=p.id) as reply_count
     FROM webboard_posts p LEFT JOIN users u ON u.id=p.user_id
     ORDER BY p.created_at DESC LIMIT 100`
  );
  res.json(r.rows);
});
app.get('/api/webboard/:id', requireLogin, async (req, res) => {
  const post = await pool.query(
    `SELECT p.*,u.name as author_name FROM webboard_posts p LEFT JOIN users u ON u.id=p.user_id WHERE p.id=$1`, [req.params.id]
  );
  if (!post.rows.length) return res.status(404).json({ error: 'ไม่พบกระทู้' });
  const replies = await pool.query(
    `SELECT r.*,u.name as author_name FROM webboard_replies r LEFT JOIN users u ON u.id=r.user_id WHERE r.post_id=$1 ORDER BY r.created_at`, [req.params.id]
  );
  res.json({ post: post.rows[0], replies: replies.rows });
});
app.post('/api/webboard', requireLogin, async (req, res) => {
  const { title, body, category } = req.body;
  if (!title) return res.status(400).json({ error: 'กรุณากรอกหัวข้อ' });
  await pool.query(
    'INSERT INTO webboard_posts (title,body,category,user_id) VALUES ($1,$2,$3,$4)',
    [title, body||'', category||'general', req.session.user.id]
  );
  res.json({ ok: true });
});
app.post('/api/webboard/:id/reply', requireLogin, async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'กรุณากรอกข้อความ' });
  await pool.query(
    'INSERT INTO webboard_replies (post_id,body,user_id) VALUES ($1,$2,$3)',
    [req.params.id, body, req.session.user.id]
  );
  res.json({ ok: true });
});


// ======== ISMS NEWS FEED ========
const https = require('https');
const http  = require('http');

let ismsCache = { data: [], fetchedAt: 0 };

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 IntranetBot/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(raw));
    }).on('error', reject);
  });
}

function parseRSS(xml, source) {
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const block = m[1];
    const title   = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)   || [])[1] || '';
    const link    = (block.match(/<link>([\s\S]*?)<\/link>/)                                 || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)                           || [])[1] || '';
    const desc    = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || '';
    const cleanDesc = desc.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim().slice(0, 160);
    if (title && link) items.push({
      title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#\d+;/g,'').trim(),
      link: link.trim(),
      pubDate: pubDate.trim(),
      desc: cleanDesc,
      source
    });
  }
  return items;
}

async function refreshIsmsNews() {
  const feeds = [
    { url: 'https://feeds.feedburner.com/TheHackersNews', source: 'The Hacker News' },
    { url: 'https://krebsonsecurity.com/feed/', source: 'Krebs on Security' },
    { url: 'https://www.blognone.com/feed', source: 'Blognone' },
  ];
  const ismsKeywords = ['isms','iso 27001','information security','cybersecurity','data breach','ransomware','phishing','vulnerability','pdpa','ความปลอดภัย','ไซเบอร์','cyber','compliance','ข้อมูลส่วนบุคคล','malware','hacker','exploit','security','encryption','ซีเคียวริตี้'];
  let all = [];
  for (const feed of feeds) {
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseRSS(xml, feed.source);
      all = all.concat(items);
    } catch(e) { console.error('RSS fetch error:', feed.source, e.message); }
  }
  // Filter by ISMS keywords
  const filtered = all.filter(item => {
    const txt = (item.title + ' ' + item.desc).toLowerCase();
    return ismsKeywords.some(k => txt.includes(k));
  });
  // Sort by date desc, take top 8
  const sorted = filtered
    .sort((a,b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 8);
  ismsCache = { data: sorted.length ? sorted : all.slice(0,8), fetchedAt: Date.now() };
  console.log('ISMS news refreshed:', ismsCache.data.length, 'articles');
}

// Refresh on startup + every 2 hours
refreshIsmsNews().catch(console.error);
setInterval(() => refreshIsmsNews().catch(console.error), 2 * 60 * 60 * 1000);

app.get('/api/isms-news', requireLogin, (req, res) => {
  res.json({ items: ismsCache.data, fetchedAt: ismsCache.fetchedAt });
});


// ======== THAI ECONOMY NEWS ========
let thaiEconCache = { data: [], fetchedAt: 0 };
async function refreshThaiEconNews() {
  const feeds = [
    { url: 'https://feeds.bbci.co.uk/thai/rss.xml', source: 'BBC ไทย' },
    { url: 'https://www.rfa.org/thai/economy/rss2.0', source: 'RFA ไทย' },
    { url: 'https://thestandard.co/feed/', source: 'The Standard' },
  ];
  const econKeywords = ['เศรษฐกิจ','ธุรกิจ','การเงิน','ตลาด','หุ้น','ลงทุน','gdp','inflation','บาท','เงินเฟ้อ','ธนาคาร','economy','finance','trade','export','import','ส่งออก','นำเข้า','งบประมาณ','รายได้','ภาษี'];
  let all = [];
  for (const feed of feeds) {
    try { const xml = await fetchUrl(feed.url); all = all.concat(parseRSS(xml, feed.source)); }
    catch(e) { console.error('Thai econ fetch error:', feed.source, e.message); }
  }
  const filtered = all.filter(item => {
    const txt = (item.title + ' ' + item.desc).toLowerCase();
    return econKeywords.some(k => txt.includes(k));
  });
  const pool2 = (filtered.length >= 3 ? filtered : all).sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  thaiEconCache = { data: pool2.slice(0, 8), fetchedAt: Date.now() };
  console.log('Thai economy news refreshed:', thaiEconCache.data.length);
}
refreshThaiEconNews().catch(console.error);
setInterval(() => refreshThaiEconNews().catch(console.error), 2 * 60 * 60 * 1000);

app.get('/api/thai-econ-news', requireLogin, (req, res) => {
  res.json({ items: thaiEconCache.data, fetchedAt: thaiEconCache.fetchedAt });
});

// ======== THAI INDUSTRIAL NEWS ========
let thaiIndustrialCache = { data: [], fetchedAt: 0 };
async function refreshThaiIndustrialNews() {
  const feeds = [
    { url: 'https://feeds.bbci.co.uk/thai/rss.xml', source: 'BBC ไทย' },
    { url: 'https://www.rfa.org/thai/rss2.0', source: 'RFA ไทย' },
    { url: 'https://thestandard.co/feed/', source: 'The Standard' },
  ];
  const keywords = ['อุตสาหกรรม','โรงงาน','boi','การผลิต','ยานยนต์','เหล็ก','เคมี','อิเล็กทรอนิกส์','fdi','สินค้า','manufacturing','industrial','factory','automobile','ชิ้นส่วน','พลังงาน','นิคม','ลงทุน','ผลิต'];
  let all = [];
  for (const feed of feeds) {
    try { const xml = await fetchUrl(feed.url); all = all.concat(parseRSS(xml, feed.source)); }
    catch(e) { console.error('Thai industrial fetch error:', feed.source, e.message); }
  }
  const filtered = all.filter(item => {
    const txt = (item.title + ' ' + item.desc).toLowerCase();
    return keywords.some(k => txt.includes(k));
  });
  const pool2 = (filtered.length >= 2 ? filtered : all).sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  thaiIndustrialCache = { data: pool2.slice(0, 8), fetchedAt: Date.now() };
  console.log('Thai industrial news refreshed:', thaiIndustrialCache.data.length);
}
refreshThaiIndustrialNews().catch(console.error);
setInterval(() => refreshThaiIndustrialNews().catch(console.error), 2 * 60 * 60 * 1000);

app.get('/api/thai-industrial-news', requireLogin, (req, res) => {
  res.json({ items: thaiIndustrialCache.data, fetchedAt: thaiIndustrialCache.fetchedAt });
});

// ======== EXCHANGE RATES ========
let fxCache = { data: null, fetchedAt: 0 };
async function refreshFxRates() {
  try {
    const json = await fetchUrl('https://api.frankfurter.app/latest?from=THB&to=USD,EUR,JPY,CNY,SGD,GBP,AUD');
    fxCache = { data: JSON.parse(json), fetchedAt: Date.now() };
    console.log('FX rates refreshed');
  } catch(e) { console.error('FX fetch error:', e.message); }
}
refreshFxRates().catch(console.error);
setInterval(() => refreshFxRates().catch(console.error), 60 * 60 * 1000); // every 1hr

app.get('/api/fx-rates', requireLogin, (req, res) => {
  res.json(fxCache);
});



// ======== TEMP: SEED LEAVE TEST DATA ========
app.post('/api/admin/seed-leave-test', requireLogin, requireAdmin, async (req, res) => {
  try {
    // ดึงรายชื่อ user ทั้งหมด
    const usersR = await pool.query('SELECT id, name, dept FROM users ORDER BY id');
    const users  = usersR.rows;

    const today = new Date();
    const y = today.getFullYear();
    const results = [];
    let seqNo = Date.now();

    // helper: หาวันทำงาน offset จากวันนี้ (ข้ามเสาร์-อาทิตย์)
    function workday(offsetDays, h, min) {
      const d = new Date(today);
      let step = offsetDays < 0 ? -1 : 1;
      let remaining = Math.abs(offsetDays);
      while (remaining > 0) {
        d.setDate(d.getDate() + step);
        if (d.getDay() !== 0 && d.getDay() !== 6) remaining--;
      }
      d.setHours(h, min, 0, 0);
      return d.toISOString();
    }

    // กรณีทดสอบต่างๆ (แต่ละ user จะได้คนละวัน ไม่ซ้ำกัน)
    const caseTemplates = [
      { label:'ลาป่วย ครึ่งเช้า',        type:'sick',     sh:8,  sm:30, eh:12, em:0,  offsetS:-14, reason:'ไม่สบาย ครึ่งวันเช้า' },
      { label:'ลาป่วย ครึ่งบ่าย',        type:'sick',     sh:13, sm:0,  eh:17, em:40, offsetS:-13, reason:'หมอนัด บ่าย' },
      { label:'ลาป่วย 1 วันเต็ม',        type:'sick',     sh:8,  sm:30, eh:17, em:40, offsetS:-12, reason:'ไข้หวัด' },
      { label:'ลากิจ 30 นาที (ขั้นต่ำ)', type:'personal', sh:8,  sm:30, eh:9,  em:0,  offsetS:-11, reason:'ติดธุระเช้า' },
      { label:'ลากิจ 2 ชม. (10-12น.)',   type:'personal', sh:10, sm:0,  eh:12, em:0,  offsetS:-10, reason:'ธุระส่วนตัว' },
      { label:'ลากิจ ข้ามพักเที่ยง',     type:'personal', sh:11, sm:0,  eh:14, em:0,  offsetS:-9,  reason:'นัดหมอ (ข้ามพักเที่ยง)' },
      { label:'ลาพักร้อน 1 วัน',         type:'annual',   sh:8,  sm:30, eh:17, em:40, offsetS:-8,  reason:'พักผ่อน' },
      { label:'ลาพักร้อน 2 วัน',         type:'annual',   sh:8,  sm:30, eh:17, em:40, offsetS:-20, offsetE:-19, reason:'ท่องเที่ยว' },
      { label:'ลาสมรส 1 วัน',            type:'marriage', sh:8,  sm:30, eh:17, em:40, offsetS:-7,  reason:'แต่งงาน' },
      { label:'ลาตัดเงิน 1 วัน',         type:'unpaid',   sh:8,  sm:30, eh:17, em:40, offsetS:-6,  reason:'กิจส่วนตัว' },
    ];

    for (const user of users) {
      const userResults = [];

      for (let i = 0; i < caseTemplates.length; i++) {
        const c = caseTemplates[i];
        // offset ต่างกันทีละ 1 วัน ไม่ให้ซ้ำกันในคนเดียวกัน (ไม่ใช่แค่ offset แต่ใช้ workday)
        const startDT = workday(c.offsetS, c.sh, c.sm);
        const endDT   = c.offsetE !== undefined
          ? workday(c.offsetE, c.eh, c.em)
          : workday(c.offsetS, c.eh, c.em);

        const hours = calcWorkHours(startDT, endDT);
        const days  = hours / WORK_HOURS_PER_DAY;
        const leaveNo = 'TST' + (seqNo++);

        try {
          await pool.query(
            `INSERT INTO leave_requests
              (leave_no,user_id,leave_type,start_datetime,end_datetime,hours,days,reason,status,approver_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NULL)`,
            [leaveNo, user.id, c.type, startDT, endDT,
             Math.round(hours*100)/100, Math.round(days*100)/100, c.reason]
          );
          userResults.push({
            กรณี: c.label, ประเภท: c.type,
            ชั่วโมง: Math.round(hours*100)/100,
            วัน: Math.round(days*100)/100,
          });
        } catch(e) {
          userResults.push({ กรณี: c.label, error: e.message });
        }
      }

      results.push({ user: user.name, dept: user.dept, ใบลา: userResults });
    }

    res.json({
      ok: true,
      users: users.length,
      ใบลาต่อคน: caseTemplates.length,
      รวม: users.length * caseTemplates.length,
      ผลลัพธ์: results,
      การคำนวณ: {
        เวลาทำงาน: '08:30-17:40',
        พักเที่ยง: '12:00-13:00',
        ชม_ต่อวัน: Math.round(WORK_HOURS_PER_DAY*100)/100,
        ลาขั้นต่ำ: MIN_LEAVE_HOURS + ' ชม.'
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});




// ======== GET /api/admin/leave-list-excel ========
app.get('/api/admin/leave-list-excel', requireLogin, requireAdmin, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const { type, dept, status, from, to } = req.query;
    const LEAVE_LABEL = {
      annual:'ลาพักร้อน', sick:'ลาป่วย', personal:'ลากิจจำเป็น',
      personal_special:'ลากิจพิเศษ', maternity:'ลาคลอด', ordain:'ลาบวช',
      military:'ลาราชการทหาร', marriage:'ลาสมรส',
      work_injury:'ลาป่วยเนื่องจากงาน', unpaid:'ลาตัดเงิน'
    };
    const STATUS_LABEL = { pending:'รออนุมัติ', approved:'อนุมัติ', rejected:'ปฏิเสธ' };

    let sql = `SELECT lr.*, u.name as uname, u.dept, u.username,
                      a.name as approver_name
               FROM leave_requests lr
               JOIN users u ON lr.user_id = u.id
               LEFT JOIN users a ON lr.approver_id = a.id
               WHERE 1=1`;
    const params = [];
    if (type)   { params.push(type);   sql += ` AND lr.leave_type=$${params.length}`; }
    if (dept)   { params.push(dept);   sql += ` AND u.dept=$${params.length}`; }
    if (status) { params.push(status); sql += ` AND lr.status=$${params.length}`; }
    if (from)   { params.push(from);   sql += ` AND lr.start_datetime>=$${params.length}`; }
    if (to)     { params.push(to);     sql += ` AND lr.end_datetime<=$${params.length}`; }
    sql += ' ORDER BY u.dept, u.name, lr.start_datetime';

    const r = await pool.query(sql, params);
    const rows = r.rows;
    const today = new Date().toLocaleDateString('th-TH',{year:'numeric',month:'long',day:'numeric'});

    const aoa = [];
    aoa.push([`รายการใบลา — ออกรายงาน ณ ${today}`]);
    const filters = [type&&`ประเภท: ${LEAVE_LABEL[type]||type}`, dept&&`แผนก: ${dept}`,
                     status&&`สถานะ: ${STATUS_LABEL[status]||status}`,
                     from&&`ตั้งแต่: ${from}`, to&&`ถึง: ${to}`].filter(Boolean);
    if (filters.length) aoa.push(['ตัวกรอง: ' + filters.join(', ')]);
    aoa.push([]);
    aoa.push(['ลำดับ','เลขใบลา','รหัส','ชื่อ-นามสกุล','แผนก','ประเภทการลา','สถานะ',
              'วันเริ่มลา','เวลาเริ่ม','วันสิ้นสุด','เวลาสิ้นสุด','จำนวน (ชม.)','จำนวน (วัน)','เหตุผล','ผู้อนุมัติ']);

    rows.forEach((l, i) => {
      const s = new Date(l.start_datetime);
      const e = new Date(l.end_datetime);
      aoa.push([
        i+1, l.leave_no, l.username, l.uname, l.dept,
        LEAVE_LABEL[l.leave_type]||l.leave_type,
        STATUS_LABEL[l.status]||l.status,
        s.toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'}),
        s.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}),
        e.toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'}),
        e.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}),
        Math.round(parseFloat(l.hours||0)*100)/100,
        Math.round(parseFloat(l.days||0)*100)/100,
        l.reason||'', l.approver_name||'-'
      ]);
    });
    aoa.push([]);
    aoa.push([`รวมทั้งหมด ${rows.length} รายการ`]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [5,14,9,20,12,18,10,12,8,12,8,10,8,28,16].map(w=>({wch:w}));
    ws['!merges'] = [{s:{r:0,c:0},e:{r:0,c:14}}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'รายการใบลา');

    const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
    const fname = `leave_list_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ======== GET /api/admin/leave-balance-excel ========
app.get('/api/admin/leave-balance-excel', requireLogin, requireAdmin, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const WH = WORK_HOURS_PER_DAY;
    const LEAVE_LABEL = {
      annual:'ลาพักร้อน', sick:'ลาป่วย', personal:'ลากิจจำเป็น',
      personal_special:'ลากิจพิเศษ', maternity:'ลาคลอด', ordain:'ลาบวช',
      military:'ลาราชการทหาร', marriage:'ลาสมรส',
      work_injury:'ลาป่วยเนื่องจากงาน', unpaid:'ลาตัดเงิน'
    };
    const leaveOrder = ['annual','sick','personal','personal_special','maternity','ordain','military','marriage','work_injury','unpaid'];

    const usersR = await pool.query(
      'SELECT id, username, name, dept, start_date FROM users ORDER BY dept, name'
    );
    const users = usersR.rows;

    const year = new Date().getFullYear();

    // ดึง quotas ทุกปี (annual leave สะสมข้ามปีได้ ต้องรวมทุก leave_year)
    const quotasR = await pool.query(
      `SELECT user_id, leave_type, SUM(quota) as quota, SUM(used_hours) as used_hours
       FROM leave_quotas
       GROUP BY user_id, leave_type`
    );
    const quotas = quotasR.rows;

    // ดึง used hours จากใบลาจริง (pending + approved) ทุกปี เพื่อให้ตรงกับ web
    const usedR = await pool.query(
      `SELECT user_id, leave_type, SUM(hours) as total_hours
       FROM leave_requests
       WHERE status != 'rejected'
       GROUP BY user_id, leave_type`
    );
    const usedMap = {};
    usedR.rows.forEach(r => {
      if (!usedMap[r.user_id]) usedMap[r.user_id] = {};
      usedMap[r.user_id][r.leave_type] = parseFloat(r.total_hours||0);
    });

    const wb = XLSX.utils.book_new();

    // ===== Header rows =====
    const today = new Date().toLocaleDateString('th-TH', { year:'numeric', month:'long', day:'numeric' });
    const rows = [];

    rows.push([`รายงานวันลาคงเหลือ ประจำปี ${year + 543}`]);
    rows.push([`ณ วันที่ ${today}`]);
    rows.push([]);

    // Column headers
    const typeHeaders = leaveOrder.map(t => LEAVE_LABEL[t]);
    rows.push(['ลำดับ','รหัส','ชื่อ-นามสกุล','แผนก', ...typeHeaders.flatMap(h=>[h+' (โควต้า)', h+' (ใช้ไป)', h+' (คงเหลือ)'])]);

    let seq = 1;
    for (const u of users) {
      const row = [seq++, u.username, u.name, u.dept];
      for (const lt of leaveOrder) {
        const q = quotas.find(q => q.user_id===u.id && q.leave_type===lt);
        const quotaH  = q ? parseFloat(q.quota) : 0;
        const usedH   = (usedMap[u.id]||{})[lt] || 0;
        const remainH = Math.max(0, quotaH - usedH);
        row.push(
          Math.round(quotaH /WH*100)/100,
          Math.round(usedH  /WH*100)/100,
          Math.round(remainH/WH*100)/100
        );
      }
      rows.push(row);
    }

    rows.push([]);
    rows.push(['* หน่วย: วัน  |  เวลาทำงาน 8.17 ชม./วัน  |  ข้อมูล ณ วันที่ออกรายงาน']);

    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Column widths
    ws['!cols'] = [
      {wch:6},{wch:10},{wch:22},{wch:12},
      ...leaveOrder.flatMap(()=>[{wch:12},{wch:10},{wch:10}])
    ];

    // Merge title rows
    const lastCol = 3 + leaveOrder.length * 3;
    ws['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:lastCol} },
      { s:{r:1,c:0}, e:{r:1,c:lastCol} },
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'วันลาคงเหลือ');

    // ===== Sheet 2: ตารางสรุปสั้น (คงเหลืออย่างเดียว) =====
    const shortRows = [];
    shortRows.push([`สรุปวันลาคงเหลือ ปี ${year + 543}`]);
    shortRows.push([]);
    shortRows.push(['ลำดับ','รหัส','ชื่อ-นามสกุล','แผนก',
      'พักร้อน (วัน)','ลาป่วย (วัน)','ลากิจ (วัน)','รวมคงเหลือ (วัน)']);

    let seq2 = 1;
    for (const u of users) {
      const getRemain = (lt) => {
        const q = quotas.find(q => q.user_id===u.id && q.leave_type===lt);
        const quotaH = q ? parseFloat(q.quota) : 0;
        const usedH  = (usedMap[u.id]||{})[lt] || 0;
        return Math.max(0, Math.round((quotaH - usedH)/WH*100)/100);
      };
      const ann  = getRemain('annual');
      const sick = getRemain('sick');
      const pers = getRemain('personal');
      shortRows.push([seq2++, u.username, u.name, u.dept, ann, sick, pers, ann+sick+pers]);
    }
    shortRows.push([]);
    shortRows.push(['* หน่วย: วัน (1 วัน = 8.17 ชม.)']);

    const ws2 = XLSX.utils.aoa_to_sheet(shortRows);
    ws2['!cols'] = [{wch:6},{wch:10},{wch:22},{wch:12},{wch:14},{wch:14},{wch:12},{wch:16}];
    ws2['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:7} }];
    XLSX.utils.book_append_sheet(wb, ws2, 'สรุปสั้น');

    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    const filename = `leave_balance_${year}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ======== GET /api/admin/leave-report-excel ========
app.get('/api/admin/leave-report-excel', requireLogin, requireAdmin, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const WH = WORK_HOURS_PER_DAY;

    // ดึงข้อมูลทั้งหมด
    const usersR = await pool.query(
      'SELECT id, username, name, dept FROM users ORDER BY dept, name'
    );
    const users = usersR.rows;

    const leavesR = await pool.query(
      `SELECT lr.*, u.name as uname, u.dept
       FROM leave_requests lr
       JOIN users u ON lr.user_id = u.id
       ORDER BY u.dept, u.name, lr.start_datetime`
    );
    const leaves = leavesR.rows;

    const quotasR = await pool.query(
      `SELECT * FROM leave_quotas ORDER BY user_id, leave_year, leave_type`
    );
    const quotas = quotasR.rows;

    const LEAVE_LABEL = {
      sick:'ลาป่วย', annual:'ลาพักร้อน', personal:'ลากิจจำเป็น',
      personal_special:'ลากิจพิเศษ', maternity:'ลาคลอด', ordain:'ลาบวช',
      military:'ลาราชการทหาร', marriage:'ลาสมรส',
      work_injury:'ลาป่วยเนื่องจากงาน', unpaid:'ลาตัดเงิน'
    };
    const STATUS_LABEL = { pending:'รออนุมัติ', approved:'อนุมัติ', rejected:'ปฏิเสธ' };

    const wb = XLSX.utils.book_new();

    // ===== SHEET 1: สรุปรายบุคคล =====
    const summaryRows = [];
    summaryRows.push([
      'รหัสพนักงาน','ชื่อ-นามสกุล','แผนก','ประเภทการลา',
      'โควต้า (วัน)','โควต้า (ชม.)',
      'ใช้ไป (วัน)','ใช้ไป (ชม.)',
      'คงเหลือ (วัน)','คงเหลือ (ชม.)',
      'จำนวนใบลา'
    ]);

    for (const u of users) {
      const uLeaves = leaves.filter(l => l.user_id === u.id && l.status !== 'rejected');
      const uQuotas = quotas.filter(q => q.user_id === u.id);
      const leaveTypes = [...new Set(uLeaves.map(l => l.leave_type))];

      if (leaveTypes.length === 0) {
        summaryRows.push([u.username, u.name, u.dept, '-', 0,0,0,0,0,0,0]);
        continue;
      }

      for (const lt of leaveTypes) {
        const typeLeaves = uLeaves.filter(l => l.leave_type === lt);
        const usedHours = typeLeaves.reduce((s,l) => s + parseFloat(l.hours||0), 0);
        const q = uQuotas.find(q => q.leave_type === lt);
        const quotaH = q ? parseFloat(q.quota) : 0;
        const remainH = Math.max(0, quotaH - usedHours);

        summaryRows.push([
          u.username, u.name, u.dept,
          LEAVE_LABEL[lt] || lt,
          Math.round(quotaH/WH*100)/100,
          Math.round(quotaH*100)/100,
          Math.round(usedHours/WH*100)/100,
          Math.round(usedHours*100)/100,
          Math.round(remainH/WH*100)/100,
          Math.round(remainH*100)/100,
          typeLeaves.length
        ]);
      }
    }

    const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
    ws1['!cols'] = [9,20,12,18,12,12,12,12,12,12,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws1, 'สรุปรายบุคคล');

    // ===== SHEET 2: รายละเอียดใบลา =====
    const detailRows = [];
    detailRows.push([
      'รหัสพนักงาน','ชื่อ-นามสกุล','แผนก','เลขใบลา','ประเภท','สถานะ',
      'วันเริ่มลา','เวลาเริ่ม','วันสิ้นสุด','เวลาสิ้นสุด',
      'จำนวน (ชม.)','จำนวน (วัน)','เหตุผล'
    ]);

    const userMap = {};
    users.forEach(u => userMap[u.id] = u);

    for (const l of leaves) {
      const u = userMap[l.user_id] || {};
      const s = new Date(l.start_datetime);
      const e = new Date(l.end_datetime);
      detailRows.push([
        u.username||'', l.uname, l.dept,
        l.leave_no,
        LEAVE_LABEL[l.leave_type] || l.leave_type,
        STATUS_LABEL[l.status] || l.status,
        s.toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'}),
        s.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}),
        e.toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'}),
        e.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'}),
        Math.round(parseFloat(l.hours||0)*100)/100,
        Math.round(parseFloat(l.days||0)*100)/100,
        l.reason||''
      ]);
    }

    const ws2 = XLSX.utils.aoa_to_sheet(detailRows);
    ws2['!cols'] = [9,20,12,14,18,10,12,8,12,8,10,8,30].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws2, 'รายละเอียดใบลา');

    // ===== SHEET 3: เปรียบเทียบก่อน-หลัง (จำลอง) =====
    const compareRows = [];
    compareRows.push([
      'ชื่อ-นามสกุล','แผนก','ประเภทการลา',
      'โควต้าเริ่มต้น (วัน)','ใช้ไปทั้งหมด (วัน)','คงเหลือ (วัน)',
      '% ที่ใช้ไป'
    ]);

    for (const u of users) {
      const uLeaves = leaves.filter(l => l.user_id===u.id && l.status!=='rejected');
      const uQuotas = quotas.filter(q => q.user_id===u.id);
      const allTypes = [...new Set([...uQuotas.map(q=>q.leave_type),...uLeaves.map(l=>l.leave_type)])];

      for (const lt of allTypes) {
        const q = uQuotas.find(q=>q.leave_type===lt);
        const usedH = uLeaves.filter(l=>l.leave_type===lt).reduce((s,l)=>s+parseFloat(l.hours||0),0);
        const quotaH = q ? parseFloat(q.quota) : 0;
        const remainH = Math.max(0, quotaH - usedH);
        const pct = quotaH > 0 ? Math.round(usedH/quotaH*1000)/10 : 0;

        compareRows.push([
          u.name, u.dept, LEAVE_LABEL[lt]||lt,
          Math.round(quotaH/WH*100)/100,
          Math.round(usedH/WH*100)/100,
          Math.round(remainH/WH*100)/100,
          pct + '%'
        ]);
      }
    }

    const ws3 = XLSX.utils.aoa_to_sheet(compareRows);
    ws3['!cols'] = [20,12,18,16,16,14,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws3, 'ก่อน-หลังการลา');

    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    const filename = `leave_report_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ======== TEMP: RESET DATA (admin only) ========
app.post('/api/admin/reset-bookings', requireLogin, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings');
    res.json({ ok: true, message: 'ล้างข้อมูลการจองห้องประชุมทั้งหมดสำเร็จ' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-data', requireLogin, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM leave_requests');
    await pool.query('DELETE FROM leave_quotas');
    await pool.query('DELETE FROM annual_leave_log');
    await pool.query('DELETE FROM users WHERE username != $1', ['admin']);
    res.json({ ok: true, message: 'ล้างข้อมูลสำเร็จ: ลบพนักงานทั้งหมด (ยกเว้น admin) + ข้อมูลการลาทั้งหมด' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Intranet running on port', PORT));
