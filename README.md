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
  build the same track). Layout families: grid circuits, organic loops, mountain-pass switchbacks and
  (rarely) figure-8s whose crossing becomes an overpass; the host never repeats the previous round's
  layout family or theme. Tracks get rolling hills, banked corners (up to ~18°, ~22° on Star Road),
  varying road width, jump ramps, boost pads,
  bridges and tunnels. Themes are inspired by classic kart courses: Cowbell Meadows (cows, big hills),
  Dune Dash (pyramids, sand traps), Frosty Summit (snowmen, ice), Toadstool Gorge (giant mushrooms),
  Coconut Cove (palms, ocean), Magma Keep (lava, torches, volcano), Star Road (rainbow road in space)
  and Spooky Hollow (plank road, ghosts, pumpkins).
- **Garage** (in the room lobby and between rounds): coins you're holding when a round ends (plus a
  placement bonus) are banked. Spend them on Top Speed, Acceleration, Handling and Drift Boost, and on
  cosmetic parts (bodies, spoilers, wheels, headgear) plus paint/accent colours, previewed in 3D and
  shown to everyone in the room. Everything lasts for that room / solo session only — leaving to the
  menu resets it. CPU karts get upgrades as rounds progress.
- **CPU racers**: in a room the host fills empty grid slots with CPU karts (adjustable in the lobby,
  default: fill all 8 slots). The host simulates them and streams their state like any kart.
- **Ready-up**: in a room every player marks Ready in the lobby and again between rounds; the
  race starts when everyone is ready (the host can also skip the wait).
- **Style parts** are previewed on the showroom kart when clicked and only bought via the Buy button.
- **Items** (odds depend on your position: leaders get defensive items, the back gets catch-up items):
  green shell (bounces), red shell (homes in on the kart ahead), banana, oil slick (a puddle that
  makes every kart driving through it fishtail), mushroom, triple mushroom (3 uses), boost pad drop
  (anyone can use it), bubble shield (absorbs the next hit), coin magnet, ghost (6 s intangible,
  steals a rival's item), storm cloud (reverses the leader's steering), lightning bolt (back half:
  shrinks everyone else), rocket (last places: 3.5 s autopilot at 1.6× speed, bowls karts over) and
  the rare Mega Mushroom (3× size for 10 s).
- **Audio**: `sound_effects/` holds the countdown, item-roulette, race-end jingle, the menu loop
  (menu, lobby, garage and between races) and three race music
  tracks (one per circuit). Settings (gear button or Esc) has master/music/effects volume; M mutes.

## Architecture

| Path | Role |
| --- | --- |
| `src/engine/Renderer.js` | WebGL renderer, toon material cache, chase camera, instanced blob shadows |
| `src/engine/Physics.js` | Rapier world, fixed 60 Hz accumulator loop, ray helpers |
| `src/engine/Particles.js` | Typed-array particle pool on one InstancedMesh |
| `src/game/Track.js` | Seeded layouts (incl. crossings → overpasses), terrain, width, jumps, pads, bridges/tunnels, colliders, progress queries |
| `src/game/TrackDecor.js` | Theme definitions and scenery builders (plants, rocks, theme props, grandstand, tire stacks) |
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
