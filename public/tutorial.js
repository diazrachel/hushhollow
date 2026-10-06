/* First Night: a scripted, playable tutorial. Runs entirely in the browser. */
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function open(opts) {
    const { profile, modal, closeModal, avatar, onDone, onPractice } = opts;
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
        <div class="pond" style="width:38%;height:30%"><div class="pond-text" style="font-size:.85rem">${marks.pond || ''}</div></div>
        ${cast.map((c, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / cast.length;
          const x = 50 + 38 * Math.cos(a), y = 50 + 38 * Math.sin(a);
          const cls = ['house', c.id === 'you' && 'me', d.has(c.id) && 'dead', targets.includes(c.id) && 'target', marks.picked === c.id && 'picked'].filter(Boolean).join(' ');
          return `<button class="${cls}" data-t="${c.id}" style="left:${x}%;top:${y}%">${avatar(c)}<span class="nm">${esc(c.name)}</span>
            <span class="badges">${(marks.badges || {})[c.id] || ''}</span></button>`;
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
        say: () => !st.checked ? "Night falls. The first night is a settling-in night, so nobody vanishes. Tap <b>Pip's</b> house to watch Pip."
          : !st.noted ? "The Owl never gets a straight answer. The game adds two random critters to the one you watched, and tells you whether <b>at least one</b> of them is a Sneak. Write it down! If you're ever spirited away, the whole village reads your notepad."
          : 'Perfect. One hint is fuzzy. Several hints together tell a story.',
        scene: () => mini(st.checked ? [] : ['pip'], { pond: 'Night 1', picked: st.checked ? 'pip' : null })
          + (st.checked ? `<div class="clue" style="margin-top:.6rem">🦉 At least one of Pip, Bramble, and Fig is a Sneak.</div>
            <div class="behind" style="margin-top:.6rem"><b>Your notepad</b><ol>${st.noted ? '<li><span class="stamp">Night 1</span>At least one of Pip, Bramble, and Fig is a Sneak.</li>' : ''}</ol>
            ${st.noted ? '' : '<button class="btn small" data-note>Write it in my Notepad</button>'}</div>` : ''),
        ready: () => st.noted,
      },
      { // 3
        say: () => !st.guessed ? "A quiet day passes, then night 2. You watched again: <b>none of Pip, Mochi, and Clover is a Sneak.</b> But at dawn… <b>Clover</b> is gone! Her role stays secret, but her notepad was left behind. Put it all together: who do you suspect most? Tap them."
          : 'Sharp thinking! Pip is cleared, so the Sneak from your first hint is Bramble or Fig. And Clover saw Bramble out at night. Careful though: honest critters visit houses too. A Hedgehog protecting Pip would look exactly the same.',
        scene: () => mini(st.guessed ? [] : ['pip', 'bramble', 'mochi', 'fig'], { pond: 'Dawn', picked: st.guessed ? 'bramble' : null })
          + `<div class="behind" style="margin-top:.6rem"><b>Your notepad</b><ol><li><span class="stamp">Night 1</span>At least one of Pip, Bramble, and Fig is a Sneak.</li><li><span class="stamp">Night 2</span>None of Pip, Mochi, and Clover is a Sneak.</li></ol></div>
          <div class="behind" style="margin-top:.4rem"><b>Clover left behind:</b><ol><li><span class="stamp">Night 1</span>watched Pip's house. Bramble visited.</li></ol></div>${st.msg ? `<p class="tut-scene-text">${st.msg}</p>` : ''}`,
        ready: () => st.guessed,
      },
      { // 4
        say: () => st.posted.size < 3 ? 'Now share what you know on the <b>Board</b>. Cards look the same in every language, so anyone in the world can follow along. Post all three cards. (Sneaks can post fake hint cards too!)'
          : 'Look, Mochi and Pip trust your cards. Bramble does not look happy…',
        scene: () => {
          const cards = [['owl', '🦉 I\'m the Owl.'], ['pip', '🚨 At least one of Pip, Bramble, and Fig is a Sneak.'], ['bramble', '🔍 None of Pip, Mochi, and Clover is a Sneak.']];
          return `<div class="row" style="justify-content:center">${cards.map(([k, l]) => `<button class="btn small ${st.posted.has(k) ? 'on' : ''}" data-post="${k}" ${st.posted.has(k) ? 'disabled' : ''}>${l}</button>`).join('')}</div>
            <div style="display:flex;flex-direction:column;gap:.4rem;margin-top:.7rem">${cards.filter(([k]) => st.posted.has(k)).map(([, l]) => `<div class="claim">${avatar(you, 'sm')}<div class="body"><b>${esc(you.name)}</b><br>${l}</div>
              <div class="react"><button>👍 ${st.posted.size === 3 ? 2 : 1}</button><button>👎 ${st.posted.size === 3 ? 1 : 0}</button></div></div>`).join('')}</div>`;
        },
        ready: () => st.posted.size === 3,
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
        scene: () => `<div class="recap-night"><b>What really happened</b><ul>
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
        else if (t === 'fig') st.msg = 'Possible! Fig is in your first hint too. But Clover saw someone else out at night. Look again.';
        else if (t !== 'clover' && t !== 'you') st.msg = `${byId[t].name} was cleared by your second hint. Try again.`;
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
