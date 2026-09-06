import { setLocale, t } from './i18n/index.js';
const boot = document.getElementById('boot');
const status = document.getElementById('boot-status');
const progress = document.getElementById('boot-progress');
const progressBar = document.getElementById('boot-progress-bar');
const note = document.getElementById('boot-note');
const canvas = document.getElementById('game');
const rotateOverlay = document.getElementById('rotate-overlay');

const fitBootTitle = () => {
  const title = document.getElementById('boot-title');
  if (!title || !document.documentElement.classList.contains('cjk') || !title.clientWidth) return;
  title.style.fontSize = '';
  if (title.scrollWidth > title.clientWidth) {
    const size = parseFloat(getComputedStyle(title).fontSize);
    title.style.fontSize = `${size * title.clientWidth / title.scrollWidth}px`;
  }
};
addEventListener('resize', fitBootTitle);
const localizeDocument = () => {
  document.querySelectorAll('[data-i18n]').forEach(node => {
    node.textContent = t(node.dataset.i18n, { title: t('title') });
  });
  progress?.setAttribute('aria-label', t('deploymentProgress'));
  fitBootTitle();
};

const touchCapable = navigator.maxTouchPoints > 0;
const bootAbort = new AbortController();
const { signal } = bootAbort;
document.documentElement.classList.toggle('touch-device', touchCapable);

window.__PLAYDROP_STARTED__ = false;

const syncOrientation = () => {
  const portrait = innerHeight > innerWidth;
  window.__PLAYDROP_PORTRAIT__ = portrait;
  if (rotateOverlay) rotateOverlay.hidden = !portrait;

  const engine = window.__ENGINE__;
  if (!engine) return;
  const changed = engine.input.orientationPaused !== portrait;
  engine.input.orientationPaused = portrait;
  if (changed) engine.input.reset();
  if (portrait) {
    document.exitPointerLock?.();
    engine.stop();
  } else {
    engine.resize();
    if (window.__READY__ && window.__PLAYDROP_STARTED__ && !engine.input.hostPaused) engine.start();
  }
  if (changed) void window.__AUDIO__?.syncPlayback?.();
};
window.__PLAYDROP_SYNC_ORIENTATION__ = syncOrientation;
addEventListener('resize', syncOrientation);
syncOrientation();

const setBootProgress = (message, percent) => {
  signal.throwIfAborted();
  if (status) status.textContent = message;
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  if (progress) progress.setAttribute('aria-valuenow', String(value));
  if (progressBar) progressBar.style.width = `${value}%`;
};

const nextFrame = () => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const frame = requestAnimationFrame(() => {
    signal.removeEventListener('abort', cancel);
    resolve();
  });
  const cancel = () => { cancelAnimationFrame(frame); reject(signal.reason); };
  signal.addEventListener('abort', cancel, { once: true });
});
window.__PLAYDROP_BOOT__ = { report: setBootProgress, nextFrame };

const loadPlayDropSdk = async () => {
  if (!window.playdrop?.init) {
    const script = document.createElement('script');
    script.src = 'https://assets.playdrop.ai/sdk/playdrop.js';
    script.async = true;
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error('PlayDrop SDK failed to load'));
      document.head.append(script);
    });
  }
  if (!window.playdrop?.init) throw new Error('PlayDrop SDK loaded without exposing playdrop.init()');
  return window.playdrop;
};

const waitForStart = () => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  if (!boot || !canvas) throw new Error('start gate elements missing');
  const gate = new AbortController();
  const options = { signal: gate.signal };
  let pollFrame = 0;
  const cleanup = () => {
    gate.abort();
    cancelAnimationFrame(pollFrame);
    signal.removeEventListener('abort', cancel);
  };
  const cancel = () => { cleanup(); reject(signal.reason); };
  signal.addEventListener('abort', cancel, { once: true });
  boot.dataset.state = 'ready';
  boot.setAttribute('aria-busy', 'false');
  boot.setAttribute('role', 'button');
  boot.setAttribute('aria-label', t('startGame', { title: t('title') }));
  boot.tabIndex = 0;
  setBootProgress(t('ready'), 100);
  if (note) note.textContent = t('clickStart');

  // Keep the start click out of the gameplay input queue. Pointerdown is left
  // alone so the Web Audio gesture handler can unlock sound on the same action.
  const consumeMouseInput = (event) => event.stopPropagation();
  boot.addEventListener('mousedown', consumeMouseInput, options);
  boot.addEventListener('mouseup', consumeMouseInput, options);
  const input = window.__ENGINE__.input;
  const start = (event) => {
    event?.preventDefault();
    if (window.__PLAYDROP_STARTED__) return;
    cleanup();
    if (event) input.inputMethod = event.pointerType === 'touch' || input.inputMethod === 'touch' ? 'touch' : 'keyboard';
    input.reset();
    input.focusLost = false;
    window.__PLAYDROP_STARTED__ = true;
    boot.dataset.state = 'starting';
    canvas.focus({ preventScroll: true });
    // Capture only once this click has started play. Capturing on pointerdown
    // can redirect its later click to the canvas and strand the ready overlay.
    if (event?.type === 'click' && input.inputMethod !== 'touch') input.requestPointerLock();
    // Gamepad polling is not a DOM gesture. Try normal audio startup without
    // blocking play; browser autoplay policy may still require one page click.
    if (!event) void window.__AUDIO__?.start();
    resolve();
  };
  const startFromKeyboard = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    start(event);
  };
  boot.addEventListener('click', start, options);
  boot.addEventListener('keydown', startFromKeyboard, options);
  const pollStart = () => {
    input.beginFrame(); // The engine is deliberately stopped at the ready gate.
    if (note) note.textContent = input.gamepad.connected
      ? t('controllerStart', { button: input.gamepad.labels.confirm })
      : touchCapable ? t('tapStart') : t('clickStart');
    if (input.gamepad.pressed('confirm')) start();
    else pollFrame = requestAnimationFrame(pollStart);
  };
  pollFrame = requestAnimationFrame(pollStart);
});

