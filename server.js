// Today's Reflection - backend. Không cần cài thư viện ngoài: chỉ Node >= 22.5 (có node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db');
const PUBLIC = path.join(__dirname, 'public');
const SESSION_MS = 30 * 24 * 3600 * 1000;

const db = new DatabaseSync(DB_FILE);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ---------- helpers ----------
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise((ok, fail) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) { fail(new Error('too big')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
});
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);

function userFrom(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token=?').get(m[1]);
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]); return null; }
  return { id: row.user_id, token: m[1] };
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, userId, Date.now() + SESSION_MS);
  return token;
}

// ---------- data access ----------
const getHabits = uid => db.prepare('SELECT id,name FROM habits WHERE user_id=? ORDER BY id').all(uid).map(h => ({
  ...h,
  done: db.prepare('SELECT date FROM habit_logs WHERE habit_id=? ORDER BY date').all(h.id).map(r => r.date)
}));
const getMoods = uid => db.prepare('SELECT id,date,mood,note FROM moods WHERE user_id=? ORDER BY id').all(uid);
const getJournals = uid => db.prepare('SELECT id,title,content,mood,date,updated FROM journals WHERE user_id=? ORDER BY id').all(uid);
const bootstrap = uid => ({ moods: getMoods(uid), journals: getJournals(uid), habits: getHabits(uid) });
const DEFAULT_HABITS = ['Uống đủ nước', 'Vận động 15 phút', 'Đọc sách 10 phút', 'Viết vài dòng nhật ký'];

// ---------- API ----------
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

  if (route === 'POST /api/register') {
    const username = str(body.username, 40), password = String(body.password || '');
    if (!/^[\w.\-]{3,40}$/.test(username)) return send(res, 400, { error: 'Tên đăng nhập 3-40 ký tự (chữ, số, . _ -).' });
    if (password.length < 6) return send(res, 400, { error: 'Mật khẩu tối thiểu 6 ký tự.' });
    if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return send(res, 409, { error: 'Tên đăng nhập đã tồn tại.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const { lastInsertRowid: uid } = db.prepare('INSERT INTO users(username,password_hash,salt) VALUES(?,?,?)').run(username, hash(password, salt), salt);
    const ins = db.prepare('INSERT INTO habits(user_id,name) VALUES(?,?)');
    DEFAULT_HABITS.forEach(n => ins.run(uid, n));
    return send(res, 201, { token: newSession(uid), username });
  }
  if (route === 'POST /api/login') {
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(str(body.username, 40));
    const ok = u && crypto.timingSafeEqual(Buffer.from(hash(String(body.password || ''), u.salt), 'hex'), Buffer.from(u.password_hash, 'hex'));
    if (!ok) return send(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
    return send(res, 200, { token: newSession(u.id), username: u.username });
  }

  const user = userFrom(req);
  if (!user) return send(res, 401, { error: 'Chưa đăng nhập.' });
  const uid = user.id;
  let m;

  if (route === 'POST /api/logout') { db.prepare('DELETE FROM sessions WHERE token=?').run(user.token); return send(res, 200, { ok: true }); }
  if (route === 'GET /api/me') {
    const u = db.prepare('SELECT username FROM users WHERE id=?').get(uid);
    return send(res, 200, { username: u.username, ...bootstrap(uid) });
  }

  if (route === 'POST /api/moods') {
    const mood = str(body.mood, 30), date = str(body.date, 10);
    if (!mood || !validDate(date)) return send(res, 400, { error: 'Dữ liệu không hợp lệ.' });
    db.prepare('INSERT INTO moods(user_id,date,mood,note) VALUES(?,?,?,?)').run(uid, date, mood, str(body.note, 2000));
    return send(res, 201, { moods: getMoods(uid) });
  }

  if (route === 'POST /api/journals') {
    const content = str(body.content, 20000), date = str(body.date, 10);
    if (!content || !validDate(date)) return send(res, 400, { error: 'Dữ liệu không hợp lệ.' });
    db.prepare('INSERT INTO journals(user_id,title,content,mood,date) VALUES(?,?,?,?,?)')
      .run(uid, str(body.title, 200) || 'Một trang nhật ký của tôi', content, str(body.mood, 30) || 'Bình yên', date);
    return send(res, 201, { journals: getJournals(uid) });
  }
  if ((m = /^\/api\/journals\/(\d+)$/.exec(url.pathname))) {
    const id = +m[1];
    if (req.method === 'PUT') {
      const content = str(body.content, 20000), date = str(body.date, 10);
      if (!content || !validDate(date)) return send(res, 400, { error: 'Dữ liệu không hợp lệ.' });
      db.prepare('UPDATE journals SET title=?,content=?,mood=?,updated=? WHERE id=? AND user_id=?')
        .run(str(body.title, 200) || 'Một trang nhật ký của tôi', content, str(body.mood, 30) || 'Bình yên', date, id, uid);
      return send(res, 200, { journals: getJournals(uid) });
    }
    if (req.method === 'DELETE') {
      db.prepare('DELETE FROM journals WHERE id=? AND user_id=?').run(id, uid);
      return send(res, 200, { journals: getJournals(uid) });
    }
  }

  if (route === 'POST /api/habits') {
    const name = str(body.name, 100);
    if (!name) return send(res, 400, { error: 'Thiếu tên thói quen.' });
    db.prepare('INSERT INTO habits(user_id,name) VALUES(?,?)').run(uid, name);
    return send(res, 201, { habits: getHabits(uid) });
  }
  if ((m = /^\/api\/habits\/(\d+)$/.exec(url.pathname)) && req.method === 'DELETE') {
    db.prepare('DELETE FROM habits WHERE id=? AND user_id=?').run(+m[1], uid);
    return send(res, 200, { habits: getHabits(uid) });
  }
  if ((m = /^\/api\/habits\/(\d+)\/log$/.exec(url.pathname)) && req.method === 'PUT') {
    const date = str(body.date, 10);
    if (!validDate(date)) return send(res, 400, { error: 'Ngày không hợp lệ.' });
    if (!db.prepare('SELECT 1 FROM habits WHERE id=? AND user_id=?').get(+m[1], uid)) return send(res, 404, { error: 'Không tìm thấy.' });
    if (body.done) db.prepare('INSERT OR IGNORE INTO habit_logs(habit_id,date) VALUES(?,?)').run(+m[1], date);
    else db.prepare('DELETE FROM habit_logs WHERE habit_id=? AND date=?').run(+m[1], date);
    return send(res, 200, { habits: getHabits(uid) });
  }

  if (route === 'DELETE /api/data') {
    db.prepare('DELETE FROM moods WHERE user_id=?').run(uid);
    db.prepare('DELETE FROM journals WHERE user_id=?').run(uid);
    db.prepare('DELETE FROM habits WHERE user_id=?').run(uid);
    return send(res, 200, bootstrap(uid));
  }
  send(res, 404, { error: 'Không tìm thấy endpoint.' });
}

// ---------- static + server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Lỗi máy chủ.' });
  }
}).listen(PORT, () => console.log(`Today's Reflection chạy tại http://localhost:${PORT} (DB: ${DB_FILE})`));
