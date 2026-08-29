import { GamepadInput } from './gamepad.js';
import { TouchInput } from './touch.js';

/**
 * Input aggregation: keyboard, mouse (pointer-locked), gamepad and touch, exposed as
 * a stable per-frame snapshot so gameplay never touches raw DOM events.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 */

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  swapWeapon: ['Tab'],
  cycleFireMode: ['KeyB'],
  inspect: ['KeyI'],
  grenade: ['KeyG'],
  flashlight: ['KeyT'],
  pause: ['Escape'],
};

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame
    this._pendingDown = new Set();
    this._pendingUp = new Set();

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;

    this.gamepad = new GamepadInput();
    this.touch = new TouchInput();
    this.stick = this.gamepad.stick;
    this.inputMethod = 'keyboard';
    this._lastPointerType = 'mouse';
    this.hostPaused = false;
    this.orientationPaused = false;
    this.focusLost = false;
    this.controllerDisconnected = false;
    this._controllerAvailability = null; // null means standalone, without an SDK host.
    this._controllerUnsubscribe = null;
    this._gamepadAccessBlocked = false;

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      blur: this._onBlur.bind(this),
      visibility: () => { if (document.hidden) this._onBlur(); },
      pointerdown: (e) => {
        this._lastPointerType = e.pointerType;
        if (e.pointerType === 'touch') this.inputMethod = 'touch';
      },
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    addEventListener('keydown', this._bound.keydown);
    addEventListener('keyup', this._bound.keyup);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    addEventListener('pointerdown', this._bound.pointerdown, true);
    document.addEventListener('visibilitychange', this._bound.visibility);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  detach() {
    removeEventListener('keydown', this._bound.keydown);
    removeEventListener('keyup', this._bound.keyup);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    removeEventListener('pointerdown', this._bound.pointerdown, true);
    document.removeEventListener('visibilitychange', this._bound.visibility);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
    this._controllerUnsubscribe?.();
  }

  bindPlayDropDevice(device) {
    this._controllerUnsubscribe?.();
    this._controllerAvailability = device.controllerAvailability;
    this._controllerUnsubscribe = device.onControllerChange(({ availability }) => {
      this._controllerAvailability = availability;
    });
  }

  requestPointerLock() {
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.repeat) return;
    this.inputMethod = 'keyboard';
    // Dialog buttons keep native Enter/Space/Tab behavior. None of those keys
    // may also enter the movement/weapon queue when the dialog closes.
    if (e.code !== 'Escape' && e.target?.closest?.('button, input, textarea, select, a[href], [contenteditable="true"]')) return;
    // Let devtools/refresh through; swallow everything else the game binds.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    this._pendingDown.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(e.code);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    if (this._lastPointerType === 'touch' || e.sourceCapabilities?.firesTouchEvents || e.target?.closest?.('[data-touch-ui]')) return;
    this.inputMethod = 'keyboard';
    // UI clicks must reach their button before it requests pointer lock.
    // Locking on Resume's mouse-down retargets mouse-up and cancels its click.
    if (e.target !== this.canvas) return;
    if (!this.pointerLocked && e.button === 0) this.requestPointerLock();
    this._pendingDown.add(`Mouse${e.button}`);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    if (this._lastPointerType === 'touch' || e.sourceCapabilities?.firesTouchEvents || e.target?.closest?.('[data-touch-ui]')) return;
    this._pendingUp.add(`Mouse${e.button}`);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
    if (e.movementX || e.movementY) this.inputMethod = 'keyboard';
  }

  _onWheel(e) {
    if (!this.enabled) return;
    this.inputMethod = 'keyboard';
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this.reset();
  }

  /** Losing focus must release every held key, or the player runs forever. */
  _onBlur() {
    this.focusLost = true;
    this.reset();
  }

  reset() {
    this.down.clear();
    this._pressed.clear();
    this._released.clear();
    this._pendingDown.clear();
    this._pendingUp.clear();
    this.look.x = this.look.y = this._rawLook.x = this._rawLook.y = 0;
    this.wheel = this._pendingWheel = 0;
    this.gamepad.reset();
    this.touch.reset();
  }

  beginFrame() {
    this._pressed.clear();
    this._released.clear();

    for (const code of this._pendingDown) {
      if (!this.down.has(code)) {
        this.down.add(code);
        this._pressed.add(code);
      }
    }
    for (const code of this._pendingUp) {
      if (this.down.delete(code)) this._released.add(code);
    }
    this._pendingDown.clear();
    this._pendingUp.clear();

    const s = this.config.sensitivity;
    this.touch.beginFrame(this.enabled && !this.frozen && !this.hostPaused && !this.orientationPaused && !document.hidden);
    this.look.x = this.frozen ? 0 : this._rawLook.x * s + this.touch.look.x;
    this.look.y = this.frozen ? 0 : (this._rawLook.y * s + this.touch.look.y) * (this.config.invertY ? -1 : 1);
    this._rawLook.x = 0;
    this._rawLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    this._pollGamepad();
  }

  endFrame() {}

  _pollGamepad() {
    let pads = [];
    const allowed = this._controllerAvailability === null || this._controllerAvailability === 'ready';
    // The host owns iframe focus/overlays. Standalone play must be the focused tab.
    const focused = this._controllerAvailability !== null || document.hasFocus();
    if (allowed && focused && !document.hidden && this.enabled && !this.frozen && !this.hostPaused && !this.orientationPaused && !this._gamepadAccessBlocked) {
      try {
        pads = Array.from(navigator.getGamepads?.() ?? []);
      } catch (error) {
        if (error.name !== 'SecurityError') throw error;
        this._gamepadAccessBlocked = true;
        console.warn('[input] Controller access is blocked by the browser permissions policy.');
      }
    }
    this.gamepad.update(pads);
    this.controllerDisconnected = this.gamepad.disconnected && this.inputMethod === 'gamepad';
    if (!allowed || this._gamepadAccessBlocked) this.gamepad.status = this._gamepadAccessBlocked ? 'blocked' : this._controllerAvailability;
    if (this.gamepad.active) this.inputMethod = 'gamepad';
    else if (this.controllerDisconnected) this.inputMethod = 'keyboard';
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    if (this.touch.held(name)) return true;
    if (this.gamepad.held(name)) return true;
    const codes = ACTIONS[name] ?? [];
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    if (this.touch.pressed(name)) return true;
    if (this.gamepad.pressed(name)) return true;
    const codes = ACTIONS[name] ?? [];
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  get fire() {
    return this.down.has('Mouse0') || this.gamepad.held('fire') || this.touch.held('fire');
  }

  get firePressed() {
    return this._pressed.has('Mouse0') || this.gamepad.pressed('fire') || this.touch.pressed('fire');
  }

  get ads() {
    return this.down.has('Mouse2') || this.gamepad.held('ads') || this.touch.held('ads');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    x += this.touch.move.x;
    y += this.touch.move.y;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
