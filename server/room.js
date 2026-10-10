// A Room holds a lobby and (when started) one game of Hush Hollow.
// Everything secret lives here; clients only ever receive view(playerId).

const crypto = require('crypto');
const { ROLES, isSneakTeam, generateSetup, shuffle, pick, clearChance, sceneClues, exactSize } = require('./roles');
const { clean, cleanName } = require('./filter');
const AI = require('./ai');
const Talk = require('./talk');
const Hear = require('./hear');
const Night = require('./night');
const STICKERS = ['theory', 'accuse', 'defend', 'question'];

const HATS = ['none', 'bow', 'flower', 'crown', 'cap', 'tophat', 'mushroom', 'sprout'];
const CRITTERS = ['mouse', 'hamster', 'frog', 'duck', 'bunny', 'cat', 'fox', 'raccoon', 'bear', 'panda', 'pig', 'koala'];
const COLORS = ['berry', 'honey', 'sky', 'mint', 'lilac', 'peach', 'moss', 'cocoa'];
const EMOTES = ['🤔', '👀', '😤', '🙏', '😂', '❤️', '😱', '🤫'];
const AI_NAMES = ['Mochi', 'Pip', 'Biscuit', 'Clover', 'Pebble', 'Juniper', 'Nutmeg', 'Wren', 'Fig', 'Tofu',
  'Bramble', 'Sprig', 'Maple', 'Puddle', 'Thimble', 'Acorn', 'Bean', 'Willow', 'Hazel', 'Dumpling'];

const BASE = { night: 70, settle: 45, dawn: 10, vote: 20, defense: 15 };
const SPEED = { relaxed: 1.6, normal: 1, fast: 0.65 };
const ENV_MULT = Number(process.env.SPEED_MULT || 1); // for local testing only
const MAX_PLAYERS = 14, MIN_PLAYERS = 4;
const NOTE_LIMIT = 500;

