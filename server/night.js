// Lantern Night: the live, real-time night phase.
//
// The server is the referee. Clients send a movement direction, a lantern toggle, and
// "I'm holding the action button". Everything else (movement, collisions, lights, strikes,
// abilities, footprints, and what each player is allowed to see) is decided here.

const { isSneakTeam, ROLES, shuffle } = require('./roles');
const { SIZE, PLACES } = require('./world');

const TICK = 0.05;            // seconds per simulation step (20 Hz)
const FRAME_EVERY = 2;        // send a view frame every 2 ticks (10 Hz)
const SPEED = 13;             // world units per second (the world is 100 x 100)
const BODY = 1.3;             // critter radius for collisions
const LIGHT = 9;              // lantern light radius
const LIGHT_KEEN = 11;        // ...once you've finished your errands
const DARK_SIGHT = 3.2;       // how far you can see with your lantern off
const RECOGNIZE_LIT = 10.5;   // you can make out a lantern-lit critter a little beyond your own light
const LAMP_LIGHT = 8;         // street lamp radius
const PORCH_LIGHT = 11;       // Lantern Keeper's porch light radius
const STRIKE_RANGE = 3.4;
const HOLD_TIME = { strike: 1.4, house: 1.5, lamp: 1.4, blow: 0.8, bell: 1.0 };
const BELL_RANGE = 3.6;
const BELL_NEAR = 25;          // the morning report names who was this close to the tombstone when the bell rang
const HOUSE_RANGE = 6;        // how close to a door you must be to use an ability there
const LAMP_RANGE = 3.4;
const VISIT_RANGE = 7;        // the Gossip Bunny notices anyone who comes this close to the watched door
const TRACK_EVERY = 0.55;     // seconds between footprints
const ERRAND_RANGE = 2.8;     // stand this close to an errand spot...
const ERRAND_TIME = 1.0;      // ...for this long to finish it
const MOVE_SLACK = 1.4;       // how much faster than SPEED a client may report moving (network bunching)

const LANDMARKS = [
  { id: 'bakery', x: 12, y: 12 }, { id: 'mill', x: 88, y: 12 },
  { id: 'orchard', x: 12, y: 88 }, { id: 'library', x: 88, y: 88 },
].map((l) => ({ ...l, name: PLACES[l.id].name, e: PLACES[l.id].e, r: 4.6 }));
const POND = { x: 50, y: 50, rx: 19, ry: 15 };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- world layout (same ring as the day map, so tracks line up) ----------
function housePos(i, n) {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n, rad = n > 10 ? 40 : 38;
  return { x: 50 + rad * Math.cos(a), y: 50 + rad * Math.sin(a) };
}
function buildWorld(houses) {
  const n = houses.length;
  const homes = houses.map((id, i) => {
    const p = housePos(i, n);
    // the door is just below the cottage, toward the pond
    const toC = Math.atan2(50 - p.y, 50 - p.x);
    return { id, x: p.x, y: p.y, door: { x: p.x + Math.cos(toC) * 5.5, y: p.y + Math.sin(toC) * 5.5 }, r: 4 };
  });
  const lamps = [];
  const LN = n >= 12 ? 8 : 6;
  for (let i = 0; i < LN; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / LN;
    lamps.push({ x: 50 + 27 * Math.cos(a), y: 50 + 25 * Math.sin(a) });
  }
  // the village bell stands on the north shore of the pond
  return { size: 100, homes, lamps, landmarks: LANDMARKS, pond: POND, bell: { x: 50, y: POND.y - POND.ry - 4.2 } };
}

// Name a spot so players (and the morning report) can talk about it
function zoneOf(world, pt, name) {
  let best = null, bd = Infinity;
  for (const l of world.landmarks) { const d = dist(l, pt); if (d < 17 && d < bd) { bd = d; best = `the ${l.name}`; } }
  if (best) return best;
  for (const h of world.homes) { const d = dist(h, pt); if (d < 15 && d < bd) { bd = d; best = `${name(h.id)}'s house`; } }
  if (best) return best;
  const e = ((pt.x - POND.x) / POND.rx) ** 2 + ((pt.y - POND.y) / POND.ry) ** 2;
  if (e < 1.7) return 'the Pond';
  return 'the village path';
}

