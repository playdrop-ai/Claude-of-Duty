import { el, setText, setStyle, setClass } from './util.js';
import './touch.css';

const ICONS = {
  ads: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 1v5m0 12v5M1 12h5m12 0h5"/>',
  jump: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  crouch: '<path d="M12 4v16m-7-7 7 7 7-7"/>',
  grenade: '<path d="M9 3h6v4H9zm6 0 4 3"/><ellipse cx="12" cy="15" rx="7" ry="8"/><path d="M12 8v14M6 13h12M6 17h12"/>',
  reload: '<path d="M20 9a8 8 0 1 0-1 9M20 3v6h-6"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
};

const GUNS = {
  rifle: '<path d="M2 12h13V9h8V7h12v3h23v3h11v3H44l-3 4-2 9h-7l2-11h-7l-3 8h-5l2-10h-7l-8 6H2zM28 5h14v3H28z"/>',
  smg: '<path d="M3 12h15V9h29v3h16v4H43l-5 4 3 9h-7l-4-10h-6l-2 8h-6l2-11H9l-6 5zM22 6h14v3H22z"/>',
  pistol: '<path d="M13 8h40v9H37l-3 12H23l3-12H13zM17 5h7v3h-7z"/>',
};

/** Floating movement, swipe-to-look and direct weapon selection. */
export class TouchControls {
  constructor(ui, nipplejs) {
    this.ui = ui;
    this.input = ui.ctx.input;
    this.touch = this.input.touch;
    this.nipplejs = nipplejs;
    this.weapons = ui.ctx.peek('weapons');
    this.root = el('div', 'ow-touch', ui.root);
    this.root.dataset.touchUi = '';
    this.root.setAttribute('aria-label', 'Touch controls');
    this.input.inputMethod = 'touch';
    this.buttons = new Map();
    this.pointers = new Map();
    this.lookPointer = null;
    this.stickHeld = false;
    this.visible = false;

    // Prevent synthetic mouse events from firing a weapon or locking a cursor.
    for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu']) {
      this.root.addEventListener(type, e => { e.preventDefault(); e.stopPropagation(); });
    }

    this.lookZone = el('div', 'ow-touch-look', this.root);
    this.lookZone.setAttribute('aria-label', 'Swipe to look');
    this.lookZone.addEventListener('pointerdown', e => this.beginLook(e));
    this.lookZone.addEventListener('pointermove', e => this.moveLook(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.lookZone.addEventListener(type, e => this.endLook(e));
    }

    this.stickZone = el('div', 'ow-touch-move', this.root);
    this.stickZone.setAttribute('aria-label', 'Move joystick. Push past the ring to sprint.');
    this.createJoystick();

    for (const [action, label] of [
      ['ads', 'Aim'], ['jump', 'Jump'], ['crouch', 'Crouch'],
      ['grenade', 'Grenade'], ['pause', 'Pause'],
    ]) this.addButton(action, label);
    this.grenadeCount = el('span', 'ow-touch-count', this.buttons.get('grenade'), '2');
    this.buildLoadout();

    this.touch.onReset = () => this.cancelPointers();
    this.onResize = () => this.update();
    addEventListener('resize', this.onResize);
    this.update();
  }

  get canPlay() {
    return window.__PLAYDROP_STARTED__ === true && innerWidth >= innerHeight &&
      !this.ui.menu.open && !this.ui.resultActive && !this.input.hostPaused &&
      !document.hidden && this.input.enabled && !this.input.frozen;
  }

