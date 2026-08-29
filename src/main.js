import { Engine } from './core/engine.js';
import { createConfig, selectQuality, selectRuntimeProfile } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';
import { WaveSystem } from './waves.js';

import { installShotApi } from './dev/shots.js';
import { installPerfDebug } from './dev/perf-debug.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Lockstep captures pump exact frame counts; live profiles use the normal loop.
const lockstep = capture && params.get('lockstep') === '1';
const mobile = navigator.maxTouchPoints > 0;

const config = createConfig({
  ...selectRuntimeProfile(mobile),
  mobile,
  quality: selectQuality(params.get('q'), mobile),
  deterministic: capture,
});
const captureRenderScale = capture && params.has('renderScale')
  ? Number(params.get('renderScale'))
  : null;
if (captureRenderScale !== null) {
  if (!Number.isFinite(captureRenderScale) || captureRenderScale <= 0 || captureRenderScale > 1) {
    throw new Error(`capture renderScale must be greater than 0 and at most 1, received ${params.get('renderScale')}`);
  }
  config.q.renderScale = captureRenderScale;
}

const canvas = document.getElementById('game');

const engine = new Engine({ canvas, config });
window.__ENGINE__ = engine;
engine.input.orientationPaused = window.__PLAYDROP_PORTRAIT__ === true;
const boot = window.__PLAYDROP_BOOT__;
const bootStage = {
  render: 'Initializing renderer',
  materials: 'Generating tactical materials',
  sky: 'Baking procedural sky',
  physics: 'Building collision world',
  world: 'Assembling combat environment',
  player: 'Preparing player controls',
  weapons: 'Building weapon systems',
  fx: 'Preparing tactical effects',
  ai: 'Deploying AI soldiers',
  ui: 'Loading mission interface',
  audio: 'Preparing procedural audio',
  waves: 'Preparing wave objectives',
};

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(WaveSystem)
  .add(UiSystem)
  .add(AudioSystem);

performance.mark('boot:engine-init:start');
await engine.init({
  onProgress: ({ id, completed, total }) => {
    boot.report(bootStage[id] ?? `Preparing ${id}`, 8 + (completed / total) * 64);
  },
});
window.__PLAYDROP_SYNC_ORIENTATION__?.();
performance.mark('boot:engine-init:end');
performance.measure('boot:engine-init', 'boot:engine-init:start', 'boot:engine-init:end');

const shotApi = installShotApi(engine, { capture, lockstep });
const perfDebug = installPerfDebug(engine);
window.advanceTime = (ms) => shotApi.pump(Math.max(1, Math.round(ms / (1000 / 60))));
window.render_game_to_text = () => {
  const playerSystem = engine.ctx.peek('player');
  const player = playerSystem?.stats;
  const ai = engine.ctx.peek('ai')?.stats;
  const weapons = engine.ctx.peek('weapons')?.getHudState?.();
  const paused = engine.ctx.peek('ui')?.menu?.open === true;
  const waves = engine.ctx.get('waves');
  return JSON.stringify({
    coordinateSystem: 'Three.js world coordinates; +Y is up and the camera faces its local -Z axis.',
    mode: engine.error ? 'error' : window.__PLAYDROP_STARTED__ ? (waves.status === 'won' ? 'victory' : player?.dead ? 'gameover' : paused || !engine._running ? 'paused' : 'playing') : 'start',
    wave: { number: waves.number, status: waves.status, seconds: Number(waves.elapsed.toFixed(1)), ...waves.rules },
    error: engine.error?.message ?? null,
    frame: engine.time.frame,
    player: player ? {
      state: player.state,
      stance: player.stance,
      speed: Number(player.speed.toFixed(3)),
      verticalSpeed: Number(player.vertical.toFixed(3)),
      grounded: player.grounded,
      health: Number(player.health.toFixed(1)),
      dead: player.dead,
      deathProgress: Number((player.deathProgress ?? 0).toFixed(3)),
      yaw: Number(player.yaw.toFixed(3)),
      aiming: playerSystem.adsAmount > 0.5,
    } : null,
    enemies: {
      alive: ai?.alive ?? 0,
      total: ai?.agents ?? 0,
      minimapBlips: engine.ctx.peek('ui')?._blipCount ?? 0,
      openingGrenade: ai?.openingGrenade ?? null,
      openingGrenadeShooterDistance: ai?.openingGrenadeShooterDistance ?? null,
      openingGrenadeTargetDistance: ai?.openingGrenadeTargetDistance ?? null,
      openingGrenadeLandingDistance: ai?.openingGrenadeLandingDistance ?? null,
      openingGrenadeTargetError: ai?.openingGrenadeTargetError ?? null,
      openingGrenadePlayerHealth: ai?.openingGrenadePlayerHealth ?? null,
      openingGrenadePlayerDamage: ai?.openingGrenadePlayerDamage ?? null,
      friendlyFireBlocked: ai?.friendlyFireBlocked ?? 0,
    },
    weapon: weapons ? {
      name: weapons.name,
      index: weapons.weaponIndex,
      count: weapons.weaponCount,
      grenades: weapons.lethalCount,
      ammo: weapons.ammo,
      reserve: weapons.reserve,
    } : null,
    pointerLocked: engine.input.pointerLocked,
    inputMethod: engine.input.inputMethod,
    controller: { status: engine.input.gamepad.status, connected: engine.input.gamepad.connected },
    touchControls: engine.ctx.peek('ui')?.touchControls?.visible === true,
    performanceDebug: perfDebug.enabled,
  });
};

// Compile gameplay shaders while loading to avoid first-use stalls. The capture
// harness can opt out to compare pixels; prewarm preserves scene/time/RNG state.
performance.mark('boot:shader-prewarm:start');
boot?.report('Compiling shader programs', 72);
const warmup = params.get('prewarm') === '0'
  ? { ok: false, reason: 'disabled by ?prewarm=0' }
  : await prewarm(engine, {
      onProgress: (value) => boot?.report('Compiling shader programs', 72 + value * 25),
    });
performance.mark('boot:shader-prewarm:end');
performance.measure('boot:shader-prewarm', 'boot:shader-prewarm:start', 'boot:shader-prewarm:end');
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

boot.report('Rendering first combat frame', 99);
engine.start();

// The module resolves after the same three-frame handshake in both modes.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
} else {
  for (let frame = 0; frame < BOOT_FRAMES; frame++) await boot.nextFrame();
}
if (engine.error) throw engine.error;
window.__READY__ = true;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    perfDebug.dispose();
    engine.dispose();
  });
}
