/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Runtime budgets are device-class decisions, independent of visual quality. */
export const RUNTIME_PROFILES = {
  desktop: {
    targetFps: 60,
    physicsHz: 60,
    maxRenderWidth: 1920,
    maxRenderHeight: 1080,
  },
  mobile: {
    targetFps: 30,
    physicsHz: 30,
    maxRenderWidth: 1280,
    maxRenderHeight: 720,
  },
};

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  // Phones keep the same world, materials and TAA, with a fixed GPU budget.
  // These are rendering/FX budgets only; simulation and input stay identical.
  mobile: {
    renderScale: 1.0,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    contactShadows: false,
    dof: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 6000,
    decalBudget: 128,
  },
  low: {
    renderScale: 0.72,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  ...RUNTIME_PROFILES.desktop,
  mobile: false,
  quality: 'ultra',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

/** A caller's quality query wins over device selection, including on touch PCs. */
export function selectQuality(requestedQuality, touchCapable) {
  return requestedQuality ?? (touchCapable ? 'mobile' : DEFAULTS.quality);
}

export function selectRuntimeProfile(mobile) {
  return RUNTIME_PROFILES[mobile ? 'mobile' : 'desktop'];
}

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  for (const key of ['targetFps', 'physicsHz', 'maxRenderWidth', 'maxRenderHeight']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] <= 0) {
      throw new Error(`${key} must be a positive finite number, received ${cfg[key]}`);
    }
  }
  cfg.fixedDt = 1 / cfg.physicsHz;
  cfg.q = {};
  cfg.setQuality = (name) => {
    if (!Object.hasOwn(QUALITY_PRESETS, name)) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    for (const key of Object.keys(cfg.q)) delete cfg.q[key];
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  cfg.setQuality(cfg.quality);
  return cfg;
}