// ---------- collisions ----------
function collide(world, p) {
  p.x = clamp(p.x, 2, 98); p.y = clamp(p.y, 2, 98);
  const solids = [...world.homes, ...world.landmarks];
  for (const s of solids) {
    const d = Math.hypot(p.x - s.x, p.y - s.y), min = s.r + BODY;
    if (d < min) { const k = (min - d) / (d || 1); p.x += (p.x - s.x) * k; p.y += (p.y - s.y) * k; }
  }
  // pond (ellipse): push back along the normal
  const ex = (p.x - POND.x) / (POND.rx + BODY), ey = (p.y - POND.y) / (POND.ry + BODY);
  const e = Math.hypot(ex, ey);
  if (e < 1) { const k = 1 / (e || 1); p.x = POND.x + (p.x - POND.x) * k; p.y = POND.y + (p.y - POND.y) * k; }
}
function blocked(world, x, y) {
  if (x < 2 || x > 98 || y < 2 || y > 98) return true;
  for (const s of [...world.homes, ...world.landmarks]) if (Math.hypot(x - s.x, y - s.y) < s.r + BODY) return true;
  return Math.hypot((x - POND.x) / (POND.rx + BODY), (y - POND.y) / (POND.ry + BODY)) < 1;
}

// ---------- the night itself ----------
function begin(room) {
  const g = room.game;
  if (!g.world) g.world = buildWorld(g.houses);
  const world = g.world;
  const pos = {};
  for (const h of world.homes) {
    if (!g.alive.has(h.id)) continue;
    const x = h.door.x + (Math.random() - 0.5) * 2, y = h.door.y + (Math.random() - 0.5) * 2;
    pos[h.id] = { x, y, tx: x, ty: y, dx: 0, dy: 0, lit: true, hold: null, moved: 0, lastTrack: 0, lx: h.door.x, ly: h.door.y, budget: SPEED * 0.6, errT: 0 };
  }
  g.night = {
    t: 0, tick: 0, pos, gone: new Set(), lamps: world.lamps.map((l) => ({ ...l, lit: false })), porches: new Set(), protected: new Set(),
    tracks: [], strike: null, attempted: false, seen: {}, outs: [], visits: {}, witness: {}, zoneTime: {}, bot: {}, lampLog: [],
    tasks: {}, tkVer: {}, tkSent: {}, ev: {}, fix: {},
    tomb: null, found: new Set(), foundAt: {}, bell: null, endNow: false,
  };
  if (g.bellsLeft === undefined) g.bellsLeft = g.n >= 8 ? 3 : 2;
  if (!g.world.bell) g.world.bell = { x: 50, y: POND.y - POND.ry - 4.2 };
  for (const id of Object.keys(pos)) {
    g.night.seen[id] = {}; g.night.zoneTime[id] = {}; g.night.ev[id] = [];
    g.night.tasks[id] = makeTasks(room, id); g.night.tkVer[id] = 1;
  }
}

