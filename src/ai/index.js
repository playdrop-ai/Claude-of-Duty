/**
 * AI — enemy characters, navigation, perception, cover selection and combat
 * behaviour.
 *
 * WHAT LIVES WHERE
 *   rig.js        25-bone skeleton, bind pose, weapon anchor points
 *   geo.js        loft/tube/revolve toolkit, skin binder, baked vertex AO
 *   parts.js      body and kit: jacket, plate carrier, pouches, helmet, boots
 *   weapon.js     the carried carbine / long rifle, baked into the character
 *   textures.js   tiling PBR sets: camo cloth, cordura, skin, polymer, steel
 *   soldier.js    variant assembly -> one skinned geometry + material list
 *   clips.js      hand-authored pose layers (idle/walk/run/crouch/hit/recoil…)
 *   animator.js   layered blending + aim, look-at, arm and foot IK
 *   nav.js        walkability grid from the physics BVH, A*, string pulling,
 *                 cover point extraction and scoring
 *   agent.js      one enemy: senses, state machine, gun, hit zones, death
 *   squad.js      peek rotation, contact sharing, flank and grenade rationing
 *
 * PUBLIC API — `const ai = ctx.get('ai')`
 *   ai.spawn(variant, position, yaw, opts) -> Agent
 *   ai.agents                              live Agent list
 *   ai.debugStage('firefight')             staged combat tableau for captures
 *   ai.prewarmMaterials()                  await: build + compile every character
 *                                          shader without spawning anything
 *   ai.grid / ai.cover                     navigation + cover queries
 *   ai.stats                               { agents, alive, navMs, coverPts,
 *                                            pathsDeferred, lodIrrelevant }
 *
 * FRAME BUDGETS — navigation and the garrison are built during init(), not on
 * the first frame of play; A* is rationed to `ai.pathsPerFrame` solves per frame;
 * and an actor that provably cannot reach a pixel this frame (see
 * `_updateRelevance`) animates at a third rate and leaves the shadow cascades.
 *
 * EVENTS consumed: weapon:fire, bullet:impact, damage:dealt, explosion,
 *   player:footstep
 * EVENTS emitted: weapon:fire (enemy muzzle), weapon:shell, bullet:tracer,
 *   damage:dealt (enemy hitting the player), actor:death
 */

import * as THREE from 'three';
import { SoldierMaterials } from './textures.js';
import { buildSoldier, resolveMaterials, MATERIAL_SLOTS, VARIANTS } from './soldier.js';
import { RIG } from './rig.js';
import { NavGrid, CoverMap } from './nav.js';
import { Agent, STATE } from './agent.js';
import { Squad } from './squad.js';
import { GroundShadows } from './grounding.js';
import { rayCapsule } from '../physics/math.js';

// Character movement uses an intentionally weighty shooter gravity. A thrown
// 420 g grenade follows a real ballistic arc instead of inheriting that doubled
// gravity, otherwise even a 22 m/s long throw falls more than 20 m short.
const GRENADE_GRAVITY_SCALE = 0.48;

export class AiSystem {
  static id = 'ai';
  static deps = ['physics', 'world', 'player', 'fx', 'sky'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.root = new THREE.Group();
    this.root.name = 'ai';
    ctx.scene.add(this.root);

    const t0 = performance.now();
    this.materials = new SoldierMaterials(this.rng.fork(), {
      size: 512,
      anisotropy: ctx.config.q.anisotropy ?? 8,
      camo: ['arid', 'woodland', 'urban'],
    });
    // Contact occlusion under every actor. Without it the cast shadow alone
    // leaves them hovering: see grounding.js.
    this.ground = new GroundShadows(this.root, 16);
    this._variants = new Map();
    this.agents = [];
    this.squads = [];
    this.grid = null;
    this.cover = null;
    this._navDirty = new THREE.Box3();
    this.inspect = false;
    this.debugLog = false;
    /** dev: force the garrison to spawn even in deterministic capture runs */
    this.forcePopulate = false;
    this.stats = {
      agents: 0,
      alive: 0,
      navMs: 0,
      coverPts: 0,
      walkable: 0,
      friendlyFireBlocked: 0,
      openingGrenade: 'pending',
      openingGrenadeShooterDistance: null,
      openingGrenadeTargetDistance: null,
      openingGrenadeLandingDistance: null,
      openingGrenadeTargetError: null,
      openingGrenadePlayerHealth: null,
      openingGrenadePlayerDamage: null,
    };
    this._openingGrenade = {
      timer: this.rng.range(0.35, 0.65),
      shooter: null,
      target: new THREE.Vector3(),
    };

    /* scratch */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._probe = { y: 0, nx: 0, ny: 1, nz: 0, hit: false };
    this._tracerFrom = new THREE.Vector3();
    this._tracerTo = new THREE.Vector3();
    this._grenadeVelocity = new THREE.Vector3();
    this._grenadeArcFrom = new THREE.Vector3();
    this._grenadeArcPrevious = new THREE.Vector3();
    this._grenadeArcTo = new THREE.Vector3();
    this._grenadeArcDelta = new THREE.Vector3();
    this._fireEvent = {
      weapon: 'ai_rifle',
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      seed: 0,
      // Sprites and light are gained SEPARATELY: see _flashGain/_flashLight.
      // The sprites have to read as fire at 25 m; the punctual light must not
      // turn the shooter into the brightest object in the frame.
      intensity: 0.12,
      light: 0.006,
      // Size is gained separately from radiance: a 0.12-intensity flash scaled
      // geometrically by 0.12 is 3 mm across and invisible at 20 m.
      flashScale: 0.8,
    };
    this._shellEvent = { position: new THREE.Vector3(), velocity: new THREE.Vector3() };
    this._tracerEvent = { from: this._tracerFrom, to: this._tracerTo, speed: 800 };
    this._grenades = [];
    this._grenadeGeo = null;
    this._grenadeMat = null;

    /* ---- frame budgets and LOD state (see _updateRelevance / requestPath) ---- */
    this._pathBudget = 0;
    /** A* solves allowed per frame. Measured: one solve is 0.5-1.1 ms on the
     *  221x221 grid, and a squad that all enters combat on the same frame used to
     *  ask for six of them at once. */
    this.pathsPerFrame = 2;
    this.stats.pathsDeferred = 0;
    this._frustum = new THREE.Frustum();
    this._mvp = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();
    this._sweep = new THREE.Sphere();
    this._sun = new THREE.Vector3(0, 1, 0);
    this._lodStats = { irrelevant: 0 };

    this._wireEvents(ctx);
    console.info(
      `[ai] materials ${(performance.now() - t0).toFixed(0)}ms ` +
        `(${this.materials.bakeMs.toFixed(0)}ms texture bake)`
    );
    // The albedo budget is only real if it is measured. Print what every camo
    // bake actually landed on, so a drift out of 0.09-0.32 is visible in the
    // capture log instead of only in the critic's histogram.
    for (const k in this.materials.camoStats ?? {}) {
      const s = this.materials.camoStats[k];
      console.info(
        `[ai] camo ${k}: map mean ${s.mean.toFixed(3)} (was ${s.was.toFixed(3)}) ` +
          `range ${s.min.toFixed(3)}-${s.max.toFixed(3)} sd ${s.sd.toFixed(3)}`
      );
    }

    this._buildNav();
    if (!ctx.config.deterministic || this.forcePopulate) this.populate();
    // Core pre-warm compiles these after lighting and the HDR target are final.
    // Compiling here creates unused canvas/un-culled-light variants first.
  }

