// Rule-based AI critters. They act through room.act() exactly like humans do,
// so they can't see anything a human in their seat couldn't.
//   sleepy  – random abilities, follows the crowd
//   clever  – reasons from hints and claims, votes on evidence, fakes claims as a Sneak
//   cunning – clever + counter-claims, bluffs, reads voting patterns

const { isSneakTeam, ROLES, pick } = require('./roles');

// ---------------- chat ----------------
const LINES = {
  mourn: ['Poor {v} 😢', 'Not {v}!! They were so nice…', 'RIP {v}. We HAVE to find who did this.', 'Noooo {v} 😭', '{v} is gone… okay, think everyone.'],
  safe: ['Phew, everyone made it!', 'Nobody vanished? Someone got protected 🦔', 'A quiet night… suspicious.'],
  accuse: ["I really think it's {t}.", '{t} has been acting weird 🤔', 'My gut says {t}.', 'Anyone else side-eyeing {t}? 👀', "{t}, explain yourself."],
  defend: ["It's not me, I promise!", "Why me?? I'm on your side 😤", "Look somewhere else, I'm innocent!", "You're wasting a vote on me.", 'I swear I was home all night 🏡'],
  owl: ['Owl here 🦉 my hints are on the Board.', "I'm the Owl. Read my hint cards!", 'Owl hints posted. Somebody in there is a Sneak.'],
  saw: ["I saw {t} at {v}'s house last night 👀", "{t} visited {v} the night they vanished. Just saying."],
  vote: ['Voting {t}.', 'Going with {t}.', 'My vote is on {t}.', '{t}. Sorry not sorry.'],
  skip: ["I'm not sure yet, skipping.", 'Skipping, not enough info.'],
  den: ["Let's get {t} tonight.", '{t} is getting too close. Them?', 'I say {t} 🌑', '{t} talks too much. Bye bye.'],
  hello: ['hi everyone!', 'good luck all 🍀', 'hiii', "let's find these Sneaks"],
};
function say(room, p, key, vars = {}, channel) {
  const g = room.game, M = mem(g, p.id);
  M.spoke = M.spoke || {};
  const slot = `${g.day}-${g.phase}`;
  if ((M.spoke[slot] || 0) >= 2) return;
  M.spoke[slot] = (M.spoke[slot] || 0) + 1;
  const text = pick(LINES[key]).replace(/\{(\w)\}/g, (_, k) => vars[k] || '');
  room.act(p.id, { t: 'chat', text, channel });
}
const shared = (g) => (g.ai._shared = g.ai._shared || { mourned: new Set(), greeted: false });

function mem(g, id) {
  if (!g.ai[id]) g.ai[id] = { claimedRole: false, posted: new Set(), notedIdx: 0, fakeNights: new Set() };
  return g.ai[id];
}
const top = (s, filter = () => true) => {
  const e = Object.entries(s).filter(([id]) => filter(id)).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : null;
};
const accusedBy = (g, id) => g.claims.filter((c) => (c.kind === 'accuse' && c.target === id)
  || (c.kind === 'hint' && c.result === 'sneak' && c.targets.length === 1 && c.targets[0] === id)
  || (c.kind === 'saw' && c.target === id)).map((c) => c.by);
const diedAtNight = (g, house, night) => g.deaths.some((d) => d.id === house && d.how === 'night' && d.day === night);

// What this AI privately learned: Owl hints and Bunny sightings
function intel(g, id) {
  const out = { hints: [], saw: [] };
  for (const e of g.priv[id] || []) {
    if (e.hint) out.hints.push(e.hint);
    if (e.saw) out.saw.push({ ...e.saw, night: e.day });
  }
  return out;
}