// ---------- tonight's errands (random per critter, so everyone has a reason to roam) ----------
const ERRANDS = {
  bakery: [['Grab a warm loaf at the Bakery', '🥖'], ['Return a pie tin to the Bakery', '🥧']],
  mill: [['Fetch a sack of flour from the Mill', '🌾'], ['Check the Mill\'s creaky wheel', '⚙️']],
  orchard: [['Pick apples in the Orchard', '🍎'], ['Look for fallen pears in the Orchard', '🍐']],
  library: [['Return a book to the Library', '📚'], ['Borrow a storybook from the Library', '📖']],
  pond: [['Feed the ducks at the Pond', '🦆'], ['Skip a stone across the Pond', '🪨'], ['Catch a firefly by the Pond', '✨']],
  door: [['Leave a note at NAME\'s door', '✉️'], ['Return NAME\'s basket', '🧺'], ['Borrow sugar from NAME', '🍯']],
};
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
const ROLE_TASK = {
  check: ['Watch a critter: hold E at their door', '🦉'],
  protect: ['Protect a critter: hold E at their door', '🦔'],
  gossip: ['Watch a house: hold E at its door', '🐇'],
  light: ['Hang a porch lantern: hold E at a door', '🏮'],
};
function makeTasks(room, id) {
  const g = room.game, w = g.world, list = [];
  const role = g.roles[id], sneak = isSneakTeam(role), ability = ROLES[role].night;
  if (!sneak && ROLE_TASK[ability]) list.push({ k: 'role', text: ROLE_TASK[ability][0], e: ROLE_TASK[ability][1], done: false });
  if (sneak && !g.settling) list.push({ k: 'strike', text: 'Spirit someone away: lantern off, get close, hold E (not in lamplight)', e: '🌑', done: false });
  if (sneak && g.settling) list.push({ k: 'info', text: 'Settling-in night: no strikes tonight. Blend in!', e: '🌙', done: false });
  if (role === 'trickster' && !g.settling) list.push({ k: 'meddle', text: 'Meddle with a critter: hold E at their door', e: '🎭', done: false });
  // errands: a random mix of landmarks, the pond, a neighbour's door, and a street lamp
  const cands = [];
  for (const l of shuffle(w.landmarks.slice()).slice(0, 2)) {
    const [text, e] = pickOne(ERRANDS[l.id]);
    cands.push({ k: 'spot', text, e, x: l.x + (l.x < 50 ? 6.5 : -6.5), y: l.y + (l.y < 50 ? 6.5 : -6.5) });
  }
  { const a = Math.random() * Math.PI * 2, [text, e] = pickOne(ERRANDS.pond);
    cands.push({ k: 'spot', text, e, x: POND.x + Math.cos(a) * (POND.rx + 3.6), y: POND.y + Math.sin(a) * (POND.ry + 3.6) }); }
  const doors = w.homes.filter((h) => h.id !== id && g.alive.has(h.id));
  if (doors.length) { const h = pickOne(doors), [text, e] = pickOne(ERRANDS.door);
    cands.push({ k: 'spot', text: text.replace('NAME', room.name(h.id)), e, x: h.door.x, y: h.door.y }); }
  { const i = Math.floor(Math.random() * w.lamps.length), l = w.lamps[i];
    cands.push({ k: 'lamp', i, text: `Make sure the lamp near ${zoneOf(w, l, (x) => room.name(x)).replace(/^the /, 'the ')} is lit`, e: '💡', x: l.x, y: l.y }); }
  for (const c of shuffle(cands).slice(0, 3)) list.push({ ...c, done: false, errand: true });
  list.forEach((t, i) => { t.n = i; if (t.x !== undefined) { t.x = +t.x.toFixed(1); t.y = +t.y.toFixed(1); } });
  return list;
}
function finishTask(room, id, t, text) {
  const n = room.game.night; if (t.done) return;
  t.done = true; if (text) t.text = text;
  n.tkVer[id] = (n.tkVer[id] || 0) + 1;
  const p = n.pos[id];
  if (t.errand) {
    n.ev[id].push({ e: t.e, text: `Errand done: ${t.text}` });
    const all = n.tasks[id].filter((x) => x.errand);
    if (p && !p.keen && all.every((x) => x.done)) { p.keen = true; n.ev[id].push({ e: '✨', text: 'All errands done! Your lantern burns brighter for the rest of the night.', big: true }); }
  }
}
function taskOf(n, id, k) { return (n.tasks[id] || []).find((t) => t.k === k); }

const sightOf = (p) => (p.lit ? (p.keen ? LIGHT_KEEN : LIGHT) : DARK_SIGHT);
function lightSources(n) {
  const out = [];
  for (const l of n.lamps) if (l.lit) out.push({ x: l.x, y: l.y, r: LAMP_LIGHT });
  return out;
}
function inStaticLight(g, pt) {
  const n = g.night;
  for (const l of n.lamps) if (l.lit && dist(l, pt) <= LAMP_LIGHT) return true;
  for (const hid of n.porches) { const h = g.world.homes.find((x) => x.id === hid); if (h && dist(h.door, pt) <= PORCH_LIGHT) return true; }
  return false;
}
// Can `obs` make out who `q` is right now?
function recognizes(g, obsId, qId) {
  const n = g.night, o = n.pos[obsId], q = n.pos[qId];
  if (!o || !q) return false;
  const d = dist(o, q);
  const mole = g.roles[qId] === 'mole' && !q.lit;
  if (mole) return d <= 1.6; // underground
  if (d <= sightOf(o)) return true;
  if (q.lit && d <= RECOGNIZE_LIT) return true;
  if (inStaticLight(g, q) && d <= 13) return true;
  return false;
}

