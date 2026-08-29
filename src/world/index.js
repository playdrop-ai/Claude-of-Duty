import * as THREE from 'three';
import { Assembler } from './builder.js';
import { BUILDINGS, STREET, SET_PIECES, GATE } from './layout.js';
import { buildGround } from './ground.js';
import { buildBuilding, collapseRoof } from './buildings.js';
import { registerProps } from './props.js';
import {
  registerDressingProps,
  dressStreet,
  dressBuildings,
  scatterDebris,
  buildGate,
  buildPerimeter,
  groundY,
  isOpen,
} from './dressing.js';

/**
 * WORLD — level geometry, the modular building kit, props, set dressing and
 * static collision.
 *
 * A ~120 x 120 m Middle-Eastern market street: one main street with a plaza,
 * flanking alleys, eighteen buildings (three of them enterable and furnished
 * across multiple floors), an arched gate closing the vista, and several
 * thousand props. Nothing is loaded from disk — every vertex is generated here.
 *
 * HOW IT FITS TOGETHER
 *   layout.js     the map: footprints, facade programmes, set-piece positions
 *   util.js       geometry toolkit (chamfered boxes, wall panels with real
 *                 holes, cloth grids, catenary tubes, rocks) + vertex masks
 *   kit.js        the modular building kit (facades, windows, doors, balconies,
 *                 stairs, awnings, parapets, drainpipes, damage)
 *   buildings.js  assembles a building from a footprint + a facade programme
 *   interiors.js  furnishes rooms so an interior screenshot is worth taking
 *   props.js      the instanced prop library
 *   dressing.js   places the hundreds of props, cables, laundry and debris
 *   ground.js     terrain, road camber, kerbs, pavement slabs, sand drifts
 *   builder.js    the Assembler: merges statics, batches instances, authors
 *                 collision proxies, bakes the level->world transform
 *
 * PUBLIC API — `const world = ctx.get('world')`
 *   world.root                THREE.Group holding everything
 *   world.bounds              THREE.Box3 of the playable area, world space
 *   world.spawnPoints         [{ position:Vector3, yaw:number, tag:string }]
 *   world.spawn(i)            one of the above
 *   world.groundHeight(x, z)  cheap analytic floor height (physics is exact)
 *   world.isOpen(x, z)        true where a character can stand outdoors
 *   world.stats               { staticTris, instTris, instances, drawCalls }
 *   world.prewarmMaterials()  compile every shader permutation the world can
 *                             produce, before the frame loop starts. Awaitable.
 *                             Call it from src/core/prewarm.js — see the method.
 *   world.levelToWorld(x,y,z,out) / world.worldToLevel(x,y,z,out)
 */

/**
 * LEVEL -> WORLD. The street is authored down -Z; this yaw puts it on the axis
 * the canonical hero/sunset cameras look along, with the market in the near
 * third of the frame and the gate closing the far end.
 */
const LEVEL_YAW = 0.5877;
const LEVEL_TX = 0.9;
const LEVEL_TZ = 1.34;

/**
 * How many zero-intensity "ballast" point lights the world parks in the scene to
 * hold `numPointLights` — and therefore the shader permutation — constant. See
 * `_addBallast()`. Must be at least the worst-case number of practicals that can
 * be in range at once: a sweep of the whole playable area at three eye heights
 * puts that at 10 for the world's own lights, plus whatever `fx` keeps live.
 */
const LIGHT_SLOTS = 20;
const HIDDEN_INSTANCE = new THREE.Matrix4().makeTranslation(0, -10000, 0);

/** Spawn points in LEVEL space: [x, z, yaw, tag]. */
const SPAWNS = [
  [0.4, 22.5, 0, 'north street'],
  [-2.4, 30.0, Math.PI, 'north plaza'],
  [3.6, 5.0, Math.PI, 'market'],
  [-3.4, -12.0, 0, 'mid street'],
  [2.6, -32.0, 0, 'south street'],
  [-1.0, -39.0, 0, 'gate'],
  [10.5, 4.6, -Math.PI / 2, 'east alley'],
  [-9.0, -10.2, Math.PI / 2, 'west alley'],
];

