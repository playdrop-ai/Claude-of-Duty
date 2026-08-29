import * as THREE from 'three';
import { P } from './atlas.js';

/**
 * GPU particle system.
 *
 * One instanced quad per particle. The whole simulation lives in the vertex
 * shader as a closed-form solution of
 *
 *     dv/dt = -k v + g          =>   v(t) = v0 e^-kt + g/k (1 - e^-kt)
 *                                    x(t) = x0 + (v0 - g/k)(1 - e^-kt)/k + g t / k
 *
 * plus a per-particle turbulence term. Rendering needs no CPU simulation or
 * readback; AI visibility samples the same equations for live smoke only.
 * Spawning writes 32 floats into a preallocated interleaved ring buffer and
 * uploads only the dirty span.
 *
 * Two blend modes share the code:
 *   ADDITIVE  premultiplied ONE/ONE — sparks, muzzle flash, fire, tracers.
 *             Order independent, so no sorting is needed.
 *   LIT/alpha src-alpha over — smoke, dust, blood. Shaded with a spherical
 *             fake normal bent by the sprite's own density gradient, wrapped
 *             sun term plus a forward-scatter lobe, so a puff reads as volume.
 *
 * Both fade softly against `render.depthTexture` (linear view depth in metres)
 * so nothing shows a hard intersection line with the world.
 */

export const STRIDE = 32;
export const PF_FLICKER = 1;
export const PF_TRACER = 2;

// interleaved slot offsets
const O_PS = 0; // pos.xyz, size0
const O_VS = 4; // vel.xyz, size1
const O_LF = 8; // birth, 1/life, drag, gravity
const O_RT = 12; // rot0, spin, stretch, sizeCurve
const O_C0 = 16; // colour A rgb, intensity A
const O_C1 = 20; // colour B rgb, intensity B
const O_MS = 24; // tile, softness, alpha, alphaCurve
const O_EX = 28; // turbAmp, turbFreq, seed, flags

/** Reusable spawn descriptor — spawning must never allocate. */
export const SP = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  size0: 0.2, size1: 0.3, sizeCurve: 1,
  life: 1, delay: 0, drag: 1.4, gravity: 0,
  rot: 0, spin: 0,
  /** Velocity-aligned smear: length = size * (1 + stretch * speed). ~1 is one
   *  frame of motion blur at 60 Hz for a centimetre-scale sprite. */
  stretch: 0,
  r0: 1, g0: 1, b0: 1, i0: 1,
  r1: 1, g1: 1, b1: 1, i1: 0,
  tile: 0, soft: 0.4, alpha: 1, alphaCurve: 1,
  turb: 0, turbFreq: 1, seed: 0, flags: 0,
};

export function resetSpawn() {
  const s = SP;
  s.x = s.y = s.z = 0;
  s.vx = s.vy = s.vz = 0;
  s.size0 = 0.2; s.size1 = 0.3; s.sizeCurve = 1;
  s.life = 1; s.delay = 0; s.drag = 1.4; s.gravity = 0;
  s.rot = 0; s.spin = 0; s.stretch = 0;
  s.r0 = s.g0 = s.b0 = 1; s.i0 = 1;
  s.r1 = s.g1 = s.b1 = 1; s.i1 = 0;
  s.tile = 0; s.soft = 0.4; s.alpha = 1; s.alphaCurve = 1;
  s.turb = 0; s.turbFreq = 1; s.seed = 0; s.flags = 0;
  return s;
}

/* ------------------------------------------------------------------------- */
/*  shaders                                                                  */
/* ------------------------------------------------------------------------- */