// What the "hold" button does for this critter right now
function holdTarget(room, id) {
  const g = room.game, n = g.night, p = n.pos[id], role = g.roles[id];
  if (!p) return null;
  const sneak = isSneakTeam(role);
  if (sneak && !g.settling && !n.attempted && !p.lit) {
    let best = null, bd = STRIKE_RANGE;
    for (const [qid, q] of Object.entries(n.pos)) {
      if (qid === id || n.gone.has(qid) || isSneakTeam(g.roles[qid])) continue;
      const d = dist(p, q); if (d <= bd) { bd = d; best = qid; }
    }
    if (best) return { kind: 'strike', target: best };
  }
  const ability = ROLES[role].night;
  const canHouse = (ability && !sneak && !(id in g.actions)) || (role === 'trickster' && !(id in g.meddles) && !g.settling);
  if (canHouse) {
    let best = null, bd = HOUSE_RANGE;
    for (const h of g.world.homes) {
      if (h.id === id || !g.alive.has(h.id) || n.gone.has(h.id)) continue;
      if (ability === 'protect' && g.lastProtect[id] === h.id) continue;
      const d = dist(p, h.door); if (d <= bd) { bd = d; best = h.id; }
    }
    if (best) return { kind: 'house', target: best };
  }
  if (n.tomb && n.found.has(id) && !n.bell && g.bellsLeft > 0 && dist(p, g.world.bell) <= BELL_RANGE) return { kind: 'bell', target: 0 };
  for (let i = 0; i < n.lamps.length; i++) {
    const l = n.lamps[i];
    if (dist(p, l) > LAMP_RANGE) continue;
    if (!l.lit) return { kind: 'lamp', target: i };
    if (sneak) return { kind: 'blow', target: i };
  }
  return null;
}

function input(room, id, m) {
  const g = room.game, n = g && g.night;
  if (!n || g.phase !== 'night' || !n.pos[id] || n.gone.has(id)) return;
  const p = n.pos[id];
  if (m.t === 'pos') {
    // The browser moves your critter itself (no waiting on the network). The server checks it:
    // no faster than SPEED (with a little slack for bunched-up messages), and no walking through walls.
    const x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const now = Date.now(), el = Math.min(0.6, (now - (p.posAt || now)) / 1000);
    p.posAt = now; p.dx = 0; p.dy = 0;
    p.budget = Math.min(SPEED * 0.6, (p.budget || 0) + SPEED * MOVE_SLACK * el);
    const d = Math.hypot(x - p.x, y - p.y);
    let nx = x, ny = y;
    if (d > p.budget) { const k = p.budget / d; nx = p.x + (x - p.x) * k; ny = p.y + (y - p.y) * k; }
    p.budget = Math.max(0, p.budget - Math.min(d, p.budget));
    const q = { x: nx, y: ny }; collide(g.world, q);
    p.x = q.x; p.y = q.y;
    if (Math.hypot(q.x - x, q.y - y) > 1.5) n.fix[id] = true; // tell that browser where it really is
    return;
  }
  if (m.t === 'move') {
    let dx = Number(m.dx) || 0, dy = Number(m.dy) || 0;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    p.dx = dx; p.dy = dy;
  } else if (m.t === 'lantern') {
    const want = typeof m.on === 'boolean' ? m.on : !p.lit;
    if (p.lit && !want) n.outs.push({ x: p.x, y: p.y, t: n.t, id });
    p.lit = want;
    if (p.hold && p.hold.kind === 'strike' && p.lit) p.hold = null;
  } else if (m.t === 'hold') {
    if (!m.on) { p.hold = null; return; }
    const tgt = holdTarget(room, id);
    if (p.hold && tgt && p.hold.kind === tgt.kind && p.hold.target === tgt.target) return; // already doing it: keep the progress
    p.hold = tgt ? { ...tgt, t: 0 } : null;
  }
}

