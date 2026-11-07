import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';
const root = process.cwd();
const directory = path.join(root,'public/demo');
const scratch = path.join(root,'data/demo-build');
const segments = JSON.parse((await fs.readFile(path.join(scratch,'segments.json'),'utf8')).replace(/^\uFEFF/,''));
const durations = segments.map(segment => Number(JSON.parse(execFileSync(ffprobe.path,['-v','error','-show_format','-of','json',segment.file], { windowsHide: true })).format.duration));
const args = ['-v','error','-y'];
for (const segment of segments) args.push('-i',segment.file);
args.push('-filter_complex', `${segments.map((_,index)=>`[${index}:a]aformat=sample_rates=16000:channel_layouts=mono,apad=pad_dur=0.45[a${index}]`).join(';')};${segments.map((_,index)=>`[a${index}]`).join('')}concat=n=${segments.length}:v=0:a=1[voice]`, '-map','[voice]',path.join(scratch,'voice.wav'));
execFileSync(ffmpeg,args,{ windowsHide:true });
const duration=durations.reduce((sum,value)=>sum+value+.45,0);
execFileSync(ffmpeg,['-v','error','-y','-i',path.join(scratch,'voice.wav'),'-f','lavfi','-i',`anoisesrc=d=${duration}:c=pink:a=0.025:r=16000`,'-filter_complex','[0:a][1:a]amix=inputs=2:normalize=0','-c:a','pcm_s16le',path.join(directory,'original.wav')],{windowsHide:true});
await fs.copyFile(path.join(directory,'original.wav'),path.join(directory,'source.wav'));
execFileSync(ffmpeg,['-v','error','-y','-i',path.join(directory,'original.wav'),'-c:a','libmp3lame','-q:a','3',path.join(directory,'playback.mp3')],{windowsHide:true});
execFileSync(ffmpeg,['-v','error','-y','-i',path.join(directory,'original.wav'),'-af','highpass=f=70,afftdn=nr=12:nf=-30:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11','-c:a','libmp3lame','-q:a','2',path.join(directory,'clean.mp3')],{windowsHide:true});
const python=path.join(root,'.venv/Scripts/python.exe');
const inspectInput=path.join(scratch,'inspect.json');
await fs.writeFile(inspectInput,JSON.stringify({mode:'inspect',file:path.join(directory,'source.wav')}));
const inspection=execFileSync(python,['server/worker.py','--input',inspectInput,'--data',path.join(root,'data')],{windowsHide:true,encoding:'utf8'});
const metrics=JSON.parse(inspection.trim().split('\n').at(-1)).result;
let start=0;
const transcript=segments.map((segment,index)=>{
  const line={id:`line-${index+1}`,time:Number(start.toFixed(3)),end:Number((start+durations[index]).toFixed(3)),speaker:segment.speaker,text:segment.text,confidence:null};
  start+=durations[index]+.45;
  return line;
});
const now=new Date().toISOString();
const demo={id:'demo',name:'Tập 12 — Xây thói quen sáng tạo',fileName:'creative-habits-demo.wav',duration,format:'WAV',sampleRate:16000,channels:1,size:(await fs.stat(path.join(directory,'original.wav'))).size,createdAt:now,updatedAt:now,language:'en',isDemo:true,
  processed:{noise:true,transcript:true,speakers:true},metrics,speakers:[{id:'s1',name:'Minh · host',color:'#7472e9'},{id:'s2',name:'Lan · khách mời',color:'#ec8068'}],transcript,words:[],notes:[
    {id:'note-1',time:transcript[1].time,text:'Bắt đầu thật nhỏ — ý chính cho phần mở đầu.'},
    {id:'note-2',time:transcript[3].time,text:'Quote hay: “An appointment with yourself.”'},
    {id:'note-3',time:transcript[5].time,text:'Cắt đoạn này thành clip: một bản nháp chưa hoàn hảo vẫn tốt hơn trang giấy trắng.'}],
  files:{original:'original.wav',source:'source.wav',playback:'playback.mp3',clean:'clean.mp3'}};
await fs.writeFile(path.join(directory,'project.json'),JSON.stringify(demo,null,2));
console.log(`Created playable two-voice demo: ${duration.toFixed(1)} seconds.`);
