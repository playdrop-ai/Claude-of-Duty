# Claude of Duty

## PlayDrop hosting fork

This repository is a PlayDrop-maintained fork of [Matt Shumer's original Claude of Duty](https://github.com/mshumer/Claude-of-Duty), based on upstream commit [`d9b237b`](https://github.com/mshumer/Claude-of-Duty/commit/d9b237b75c9304ab8d9ef4cfa0c3568c7c11a853). Matt created the original game and procedural art. This fork adapts it for PlayDrop with a store listing, catalogue metadata, and a few focused hosting and gameplay tweaks.

[Play Claude of Duty on PlayDrop](https://www.playdrop.ai/@mattshumer_/claude_of_duty). You can also [make your own games on PlayDrop](https://playdrop.ai/create).

### What this fork adds

- PlayDrop listing assets and catalogue metadata.
- Hosted loading, start, and pause behavior.
- Gamepad and landscape touch controls.
- Desktop and mobile rendering budgets.
- Wave progression plus focused combat and destruction fixes.

Get updates [here](https://shumer.dev/newsletter).

A first-person shooter built in the browser with Three.js r180 and WebGL2. Roughly
55k lines across 11 subsystems, written by a fleet of AI agents under orchestration.

**There are no art assets.** Every texture, mesh, animation and sound is generated
procedurally at load time from code. No models, no HDRIs, no image files, no audio
files. Rendering uses `three`; standalone touch controls also bundle NippleJS 0.10.2.

```bash
npm ci
npm run dev          # http://127.0.0.1:5173
```

Click the canvas to lock the cursor. WASD move, mouse aim, LMB fire, RMB ADS,
R reload, Shift sprint, Ctrl crouch, Space jump, Q/E lean, Esc release.

### Controller support in this fork

Standard browser-mapped Xbox and PlayStation controllers work alongside keyboard/mouse.
Left stick moves; right stick aims. RT/R2 fires, LT/L2 aims down sights, X/Square reloads,
Y/Triangle cycles weapons, RB/R1 quick-throws a grenade, and B/Circle toggles crouch.
Hold L3 to sprint. D-pad down toggles prone, D-pad left/right leans, LB/L1 changes
fire mode, and R3 inspects the weapon. A/Cross starts, jumps, resumes, and confirms wave results;
Menu/Options pauses or resumes. Disconnecting the active controller pauses play.
The compact HUD switches between keyboard and controller hints automatically.

Hosted input respects `sdk.device.controllerAvailability` and `onControllerChange`,
plus the host pause lifecycle. Live axes/buttons use `navigator.getGamepads()`;
the SDK's NippleJS library is for touchscreen joysticks, not physical controllers.
Standalone play uses the same mapping without loading the SDK. Browser autoplay
rules may require one page click to enable audio.

Weapon sounds are generated into a bounded sample bank during loading instead of
rebuilding synthesis graphs on every shot. Directional HRTF, distance filtering
and environmental reverb remain. A single live AudioContext is unlocked by a
gesture and suspended while muted, paused or backgrounded; wave resets stop old
combat voices. These paths are tested in desktop Chromium and WebKit, not yet
on physical iPhone hardware.

### Mobile touch controls

Phones and tablets use landscape touch controls. Touch anywhere on the empty left
half to place a movement stick; drag to move, push past its ring to sprint, and
release to hide it. Swipe the right half to look. The weapon fires automatically
when the crosshair and barrel have a clear line to a living enemy. This pulls the
normal trigger: ammunition, recoil, spread, and travelling bullets are unchanged;
there is no automatic camera aiming. Keyboard and gamepad still fire manually.

Tap one of the three bottom weapon slots to equip it; tap the current weapon or
its ammunition to reload. Empty weapons also reload automatically. Aim toggles
the sights. Aim, Grenade, Jump, and Crouch sit in a staggered right-thumb arc.
Tap Crouch, or hold it to toggle prone.
Pause, Retry Wave and Next Wave work without pointer lock. Turning to portrait pauses
play and asks the player to rotate; resume explicitly after returning to landscape.

Hosted play loads `sdk.libs.nipplejs.load()`. Standalone play imports the matching
NippleJS 0.10.2 dependency without loading or contacting PlayDrop. Touch state is
cleared on pause, death, backgrounding, cancellation, and input-mode changes.

### Waves and restoration

Clear the six enemies in wave one, then choose **Next Wave**. Each wave adds one
enemy until twelve are active; later waves add 10% enemy health per wave, capped
at twice normal health. Accuracy and perception do not gain hidden advantages.
Death offers **Retry Wave**, restarting that entire wave, not just the player.
Both paths restore the original spawn and facing, full health, every magazine and
reserve, two grenades, terrain, and a fresh enemy squad. Old projectiles, debris,
impact marks and combat audio effects are cleared.

Bullets and explosions break selected crate stacks and market stalls, opening
their collision space and updating enemy navigation/cover. Desktop adds a bounded
pool of temporary physics splinters; touch devices keep the same destruction
without those extra bodies. Cars and buildings remain solid. Bullet marks persist
on surviving surfaces until the decal pool recycles them or a new round begins.

Phones and tablets automatically use the mobile rendering profile: a 600K internal
pixel budget, two 1024px shadow cascades, and reduced expensive screen-space effects.
The HUD and touch targets remain at display resolution. `?q=ultra` explicitly
selects the desktop profile; `?q=mobile` can compare the mobile profile on desktop.
Mobile emulation is not proof of physical-device Safari/Chrome performance.

## What's in it

| subsystem | what it does |
|---|---|
| `render` | HDR pipeline, cascaded shadow maps in a `sampler2DArray` with texel snapping and PCSS contact hardening, MRT depth/normal/velocity prepass, GTAO, TAA with YCoCg variance clipping, tile-dilated motion blur, Karis bloom pyramid, GPU EV100 metering, procedural 33³ grade LUT, AgX composite |
| `materials` | GPU texture forge: 19 procedural surfaces (concrete, brick, plaster, asphalt, sand, rusted/painted/brushed metal, wood, fabric, burlap, glass…), periodic noise so everything tiles seamlessly, Sobel height→normal, parallax occlusion mapping, triplanar projection, curvature-driven edge wear |
| `sky` | Atmospheric scattering, time of day, PMREM environment generation, volumetric fog and light shafts |
| `world` | ~120×120 m market street: modular building kit with real wall thickness, enterable interiors, several hundred instanced props |
| `physics` | Written from scratch, no library. Binned-SAH BVH (29k tris → 14k nodes in 22 ms, 0.25 µs/raycast), swept-capsule character controller with a 5-plane crease stack, impulse rigid bodies with CCD, PBD ragdolls, multi-layer bullet penetration |
| `player` | Movement state machine, slide/mantle/lean, camera feel |
| `weapons` | Procedural weapon geometry, viewmodel rig, ADS, spring recoil, procedural reloads, ballistics with travel time and drop |
| `fx` | GPU particles, decals, tracers, muzzle flash, explosions |
| `ai` | Skinned soldiers, navmesh pathing, perception, cover behaviour, ragdoll death |
| `ui` | DOM/CSS HUD: crosshair, hitmarkers, minimap, compass, killfeed |
| `audio` | Web Audio synthesis — no sound files. Layered weapon fire, convolution reverb, HRTF spatialisation, occlusion |

`ARCHITECTURE.md` is the contract the agents worked against: subsystem interface,
directory ownership, the cross-subsystem event vocabulary, and shared surface types.

## Tooling

The interesting part of this repo is arguably the harness, not the game.

| tool | purpose |
|---|---|
| `tools/capture.mjs` | Screenshot one named shot via GPU-backed headless Chromium |
| `tools/shotset.mjs` | All 11 shots in one session — fast review set |
| `tools/baseline.mjs` | **Reproducible** capture: each shot in an isolated page, fixed frame budget. Bit-identical across runs |
| `tools/imagediff.mjs` | Per-pixel gate. Exits non-zero if any pixel moved |
| `tools/profile.mjs` | Gameplay profiler at real device pixel ratio. Frame-time *distribution* and hitch attribution via per-frame WebGL program counts |
| `tools/playtest.mjs` | Scripted movement/fire smoke test |

Two findings worth recording, because both invalidated earlier measurements:

**Median frame time hides the actual problem.** A static-camera benchmark reported
94 fps while the game was unplayable. Real gameplay at Retina DPR (internal 3.34 MP,
not 2.07) ran 12–17 fps with **728–1236 ms stalls** caused by 34+ WebGL programs
compiling lazily mid-frame. `profile.mjs` reports p50/p95/p99 and attributes each
hitch, which is what surfaced it.

**Captures were not reproducible.** `shotset.mjs` reuses one page across all 11
shots, so particle age, decal buffers and exposure state leak forward — two identical
runs differed on 10 of 11 shots. `baseline.mjs` isolates each shot in a fresh page,
which is bit-identical and is what makes `imagediff.mjs` a usable gate.

## Performance

Measured on an Apple silicon laptop at 1512×982, DPR 2 (3.34 MP internal), `ultra` preset,
3 runs, gameplay in motion with AI and firing active:

| | before optimization | after |
|---|---|---|
| fps p50 | 12–17 | **28–30** |
| fps p99 | 4–9 | **14–17** |
| worst frame | 728–1236 ms | **66–82 ms** |
| shader compiles during play | 34–35 | **0** |
| boot | ~9–12 s | **3.7–4.6 s** |

That upstream optimization pass was constrained to produce **zero visual change**, enforced by
`imagediff.mjs` rather than by assertion. The later PlayDrop hosting pass keeps the
full-resolution presentation and HUD while bounding the internal 3D pixel workload
on oversized displays. At a 3117 x 1753 presentation size it improves the measured
median from 11 FPS to 54 to 55 FPS across three final runs. See
[`assets/marketing/playdrop/PERFORMANCE-ANALYSIS.md`](assets/marketing/playdrop/PERFORMANCE-ANALYSIS.md)
for the exact profile and visual validation.

Shader pre-warm (`src/core/prewarm.js`) is what removed the stalls. Making it
*provably* pixel-neutral required first fixing subsystems that animated off
`performance.now()` instead of the engine clock, since any change to boot duration
otherwise shifted output.

## Honest assessment

The goal was to match a modern Call of Duty. **It does not.**

Eleven independent adversarial critics scored the frames against that bar. Scores
went 3.59 → 4.14 → 4.05 → **5.05** out of 10. Two shots reached "CLOSE"; the rest
remain "AMATEUR". In a blind A/B, **every critic in every round picked the real Call
of Duty frame.**

Where it falls short, specifically:

- **Hands.** Blocky finger slabs that don't convincingly grip the weapon.
- **Material richness.** Surfaces read as procedural noise rather than photographed
  reality at close range — the ceiling of generating texture from code.
- **Characters.** Enemies read as mannequins at distance.
- **Indirect light.** An approximation, not real GI.
- **Frame rate.** 28–30 fps at Retina. The art passes tripled geometry cost
  (5.9M → 11.3M triangles) and optimization recovered about half.

A known root cause remains unfixed: the viewmodel light rig in `render/index.js`
delivers roughly 20× the irradiance per unit albedo that the world does — a plain
*black* material in the view scene renders at L=110 against a background of 91,
purely from F0=0.04. Every weapon albedo is cheated to a third of physical to
compensate, which caps material separation on the most-looked-at object in the game.

## Process note

Sequential single-owner passes beat parallel fan-out decisively. Three rounds of six
agents each owning one directory moved the score +0.46 and left frame-ruining defects
*higher* than they started (60 → 47 → 66), because tonemapping, sky and indirect light
are one coupled system and isolated agents kept breaking each other's assumptions.
One sequential pass with a single owner per coupled concern moved it +1.00 and cut
defects 66 → 26.

The most valuable single result came from an agent contradicting its own brief. Every
critic for three rounds reported the weapon as "untextured". It wasn't — it was
specular-dominated, with the diffuse term measured at L=26 against a shipped L=67.
Prior rounds had been crushing albedos to fight bright-part complaints, which killed
diffuse and made it worse. The fix was the opposite of what was asked for.