  /**
   * Build every character material and force its shader program to compile,
   * WITHOUT spawning a gameplay object and WITHOUT drawing a frame.
   *
   * This is the hook `src/core/prewarm.js` documents as missing: its `transients`
   * pass reached the character programs by staging a firefight, which left actors
   * and decals behind and blew the pixel gate. Nothing here is a gameplay object.
   *
   *  - `resolveMaterials()` is a pure function of the variant name, so every
   *    material every variant will ever ask for can be created now. It draws no
   *    random numbers, so the RNG stream — and therefore the picture — is
   *    untouched. It MUST be handed `MATERIAL_SLOTS` in the builder's own order:
   *    three sorts opaque draws (including the nine groups inside one soldier) by
   *    the global `Material.id` counter, so creating them in any other order
   *    reorders those draws and flips the depth tie on coplanar surfaces. That is
   *    a measured 2-pixel gate failure, not a theory — see MATERIAL_SLOTS.
   *  - the programs are compiled against a throwaway scene holding ONE dummy
   *    SkinnedMesh. The permutation three compiles is decided by the material
   *    plus the object's features (skinning, vertex colours, uv) and the target
   *    scene's lights, so a 6-triangle stand-in with the real 25-bone skeleton
   *    and the real vertex attributes yields the same programs a soldier does.
   *  - the cascade depth variant is compiled too, by borrowing render's own
   *    override material: `compileAsync` only ever looks at `object.material`, so
   *    the skinned depth program is otherwise not reachable without rendering a
   *    shadow map.
   *
   * Idempotent and never throws — a failed prewarm just means the old stutter.
   */
  async prewarmMaterials() {
    if (this._prewarmed) return this._prewarmed;
    const t0 = performance.now();
    const out = { ok: false, materials: 0, programs: 0, ms: 0 };
    this._prewarmed = out;
    try {
      const mats = [];
      const seen = new Set();
      for (const name in VARIANTS) {
        for (const m of resolveMaterials(name, MATERIAL_SLOTS, this.materials)) {
          if (m && !seen.has(m)) { seen.add(m); mats.push(m); }
        }
      }
      // the thrown grenade's mesh is built on the first throw, mid-firefight
      this._ensureGrenade();
      out.materials = mats.length + 1;

      const r = this.ctx.peek('render');
      if (r?.patcher) {
        for (const m of mats) r.patcher.patch(m);
        r.patcher.patch(this._grenadeMat);
      }
      const renderer = r?.renderer;
      if (!renderer) return out;
      const before = renderer.info.programs?.length ?? 0;

      const scene = new THREE.Scene();
      const { skeleton, root } = RIG.createSkeleton();
      const geo = this._dummySkinGeometry();
      const mesh = new THREE.SkinnedMesh(geo, mats);
      mesh.frustumCulled = false;
      scene.add(root);
      scene.add(mesh);
      mesh.bind(skeleton);

      const compile = async (target) => {
        try {
          await renderer.compileAsync(scene, this.ctx.camera, target);
        } catch {
          try { renderer.compile(scene, this.ctx.camera, target); } catch { /* driver */ }
        }
      };
      await compile(this.ctx.scene);
      // cascade depth: same object, render's own override material
      const depth = r.csm?.depthMaterial;
      if (depth) {
        mesh.material = depth;
        await compile(this.ctx.scene);
      }
      // the grenade is a plain (unskinned) mesh, so it needs its own object
      scene.remove(mesh);
      const g = new THREE.Mesh(this._grenadeGeo, this._grenadeMat);
      scene.add(g);
      await compile(this.ctx.scene);
      scene.remove(g);

      geo.dispose();
      skeleton.dispose?.();
      out.programs = (renderer.info.programs?.length ?? 0) - before;
      out.ok = true;
    } catch (err) {
      out.error = String(err?.message ?? err);
    }
    out.ms = Math.round(performance.now() - t0);
    console.info(`[ai] prewarmMaterials ${JSON.stringify(out)}`);
    return out;
  }

