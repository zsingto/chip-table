// โต๊ะชิปดีลเลอร์ — เซิร์ฟเวอร์ห้อง (Node.js 18+, ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
// รัน: node server.js   แล้วเปิด http://localhost:3000
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'rooms.json');
const PUBLIC = path.join(__dirname, 'public');
const ROOM_TTL = 24 * 60 * 60 * 1000; // ห้องที่ไม่มีใครใช้เกิน 24 ชม. จะถูกลบ
const MAX_PLAYERS = 12;

/* ---------- storage ---------- */
let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) { rooms = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(rooms), () => {});
  }, 500);
}
setInterval(() => {
  const now = Date.now();
  for (const c of Object.keys(rooms)) if (now - rooms[c].touched > ROOM_TTL && !(streams[c] && streams[c].size)) delete rooms[c];
  persist();
}, 60 * 60 * 1000);

/* ---------- helpers ---------- */
const token = () => crypto.randomBytes(16).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (rooms[c]);
  return c;
}
const int = (v, d = 0) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : d; };
const clean = (s, d) => (String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20)) || d;
const fmt = n => Number(n).toLocaleString('en-US');

function publicState(r) {
  return {
    code: r.code, hand: r.hand, dealer: r.dealer, start: r.start, log: r.log.slice(0, 15), canUndo: r.hist.length > 0,
    players: r.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, bet: p.bet, folded: p.folded, remote: !!p.key })),
  };
}
function snap(r) { r.hist.push(JSON.stringify({ players: r.players, hand: r.hand, dealer: r.dealer, log: r.log })); if (r.hist.length > 40) r.hist.shift(); }
const P = (r, id) => r.players.find(p => p.id === id);
const maxBet = r => Math.max(0, ...r.players.map(p => p.bet));
function addLog(r, m) { r.log.unshift(m); r.log = r.log.slice(0, 40); }

function buildPots(r) {
  const levels = [...new Set(r.players.map(p => p.bet).filter(b => b > 0))].sort((a, b) => a - b);
  const pots = []; let prev = 0;
  for (const L of levels) {
    let amt = 0; for (const p of r.players) amt += Math.min(p.bet, L) - Math.min(p.bet, prev);
    const el = r.players.filter(p => !p.folded && p.bet >= L).map(p => p.id);
    const last = pots[pots.length - 1];
    if (!el.length && last) last.amount += amt;
    else if (last && last.el.join() === el.join()) last.amount += amt;
    else pots.push({ amount: amt, el });
    prev = L;
  }
  return pots;
}

/* chip action on one player; returns message or '' */
function chipAction(r, p, type, amount) {
  const put = n => { n = Math.min(Math.max(0, int(n)), p.chips); if (n <= 0) return 0; p.chips -= n; p.bet += n; return n; };
  if (type === 'fold') { if (p.folded) return ''; p.folded = true; return p.name + ' หมอบ'; }
  if (type === 'unfold') { if (!p.folded) return ''; p.folded = false; return p.name + ' กลับเข้าเล่น'; }
  if (p.folded) return '';
  if (type === 'bet') { const n = put(amount); return n ? p.name + ' ลง ' + fmt(n) : ''; }
  if (type === 'call') { const need = maxBet(r) - p.bet; if (need <= 0) return p.name + ' เช็ค'; const n = put(need); return p.name + (n < need ? ' ตามด้วย All-in ' : ' ตาม ') + fmt(n); }
  if (type === 'allin') { const n = put(p.chips); return n ? p.name + ' All-in ' + fmt(n) : ''; }
  return '';
}

