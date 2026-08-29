import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  return match ? [match[1], match[2] ?? true] : [arg, true];
}));
const port = Number(args.port ?? 4173);
const b = await chromium.launch({ headless: true, args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio','--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
await p.goto(`http://127.0.0.1:${port}/`, {waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__READY__===true',null,{timeout:60000});
if (await p.locator('#boot[data-state="ready"]').isVisible()) {
  await p.locator('#boot').click({ position: { x: 20, y: 20 } });
  await p.waitForFunction('window.__PLAYDROP_STARTED__ === true && window.__ENGINE__?._running === true');
}
const snap = () => p.evaluate(()=>{const e=window.__ENGINE__,c=e.camera.position;return{
  pos:[+c.x.toFixed(2),+c.y.toFixed(2),+c.z.toFixed(2)],
  yaw:+e.camera.rotation.y.toFixed(3), frame:e.time.frame,
  systems:Object.keys(e.ctx).length}});
const a = await snap();
const waitEngineFrames = count => p.evaluate(n => new Promise(resolve => {
  const target = window.__ENGINE__.time.frame + n;
  const tick = () => window.__ENGINE__.time.frame >= target ? resolve() : requestAnimationFrame(tick);
  requestAnimationFrame(tick);
}), count);
// hold W for ~40 frames
await p.evaluate(()=>{const e=window.__ENGINE__; e.input.enabled=true; e.input.frozen=false;
  e.ctx.peek('player')?.setControlEnabled?.(true);});
await p.keyboard.down('w');
await waitEngineFrames(45);
await p.keyboard.up('w');
const bpos = await snap();
// fire a shot via the input layer
const fired = await p.evaluate(()=>{let n=0; const off=window.__ENGINE__.events.on('weapon:fire',()=>n++);
  window.__ENGINE__.input.down.add('Mouse0');
  const target = window.__ENGINE__.time.frame + 30;
  return new Promise(d=>{const t=()=>window.__ENGINE__.time.frame>=target?(window.__ENGINE__.input.down.delete('Mouse0'),off(),d(n)):requestAnimationFrame(t);requestAnimationFrame(t)})});
// count scene objects + check for NaN transforms
const health = await p.evaluate(()=>{const e=window.__ENGINE__; let n=0,nan=0; const nanObjects=[];
  let vm=0, visibleViewMeshes=0;
  for (const [name, scene] of [['world',e.scene],['viewmodel',e.viewScene]]) scene.traverse(o=>{
    if(name==='world') n++; else vm++;
    if(![...o.position,...o.quaternion,...o.matrixWorld.elements].every(Number.isFinite)) {
      nan++; nanObjects.push({scene:name,name:o.name,type:o.type,visible:o.visible});
    }
  });
  e.viewScene.traverseVisible(o=>{if(o.isMesh) visibleViewMeshes++;});
  return {worldObjects:n, viewmodelObjects:vm, visibleViewMeshes, nanTransforms:nan, nanObjects}});
const moved = Math.hypot(bpos.pos[0]-a.pos[0], bpos.pos[2]-a.pos[2]);
const textState = await p.evaluate(() => window.render_game_to_text?.() ?? null);
if (args.screenshot) await p.screenshot({path:String(args.screenshot)});
console.log(JSON.stringify({ready:true, started:await p.evaluate(()=>window.__PLAYDROP_STARTED__), startPos:a.pos, afterW:bpos.pos, metresMoved:+moved.toFixed(2),
  framesAdvanced:bpos.frame-a.frame, fireEvents:fired, ...health, textState:textState ? JSON.parse(textState) : null, errors:errs.slice(0,8)},null,2));
await b.close();
assert(moved > 0.5, 'player must move through real input');
assert(fired > 0, 'player must fire through real input');
assert.equal(health.nanTransforms, 0, 'world and viewmodel transforms must all be finite');
assert(health.visibleViewMeshes > 0, 'the first-person weapon scene must contain visible meshes');
assert.deepEqual(errs, [], 'game must not emit browser errors');