  /**
   * A 2-triangle skinned stand-in carrying exactly the attributes a soldier's
   * geometry does — position, normal, uv, colour, skinIndex, skinWeight. Three
   * derives half of the shader permutation from the geometry's attributes, so
   * anything missing here would compile the wrong program.
   */
  _dummySkinGeometry() {
    const g = new THREE.BufferGeometry();
    const n = 3;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(n * 4), 4));
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) w[i * 4] = 1;
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    return g;
  }

  /* ================================================================== */
  /* events                                                             */
  /* ================================================================== */

  _wireEvents(ctx) {
    this._off = [];
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));

    on('weapon:fire', (e) => {
      if (!e || !e.origin || e.weapon === 'ai_rifle') return; // ignore our own
      // A gunshot is the loudest thing in the level: everybody hears it, and
      // anyone near the line of fire also feels suppressed by it.
      for (const a of this.agents) {
        if (!a.alive) continue;
        a.hear(e.origin, 90);
        if (e.dir) {
          const d = this._distanceToRay(a.position, e.origin, e.dir, a.eyeHeight);
          if (d < 2.6) a.suppress(0.45 * (1 - d / 2.6) + 0.12);
        }
      }
    });

    on('bullet:impact', (e) => {
      if (!e || !e.point) return;
      for (const a of this.agents) {
        if (!a.alive) continue;
        const d = a.position.distanceTo(e.point);
        if (d < 3.2) a.suppress(0.5 * (1 - d / 3.2));
        else if (d < 12) a.hear(e.point, 12);
      }
    });

    on('damage:dealt', (e) => {
      if (!e || !e.target || !(e.target instanceof Agent)) return;
      const a = e.target;
      if (!a.alive) return;
      const amount = e.amount * this._falloff(e.point);
      a.applyDamage(amount, e.headshot ? 'head' : e.part ?? 'torso', e.point ?? a.position, e.incident);
      if (!a.alive) e.killed = true;
    });

    on('explosion', (e) => {
      if (!e || !e.position) return;
      const radius = e.radius ?? 5;
      const sourceAgent = e.source instanceof Agent ? e.source : null;
      for (const a of this.agents) {
        if (!a.alive) continue;
        const d = a.position.distanceTo(e.position) + 0.001;
        a.hear(e.position, 120);
        if (d > radius) continue;
        if (this.phys && !this.phys.lineOfSight(e.position, a.eye, this.phys.MASK.EXPLOSION)) continue;
        const f = 1 - d / radius;
        this._v.copy(a.position).sub(e.position).normalize();
        a.suppress(1.4 * f);
        if (sourceAgent && a.team === sourceAgent.team) {
          this.stats.friendlyFireBlocked++;
          continue;
        }
        a.applyDamage((e.damage ?? 100) * f * f, 'torso', a.eye, this._v);
      }
    });

    on('player:footstep', (e) => {
      if (!e || !e.position) return;
      const loud = e.running ? 24 : 11;
      for (const a of this.agents) if (a.alive) a.hear(e.position, loud);
    });

    on('world:destruction', ({ bounds }) => this._navDirty.union(bounds));
  }

  _falloff(point) {
    if (!point) return 1;
    const p = this.playerPosition(this._v2);
    if (!p) return 1;
    const d = p.distanceTo(point);
    // full damage inside 22 m, tapering to 45 % by 70 m
    return d < 22 ? 1 : Math.max(0.45, 1 - (d - 22) * 0.0125);
  }

  _distanceToRay(point, origin, dir, eyeH) {
    const px = point.x - origin.x;
    const py = point.y + eyeH * 0.7 - origin.y;
    const pz = point.z - origin.z;
    const t = Math.max(0, px * dir.x + py * dir.y + pz * dir.z);
    return Math.hypot(px - dir.x * t, py - dir.y * t, pz - dir.z * t);
  }

  /* ================================================================== */
  /* assets                                                             */
  /* ================================================================== */

  variant(name) {
    let v = this._variants.get(name);
    if (!v) {
      const t0 = performance.now();
      v = buildSoldier(name, { rng: this.rng.fork(), materials: this.materials });
      this._variants.set(name, v);
      // Hand the new materials to render immediately rather than waiting for its
      // scene walk: they are all MeshStandardMaterial, so the patcher injects the
      // CSM sun shadow, the screen-space contact shadow, GTAO and the bounce fill
      // into them. Without the shadow term a character is lit by ambient alone
      // and looks pasted onto the ground.
      const r = this.ctx.peek('render');
      if (r?.patcher) for (const m of v.materials) r.patcher.patch(m);
      console.info(
        `[ai] variant "${name}" ${v.stats.triangles | 0} tris / ${v.stats.vertices} verts / ` +
          `${v.materials.length} materials in ${(performance.now() - t0).toFixed(0)}ms`
      );
    }
    return v;
  }

  /** Bone index lookup for the shared rig (used by the ragdoll spec). */
  rigIndex(name) {
    return RIG.index(name);
  }

  get phys() {
    return this._phys ?? (this._phys = this.ctx.peek('physics'));
  }

  /* ================================================================== */
  /* navigation                                                         */
  /* ================================================================== */

  _buildNav() {
    const phys = this.phys;
    const world = this.ctx.peek('world');
    if (!phys) throw new Error('[ai] Navigation requires the physics system.');
    if (phys.staticWorld.dirty) phys.rebuildStatic();
    if (phys.triangleCount <= 0) throw new Error('[ai] Navigation requires loaded level collision geometry.');
    const bounds =
      world?.bounds?.clone?.() ??
      new THREE.Box3(new THREE.Vector3(-70, -4, -70), new THREE.Vector3(70, 24, 70));
    bounds.expandByScalar(2);
    const t0 = performance.now();
    this.grid = new NavGrid(phys, { bounds, cell: 0.8, radius: 0.36, height: 1.78 });
    this.grid.build();
    this.cover = new CoverMap(this.grid, phys);
    this.cover.build({ step: 1, reach: 1.3 });
    this.stats.navMs = performance.now() - t0;
    this.stats.coverPts = this.cover.points.length;
    this.stats.walkable = this.grid.walkableCount;
    console.info(
      `[ai] nav ${this.grid.nx}x${this.grid.nz} cells · ${this.grid.walkableCount} walkable · ` +
        `${this.cover.points.length} cover points · ${this.stats.navMs.toFixed(0)}ms`
    );
  }

  _refreshNavigation() {
    if (this._navDirty.isEmpty()) return;
    this.grid.build(this._navDirty);
    this.cover.build({ bounds: this._navDirty });
    this._navDirty.makeEmpty();
    this.stats.walkable = this.grid.walkableCount;
    this.stats.coverPts = this.cover.points.length;
    for (const a of this.agents) {
      if (a.cover && !this.cover.points.includes(a.cover)) {
        a.cover = null;
        a.repathTimer = 0;
      }
      if (a.hasMoveTarget) {
        a._pendingDest.copy(a.moveTarget);
        a.pathPending = true;
      }
    }
  }

  /** Floor probe used by foot IK and spawning. */
  probeGround(x, z, fromY, out) {
    const phys = this.phys;
    if (!phys) return false;
    const h = phys.raycast(x, fromY, z, 0, -1, 0, 3.2, phys.MASK.WORLD);
    if (!h.hit) return false;
    out.y = h.point.y;
    out.nx = h.normal.x;
    out.ny = h.normal.y;
    out.nz = h.normal.z;
    out.hit = true;
    return true;
  }

  groundAt(x, z, fromY = 40) {
    const phys = this.phys;
    if (!phys) return 0;
    const h = phys.raycast(x, fromY, z, 0, -1, 0, 80, phys.MASK.WORLD);
    if (h.hit) return h.point.y;
    return this.ctx.peek('world')?.groundHeight?.(x, z) ?? 0;
  }

  /** Aim at the upper body of the same stance-aware capsule that takes hits. */
  playerPosition(out) {
    const c = this.ctx.get('player').hitbox;
    if (!c) throw new Error('[ai] Player hitbox must be initialized before enemy perception.');
    return out.set(c.ax + (c.bx - c.ax) * 0.8, c.ay + (c.by - c.ay) * 0.8, c.az + (c.bz - c.az) * 0.8);
  }

  /** Same ground-haze extinction and live smoke that obscure rendered targets. */
  visibilityBetween(from, to) {
    const fog = this.ctx.get('sky').fog;
    const density = (Math.exp(-(from.y - fog.baseY) / fog.heightScale) +
      Math.exp(-(to.y - fog.baseY) / fog.heightScale)) * 0.5;
    const haze = Math.exp(-fog.extinction * density * from.distanceTo(to));
    return haze * this.ctx.get('fx').visibilityBetween(from, to);
  }

  /* ================================================================== */
  /* spawning                                                           */
  /* ================================================================== */

  spawn(variantName, position, yaw = 0, opts = {}) {
    const a = new Agent(this, { variant: variantName, position, yaw, ...opts });
    this.agents.push(a);
    return a;
  }

  resetWave({ count = 6, difficulty = 1 } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 12 || !Number.isFinite(difficulty) || difficulty < 1 || difficulty > 2) {
      throw new Error('[ai] resetWave requires count 1..12 and difficulty 1..2.');
    }
    this._refreshNavigation();
    this._clearActors();
    this._openingGrenade.timer = this.rng.range(0.35, 0.65);
    this._openingGrenade.shooter = null;
    this._openingGrenade.target.set(0, 0, 0);
    for (const key in this.stats) if (key.startsWith('openingGrenade')) this.stats[key] = null;
    this.stats.openingGrenade = 'pending';
    this.stats.friendlyFireBlocked = this.stats.pathsDeferred = 0;
    return this.populate({ count, difficulty });
  }

  _clearActors() {
    for (const a of this.agents) a.dispose();
    this.agents.length = this.squads.length = 0;
    for (const g of this._grenades) {
      if (g.body) this.phys.removeRigidBody(g.body);
      this.root.remove(g.mesh);
    }
    this._grenades.length = 0;
    this._stagedAgents = null;
    for (const point of this.cover?.points ?? []) point.claimed = -1;
    this.ground.begin();
    this.ground.end();
    this.stats.agents = this.stats.alive = 0;
  }

  /**
   * Garrison the level: two squads on patrol routes drawn from the world's own
   * spawn points, far enough from the player to be found rather than spawned on
   * top of. This is what the behaviour tree, navigation and perception actually
   * run against in play.
   */
  populate(opts = {}) {
    const world = this.ctx.peek('world');
    const spawns = world?.spawnPoints ?? [];
    if (!spawns.length || !this.grid) throw new Error('[ai] Cannot populate enemies without spawn points and navigation.');
    const player = this.playerPosition(this._v3).clone();
    // rank the spawn points by distance from the player, take the far half
    const ranked = spawns
      .map((s, i) => ({ s, i, d: s.position.distanceTo(player) }))
      .sort((a, b) => b.d - a.d)
      .filter((e) => e.d > 18);
    if (!ranked.length) throw new Error('[ai] No enemy spawn point is safely distant from the player.');

    const variants = ['vanguard', 'irregular', 'breacher'];
    const per = opts.perSquad ?? 3;
    const count = opts.count ?? (opts.squads ?? 2) * per;
    const squads = Math.ceil(count / per);
    let made = 0;
    const occupied = new Set();
    const spawnPath = [];
    for (let q = 0; q < squads; q++) {
      const squad = this.createSquad();
      const anchor = ranked[q % ranked.length].s;
      // patrol route: this spawn point and the two next-nearest ones
      const route = [anchor.position.clone()];
      const others = ranked
        .filter((e) => e.s !== anchor)
        .sort(
          (a, b) =>
            a.s.position.distanceTo(anchor.position) - b.s.position.distanceTo(anchor.position)
        )
        .slice(0, 2);
      for (const o of others) route.push(o.s.position.clone());
      // Authored points describe ground-level patrols, not the tops of props
      // that happen to occupy the same map cell.
      for (const point of route) {
        const ci = this.grid.nearest(point.x, point.z, point.y, 6, this.grid.maxStep);
        if (ci < 0) throw new Error('[ai] Patrol point has no walkable ground cell.');
        point.set(this.grid.worldX(ci % this.grid.nx), this.grid.floor[ci], this.grid.worldZ((ci / this.grid.nx) | 0));
        if (!this.grid.findPath(point, player, spawnPath)) throw new Error('[ai] Patrol point is unreachable from the player.');
      }

      for (let m = 0; m < per && made < count; m++) {
        const variant = variants[(q * per + m) % variants.length];
        const scale = VARIANTS[variant].scale;
        const radius = 0.34 * scale, height = 1.78 * scale;
        const jitterA = this.rng.range(0, Math.PI * 2);
        const jitterR = this.rng.range(0.8, 3.2);
        const p = anchor.position
          .clone()
          .add(new THREE.Vector3(Math.cos(jitterA) * jitterR, 0, Math.sin(jitterA) * jitterR));
        let ci = -1;
        for (let attempt = 0; attempt <= 12; attempt++) {
          if (attempt) {
            const angle = jitterA + attempt * 2.4;
            p.set(anchor.position.x + Math.cos(angle) * (2 + attempt * 0.45),
              anchor.position.y, anchor.position.z + Math.sin(angle) * (2 + attempt * 0.45));
          }
          ci = this.grid.nearest(p.x, p.z, anchor.position.y, 6, this.grid.maxStep);
          if (ci < 0 || occupied.has(ci)) continue;
          p.set(this.grid.worldX(ci % this.grid.nx), this.grid.floor[ci], this.grid.worldZ((ci / this.grid.nx) | 0));
          this._v.set(p.x, p.y + radius, p.z);
          this._v2.set(p.x, p.y + height - radius, p.z);
          // Match the actual character capsule: the grid's chest-height rays
          // can miss a low prop and its walkable cells can be isolated islands.
          if (this.phys.checkCapsule(this._v, this._v2, radius - 0.005) &&
              this.grid.findPath(p, player, spawnPath) > 0) break;
          ci = -1;
        }
        if (ci < 0 || occupied.has(ci)) throw new Error(`[ai] No free reachable spawn cell for enemy ${made + 1}/${count}.`);
        occupied.add(ci);
        const a = this.spawn(variant, p, anchor.yaw + this.rng.signed() * 0.7, {
          patrol: route, difficulty: opts.difficulty ?? 1,
        });
        squad.add(a);
        made++;
      }
    }
    this.stats.agents = this.agents.length;
    this.stats.alive = this.agents.filter(a => a.alive).length;
    console.info(`[ai] garrison: ${made} enemies in ${squads} squads`);
    return made;
  }

  createSquad() {
    const s = new Squad(this.rng.fork());
    this.squads.push(s);
    return s;
  }

  /* ================================================================== */
  /* opening combat beat                                                */
  /* ================================================================== */

  _updateOpeningGrenade(dt) {
    const opening = this._openingGrenade;
    if (!opening || this.stats.openingGrenade !== 'pending') return;
    const playerSystem = this.ctx.peek('player');
    if (!playerSystem || playerSystem.dead || !this.agents.length) return;
    opening.timer -= dt;
    if (opening.timer > 0) return;

    const player = this.playerPosition(this._v3);
    const candidates = [];
    for (const agent of this.agents) {
      if (!agent.alive || !agent.hasGrenade || agent.openingGrenade) continue;
      const distance = agent.position.distanceTo(player);
      if (distance >= 28) candidates.push({ agent, distance });
    }
    candidates.sort((a, b) => b.distance - a.distance);
    const top = Math.min(3, candidates.length);
    if (!top) {
      opening.timer = 0.25;
      return;
    }

    // Try a few truthful landing points between the distant shooter and the
    // player. Every accepted point is at least 11.5 m from the player's current
    // position, comfortably outside the 6.5 m damage radius, and visible from
    // both ends so the opening explosion reads rather than disappearing behind
    // a building.
    for (let attempt = 0; attempt < 8; attempt++) {
      const picked = candidates[this.rng.int(0, top - 1)];
      const agent = picked.agent;
      const towardShooter = this._v.copy(agent.position).sub(player).setY(0).normalize();
      const lateral = this._v2.set(-towardShooter.z, 0, towardShooter.x);
      const target = opening.target
        .copy(player)
        .addScaledVector(towardShooter, this.rng.range(11.5, 14.5))
        .addScaledVector(lateral, this.rng.range(-3.5, 3.5));
      target.y = this.groundAt(target.x, target.z, player.y + 8) + 0.08;

      const sightTarget = this._tracerTo.copy(target).setY(target.y + 0.7);
      const shooterClear = !this.phys || this.phys.lineOfSight(agent.eye, sightTarget, this.phys.MASK.SIGHT);
      const playerClear = !this.phys || this.phys.lineOfSight(player, sightTarget, this.phys.MASK.SIGHT);
      const launch = agent.grenadeOrigin(target, this._grenadeArcFrom);
      const arcClear = this._grenadeArcClear(launch, target);
      if (!shooterClear || !playerClear || !arcClear) continue;

      if (!agent.queueOpeningGrenade(player, target, this.rng.range(0.5, 0.8))) continue;
      if (agent.squad) agent.squad.grenadeCooldown = Math.max(agent.squad.grenadeCooldown, 14);
      opening.shooter = agent;
      this.stats.openingGrenade = 'aiming';
      this.stats.openingGrenadeShooterDistance = Number(picked.distance.toFixed(2));
      this.stats.openingGrenadeTargetDistance = Number(player.distanceTo(target).toFixed(2));
      return;
    }

    opening.timer = 0.25;
  }

  onOpeningGrenadeThrown(agent, target) {
    if (agent !== this._openingGrenade?.shooter) return;
    this.stats.openingGrenade = 'thrown';
    this._openingGrenade.target.copy(target);
  }

  /** Solve the same lob used by the live rigid body. Returns time to ground. */
  _solveGrenadeVelocity(from, target, out) {
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const dist = Math.max(0.5, Math.hypot(dx, dz));
    const g = Math.abs(this.phys.gravity) * GRENADE_GRAVITY_SCALE;
    // 22 m/s supports the map's 50 m opening throw while remaining inside the
    // measured 20-25 m/s range of an athletic overhand grenade throw.
    const speed = Math.min(22, Math.sqrt(Math.max(4, (dist * g) / 0.95)));
    const vy = speed * 0.62;
    const drop = Math.max(-2, from.y - target.y);
    const flightTime = Math.max(0.35, (vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * drop))) / g);
    const vh = Math.min(speed, dist / flightTime);
    out.set((dx / dist) * vh, vy, (dz / dist) * vh);
    return flightTime;
  }

  /** Reject an opening throw whose real ballistic arc intersects the level. */
  _grenadeArcClear(from, target) {
    const phys = this.phys;
    if (!phys) return false;
    const velocity = this._grenadeVelocity;
    const flightTime = this._solveGrenadeVelocity(from, target, velocity);
    const gravity = phys.gravity * GRENADE_GRAVITY_SCALE;
    const previous = this._grenadeArcPrevious.copy(from);
    const point = this._grenadeArcTo;
    const segments = 14;
    // Stop just before contact with the intended ground plane. The ground hit
    // itself is the desired end of the throw, not an obstruction.
    for (let i = 1; i <= segments; i++) {
      const t = flightTime * 0.96 * (i / segments);
      point.copy(from).addScaledVector(velocity, t);
      point.y += 0.5 * gravity * t * t;
      const delta = this._grenadeArcDelta.copy(point).sub(previous);
      const distance = delta.length();
      if (distance > 1e-4 && phys.raycastAny(previous, delta, distance, phys.MASK.DEBRIS)) return false;
      previous.copy(point);
    }
    return true;
  }

  /* ================================================================== */
  /* firing                                                             */
  /* ================================================================== */

  /** 0 at night, 1 in full daylight. Drives both flash gains below. */
  _daylight() {
    const sky = this._sky ?? (this._sky = this.ctx.peek('sky'));
    const alt = sky?.sunAltitude ?? 0.6; // radians above the horizon
    return Math.min(1, Math.max(0, Math.sin(Math.max(0, alt)) * 4));
  }

  /**
   * SPRITE gain. The flash itself has to be *visible* — a firefight with no fire
   * in it is not a firefight — so this stays high enough to read as burning gas
   * at 10-25 m and is only trimmed in daylight, where the sun is competing.
   */
  _flashGain() {
    return 0.12 + 0.5 * (1 - this._daylight());
  }

  /**
   * LIGHT gain, deliberately separate and two orders of magnitude smaller.
   *
   * The crown sits 0.6 m from the shooter's own chest, so a player-strength
   * 90 cd flash puts 90/0.36 = 250 W/m^2 on him against 4 W/m^2 of sun. That is
   * the whole reason the soldiers used to render BRIGHTER than the sunlit stucco
   * behind them: they were being lit, on the frame the shutter fell, by their own
   * muzzle flash. A real flash is ~1 ms inside a 16 ms frame, so the honest
   * time-averaged contribution in daylight is a highlight on the receiver and
   * nothing more; after dark it is the only light there is and gets to earn its
   * keep. Measured: torso 0.44 -> 0.13 linear, i.e. from 1.9x the sunlit wall to
   * 0.55x, which is what an 0.19-albedo uniform in shade should be.
   */
  _flashLight() {
    const day = this._daylight();
    return 0.006 + 0.05 * (1 - day);
  }

  onAgentFire(agent, origin, dir) {
    const ctx = this.ctx;
    const phys = this.phys;

    // muzzle flash, light and smoke come from fx via the canonical event
    const fe = this._fireEvent;
    fe.origin.copy(origin);
    fe.dir.copy(dir);
    fe.intensity = this._flashGain();
    fe.light = this._flashLight();
    fe.flashScale = 0.8;
    fe.seed = (agent.id * 2654435761 + ctx.time.frame) >>> 0;
    ctx.events.emit('weapon:fire', fe);

    // ejected case
    const se = this._shellEvent;
    se.position.copy(agent.animator.ejectWorld);
    se.velocity.set(dir.z, 0.55, -dir.x).multiplyScalar(2.1).addScaledVector(dir, -0.6);
    ctx.events.emit('weapon:shell', se);

    // the round itself
    let end = null;
    if (phys) {
      const impacts = phys.fireBullet({
        origin,
        dir,
        damage: agent.weaponDamage,
        penetration: 0.9,
        maxDist: 200,
        // Enemy rounds resolve the player capsule separately below. Removing
        // ACTOR here prevents a squad from shooting its own members while
        // preserving all world impacts, penetration, tracers, and player hits.
        mask: phys.MASK.BULLET & ~phys.LAYER.ACTOR,
      });
      if (impacts.length) end = impacts[0].point;
    }
    // Resolve the existing player capsule separately from penetrable scenery.
    // Staged agents shoot for the camera, not for blood: a capture must not be
    // graded through the player's low-health filter.
    const playerHitT = !agent.staged?.noDamage
      ? this._testPlayerHit(agent, origin, dir, end)
      : null;
    if (playerHitT !== null) {
      // The player capsule is tested outside the world physics BVH. Keep the
      // tracer on that same resolved path and stop it at the capsule entry point
      // instead of letting the light continue through the player.
      this._v3.copy(origin).addScaledVector(dir, playerHitT);
      end = this._v3;
    }

    this._tracerFrom.copy(origin);
    if (end) this._tracerTo.copy(end);
    else this._tracerTo.copy(origin).addScaledVector(dir, 120);
    if ((agent.id + agent.ammo) % 3 === 0) ctx.events.emit('bullet:tracer', this._tracerEvent);
  }

  _testPlayerHit(agent, origin, dir, end) {
    const player = this.ctx.get('player');
    const c = player.hitbox;
    if (!c?.enabled || player.dead) return null;
    const maxT = end ? origin.distanceTo(end) : 200;
    const hitT = rayCapsule(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
      c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.radius, maxT);
    const p = this.playerPosition(this._v);
    const t = Math.max(0, Math.min(maxT, this._v2.copy(p).sub(origin).dot(dir)));
    const miss = this._v2.copy(origin).addScaledVector(dir, t).distanceTo(p);
    if (hitT < 0) return null;
    const amount = agent.weaponDamage * (miss < 0.16 ? 1.25 : 1);
    p.copy(origin).addScaledVector(dir, hitT);
    this._v2.copy(origin);
    // Damage is applied *only* through the event below. `player` listens for
    // `damage:dealt` with itself as the target, so calling applyDamage() here as
    // well wounded the player twice for every round that connected.
    this.ctx.events.emit('damage:dealt', {
      target: player,
      amount,
      headshot: false,
      killed: false,
      point: p,
      from: this._v2,
      source: agent,
    });
    return hitT;
  }

  emitReload(agent) {
    this.ctx.events.emit('weapon:reload', { weapon: 'ai_rifle', phase: 'start', actor: agent });
  }

  /** Grenade geometry + material. Built at prewarm, not on the first throw. */
  _ensureGrenade() {
    if (this._grenadeGeo) return;
    this._grenadeGeo = new THREE.IcosahedronGeometry(0.045, 1);
    this._grenadeMat = new THREE.MeshStandardMaterial({
      color: 0x2c3226,
      roughness: 0.62,
      metalness: 0.85,
    });
  }

  throwGrenade(agent, from, target, opts = {}) {
    const phys = this.phys;
    if (!phys) return;
    this._ensureGrenade();
    const mesh = new THREE.Mesh(this._grenadeGeo, this._grenadeMat);
    this.root.add(mesh);
    // lobbed ballistic solve
    const velocity = this._grenadeVelocity;
    const flightTime = this._solveGrenadeVelocity(from, target, velocity);
    const opening = opts.opening === true;
    const grenade = {
      body: null,
      mesh,
      fuse: Math.max(2.35, flightTime + 0.35),
      agent,
      opening,
      target: target.clone(),
    };
    if (opening) {
      // The opening throw follows the exact ballistic arc already validated
      // against level geometry. Keeping this authored beat analytic prevents
      // the general debris solver from introducing frame-rate-dependent
      // bounces, while normal combat grenades retain full rigid-body physics.
      grenade.origin = from.clone();
      grenade.velocity = velocity.clone();
      grenade.gravity = phys.gravity * GRENADE_GRAVITY_SCALE;
      grenade.flightTime = flightTime;
      grenade.age = 0;
      grenade.fuse = flightTime;
      mesh.position.copy(from);
    } else {
      grenade.body = phys.addRigidBody({
        shape: 'sphere',
        radius: 0.05,
        mass: 0.42,
        position: from,
        velocity,
        restitution: 0.28,
        friction: 0.7,
        linearDamping: 0.01,
        gravityScale: GRENADE_GRAVITY_SCALE,
        lifetime: 9,
        object3D: mesh,
        surfaceType: 'metal',
      });
    }
    this._grenades.push(grenade);
    agent?.animator?.fire?.(0.35);
    return true;
  }

  _updateGrenades(dt) {
    for (let i = this._grenades.length - 1; i >= 0; i--) {
      const g = this._grenades[i];
      let p;
      if (g.opening) {
        g.age += dt;
        const t = Math.min(g.age, g.flightTime);
        g.mesh.position.copy(g.origin).addScaledVector(g.velocity, t);
        g.mesh.position.y += 0.5 * g.gravity * t * t;
        if (g.age < g.flightTime) continue;
        g.mesh.position.copy(g.target);
        p = g.mesh.position;
      } else {
        g.fuse -= dt;
        if (g.fuse > 0) continue;
        p = g.body?.position ?? g.mesh.position;
      }
      const player = this.ctx.peek('player');
      const healthBefore = player?.health?.value ?? 0;
      this.ctx.events.emit('explosion', {
        position: new THREE.Vector3(p.x, p.y, p.z),
        radius: 6.5,
        damage: 120,
        source: g.agent,
      });
      if (g.opening) {
        const playerPosition = this.playerPosition(this._v);
        const healthAfter = player?.health?.value ?? healthBefore;
        this.stats.openingGrenade = 'exploded';
        this.stats.openingGrenadeLandingDistance = Number(playerPosition.distanceTo(p).toFixed(2));
        this.stats.openingGrenadeTargetError = Number(g.target.distanceTo(p).toFixed(2));
        this.stats.openingGrenadePlayerHealth = Number(healthAfter.toFixed(1));
        this.stats.openingGrenadePlayerDamage = Number(
          Math.max(0, healthBefore - healthAfter).toFixed(1)
        );
      }
      if (g.body) this.phys?.removeRigidBody(g.body);
      this.root.remove(g.mesh);
      this._grenades.splice(i, 1);
    }
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  update(dt, ctx) {
    if (dt <= 0) return;
    this._refreshNavigation();

    // Per-frame A* budget: see requestPath().
    this._pathBudget = this.pathsPerFrame;
    this._updateRelevance(ctx);

    for (const s of this.squads) s.update(dt);

    this._updateOpeningGrenade(dt);

    let alive = 0;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.alive) {
        if (a.staged) this._updateStaged(a, dt);
        else a.update(dt, ctx);
        alive++;
      } else if (a.deadTime !== undefined) {
        a.deadTime += dt;
        if (this.debugLog && a.ragdoll && !a._loggedDoll && a.deadTime > 1.2) {
          a._loggedDoll = true;
          const b = a.ragdoll.aabb;
          console.info(
            `[ai] ragdoll ${a.id} settled: ${(b.maxx - b.minx).toFixed(2)} x ` +
              `${(b.maxy - b.miny).toFixed(2)} x ${(b.maxz - b.minz).toFixed(2)} m ` +
              `at y=${b.miny.toFixed(2)} sleeping=${a.ragdoll.sleeping}`
          );
        }
      }
    }
    this._updateGrenades(dt);
    this.stats.agents = this.agents.length;
    this.stats.alive = alive;
  }

  lateUpdate() {
    const g = this.ground;
    g.begin();
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      a.syncHitboxes();
      // Dead men keep their contact: a ragdoll on the floor needs it most.
      g.addActor(a);
    }
    g.end();
  }

  /* ================================================================== */
  /* frame budgets and LOD                                              */
  /* ================================================================== */

  /**
   * A* on the shared grid, rationed. Returns the waypoint count, or -1 when this
   * frame's budget is spent — the caller keeps its old path and asks again next
   * frame, which is invisible at 60 Hz and turns a squad-wide repath (six solves,
   * ~5 ms, on the frame the player opens fire) into two solves per frame.
   */
  requestPath(from, dest, out) {
    if (!this.grid) return 0;
    if (this._pathBudget <= 0) {
      this.stats.pathsDeferred++;
      return -1;
    }
    this._pathBudget--;
    return this.grid.findPath(from, dest, out);
  }

  /** Unit vector pointing AT the sun, however the sky exposes itself. */
  _sunDirection() {
    const sky = this._sky ?? (this._sky = this.ctx.peek('sky'));
    const d = sky?.sunDirection;
    if (d && Number.isFinite(d.x)) this._sun.copy(d);
    else this._sun.set(0.3, 0.8, 0.4);
    if (this._sun.lengthSq() < 1e-8) this._sun.set(0, 1, 0);
    return this._sun.normalize();
  }

  /**
   * Decide, per actor, whether anything it does this frame can reach a pixel.
   *
   * An actor is IRRELEVANT only when both of these hold:
   *   1. its (already 1.45x inflated) bounding sphere, grown by a further 4 m,
   *      misses the camera frustum — so it is not drawn, and no screen-space
   *      effect can sample it either, because it is not in the depth buffer;
   *   2. the volume its sun shadow could possibly darken misses the frustum too.
   *      For a directional light that volume is exactly the actor's sphere swept
   *      along -sunDir: a visible surface can only be shadowed by this actor if
   *      the ray from that surface toward the sun passes through it. Sweeping to
   *      where the ray leaves the level below the floor covers every receiver,
   *      ground or wall, and the 4 m of slack absorbs both the soft-shadow filter
   *      radius (up to ~1 m of cascade texels) and a frame of camera motion.
   *
   * Irrelevant actors animate at a third of the rate and are dropped from the
   * shadow cascades (`userData.owNoShadow`, which render honours per frame). They
   * are still simulated, still shootable, still make noise — only the parts that
   * can exclusively affect pixels are skipped.
   */
  _updateRelevance(ctx) {
    const cam = ctx.camera;
    this._mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._mvp);
    const sun = this._sunDirection();
    // how far a shadow ray can travel before it is under the level
    const floorY = (this.grid ? -6 : -20);
    const sunY = Math.max(0.06, sun.y);
    let irrelevant = 0;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const geo = a.mesh.geometry;
      const bs = geo.boundingSphere;
      if (!bs) { a.lodIrrelevant = false; continue; }
      const s = this._sphere.copy(bs).applyMatrix4(a.mesh.matrixWorld);
      s.radius += 4;
      let visible = this._frustum.intersectsSphere(s);
      if (!visible) {
        const sweep = this._sweep;
        const tMax = Math.min(320, (s.center.y - floorY) / sunY);
        const step = Math.max(2, s.radius * 0.9);
        sweep.radius = s.radius;
        for (let t = step; t <= tMax; t += step) {
          sweep.center.copy(s.center).addScaledVector(sun, -t);
          if (this._frustum.intersectsSphere(sweep)) { visible = true; break; }
        }
      }
      a.lodIrrelevant = !visible;
      if (!visible) irrelevant++;
      a.mesh.userData.owNoShadow = !visible;
    }
    this._lodStats.irrelevant = irrelevant;
    this.stats.lodIrrelevant = irrelevant;
  }

  /* ================================================================== */
  /* staged tableau for the capture harness                             */
  /* ================================================================== */

  /**
   * Pin an agent into a photogenic combat beat: it still animates, aims and
   * fires for real, it just does not get to decide where to stand.
   */
  _updateStaged(a, dt) {
    const s = a.staged;
    const p = this.playerPosition(this._v3);
    a.stateTime += dt;
    a.fireCooldown -= dt;
    a.burstCooldown -= dt;
    a.state = STATE.COMBAT;
    a.hasTarget = true;
    a.targetVisible = true;
    a.targetVisibility = a.awareness = 1;
    a.targetDistance = a.position.distanceTo(p);
    a.alertness = 1;
    a.lastKnown.copy(p);
    a.lastKnownAge = 0;
    a.crouch = !!s.crouch;
    a.aimWeight = s.aimWeight ?? 1;
    a.suppression = s.suppression ?? 0;
    a.desiredSpeed = s.speed ?? 0;
    a.wantFire = s.fire !== false;
    if (s.speed) {
      a.hasMoveTarget = true;
      if (!a.path[0]) a.path[0] = new THREE.Vector3();
      a.path[0].copy(a.position).addScaledVector(s.heading, 6);
      a.pathLen = 1;
      a.pathIndex = 0;
    } else {
      a.hasMoveTarget = false;
    }
    if (s.reloadEvery && a.stateTime > s.reloadEvery && !a.animator.reloading) {
      a.stateTime = 0;
      a.animator.reload(2.4);
    }
    a._move(dt);
    a._shoot(dt);
    a._drive(dt);
  }

  /**
   * Compose a staged enemy into the frame: find the walkable spot whose
   * projected screen position and depth best match the requested composition,
   * that the camera can actually see, that is not on top of another actor, and
   * that has cover nearby. Occlusion is checked at chest and head height, which
   * is what stops a soldier being placed behind a market stall.
   */
  _stageSlot(cam, ndcX, wantDepth, placed) {
    const g = this.grid;
    const F = this._v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    F.y = 0;
    F.normalize();
    const rx = F.z, rz = -F.x; // camera right, flattened
    const tanH = Math.tan((cam.fov * Math.PI) / 360) * cam.aspect;
    const ideal = new THREE.Vector3()
      .copy(cam.position)
      .addScaledVector(F, wantDepth)
      .add(this._v2.set(rx, 0, rz).multiplyScalar(ndcX * tanH * wantDepth));
    const yRef = cam.position.y - 1.7;
    const out = new THREE.Vector3(ideal.x, yRef, ideal.z);
    if (!g) {
      out.y = this.groundAt(out.x, out.z, cam.position.y + 3);
      return out;
    }
    const chest = this._v3;
    const cx = g.cellX(ideal.x), cz = g.cellZ(ideal.z);
    const span = Math.ceil(7 / g.cell);
    let best = -1, bestScore = Infinity, bestX = 0, bestZ = 0;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const ix = cx + dx, iz = cz + dz;
        if (!g.walkable(ix, iz)) continue;
        const i = g.index(ix, iz);
        const fy = g.floor[i];
        if (Math.abs(fy - yRef) > 1.0) continue;
        const x = g.worldX(ix), z = g.worldZ(iz);
        // spacing from the men already placed
        let tooClose = false;
        for (const q of placed) {
          if (Math.hypot(q.x - x, q.z - z) < 2.4) { tooClose = true; break; }
        }
        if (tooClose) continue;
        // project
        const ex = x - cam.position.x, ez = z - cam.position.z;
        const depth = ex * F.x + ez * F.z;
        if (depth < 3) continue;
        const lateral = ex * rx + ez * rz;
        const ndc = lateral / (depth * tanH);
        // must be visible: chest and head
        if (this.phys) {
          chest.set(x, fy + 1.25, z);
          if (!this.phys.lineOfSight(cam.position, chest, this.phys.MASK.SIGHT)) continue;
          chest.set(x, fy + 1.62, z);
          if (!this.phys.lineOfSight(cam.position, chest, this.phys.MASK.SIGHT)) continue;
        }
        let score = Math.abs(ndc - ndcX) * 9 + Math.abs(depth - wantDepth) * 0.5;
        // prefer standing next to something solid
        score -= g.enclosure[i] * 0.35;
        if (score < bestScore) {
          bestScore = score;
          best = i;
          bestX = x;
          bestZ = z;
        }
      }
    }
    if (best >= 0) out.set(bestX, g.floor[best], bestZ);
    else out.y = this.groundAt(out.x, out.z, cam.position.y + 3);
    return out;
  }

  /**
   * `debugStage('firefight')` — a staged firefight in front of the shot camera:
   * one man up and firing from behind hard cover, one crouched and peeking, one
   * moving between positions, one reloading further back.
   */
  debugStage(name) {
    if (name !== 'firefight') return this.stats;
    if (this.inspect) return this._stageInspect();

    const cam = this.ctx.camera;
    // A firefight the critic can actually see: drop the sun low enough to rake
    // down the street so the characters are lit, not silhouetted. This shot is
    // ours to compose; every other shot keeps its own time of day.
    this.ctx.peek('sky')?.setTimeOfDay?.(17.9);
    const F = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    F.y = 0;
    F.normalize();
    const right = new THREE.Vector3(F.z, 0, -F.x);
    const squad = this.createSquad();

    /** [variant, ndcX, depth, crouch, speed, fire, reloadEvery] */
    const LAYOUT = [
      // hero: up and firing, left of frame, close enough to read the kit
      ['vanguard', -0.44, 8.0, false, 0, true, 0],
      // second man crouched in cover, right of frame
      ['breacher', 0.30, 12.0, true, 0, true, 0],
      // one caught mid-stride between positions
      ['irregular', -0.14, 16.0, false, 4.1, false, 0],
      // one reloading behind cover on the far right
      ['vanguard', 0.60, 9.5, true, 0, true, 3.4],
      // depth: a fifth man well down the street
      ['irregular', -0.26, 22.0, false, 0, true, 0],
    ];

    const placedPositions = [];
    for (const [variant, ndcX, d, crouch, speed, fire, reload] of LAYOUT) {
      const pos = this._stageSlot(cam, ndcX, d, placedPositions);
      const yaw = Math.atan2(cam.position.x - pos.x, cam.position.z - pos.z);
      const a = this.spawn(variant, pos, yaw);
      squad.add(a);
      a.staged = {
        crouch,
        speed,
        fire,
        noDamage: true,
        heading: right.clone().multiplyScalar(-1),
        aimWeight: 1,
        reloadEvery: reload || 0,
        suppression: crouch ? 0.15 : 0,
      };
      // stagger the burst timers so the frame catches muzzle flashes
      a.burstCooldown = this.rng.range(0, 0.3);
      a.burstLeft = this.rng.int(2, 6);
      a.peeking = true;
      a.aimTarget.copy(this.playerPosition(this._v3));
      a.animator.update(0.016, 0);
      placedPositions.push(pos.clone());
      this._stagedAgents = (this._stagedAgents ?? []);
      this._stagedAgents.push(a);
      if (this.debugLog) {
        console.info(
          `[ai] staged ${variant} at ${pos.x.toFixed(1)},${pos.y.toFixed(2)},${pos.z.toFixed(1)} ` +
            `d=${cam.position.distanceTo(pos).toFixed(1)}m`
        );
      }
    }

    // One man already down, handed to the ragdoll solver with the round's
    // impulse — it dresses the tableau and it exercises the death path.
    const dPos = this._stageSlot(cam, -0.58, 9.4, placedPositions);
    const casualty = this.spawn('breacher', dPos, Math.atan2(cam.position.x - dPos.x, cam.position.z - dPos.z));
    squad.add(casualty);
    casualty.animator.update(0.016, 0);
    const hit = new THREE.Vector3(dPos.x, dPos.y + 1.35, dPos.z);
    const inc = new THREE.Vector3().subVectors(hit, cam.position).normalize();
    casualty.applyDamage(260, 'torso', hit, inc);

    return this.stats;
  }

  /** Model inspection line-up (dev only). */
  _stageInspect() {
    const cam = this.ctx.camera;
    const F = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    F.y = 0;
    F.normalize();
    const right = new THREE.Vector3(F.z, 0, -F.x);
    this.ctx.peek('sky')?.setTimeOfDay?.(11.5);
    const layout = [
      ['vanguard', 1.9, 0.35, 0.25],
      ['irregular', 2.7, -0.95, 3.0],
      ['breacher', 3.6, 1.15, -0.7],
    ];
    for (const [nm, d, s2, extraYaw] of layout) {
      const p = new THREE.Vector3().copy(cam.position).addScaledVector(F, d).addScaledVector(right, s2);
      p.y = this.groundAt(p.x, p.z, cam.position.y + 1.0);
      const toCam = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
      const a = this.spawn(nm, p, toCam + extraYaw);
      a.staged = {
        crouch: false,
        speed: 0,
        fire: false,
        aimWeight: 1,
        heading: new THREE.Vector3(0, 0, 1),
      };
    }
    return this.stats;
  }

  /* ================================================================== */

  dispose() {
    for (const off of this._off ?? []) off();
    this._clearActors();
    this._grenadeGeo?.dispose();
    this._grenadeMat?.dispose();
    this.ground?.dispose();
    for (const v of this._variants.values()) v.geometry.dispose();
    this._variants.clear();
    this.materials?.dispose();
    this.root.parent?.remove(this.root);
  }
}

export { VARIANTS, STATE };