/* ---------- actions ---------- */
const CHIP_TYPES = ['bet', 'call', 'allin', 'fold', 'unfold'];
function act(r, body) {
  const isHost = body.key === r.hostKey;
  const self = r.players.find(p => p.key && p.key === body.key);
  if (!isHost && !self) return { error: 'ไม่มีสิทธิ์ในห้องนี้', status: 403 };
  const type = String(body.type || '');

  if (CHIP_TYPES.includes(type)) {
    const p = isHost ? P(r, String(body.pid || '')) : self;
    if (!p) return { error: 'ไม่พบผู้เล่น', status: 400 };
    if (!isHost && int(body.hand, r.hand) !== r.hand) return { error: 'ตานี้จบไปแล้ว', status: 409 };
    snap(r);
    const msg = chipAction(r, p, type, body.amount);
    if (!msg) { r.hist.pop(); return { ok: true, msg: '' }; }
    if (type === 'fold' || type === 'allin') addLog(r, 'ตาที่ ' + r.hand + ': ' + msg);
    return { ok: true, msg };
  }

  if (!isHost) return { error: 'เฉพาะดีลเลอร์', status: 403 };

  switch (type) {
    case 'pay': {
      const pots = buildPots(r); const wins = Array.isArray(body.wins) ? body.wins : [];
      if (!pots.length) return { error: 'ไม่มีชิปในกอง', status: 400 };
      if (wins.length !== pots.length) return { error: 'กองชิปเปลี่ยนไปแล้ว เปิดหน้าจ่ายใหม่', status: 409 };
      const got = {};
      for (let i = 0; i < pots.length; i++) {
        const allowed = pots[i].el.length ? pots[i].el : r.players.map(p => p.id);
        const w = r.players.map(p => p.id).filter(id => Array.isArray(wins[i]) && wins[i].includes(id) && allowed.includes(id));
        if (!w.length) return { error: 'เลือกผู้ชนะให้ครบทุกกอง', status: 400 };
        const s = Math.floor(pots[i].amount / w.length); let rem = pots[i].amount - s * w.length;
        for (const id of w) { const g = s + (rem > 0 ? 1 : 0); if (rem > 0) rem--; got[id] = (got[id] || 0) + g; }
      }
      snap(r);
      for (const [id, g] of Object.entries(got)) P(r, id).chips += g;
      const msg = Object.entries(got).map(([id, g]) => P(r, id).name + ' +' + fmt(g)).join(', ');
      addLog(r, 'ตาที่ ' + r.hand + ': ' + msg);
      r.players.forEach(p => { p.bet = 0; p.folded = false; });
      r.hand++; r.dealer = r.players.length ? (r.dealer + 1) % r.players.length : 0;
      return { ok: true, msg };
    }
    case 'refund': {
      snap(r);
      r.players.forEach(p => { p.chips += p.bet; p.bet = 0; p.folded = false; });
      addLog(r, 'ตาที่ ' + r.hand + ': ยกเลิก คืนชิป'); r.hand++;
      return { ok: true, msg: 'คืนชิปแล้ว' };
    }
    case 'undo': {
      if (!r.hist.length) return { ok: true, msg: '' };
      const h = JSON.parse(r.hist.pop());
      // keep remote players' keys and anyone who joined after the snapshot
      const keys = Object.fromEntries(r.players.filter(p => p.key).map(p => [p.id, p.key]));
      h.players.forEach(p => { if (keys[p.id]) p.key = keys[p.id]; });
      for (const p of r.players) if (p.key && !h.players.find(q => q.id === p.id)) h.players.push(p);
      Object.assign(r, h);
      return { ok: true, msg: 'ย้อนกลับแล้ว' };
    }
    case 'addPlayer': {
      if (r.players.length >= MAX_PLAYERS) return { error: 'ได้สูงสุด ' + MAX_PLAYERS + ' คน', status: 400 };
      snap(r);
      r.players.push({ id: 'p' + token().slice(0, 8), name: clean(body.name, 'ผู้เล่น ' + (r.players.length + 1)), chips: r.start, bet: 0, folded: false });
      return { ok: true, msg: '' };
    }
    case 'setPlayer': {
      const p = P(r, String(body.pid || '')); if (!p) return { error: 'ไม่พบผู้เล่น', status: 400 };
      snap(r);
      if (body.name !== undefined) p.name = clean(body.name, p.name);
      if (body.chips !== undefined) { const old = p.chips; p.chips = Math.max(0, int(body.chips, p.chips)); if (old !== p.chips) addLog(r, p.name + ': ปรับชิป ' + fmt(old) + ' → ' + fmt(p.chips)); }
      return { ok: true, msg: '' };
    }
    case 'removePlayer': {
      const p = P(r, String(body.pid || '')); if (!p) return { error: 'ไม่พบผู้เล่น', status: 400 };
      if (p.bet) return { error: 'จ่าย Pot ตานี้ให้จบก่อนลบผู้เล่น', status: 400 };
      snap(r); r.players = r.players.filter(q => q !== p);
      return { ok: true, msg: p.name + ' ออกจากโต๊ะ' };
    }
    case 'setStart': { r.start = Math.max(1, int(body.start, r.start)); return { ok: true, msg: '' }; }
    case 'reset': {
      snap(r);
      r.players.forEach(p => { p.chips = r.start; p.bet = 0; p.folded = false; });
      r.hand++; r.dealer = 0; r.log = ['เริ่มเกมใหม่'];
      return { ok: true, msg: 'เริ่มเกมใหม่แล้ว' };
    }
  }
  return { error: 'คำสั่งไม่ถูกต้อง', status: 400 };
}

