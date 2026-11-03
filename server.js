// Today's Reflection - backend. Không cần cài thư viện ngoài: chỉ Node >= 22.5 (có node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const DATABASE_URL = process.env.DATABASE_URL || '';
const PORT = process.env.PORT || 3000;
// index.html nằm ngay cạnh server.js; nếu có thư mục public/ thì ưu tiên thư mục đó.
const PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const STATIC_OK = new Set(['index.html']); // chỉ phục vụ file giao diện, không lộ server.js / data.db
const SESSION_MS = 30 * 24 * 3600 * 1000;

// Adapter CSDL bất đồng bộ: get / all / run (câu lệnh dùng placeholder ?)
let DB = null, DB_LABEL = '';
async function initDb() {
  if (DATABASE_URL) {                       // PostgreSQL do nền tảng cấp
    const { Pool } = require('pg');
    const ssl = /sslmode=disable|localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: DATABASE_URL, ssl });
    const q = (sql, p) => { let n = 0; return pool.query(sql.replace(/\?/g, () => '$' + (++n)), p); };
    DB = {
      get: async (sql, p = []) => (await q(sql, p)).rows[0],
      all: async (sql, p = []) => (await q(sql, p)).rows,
      run: async (sql, p = []) => {
        const ret = /^\s*INSERT INTO (users|moods|journals|habits)\b/i.test(sql);
        const r = await q(ret ? sql + ' RETURNING id' : sql, p);
        return { lastId: ret ? r.rows[0].id : null };
      }
    };
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8'));
    DB_LABEL = 'PostgreSQL (DATABASE_URL)';
  } else {                                  // SQLite (file)
    let Sqlite;
    try { ({ DatabaseSync: Sqlite } = require('node:sqlite')); } catch (e) { Sqlite = require('better-sqlite3'); }
    let file = process.env.DB_FILE || path.join(__dirname, 'data.db');
    if (!process.env.DB_FILE) { try { fs.accessSync(__dirname, fs.constants.W_OK); } catch (e) { file = path.join(os.tmpdir(), 'data.db'); } }
    const sq = new Sqlite(file);
    sq.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    DB = {
      get: async (sql, p = []) => sq.prepare(sql).get(...p),
      all: async (sql, p = []) => sq.prepare(sql).all(...p),
      run: async (sql, p = []) => ({ lastId: Number(sq.prepare(sql).run(...p).lastInsertRowid) })
    };
    DB_LABEL = 'SQLite (' + file + ')';
  }
}

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

async function userFrom(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const row = await DB.get('SELECT user_id, expires_at FROM sessions WHERE token=?', [m[1]]);
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) { await DB.run('DELETE FROM sessions WHERE token=?', [m[1]]); return null; }
  return { id: row.user_id, token: m[1] };
}
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await DB.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', [token, userId, Date.now() + SESSION_MS]);
  return token;
}

// ---------- data access ----------
async function getHabits(uid) {
  const hs = await DB.all('SELECT id,name FROM habits WHERE user_id=? ORDER BY id', [uid]);
  const logs = await DB.all('SELECT l.habit_id, l.date FROM habit_logs l JOIN habits h ON h.id=l.habit_id WHERE h.user_id=? ORDER BY l.date', [uid]);
  return hs.map(h => ({ id: h.id, name: h.name, done: logs.filter(l => l.habit_id === h.id).map(l => l.date) }));
}
const getMoods = uid => DB.all('SELECT id,date,mood,note FROM moods WHERE user_id=? ORDER BY id', [uid]);
const getJournals = uid => DB.all('SELECT id,title,content,mood,date,updated FROM journals WHERE user_id=? ORDER BY id', [uid]);
const bootstrap = async uid => ({ moods: await getMoods(uid), journals: await getJournals(uid), habits: await getHabits(uid) });
const DEFAULT_HABITS = ['Uống đủ nước', 'Vận động 15 phút', 'Đọc sách 10 phút', 'Viết vài dòng nhật ký'];

