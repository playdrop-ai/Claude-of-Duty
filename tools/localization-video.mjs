#!/usr/bin/env node
// External normal-play recorder. No capture mode, staged enemies, gameplay edits or synthetic audio.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installLocalizationHost } from './localization-host.mjs';

const locale = process.argv[2];
if (!['en','fr','de','es','pt-BR','id','ja','ko','zh-Hans','zh-Hant'].includes(locale)) throw new Error('Pass one supported locale.');
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'evidence/localization-video/raw', locale);
if (fs.existsSync(path.join(source, 'capture.json'))) throw new Error(`Existing capture preserved: ${source}`);
fs.mkdirSync(source, { recursive: true });
const width = 1280, height = 720;
const runtimeHash = createHash('sha256').update(fs.readFileSync(path.join(root,'dist/index.html')));
for (const name of fs.readdirSync(path.join(root,'dist/assets')).sort()) runtimeHash.update(fs.readFileSync(path.join(root,'dist/assets',name)));
const browser = await chromium.launch({ headless:false, args:[
  '--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization',
  '--force-color-profile=srgb','--force-device-scale-factor=1','--hide-scrollbars',
  '--auto-accept-this-tab-capture','--autoplay-policy=no-user-gesture-required',
] });
const context=await browser.newContext({ viewport:{width,height}, deviceScaleFactor:1 });
await installLocalizationHost(context,{locale,phase:'play',audioEnabled:true});
const page=await context.newPage();
const errors=[];
page.on('pageerror', e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
try {
  await page.goto(`${process.env.VIDEO_URL || 'http://127.0.0.1:4173/'}?playdrop_channel=prod`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__READY__===true && document.querySelector('#boot')?.dataset.state==='ready',null,{timeout:180000});
  await page.keyboard.press('Shift'); // A real gesture unlocks the game's live audio without starting play.
  const settings=await page.evaluate(async()=>{
    const display=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:30,width:1280,height:720},audio:false,preferCurrentTab:true,selfBrowserSurface:'include'});
    const track=display.getVideoTracks()[0];
    if(track.getSettings().displaySurface!=='browser') throw new Error('Recorder must capture only this browser tab.');
    const audio=window.__ENGINE__.ctx.get('audio');
    if(!audio.running || !audio.actx || !audio.mixer) throw new Error('Real game audio did not start.');
    const destination=audio.actx.createMediaStreamDestination();
    audio.mixer.masterGain.connect(destination);
    const stream=new MediaStream([track,...destination.stream.getAudioTracks()]);
    const chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8,opus',videoBitsPerSecond:14000000,audioBitsPerSecond:192000});
    recorder.ondataavailable=e=>{if(e.data.size) chunks.push(e.data)};
    window.__externalVideo={display,destination,recorder,chunks,settings:track.getSettings()};
    return track.getSettings();
  });
  if(settings.width!==width || settings.height!==height || settings.frameRate!==30) throw new Error(`Unexpected tab geometry: ${JSON.stringify(settings)}`);
  await page.evaluate(()=>{window.__externalVideo.start=performance.now();window.__externalVideo.recorder.start(1000);});
  await page.locator('#boot').click({position:{x:20,y:20}});
  await page.waitForFunction(()=>window.__PLAYDROP_STARTED__ && window.__ENGINE__._running);
  await page.evaluate(()=>{
    const e=window.__ENGINE__, input=e.input, sys=id=>e.ctx.peek(id), cam=e.camera;
    const V=cam.position.constructor, forward=new V(), point=new V(), direction=new V();
    const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
    const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
    const record=window.__externalVideo;
    record.events=[];record.timeline=[];record.inputs=[];record.startPlaying=performance.now()-record.start;
    const timestamp=()=> (performance.now()-record.start)/1000;
    for(const name of ['weapon:fire','weapon:reload','actor:death','damage:taken','wave:complete']) e.events.on(name,p=>{
      record.events.push({time:timestamp(),name,weapon:p?.weapon,actor:p?.actor?.id??p?.target?.id??null});
    });
    let held=new Set(), target=null, lastSample=0;
    const hold=codes=>{
      for(const code of codes) if(!held.has(code)) input._pendingDown.add(code);
      for(const code of held) if(!codes.has(code)) input._pendingUp.add(code);
      if([...codes].join()!==[...held].join()) record.inputs.push({time:timestamp(),keys:[...codes]});
      held=codes;
    };
    const aim=()=>{
      if(record.stopDriver){hold(new Set());return;}
      const state=JSON.parse(window.render_game_to_text());
      if(state.mode!=='playing'){hold(new Set());record.endReason=state.mode;return;}
      const t=timestamp(), alive=sys('ai').agents.filter(a=>a.alive), phys=sys('physics');
      forward.set(0,0,-1).applyQuaternion(cam.quaternion);
      let selected=null,best=-Infinity;
      for(const agent of alive){
        point.set(agent.position.x,agent.position.y+1.35,agent.position.z);
        const distance=cam.position.distanceTo(point);
        direction.copy(point).sub(cam.position).normalize();
        const facing=direction.dot(forward);
        if(distance>55 || facing<0.05 || !phys.lineOfSight(cam.position,point,phys.MASK.SIGHT)) continue;
        const score=facing*4-distance*0.035+(agent===target?0.7:0);
        if(score>best){best=score;selected=agent;}
      }
      target=selected;
      const keys=new Set();
      if(target){
        point.set(target.position.x,target.position.y+1.4,target.position.z);
        const dx=point.x-cam.position.x,dy=point.y-cam.position.y,dz=point.z-cam.position.z;
        const distance=Math.hypot(dx,dy,dz);
        const yaw=Math.atan2(-forward.x,-forward.z),pitch=Math.asin(clamp(forward.y,-1,1));
        const yawError=wrap(Math.atan2(-dx,-dz)-yaw),pitchError=Math.asin(clamp(dy/distance,-1,1))-pitch;
        const sens=e.config.sensitivity*(1+(e.config.adsSensScale-1)*sys('player').adsAmount);
        input._rawLook.x+=clamp(-yawError*0.15/sens,-90,90);
        input._rawLook.y+=clamp(-pitchError*0.15/sens,-90,90);
        keys.add('Mouse2');
        if(Math.hypot(yawError,pitchError)<0.065) keys.add('Mouse0');
        if(distance>23) keys.add('KeyW');
        if(t>3) keys.add(Math.floor(t/2.5)%2?'KeyD':'KeyA');
      }else{
        keys.add('KeyW');
        input._rawLook.x+=Math.sin(t*0.4)*1.7;
      }
      if(state.weapon.ammo===0) keys.add('KeyR');
      hold(keys);
      if(t-lastSample>=0.1){lastSample=t;record.timeline.push({time:t,frame:e.time.frame,position:cam.position.toArray(),state,target:target?.id??null});}
      requestAnimationFrame(aim);
    };
    requestAnimationFrame(aim);
  });
  await page.waitForTimeout(24000);
  const result=await page.evaluate(async()=>{
    const r=window.__externalVideo;r.stopDriver=true;
    await new Promise(resolve=>{r.recorder.onstop=resolve;r.recorder.stop();});
    r.display.getTracks().forEach(track=>track.stop());
    window.__ENGINE__.ctx.get('audio').mixer.masterGain.disconnect(r.destination);
    const blob=new Blob(r.chunks,{type:r.recorder.mimeType});
    const bytes=new Uint8Array(await blob.arrayBuffer());
    let binary='';for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return {base64:btoa(binary),timeline:r.timeline,events:r.events,inputs:r.inputs,settings:r.settings,startPlaying:r.startPlaying,endReason:r.endReason??null,final:JSON.parse(window.render_game_to_text())};
  });
  const {base64,...report}=result;
  fs.writeFileSync(path.join(source,'source.webm'),Buffer.from(base64,'base64'));
  fs.writeFileSync(path.join(source,'capture.json'),JSON.stringify({locale,runtimeHash:runtimeHash.digest('hex'),source:path.join(source,'source.webm'),errors,...report},null,2)+'\n');
  await page.screenshot({path:path.join(source,'last.png')});
  console.log(JSON.stringify({locale,source,settings,errors,final:report.final,events:report.events.length}));
  if(errors.length) throw new Error('Browser errors recorded; raw take retained for inspection.');
} finally {await browser.close();}
