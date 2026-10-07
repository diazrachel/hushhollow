# Hush Hollow 🌙

A free, cozy social deduction game you play in the browser. A few critters in the village are secretly **Sneaks**. Find them before they take over. No accounts, no downloads, no ads.

- 4 to 14 players, roles auto-balanced for every lobby size
- Quick Play with strangers (by language), or private burrows with a 4-letter code and share link
- Add AI critters (Sleepy, Clever, Cunning) to fill any lobby
- Night walks: every critter wanders somewhere each night and sees who else is out (sometimes only "a large critter"), so everyone has alibis to check
- Crime scenes: vague public clues (pawprint size, flour from the Bakery, a tuft of fur) whenever someone vanishes
- Hints, not answers: every info role gets fuzzy information you have to reason about
- Role reveal cards, phase banners, a morning report, animated vote results, and AI critters that chat
- Private Notepad that becomes public when you're eliminated (roles are never revealed until the end)
- A Board where anyone can pin notes in their own words (theories, accusations, defenses, questions). Nothing forces a role reveal; it's a bluffing game
- Light and dark mode (follows your device, or toggle with the 🌙 button)
- First Night tutorial, Practice Burrow, and the Hollow Handbook
- Server-authoritative: nobody can see roles by opening DevTools

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. To test multiplayer on one computer, open a second browser (or a private window) and join with the burrow code.

## Put it online (free)

GitHub Pages only hosts static files, and this game needs a small Node server for the live multiplayer. Push the repo to GitHub, then connect it to a free host that runs Node:

**Render (easiest):** go to render.com → New → Blueprint → pick your repo. The included `render.yaml` sets everything up. The free plan sleeps after 15 minutes without visitors, so the first load after a break takes about 30 seconds.

**Railway or Fly.io:** create a new project from your GitHub repo. Start command: `npm start`. Both set the `PORT` variable automatically.

Any host works as long as it supports WebSockets and runs `npm start`.

## Talking AI critters

AI critters reply in chat when you name them ("Mochi, what's your role?") or ask the group ("who's sus?"). They answer from their real role and what they actually know. Sneaks lie and keep a cover story, and AI Sneak teammates follow your call in the Den.

This works out of the box for free. For smarter replies in any language, with a personality per critter, add an Anthropic API key:

1. Get a key at https://platform.claude.com (pay as you go; replies use Claude Haiku and cost a fraction of a cent each).
2. In Render, open your service → **Environment** → add `ANTHROPIC_API_KEY` with your key → Save. Render redeploys automatically.

Optional spending caps (environment variables): `AI_MAX_REPLIES_PER_GAME` (default 80) and `AI_MAX_REPLIES_PER_MINUTE` (default 30, across the whole server). When a cap is reached, critters quietly switch back to the free brain.

## How it's built

```
server/
  index.js   HTTP server, WebSockets, Quick Play matchmaking, reconnects, cleanup
  room.js    The game engine: phases, night actions, hints, votes, notepads, what each player may see
  roles.js   Roles, point values, and the auto-balancer for 4–14 players
  ai.js      Rule-based AI critters (they use the same actions as humans, no peeking)
  talk.js    AI chat replies: free rule-based brain + optional Claude brain
  hear.js    Lets AI critters understand what players say in chat and on the Board (including alibis)
  world.js   Critter sizes, fur colors, and night-walk spots
  filter.js  Chat and nickname filter
public/
  index.html, style.css
  app.js       The client: home, lobby, game board, Board, Notepad, chat, recap
  data.js      Critters, colors, hats, role text, handbook text
  tutorial.js  The First Night tutorial
```

The server owns every secret. Clients send intents ("I visit house 4") and only receive `room.view(playerId)`, which strips everything that player isn't allowed to know.

## Roles

| Role | Team | Ability |
|---|---|---|
| Villager | Village | No ability: a voice and a vote. Always the most common role |
| Owl | Village | Watch a critter: get one true fuzzy hint about them + 2 random others. 1 per game (2 at 9+ players) |
| Hedgehog | Village | Protect a critter from the Sneaks (not the same one twice in a row) |
| Gossip Bunny | Village | Watch a house: learn who visited, but not why |
| Elder Turtle | Village | Reveal once during the day for a double vote |
| Lantern Keeper | Village | Light a house for the next night; Sneaks can't reach it |
| Sneak | Sneaks | Vote with the team on who to spirit away |
| Trickster | Sneaks | Also meddles with one critter a night, slightly scrambling their info |
| Shadow Mole | Sneaks | Invisible to the Bunny; lets the team tunnel under lanterns |
| Pond Frog | Solo | Wins if voted into the Pond |
| Wandering Moth | Solo | Wins if alive at the end |

Up to 3 Sneaks, each a different type picked at random. Every role except Villager and Owl appears at most once per game.

Spice levels: **Cozy** (Owl, Hedgehog, Gossip Bunny, Lantern Keeper), **Classic** (+ Elder Turtle), **Chaos** (+ solo roles).

## Tuning balance

Setups per player count live in `server/roles.js` (`sneakCount`, `owlCount`, and `extraPowerRange`). They were tuned with thousands of simulated AI games, aiming for the village to win 45–55% of the time. Real human games will play differently, so adjust as you collect results.

To run the game fast for testing: `SPEED_MULT=0.2 npm start` makes every timer 5× shorter.

## License

MIT. Make it yours.