function completeHold(room, id, h) {
  const g = room.game, n = g.night, p = n.pos[id], role = g.roles[id];
  const ev = n.ev[id] || (n.ev[id] = []), who = (x) => room.name(x);
  if (h.kind === 'bell') { ringBell(room, id); return; }
  if (h.kind === 'lamp') { n.lamps[h.target].lit = true; n.lampLog.push({ id, lamp: h.target, t: n.t, on: true }); ev.push({ e: '💡', text: 'You lit the lamp!' }); return; }
  if (h.kind === 'blow') { n.lamps[h.target].lit = false; n.lampLog.push({ id, lamp: h.target, t: n.t, on: false }); n.outs.push({ x: n.lamps[h.target].x, y: n.lamps[h.target].y, t: n.t, lamp: true }); ev.push({ e: '🌑', text: 'You blew out the lamp.' }); return; }
  if (h.kind === 'house') {
    if (role === 'trickster') {
      g.meddles[id] = h.target;
      const t = taskOf(n, id, 'meddle'); if (t) finishTask(room, id, t, `Meddled with ${who(h.target)}`);
      ev.push({ e: '🎭', text: `You meddled with ${who(h.target)}'s night.`, big: true, target: h.target });
      return;
    }
    const kind = ROLES[role].night;
    g.actions[id] = { kind, target: h.target };
    if (kind === 'protect') n.protected.add(h.target);
    if (kind === 'light') n.porches.add(h.target);
    if (kind === 'gossip') n.visits[h.target] = n.visits[h.target] || new Set();
    const msg = { check: [`Watching ${who(h.target)} tonight`, `🦉 You're watching ${who(h.target)}. Your hint arrives in the morning.`],
      protect: [`Protecting ${who(h.target)} tonight`, `🦔 ${who(h.target)} is protected tonight!`],
      gossip: [`Watching ${who(h.target)}'s house`, `🐇 You're watching ${who(h.target)}'s house. You'll learn who came by.`],
      light: [`Porch lantern on ${who(h.target)}'s house`, `🏮 ${who(h.target)}'s porch is glowing. No one can be taken in its light.`] }[kind];
    const t = taskOf(n, id, 'role'); if (t) finishTask(room, id, t, msg[0]);
    ev.push({ e: '✅', text: msg[1], big: true, target: h.target });
    return;
  }
  if (h.kind === 'strike') {
    const v = h.target, vp = n.pos[v];
    n.attempted = true;
    for (const s of Object.keys(n.pos)) if (isSneakTeam(g.roles[s])) { const t = taskOf(n, s, 'strike'); if (t) finishTask(room, s, t, s === id ? `You went after ${room.name(h.target)}. Now get away and relight!` : `${room.name(id)} went after ${room.name(h.target)}`); }
    if (n.ev[h.target]) n.ev[h.target].push({ e: '😱', text: 'Something lunged at you in the dark!', big: true });
    const zone = zoneOf(g.world, vp, (x) => room.name(x));
    const team = Object.keys(n.pos).filter((x) => isSneakTeam(g.roles[x]));
    if (n.protected.has(v)) {
      for (const s of team) room.priv(s, `Night ${g.day}: ${room.name(id)} went for ${room.name(v)}, but a Hedgehog was protecting them! 🦔`);
      room.priv(v, `Night ${g.day}: something lunged at you in the dark near ${zone}, but a Hedgehog was protecting you! 🦔`);
      n.strike = { by: id, victim: v, x: vp.x, y: vp.y, t: n.t, zone, saved: true };
      return;
    }
    n.strike = { by: id, victim: v, x: vp.x, y: vp.y, t: n.t, zone, saved: false };
    n.gone.add(v); vp.hold = null; vp.dx = 0; vp.dy = 0;
    n.tomb = { x: +vp.x.toFixed(1), y: +vp.y.toFixed(1), victim: v, t: n.t };
    n.found.add(id); n.foundAt[id] = n.t; // the culprit knows exactly where it is
    if (vp.lit) n.outs.push({ x: vp.x, y: vp.y, t: n.t, id: v });
    vp.lit = false;
    for (const s of team) room.priv(s, `Night ${g.day}: ${room.name(id)} spirited away ${room.name(v)} near ${zone}.`);
    // Anyone who could see the Sneak at that moment saw everything
    for (const oid of Object.keys(n.pos)) {
      if (oid === id || oid === v || n.gone.has(oid) || isSneakTeam(g.roles[oid])) continue;
      if (recognizes(g, oid, id)) n.witness[oid] = { by: id, victim: v, zone };
    }
  }
}