// ---------- API ----------
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};

  if (route === 'POST /api/register') {
    const username = str(body.username, 40), password = String(body.password || '');
    if (!/^[\w.\-]{3,40}$/.test(username)) return send(res, 400, { error: 'Tên đăng nhập 3-40 ký tự (chữ, số, . _ -).' });
    if (password.length < 6) return send(res, 400, { error: 'Mật khẩu tối thiểu 6 ký tự.' });
    if (await DB.get('SELECT 1 AS x FROM users WHERE lower(username)=lower(?)', [username])) return send(res, 409, { error: 'Tên đăng nhập đã tồn tại.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const { lastId: uid } = await DB.run('INSERT INTO users(username,password_hash,salt) VALUES(?,?,?)', [username, hash(password, salt), salt]);
    for (const n of DEFAULT_HABITS) await DB.run('INSERT INTO habits(user_id,name) VALUES(?,?)', [uid, n]);
    return send(res, 201, { token: await newSession(uid), username });
  }
  if (route === 'GET /api/health') {
    const c = async t => Number((await DB.get('SELECT COUNT(*) AS n FROM ' + t)).n);
    return send(res, 200, { status: 'ok', database: DATABASE_URL ? 'postgresql' : 'sqlite',
      rows: { users: await c('users'), moods: await c('moods'), journals: await c('journals'), habits: await c('habits') } });
  }
  if (route === 'POST /api/guest') {
    const username = 'khach_' + crypto.randomBytes(4).toString('hex'), salt = crypto.randomBytes(16).toString('hex');
    const { lastId: uid } = await DB.run('INSERT INTO users(username,password_hash,salt) VALUES(?,?,?)',
      [username, hash(crypto.randomBytes(16).toString('hex'), salt), salt]);
    for (const n of DEFAULT_HABITS) await DB.run('INSERT INTO habits(user_id,name) VALUES(?,?)', [uid, n]);
    return send(res, 201, { token: await newSession(uid), username });
  }
  if (route === 'POST /api/login') {
    const u = await DB.get('SELECT * FROM users WHERE lower(username)=lower(?)', [str(body.username, 40)]);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hash(String(body.password || ''), u.salt), 'hex'), Buffer.from(u.password_hash, 'hex'));
    if (!ok) return send(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
    return send(res, 200, { token: await newSession(u.id), username: u.username });
  }

  const user = await userFrom(req);
  if (!user) return send(res, 401, { error: 'Chưa đăng nhập.' });
  const uid = user.id;
  let m;

  if (route === 'POST /api/logout') { await DB.run('DELETE FROM sessions WHERE token=?', [user.token]); return send(res, 200, { ok: true }); }
  if (route === 'GET /api/me') {
    const u = await DB.get('SELECT username FROM users WHERE id=?', [uid]);
    return send(res, 200, { username: u.username, ...(await bootstrap(uid)) });
  }

  if (route === 'POST /api/moods') {
    const mood = str(body.mood, 30), date = str(body.date, 10);
    if (!mood || !validDate(date)) return send(res, 400, { error: 'Dữ liệu không hợp lệ.' });
    await DB.run('INSERT INTO moods(user_id,date,mood,note) VALUES(?,?,?,?)', [uid, date, mood, str(body.note, 2000)]);
    return send(res, 201, { moods: await getMoods(uid) });
  }
  if ((m = /^\/api\/moods\/(\d+)$/.exec(url.pathname))) {
    const id = +m[1];
    if (req.method === 'PUT') {
      const mood = str(body.mood, 30);
      if (!mood) return send(res, 400, { error: 'Dữ liệu không hợp lệ.' });
      await DB.run('UPDATE moods SET mood=?,note=? WHERE id=? AND user_id=?', [mood, str(body.note, 2000), id, uid]);
      return send(res, 200, { moods: await getMoods(uid) });
    }
    if (req.method === 'DELETE') {
      await DB.run('DELETE FROM moods WHERE id=? AND user_id=?', [id, uid]);
      return send(res, 200, { moods: await getMoods(uid) });
    }
  }

  if (route === 'POST /api/journals') {
    const content = str(body.content, 20000), date = str(body.date, 10);
    if (!content || !validDate(date)) return send(res, 400, { error: 'Dữ liệu không hợp lệ.' });
    await DB.run('INSERT INTO journals(user_id,title,content,mood,date) VALUES(?,?,?,?,?)',
      [uid, str(body.title, 200) || 'Một trang nhật ký của tôi', content, str(body.mood, 30) || 'Bình yên', date]);
    return send(res, 201, { journals: await getJournals(uid) });
  }
  if ((m = /^\/api\/journals\/(\d+)$/.exec(url.pathname))) {
    const id = +m[1];
    if (req.method === 'PUT') {
      const content = str(body.content, 20000), date = str(body.date, 10);
      if (!content || !validDate(date)) return send(res, 400, { error: 'Dữ liệu không hợp lệ.' });
      await DB.run('UPDATE journals SET title=?,content=?,mood=?,updated=? WHERE id=? AND user_id=?',
        [str(body.title, 200) || 'Một trang nhật ký của tôi', content, str(body.mood, 30) || 'Bình yên', date, id, uid]);
      return send(res, 200, { journals: await getJournals(uid) });
    }
    if (req.method === 'DELETE') {
      await DB.run('DELETE FROM journals WHERE id=? AND user_id=?', [id, uid]);
      return send(res, 200, { journals: await getJournals(uid) });
    }
  }

  if (route === 'POST /api/habits') {
    const name = str(body.name, 100);
    if (!name) return send(res, 400, { error: 'Thiếu tên thói quen.' });
    await DB.run('INSERT INTO habits(user_id,name) VALUES(?,?)', [uid, name]);
    return send(res, 201, { habits: await getHabits(uid) });
  }
  if ((m = /^\/api\/habits\/(\d+)$/.exec(url.pathname))) {
    const id = +m[1];
    if (req.method === 'PUT') {
      const name = str(body.name, 100);
      if (!name) return send(res, 400, { error: 'Thiếu tên thói quen.' });
      await DB.run('UPDATE habits SET name=? WHERE id=? AND user_id=?', [name, id, uid]);
      return send(res, 200, { habits: await getHabits(uid) });
    }
    if (req.method === 'DELETE') {
      await DB.run('DELETE FROM habits WHERE id=? AND user_id=?', [id, uid]);
      return send(res, 200, { habits: await getHabits(uid) });
    }
  }
  if ((m = /^\/api\/habits\/(\d+)\/log$/.exec(url.pathname)) && req.method === 'PUT') {
    const id = +m[1], date = str(body.date, 10);
    if (!validDate(date)) return send(res, 400, { error: 'Ngày không hợp lệ.' });
    if (!(await DB.get('SELECT 1 AS x FROM habits WHERE id=? AND user_id=?', [id, uid]))) return send(res, 404, { error: 'Không tìm thấy.' });
    if (body.done) await DB.run('INSERT INTO habit_logs(habit_id,date) VALUES(?,?) ON CONFLICT DO NOTHING', [id, date]);
    else await DB.run('DELETE FROM habit_logs WHERE habit_id=? AND date=?', [id, date]);
    return send(res, 200, { habits: await getHabits(uid) });
  }

  if (route === 'DELETE /api/data') {
    await DB.run('DELETE FROM moods WHERE user_id=?', [uid]);
    await DB.run('DELETE FROM journals WHERE user_id=?', [uid]);
    await DB.run('DELETE FROM habits WHERE user_id=?', [uid]);
    return send(res, 200, await bootstrap(uid));
  }
  send(res, 404, { error: 'Không tìm thấy endpoint.' });
}

// ---------- static + server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if ((PUBLIC === __dirname && !STATIC_OK.has(rel)) || !file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Lỗi máy chủ.' });
  }
});
initDb().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`Today's Reflection chạy tại cổng ${PORT} | DB: ${DB_LABEL}`)))
  .catch(e => { console.error('Không khởi tạo được CSDL:', e); process.exit(1); });