function suspicion(room, p) {
  const g = room.game, me = p.id, sneak = isSneakTeam(g.roles[me]);
  const others = [...g.alive].filter((id) => id !== me);
  const s = {};
  others.forEach((id) => { s[id] = Math.random() * (p.aiLevel === 'sleepy' ? 10 : 1.2); });
  if (p.aiLevel === 'sleepy') return s;
  const add = (id, v) => { if (id in s) s[id] += v; };

  // My own hints
  const { hints, saw } = intel(g, me);
  const cleared = new Set([...g.turtles]);
  for (const h of hints) {
    if (!h.yes) h.group.forEach((x) => add(x, -0.8)); // "at least one is NOT a Sneak" is weak evidence
    else {
      const left = h.group.filter((x) => !cleared.has(x) && g.alive.has(x));
      left.forEach((x) => add(x, left.length === 1 ? 40 : 6 / left.length + 1));
    }
  }
  for (const v of saw) {
    if (diedAtNight(g, v.house, v.night)) v.visitors.forEach((x) => add(x, 7));
    else v.visitors.forEach((x) => add(x, 0.4));
  }
  for (const id of others) if (g.turtles.has(id)) s[id] -= 30;

  // Cards on the Board
  const roleClaims = {};
  for (const c of g.claims) {
    if (c.kind === 'role') (roleClaims[c.role] = roleClaims[c.role] || new Set()).add(c.by);
    const w = cleared.has(c.by) ? 1.5 : 1;
    if (c.kind === 'hint') {
      if (c.result === 'not') c.targets.forEach((x) => add(x, -0.6 * w));
      else c.targets.forEach((x) => add(x, (c.targets.length === 1 ? 4 : 1.5) * w));
    }
    if (c.kind === 'saw') add(c.target, (diedAtNight(g, c.at, c.day) ? 4 : 0.5) * w);
    if (c.kind === 'accuse') add(c.target, 0.8 * w);
    // Someone lying about me (I know I'm village)
    if (!sneak && c.by !== me && ((c.kind === 'saw' && c.target === me) || (c.kind === 'accuse' && c.target === me))) add(c.by, c.kind === 'saw' ? 5 : 1);
  }
  for (const [r, set] of Object.entries(roleClaims)) {
    const limit = r === 'villager' ? 99 : r === 'owl' || r === 'hedgehog' ? 2 : 1;
    if (set.size > limit) set.forEach((id) => add(id, cleared.has(id) ? 0 : 4));
    if (!sneak && r === g.roles[me] && ['bunny', 'turtle', 'lantern'].includes(r)) set.forEach((id) => add(id, 10));
  }
  // Notepads left behind
  for (const d of g.deaths) {
    for (const n of g.notes[d.id] || []) {
      for (const id of others) {
        if (!n.text.includes(room.name(id))) continue;
        if (/not a sneak/i.test(n.text)) add(id, -0.5); else if (/is a sneak/i.test(n.text)) add(id, 1.2); else if (/visited/i.test(n.text)) add(id, 0.5);
      }
    }
  }
  if (p.aiLevel === 'cunning') {
    for (const [voter, t] of Object.entries(g.votes)) if (cleared.has(t)) add(voter, 1.5);
    for (const [from, to] of Object.entries(g.yarn)) if (cleared.has(to)) add(from, 1);
  }
  if (sneak) for (const id of others) if (isSneakTeam(g.roles[id])) s[id] = -1000;
  return s;
}

// ---------------- night ----------------
function night(room, p) {
  const g = room.game, me = p.id;
  if (!g.alive.has(me) || g.phase !== 'night') return;
  const role = g.roles[me], level = p.aiLevel;
  const others = [...g.alive].filter((id) => id !== me);
  if (!others.length) return;
  const send = (target, extra = {}) => target && room.act(me, { t: 'night', target, ...extra });
  const claimedPower = (id) => g.claims.some((c) => c.by === id && ((c.kind === 'role' && c.role !== 'villager') || c.kind === 'hint' || c.kind === 'saw'));

  if (isSneakTeam(role) && !g.settling) {
    const mole = [...g.alive].some((id) => g.roles[id] === 'mole');
    const cands = others.filter((id) => !isSneakTeam(g.roles[id]) && (!g.lit.has(id) || mole));
    if (cands.length) {
      let t;
      if (level === 'sleepy') t = pick(cands);
      else {
        const teamPicks = Object.values(g.sneakVotes).filter((x) => cands.includes(x));
        if (teamPicks.length && Math.random() < 0.75) t = pick(teamPicks);
        else {
          const score = {};
          cands.forEach((id) => {
            score[id] = Math.random() * 2 + (g.turtles.has(id) ? 3 : 0) + (claimedPower(id) ? 5 : 0);
            if (accusedBy(g, id).length) score[id] -= 1; // let the village waste a vote on them
            for (const c of g.claims) if (c.by === id && c.kind === 'accuse' && isSneakTeam(g.roles[c.target])) score[id] += 4;
          });
          t = top(score);
        }
      }
      send(t);
      const team = [...g.alive].filter((id) => isSneakTeam(g.roles[id]));
      if (t && team.length > 1 && level !== 'sleepy' && Math.random() < 0.6) setTimeout(() => {
        if (room.game === g && g.phase === 'night' && g.alive.has(me)) say(room, p, 'den', { t: room.name(t) }, 'den');
      }, 400 + Math.random() * 1500);
    }
    if (role === 'trickster' && level !== 'sleepy') {
      const pool = others.filter((id) => id !== g.lastMeddle[me] && !isSneakTeam(g.roles[id]));
      const info = pool.filter((id) => claimedPower(id));
      const target = pick(info.length ? info : pool);
      if (target && Math.random() < 0.8) room.act(me, { t: 'night', kind: 'meddle', target });
    }
    return;
  }

  const kind = isSneakTeam(role) ? 'peek' : ROLES[role].night;
  const legal = others.filter((id) => !(kind === 'protect' && id === g.lastProtect[me]) && !(kind === 'light' && id === g.lastLight[me]));
  if (level === 'sleepy') return send(pick(legal.length ? legal : others));
  const s = suspicion(room, p);
  const victimScore = (pool) => {
    const sc = {};
    pool.forEach((id) => { sc[id] = Math.random() * 2 - Math.max(0, s[id] || 0) * 0.3 + (claimedPower(id) ? 4 : 0) + (g.turtles.has(id) ? 2 : 0); });
    return top(sc);
  };
  let t;
  if (kind === 'check') t = top(s, (id) => legal.includes(id) && s[id] > -5) || pick(legal);
  else if (kind === 'protect' || kind === 'light') t = victimScore(legal);
  else if (kind === 'gossip') t = Math.random() < 0.65 ? victimScore(legal) : top(s);
  else t = Math.random() < 0.5 ? top(s) : pick(legal);
  send(t || pick(legal));
}

