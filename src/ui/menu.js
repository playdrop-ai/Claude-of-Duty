import { el, setText, setStyle, damp, ease } from './util.js';

/**
 * Minimal pause overlay. Runtime settings stay out of the play surface so the
 * player has one obvious action: resume the match.
 */
export class PauseMenu {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.root = el('div', 'ow-menu', parent);
    const inner = el('div', 'ow-menu-inner', this.root);

    el('h1', null, inner, 'PAUSED');
    const btns = el('div', 'ow-btns', inner);
    this.resumeBtn = el('button', 'ow-btn primary', btns, 'RESUME');
    this.resumeBtn.type = 'button';
    this.resumeBtn.addEventListener('click', () => this.close());

    this.open = false;
    this.shown = 0;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'cursor', 'default');
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.ctx.input.reset();
    setStyle(this.root, 'display', '');
    document.exitPointerLock?.();
    const t = this.ctx.time;
    if (t) {
      this._prevScale = t.scale;
      t.scale = 0;
    }
    this.ctx.peek('player')?.setControlEnabled?.(false, { preserveMotion: true });
    this.resumeBtn.focus({ preventScroll: true });
    this.ctx.events.emit('ui:pause', { paused: true });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.ctx.input.reset();
    const t = this.ctx.time;
    if (t) t.scale = this._prevScale ?? 1;
    this.ctx.peek('player')?.setControlEnabled?.(true);
    this.ctx.canvas.focus({ preventScroll: true });
    if (this.ctx.input.inputMethod === 'keyboard') this.ctx.input.requestPointerLock();
    this.ctx.events.emit('ui:pause', { paused: false });
  }

  /** Driven with unscaled time so the fade still runs while the game is frozen. */
  update(rawDt) {
    const input = this.ctx.input;
    setText(this.resumeBtn, input.inputMethod === 'gamepad' ? `${input.gamepad.labels.confirm} · RESUME` : 'RESUME');
    this.shown = damp(this.shown, this.open ? 1 : 0, 14, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));
  }

  dispose() {
    this.root.remove();
  }
}
