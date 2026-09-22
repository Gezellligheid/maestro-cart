# Maestro Kart Bros

Peer-to-peer 3D arcade kart racer: Three.js + Rapier3D (WASM) + PeerJS, built with Vite + Tailwind.

## Run / deploy

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
```

Vercel: import the Git repo; `vercel.json` sets the Vite build (`dist/`). No server code — PeerJS's
public broker handles signalling only; gameplay traffic is direct WebRTC.

## How a session works

- **Rounds**: every race generates a new circuit from a seed (the host sends the seed, so all peers
  build the same track). Most layouts are grid-based circuits (straights, hairpins, notches, chicanes);
  some are flowing loops. Themes: meadow, desert, snow (with ice patches), autumn. Tracks can include
  bridges (real elevated road over a pond) and tunnels bored through a hill.
- **Garage** (in the room lobby and between rounds): coins you're holding when a round ends (plus a
  placement bonus) are banked. Spend them on Top Speed, Acceleration, Handling and Drift Boost, and on
  cosmetic parts (bodies, spoilers, wheels, headgear) plus paint/accent colours, previewed in 3D and
  shown to everyone in the room. Everything lasts for that room / solo session only — leaving to the
  menu resets it. CPU karts get upgrades as rounds progress.
- **Ready-up**: in a room every player marks Ready in the lobby and again between rounds; the
  race starts when everyone is ready (the host can also skip the wait).
- **Style parts** are previewed on the showroom kart when clicked and only bought via the Buy button.
- **Items**: green shell, banana, mushroom and the rare Mega Mushroom (3× size for 10 s: immune to
  items, squashes karts it touches).
- **Audio**: `sound_effects/` holds the countdown, item-roulette, race-end jingle and three music
  tracks (one per circuit). Settings (gear button or Esc) has master/music/effects volume; M mutes.

## Architecture

| Path | Role |
| --- | --- |
| `src/engine/Renderer.js` | WebGL renderer, toon material cache, chase camera, instanced blob shadows |
| `src/engine/Physics.js` | Rapier world, fixed 60 Hz accumulator loop, ray helpers |
| `src/engine/Particles.js` | Typed-array particle pool on one InstancedMesh |
| `src/game/Track.js` | Seeded procedural circuit, bridges/tunnels/ice, barriers + colliders, progress queries |
| `src/game/Kart.js` | Arcade kart on a locked-rotation ball body: drift tiers, mini-turbo, spin-outs |
| `src/game/ItemSystem.js` | Item boxes, coins, pooled shells/bananas, host-authoritative events |
| `src/game/Upgrades.js` | Garage wallet, upgrade levels → physics modifiers, owned parts/look |
| `src/game/Cosmetics.js` | Kart part catalogue (geometry builders, prices), look sanitising |
| `src/game/KartRenderer.js` | All karts and parts in one `BatchedMesh` draw call |
| `src/engine/Audio.js` | WebAudio SFX (cue-aligned), streamed music, synthesized blips |
| `src/network/NetworkManager.js` | PeerJS star topology; extra `ordered:false, maxRetransmits:0` channel |
| `src/network/Protocol.js` | 44-byte binary kart records at 30 Hz |
| `src/network/Interpolator.js` | Sender-clock snapshot buffer, Hermite interpolation + dead reckoning |
| `src/main.js` | Game loop, race flow, lobby/results wiring |

Netcode model: each player simulates their own kart (instant response) and streams state; the host
is authoritative for item boxes, coins, projectile spawns, hits, and finish order.

Controls: WASD/arrows drive · Space hop/drift · Shift/E item · R respawn · M mute · Esc settings. Gamepads work too.