// ---------------- notepad ----------------
function notes(room, p) {
  const g = room.game, me = p.id, M = mem(g, me), sneak = isSneakTeam(g.roles[me]);
  if (p.aiLevel === 'sleepy' || !g.alive.has(me)) return;
  const log = g.priv[me] || [];
  const fresh = log.slice(M.notedIdx); M.notedIdx = log.length;
  for (const e of fresh) {
    if (!/^Night \d+:/.test(e.text)) continue;
    if (sneak && !/peeked/.test(e.text)) continue; // never write the real plan down
    room.act(me, { t: 'note', text: e.text.replace(/\byou\b /, '') });
  }
  if (sneak && !M.fakeNights.has(g.day) && g.day >= 2) {
    M.fakeNights.add(g.day);
    const t = pick([...g.alive].filter((id) => id !== me));
    if (t) room.act(me, { t: 'note', text: `Night ${g.day}: peeked at ${room.name(t)}'s house. ${pick(['Nobody else visited.', '1 other critter visited.'])}` });
  }
}

// ---------------- day ----------------
const claim = (room, me, data) => room.act(me, { t: 'claim', ...data });

function dayTalk(room, p) {
  const g = room.game, me = p.id;
  if (!g.alive.has(me) || g.phase !== 'day') return;
  const role = g.roles[me], level = p.aiLevel, M = mem(g, me);
  if (level === 'sleepy') { if (Math.random() < 0.35) room.act(me, { t: 'emote', e: pick(['🤔', '👀', '🙏']) }); return; }
  const s = suspicion(room, p), sneak = isSneakTeam(role);
  const accusers = accusedBy(g, me).filter((id) => g.alive.has(id));
  const { hints, saw } = intel(g, me);
  const sh = shared(g);
  const lastDawn = [...g.events].reverse().find((e) => e.type === 'dawn');
  if (lastDawn && !sh.mourned.has(lastDawn.id) && Math.random() < 0.7) {
    sh.mourned.add(lastDawn.id);
    if (lastDawn.died.length) say(room, p, 'mourn', { v: room.name(lastDawn.died[0]) }); else if (lastDawn.night > 1) say(room, p, 'safe');
    else if (!sh.greeted) { sh.greeted = true; say(room, p, 'hello'); }
  }
  if (accusers.length && Math.random() < 0.8) say(room, p, 'defend');
  const claimRole = (r) => { if (!M.claimedRole) { claim(room, me, { kind: 'role', role: r }); M.claimedRole = true; } };

  if (!sneak) {
    if (role === 'owl' && hints.length && (g.day >= 2 || accusers.length >= 2 || hints.some((h) => !h.yes))) {
      if (!M.claimedRole) say(room, p, 'owl');
      claimRole('owl');
      hints.forEach((h, i) => { if (!M.posted.has(`h${i}`)) { M.posted.add(`h${i}`); claim(room, me, { kind: 'hint', targets: h.group, result: h.yes ? 'sneak' : 'not' }); } });
    } else if (role === 'bunny') {
      saw.forEach((v, i) => {
        if (M.posted.has(`s${i}`) || !diedAtNight(g, v.house, v.night)) return;
        M.posted.add(`s${i}`); claimRole('bunny');
        if (v.visitors.length) say(room, p, 'saw', { t: room.name(v.visitors[0]), v: room.name(v.house) });
        v.visitors.forEach((x) => claim(room, me, { kind: 'saw', target: x, at: v.house }));
      });
    } else if (role === 'turtle' && !g.turtles.has(me) && g.day >= 2 && Math.random() < 0.5) {
      room.act(me, { t: 'reveal' });
    }
    if (accusers.length >= 2 && !M.claimedRole && role !== 'frog') claimRole(role === 'moth' ? 'villager' : role);
    if (role === 'frog' && accusers.length && Math.random() < 0.5) room.act(me, { t: 'emote', e: '😱' });
  } else {
    if (accusers.length >= 2 && !M.claimedRole) {
      const fake = level === 'cunning' && Math.random() < 0.5 ? 'owl' : pick(['villager', 'villager', 'hedgehog']);
      claimRole(fake);
      if (fake === 'owl') {
        const acc = accusers.find((id) => !isSneakTeam(g.roles[id]));
        const filler = [...g.alive].filter((x) => x !== me && x !== acc && !isSneakTeam(g.roles[x]));
        if (acc) claim(room, me, { kind: 'hint', targets: [acc, pick(filler)].filter(Boolean), result: 'sneak' });
      }
    }
    if (level === 'cunning') {
      // A teammate got named in a hint: muddy the water with a counter-hint
      for (const c of g.claims) {
        if (c.kind === 'hint' && c.result === 'sneak' && c.targets.some((x) => isSneakTeam(g.roles[x])) && g.alive.has(c.by)
          && !isSneakTeam(g.roles[c.by]) && !M.posted.has(`ctr${c.id}`)) {
          M.posted.add(`ctr${c.id}`);
          claimRole('owl');
          const filler = [...g.alive].filter((x) => x !== me && x !== c.by && !isSneakTeam(g.roles[x]));
          claim(room, me, { kind: 'hint', targets: [c.by, pick(filler)].filter(Boolean), result: 'sneak' });
          break;
        }
      }
      // Fake a sighting at the victim's house
      const lastDeath = g.deaths.filter((d) => d.how === 'night' && d.day === g.day).pop();
      if (lastDeath && !M.posted.has(`fs${g.day}`) && Math.random() < 0.3) {
        M.posted.add(`fs${g.day}`);
        const scapegoat = top(s);
        if (scapegoat) { claimRole('bunny'); claim(room, me, { kind: 'saw', target: scapegoat, at: lastDeath.id }); say(room, p, 'saw', { t: room.name(scapegoat), v: room.name(lastDeath.id) }); }
      }
    }
  }
  const t = top(s);
  if (t && s[t] >= (sneak ? 0.8 : 3) && !M.posted.has(`day${g.day}`) && (!sneak || Math.random() < 0.5)) {
    M.posted.add(`day${g.day}`);
    claim(room, me, { kind: 'accuse', target: t });
    if (Math.random() < 0.7) say(room, p, 'accuse', { t: room.name(t) });
  }
  if (t) room.act(me, { t: 'yarn', target: t });
  for (const c of g.claims.slice(-8)) {
    if (c.by === me) continue;
    let v = null;
    const targets = c.targets || (c.target ? [c.target] : []);
    if (targets.includes(me)) v = 'doubt';
    else if (c.kind === 'accuse' && c.target in s) v = s[c.target] > 2 ? 'trust' : s[c.target] < -5 ? 'doubt' : null;
    if (sneak && targets.some((x) => isSneakTeam(g.roles[x]))) v = 'doubt';
    if (v) room.act(me, { t: 'react', id: c.id, v });
  }
}