function tick(room, dt) {
  const g = room.game, n = g.night;
  n.t += dt; n.tick++;
  const ids = Object.keys(n.pos).filter((id) => !n.gone.has(id));
  require('./bots').tick(room, dt);
  for (const id of ids) {
    const p = n.pos[id];
    const ox = p.tx === undefined ? p.x : p.tx, oy = p.ty === undefined ? p.y : p.ty;
    if (p.dx || p.dy) {
      p.x += p.dx * SPEED * dt; p.y += p.dy * SPEED * dt;
      collide(g.world, p);
    }
    const moved = Math.hypot(p.x - ox, p.y - oy);
    p.tx = p.x; p.ty = p.y;
    // errands
    const tasks = n.tasks[id];
    if (tasks) {
      let near = false;
      for (const t of tasks) {
        if (t.done || !t.errand) continue;
        if (t.k === 'lamp') { if (n.lamps[t.i].lit && dist(p, t) <= LAMP_RANGE + 1) finishTask(room, id, t); continue; }
        if (dist(p, t) <= ERRAND_RANGE) { near = true; p.errT += dt; if (p.errT >= ERRAND_TIME) { finishTask(room, id, t); p.errT = 0; } break; }
      }
      if (!near) p.errT = 0;
    }
    if (p.hold && moved > 0.05) p.hold = null; // moving cancels a hold
    if (p.hold) {
      // re-validate the target every tick
      const now = holdTarget(room, id);
      if (!now || now.kind !== p.hold.kind || now.target !== p.hold.target) p.hold = null;
      else if (p.hold.kind === 'strike' && inStaticLight(g, n.pos[p.hold.target])) p.hold = null; // too bright to strike
      else { p.hold.t += dt; if (p.hold.t >= HOLD_TIME[p.hold.kind]) { const h = p.hold; p.hold = null; completeHold(room, id, h); } }
    }
    // footprints (a Mole leaves none)
    p.moved += moved;
    if (n.t - p.lastTrack >= TRACK_EVERY && p.moved > 0.8 && g.roles[id] !== 'mole') {
      const pl = room.get(id);
      n.tracks.push({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), a: +Math.atan2(p.y - p.ly, p.x - p.lx).toFixed(2), s: SIZE[pl.critter], c: pl.critter, t: +n.t.toFixed(1), id });
      p.lastTrack = n.t; p.moved = 0; p.lx = p.x; p.ly = p.y;
    }
    // where everyone spends their night (used for alibis)
    if (n.tick % 10 === 0) { const z = zoneOf(g.world, p, (x) => room.name(x)); n.zoneTime[id][z] = (n.zoneTime[id][z] || 0) + 0.5; }
  }
  // the Gossip Bunny's watched doors
  for (const [watcher, a] of Object.entries(g.actions)) {
    if (a.kind !== 'gossip') continue;
    const h = g.world.homes.find((x) => x.id === a.target), set = n.visits[a.target] || (n.visits[a.target] = new Set());
    for (const id of ids) if (id !== watcher && id !== a.target && g.roles[id] !== 'mole' && dist(n.pos[id], h.door) <= VISIT_RANGE) set.add(id);
  }
  // stumbling on the tombstone
  if (n.tomb && n.tick % 2 === 0) {
    for (const id of ids) {
      if (n.found.has(id)) continue;
      const p = n.pos[id], d = dist(p, n.tomb);
      if (d <= sightOf(p) + 0.5 || (inStaticLight(g, n.tomb) && d <= 13)) {
        n.found.add(id); n.foundAt[id] = n.t;
        const left = g.bellsLeft, vname = room.name(n.tomb.victim);
        n.ev[id].push({ e: '🪦', big: true, text: left > 0 && !n.bell ? `You found ${vname}'s tombstone! Ring the bell by the Pond to call everyone (${left} ring${left === 1 ? '' : 's'} left this game).` : `You found ${vname}'s tombstone! Remember who was around…` });
        if (left > 0 && !n.bell) {
          n.tasks[id].unshift({ k: 'bell', n: 99, text: `Ring the bell by the Pond (${left} ring${left === 1 ? '' : 's'} left this game)`, e: '🔔', x: g.world.bell.x, y: g.world.bell.y, done: false });
          n.tkVer[id]++;
        }
      }
    }
  }
  // sightings (5 times a second)
  if (n.tick % 4 === 0) {
    for (const o of ids) for (const q of ids) {
      if (o === q || !recognizes(g, o, q)) continue;
      const rec = n.seen[o][q] || (n.seen[o][q] = { first: n.t, last: n.t, pts: [] });
      rec.last = n.t;
      const lp = rec.pts[rec.pts.length - 1], qlit = n.pos[q].lit ? 1 : 0;
      if (!qlit) rec.dark = true;
      if (!lp || n.t - lp[0] >= 1 || lp[3] !== qlit) rec.pts.push([+n.t.toFixed(1), +n.pos[q].x.toFixed(1), +n.pos[q].y.toFixed(1), qlit]);
    }
  }
}

