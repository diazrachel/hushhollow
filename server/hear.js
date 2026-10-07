// "Hearing": turns what players SAY (chat and Board notes) into claims the AI can reason about.
// Nothing here is shown to players. A claim is only as true as the critter who said it.

const ROLE_WORDS = [
  ['gossip bunny', 'bunny'], ['bunny', 'bunny'], ['elder turtle', 'turtle'], ['turtle', 'turtle'],
  ['lantern keeper', 'lantern'], ['lantern', 'lantern'], ['hedgehog', 'hedgehog'], ['hedgie', 'hedgehog'],
  ['owl', 'owl'], ['villager', 'villager'], ['frog', 'frog'], ['moth', 'moth'],
];
const { PLACES } = require('./world');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names mentioned in the text, in the order they appear
function namesIn(room, text, except) {
  const low = text.toLowerCase(), out = [];
  for (const id of room.game.houses) {
    if (id === except) continue;
    const m = new RegExp(`(^|[^a-z0-9])${esc(room.name(id).toLowerCase())}([^a-z0-9]|$)`).exec(low);
    if (m) out.push([m.index, id]);
  }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

function hear(room, by, text) {
  const g = room.game;
  if (!g || !g.alive.has(by)) return;
  const low = ` ${text.toLowerCase()} `;
  const names = namesIn(room, text, by);
  const add = (c) => g.claims.push({ id: g.claimSeq++, by, day: g.day, ...c });
  let found = false;

  // Night-walk alibis: "I was at the Bakery", "I stayed home" (+ "saw Pip there")
  const home = /\b(stayed home|was home|at home|stayed in|in my house|in bed)\b/.test(low);
  let place = null;
  for (const id of g.places || []) {
    const w = PLACES[id].name.toLowerCase();
    if (low.includes(w) || (id === 'well' && /\bwell\b/.test(low))) { place = id; break; }
  }
  const self = /\b(i was|i went|i wandered|i walked|i stayed|i'?m at|went to|walked to|wandered to)\b/.test(low);
  if (home && self) { add({ kind: 'at', place: 'home', night: g.day }); return; }
  if (place) {
    if (self) add({ kind: 'at', place, night: g.day });
    if (names.length && /\b(saw|seen|spotted|with|bumped)\b/.test(low)) add({ kind: 'seenAt', targets: names.slice(0, 3), place, night: g.day });
    if (self || names.length) return;
  }

  // "I'm the Owl", "owl here", "I'm a villager"
  const rm = /\b(?:i'?m|i am|im)\s+(?:a|an|the|actually|really|just)?\s*(?:a |an |the )?([a-z ]{3,16})/.exec(low) || /\b([a-z ]{3,14}) here\b/.exec(low);
  if (rm && !/\bnot\b/.test(rm[1])) {
    const hit = ROLE_WORDS.find(([w]) => rm[1].trim().startsWith(w));
    if (hit && !g.claims.some((c) => c.by === by && c.kind === 'role' && c.role === hit[1])) { add({ kind: 'role', role: hit[1] }); found = true; }
  }
  // "at least one of A, B, C is (NOT) a sneak"
  if (/at least one|one of (them|those)/.test(low) && names.length) {
    const not = /\b(not|isn'?t|aren'?t|innocent|clean)\b/.test(low);
    if (not || /sneak|evil|bad/.test(low)) { add({ kind: 'hint', targets: names.slice(0, 3), result: not ? 'not' : 'sneak' }); return; }
  }
  // "I saw A visit B" / "I saw A at B's house"
  if (/\b(saw|seen|spotted|caught)\b/.test(low) && names.length >= 2) { add({ kind: 'saw', target: names[0], at: names[1] }); return; }
  // "I suspect A" / "A is sus" / "vote A" / "A is the sneak"
  if (!found && names.length && /(sus|suspect|sneak|vote|liar|lying|guilty|did it|it'?s |evil|accuse|🚨|🧶)/.test(low)
    && !/\b(not|isn'?t|innocent|trust|safe|clear)\b/.test(low)) {
    if (g.alive.has(names[0])) add({ kind: 'accuse', target: names[0] });
  }
}

module.exports = { hear, namesIn };