function dayLate(room, p) {
  const g = room.game;
  if (!g.alive.has(p.id) || g.phase !== 'day') return;
  if (g.bigGame) room.act(p.id, { t: 'nominate', target: top(suspicion(room, p)) });
  if (p.aiLevel !== 'sleepy') notes(room, p);
}

function ready(room, p) { room.act(p.id, { t: 'ready' }); }

function vote(room, p) {
  const g = room.game, me = p.id;
  if (!g.alive.has(me) || g.phase !== 'vote') return;
  const cands = g.nominees.filter((id) => id !== me && g.alive.has(id));
  if (!cands.length) return room.act(me, { t: 'vote', target: 'skip' });
  const tally = {};
  Object.values(g.votes).forEach((t) => { if (t !== 'skip') tally[t] = (tally[t] || 0) + 1; });
  const lead = (f = () => true) => top(tally, (id) => cands.includes(id) && f(id));
  if (p.aiLevel === 'sleepy') return room.act(me, { t: 'vote', target: lead() || (Math.random() < 0.6 ? pick(cands) : 'skip') });
  const s = suspicion(room, p), sneak = isSneakTeam(g.roles[me]);
  let t = top(s, (id) => cands.includes(id));
  if (sneak) { const l = lead((id) => !isSneakTeam(g.roles[id])); if (l && Math.random() < 0.6) t = l; }
  else if (t && s[t] < 1.5) t = lead() || t;
  room.act(me, { t: 'vote', target: t || 'skip' });
  if (Math.random() < 0.35) say(room, p, t && t !== 'skip' ? 'vote' : 'skip', { t: t && t !== 'skip' ? room.name(t) : '' });
}

module.exports = { night, notes, dayTalk, dayLate, ready, vote, suspicion, mem };
