const rulesFor = (number) => ({
  count: Math.min(12, 5 + number),
  difficulty: Math.min(2, 1 + Math.max(0, number - 7) * 0.1),
});

/** One combat round, one outcome, one complete reset path. */
export class WaveSystem {
  static id = 'waves';
  static deps = ['ai', 'player', 'weapons', 'fx', 'audio'];

  init(ctx) {
    this.ctx = ctx;
    this.number = 1;
    this.status = 'playing';
    this.elapsed = 0;
    this.resultTime = 0;
  }

  get rules() {
    return rulesFor(this.number);
  }

  update(dt, ctx) {
    if (!window.__PLAYDROP_STARTED__ || dt <= 0) return;
    if (this.status === 'lost') {
      // Let the existing first-person death fall finish before freezing the world.
      this.resultTime += dt;
      if (this.resultTime >= 1.25) ctx.time.scale = 0;
      return;
    }
    if (this.status !== 'playing') return;
    this.elapsed += dt;
    const ai = ctx.get('ai');
    if (ctx.get('player').dead) this.finish('lost');
    else if (ai.agents.length > 0 && ai.stats.alive === 0) this.finish('won');
  }

  finish(status) {
    if (this.status !== 'playing') return;
    this.status = status;
    this.resultTime = 0;
    this.ctx.input.reset();
    this.ctx.get('player').setControlEnabled(false);
    if (status === 'won') this.ctx.time.scale = 0;
    this.ctx.events.emit('wave:ended', { won: status === 'won', number: this.number });
  }

  restart() {
    if (this.status === 'playing' || this.ctx.input.hostPaused || this.ctx.engine.error) return;
    const ctx = this.ctx;
    const number = this.number + (this.status === 'won' ? 1 : 0);
    ctx.input.reset();
    ctx.input.focusLost = false;
    ctx.get('world').resetDestruction();
    ctx.get('fx').reset();
    ctx.get('physics').resetDynamics();
    ctx.get('player').respawn(0);
    ctx.get('ai').resetWave(rulesFor(number));
    ctx.get('audio').resetCombat();
    ctx.get('render').resetHistory();
    this.number = number;
    this.elapsed = this.resultTime = 0;
    this.status = 'playing';
    ctx.time.scale = 1;
    ctx.engine._accum = 0;
    ctx.engine._renderDirty = true;
    ctx.events.emit('wave:started', { number: this.number });
  }
}
