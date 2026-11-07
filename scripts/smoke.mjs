import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffprobe from '@ffprobe-installer/ffprobe';
import { insightsAreCurrent } from '../public/insights.js';
const base=process.env.AUDIO_URL||'http://127.0.0.1:4188';
const ai=process.argv.includes('--ai');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(route,options){const response=await fetch(base+route,options);const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
await api('/api/health');
const file=await fs.readFile('public/demo/original.wav');const form=new FormData();form.append('audio',new Blob([file],{type:'audio/wav'}),'smoke-creative-habits.wav');
const project=await api('/api/projects',{method:'POST',body:form});assert.ok(project.duration>60);assert.ok(project.metrics.peaks.length>100);assert.equal(project.transcript.length,0);
const note={id:'smoke-note',time:12.345,text:'Ghi chú thử nghiệm — giữ Unicode tiếng Việt.'};
await api(`/api/projects/${project.id}`,json('PATCH',{notes:[note]}));
const restored=await api(`/api/projects/${project.id}`);assert.deepEqual(restored.notes,[note]);
let rejected=await fetch(base+`/api/projects/${project.id}`,json('PATCH',{notes:[{...note,time:99999}]}));assert.equal(rejected.status,400);
rejected=await fetch(base+'/api/demo/copy',{method:'POST',headers:{Origin:'https://unrelated.example'}});assert.equal(rejected.status,403);
const badForm=new FormData();badForm.append('audio',new Blob(['not audio']),'bad.wav');rejected=await fetch(base+'/api/projects',{method:'POST',body:badForm});assert.ok(rejected.status>=400);
const range=await fetch(base+project.audioUrl,{headers:{Range:'bytes=0-1023'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,1024);
const job=await api(`/api/projects/${project.id}/jobs`,json('POST',{kind:ai?'all':'noise',model:'base',language:'en',numSpeakers:2}));
const started=Date.now();let status=job;
while(status.status==='running'){
  if(Date.now()-started>20*60*1000)throw new Error('Smoke timed out.');
  await sleep(1500);status=await api(`/api/jobs/${job.id}`);
}
assert.equal(status.status,'completed',status.message);
const result=await api(`/api/projects/${project.id}`);assert.equal(result.processed.noise,true);assert.deepEqual(result.notes,[note]);
const clean=await fetch(base+`/api/projects/${project.id}/audio/clean?download=1`);assert.equal(clean.status,200);assert.match(clean.headers.get('content-disposition'),/attachment/);
await fs.mkdir('data/checks',{recursive:true});const target='data/checks/clean.mp3';await fs.writeFile(target,Buffer.from(await clean.arrayBuffer()));
const media=JSON.parse(execFileSync(ffprobe.path,['-v','error','-show_format','-show_streams','-of','json',target],{windowsHide:true}));
assert.ok(media.streams.some(stream=>stream.codec_type==='audio'));assert.ok(Math.abs(Number(media.format.duration)-project.duration)<.2);
if(ai){
  assert.equal(insightsAreCurrent(result),true);assert.ok(result.insights.summary.length);assert.ok(result.insights.chapters.length);assert.ok(result.insights.highlights.length);
  assert.ok(result.transcript.length>5);assert.equal(result.speakers.length,2);assert.equal(result.language,'en');
  assert.match(result.transcript.map(line=>line.text).join(' '),/creative habit/i);
  assert.equal(new Set(result.transcript.map(line=>line.speaker)).size,2);
  let previous=-1;for(const line of result.transcript){assert.ok(line.time>=previous);assert.ok(line.end>line.time);assert.ok(line.end<=result.duration+.01);previous=line.time;}
}
console.log(JSON.stringify({result:'passed',projectId:project.id,ai,lines:result.transcript.length,speakers:result.speakers.length,duration:result.duration},null,2));
