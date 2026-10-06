// Simple chat + nickname filter. Add more words to BLOCKED as needed.
const BLOCKED = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'whore', 'slut', 'bastard',
  'asshole', 'nigger', 'nigga', 'faggot', 'retard', 'kys',
];
// Catch simple letter swaps like sh1t or f*ck
const LEET = { a: '[a@4]', e: '[e3]', i: '[i1!]', o: '[o0]', s: '[s$5]', u: '[u*v]', t: '[t7]' };
const patterns = BLOCKED.map((w) => new RegExp(w.split('').map((c) => LEET[c] || c).join('[\\W_]*'), 'gi'));

function clean(text) {
  let out = String(text || '');
  for (const p of patterns) out = out.replace(p, (m) => '♡'.repeat(Math.min(m.length, 6)));
  return out;
}

function cleanName(name) {
  let n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  n = clean(n);
  return n || 'Critter';
}

module.exports = { clean, cleanName };