function ringBell(room, id) {
  const g = room.game, n = g.night;
  if (n.bell || g.bellsLeft <= 0) return;
  g.bellsLeft--;
  const near = Object.keys(n.pos).filter((q) => q !== n.tomb.victim && !n.gone.has(q) && g.alive.has(q))
    .map((q) => ({ id: q, d: +dist(n.pos[q], n.tomb).toFixed(1) })).filter((x) => x.d <= BELL_NEAR).sort((a, b) => a.d - b.d).slice(0, 3);
  n.bell = { by: id, t: n.t, near, victim: n.tomb.victim };
  for (const q of Object.keys(n.ev)) {
    n.ev[q].push({ e: '🔔', big: true, text: q === id ? 'You rang the bell! Everyone, to the Pond…' : `${room.name(id)} rang the bell! Everyone, to the Pond…` });
    const t = taskOf(n, q, 'bell'); if (t) finishTask(room, q, t, q === id ? 'You rang the bell' : `${room.name(id)} rang the bell`);
  }
  n.endNow = true;
  if (room.bellRung) room.bellRung();
}

// What one player gets to see this frame (fog of war is enforced HERE, not in the browser)
function frameFor(room, viewerId) {
  const g = room.game, n = g.night;
  const me = n.pos[viewerId];
  const wisp = !g.alive.has(viewerId) || n.gone.has(viewerId);
  const see = [], glows = [];
  for (const [id, q] of Object.entries(n.pos)) {
    if (id === viewerId || n.gone.has(id)) continue;
    if (wisp || (me && recognizes(g, viewerId, id))) see.push([id, +q.x.toFixed(2), +q.y.toFixed(2), q.lit ? 1 : 0, q.hold ? q.hold.kind : 0]);
    else if (q.lit) glows.push([+q.x.toFixed(1), +q.y.toFixed(1)]);
  }
  const team = isSneakTeam(g.roles[viewerId]);
  const out = {
    t: 'nf', nt: +n.t.toFixed(2),
    me: me && !wisp ? [+me.x.toFixed(2), +me.y.toFixed(2), me.lit ? 1 : 0, me.hold ? me.hold.kind : 0, me.hold ? +(me.hold.t / HOLD_TIME[me.hold.kind]).toFixed(2) : 0, me.keen ? 1 : 0, +(me.errT / ERRAND_TIME).toFixed(2)] : null,
    see, glows,
    lamps: n.lamps.map((l) => (l.lit ? 1 : 0)).join(''),
    porches: [...n.porches],
    struck: team ? !!n.strike : undefined,
    wisp,
  };
  if (n.tomb && (wisp || n.found.has(viewerId))) out.tomb = [n.tomb.x, n.tomb.y, n.tomb.victim];
  out.bells = g.bellsLeft; if (n.bell) out.rung = 1;
  if (n.tasks[viewerId] && n.tkSent[viewerId] !== n.tkVer[viewerId]) { out.tasks = n.tasks[viewerId]; n.tkSent[viewerId] = n.tkVer[viewerId]; }
  if (n.ev[viewerId] && n.ev[viewerId].length) { out.ev = n.ev[viewerId]; n.ev[viewerId] = []; }
  if (n.fix[viewerId] && me) { out.fix = 1; n.fix[viewerId] = false; }
  return out;
}

