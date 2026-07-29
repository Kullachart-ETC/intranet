const I18N_DICT = {
  // shared nav-home icon tooltip is left untranslated (icon-only, low priority)

  // index.html SPA nav (emoji-prefixed buttons)
  'idx.board':       {th:'📢 ประชาสัมพันธ์',       en:'📢 Announcements'},
  'idx.calendar':    {th:'📅 ปฏิทินงาน',           en:'📅 Calendar'},
  'idx.documents':   {th:'📁 คลังเอกสาร',          en:'📁 Documents'},
  'idx.about':       {th:'🏢 เกี่ยวกับเรา',         en:'🏢 About Us'},
  'idx.orgchart':    {th:'🗂️ โครงสร้างองค์กร',     en:'🗂️ Org Chart'},
  'idx.webboard':    {th:'💬 เว็บบอร์ด',            en:'💬 Webboard'},
  'idx.regulations': {th:'📜 ระเบียบบริษัท',        en:'📜 Regulations'},
  'idx.leavereport': {th:'📊 รายงานการลา',          en:'📊 Leave Report'},

  // plain nav links used by the other static pages
  'nav.documents':   {th:'คลังเอกสาร',             en:'Documents'},
  'nav.about':       {th:'เกี่ยวกับเรา',            en:'About Us'},
  'nav.orgchart':    {th:'โครงสร้างองค์กร',        en:'Org Chart'},
  'nav.news':        {th:'ข่าวสารกิจกรรม',         en:'News'},
  'nav.webboard':    {th:'เว็บบอร์ด',               en:'Webboard'},
  'nav.regulations': {th:'ระเบียบบริษัท',           en:'Regulations'},
  'nav.forms':       {th:'แบบฟอร์ม - ARS',          en:'EARTH Forms'},
  'nav.leavereport': {th:'รายงานการลา',             en:'Leave Report'},

  'nav.logout':      {th:'ออกจากระบบ',             en:'Logout'},

  // primary buttons
  'btn.newpost':        {th:'+ โพสต์ใหม่',              en:'+ New Post'},
  'btn.newevent':       {th:'+ เพิ่มกิจกรรม',           en:'+ Add Event'},
  'btn.applyleave':     {th:'+ ยื่นใบลา',               en:'+ Apply Leave'},
  'btn.submitleave':    {th:'📤 ยื่นใบลา',              en:'📤 Submit Leave'},
  'btn.bookroom':       {th:'✓ จองห้อง',               en:'✓ Book Room'},
  'btn.bookcar':        {th:'✓ จองรถ',                 en:'✓ Book Car'},
  'btn.uploademployee': {th:'⬆️ อัปโหลดและ Import',     en:'⬆️ Upload & Import'},
  'btn.login':          {th:'เข้าสู่ระบบ',              en:'Login'},

  // page titles
  'h1.leave':           {th:'📋 ระบบลาหยุด',            en:'📋 Leave System'},
  'h1.meetingroom':     {th:'จองห้องประชุม',            en:'Book Meeting Room'},
  'h1.carbooking':      {th:'จองรถ',                    en:'Book Car'},
  'h1.uploademployee':  {th:'🏢 Upload พนักงานเข้าระบบ', en:'🏢 Upload Employees'},

  // login page
  'lbl.username': {th:'ชื่อผู้ใช้งาน',   en:'Username'},
  'lbl.password': {th:'รหัสผ่าน',        en:'Password'},
  'ph.username':  {th:'กรอก Username',  en:'Enter Username'},
  'ph.password':  {th:'กรอก Password',  en:'Enter Password'},

  // index.html quick-links tiles
  'ql.leave':       {th:'ใบลาออนไลน์',     en:'Online Leave'},
  'ql.meeting':     {th:'จองห้องประชุม',   en:'Book Meeting Room'},
  'ql.car':         {th:'จองรถ',           en:'Book Car'},
  'ql.forms':       {th:'แบบฟอร์ม EARTH',  en:'EARTH Forms'},
  'ql.webboard':    {th:'เว็บบอร์ด',        en:'Webboard'},
  'ql.regulations': {th:'ระเบียบบริษัท',    en:'Regulations'}
};

function applyI18N(){
  const lang = localStorage.getItem('siteLang') || 'th';
  document.documentElement.lang = lang === 'en' ? 'en' : 'th';
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const e = I18N_DICT[el.getAttribute('data-i18n')];
    if(e) el.textContent = e[lang] || e.th;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{
    const e = I18N_DICT[el.getAttribute('data-i18n-placeholder')];
    if(e) el.placeholder = e[lang] || e.th;
  });
  document.querySelectorAll('#lang-toggle').forEach(btn=>{
    btn.textContent = lang === 'en' ? 'ไทย' : 'EN';
  });
}
function toggleLang(){
  const next = (localStorage.getItem('siteLang') || 'th') === 'en' ? 'th' : 'en';
  localStorage.setItem('siteLang', next);
  applyI18N();
}
document.addEventListener('DOMContentLoaded', applyI18N);
