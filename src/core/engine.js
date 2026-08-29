import * as THREE from 'three';
import { Registry, EventBus } from './registry.js';
import { MAX_SUBSTEPS } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';

/** Owns input -> fixed simulation -> update -> lateUpdate -> render. */
export class Engine {
  constructor({ canvas, config }) {
    this.canvas = canvas;
    this.config = config;
    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? 0x5eed1234 : (Math.random() * 2 ** 32) >>> 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(config.fov, 1, 0.05, 1200);
    this.camera.rotation.order = 'YXZ';

    /** Separate scene+camera for the first-person viewmodel, drawn with its own
     *  near plane so hands/weapon never clip into world geometry. */
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.005, 12);

    this.time = {
      /** Seconds since start, scaled. */ elapsed: 0,
      /** Unscaled wall-clock seconds since start. */ raw: 0,
      /** Last frame delta, scaled and clamped. */ dt: 0,
      /** Fixed simulation step. */ fixed: config.fixedDt,
      /** Maximum rendered frames per second. */ targetFps: config.targetFps,
      /** Interpolation alpha between the last two physics steps, 0..1. */ alpha: 0,
      scale: 1,
      frame: 0,
    };

    this.ctx = {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._frame = null;
    this._frameIntervalMs = 1000 / config.targetFps;
    this._nextFrameAt = 0;
    this._renderDirty = true;
    this.error = null;
    this._loop = this._loop.bind(this);
    this._onResize = () => this.resize();
    this._resizeObserver = null;
  }

  add(SystemClass, opts) {
    this.registry.add(new SystemClass(opts));
    return this;
  }

  async init({ onProgress = null } = {}) {
    const order = this.registry.resolve();
    for (let index = 0; index < order.length; index++) {
      const sys = order[index];
      const id = sys.constructor.id;
      onProgress?.({ id, completed: index, total: order.length });
      if (onProgress) {
        // Paint the CURRENT stage before its synchronous generation starts.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      if (this.error) throw this.error;
      performance.mark(`boot:${id}:start`);
      const t0 = performance.now();
      await sys.init?.(this.ctx);
      if (this.error) throw this.error;
      const ms = performance.now() - t0;
      performance.mark(`boot:${id}:end`);
      performance.measure(`boot:${id}`, `boot:${id}:start`, `boot:${id}:end`);
      if (ms > 50) console.info(`[engine] ${id} init ${ms.toFixed(0)}ms`);
    }
    this.input.attach();
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(this.canvas);
    this.resize();
    return this;
  }

  resize() {
    if (this.error) return;
    this._renderDirty = true;
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this.error) throw this.error;
    if (this.input.orientationPaused) return;
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._nextFrameAt = this._last;
    this._frame = requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._frame);
    this._frame = null;
  }

  fail(error) {
    this.error ??= error;
    this.stop();
    this.input.reset();
    this.input.enabled = false;
  }

  _loop(now) {
    this._frame = null;
    if (!this._running) return;
    // Keep rAF for compositor pacing, but only run a game frame when the
    // device profile's deadline arrives. Advancing the deadline instead of
    // counting callbacks also paces correctly on 90/120/144 Hz displays.
    if (now + 0.25 >= this._nextFrameAt) {
      try {
        this.step(now);
      } catch (error) {
        this.fail(error);
        throw error;
      }
      const late = Math.max(0, now - this._nextFrameAt);
      const missed = Math.floor(late / this._frameIntervalMs);
      this._nextFrameAt += (missed + 1) * this._frameIntervalMs;
    }
    if (this._running && this._frame === null) this._frame = requestAnimationFrame(this._loop);
  }

  /** Advance one frame. Exposed so the capture harness can pump frames by hand. */
  step(now = performance.now()) {
    if (this.error || this.input.orientationPaused) return;
    const t = this.time;
    const fixedDt = t.fixed;
    // Clamp so a tab-switch or a breakpoint doesn't teleport the simulation.
    const rawDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    // Every subsystem gets the same accepted time, including on slow hardware.
    t.dt = Math.min(rawDt * t.scale, fixedDt * MAX_SUBSTEPS);
    t.elapsed += t.dt;
    t.frame++;

    this.input.beginFrame();

    this._accum += t.dt;
    const steps = Math.min(MAX_SUBSTEPS, Math.floor(this._accum / fixedDt + 1e-9));
    this._accum = Math.max(0, this._accum - steps * fixedDt);
    const fixedSystems = this.registry.with('fixedUpdate');
    for (let i = 0; i < steps; i++) {
      for (const sys of fixedSystems) sys.fixedUpdate(fixedDt, this.ctx);
    }
    t.alpha = this._accum / fixedDt;

    for (const sys of this.registry.with('update')) sys.update(t.dt, this.ctx);
    for (const sys of this.registry.with('lateUpdate')) sys.lateUpdate(t.dt, this.ctx);

    // DOM menus and input keep ticking while paused; the settled 3D frame does not.
    if (t.dt > 0 || this._renderDirty) {
      this.registry.peek('render')?.render(this.ctx);
      this._renderDirty = false;
    }

    this.input.endFrame();
  }

  dispose() {
    this.stop();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this.input.detach();
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
  }
}