const listNames = (a) => (a.length <= 1 ? a.join('') : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`);
const newId = () => crypto.randomBytes(5).toString('hex');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function sanitizeProfile(pr = {}) {
  return {
    name: cleanName(pr.name),
    critter: CRITTERS.includes(pr.critter) ? pr.critter : pick(CRITTERS),
    color: COLORS.includes(pr.color) ? pr.color : pick(COLORS),
    hat: HATS.includes(pr.hat) ? pr.hat : 'none',
    games: Math.max(0, Math.min(9999, Number(pr.games) || 0)),
  };
}

class Room {
  constructor(hub, code, { isPublic = false, pool = null, practice = false } = {}) {
    this.hub = hub; this.code = code; this.isPublic = isPublic; this.pool = pool; this.practice = practice;
    this.players = []; this.hostId = null;
    this.settings = { spice: 'cozy', speed: practice ? 'relaxed' : 'normal', dropAI: 'sleepy', forcedRole: null };
    this.lobbyChat = []; this.game = null;
    this.timer = null; this.nextFn = null; this.aiTimers = []; this.flushTimer = null;
    this.firstHumanAt = null; this.autoStartAt = null; this.emptySince = null;
  }

  // ---------- helpers ----------
  mult() { return (SPEED[this.settings.speed] || 1) * ENV_MULT; }
  get(id) { return this.players.find((p) => p.id === id); }
  name(id) { const p = this.get(id); return p ? p.name : 'someone'; }
  humans() { return this.players.filter((p) => !p.isAI); }
  sys(text) { this.lobbyChat.push({ sys: true, text, ts: Date.now() }); this.lobbyChat = this.lobbyChat.slice(-80); }
  log(text) { if (this.game) this.game.log.push({ day: this.game.day, phase: this.game.phase, text }); }
  priv(id, text, extra = {}) { if (this.game && this.game.priv[id]) this.game.priv[id].push({ text, day: this.game.day, ...extra }); }

  changed() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 60);
  }
  flush() {
    for (const p of this.players) {
      if (!p.isAI && p.ws && p.ws.readyState === 1) {
        try { p.ws.send(JSON.stringify(this.view(p.id))); } catch (e) { /* ignore */ }
      }
    }
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players) if (!p.isAI && p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
  fixHost() {
    const host = this.get(this.hostId);
    if (host && !host.isAI) return;
    const next = this.players.find((p) => !p.isAI && p.connected) || this.players.find((p) => !p.isAI);
    this.hostId = next ? next.id : null;
  }

  // ---------- lobby ----------
  addHuman(token, profile, ws) {
    const p = { id: newId(), token, ...sanitizeProfile(profile), isAI: false, connected: true, ws, lastSeen: Date.now(), lastChat: 0, lastEmote: 0 };
    this.players.push(p);
    if (!this.firstHumanAt) this.firstHumanAt = Date.now();
    this.fixHost();
    this.sys(`${p.name} joined.`);
    this.changed();
    return p;
  }
  addAI(level = 'clever') {
    if (this.players.length >= MAX_PLAYERS || this.game) return;
    const used = new Set(this.players.map((p) => p.name));
    const name = AI_NAMES.find((n) => !used.has(n)) || `Sprig${this.players.length}`;
    this.players.push({ id: newId(), token: null, name, critter: pick(CRITTERS), color: pick(COLORS),
      hat: pick(HATS), games: 99, isAI: true, aiLevel: ['sleepy', 'clever', 'cunning'].includes(level) ? level : 'clever', connected: true });
    this.changed();
  }
  remove(id, reason = 'left') {
    const p = this.get(id); if (!p) return;
    if (this.game && this.game.phase !== 'over') {
      // Mid-game: keep the seat, hand it to a sleepy AI so the game stays fair.
      const keep = reason === 'left'; // someone who walked out can come back; someone kicked can't
      p.isAI = true; p.aiLevel = 'sleepy'; p.ws = null; p.connected = true; p.dropped = true;
      if (keep) p.leftAt = Date.now(); else p.token = null;
      this.log(`${p.name} ${reason}. A sleepy AI critter took their seat${keep ? ' (they can rejoin)' : ''}.`);
    } else {
      this.players = this.players.filter((x) => x.id !== id);
      this.sys(`${p.name} ${reason}.`);
    }
    this.fixHost();
    this.changed();
  }

  // ---------- message entry point ----------
  act(pid, m) {
    const p = this.get(pid); if (!p || !m || typeof m.t !== 'string') return;
    const isHost = pid === this.hostId;
    const g = this.game;
    switch (m.t) {
      case 'settings': {
        if (!isHost || g) return;
        if (['cozy', 'classic', 'chaos'].includes(m.spice) && !(this.pool && this.pool.endsWith(':sprout'))) this.settings.spice = m.spice;
        if (SPEED[m.speed]) this.settings.speed = m.speed;
        if (['sleepy', 'clever'].includes(m.dropAI)) this.settings.dropAI = m.dropAI;
        if (this.practice && (m.forcedRole === null || ROLES[m.forcedRole])) this.settings.forcedRole = m.forcedRole;
        return this.changed();
      }
      case 'addAI': if (isHost && !g) this.addAI(m.level); return;
      case 'fillTo': {
        if (!isHost || g) return;
        const target = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Number(m.n) || 0));
        while (this.players.length < target) this.addAI(m.level);
        return;
      }
      case 'removeAI': {
        const t = this.get(m.id);
        if (isHost && !g && t && t.isAI) { this.players = this.players.filter((x) => x.id !== t.id); this.changed(); }
        return;
      }
      case 'kick': {
        const t = this.get(m.id);
        if (!isHost || !t || t.isAI || t.id === pid) return;
        if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'kicked' }));
        this.hub.forget(t.token);
        return this.remove(t.id, 'was removed by the host');
      }
      case 'start': if (isHost) this.start(); return;
      case 'again': {
        if (!g || g.phase !== 'over') return; // anyone can head back to the lobby once the game is over
        this.clearTimers(); this.game = null; this.autoStartAt = null;
        for (const x of this.players) if (x.dropped && x.token) this.hub.forget(x.token);
        this.players = this.players.filter((x) => !x.dropped);
        this.sys(`${p.name} brought everyone back to the lobby.`);
        this.sys('Back in the lobby. Same burrow, new game.');
        return this.changed();
      }
      case 'chat': return this.chat(p, m);
      case 'emote': {
        if (!EMOTES.includes(m.e) || Date.now() - (p.lastEmote || 0) < 800) return;
        p.lastEmote = Date.now();
        return this.broadcast({ t: 'emote', id: pid, e: m.e });
      }
    }
    if (!g || g.phase === 'over') return;
    switch (m.t) {
      case 'move': case 'pos': case 'lantern': case 'hold': case 'strike': return Night.input(this, p.id, m);
      case 'post': return this.post(p, m);
      case 'react': return this.react(p, m);
      case 'yarn': return this.setYarn(p, m);
      case 'ready': return this.setReady(p);
      case 'nominate': return this.nominate(p, m);
      case 'vote': return this.vote(p, m);
      case 'reveal': return this.reveal(p);
      case 'note': return this.note(p, m);
    }
  }

  chat(p, m) {
    const text = clean(String(m.text || '').trim().slice(0, 240));
    if (!text) return;
    if (!p.isAI && Date.now() - p.lastChat < 600) return;
    p.lastChat = Date.now();
    const g = this.game;
    const msg = { by: p.id, text, ts: Date.now(), depth: p.isAI ? Math.max(1, Number(m.depth) || 1) : 0 };
    if (!g || g.phase === 'over') {
      this.lobbyChat.push(msg); this.lobbyChat = this.lobbyChat.slice(-80);
      return this.changed();
    }
    const alive = g.alive.has(p.id);
    let ch;
    if (!alive) ch = 'wisp';
    else if (m.channel === 'den' && isSneakTeam(g.roles[p.id])) ch = 'den';
    else if (g.phase === 'night') return; // the village sleeps at night
    else ch = 'day';
    g.chat[ch].push(msg); g.chat[ch] = g.chat[ch].slice(-100);
    if (ch === 'day') Hear.hear(this, p.id, text);
    this.changed();
    try { Talk.onChat(this, msg, ch); } catch (e) { console.error('[talk]', e); }
  }

  // ---------- game setup ----------
  start() {
    const n = this.players.length;
    if (this.game || n < MIN_PLAYERS || n > MAX_PLAYERS) return false;
    if (!this.players.some((p) => !p.isAI)) return false;
    let roles = generateSetup(n, this.settings.spice);
    const forced = this.practice && this.settings.forcedRole;
    if (forced) {
      const hi = this.players.findIndex((p) => p.id === this.hostId);
      let j = roles.indexOf(forced);
      if (j < 0) {
        const team = ROLES[forced].team;
        j = roles.findIndex((r) => (team === 'sneaks' ? isSneakTeam(r) : r === 'villager'));
        if (j < 0) j = roles.findIndex((r) => !isSneakTeam(r));
        roles[j] = forced;
      }
      [roles[hi], roles[j]] = [roles[j], roles[hi]];
    }
    const order = shuffle(this.players.map((p) => p.id));
    const g = this.game = {
      n, phase: 'night', day: 1, settling: n !== 7, endsAt: 0, roles: {}, alive: new Set(order), houses: order,
      log: [], priv: {}, notes: {}, claims: [], board: [], boardSeq: 1, yarn: {},
      actions: {}, meddles: {}, owlPending: [], lastProtect: {}, lastLight: {}, lastMeddle: {},
      turtles: new Set(), ready: new Set(), noms: {}, nominees: [], votes: {}, defenseIdx: 0, history: [], deaths: [],
      chat: { day: [], den: [], wisp: [] }, ai: {}, soloWins: new Set(), winner: null, winnerIds: new Set(),
      settleLeft: [4, 8, 12, 13, 14].includes(n) ? 2 : n === 7 ? 0 : 1, scenes: [], tracks: [], trackLog: {}, outs: [], lampOuts: [],
      world: Night.buildWorld(order), places: Night.LANDMARKS.map((l) => l.id), claimSeq: 1, eventSeq: 1, events: [], bigGame: n >= 12,
    };
    this.players.forEach((p, i) => { g.roles[p.id] = roles[i]; g.priv[p.id] = []; g.notes[p.id] = []; });
    const team = order.filter((id) => isSneakTeam(g.roles[id]));
    for (const id of order) {
      const r = g.roles[id];
      this.priv(id, `You are the ${ROLES[r].name}.`);
      if (isSneakTeam(r) && team.length > 1) {
        this.priv(id, `Your Sneak team: ${team.filter((x) => x !== id).map((x) => `${this.name(x)} (${ROLES[g.roles[x]].name})`).join(', ')}.`);
      }
    }
    this.autoStartAt = null;
    this.log(`Night falls on Hush Hollow. ${n} critters, ${team.length} of them secretly Sneaks. ${g.settling ? "It's a settling-in night, so nobody will be spirited away." : 'Careful: the Sneaks can strike tonight!'}`);
    this.startNight();
    return true;
  }

  // ---------- phase machinery ----------
  clearTimers() {
    clearTimeout(this.timer); this.timer = null;
    clearInterval(this.nightLoop); this.nightLoop = null;
    this.aiTimers.forEach(clearTimeout); this.aiTimers = [];
  }
  setPhase(phase, secs, next) {
    const g = this.game;
    g.phase = phase; g.endsAt = Date.now() + secs * 1000;
    this.nextFn = next;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runNext(), secs * 1000);
    this.scheduleAI();
    this.changed();
  }
  runNext() {
    const fn = this.nextFn; this.nextFn = null;
    if (!fn || !this.game) return;
    try { fn(); } catch (e) { console.error('[phase error]', e); }
  }
  shorten(secs) {
    const g = this.game; if (!g || !this.nextFn) return;
    const at = Date.now() + secs * 1000;
    if (g.endsAt <= at) return;
    g.endsAt = at;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runNext(), secs * 1000);
    this.changed();
  }
  scheduleAI() {
    this.aiTimers.forEach(clearTimeout); this.aiTimers = [];
    const g = this.game; if (!g) return;
    const span = Math.max(1, g.endsAt - Date.now());
    const at = (lo, hi) => Math.min(span - (ENV_MULT < 1 ? 5 : 400), (lo + Math.random() * (hi - lo)) * span);
    for (const p of this.players) {
      if (!p.isAI) continue;
      const run = (fn, lo, hi) => this.aiTimers.push(setTimeout(() => {
        if (!this.game || this.game.phase === 'over') return;
        try { fn(this, p); } catch (e) { console.error('[ai error]', e); }
      }, Math.max(ENV_MULT < 1 ? 5 : 150, at(lo, hi))));
      const alive = g.alive.has(p.id);
      if (g.phase === 'dawn' && alive) run(AI.notes, 0.1, 0.6);
      else if (g.phase === 'day' && alive) {
        run(AI.dayTalk, 0.05, 0.3);
        run(AI.dayLate, 0.35, 0.6);
        run(AI.ready, 0.55, 0.85);
      } else if (g.phase === 'vote' && alive) run(AI.vote, 0.1, 0.55);
    }
  }

  startNight() {
    const g = this.game;
    g.actions = {}; g.meddles = {};
    g.ready = new Set(); g.votes = {}; g.noms = {}; g.nominees = [];
    g.nightDur = (g.settling ? BASE.settle : BASE.night) * (SPEED[this.settings.speed] || 1) * Number(process.env.NIGHT_MULT || 1);
    Night.begin(this);
    if (ENV_MULT < 1) {
      // fast simulation (tests): play the whole night instantly
      g.phase = 'night'; g.endsAt = Date.now();
      setImmediate(() => {
        if (this.game !== g) return;
        for (let t = 0; t < g.nightDur; t += Night.TICK) { Night.tick(this, Night.TICK); if (g.night.endNow) break; }
        this.endNight();
      });
      return;
    }
    this.setPhase('night', g.nightDur, () => this.endNight());
    clearInterval(this.nightLoop);
    let k = 0;
    this.nightLoop = setInterval(() => {
      if (!this.game || this.game !== g || g.phase !== 'night') { clearInterval(this.nightLoop); return; }
      try {
        Night.tick(this, Night.TICK);
        if (++k % Night.FRAME_EVERY === 0) {
          for (const p of this.players) {
            if (p.isAI || !p.ws || p.ws.readyState !== 1) continue;
            p.ws.send(JSON.stringify(Night.frameFor(this, p.id)));
          }
        }
      } catch (e) { console.error('[night]', e); }
    }, Night.TICK * 1000);
  }
  // Someone rang the village bell: the night ends in a moment
  bellRung() {
    if (ENV_MULT < 1) return; // the fast simulation loop stops by itself
    this.shorten(2.5);
  }
  nextNight() { this.game.day++; this.log(`Night ${this.game.day} falls.`); this.startNight(); }

  endNight() {
    const g = this.game, night = g.day, n = g.night;
    clearInterval(this.nightLoop); this.nightLoop = null;
    const rec = { night, visits: [], kill: null, saved: false, lit: [...n.porches], meddles: [] };
    const st = n.strike;
    const died = [];
    if (st) { rec.kill = st.victim; rec.culprit = st.by; if (st.saved) rec.saved = true; else died.push(st.victim); }
    const living = [...g.alive].filter((id) => !n.gone.has(id));
    const acts = Object.entries(g.actions).filter(([id]) => g.alive.has(id));

    // Hedgehog bookkeeping (can't protect the same critter twice in a row)
    for (const id of Object.keys(g.lastProtect)) if (!(id in g.actions)) delete g.lastProtect[id];
    for (const [id, a] of acts) if (a.kind === 'protect') g.lastProtect[id] = a.target;

    // Trickster meddling
    const meddled = new Set();
    for (const id of Object.keys(g.lastMeddle)) if (!(id in g.meddles)) delete g.lastMeddle[id];
    for (const [tid, target] of Object.entries(g.meddles)) {
      if (!g.alive.has(tid)) continue;
      meddled.add(target); g.lastMeddle[tid] = target; rec.meddles.push({ by: tid, target });
      this.priv(tid, `Night ${night}: you meddled with ${this.name(target)}'s night.`);
    }

    // What everyone saw with their own lantern
    Night.summarize(this, meddled);

    // Ability results (hints, not answers)
    for (const [id, a] of acts) {
      if (n.gone.has(id)) continue;
      const tn = this.name(a.target);
      const scrambled = meddled.has(id);
      rec.visits.push({ from: id, to: a.target, kind: a.kind });
      if (a.kind === 'check') {
        const others = shuffle(living.filter((x) => x !== id && x !== a.target));
        const extra = living.length >= 5 ? 2 : 1;
        const group = [a.target, ...others.slice(0, extra)];
        const hasSneak = group.some((x) => isSneakTeam(g.roles[x]));
        const hasOther = group.some((x) => !isSneakTeam(g.roles[x]));
        const yes = hasSneak && (!hasOther || Math.random() < 0.8);
        let shown = group.slice();
        if (scrambled && shown.length > 1) {
          const spare = others.slice(extra);
          if (spare.length) shown[1 + Math.floor(Math.random() * (shown.length - 1))] = pick(spare);
        }
        const names = listNames(shown.map((x) => this.name(x)));
        const text = `Night ${night}: you watched ${tn}. ${yes ? `At least one of ${names} is a Sneak.` : `At least one of ${names} is NOT a Sneak.`}`;
        if (g.n <= 8 || g.n === 11) { g.owlPending.push({ to: id, text, hint: { group: shown, yes }, at: night + 1 }); this.priv(id, `Night ${night}: you watched ${tn}. In a small village the answer takes a night to arrive.`); }
        else this.priv(id, text, { hint: { group: shown, yes } });
      } else if (a.kind === 'gossip') {
        let seen = [...(n.visits[a.target] || [])];
        if (scrambled) {
          const fake = pick(living.filter((x) => x !== id && x !== a.target && !seen.includes(x)));
          if (fake) { if (seen.length) seen[Math.floor(Math.random() * seen.length)] = fake; else seen = [fake]; }
        }
        const names = seen.map((x) => this.name(x));
        this.priv(id, `Night ${night}: ${names.length ? `${listNames(names)} came by ${tn}'s door after you started watching.` : `nobody came by ${tn}'s door while you watched.`}`, { saw: { house: a.target, visitors: seen } });
      } else if (a.kind === 'protect') {
        this.priv(id, `Night ${night}: you protected ${tn}.${st && st.saved && st.victim === a.target ? ' You fought off a Sneak!' : ''}`);
      } else if (a.kind === 'light') {
        this.priv(id, `Night ${night}: you lit the porch lantern at ${tn}'s house. Nobody could strike in its light.`);
      }
    }
    g.owlPending = g.owlPending.filter((o) => {
      if (o.at > night) return true;
      if (g.alive.has(o.to) && !n.gone.has(o.to)) this.priv(o.to, `${o.text} (delayed answer)`, { hint: o.hint });
      return false;
    });

    // The scene: where it happened (public). Footprints are public too, but nameless.
    let scene = null;
    if (st && !st.saved) {
      scene = { night, victim: st.victim, x: +st.x.toFixed(1), y: +st.y.toFixed(1), zone: st.zone, t: +st.t.toFixed(1), mole: g.roles[st.by] === 'mole' };
      g.scenes.push(scene);
      rec.visits.push({ from: st.by, to: st.victim, kind: 'kill', hidden: scene.mole });
    }
    // The bell: who rang it, and who was closest to the tombstone at that moment (public)
    let bell = null;
    if (n.bell) {
      const how = (d) => (d <= 6 ? 'right next to it' : d <= 13 ? 'close by' : 'not far');
      bell = { by: n.bell.by, victim: n.bell.victim, near: n.bell.near.map((x) => ({ id: x.id, how: how(x.d) })), left: g.bellsLeft };
      rec.bell = bell;
    }
    g.trackLog[night] = g.tracks;
    rec.scene = scene ? [`near ${scene.zone}`] : null;
    rec.culprit = st ? st.by : null;
    g.history.push(rec);

    // Deaths
    for (const id of died) this.kill(id, 'night');
    g.events.push({ id: g.eventSeq++, type: 'dawn', night, died, saved: rec.saved, lit: [], zone: scene ? scene.zone : null, outs: g.outs, lampOuts: g.lampOuts, bell });
    if (died.length) this.log(`Dawn. ${died.map((d) => this.name(d)).join(', ')} was spirited away near ${scene.zone}${scene.mole ? '. There were no footprints, only fresh dirt 🕳️' : ''}. Their notepad was left behind.`);
    else if (rec.saved) this.log('Dawn. Everyone is safe. Someone was protected in the night!');
    else this.log('Dawn. Everyone woke up safe.');
    if (bell) this.log(bell.victim
      ? `🔔 ${this.name(bell.by)} rang the bell after ${this.name(bell.victim)} went missing. ${bell.near.length ? `When it rang, closest to the tombstone: ${bell.near.map((x) => `${this.name(x.id)} (${x.how})`).join(', ')}.` : 'When it rang, nobody was near the tombstone.'} ${bell.left} bell ring${bell.left === 1 ? '' : 's'} left this game.`
      : `🔔 ${this.name(bell.by)} rang the bell before anyone went missing, and the night ended early. ${bell.left} bell ring${bell.left === 1 ? '' : 's'} left this game.`);
    if (g.outs.length) this.log(`🏮 Lanterns went dark tonight near ${g.outs.map((o) => `${o.zone} (${o.when})`).join(', ')}.`);
    if (g.lampOuts.length) this.log(`💨 A street lamp was blown out near ${g.lampOuts.map((o) => o.zone).join(', ')}.`);
    g.settleLeft = Math.max(0, (g.settleLeft || 0) - 1);
    g.settling = g.settleLeft > 0;
    if (this.checkWin()) return;
    this.setPhase('dawn', BASE.dawn * this.mult(), () => this.startDay());
  }

  kill(id, how) {
    const g = this.game;
    g.alive.delete(id);
    g.deaths.push({ id, day: g.day, how });
    delete g.yarn[id]; g.ready.delete(id);
    this.priv(id, 'You are a Wisp now. You can read every chat, including the Sneak Den, and talk with other Wisps.');
  }

  startDay() {
    const g = this.game;
    g.ready = new Set(); g.noms = {}; g.nominees = []; g.votes = {};
    const secs = Math.min(150, Math.max(90, 15 * g.alive.size));
    this.log(`Day ${g.day}. Talk it over${g.bigGame ? ', then nominate up to 3 suspects' : ''}.`);
    this.setPhase('day', secs * this.mult(), () => this.endDiscussion());
  }
  endDiscussion() {
    const g = this.game;
    if (g.bigGame) {
      const tally = {};
      for (const [id, t] of Object.entries(g.noms)) if (g.alive.has(id) && g.alive.has(t)) tally[t] = (tally[t] || 0) + 1;
      const sorted = shuffle(Object.keys(tally)).sort((a, b) => tally[b] - tally[a]);
      g.nominees = sorted.slice(0, 3);
      if (!g.nominees.length) { this.log('Nobody was nominated today.'); return this.nextNight(); }
      g.defenseIdx = 0;
      this.log(`Nominated: ${g.nominees.map((x) => this.name(x)).join(', ')}. Each gets 15 seconds to defend themselves.`);
      return this.setPhase('defense', BASE.defense * this.mult(), () => this.nextDefense());
    }
    g.nominees = [...g.alive];
    this.setPhase('vote', BASE.vote * this.mult(), () => this.endVote());
  }
  nextDefense() {
    const g = this.game;
    g.defenseIdx++;
    if (g.defenseIdx < g.nominees.length) return this.setPhase('defense', BASE.defense * this.mult(), () => this.nextDefense());
    this.setPhase('vote', BASE.vote * this.mult(), () => this.endVote());
  }
  endVote() {
    const g = this.game;
    const tally = {}; let skip = 0;
    for (const [id, t] of Object.entries(g.votes)) {
      if (!g.alive.has(id)) continue;
      const w = g.turtles.has(id) ? 2 : 1;
      if (t === 'skip') skip += w;
      else if (g.nominees.includes(t) && g.alive.has(t)) tally[t] = (tally[t] || 0) + w;
    }
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    let out = null;
    if (sorted.length && sorted[0][1] > skip && (sorted.length === 1 || sorted[0][1] > sorted[1][1])) out = sorted[0][0];
    g.events.push({ id: g.eventSeq++, type: 'pond', day: g.day, out, tally, skip });
    if (out) {
      this.log(`The village sends ${this.name(out)} into the Pond. Splash! Their notepad was left behind.`);
      this.kill(out, 'pond');
      if (g.roles[out] === 'frog') g.soloWins.add(out);
    } else this.log('No clear majority, so nobody goes into the Pond today.');
    if (this.checkWin()) return;
    this.nextNight();
  }

  checkWin() {
    const g = this.game;
    const alive = [...g.alive];
    const S = alive.filter((id) => isSneakTeam(g.roles[id])).length;
    const O = alive.length - S;
    let team = null;
    if (S === 0) team = 'village'; else if (S >= O) team = 'sneaks';
    if (!team) return false;
    this.endGame(team); return true;
  }
  endGame(team) {
    const g = this.game;
    this.clearTimers();
    g.winner = team;
    for (const id of g.houses) {
      const r = g.roles[id];
      if (ROLES[r].team === team) g.winnerIds.add(id);
      if (r === 'moth' && g.alive.has(id)) g.winnerIds.add(id);
    }
    g.soloWins.forEach((id) => g.winnerIds.add(id));
    g.phase = 'over'; g.endsAt = 0;
    this.log(team === 'village' ? 'Every Sneak is in the Pond. The village wins!' : 'The Sneaks now match the village. The Sneaks win!');
    for (const p of this.players) p.games = (p.games || 0) + 1;
    this.broadcast({ t: 'gameover' });
    this.changed();
  }

  // ---------- day actions ----------
  dayPhase() { return ['day', 'defense', 'vote', 'dawn'].includes(this.game.phase); }
  // Board: a free sticky-note wall. Notes are in players' own words; nothing forces a role reveal.
  post(p, m) {
    const g = this.game;
    if (!g.alive.has(p.id) || !this.dayPhase()) return;
    if (g.board.filter((c) => c.by === p.id && c.day === g.day).length >= 5) return;
    const text = clean(String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 140));
    if (!text) return;
    const sticker = STICKERS.includes(m.sticker) ? m.sticker : 'theory';
    const tags = [...new Set(Array.isArray(m.tags) ? m.tags : [])].filter((x) => this.get(x)).slice(0, 3);
    g.board.push({ id: g.boardSeq++, by: p.id, day: g.day, sticker, text, tags, trust: [], doubt: [] });
    Hear.hear(this, p.id, text + (sticker === 'accuse' && tags.length ? ` suspect ${tags.map((x) => this.name(x)).join(' ')}` : ''));
    this.changed();
  }
  react(p, m) {
    const g = this.game;
    const c = g.board.find((x) => x.id === Number(m.id));
    if (!c || !g.alive.has(p.id) || c.by === p.id) return;
    c.trust = c.trust.filter((x) => x !== p.id); c.doubt = c.doubt.filter((x) => x !== p.id);
    if (m.v === 'trust') c.trust.push(p.id); else if (m.v === 'doubt') c.doubt.push(p.id);
    this.changed();
  }
  setYarn(p, m) {
    const g = this.game;
    if (!g.alive.has(p.id)) return;
    if (m.target && g.alive.has(m.target) && m.target !== p.id) g.yarn[p.id] = m.target; else delete g.yarn[p.id];
    this.changed();
  }
  setReady(p) {
    const g = this.game;
    if (g.phase !== 'day' || !g.alive.has(p.id)) return;
    g.ready.add(p.id);
    this.changed();
    if (g.ready.size >= Math.ceil((g.alive.size * 2) / 3)) this.shorten(10 * Math.min(1, ENV_MULT));
  }
  nominate(p, m) {
    const g = this.game;
    if (!g.bigGame || g.phase !== 'day' || !g.alive.has(p.id)) return;
    if (m.target && g.alive.has(m.target) && m.target !== p.id) g.noms[p.id] = m.target; else delete g.noms[p.id];
    this.changed();
  }
  vote(p, m) {
    const g = this.game;
    if (g.phase !== 'vote' || !g.alive.has(p.id)) return;
    if (m.target === 'skip' || (g.nominees.includes(m.target) && g.alive.has(m.target) && m.target !== p.id)) g.votes[p.id] = m.target;
    else delete g.votes[p.id];
    this.changed();
    if ([...g.alive].every((id) => id in g.votes)) this.shorten(2 * Math.min(1, ENV_MULT));
  }
  reveal(p) {
    const g = this.game;
    if (g.roles[p.id] !== 'turtle' || !g.alive.has(p.id) || g.turtles.has(p.id) || !this.dayPhase()) return;
    g.turtles.add(p.id);
    this.log(`${p.name} reveals they are the Elder Turtle! Their vote now counts double.`);
    this.changed();
  }
  note(p, m) {
    const g = this.game;
    if (!g.alive.has(p.id)) return;
    const text = clean(String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200));
    if (!text) return;
    const used = g.notes[p.id].reduce((s, n) => s + n.text.length, 0);
    if (used + text.length > NOTE_LIMIT) return;
    const label = g.phase === 'night' ? `Night ${g.day}` : `Day ${g.day}`;
    g.notes[p.id].push({ stamp: label, text });
    this.changed();
  }

  // ---------- what each player is allowed to see ----------
  view(pid) {
    const base = {
      t: 'state', now: Date.now(), code: this.code, isPublic: this.isPublic, practice: this.practice,
      hostId: this.hostId, me: pid, settings: this.settings, autoStartAt: this.autoStartAt,
      sprout: !!(this.pool && this.pool.endsWith(':sprout')),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, critter: p.critter, color: p.color, hat: p.hat, isAI: p.isAI,
        aiLevel: p.isAI ? p.aiLevel : undefined, connected: p.connected, sprout: !p.isAI && (p.games || 0) < 5,
      })),
      lobbyChat: this.lobbyChat.slice(-60),
    };
    const g = this.game;
    if (!g) return base;
    const over = g.phase === 'over';
    const role = g.roles[pid];
    const alive = g.alive.has(pid);
    const sneak = isSneakTeam(role);
    base.game = {
      phase: g.phase, day: g.day, endsAt: g.endsAt, settling: g.settling, bigGame: g.bigGame, n: g.n,
      houses: g.houses, alive: [...g.alive],
      log: g.log.slice(-100),
      deaths: g.deaths.map((d) => ({ ...d, notes: g.notes[d.id] })),
      board: g.board, yarn: g.yarn, noms: g.noms, nominees: g.nominees, defenseIdx: g.defenseIdx,
      votes: g.votes, readyCount: g.ready.size, turtles: [...g.turtles], events: g.events.slice(-6),
      myRole: role, myLog: g.priv[pid] || [], myNotes: g.notes[pid] || [],
      myAction: g.actions[pid] || null,
      world: g.world, nightDur: g.nightDur, scenes: g.scenes, tracks: g.phase === 'night' ? [] : g.tracks, outs: g.outs,
      nightConst: { light: Night.LIGHT, keen: Night.LIGHT_KEEN, dark: Night.DARK_SIGHT, lamp: Night.LAMP_LIGHT, porch: Night.PORCH_LIGHT, strike: Night.STRIKE_RANGE, house: Night.HOUSE_RANGE, lampR: Night.LAMP_RANGE, speed: Night.SPEED, hold: Night.HOLD_TIME, errand: Night.ERRAND_RANGE },
      bellsLeft: g.bellsLeft === undefined ? (g.n >= 8 ? 3 : 2) : g.bellsLeft,
      nightTasks: g.phase === 'night' && g.night && g.night.tasks ? g.night.tasks[pid] || null : null,
      attempted: isSneakTeam(role) && g.night ? !!g.night.attempted : undefined,
      iReady: g.ready.has(pid), lastProtect: g.lastProtect[pid] || null, lastLight: g.lastLight[pid] || null,
      myMeddle: role === 'trickster' ? g.meddles[pid] || null : null, lastMeddle: role === 'trickster' ? g.lastMeddle[pid] || null : null,
      team: sneak || over ? g.houses.filter((id) => isSneakTeam(g.roles[id])) : null,
      teamRoles: sneak ? Object.fromEntries(g.houses.filter((id) => isSneakTeam(g.roles[id])).map((id) => [id, g.roles[id]])) : null,
      chat: {
        day: g.chat.day.slice(-80),
        den: sneak || !alive || over ? g.chat.den.slice(-80) : [],
        wisp: !alive || over ? g.chat.wisp.slice(-80) : [],
      },
      over: over ? { winner: g.winner, winners: [...g.winnerIds], roles: g.roles, notes: g.notes, history: g.history } : null,
    };
    return base;
  }
}

module.exports = { Room, sanitizeProfile };
