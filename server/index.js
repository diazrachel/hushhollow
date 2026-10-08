// Hush Hollow server: serves the site and runs every room over WebSockets.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

// ---------- static files ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/' || !path.extname(file)) file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- hub ----------
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const hub = {
  rooms: new Map(),   // code -> Room
  tokens: new Map(),  // token -> { code, pid }
  newCode() {
    let code;
    do { code = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join(''); }
    while (this.rooms.has(code));
    return code;
  },
  create(opts) { const r = new Room(this, this.newCode(), opts); this.rooms.set(r.code, r); return r; },
  forget(token) { if (token) this.tokens.delete(token); },
  lookup(token) {
    const s = this.tokens.get(token); if (!s) return null;
    const room = this.rooms.get(s.code); const p = room && room.get(s.pid);
    if (!p || p.token !== token) { this.tokens.delete(token); return null; }
    return { room, p };
  },
  quickPlay(lang, sprout) {
    const pool = `${lang}${sprout ? ':sprout' : ''}`;
    const open = [...this.rooms.values()].filter((r) => r.isPublic && r.pool === pool && !r.game && r.players.length < 12)
      .sort((a, b) => b.players.length - a.players.length);
    if (open.length) return open[0];
    return this.create({ isPublic: true, pool });
  },
};

// ---------- sockets ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const TOKEN_RE = /^[a-zA-Z0-9-]{16,64}$/;

wss.on('connection', (ws) => {
  ws.session = null; ws.token = null; ws.profile = {};
  ws.bucket = { n: 0, at: Date.now() };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // basic rate limit: 60 messages per second (night movement sends ~15 a second)
    const now = Date.now();
    if (now - ws.bucket.at > 1000) ws.bucket = { n: 0, at: now };
    if (++ws.bucket.n > 60) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (!TOKEN_RE.test(m.token || '')) return send(ws, { t: 'error', text: 'Your browser sent an invalid session. Refresh the page.' });
      ws.token = m.token; ws.profile = m.profile || {};
      const found = hub.lookup(ws.token);
      if (found) {
        const { room, p } = found;
        if (p.ws && p.ws !== ws) try { p.ws.close(); } catch {}
        p.ws = ws; p.connected = true; p.lastSeen = Date.now();
        if (p.isAI && p.dropped) { p.isAI = false; p.dropped = false; delete p.aiLevel; room.log(`${p.name} is back.`); }
        ws.session = { code: room.code, pid: p.id };
        room.changed();
      } else send(ws, { t: 'home' });
      return;
    }
    if (!ws.token) return;
    if (m.t === 'profile') { ws.profile = m.profile || {}; return; }

    if (m.t === 'quick' || m.t === 'create' || m.t === 'join') {
      if (ws.session) leave(ws);
      let room;
      if (m.t === 'quick') {
        const lang = /^[a-z]{2}$/.test(m.lang) ? m.lang : 'en';
        room = hub.quickPlay(lang, !!m.sprout);
      } else if (m.t === 'create') {
        room = hub.create({ practice: !!m.practice });
      } else {
        room = hub.rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) return send(ws, { t: 'error', text: 'No burrow has that code. Check the 4 letters and try again.' });
        if (room.game) return send(ws, { t: 'error', text: 'That burrow is mid-game. Wait for the round to end, then join.' });
        if (room.practice) return send(ws, { t: 'error', text: 'That is a solo practice burrow.' });
      }
      if (room.players.length >= 14) return send(ws, { t: 'error', text: 'That burrow is full (14 critters).' });
      const p = room.addHuman(ws.token, ws.profile, ws);
      hub.tokens.set(ws.token, { code: room.code, pid: p.id });
      ws.session = { code: room.code, pid: p.id };
      if (room.practice) {
        room.settings.forcedRole = m.forcedRole && /^[a-z]+$/.test(m.forcedRole) ? m.forcedRole : null;
        room.act(p.id, { t: 'fillTo', n: 8, level: 'clever' });
      }
      return;
    }
    if (m.t === 'leave') { leave(ws); return send(ws, { t: 'home' }); }

    const s = ws.session; if (!s) return;
    const room = hub.rooms.get(s.code);
    if (!room) { ws.session = null; return send(ws, { t: 'home' }); }
    room.act(s.pid, m);
  });

  ws.on('close', () => {
    const s = ws.session; if (!s) return;
    const room = hub.rooms.get(s.code); const p = room && room.get(s.pid);
    if (p && p.ws === ws) { p.connected = false; p.lastSeen = Date.now(); p.ws = null; room.changed(); }
  });
});

function leave(ws) {
  const s = ws.session; ws.session = null;
  if (!s) return;
  const room = hub.rooms.get(s.code);
  hub.forget(ws.token);
  if (room) room.remove(s.pid, 'left');
}

// ---------- housekeeping (every second) ----------
setInterval(() => {
  const now = Date.now();
  for (const room of hub.rooms.values()) {
    const g = room.game;
    for (const p of [...room.players]) {
      if (p.isAI || p.connected) continue;
      const away = now - (p.lastSeen || now);
      if (!g && away > 15000) { hub.forget(p.token); room.remove(p.id, 'disconnected'); }
      else if (g && g.phase !== 'over' && away > 60000 && !p.dropped) {
        // keep their token so they can reclaim the seat if they come back
        p.isAI = true; p.dropped = true; p.aiLevel = room.settings.dropAI; p.connected = true;
        room.log(`${p.name} lost connection. An AI critter is keeping their seat warm.`);
        room.fixHost(); room.changed();
      }
    }
    // Quick Play: auto-start and AI top-up
    if (room.isPublic && !g) {
      const humans = room.players.filter((p) => !p.isAI && p.connected);
      if (!humans.length) room.autoStartAt = null;
      else {
        if (room.players.length < 7 && now - room.firstHumanAt > 60000) {
          const target = Math.min(8, humans.length * 2);
          while (room.players.length < target) room.addAI('clever');
        }
        if (room.players.length >= 4 && !room.autoStartAt && (room.players.length >= 7 || now - room.firstHumanAt > 60000)) {
          room.autoStartAt = now + 20000; room.changed();
        }
        if (room.autoStartAt && now >= room.autoStartAt) { room.autoStartAt = null; if (!room.start()) room.changed(); }
      }
    }
    // Delete empty rooms after 2 minutes
    const anyone = room.players.some((p) => !p.isAI && (p.connected || (p.dropped && p.token)));
    if (anyone) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > 120000) {
      room.clearTimers();
      room.players.forEach((p) => hub.forget(p.token));
      hub.rooms.delete(room.code);
    }
  }
}, 1000);

// Drop dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`Hush Hollow is listening on http://localhost:${PORT}`));
module.exports = { hub, server };
