// W3C standard mapping. PlayDrop owns availability; the browser owns live input.
export const GAMEPAD_ACTIONS = {
  confirm: 0, jump: 0, cancel: 1, crouch: 1, reload: 2, swapWeapon: 3,
  cycleFireMode: 4, grenade: 5, ads: 6, fire: 7, pause: 9,
  sprint: 10, inspect: 11, prone: 13, leanLeft: 14, leanRight: 15,
};

const XBOX_LABELS = { confirm: 'A', swapWeapon: 'Y', grenade: 'RB', reload: 'X' };
const PS_LABELS = { confirm: '×', swapWeapon: '△', grenade: 'R1', reload: '□' };
const DEADZONE = 0.16;

function stick(out, xKey, yKey, x, y, exponent = 1) {
  const length = Math.hypot(x, y);
  const strength = length > DEADZONE ? ((Math.min(1, length) - DEADZONE) / (1 - DEADZONE)) ** exponent : 0;
  out[xKey] = length > 0 ? x / length * strength : 0;
  out[yKey] = length > 0 ? y / length * strength : 0;
}

export class GamepadInput {
  constructor() {
    this.index = null;
    this.id = '';
    this.connected = false;
    this.disconnected = false;
    this.active = false;
    this.status = 'disconnected';
    this.labels = XBOX_LABELS;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };
    this.buttons = new Uint8Array(17);
    this.presses = new Uint8Array(17);
    this._blockButtons = false;
  }

  update(pads) {
    const usable = (pad) => pad && pad.connected !== false && pad.mapping === 'standard';
    const pad = pads.find(p => usable(p) && p.index === this.index && p.id === this.id) ?? pads.find(usable);
    this.disconnected = this.connected && (!pad || pad.index !== this.index || pad.id !== this.id);
    if (this.disconnected) this.reset();
    this.connected = Boolean(pad);
    this.index = pad?.index ?? null;
    this.id = pad?.id ?? '';
    this.status = pad ? 'ready' : pads.some(p => p && p.connected !== false) ? 'unmapped' : 'disconnected';
    this.labels = /dualsense|dualshock|playstation|054c|sony/i.test(this.id) ? PS_LABELS : XBOX_LABELS;
    this.active = false;
    this.presses.fill(0);
    if (!pad) {
      this.buttons.fill(0);
      Object.keys(this.stick).forEach(key => { this.stick[key] = 0; });
      return;
    }

    const held = (i) => Boolean(pad.buttons[i]?.pressed || pad.buttons[i]?.value > 0.5);
    if (this._blockButtons && !pad.buttons.some((_, i) => held(i))) this._blockButtons = false;
    for (let i = 0; i < this.buttons.length; i++) {
      const down = !this._blockButtons && held(i) ? 1 : 0;
      this.presses[i] = down && !this.buttons[i] ? 1 : 0;
      this.buttons[i] = down;
      if (down) this.active = true;
    }
    const axis = (i) => Number.isFinite(pad.axes[i]) ? pad.axes[i] : 0;
    stick(this.stick, 'moveX', 'moveY', axis(0), axis(1));
    stick(this.stick, 'lookX', 'lookY', axis(2), axis(3), 2.4);
    this.active ||= Object.values(this.stick).some(value => value !== 0);
  }

  held(action) { return this.buttons[GAMEPAD_ACTIONS[action]] === 1; }
  pressed(action) { return this.presses[GAMEPAD_ACTIONS[action]] === 1; }

  // A start/resume/redeploy press must not also jump or shoot in the next frame.
  reset() {
    this.buttons.fill(0);
    this.presses.fill(0);
    this._blockButtons = true;
    Object.keys(this.stick).forEach(key => { this.stick[key] = 0; });
  }
}