export const PARTICLE_VERT = /* glsl */ `
precision highp float;

attribute vec4 aPS;
attribute vec4 aVS;
attribute vec4 aLife;
attribute vec4 aRot;
attribute vec4 aCol0;
attribute vec4 aCol1;
attribute vec4 aMisc;
attribute vec4 aExtra;

uniform float uTime;
uniform vec2 uAtlas;   // cols, 1/cols

varying vec2 vUv;
varying vec4 vCol;
varying float vViewZ;
varying float vSoft;
varying vec2 vQ;
varying float vAge;

void main() {
  float t = uTime - aLife.x;
  float n = t * aLife.y;
  if ( t < 0.0 || n >= 1.0 ) {
    vUv = vec2( 0.0 );
    vCol = vec4( 0.0 );
    vViewZ = 1.0;
    vSoft = 1.0;
    vQ = vec2( 0.0 );
    vAge = 0.0;
    gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );  // behind the far plane: clipped
    return;
  }

  float k = max( aLife.z, 0.02 );
  float e = exp( -k * t );
  bool tracer = aExtra.w > 1.5;
  vec3 wpos;
  vec3 wvel;
  float ph = aExtra.z * 6.2831853;
  if ( tracer ) {
    // Tracers visualize an already-resolved physics segment. Advance the head
    // linearly from the real muzzle and clamp it at the real endpoint stored in
    // aExtra.x. Generic drag, gravity and turbulence would make the light lie.
    float speed = length( aVS.xyz );
    vec3 dir = speed > 1e-5 ? aVS.xyz / speed : vec3( 0.0, 0.0, -1.0 );
    float travelled = min( max( aExtra.x, 0.0 ), speed * max( t, 0.0 ) );
    wpos = aPS.xyz + dir * travelled;
    wvel = dir * speed;
  } else {
    vec3 gk = vec3( 0.0, aLife.w, 0.0 ) / k;
    wpos = aPS.xyz + ( aVS.xyz - gk ) * ( ( 1.0 - e ) / k ) + gk * t;
    wvel = aVS.xyz * e + gk * ( 1.0 - e );

    // Turbulence: three decorrelated sines. Grows in so particles do not
    // teleport on their first frame, and contributes to the velocity used for
    // stretch orientation so drifting smoke leans the right way.
    float f = aExtra.y;
    float grow = smoothstep( 0.0, 0.4, n );
    float amp = aExtra.x * grow;
    wpos += vec3( sin( t * f * 1.13 + ph ), sin( t * f * 0.79 + ph * 2.1 ), cos( t * f * 1.31 + ph * 1.7 ) ) * amp;
    wvel += vec3( cos( t * f * 1.13 + ph ), cos( t * f * 0.79 + ph * 2.1 ), -sin( t * f * 1.31 + ph * 1.7 ) ) * ( amp * f );
  }

  vec4 mv = viewMatrix * vec4( wpos, 1.0 );
  vec3 velView = ( viewMatrix * vec4( wvel, 0.0 ) ).xyz;

  float size = mix( aPS.w, aVS.w, pow( n, max( aRot.w, 0.02 ) ) );
  vec2 c = position.xy;
  vec2 off;
  bool ribbon = tracer && aRot.z > 0.001;
  if ( ribbon ) {
    // A finite ribbon follows the projectile head. Its tail cannot precede the
    // muzzle because its length is clamped to distance actually travelled.
    float travelled = length( wpos - aPS.xyz );
    float len = min( aRot.z, travelled );
    vec3 dir = length( wvel ) > 1e-5 ? normalize( wvel ) : vec3( 0.0, 0.0, -1.0 );
    vec4 headMv = mv;
    vec4 tailMv = viewMatrix * vec4( wpos - dir * len, 1.0 );
    float alongU = c.y + 0.5;
    mv = mix( tailMv, headMv, alongU );
    vec4 headClip = projectionMatrix * headMv;
    vec4 tailClip = projectionMatrix * tailMv;
    vec2 screenDir = headClip.xy / max( headClip.w, 1e-5 ) - tailClip.xy / max( tailClip.w, 1e-5 );
    float screenLen = length( screenDir );
    vec2 along = screenLen > 1e-5 ? screenDir / screenLen : vec2( 0.0, 1.0 );
    vec2 perpNdc = vec2( -along.y, along.x );
    vec2 perpView = normalize( vec2(
      perpNdc.x / projectionMatrix[0][0],
      perpNdc.y / projectionMatrix[1][1]
    ) );
    mv.xy += perpView * ( c.x * size );
    off = vec2( c.x * size, ( alongU - 0.5 ) * max( len, size ) );
  } else if ( aRot.z > 0.001 ) {
    // velocity-aligned: +Y of the sprite runs along screen-space velocity
    vec2 d = velView.xy;
    float dl = length( d );
    vec2 along = dl > 1e-5 ? d / dl : vec2( 0.0, 1.0 );
    vec2 perp = vec2( -along.y, along.x );
    float len = size * ( 1.0 + aRot.z * length( velView ) );
    off = along * ( c.y * len ) + perp * ( c.x * size );
  } else {
    float rot = aRot.x + aRot.y * t;
    float s = sin( rot ), co = cos( rot );
    off = vec2( c.x * co - c.y * s, c.x * s + c.y * co ) * size;
  }
  // Ribbon vertices were positioned directly between their world-space tail
  // and head above. Applying the offset again treated metres as another
  // view-space displacement, producing the steep side/sky V that contradicted
  // the shot.
  if ( !ribbon ) mv.xy += off;

  vViewZ = -mv.z;
  vSoft = max( aMisc.y, 0.002 );
  vQ = off / max( size, 1e-4 ) * 2.0;
  vAge = n;
  gl_Position = projectionMatrix * mv;

  vec2 tuv = vec2( mod( aMisc.x, uAtlas.x ), floor( aMisc.x * uAtlas.y ) );
  vUv = ( uv + tuv ) * uAtlas.y;

  vec3 col = mix( aCol0.rgb, aCol1.rgb, n );
  float inten = mix( aCol0.w, aCol1.w, n * n );
  if ( aExtra.w > 0.5 && aExtra.w < 1.5 ) inten *= 0.72 + 0.28 * sin( t * 63.0 + ph * 9.0 );  // spark flicker
  float a = aMisc.z * pow( max( 1.0 - n, 0.0 ), max( aMisc.w, 0.02 ) ) * smoothstep( 0.0, 0.045, n );
  vCol = vec4( col * inten, a );
}
`;