// ---------- the morning: turn the night into private memories + public tracks ----------
function summarize(room, meddled = new Set()) {
  const g = room.game, n = g.night, night = g.day, name = (x) => room.name(x);
  const dur = n.t || 1;
  const when = (t) => (t < dur / 3 ? 'early' : t < (2 * dur) / 3 ? 'around midnight' : 'late');
  for (const o of Object.keys(n.pos)) {
    if (n.gone.has(o) || !g.alive.has(o)) continue;
    const zones = Object.entries(n.zoneTime[o]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const seen = Object.entries(n.seen[o]).map(([q, r]) => {
      const p0 = r.pts[0] || [r.first, 50, 50], p1 = r.pts[r.pts.length - 1] || p0;
      return { id: q, first: r.first, last: r.last, pts: r.pts, dark: !!r.dark, zone: zoneOf(g.world, { x: p0[1], y: p0[2] }, name), lastZone: zoneOf(g.world, { x: p1[1], y: p1[2] }, name) };
    }).sort((a, b) => a.first - b.first);
    const spot = (s) => (s.zone === s.lastZone && when(s.first) === when(s.last) ? `${s.zone}, ${when(s.first)}`
      : `${s.zone} ${when(s.first)} → ${s.lastZone} ${when(s.last)}`);
    if (meddled.has(o) && seen.length) {
      // the Trickster muddled your memory: one face is swapped for someone else
      const fake = Object.keys(n.pos).find((x) => x !== o && !n.gone.has(x) && !seen.some((y) => y.id === x));
      if (fake) seen[Math.floor(Math.random() * seen.length)].id = fake;
    }
    let text;
    if (!seen.length) text = `Night ${night}: you spent the night around ${zones.slice(0, 2).join(' and ') || 'home'} and didn't run into anyone.`;
    else text = `Night ${night}: you were around ${zones.slice(0, 2).join(' and ')}. You saw ${seen.map((s) => `${name(s.id)} (${spot(s)}${s.dark ? ', lantern OFF 🌑' : ''})`).join(', ')}.`;
    room.priv(o, text, { sight: { night, zones, seen } });
    if (n.tomb && n.found.has(o) && o !== (n.strike && n.strike.by)) room.priv(o, `Night ${night}: 🪦 you found ${name(n.tomb.victim)}'s tombstone near ${zoneOf(g.world, n.tomb, name)} (${when(n.foundAt[o])}).`, { found: { night, at: n.foundAt[o] } });
    const w = n.witness[o];
    if (w) room.priv(o, `Night ${night}: 😱 you SAW ${name(w.by)} spirit away ${name(w.victim)} near ${w.zone}!`, { witness: { night, by: w.by, victim: w.victim } });
  }
  // Public: tonight's footprints (no names, just shapes) and where lights went out
  g.tracks = n.tracks.map(({ id, ...rest }) => rest);
  g.outs = n.outs.filter((x) => !x.lamp).map((x) => ({ zone: zoneOf(g.world, x, name), when: when(x.t), x: +x.x.toFixed(1), y: +x.y.toFixed(1), t: x.t }));
  g.lampOuts = n.outs.filter((x) => x.lamp).map((x) => ({ zone: zoneOf(g.world, x, name), when: when(x.t) }));
}

module.exports = {
  TICK, FRAME_EVERY, LIGHT, LIGHT_KEEN, ERRAND_RANGE, ERRAND_TIME, DARK_SIGHT, LAMP_LIGHT, PORCH_LIGHT, STRIKE_RANGE, HOLD_TIME, HOUSE_RANGE, LAMP_RANGE, SPEED,
  BELL_RANGE, BELL_NEAR, ringBell,
  begin, tick, input, frameFor, summarize, holdTarget, recognizes, inStaticLight, zoneOf, blocked, dist, buildWorld, LANDMARKS,
};
