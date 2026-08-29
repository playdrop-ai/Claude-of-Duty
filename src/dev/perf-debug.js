const SAMPLE_CAPACITY = 120;
const UPDATE_INTERVAL_MS = 250;

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

export function installPerfDebug(engine) {
  const style = document.createElement('style');
  style.dataset.perfDebug = 'true';
  style.textContent = `
    #perf-debug {
      position: fixed;
      top: max(16px, env(safe-area-inset-top));
      right: max(16px, env(safe-area-inset-right));
      z-index: 9200;
      width: min(292px, calc(100vw - 32px));
      overflow: hidden;
      border: 1px solid rgba(226, 187, 127, .42);
      border-radius: 4px;
      color: #f4eee3;
      background: rgba(7, 8, 7, .88);
      box-shadow: 0 18px 60px rgba(0, 0, 0, .52);
      pointer-events: none;
      user-select: none;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    #perf-debug[hidden] { display: none; }
    #perf-debug .perf-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px 9px;
      border-bottom: 1px solid rgba(255, 255, 255, .1);
      color: #e2bb7f;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .18em;
    }
    #perf-debug .perf-state { color: #82d79a; letter-spacing: .1em; }
    #perf-debug[data-running="false"] .perf-state { color: #e6b767; }
    #perf-debug pre {
      margin: 0;
      padding: 11px 12px 10px;
      color: rgba(244, 238, 227, .9);
      font: 500 11px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
    }
    #perf-debug .perf-footer {
      padding: 7px 12px 8px;
      border-top: 1px solid rgba(255, 255, 255, .08);
      color: rgba(244, 238, 227, .42);
      font-size: 9px;
      letter-spacing: .13em;
    }
  `;
  document.head.append(style);

  const panel = document.createElement('aside');
  panel.id = 'perf-debug';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Performance debug information');
  panel.innerHTML = `
    <div class="perf-header">
      <span>PERFORMANCE DEBUG</span>
      <span class="perf-state">LIVE</span>
    </div>
    <pre></pre>
    <div class="perf-footer">⌘⇧D TO CLOSE</div>
  `;
  document.body.append(panel);

  const output = panel.querySelector('pre');
  const stateLabel = panel.querySelector('.perf-state');
  const samples = new Float32Array(SAMPLE_CAPACITY);
  let sampleCount = 0;
  let sampleCursor = 0;
  let enabled = false;
  let frameHandle = 0;
  let previousEngineTick = 0;
  let previousEngineFrame = 0;
  let lastUpdate = 0;
  let lastSnapshot = { enabled: false };

  const readSnapshot = () => {
    const frameTimes = Array.from(samples.subarray(0, sampleCount));
    const averageMs = frameTimes.length
      ? frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length
      : 0;
    const render = engine.ctx.peek('render');
    const rendererInfo = render?.renderer?.info;
    const physics = engine.ctx.peek('physics')?.stats;
    const ai = engine.ctx.peek('ai')?.stats;
    const player = engine.ctx.peek('player')?.stats;
    const audio = engine.ctx.peek('audio')?.stats;
    const heapBytes = performance.memory?.usedJSHeapSize;
    return {
      enabled,
      running: engine._running,
      fps: averageMs > 0 ? 1000 / averageMs : 0,
      frameMs: averageMs,
      p95Ms: percentile(frameTimes, 0.95),
      p99Ms: percentile(frameTimes, 0.99),
      frame: engine.time.frame,
      calls: rendererInfo?.render?.calls ?? 0,
      triangles: rendererInfo?.render?.triangles ?? 0,
      programs: rendererInfo?.programs?.length ?? 0,
      textures: rendererInfo?.memory?.textures ?? 0,
      geometries: rendererInfo?.memory?.geometries ?? 0,
      internalWidth: render?.screenSize?.width ?? 0,
      internalHeight: render?.screenSize?.height ?? 0,
      displayWidth: render?.displaySize?.width ?? 0,
      displayHeight: render?.displaySize?.height ?? 0,
      physicsMs: physics?.stepMs ?? 0,
      bodies: physics?.bodies ?? 0,
      awakeBodies: physics?.awake ?? 0,
      aliveAi: ai?.alive ?? 0,
      totalAi: ai?.agents ?? 0,
      playerSpeed: player?.speed ?? 0,
      audioVoices: audio?.voices ?? 0,
      audioState: audio?.contextState ?? 'none',
      heapMb: Number.isFinite(heapBytes) ? heapBytes / (1024 * 1024) : null,
      quality: engine.config.quality,
    };
  };

  const paint = () => {
    lastSnapshot = readSnapshot();
    panel.dataset.running = String(lastSnapshot.running);
    stateLabel.textContent = lastSnapshot.running ? 'LIVE' : 'PAUSED';
    const heap = lastSnapshot.heapMb === null ? '--' : `${fixed(lastSnapshot.heapMb, 0)} MB`;
    output.textContent = [
      `FPS          ${fixed(lastSnapshot.fps, 1)}`,
      `FRAME        ${fixed(lastSnapshot.frameMs, 1)} ms`,
      `P95 / P99    ${fixed(lastSnapshot.p95Ms, 1)} / ${fixed(lastSnapshot.p99Ms, 1)} ms`,
      `FRAME INDEX  ${lastSnapshot.frame}`,
      '',
      `DRAWS        ${lastSnapshot.calls}`,
      `TRIANGLES    ${lastSnapshot.triangles.toLocaleString()}`,
      `PROGRAMS     ${lastSnapshot.programs}`,
      `GPU MEMORY   ${lastSnapshot.textures} tex / ${lastSnapshot.geometries} geo`,
      `RESOLUTION   ${lastSnapshot.internalWidth}×${lastSnapshot.internalHeight}`,
      `DISPLAY      ${lastSnapshot.displayWidth}×${lastSnapshot.displayHeight}`,
      '',
      `PHYSICS      ${fixed(lastSnapshot.physicsMs, 2)} ms`,
      `BODIES       ${lastSnapshot.awakeBodies} awake / ${lastSnapshot.bodies}`,
      `AI           ${lastSnapshot.aliveAi} alive / ${lastSnapshot.totalAi}`,
      `PLAYER       ${fixed(lastSnapshot.playerSpeed, 2)} m/s`,
      `AUDIO        ${lastSnapshot.audioVoices} voices / ${lastSnapshot.audioState}`,
      `JS HEAP      ${heap}`,
      `QUALITY      ${String(lastSnapshot.quality).toUpperCase()}`,
    ].join('\n');
  };

  const tick = (now) => {
    if (!enabled) return;
    const engineFrame = engine.time.frame;
    if (engineFrame > previousEngineFrame) {
      if (previousEngineTick > 0) {
        const perFrameMs = (now - previousEngineTick) / (engineFrame - previousEngineFrame);
        if (perFrameMs > 0 && perFrameMs < 500) {
          samples[sampleCursor] = perFrameMs;
          sampleCursor = (sampleCursor + 1) % SAMPLE_CAPACITY;
          sampleCount = Math.min(SAMPLE_CAPACITY, sampleCount + 1);
        }
      }
      previousEngineTick = now;
      previousEngineFrame = engineFrame;
    }
    if (now - lastUpdate >= UPDATE_INTERVAL_MS) {
      lastUpdate = now;
      paint();
    }
    frameHandle = requestAnimationFrame(tick);
  };

  const toggle = (force) => {
    const next = typeof force === 'boolean' ? force : !enabled;
    if (next === enabled) return enabled;
    enabled = next;
    panel.hidden = !enabled;
    if (enabled) {
      sampleCount = 0;
      sampleCursor = 0;
      previousEngineTick = 0;
      previousEngineFrame = engine.time.frame;
      lastUpdate = 0;
      paint();
      frameHandle = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      lastSnapshot = { ...lastSnapshot, enabled: false };
    }
    return enabled;
  };

  const onKeyDown = (event) => {
    if (event.code !== 'KeyD' || !event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggle();
  };
  addEventListener('keydown', onKeyDown, true);

  const api = {
    get enabled() { return enabled; },
    toggle,
    snapshot() { return { ...lastSnapshot, enabled }; },
    dispose() {
      cancelAnimationFrame(frameHandle);
      removeEventListener('keydown', onKeyDown, true);
      panel.remove();
      style.remove();
      if (window.__PERF_DEBUG__ === api) delete window.__PERF_DEBUG__;
    },
  };
  window.__PERF_DEBUG__ = api;
  return api;
}
