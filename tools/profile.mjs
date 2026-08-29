#!/usr/bin/env node
/**
 * Gameplay profiler — reproduces the conditions a real player hits, which the
 * static-camera capture harness completely misses:
 *
 *  - real display dimensions and device pixel ratio, with the runtime pixel cap
 *  - a moving camera (forces new shadow cascades, new frusta, streaming)
 *  - firing (particles, decals, tracers, muzzle light, audio)
 *  - AI active (skinned meshes, ragdolls, pathfinding)
 *
 * Reports the frame-time DISTRIBUTION and every hitch, because a median frame
 * time hides exactly the stalls that make a game feel broken. Also tracks WebGL
 * program count per frame — a jump in programs on the same frame as a hitch is
 * a shader compilation stall, the classic cause of Three.js hitching.
 *
 *   node tools/profile.mjs --port=4173 --dpr=2 --w=1512 --h=982
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));

const PORT = Number(args.port ?? 4173);
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 2);
const FRAMES = Number(args.frames ?? 900);
const SCALE = args.scale === undefined ? null : Number(args.scale);
const DISABLED = String(args.disable ?? '').split(',').map((value) => value.trim()).filter(Boolean);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio',
         '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
if (args.seed !== undefined) {
  await page.addInitScript((seed) => {
    let state = seed >>> 0;
    Math.random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }, Number(args.seed));
}
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

const t0 = Date.now();
const EXTRA = args.query ? `?${args.query}` : '';
await page.goto(`http://127.0.0.1:${PORT}/${EXTRA}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
const bootMs = Date.now() - t0;
if (await page.locator('#boot[data-state="ready"]').isVisible()) {
  await page.locator('#boot').click({ position: { x: 20, y: 20 } });
}
await page.waitForFunction('window.__PLAYDROP_STARTED__ && window.__ENGINE__._running');
if (args.debug) await page.keyboard.press('Meta+Shift+D');

if (SCALE !== null) {
  if (!Number.isFinite(SCALE) || SCALE <= 0 || SCALE > 1) {
    throw new Error(`--scale must be greater than 0 and at most 1, received ${args.scale}`);
  }
  await page.evaluate((scale) => {
    const engine = window.__ENGINE__;
    engine.config.q.renderScale = scale;
    engine.resize();
  }, SCALE);
}

if (DISABLED.length) {
  await page.evaluate((disabled) => {
    const render = window.__ENGINE__.ctx.peek('render');
    for (const name of disabled) {
      if (name === 'csm') render.csm.enabled = false;
      else if (name === 'gtao') render.gtao = null;
      else if (name === 'contact') render.contact = null;
      else if (name === 'ssr') render.ssr = null;
      else if (name === 'taa') render.taa = null;
      else if (name === 'motion-blur') render.motionBlur = null;
      else if (name === 'bloom') render.bloom = null;
      else if (name === 'viewmodel') render._viewRigChildren = Number.POSITIVE_INFINITY;
      else if (name === 'volumetrics') render.passes.find((pass) => pass.order === -70).enabled = false;
      else if (name === 'sky-dome') window.__ENGINE__.ctx.peek('sky').dome.mesh.visible = false;
      else if (name === 'world') {
        const original = render.renderer.render;
        render.renderer.render = function (scene, camera) {
          if (scene === window.__ENGINE__.scene && camera === window.__ENGINE__.camera) return;
          return original.call(this, scene, camera);
        };
      }
      else if (name === 'haze') render.passes.find((pass) => pass.order === 14).enabled = false;
      else throw new Error(`unknown disabled renderer component: ${name}`);
    }
  }, DISABLED);
}

// Boot-phase breakdown: how much of that boot was spent where.
const bootMarks = await page.evaluate(() =>
  performance.getEntriesByType('measure').map((m) => ({ name: m.name, ms: +m.duration.toFixed(1) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 25));

const internal = await page.evaluate(() => {
  const r = window.__ENGINE__.ctx.peek('render');
  const gl = r.renderer.getContext();
  return {
    pixelRatio: r.renderer.getPixelRatio(),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    megapixels: +((gl.drawingBufferWidth * gl.drawingBufferHeight) / 1e6).toFixed(2),
    internalBuffer: [r.screenSize.width, r.screenSize.height],
    internalMegapixels: +((r.screenSize.width * r.screenSize.height) / 1e6).toFixed(2),
    quality: window.__ENGINE__.config.quality,
    renderScale: window.__ENGINE__.config.q.renderScale,
  };
});

// Enable player control and run a scripted gameplay sequence while sampling.
await page.evaluate(() => {
  const e = window.__ENGINE__;
  e.input.enabled = true; e.input.frozen = false;
  e.ctx.peek('player')?.setControlEnabled?.(true);
  // Keep the actual six-enemy opening, not the debug stage's extra actors.
});

const cdp = args.cpu ? await page.context().newCDPSession(page) : null;
if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
const result = await page.evaluate(({ FRAMES, stationary }) => new Promise((done) => {
  const e = window.__ENGINE__;
  const r = e.ctx.peek('render');
  const samples = [];
  let last = performance.now(), i = 0;
  const initialFrame = e.time.frame;

  const tick = () => {
    const now = performance.now();
    const dt = now - last; last = now;

    // Drive gameplay: orbit the view, walk, and fire in bursts.
    if (!stationary) {
      e.input._rawLook.x += 2;
      if (i % 180 < 90) e.input.down.add('KeyW'); else e.input.down.delete('KeyW');
      if (i % 90 < 30) e.input.down.add('Mouse0'); else e.input.down.delete('Mouse0');
    }

    samples.push({
      i, dt, engineFrames: e.time.frame - initialFrame,
      progs: r.renderer.info.programs?.length ?? 0,
      calls: r.renderer.info.render.calls,
      tris: r.renderer.info.render.triangles,
      geos: r.renderer.info.memory.geometries,
      texs: r.renderer.info.memory.textures,
      heap: performance.memory ? performance.memory.usedJSHeapSize >> 20 : 0,
    });

    if (++i >= FRAMES) {
      e.input.down.delete('KeyW'); e.input.down.delete('Mouse0');
      return done(samples);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), { FRAMES, stationary: args.stationary === true });
if (cdp) {
  const { profile } = await cdp.send('Profiler.stop');
  await writeFile(resolve(String(args.cpu)), JSON.stringify(profile));
}
const validation = await page.evaluate(() => {
  const e = window.__ENGINE__;
  const invalid = [];
  for (const [name, scene] of [['world', e.scene], ['viewmodel', e.viewScene]]) {
    scene.traverse((o) => {
      if (![...o.position, ...o.quaternion, ...o.matrixWorld.elements].every(Number.isFinite)) {
        invalid.push(`${name}:${o.name || o.type}`);
      }
    });
  }
  return { invalidTransforms: invalid, state: JSON.parse(window.render_game_to_text()) };
});
if (args.screenshot) await page.screenshot({ path: resolve(String(args.screenshot)) });

// Discard the first 60 frames: control handover and the first shadow-cascade fit
// are one-time costs, not steady state.
//
// `--warmup=0` keeps them, which is how you see the COLD first-load experience:
// a lazily-compiled program lands in exactly those discarded frames, so the
// default view is blind to the stall the pre-warm exists to remove.
const WARMUP = Number(args.warmup ?? 60);
const warm = result.slice(WARMUP);
const dts = warm.map((s) => s.dt).sort((a, b) => a - b);
const q = (p) => +dts[Math.min(dts.length - 1, Math.floor(dts.length * p))].toFixed(2);
const med = q(0.5);

const hitches = warm
  .filter((s) => s.dt > Math.max(2 * med, med + 8))
  .map((s, n, arr) => {
    const prev = warm[warm.indexOf(s) - 1];
    return {
      frame: s.i, ms: +s.dt.toFixed(1),
      progDelta: prev ? s.progs - prev.progs : 0,
      geoDelta: prev ? s.geos - prev.geos : 0,
      texDelta: prev ? s.texs - prev.texs : 0,
    };
  });

const first = warm[0], lastS = warm[warm.length - 1];
const report = {
  bootMs,
  bootMarks,
  internal,
  frames: warm.length,
  coldFrames: {
    total: result.length,
    over50ms: result.filter((s) => s.dt > 50).length,
    maxMs: +Math.max(...result.map((s) => s.dt)).toFixed(2),
    programsStart: result[0].progs,
    programsEnd: result.at(-1).progs,
  },
  frameTimeMs: { p1: q(0.01), p50: med, p90: q(0.9), p95: q(0.95), p99: q(0.99), max: q(1) },
  fps: { p50: +(1000 / med).toFixed(0), p95: +(1000 / q(0.95)).toFixed(0), p99: +(1000 / q(0.99)).toFixed(0) },
  hitchCount: hitches.length,
  hitchPctOfFrames: +((hitches.length / warm.length) * 100).toFixed(2),
  worstHitches: hitches.sort((a, b) => b.ms - a.ms).slice(0, 15),
  programs: { start: first.progs, end: lastS.progs, compiledDuringPlay: lastS.progs - first.progs },
  resources: { geosStart: first.geos, geosEnd: lastS.geos, texStart: first.texs, texEnd: lastS.texs },
  heapMb: { start: first.heap, end: lastS.heap, growth: lastS.heap - first.heap },
  drawCalls: { min: Math.min(...warm.map(s=>s.calls)), max: Math.max(...warm.map(s=>s.calls)) },
  triangles: { min: Math.min(...warm.map(s=>s.tris)), max: Math.max(...warm.map(s=>s.tris)) },
  engineFrames: lastS.engineFrames,
  validation: { ...validation, invalidTransformCount: validation.invalidTransforms.length,
    invalidTransforms: validation.invalidTransforms.slice(0, 10) },
  errors: errs.slice(0, 6),
};
console.log(JSON.stringify(report, null, 2));
if (args.output) await writeFile(resolve(String(args.output)), JSON.stringify(report, null, 2));

await browser.close();
assert(lastS.engineFrames >= FRAMES - 1 && lastS.engineFrames <= FRAMES + 1,
  'profiling must measure one running game frame per animation callback');
assert.equal(validation.invalidTransforms.length, 0, 'profiling found invalid game transforms');
assert.deepEqual(errs, [], 'profiling found browser errors');