  createJoystick() {
    this.joystick = this.nipplejs.create({
      zone: this.stickZone, mode: 'dynamic', follow: false, multitouch: false,
      size: 112, color: 'white', restOpacity: 0, fadeTime: 100,
      threshold: 0.08, dynamicPage: true,
    });
    this.joystick.on('start', () => {
      this.stickHeld = this.canPlay;
      if (this.stickHeld) this.input.inputMethod = 'touch';
    });
    this.joystick.on('move', (_, data) => {
      if (!this.stickHeld || !this.canPlay) return;
      const { x, y } = data.vector;
      const length = Math.hypot(x, y);
      const strength = Math.max(0, (Math.min(1, length) - 0.08) / 0.92);
      this.touch.move.x = length ? x / length * strength : 0;
      this.touch.move.y = length ? y / length * strength : 0;
      if (data.force > 1.2 && y > 0.6) this.touch.press('sprint');
      else this.touch.release('sprint');
    });
    this.joystick.on('end', () => {
      this.stickHeld = false;
      this.touch.move.x = this.touch.move.y = 0;
      this.touch.release('sprint');
    });
  }

  buildLoadout() {
    const loadout = el('div', 'ow-touch-loadout', this.root);
    loadout.setAttribute('role', 'group');
    loadout.setAttribute('aria-label', 'Weapons. Tap the equipped weapon to reload.');
    this.weaponSlots = this.weapons.weaponIds.map((id, index) => {
      const action = `weapon${index + 1}`;
      const label = this.weapons.states.get(id).def.label;
      const button = el('button', 'ow-touch-weapon', loadout);
      button.type = 'button';
      button.dataset.weapon = id;
      button.innerHTML = `<svg class="ow-touch-gun" viewBox="0 0 72 32" fill="currentColor" aria-hidden="true">${GUNS[id]}</svg>`;
      const detail = el('div', 'ow-touch-weapon-detail', button);
      el('span', 'ow-touch-weapon-name', detail, label);
      const ammo = el('span', 'ow-touch-weapon-ammo', detail);
      const rounds = el('b', null, ammo);
      const reserve = el('span', null, ammo);
      const reload = el('span', 'ow-touch-reload-hint', ammo);
      reload.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${ICONS.reload}</svg>`;
      const progress = el('i', 'ow-touch-reload-progress', button);
      let downX = 0, downY = 0, dragged = false;
      button.addEventListener('pointerdown', e => {
        if (!this.canPlay || this.pointers.has(action)) return;
        e.preventDefault();
        this.input.inputMethod = 'touch';
        this.pointers.set(action, e.pointerId);
        button.setPointerCapture(e.pointerId);
        downX = e.clientX; downY = e.clientY; dragged = false;
      });
      button.addEventListener('pointermove', e => {
        if (this.pointers.get(action) === e.pointerId &&
          Math.hypot(e.clientX - downX, e.clientY - downY) > 10) dragged = true;
      });
      const release = e => {
        if (this.pointers.get(action) !== e.pointerId) return;
        this.pointers.delete(action);
        if (e.type === 'pointerup' && !dragged && this.canPlay) {
          this.touch.pulse(this.weapons.activeId === id ? 'reload' : action);
        }
      };
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, release);
      return { id, label, button, rounds, reserve, progress };
    });
  }

  updateLoadout() {
    const state = this.weapons.getHudState();
    for (const slot of this.weaponSlots) {
      const active = slot.id === this.weapons.activeId;
      setClass(slot.button, 'selected', active);
      setClass(slot.button, 'reloading', active && state.reloading);
      slot.button.setAttribute('aria-pressed', String(active));
      slot.button.setAttribute('aria-label', active ? `${slot.label}. Tap to reload.` : `Equip ${slot.label}`);
      if (!active) continue;
      setText(slot.rounds, state.ammo);
      setText(slot.reserve, `/ ${state.reserve}`);
      setStyle(slot.progress, 'transform', `scaleX(${state.reloading ? state.reloadProgress : 0})`);
    }
  }

  beginLook(e) {
    if (!this.canPlay || this.lookPointer !== null) return;
    e.preventDefault();
    this.input.inputMethod = 'touch';
    this.lookPointer = e.pointerId;
    this.lookX = e.clientX;
    this.lookY = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  moveLook(e) {
    if (e.pointerId !== this.lookPointer || !this.canPlay) return;
    e.preventDefault();
    // Screen-distance aiming, independent of frame rate or device pixel ratio.
    const sensitivity = Math.PI * 0.65 / Math.min(innerWidth, innerHeight);
    this.touch.aim((e.clientX - this.lookX) * sensitivity, (e.clientY - this.lookY) * sensitivity);
    this.lookX = e.clientX;
    this.lookY = e.clientY;
  }

  endLook(e) {
    if (e.pointerId === this.lookPointer) this.lookPointer = null;
  }

  addButton(action, label) {
    const button = el('button', `ow-touch-button ow-touch-${action}`, this.root);
    button.type = 'button';
    button.setAttribute('aria-label', action === 'crouch' ? 'Crouch. Hold for prone.' : label);
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[action]}</svg>`;
    this.buttons.set(action, button);
    button.addEventListener('pointerdown', e => {
      if (!this.canPlay || button.disabled || this.pointers.has(action)) return;
      e.preventDefault();
      this.input.inputMethod = 'touch';
      button.setPointerCapture(e.pointerId);
      this.pointers.set(action, e.pointerId);
      if (action === 'jump') this.touch.press(action);
      else if (action === 'ads') {
        this.touch.held('ads') ? this.touch.release('ads') : this.touch.press('ads');
      } else if (action === 'crouch') {
        this.proneHeld = false;
        this.proneTimer = setTimeout(() => {
          if (this.canPlay && this.pointers.has('crouch')) {
            this.proneHeld = true;
            this.touch.pulse('prone');
          }
        }, 450);
      } else this.touch.pulse(action);
    });
    const release = e => {
      if (this.pointers.get(action) !== e.pointerId) return;
      this.pointers.delete(action);
      if (action === 'jump') this.touch.release(action);
      if (action === 'crouch') {
        clearTimeout(this.proneTimer);
        if (e.type === 'pointerup' && !this.proneHeld && this.canPlay) this.touch.pulse('crouch');
      }
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, release);
  }

  cancelPointers() {
    const wasMoving = this.stickHeld;
    clearTimeout(this.proneTimer);
    this.pointers.clear();
    this.lookPointer = null;
    this.stickHeld = false;
    // A paused/cancelled gesture must not leave a stale joystick origin alive.
    if (wasMoving) {
      this.joystick.destroy();
      this.createJoystick();
    }
  }

  update() {
    const touchMode = this.input.inputMethod === 'touch';
    this.ui.root.classList.toggle('ow-mobile', true);
    this.ui.root.classList.toggle('ow-touch-layout', touchMode);
    const visible = touchMode && this.canPlay;
    if (visible !== this.visible) {
      this.visible = visible;
      this.touch.enabled = visible;
      this.touch.reset();
    }
    setStyle(this.root, 'display', visible ? 'block' : 'none');
    this.buttons.get('ads').setAttribute('aria-pressed', String(this.touch.held('ads')));
    const player = this.ui.ctx.peek('player');
    const stance = player?.movement?.stance;
    this.buttons.get('crouch').setAttribute('aria-pressed', String(stance === 'crouch' || stance === 'prone'));
    this.buttons.get('crouch').setAttribute('aria-label', stance === 'prone' ? 'Crouch. Hold to leave prone.' : stance === 'crouch' ? 'Stand. Hold for prone.' : 'Crouch. Hold for prone.');
    this.stickZone.classList.toggle('sprinting', this.touch.held('sprint'));
    const count = this.ui.ctx.peek('weapons')?.getHudState().lethalCount ?? 0;
    setText(this.grenadeCount, count);
    this.buttons.get('grenade').disabled = count === 0;
    if (visible) this.updateLoadout();
  }

  dispose() {
    this.touch.onReset = null;
    this.touch.enabled = false;
    this.touch.reset();
    this.cancelPointers();
    removeEventListener('resize', this.onResize);
    this.joystick.destroy();
    this.root.remove();
  }
}