export const PARTICLE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uSprite;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform vec2 uSoftEnable;
uniform vec3 uSunDir;   // view space, pointing at the sun
uniform vec3 uSunCol;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform vec3 uUpView;
uniform vec4 uFog;      // rgb, density

varying vec2 vUv;
varying vec4 vCol;
varying float vViewZ;
varying float vSoft;
varying vec2 vQ;
varying float vAge;

layout(location = 0) out vec4 outColor;

void main() {
  if ( vCol.a <= 0.0 ) discard;
  vec4 tex = texture2D( uSprite, vUv );
  float a = tex.a * vCol.a;
  if ( a < 0.0035 ) discard;
  vec3 c = vCol.rgb * tex.rgb;

#ifdef LIT
  float rr = dot( vQ, vQ );
  vec3 nrm = vec3( vQ, sqrt( max( 0.03, 1.0 - rr ) ) );
  // Bend the fake sphere normal by the sprite's own density gradient: this is
  // what turns a soft blob into something with legible internal form.
  nrm = normalize( nrm - vec3( dFdx( tex.r ), dFdy( tex.r ), 0.0 ) * 7.0 );
  float ndl = dot( nrm, uSunDir );
  float wrap = max( 0.0, ( ndl + 0.42 ) / 1.42 );
  float back = max( 0.0, -ndl );
  float up = 0.5 + 0.5 * dot( nrm, uUpView );
  // Irradiance -> radiance: the 1/PI is what keeps a dust puff sitting at the
  // same exposure as the wall behind it instead of blowing out white.
  vec3 lit = ( mix( uAmbBot, uAmbTop, up ) + uSunCol * ( wrap * 0.9 + pow( back, 4.0 ) * 0.55 ) ) * 0.3183099;
  lit *= mix( 1.0, 0.55, clamp( tex.a * 1.1, 0.0, 1.0 ) );  // self-shadowing by density
  c *= lit;
#endif

#ifdef SOFT
  if ( uSoftEnable.x > 0.5 ) {
    float sceneZ = texture2D( uDepth, gl_FragCoord.xy / uRes ).r;
    sceneZ = sceneZ > 0.001 ? sceneZ : 1.0e6;   // nothing drawn == infinitely far
    a *= clamp( ( sceneZ - vViewZ ) / vSoft, 0.0, 1.0 );
  }
#endif

  // never let a sprite smear across the lens
  a *= clamp( ( vViewZ - 0.05 ) / 0.2, 0.0, 1.0 );

  float fogAmt = 1.0 - exp( -uFog.w * vViewZ );
#ifdef ADDITIVE
  c *= ( 1.0 - fogAmt );
  outColor = vec4( c * a, a );
#else
  c = mix( c, uFog.rgb, fogAmt );
  outColor = vec4( c, a );
#endif
}
`;

/* ------------------------------------------------------------------------- */
/*  ring-buffer storage                                                      */
/* ------------------------------------------------------------------------- */

let quadGeoSource = null;

function quadSource() {
  if (!quadGeoSource) {
    quadGeoSource = new THREE.PlaneGeometry(1, 1, 1, 1);
  }
  return quadGeoSource;
}

/**
 * A fixed-capacity ring of particles backed by one interleaved buffer.
 * GPU storage is allocated at construction; the optional AI cache on first use.
 */
export class ParticleLayer {
  /**
   * @param {object} o
   * @param {number} o.capacity     hard cap, from config.q.particleBudget
   * @param {'additive'|'lit'} o.mode
   * @param {THREE.Texture} o.atlas
   * @param {number} o.cols         atlas columns
   * @param {boolean} [o.soft]      depth-fade against the scene
   */
  constructor(o) {
    this.capacity = Math.max(16, o.capacity | 0);
    this.mode = o.mode;
    this.cursor = 0;
    this.highWater = 0;
    this.expireAt = -1;
    this.spawned = 0;

    this.array = new Float32Array(this.capacity * STRIDE);
    this.ibuf = new THREE.InstancedInterleavedBuffer(this.array, STRIDE, 1);
    this.ibuf.setUsage(THREE.DynamicDrawUsage);

    const src = quadSource();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index;
    geo.setAttribute('position', src.getAttribute('position'));
    geo.setAttribute('uv', src.getAttribute('uv'));
    const bind = (name, offset) =>
      geo.setAttribute(name, new THREE.InterleavedBufferAttribute(this.ibuf, 4, offset));
    bind('aPS', O_PS);
    bind('aVS', O_VS);
    bind('aLife', O_LF);
    bind('aRot', O_RT);
    bind('aCol0', O_C0);
    bind('aCol1', O_C1);
    bind('aMisc', O_MS);
    bind('aExtra', O_EX);
    geo.instanceCount = 0;
    // Particles are world-space in the shader; the mesh transform is identity
    // and culling must never remove it.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = geo;

    const additive = o.mode === 'additive';
    this.uniforms = {
      uTime: { value: 0 },
      uAtlas: { value: new THREE.Vector2(o.cols, 1 / o.cols) },
      uSprite: { value: o.atlas },
      uDepth: { value: null },
      uRes: { value: new THREE.Vector2(1920, 1080) },
      uSoftEnable: { value: new THREE.Vector2(0, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Vector3(1, 0.95, 0.86) },
      uAmbTop: { value: new THREE.Vector3(0.35, 0.42, 0.55) },
      uAmbBot: { value: new THREE.Vector3(0.16, 0.14, 0.12) },
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
      uFog: { value: new THREE.Vector4(0.6, 0.65, 0.72, 0.0) },
    };

    const defines = { SOFT: '' };
    if (additive) defines.ADDITIVE = '';
    else defines.LIT = '';
    if (o.soft === false) delete defines.SOFT;

    const mat = new THREE.ShaderMaterial({
      name: `fx-particles-${o.mode}`,
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      defines,
      blending: THREE.CustomBlending,
      blendSrc: additive ? THREE.OneFactor : THREE.SrcAlphaFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
    });
    this.material = mat;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = o.renderOrder ?? (additive ? 12 : 10);
    this.mesh.visible = false;
    this.mesh.name = `fx-particles-${o.mode}`;
    // FX are not level content: keep the render probe's "is the world empty?"
    // heuristic from counting our sprites as geometry.
    this.mesh.userData.owProbe = true;
    this.mesh.userData.owNoShadow = true;

    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
    this._wrapped = false;
  }

  /** True while anything might still be alive. */
  get active() {
    return this.mesh.visible;
  }

  /**
   * Write one particle. `s` is the shared {@link SP} descriptor — pass it after
   * resetSpawn() so nothing leaks between call sites.
   */
  emit(s, now) {
    const i = this.cursor;
    this.cursor = i + 1;
    if (this.cursor >= this.capacity) {
      this.cursor = 0;
      this._wrapped = true;
    }
    if (i + 1 > this.highWater) this.highWater = i + 1;

    const a = this.array;
    const b = i * STRIDE;
    const life = Math.max(0.016, s.life);
    const birth = now + s.delay;

    a[b + O_PS] = s.x;
    a[b + O_PS + 1] = s.y;
    a[b + O_PS + 2] = s.z;
    a[b + O_PS + 3] = s.size0;

    a[b + O_VS] = s.vx;
    a[b + O_VS + 1] = s.vy;
    a[b + O_VS + 2] = s.vz;
    a[b + O_VS + 3] = s.size1;

    a[b + O_LF] = birth;
    a[b + O_LF + 1] = 1 / life;
    a[b + O_LF + 2] = s.drag;
    a[b + O_LF + 3] = s.gravity;

    a[b + O_RT] = s.rot;
    a[b + O_RT + 1] = s.spin;
    a[b + O_RT + 2] = s.stretch;
    a[b + O_RT + 3] = s.sizeCurve;

    a[b + O_C0] = s.r0;
    a[b + O_C0 + 1] = s.g0;
    a[b + O_C0 + 2] = s.b0;
    a[b + O_C0 + 3] = s.i0;

    a[b + O_C1] = s.r1;
    a[b + O_C1 + 1] = s.g1;
    a[b + O_C1 + 2] = s.b1;
    a[b + O_C1 + 3] = s.i1;

    a[b + O_MS] = s.tile;
    a[b + O_MS + 1] = s.soft;
    a[b + O_MS + 2] = s.alpha;
    a[b + O_MS + 3] = s.alphaCurve;

    a[b + O_EX] = s.turb;
    a[b + O_EX + 1] = s.turbFreq;
    a[b + O_EX + 2] = s.seed;
    a[b + O_EX + 3] = s.flags;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    const end = birth + life;
    if (end > this.expireAt) this.expireAt = end;
    this.spawned++;
    return i;
  }

  /** Upload the dirty span and update per-frame uniforms. Call once per frame. */
  flush(now) {
    if (this._dirtyHi >= this._dirtyLo) {
      const start = this._dirtyLo * STRIDE;
      const count = (this._dirtyHi - this._dirtyLo + 1) * STRIDE;
      this.ibuf.addUpdateRange(start, count);
      this.ibuf.needsUpdate = true;
      this._dirtyLo = Infinity;
      this._dirtyHi = -Infinity;
    }
    this.uniforms.uTime.value = now;
    this.geometry.instanceCount = this._wrapped ? this.capacity : this.highWater;
    this.mesh.visible = now < this.expireAt && this.geometry.instanceCount > 0;
  }

  /** Cache the shader's current smoke centers, squared radii and lifetime alpha. */
  _cacheSmoke(now) {
    if (this._smokeTime === now && this._smokeSpawned === this.spawned) return;
    this._smokeTime = now;
    this._smokeSpawned = this.spawned;
    this._smoke ??= new Float32Array(this.capacity * 5);
    this._smokeEnd = 0;
    const a = this.array;
    const smoke = this._smoke;
    for (let b = 0; b < this.highWater * STRIDE; b += STRIDE) {
      const tile = a[b + O_MS];
      if ((tile !== P.SMOKE_A && tile !== P.SMOKE_B) || a[b + O_EX + 3] > 1.5) continue;
      const t = now - a[b + O_LF];
      const n = t * a[b + O_LF + 1];
      if (t < 0 || n >= 1) continue;
      const fadeIn = Math.min(1, n / 0.045);
      const alpha = a[b + O_MS + 2] * Math.pow(1 - n, Math.max(a[b + O_MS + 3], 0.02))
        * fadeIn * fadeIn * (3 - 2 * fadeIn);
      if (alpha < 0.0035) continue;
      const k = Math.max(a[b + O_LF + 2], 0.02);
      const travel = (1 - Math.exp(-k * t)) / k;
      const gravity = a[b + O_LF + 3] / k;
      const grow = Math.min(1, n / 0.4);
      const amp = a[b + O_EX] * grow * grow * (3 - 2 * grow);
      const f = a[b + O_EX + 1];
      const ph = a[b + O_EX + 2] * 6.2831853;
      const size = a[b + O_PS + 3] + (a[b + O_VS + 3] - a[b + O_PS + 3])
        * Math.pow(n, Math.max(a[b + O_RT + 3], 0.02));
      if (size <= 0) continue;
      const i = this._smokeEnd;
      smoke[i] = a[b + O_PS] + a[b + O_VS] * travel + Math.sin(t * f * 1.13 + ph) * amp;
      smoke[i + 1] = a[b + O_PS + 1] + (a[b + O_VS + 1] - gravity) * travel + gravity * t
        + Math.sin(t * f * 0.79 + ph * 2.1) * amp;
      smoke[i + 2] = a[b + O_PS + 2] + a[b + O_VS + 2] * travel + Math.cos(t * f * 1.31 + ph * 1.7) * amp;
      smoke[i + 3] = size * size * 0.25;
      smoke[i + 4] = Math.min(1, alpha);
      this._smokeEnd += 5;
    }
  }

  /** Optical transmission through actual live smoke, never through its emitter. */
  visibilityBetween(from, to, now) {
    if (this.mode !== 'lit' || this.highWater === 0 || now >= this.expireAt) return 1;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-8) return 1;
    this._cacheSmoke(now);
    const ux = dx / length, uy = dy / length, uz = dz / length;
    const smoke = this._smoke;
    let visibility = 1;
    for (let i = 0; i < this._smokeEnd; i += 5) {
      const x = smoke[i] - from.x, y = smoke[i + 1] - from.y, z = smoke[i + 2] - from.z;
      const along = x * ux + y * uy + z * uz;
      const distanceSq = Math.max(0, x * x + y * y + z * z - along * along);
      const radiusSq = smoke[i + 3];
      if (distanceSq >= radiusSq) continue;
      const halfChord = Math.sqrt(radiusSq - distanceSq);
      const overlap = Math.min(length, along + halfChord) - Math.max(0, along - halfChord);
      if (overlap <= 0) continue;
      // Conservative soft atlas coverage, not an opaque sprite-sized sphere.
      // Actual rim erosion and camera-dependent soft-depth fading vary by view;
      // use a reduced core and radial falloff, also clipping at both endpoints.
      const core = 1 - distanceSq / radiusSq;
      visibility *= 1 - smoke[i + 4] * 0.75 * core * core * overlap / (2 * halfChord);
    }
    return visibility;
  }

  reset() {
    this.cursor = this.highWater = this.spawned = 0;
    this._smokeTime = NaN;
    this._wrapped = false;
    this.expireAt = -1;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Dispose the module-level quad prototype (called by the FX system). */
export function disposeQuadSource() {
  if (quadGeoSource) {
    quadGeoSource.dispose();
    quadGeoSource = null;
  }
}
