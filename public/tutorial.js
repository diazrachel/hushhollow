/* First Night: a scripted, playable tutorial. Runs entirely in the browser. */
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function open(opts) {
    const { profile, modal, closeModal, avatar, cottage, onDone, onPractice } = opts;
    const you = { id: 'you', name: profile.name || 'You', critter: profile.critter, color: profile.color, hat: profile.hat };
    const cast = [
      you,
      { id: 'pip', name: 'Pip', critter: 'bunny', color: 'honey', hat: 'flower' },
      { id: 'clover', name: 'Clover', critter: 'duck', color: 'mint', hat: 'bow' },
      { id: 'bramble', name: 'Bramble', critter: 'bear', color: 'sky', hat: 'cap' },
      { id: 'mochi', name: 'Mochi', critter: 'cat', color: 'berry', hat: 'none' },
      { id: 'fig', name: 'Fig', critter: 'frog', color: 'lilac', hat: 'mushroom' },
    ];
    const byId = Object.fromEntries(cast.map((c) => [c.id, c]));
    const st = { step: 0, flipped: false, checked: false, noted: false, guessed: false, posted: new Set(), voted: false, den: false, msg: '' };
    const dead = () => {
      const d = new Set();
      if (st.step >= 3) d.add('clover');
      if (st.step >= 5 && st.voted) d.add('bramble');
      if (st.step >= 6) d.add('you');
      if (st.step >= 7) d.add('fig');
      return d;
    };

    function mini(targets = [], marks = {}) {
      const d = dead();
      return `<div class="mini-map">
        <div class="pond"><span class="pond-icon" style="font-size:.95rem;font-family:var(--display);color:#fff;text-shadow:0 2px 0 rgba(0,0,0,.3)">${marks.pond || ''}</span></div>
        ${cast.map((c, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / cast.length;
          const x = 50 + 38 * Math.cos(a), y = 50 + 38 * Math.sin(a);
          const cls = ['house', c.id === 'you' && 'me', d.has(c.id) && 'dead', targets.includes(c.id) && 'target', marks.picked === c.id && 'picked'].filter(Boolean).join(' ');
          const badge = (marks.badges || {})[c.id];
          return `<button class="${cls}" data-t="${c.id}" style="left:${x}%;top:${y}%"><span class="badges">${badge ? `<span>${badge}</span>` : ''}</span>
            ${cottage(c)}<span class="critter">${avatar(c)}</span><span class="nameplate">${esc(c.name)}</span></button>`;
        }).join('')}</div>`;
    }

    const steps = [
      { // 0
        say: () => `Welcome to Hush Hollow, ${esc(you.name)}! I'm Grandma Badger. A few critters in our village are secretly <b>Sneaks</b>. Each night they spirit someone away. Your job: find them before they outnumber us.`,
        scene: () => mini([], { pond: 'The Pond' }),
        ready: () => true,
      },
      { // 1
        say: () => st.flipped ? "You're the <b>Owl</b>! Each night you watch one critter and get a hint about whether a Sneak is nearby. Keep it quiet at first: Sneaks love to spirit away Owls."
          : 'Every critter gets a secret role. Tap your role card to read yours.',
        scene: () => `<div class="flip-card" data-flip>${st.flipped ? '<div style="font-size:3rem">🦉</div><h3>Owl</h3><p class="small">Watch one critter each night for a hint.</p>' : '<div style="font-size:3rem">❓</div><p><b>Tap to reveal</b></p>'}</div>`,
        ready: () => st.flipped,
      },
      { // 2
        say: () => !st.checked ? "Night falls, and it's dark! In a real game you walk the village with your lantern (WASD or drag) and <b>hold E</b> at a door to use your ability. The first night is a settling-in night, so nobody vanishes. Tap <b>Pip's</b> house to watch Pip."
          : !st.noted ? "The Owl never gets a straight answer. The game adds two random critters to the one you watched, and tells you one true thing about the group: either <b>at least one is a Sneak</b>, or the fuzzier <b>at least one is NOT a Sneak</b>. Write it down! If you're ever spirited away, the whole village reads your notepad."
          : 'Perfect. One hint is fuzzy. Several hints together tell a story.',
        scene: () => mini(st.checked ? [] : ['pip'], { pond: 'Night 1', picked: st.checked ? 'pip' : null })
          + (st.checked ? `<div class="clue" style="margin-top:.6rem">🦉 At least one of Pip, Bramble, and Fig is a Sneak.</div>
            <div class="behind" style="margin-top:.6rem"><b>Your notepad</b><ol>${st.noted ? '<li><span class="stamp">Night 1</span>At least one of Pip, Bramble, and Fig is a Sneak.</li>' : ''}</ol>
            ${st.noted ? '' : '<button class="btn small" data-note>Write it in my Notepad</button>'}</div>` : ''),
        ready: () => st.noted,
      },
      { // 3
        say: () => !st.guessed ? "Night 2. You watched again while everyone roamed with their lanterns. At dawn… <b>Clover</b> is gone, taken by the Bakery! Put it together: your hints, who <i>you</i> saw last night, and the footprints. Who do you suspect most? Tap them."
          : "Sharp thinking! Bramble is in BOTH of your hints, you saw him near the Bakery with his lantern <b>off</b>, and the large paw tracks fit a bear 🐻. Villagers sometimes go dark too, so it's a hint, not proof, but this one adds up.",
        scene: () => mini(st.guessed ? [] : ['pip', 'bramble', 'mochi', 'fig'], { pond: 'Dawn', picked: st.guessed ? 'bramble' : null })
          + `<div class="behind" style="margin-top:.6rem"><b>Your notepad</b><ol><li><span class="stamp">Night 1</span>At least one of Pip, Bramble, and Fig is a Sneak.</li><li><span class="stamp">Night 2</span>At least one of Bramble, Mochi, and Clover is a Sneak.</li></ol></div>
          <div class="behind" style="margin-top:.4rem"><b>👀 Who you saw last night</b><p class="small" style="margin:.2rem 0 0;font-weight:700">You were around the Bakery and the Pond. You saw Pip (the Pond, lantern on), Bramble (the Pond → the Bakery, lantern OFF 🌑).</p></div>
          <div class="scene-box"><b>👣 The morning report</b><ul><li>Clover vanished by the Bakery, around midnight.</li><li>Replaying the footprints: large paws walked up to that spot and hurried away.</li></ul></div>${st.msg ? `<p class="tut-scene-text">${st.msg}</p>` : ''}`,
        ready: () => st.guessed,
      },
      { // 4
        say: () => st.posted.has('note') ? 'Perfect. The village is looking at Bramble now, and nobody knows you\'re the Owl. Bramble does not look happy… 😤'
          : st.posted.has('owl') ? "Whoa, careful! Shout that and every Sneak knows who to spirit away tonight. In Hush Hollow you never <i>have</i> to reveal your role. Try a sneakier way."
          : 'Time to talk! You <b>could</b> announce you\'re the Owl… but the Sneaks are listening. Pin a note on the <b>Board</b> instead. Write anything you like: theories, accusations, questions. Anyone can lie, so stay sharp. Pick one:',
        scene: () => {
          const opts = [['owl', '🦉 "I\'m the Owl! Listen to me!"'], ['note', '🚨 "Not saying how I know, but Bramble was out late the night Clover vanished 👀"']];
          return `<div style="display:flex;flex-direction:column;gap:.5rem;align-items:center">${opts.map(([k, l]) => `<button class="btn small ${st.posted.has(k) && k === 'note' ? 'on' : ''}" data-post="${k}" ${st.posted.has('note') ? 'disabled' : ''} style="white-space:normal">${l}</button>`).join('')}</div>
            ${st.posted.has('note') ? `<div class="note-card accuse" style="margin-top:1.1rem"><div class="note-top">${avatar(you, 'xs')}<b>${esc(you.name)}</b><span class="note-st">🚨 Accuse</span></div>
              <div class="note-text">Not saying how I know, but Bramble was out late the night Clover vanished 👀</div><div class="note-tags"><span class="tag">Bramble</span></div>
              <div class="react"><button>👍 2</button><button>👎 1</button></div></div>` : ''}`;
        },
        ready: () => st.posted.has('note'),
      },
      { // 5
        say: () => !st.voted ? 'Time to vote! Tap the house of the critter you want to send into the Pond. Everyone can see who votes for whom.'
          : "Splash! Bramble goes into the Pond. Bramble's role stays secret… but read the notepad: it's empty. A real villager would have written something down. Very suspicious!",
        scene: () => mini(st.voted ? [] : ['pip', 'bramble', 'mochi', 'fig'], { pond: st.voted ? 'Splash!' : 'Vote!', badges: { mochi: '🤔', pip: '🙏', fig: '👀', bramble: '😤' } })
          + (st.voted ? '<div class="behind" style="margin-top:.6rem"><b>Bramble left behind:</b><p class="small muted" style="margin:.3rem 0 0">Their notepad was empty.</p></div>' : '')
          + (st.msg ? `<p class="tut-scene-text">${st.msg}</p>` : ''),
        ready: () => st.voted,
      },
      { // 6
        say: () => !st.den ? "Night 3… uh oh. A Sneak got you! Don't worry: eliminated critters become <b>Wisps</b>. Wisps can read every chat, even the Sneaks' secret Den. Take a peek."
          : "Wisps can't talk to the living, so you can't warn anyone. But your notepad is now public, and it already points the village toward Bramble's partner…",
        scene: () => mini([], { pond: 'Night 3' }) + (st.den
          ? `<div class="behind" style="margin-top:.6rem"><b>🌑 Sneak Den</b><div class="msg">${avatar(byId.fig, 'xs')}<div><b>Fig</b> they got Bramble 😭 the Owl's notes are gonna expose me</div></div></div>`
          : '<div class="row" style="justify-content:center;margin-top:.6rem"><button class="btn" data-den>Open the Den</button></div>'),
        ready: () => st.den,
      },
      { // 7
        say: () => `The village read your notepad: Bramble or Fig, and Bramble is gone. They sent Fig into the Pond. Fig was the last Sneak. <b>The village wins!</b> At the end of every game you see who was who and what really happened. You're ready, ${esc(you.name)}. Here's a Sprout Leaf for your hat. 🌱`,
        scene: () => `<div class="recap-night tut"><b>What really happened</b><ul>
          <li>Night 1: you watched Pip. Clover (Gossip Bunny) saw Bramble visit Pip's house.</li>
          <li>Night 2: 🌑 Bramble went after Clover, the only one who had seen him.</li>
          <li>Night 3: 🌑 Fig went after you.</li>
          <li>Roles: Bramble 🌑 Sneak, Fig 🌑 Sneak, everyone else 🏡 Village.</li></ul></div>`,
        ready: () => true,
        last: true,
      },
    ];

    function render() {
      const s = steps[st.step];
      const m = modal(`<div class="tut">
        <div class="tut-progress">${steps.map((_, i) => `<span class="${i <= st.step ? 'on' : ''}"></span>`).join('')}</div>
        <div class="badger"><div class="face" aria-hidden="true">🦡</div><div class="bubble">${s.say()}</div></div>
        <div>${s.scene()}</div>
        <div class="row" style="justify-content:flex-end">
          ${s.last ? '<button class="btn" data-practice>Try a Practice Burrow</button><button class="btn primary" data-done>Finish</button>'
            : `<button class="btn primary" data-next ${s.ready() ? '' : 'disabled'}>Next</button>`}
        </div></div>`, 'wide');
      m.addEventListener('click', onClick);
    }

    function onClick(e) {
      const s = st.step;
      if (e.target.closest('[data-next]')) { st.step++; st.msg = ''; return render(); }
      if (e.target.closest('[data-done]')) { onDone(); closeModal(); return; }
      if (e.target.closest('[data-practice]')) { onDone(); onPractice(); return; }
      if (e.target.closest('[data-flip]')) { st.flipped = true; return render(); }
      if (e.target.closest('[data-note]')) { st.noted = true; return render(); }
      if (e.target.closest('[data-den]')) { st.den = true; return render(); }
      const post = e.target.closest('[data-post]');
      if (post) { st.posted.add(post.dataset.post); return render(); }
      const h = e.target.closest('[data-t]');
      if (!h) return;
      const t = h.dataset.t;
      if (s === 2 && !st.checked) { if (t === 'pip') st.checked = true; else st.msg = ''; return render(); }
      if (s === 3 && !st.guessed) {
        if (t === 'bramble') { st.guessed = true; st.msg = ''; }
        else if (t === 'pip') st.msg = 'You saw Pip with a lit lantern by the Pond, and Pip is a medium-sized bunny. The tracks were large.';
        else if (t === 'fig') st.msg = 'Fig is in your first hint, but Fig is a tiny frog, and the tracks were large. Who fits every clue?';
        else if (t === 'mochi') st.msg = 'Mochi is only in your second hint. Who shows up in both?';
        return render();
      }
      if (s === 5 && !st.voted) {
        if (t === 'bramble') { st.voted = true; st.msg = ''; }
        else if (t !== 'you' && t !== 'clover') st.msg = 'Your hints point somewhere else. Who did Clover see?';
        return render();
      }
    }

    render();
  }

  window.HHTutorial = { open };
})();