/* ---------- live updates (Server-Sent Events) ---------- */
const streams = {};
function broadcast(code, extra) {
  const r = rooms[code]; if (!r || !streams[code]) return;
  const data = 'data: ' + JSON.stringify({ state: publicState(r), ...extra }) + '\n\n';
  for (const res of streams[code]) res.write(data);
}
setInterval(() => { for (const set of Object.values(streams)) for (const res of set) res.write(': ping\n\n'); }, 25000);

/* ---------- http ---------- */
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;

  if (req.method === 'POST' && route === '/api/create') {
    const b = await readBody(req);
    const code = newCode();
    const r = rooms[code] = { code, hostKey: token(), start: Math.max(1, int(b.start, 1000)), hand: 1, dealer: 0, players: [], log: ['เปิดห้อง'], hist: [], touched: Date.now() };
    persist();
    return send(res, 200, { code, key: r.hostKey });
  }

  if (req.method === 'POST' && route === '/api/join') {
    const b = await readBody(req);
    const r = rooms[String(b.code || '').toUpperCase()];
    if (!r) return send(res, 404, { error: 'ไม่พบห้องนี้ ตรวจรหัสอีกครั้ง' });
    if (r.players.length >= MAX_PLAYERS) return send(res, 400, { error: 'โต๊ะเต็มแล้ว' });
    const p = { id: 'r' + token().slice(0, 8), key: token(), name: clean(b.name, 'ผู้เล่น'), chips: r.start, bet: 0, folded: false };
    r.players.push(p); addLog(r, p.name + ' เข้าร่วมโต๊ะ'); r.touched = Date.now();
    persist(); broadcast(r.code, { msg: p.name + ' เข้าร่วมโต๊ะ' });
    return send(res, 200, { code: r.code, key: p.key, pid: p.id });
  }

  if (req.method === 'POST' && route === '/api/act') {
    const b = await readBody(req);
    const r = rooms[String(b.code || '').toUpperCase()];
    if (!r) return send(res, 404, { error: 'ไม่พบห้องนี้' });
    const out = act(r, b);
    if (out.error) return send(res, out.status || 400, { error: out.error });
    r.touched = Date.now(); persist(); broadcast(r.code, { msg: out.msg });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && route === '/api/stream') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    const key = String(url.searchParams.get('key') || '');
    const r = rooms[code];
    if (!r) return send(res, 404, { error: 'ไม่พบห้องนี้' });
    const role = key === r.hostKey ? 'host' : (r.players.find(p => p.key && p.key === key) ? 'player' : 'viewer');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n');
    res.write('data: ' + JSON.stringify({ state: publicState(r), role }) + '\n\n');
    (streams[code] = streams[code] || new Set()).add(res);
    req.on('close', () => { streams[code] && streams[code].delete(res); });
    return;
  }

  if (req.method === 'GET') {
    let file = route === '/' ? '/index.html' : route;
    const fp = path.normalize(path.join(PUBLIC, file));
    if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    return fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  }
  res.writeHead(405); res.end();
});

server.listen(PORT, () => console.log('โต๊ะชิปพร้อมแล้วที่ http://localhost:' + PORT));