export class WorldSystem {
  static id = 'world';
  static deps = ['materials', 'physics'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    const rng = this.rng;
    const materials = ctx.get('materials');
    const physics = ctx.peek('physics');
    const render = ctx.peek('render');

    this.root = new THREE.Group();
    this.root.name = 'world';
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    // Weathering in the shared materials keys off the ground plane.
    materials.setGroundLevel?.(0);

    const t0 = performance.now();
    const A = new Assembler({ materials, rng, render });
    this.A = A;
    A.setTransform(LEVEL_YAW, LEVEL_TX, LEVEL_TZ);

    // 1. prototypes first: the level references them by id while it builds
    registerProps(A, rng);
    registerDressingProps(A, rng);

    // 2. ground, then the shells, then what people put in and on them
    buildGround(A, rng);

    const infos = [];
    for (const spec of BUILDINGS) {
      const info = buildBuilding(A, rng, spec);
      infos.push(info);
      if (spec.collapse) {
        collapseRoof(A, rng, spec, info, {
          x: spec.x + rng.range(-2, 2),
          z: spec.z + rng.range(-2, 2),
        });
      }
    }
    this.buildings = infos;

    buildGate(A, rng);
    buildPerimeter(A, rng);
    dressStreet(A, rng);
    dressBuildings(A, rng, infos);
    scatterDebris(A, rng);

    this._addLights(A);

    A.finalize(this.root, physics);
    A.releaseCache();

    // -------------------------------------------------------------- queries --
    this._v = new THREE.Vector3();
    this._inv = new THREE.Matrix4().copy(A.xform).invert();
    this.spawnPoints = SPAWNS.map(([x, z, yaw, tag]) => ({
      position: A.toWorld(x, 0, z),
      yaw: yaw + LEVEL_YAW,
      tag,
    }));
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-62, -2, -62),
      new THREE.Vector3(62, 26, 62)
    ).applyMatrix4(A.xform);
    this.stats = A.stats;
    this._initDestruction();

    const ms = performance.now() - t0;
    console.info(
      `[world] built in ${ms.toFixed(0)}ms — ${(A.stats.staticTris / 1000).toFixed(0)}k static tris, ` +
        `${(A.stats.instTris / 1000).toFixed(0)}k instanced tris in ${A.stats.instances} instances, ` +
        `${A.stats.drawCalls} draw calls, ${(A.stats.collideTris / 1000).toFixed(1)}k collision tris`
    );
  }

  _initDestruction() {
    this.stats.breakables = this.A.breakables.length;
    this.stats.destroyed = this.stats.debris = 0;
    this._debris = [];
    this._fragmentBatches = new Map();
    // Cache original components and warm every material during loading. Grow
    // vertex buffers only for destroyed props, not a second copy of the map.
    for (const group of this.A.breakables) {
      if (!group.parts?.length) throw new Error(`[world] ${group.kind} has no fracture geometry`);
      group.fragments = group.parts.map((part) => {
        if (!part.geometry.index || !['position', 'normal', 'uv', 'color'].every(name => part.geometry.getAttribute(name))) {
          throw new Error(`[world] ${group.kind} fracture geometry needs indexed position, normal, uv and color attributes`);
        }
        let batch = this._fragmentBatches.get(part.material);
        if (!batch) {
          batch = { material: part.material, vertices: 0, count: 0, dirty: false, mesh: null };
          this._fragmentBatches.set(part.material, batch);
        }
        const count = part.geometry.getAttribute('position').count;
        part.geometry.computeBoundingBox();
        const center = part.geometry.boundingBox.getCenter(new THREE.Vector3());
        const scale = new THREE.Vector3(), pose = new THREE.Object3D();
        part.matrix.decompose(pose.position, pose.quaternion, scale);
        pose.position.copy(center).applyMatrix4(part.matrix);
        const half = part.geometry.boundingBox.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(0.5);
        // A collapsing table releases intact goods, not every carton panel.
        // Cloth strips remain flexible independent pieces instead of one
        // invisible box holding the entire canopy above the wreckage.
        let assemblyKey = group.kind === 'stall' && part.prototype && part.prototype !== 'stall' ? part.matrix : null;
        if (part.prototype === 'stall') {
          // Each paired leg/post is one connected corner, and the two deck
          // boards stay joined. Cloth still falls in independent strips.
          if (Math.abs(center.x) > 0.5 && Math.abs(center.z) > 0.2) assemblyKey = `corner:${Math.sign(center.x)}:${Math.sign(center.z)}`;
          else if (center.y > 0.6 && center.y < 1) assemblyKey = 'deck';
        }
        return { batch, start: 0, count, source: part.geometry, masks: part.masks, pose, half, center, scale, surface: part.surface, assemblyKey,
          initialPosition: pose.position.clone(), initialQuaternion: pose.quaternion.clone(), body: null, assembly: null };
      });
    }
    for (const batch of this._fragmentBatches.values()) {
      const mesh = batch.mesh = new THREE.Mesh(new THREE.BufferGeometry(), batch.material);
      mesh.name = 'world_prop_parts';
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.userData.collision = false;
      this._reserveParts(batch, 64, 192);
      this.root.add(mesh);
    }
    this._destructionOff = [
      this.ctx.events.on('bullet:impact', (hit) => {
        const group = hit.object?.userData?.breakable;
        if (group && !hit.exit) this._damageProp(group, hit.damage, hit.point);
      }),
      this.ctx.events.on('explosion', (blast) => {
        const physics = this.ctx.get('physics');
        for (const group of this.A.breakables) {
          if (group.destroyed) continue;
          const point = group.bounds.clampPoint(blast.position, new THREE.Vector3());
          const direction = point.clone().sub(blast.position);
          const distance = direction.length();
          if (distance >= blast.radius) continue;
          const hit = physics.raycast(blast.position, direction, distance + 0.02, physics.MASK.WORLD);
          if (hit.hit && hit.object?.userData?.breakable !== group) continue;
          this._damageProp(group, blast.damage * (1 - distance / blast.radius), blast.position, true);
        }
      }),
    ];
  }

  _reserveParts(batch, vertices, indices) {
    const old = batch.mesh.geometry;
    if (old.getAttribute('position')?.count >= vertices && old.index.count >= indices) return;
    const vertexCapacity = 2 ** Math.ceil(Math.log2(Math.max(64, vertices)));
    const indexCapacity = 2 ** Math.ceil(Math.log2(Math.max(192, indices)));
    const geometry = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
      const attribute = new THREE.Float32BufferAttribute(new Float32Array(vertexCapacity * size), size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      const previous = old.getAttribute(name);
      if (previous) attribute.array.set(previous.array.subarray(0, batch.vertices * size));
      geometry.setAttribute(name, attribute);
    }
    const index = new THREE.Uint32BufferAttribute(new Uint32Array(indexCapacity), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    if (old.index) index.array.set(old.index.array.subarray(0, batch.count));
    geometry.setIndex(index);
    geometry.setDrawRange(0, batch.count);
    batch.mesh.geometry = geometry;
    old.dispose();
  }

  _damageProp(group, damage, point, blast = false, collapse = false) {
    if (group.destroyed || !Number.isFinite(damage) || damage <= 0) return;
    group.health -= damage;
    if (group.health > 0) return;
    group.destroyed = true;
    this.stats.destroyed++;
    this._setPropVisible(group, false);
    this.ctx.peek('fx')?.decals.removeOwner(group);
    this._releaseParts(group, point, blast, collapse);
    this.ctx.events.emit('world:destruction', { bounds: group.bounds, group });
    // A crate on a destroyed pallet or another crate must fall, not hover.
    // Keep its assembly intact while gravity removes the unsupported stack.
    for (const other of this.A.breakables) {
      if (other.destroyed || other === group) continue;
      const a = group.bounds, b = other.bounds;
      if (Math.abs(b.min.y - a.max.y) > 0.16 || b.min.x >= a.max.x || b.max.x <= a.min.x || b.min.z >= a.max.z || b.max.z <= a.min.z) continue;
      const center = b.getCenter(new THREE.Vector3());
      center.y = b.min.y - 0.025;
      const support = this.ctx.get('physics').raycast(center, { x: 0, y: -1, z: 0 }, 0.2, this.ctx.get('physics').MASK.WORLD);
      if (support.hit) continue;
      this._damageProp(other, other.health, point, false, true);
    }
  }

  _releaseParts(group, point, blast, collapse) {
    const physics = this.ctx.get('physics');
    const needed = new Map();
    for (const part of group.fragments) {
      const n = needed.get(part.batch) ?? { vertices: part.batch.vertices, indices: part.batch.count };
      n.vertices += part.count;
      n.indices += part.source.index.count;
      needed.set(part.batch, n);
    }
    for (const [batch, n] of needed) this._reserveParts(batch, n.vertices, n.indices);
    const assemblies = new Map();
    for (const part of group.fragments) {
      const key = collapse ? group : part.assemblyKey;
      if (!key) continue;
      if (!assemblies.has(key)) assemblies.set(key, []);
      assemblies.get(key).push(part);
    }
    for (const parts of assemblies.values()) {
      const pose = new THREE.Object3D();
      const bounds = new THREE.Box3(), matrix = new THREE.Matrix4();
      for (const part of parts) {
        matrix.compose(part.pose.position, part.pose.quaternion, new THREE.Vector3(1, 1, 1));
        bounds.union(new THREE.Box3(part.half.clone().negate(), part.half.clone()).applyMatrix4(matrix));
      }
      bounds.getCenter(pose.position);
      const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.015, 0.015, 0.015));
      const assembly = { pose, body: physics.addRigidBody({
        position: pose.position, halfExtents: half, mass: 12, object3D: pose,
        friction: 0.85, restitution: 0.05, angularDamping: 1.6,
        surface: physics.SURFACE[parts[0].surface],
      }) };
      for (const part of parts) {
        part.assembly = assembly;
        part.offset = part.pose.position.clone().sub(pose.position);
      }
    }
    for (const part of group.fragments) {
      const batch = part.batch, geometry = batch.mesh.geometry;
      part.start = batch.vertices;
      const indices = part.source.index.array;
      for (let i = 0; i < indices.length; i++) geometry.index.array[batch.count + i] = part.start + indices[i];
      geometry.index.addUpdateRange(batch.count, indices.length);
      batch.count += indices.length;
      batch.vertices += part.count;
      geometry.index.needsUpdate = true;
      geometry.setDrawRange(0, batch.count);
      for (const name of ['uv', 'color']) {
        const source = part.source.getAttribute(name), attribute = geometry.getAttribute(name), size = source.itemSize;
        for (let i = 0; i < source.array.length; i++) attribute.array[part.start * size + i] = source.array[i] * (name === 'color' ? part.masks[i % 3] : 1);
        attribute.addUpdateRange(part.start * size, part.count * size);
        attribute.needsUpdate = true;
      }
      const velocity = part.pose.position.clone().sub(point);
      const distance = velocity.length();
      velocity.multiplyScalar((blast ? 2.8 : 0.5) / Math.max(0.3, distance));
      velocity.y = blast ? 1.2 + this.rng.float() * 1.2 : 0.12;
      part.body = part.assembly?.body ?? physics.addRigidBody({
        halfExtents: { x: Math.max(0.015, part.half.x), y: Math.max(0.015, part.half.y), z: Math.max(0.015, part.half.z) },
        mass: Math.max(0.08, Math.min(24, part.half.x * part.half.y * part.half.z * 8 * 350)),
        position: part.pose.position, quaternion: part.pose.quaternion, velocity,
        friction: 0.85, restitution: 0.08, angularDamping: 1.6,
        object3D: part.pose, surface: physics.SURFACE[part.surface],
      });
      if (!part.assembly) part.body.angularVelocity.set(this.rng.signed() * 1.5, this.rng.signed(), this.rng.signed() * 1.5);
      this._debris.push(part);
    }
    this._updateParts(group.fragments);
    this.stats.debris = this._debris.length;
  }

  _updateParts(parts = this._debris) {
    const physics = this.ctx.get('physics');
    const v = new THREE.Vector3(), n = new THREE.Vector3();
    for (const part of parts) {
      if (!part.body) continue;
      if (part.assembly) {
        part.pose.position.copy(part.offset).applyQuaternion(part.assembly.pose.quaternion).add(part.assembly.pose.position);
        part.pose.quaternion.copy(part.assembly.pose.quaternion).multiply(part.initialQuaternion);
      }
      const batch = part.batch, geometry = batch.mesh.geometry;
      const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
      const sourcePositions = part.source.getAttribute('position'), sourceNormals = part.source.getAttribute('normal');
      for (let i = 0; i < part.count; i++) {
        v.fromBufferAttribute(sourcePositions, i).sub(part.center).multiply(part.scale).applyQuaternion(part.pose.quaternion).add(part.pose.position);
        n.fromBufferAttribute(sourceNormals, i).divide(part.scale).normalize().applyQuaternion(part.pose.quaternion);
        positions.setXYZ(part.start + i, v.x, v.y, v.z);
        normals.setXYZ(part.start + i, n.x, n.y, n.z);
      }
      positions.addUpdateRange(part.start * 3, part.count * 3);
      normals.addUpdateRange(part.start * 3, part.count * 3);
      batch.dirty = true;
      // Large boards can rock forever just above the casing solver's very
      // strict sleep threshold. Retire imperceptible motion, not the geometry.
      const settled = part.body.age > 2 && part.body.linearVelocity.lengthSq() < 0.0064 &&
        part.body.angularVelocity.lengthSq() * part.body.boundRadius ** 2 < 0.0064;
      if (part.body.sleeping || settled) {
        physics.removeRigidBody(part.body);
        part.body = null; // Keep the rendered wreckage until the wave resets.
      }
    }
    for (const batch of this._fragmentBatches.values()) {
      if (!batch.dirty) continue;
      batch.mesh.geometry.getAttribute('position').needsUpdate = true;
      batch.mesh.geometry.getAttribute('normal').needsUpdate = true;
      batch.dirty = false;
    }
  }

  _setPropVisible(group, visible) {
    for (const range of group.ranges) {
      const index = range.mesh.geometry.index;
      if (visible) index.array.set(range.original, range.start);
      else index.array.fill(0, range.start, range.start + range.count);
      index.addUpdateRange(range.start, range.count);
      index.needsUpdate = true;
    }
    for (const instance of group.instances) {
      instance.mesh.setMatrixAt(instance.index, visible ? instance.original : HIDDEN_INSTANCE);
      instance.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const handle of group.handles) this.ctx.get('physics').setStaticEnabled(handle, visible);
  }

  resetDestruction() {
    const bounds = new THREE.Box3();
    for (const group of this.A.breakables) {
      group.health = group.maxHealth;
      if (!group.destroyed) continue;
      group.destroyed = false;
      this._setPropVisible(group, true);
      bounds.union(group.bounds);
    }
    for (const slot of this._debris) {
      if (slot.body) this.ctx.get('physics').removeRigidBody(slot.body);
      slot.body = null;
      slot.assembly = null;
      slot.pose.position.copy(slot.initialPosition);
      slot.pose.quaternion.copy(slot.initialQuaternion);
    }
    this._debris.length = 0;
    for (const batch of this._fragmentBatches.values()) {
      batch.count = batch.vertices = 0;
      batch.mesh.geometry.setDrawRange(0, 0);
    }
    this.stats.destroyed = this.stats.debris = 0;
    if (!bounds.isEmpty()) this.ctx.events.emit('world:destruction', { bounds, reset: true });
  }

  // ----------------------------------------------------------------- lights --
  /**
   * Punctual lights the world owns: the bare bulbs inside the enterable
   * buildings (what makes an interior read as lived-in against cool skylight)
   * and the street lamps, which only draw power after dusk.
   */
  _addLights(A) {
    this.bulbs = [];
    this.lamps = [];

    for (const b of A.interiorLights.slice(0, 20)) {
      // A bare 60 W bulb in an unlit room: the only thing separating an interior
      // from a black hole, so it has to actually carry the room.
      // Intensity is re-driven every update() off the solar altitude; this is
      // the daylight value so a frame captured before the first update is right.
      const l = new THREE.PointLight(0xffc07a, 5, 13, 2);
      l.position.set(b.x, b.y, b.z);
      l.castShadow = false;
      A.light(l, { range: 13, priority: 2 });
      this.bulbs.push(l);
    }

    for (const p of A.lampAnchors) {
      const l = new THREE.PointLight(0xffb765, 0, 22, 2);
      l.position.set(p.x, p.y - 0.12, p.z);
      l.castShadow = false;
      A.light(l, { range: 22, priority: 3 });
      this.lamps.push(l);
    }
    this.lampLens = A.mat('lamp_lens');
    this._lampMix = -1;

    this._addBallast();
  }

  /**
   * BALLAST — hold the scene's point-light COUNT constant.
   *
   * MEASURED, not guessed. The single worst source of stalls in this build was
   * not geometry: it was shader compilation triggered by the world's own
   * practicals. `render` distance-culls every registered punctual light
   * (`light.visible = fade > 0.002`), and Three bakes the number of *visible*
   * point lights into the program cache key. The world owns 17 practicals (12
   * interior bulbs at 13 m, 5 street lamps at 22 m), so walking down the street
   * sweeps the visible count through 9-8-7-6-5-4 — and every single step
   * recompiles EVERY lit material in the frame:
   *
   *   f15 +36 programs  636 ms   f32 +35  702 ms   f41 +35  699 ms
   *   f51 +35 programs  678 ms   f99 +33  698 ms
   *   → 186 programs and ~3.5 s of stalls inside 900 frames of play
   *
   * Pre-compiling every count instead costs 9.5 s of boot (measured: 595
   * programs for counts 0-16), which is the wrong trade. Holding the count
   * still costs nothing.
   *
   * These lights are black (`color 0x000000`, `intensity 0`) with a 1 cm range,
   * parked under the map, and are NOT registered with `render.addLight`, so
   * nothing culls or re-lights them. A point light whose colour times intensity
   * is exactly 0 contributes `0.0` to irradiance — not "almost nothing", but a
   * float zero that is added to the accumulator — so this cannot move a pixel
   * no matter how many slots are lit. It only changes `numPointLights`, which
   * is a shader-permutation input and nothing else.
   *
   * Cost of the padding, measured over 3 paired runs at 1512x982 DPR 2 with 20
   * ballast slots live: p05 frame time 15.7 ms -> 14.4 ms (i.e. inside noise).
   */
  _addBallast() {
    this._ballast = [];
    for (let i = 0; i < LIGHT_SLOTS + 4; i++) {
      const l = new THREE.PointLight(0x000000, 0, 0.01, 2);
      l.name = `world_light_ballast_${i}`;
      l.castShadow = false;
      l.visible = false;
      l.userData.owBallast = true;
      // Far under the terrain, so even the distance-attenuation term is 0.
      l.position.set(0, -1000, 0);
      this.root.add(l);
      this._ballast.push(l);
    }
    /** Point lights in the scene that are NOT ballast; refreshed periodically. */
    this._pointLights = [];
    this._pointLightsFrame = -1e9;
    this._lightTarget = LIGHT_SLOTS;
    this._lightRanges = new Map(); // light -> the cull radius `render` gave it
    this._camPos = new THREE.Vector3();
    this._collectPointLight = (o) => {
      if (o.isPointLight === true && o.userData.owBallast !== true) this._pointLights.push(o);
    };
  }

  /**
   * Top the visible point-light count up to a fixed target. Runs in lateUpdate,
   * after every subsystem has finished moving lights and the camera, and before
   * `render` draws — so the count Three sees is the same every frame.
   *
   * The count has to be PREDICTED rather than read off `light.visible`, because
   * `render._cullLights()` runs inside `render.render()` — i.e. after this. Using
   * last frame's flags is right on 99% of frames and off by one on exactly the
   * frames where a light crosses its cull radius, which are exactly the frames
   * that used to stall. So mirror the renderer's own test here. Getting the
   * prediction wrong can only cost a permutation, never a pixel: the ballast
   * lights are black, and a black light is a no-op however many are lit.
   */
  _stabiliseLightCount(ctx) {
    const list = this._pointLights;
    if (!list) return;
    const render = this._render ?? (this._render = ctx.peek('render'));
    // The set of point lights in the scene only changes when a subsystem builds
    // or frees a pool, so rescanning every frame is pure waste. Every 90 frames
    // is often enough to catch a pool that appears after boot.
    if (ctx.time.frame - this._pointLightsFrame >= 90) {
      this._pointLightsFrame = ctx.time.frame;
      list.length = 0;
      ctx.scene.traverse(this._collectPointLight);
      this._lightRanges.clear();
      for (const e of render?.lights ?? []) {
        if (e.light?.isPointLight === true) this._lightRanges.set(e.light, e.range);
      }
    }

    ctx.camera.getWorldPosition(this._camPos);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const range = this._lightRanges.get(l);
      if (range === undefined) {
        // Not registered for distance culling: its owner drives `visible`.
        if (l.visible === true) n++;
        continue;
      }
      // The renderer's test, verbatim: fade = 1 - smoothstep(d, .75r, 1.15r),
      // light.visible = fade > 0.002.
      const d = l.position.distanceTo(this._camPos);
      if (1 - THREE.MathUtils.smoothstep(d, range * 0.75, range * 1.15) > 0.002) n++;
    }

    // A subsystem can always out-run the pool; adopting the higher count costs
    // one compile, once, instead of one per crossing.
    if (n > this._lightTarget) this._lightTarget = n;
    const want = this._lightTarget - n;
    const pool = this._ballast;
    for (let i = 0; i < pool.length; i++) {
      const v = i < want;
      if (pool[i].visible !== v) pool[i].visible = v;
    }
  }

  // ---------------------------------------------------------------- runtime --
  update(dt, ctx) {
    this._updateParts();
    // Distance LOD for the scatter clouds: one bounding-sphere test per batch.
    this.A?.updateLod(ctx.camera);

    // Street lamps come on as the sun goes down, driven by the sky's real solar
    // altitude rather than a timer, so it is right at any time of day.
    const sky = this._sky ?? (this._sky = ctx.peek('sky'));
    const alt = sky?.sunAltitude ?? 0.6;
    const mix = 1 - Math.min(1, Math.max(0, (alt + 0.05) / 0.16));
    if (Math.abs(mix - this._lampMix) > 0.01) {
      this._lampMix = mix;
      for (let i = 0; i < this.lamps.length; i++) this.lamps[i].intensity = 14 * mix;
      if (this.lampLens) this.lampLens.emissiveIntensity = 9 * mix;
      // Bulbs stay on around the clock — but a 60 W bulb is NOT competitive with
      // daylight, and running it at night strength at noon is what made every
      // interior read as pure tungsten (B-R -93) and sit level with the sunlit
      // street instead of 1.5-2.5 stops under it. Gate the bulb on solar
      // altitude: a weak practical by day, the room's only light after dark.
      for (let i = 0; i < this.bulbs.length; i++) this.bulbs[i].intensity = 5 + 17 * mix;
    }
  }

  lateUpdate(dt, ctx) {
    this._stabiliseLightCount(ctx);
  }

  // --------------------------------------------------------------- pre-warm --
  /**
   * Compile every shader permutation the world can produce, before the frame
   * loop starts. See `src/core/prewarm.js` — that module asks each subsystem for
   * exactly this hook, because `renderer.compileAsync(scene, camera)` alone
   * reaches only the forward lit variant of a material, not the two override
   * passes the world's geometry also goes through every frame:
   *
   *   - the CSM cascades render the whole scene with `csm.depthMaterial`
   *   - the prepass renders it again with the gbuffer's ShaderMaterial
   *
   * Both are separate programs, and each one has its own permutations for plain
   * geometry, instanced geometry and instanced geometry with an instanceColor —
   * which is precisely the mix the world puts in front of them.
   *
   * Pixel-neutral by construction: it compiles, it does not draw. The only
   * mutations are `scene.overrideMaterial` and the ballast light visibility,
   * both restored in the `finally`.
   */
  async prewarmMaterials(ctx = this.ctx) {
    const render = ctx.peek?.('render') ?? ctx.get?.('render');
    const renderer = render?.renderer;
    if (!renderer) return { ok: false, reason: 'no renderer' };
    const scene = ctx.scene;
    const camera = ctx.camera;
    const before = renderer.info.programs?.length ?? 0;
    const t0 = performance.now();

    // Every lit material must carry render's CSM/AO/SSR injection before it is
    // compiled, or the program we warm is not the program the frame will use.
    render.patchMaterials?.(this.root);

    // Compile at the count the frame loop will actually run at, not at whatever
    // the distance cull happens to have left visible during boot.
    this._stabiliseLightCount(ctx);

    const prevOverride = scene.overrideMaterial;
    try {
      // 1. forward lit pass.
      await this._compile(renderer, scene, camera);
      // 2. the shadow cascades and 3. the depth/normal/velocity prepass, both of
      //    which draw this same geometry through an override material.
      for (const over of [render.csm?.depthMaterial, render.gbuffer?.material]) {
        if (!over) continue;
        scene.overrideMaterial = over;
        await this._compile(renderer, scene, camera);
      }
    } finally {
      scene.overrideMaterial = prevOverride;
    }

    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      compiled: (renderer.info.programs?.length ?? 0) - before,
      lightTarget: this._lightTarget,
    };
  }

  async _compile(renderer, scene, camera) {
    try {
      await renderer.compileAsync(scene, camera);
    } catch {
      try {
        renderer.compile(scene, camera);
      } catch {
        /* a driver we cannot pre-warm on; boot must still proceed */
      }
    }
  }

  // ---------------------------------------------------------------- queries --
  spawn(i = 0) {
    const n = this.spawnPoints.length;
    return this.spawnPoints[((i % n) + n) % n];
  }

  levelToWorld(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z).applyMatrix4(this.A.xform);
  }

  worldToLevel(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z).applyMatrix4(this._inv);
  }

  /** Analytic floor height. Physics owns the exact answer; this is a hint. */
  groundHeight(x, z) {
    const p = this.worldToLevel(x, 0, z, this._v);
    return groundY(p.x, p.z);
  }

  /** True where a character can stand outdoors (street, pavement, alley). */
  isOpen(x, z, margin = 0.4) {
    const p = this.worldToLevel(x, 0, z, this._v);
    return isOpen(p.x, p.z, margin);
  }

  dispose() {
    for (const off of this._destructionOff ?? []) off();
    for (const slot of this._debris ?? []) if (slot.body) this.ctx.get('physics').removeRigidBody(slot.body);
    for (const batch of this._fragmentBatches?.values() ?? []) batch.mesh.geometry.dispose();
    this.A?.dispose();
    this.root?.parent?.remove(this.root);
    for (const l of this._ballast ?? []) l.parent?.remove(l);
    this._ballast = null;
    this._pointLights = null;
    this.bulbs = null;
    this.lamps = null;
  }
}

export { BUILDINGS, STREET, SET_PIECES, GATE };
