#!/usr/bin/env node
// Re-encode original tab recordings without recapture; retain exact range and real audio.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [locale,...rangeArgs]=process.argv.slice(2);
if(!locale || !rangeArgs.length || rangeArgs.length%2) throw new Error('Usage: node tools/localization-video-render.mjs LOCALE START END [START END]');
const ranges=[];
for(let i=0;i<rangeArgs.length;i+=2){
  const start=Number(rangeArgs[i]),end=Number(rangeArgs[i+1]);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) throw new Error('Invalid source range.');
  ranges.push({start,end,speed:1});
}
const start=ranges[0].start,end=ranges.at(-1).end;
const root=path.resolve(import.meta.dirname,'..');
const raw=path.join(root,'evidence/localization-video/raw',locale);
const report=JSON.parse(fs.readFileSync(path.join(raw,'capture.json')));
const out=path.join(root,'assets/marketing/playdrop/locales',locale,'video/gameplay.mp4');
const review=path.join(root,'evidence/localization-video/review',locale);
for(const dir of [path.dirname(out),review]) fs.mkdirSync(dir,{recursive:true});
function command(name,args){const result=spawnSync(name,args,{encoding:'utf8',maxBuffer:20*1024*1024});if(result.status!==0) throw new Error(`${name} failed: ${result.stderr.slice(-2000)}`);return result;}
const filters=ranges.map((range,i)=>`[0:v]trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS,fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p[v${i}];[0:a]atrim=start=${range.start}:end=${range.end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${range.end-range.start}[a${i}]`);
filters.push(ranges.map((_,i)=>`[v${i}][a${i}]`).join('')+`concat=n=${ranges.length}:v=1:a=1[v][a]`);
command('ffmpeg',['-y','-v','error','-i',report.source,'-filter_complex',filters.join(';'),'-map','[v]','-map','[a]','-c:v','libx264','-preset','medium','-crf','28','-threads','2','-r','30','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart','-shortest',out]);
const probe=JSON.parse(command('ffprobe',['-v','error','-show_format','-show_streams','-of','json',out]).stdout);
const video=probe.streams.find(s=>s.codec_type==='video'),audio=probe.streams.find(s=>s.codec_type==='audio');
if(video.width!==1920 || video.height!==1080 || video.r_frame_rate!=='30/1' || video.codec_name!=='h264' || video.pix_fmt!=='yuv420p' || video.sample_aspect_ratio!=='1:1' || audio?.codec_name!=='aac' || audio.channels!==2 || audio.sample_rate!=='48000') throw new Error('Export format mismatch.');
const checked=command('ffmpeg',['-hide_banner','-i',out,'-vf','blackdetect=d=0.1:pix_th=0.03','-af','volumedetect','-f','null','-']);
if(checked.stderr.includes('black_start:')) throw new Error('Black interval found in final.');
const maxVolume=Number(checked.stderr.match(/max_volume: ([-\d.]+) dB/)?.[1]);
if(!Number.isFinite(maxVolume)||maxVolume < -45) throw new Error('Real audio missing or inaudible.');
const duration=Number(probe.format.duration),count=Math.ceil(duration*2),rows=Math.ceil(count/5);
command('ffmpeg',['-y','-v','error','-i',out,'-vf',`fps=2,scale=384:216,tile=5x${rows}`,'-frames:v','1',path.join(review,'timeline.jpg')]);
for(const [name,time] of [['first',0],['poster',Math.min(2,duration/2)],['last',Math.max(0,duration-0.08)]]) command('ffmpeg',['-y','-v','error','-ss',String(time),'-i',out,'-frames:v','1',path.join(review,`${name}.png`)]);
const selectedRows=rows=>{
  let offset=0;
  return ranges.flatMap((range,segment)=>{const selected=rows.filter(i=>i.time>=range.start&&i.time<=range.end).map(i=>({...i,outputTime:offset+i.time-range.start,segment}));offset+=range.end-range.start;return selected;});
};
const inputs=selectedRows(report.inputs);
let offset=0;const cuts=ranges.slice(0,-1).map(range=>offset+=range.end-range.start);
const cueFrames=[...new Set([...inputs.map(i=>Math.round(i.outputTime*30)),...cuts.flatMap(t=>[Math.round(t*30)-1,Math.round(t*30),Math.round(t*30)+1])])].sort((a,b)=>a-b);
if(cueFrames.length) command('ffmpeg',['-y','-v','error','-i',out,'-vf',`select=${cueFrames.map(n=>`eq(n\\,${n})`).join('+')},scale=384:216,tile=5x${Math.ceil(cueFrames.length/5)}`,'-frames:v','1',path.join(review,'inputs.jpg')]);
command('ffmpeg',['-y','-v','error','-ss',String(start+Math.min(2,duration/2)),'-i',report.source,'-frames:v','1',path.join(review,'source-poster.png')]);
const selected=selectedRows(report.timeline);
if(selected.some(s=>s.state.mode!=='playing')) throw new Error('Selected footage contains non-gameplay state.');
const manifest={locale,file:path.relative(root,out),source:report.source,runtimeHash:report.runtimeHash,ranges,cutTimes:cuts,speed:1,crop:'none',scale:'Uniform 1.5x from1280x720 complete browser game surface including DOM HUD',inputs,events:selectedRows(report.events),firstState:selected[0]?.state,lastState:end>report.timeline.at(-1).time?report.final:selected.at(-1)?.state,duration,bytes:Number(probe.format.size),encoder:{codec:'h264',preset:'medium',crf:28,width:video.width,height:video.height,fps:video.r_frame_rate,sar:video.sample_aspect_ratio},audio:{codec:audio.codec_name,sampleRate:audio.sample_rate,channels:audio.channels,maxVolumeDb:maxVolume},fullDecode:'passed',blackIntervals:0,captions:'No overlays; literal localized game interface',protectedArt:'No identity art used or modified',browserErrors:report.errors};
fs.writeFileSync(path.join(review,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({locale,file:out,duration,bytes:manifest.bytes,maxVolume,review}));
