// Role definitions + auto-balancing for 4–14 players.
// `night` is the kind of action the role takes at night.

const ROLES = {
  villager: { name: 'Villager', team: 'village', points: 1, night: null },   // no ability: just a voice and a vote
  owl:      { name: 'Owl', team: 'village', points: 5, night: 'check' },
  hedgehog: { name: 'Hedgehog', team: 'village', points: 5, night: 'protect' },
  bunny:    { name: 'Gossip Bunny', team: 'village', points: 5, night: 'gossip' },
  turtle:   { name: 'Elder Turtle', team: 'village', points: 3, night: null },
  lantern:  { name: 'Lantern Keeper', team: 'village', points: 5, night: 'light' },
  sneak:    { name: 'Sneak', team: 'sneaks', points: -6, night: 'kill' },
  trickster:{ name: 'Trickster', team: 'sneaks', points: -7, night: 'kill' },
  mole:     { name: 'Shadow Mole', team: 'sneaks', points: -7, night: 'kill' },
  frog:     { name: 'Pond Frog', team: 'frog', points: -2, night: null },
  moth:     { name: 'Wandering Moth', team: 'moth', points: -1, night: null },
};

const isSneakTeam = (role) => ROLES[role] && ROLES[role].team === 'sneaks';

// ---- Composition rules ----
// - Villagers have no ability and are always the most common role.
// - Owls: 1 under 13 players, 2 at 13+.
// - Sneaks: up to 3, each a different type (Sneak, Trickster, Shadow Mole), picked at random.
// - Every other role appears at most once.
const SNEAK_TYPES = ['sneak', 'trickster', 'mole'];
function sneakCount(n) { if (n <= 8) return 1; if (n <= 12) return 2; return 3; }
const owlCount = (n) => (n >= 13 ? 2 : 1);
// Village roles besides the Owl(s), by player count (tuned with simulations)
function extraPowerRange(n) {
  const table = { 4: [0, 0], 5: [0, 1], 6: [1, 2], 7: [1, 1], 8: [0, 1], 9: [3, 3], 10: [2, 3], 11: [2, 3], 12: [2, 3], 13: [3, 4], 14: [3, 4] };
  return table[n] || [3, 4];
}
function soloRange(n, spice) {
  if (spice !== 'chaos' || n < 6) return [0, 0];
  if (n <= 9) return [0, 1];
  return [1, 1];
}
const POOLS = { cozy: ['hedgehog', 'bunny'], classic: ['hedgehog', 'bunny', 'turtle', 'lantern'], chaos: ['hedgehog', 'bunny', 'turtle', 'lantern'] };

const rint = (a, b, rng) => a + Math.floor(rng() * (b - a + 1));
const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];
function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// The village side of one candidate setup (sneaks are chosen separately, at random)
function villageSide(n, spice, sneaks, rng) {
  const owls = owlCount(n);
  const roles = Array(owls).fill('owl');
  const pool = POOLS[spice] || POOLS.cozy;
  const [emin, emax] = extraPowerRange(n);
  // Hedgehog comes first so every game with an extra role can protect someone
  const order = ['hedgehog', ...shuffle(pool.filter((r) => r !== 'hedgehog'), rng)];
  const extras = order.slice(0, Math.min(pool.length, rint(emin, emax, rng)));
  roles.push(...extras);
  const [smin, smax] = soloRange(n, spice);
  roles.push(...shuffle(['frog', 'moth'], rng).slice(0, rint(smin, smax, rng)));
  // Villagers must outnumber every other role (so more than the Owls)
  while (n - sneaks - roles.length <= owls && roles.length > owls) roles.pop();
  while (sneaks + roles.length < n) roles.push('villager');
  return roles;
}

// Builds a balanced setup: Sneak types are random, then the village side is chosen from
// many legal candidates, keeping the one whose point total is closest to 0.
function generateSetup(n, spice = 'cozy', rng = Math.random) {
  const sneaks = shuffle(SNEAK_TYPES, rng).slice(0, sneakCount(n));
  const sneakPts = sneaks.reduce((sum, r) => sum + ROLES[r].points, 0);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 200; i++) {
    const side = villageSide(n, spice, sneaks.length, rng);
    const score = Math.abs(sneakPts + side.reduce((sum, r) => sum + ROLES[r].points, 0)) + rng() * 0.5;
    if (score < bestScore) { best = side; bestScore = score; }
  }
  return shuffle([...sneaks, ...best], rng);
}

module.exports = { ROLES, isSneakTeam, generateSetup, shuffle, pick };