const showBootFailure = (error) => {
  if (signal.aborted) return;
  console.error('[Claude of Duty] Game stopped:', error);
  bootAbort.abort(error);
  window.__ENGINE__?.fail(error);
  window.__PLAYDROP_STARTED__ = window.__READY__ = false;
  window.__PLAYDROP_AUDIO_ENABLED__ = false;
  const audio = window.__AUDIO__;
  if (audio) { audio.enabled = false; audio.dispose(); }
  document.exitPointerLock?.();
  boot.hidden = false;
  boot.style.opacity = '1';
  boot.dataset.state = 'error';
  boot.setAttribute('role', 'alertdialog');
  boot.setAttribute('aria-label', t('restartGame', { title: t('title') }));
  boot.setAttribute('aria-busy', 'false');
  boot.tabIndex = 0;
  status.textContent = error.code === 'graphics-context-lost' ? t('graphicsLost') : t('gameStopped');
  note.textContent = t('restartHint');
  const restart = () => window.location.reload();
  boot.addEventListener('click', restart);
  boot.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    restart();
  });
  boot.focus({ preventScroll: true });
};
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  const error = new Error(t('graphicsLost'));
  error.code = 'graphics-context-lost';
  showBootFailure(error);
}, { once: true });

const bindHostLifecycle = (sdk) => {
  if (!sdk?.host) return;
  const input = window.__ENGINE__.input;
  input.bindPlayDropDevice(sdk.device);
  input.hostPaused = sdk.host.isPaused;
  sdk.host.onPause(() => {
    input.hostPaused = true;
    void window.__AUDIO__?.syncPlayback?.();
    input.reset();
    window.__ENGINE__.stop();
  });
  sdk.host.onResume(() => {
    if (signal.aborted) return;
    input.reset();
    input.hostPaused = false;
    void window.__AUDIO__?.syncPlayback?.();
    if (window.__PLAYDROP_STARTED__ && !input.orientationPaused) window.__ENGINE__?.start?.();
  });
  sdk.host.onAudioPolicyChange(({ enabled }) => {
    if (signal.aborted) return;
    window.__PLAYDROP_AUDIO_ENABLED__ = enabled;
    window.__AUDIO__?.setEnabled?.(enabled);
  });

  window.__PLAYDROP_AUDIO_ENABLED__ = sdk.host.audioEnabled;
  window.__AUDIO__?.setEnabled?.(sdk.host.audioEnabled);
  if (sdk.host.isPaused) window.__ENGINE__?.stop?.();
};

try {
  // Paint loading before expensive procedural generation.
  await nextFrame();

  const params = new URLSearchParams(window.location.search);
  const hostedByPlayDrop = params.has('playdrop_channel');
  let sdk = null;
  let hostReady = false;

  if (hostedByPlayDrop) {
    setBootProgress(t('connecting'), 5);
    performance.mark('playdrop:init:start');
    const playdrop = await loadPlayDropSdk();
    sdk = await playdrop.init();
    setLocale(sdk.host.locale);
    localizeDocument();
    performance.mark('playdrop:init:end');
    performance.measure('playdrop:init', 'playdrop:init:start', 'playdrop:init:end');
    window.__PLAYDROP_AUDIO_ENABLED__ = sdk.host.audioEnabled;
    setBootProgress(t('generating'), 8);

    // Reveal loading for interactive play. Capture/profile/preview still require
    // the first gameplay frame before the host removes its poster.
    const interactivePlay =
      params.get('capture') !== '1' && params.get('profile') !== '1' && sdk.host.phase === 'play';
    if (interactivePlay) {
      sdk.host.ready();
      hostReady = true;
    }
  } else {
    setLocale('en');
    localizeDocument();
    window.__PLAYDROP_AUDIO_ENABLED__ = true;
    setBootProgress(t('generating'), 8);
  }

  await import('./main.js');
  signal.throwIfAborted();
  bindHostLifecycle(sdk);
  const requiresStart = params.get('capture') !== '1' && params.get('profile') !== '1' && sdk?.host?.phase !== 'preview';
  if (requiresStart) window.__ENGINE__.stop();
  if (touchCapable) {
    setBootProgress(t('touchPreparing'), 99);
    const { TouchControls } = await import('./ui/touch.js');
    // Standalone bundles NippleJS; hosted play must use the SDK-pinned runtime.
    const nipplejs = sdk ? await sdk.libs.nipplejs.load() : (await import('nipplejs')).default;
    signal.throwIfAborted();
    const ui = window.__ENGINE__.ctx.peek('ui');
    ui.touchControls = new TouchControls(ui, nipplejs);
  }
  if (requiresStart) {
    await Promise.all([waitForStart(), nextFrame().then(() => {
      if (!hostReady) sdk?.host?.ready();
    })]);
    signal.throwIfAborted();
    if (!sdk?.host?.isPaused) window.__ENGINE__?.start?.();
  } else {
    window.__PLAYDROP_STARTED__ = true;
    if (!hostReady) sdk?.host?.ready();
    setBootProgress(t('ready'), 100);
  }
  boot.style.opacity = '0';
  await new Promise((resolve) => setTimeout(resolve, 340));
  if (!signal.aborted) boot.hidden = true;
} catch (error) {
  showBootFailure(error);
}
