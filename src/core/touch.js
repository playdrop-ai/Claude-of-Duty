/** Touch controls feed the same frame actions as keyboard and gamepad. */
export class TouchInput {
  constructor() {
    this.enabled = false;
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this._look = { x: 0, y: 0 };
    this.down = new Set();
    this.presses = new Set();
    this._pending = new Set();
  }

  press(action) {
    if (!this.enabled) return;
    if (!this.down.has(action)) this._pending.add(action);
    this.down.add(action);
  }

  release(action) { this.down.delete(action); }

  pulse(action) {
    if (this.enabled) this._pending.add(action);
  }

  aim(dx, dy) {
    if (!this.enabled) return;
    this._look.x += dx;
    this._look.y += dy;
  }

  beginFrame(allowed) {
    if (!allowed || !this.enabled) {
      this.reset();
      return;
    }
    this.presses.clear();
    for (const action of this._pending) this.presses.add(action);
    this._pending.clear();
    this.look.x = this._look.x;
    this.look.y = this._look.y;
    this._look.x = this._look.y = 0;
  }

  held(action) { return this.down.has(action); }
  pressed(action) { return this.presses.has(action); }

  reset() {
    this.down.clear();
    this.presses.clear();
    this._pending.clear();
    this.move.x = this.move.y = this.look.x = this.look.y = 0;
    this._look.x = this._look.y = 0;
    this.onReset?.();
  }
}
