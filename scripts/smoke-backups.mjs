import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import JSZip from 'jszip';
import { buildInsights } from '../public/insights.js';
import { stopProcess } from '../server/process.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'data','checks',`backup-${Date.now()}`),id=randomUUID();
const projects=path.join(directory,'projects'),media=path.join(directory,'media',id);
await fs.mkdir(projects,{recursive:true});await fs.mkdir(media,{recursive:true});
const demo=JSON.parse(await fs.readFile(path.join(root,'public/demo/project.json'),'utf8'));
const project={...demo,id,isDemo:false,name:'Kiểm tra sao lưu — tiếng Việt',notes:[{id:'backup-note',time:18.75,text:'Giữ mốc thời gian, xuống dòng\nvà tiếng Việt: ă â đ ê ô ơ ư.'}],
  words:[{text:'Welcome',start:0,end:.5,probability:.95}],turns:[{start:0,end:5,speaker:'s1'}],transcriptEdited:true,model:'tiny'};
project.insights=buildInsights(project);
await fs.writeFile(path.join(projects,`${id}.json`),JSON.stringify(project));
for(const role of ['original','source','playback','clean'])await fs.copyFile(path.join(root,'public/demo',demo.files[role]),path.join(media,demo.files[role]));
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const base=`http://127.0.0.1:${port}`,json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let server,logs='';
async function boot(){
  server=spawn(process.execPath,['server/index.mjs'],{cwd:root,windowsHide:true,env:{...process.env,PORT:String(port),AUDIO_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',chunk=>{logs+=chunk;});server.stderr.on('data',chunk=>{logs+=chunk;});
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){try{if((await fetch(`${base}/api/health`)).ok)return;}catch{}if(server.exitCode!==null)throw new Error(logs);await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Server did not start. '+logs);
}
async function kill(){const old=server;if(!old)return;await stopProcess(old);if(old.exitCode===null&&old.signalCode===null)await new Promise(resolve=>old.once('close',resolve));server=null;}
async function api(url,init={}){const res=await fetch(base+url,init),body=await res.json();if(!res.ok)throw Object.assign(new Error(body.error),{status:res.status});return body;}
async function inspect(bytes){const form=new FormData();form.append('backup',new Blob([bytes]),'test.audiokit.zip');return api('/api/backups/inspect',{method:'POST',body:form});}
async function discard(token){const res=await fetch(`${base}/api/backups/${token}`,{method:'DELETE'});assert.equal(res.status,204);}
try{
  await boot();
  const before=await fs.readFile(path.join(projects,`${id}.json`));
  const prepared=await api(`/api/projects/${id}/backup`,json({}));
  const response=await fetch(base+prepared.url);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/zip/);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-disposition'),/filename\*=UTF-8''/);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,prepared.bytes);
  const archive=path.join(directory,'round-trip.audiokit.zip');await fs.writeFile(archive,bytes);
  assert.deepEqual(await fs.readFile(path.join(projects,`${id}.json`)),before,'Backup must not modify its source.');
  const zip=await JSZip.loadAsync(bytes),manifest=JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(Object.keys(zip.files).length,6);
  for(const record of manifest.files){const actual=await zip.file(record.path).async('nodebuffer');assert.equal(hash(actual),record.sha256);assert.equal(actual.length,record.bytes);}
  let review=await inspect(bytes);assert.equal(review.status,'duplicate');assert.equal(review.reason,'same');await discard(review.token);
  // Move only this script's fixture metadata aside to emulate a second computer.
  const target=path.resolve(projects,`${id}.json`);assert.equal(path.dirname(target),path.resolve(projects));
  await fs.rename(target,path.join(directory,'source-fixture.json'));
  review=await inspect(bytes);assert.equal(review.status,'new');
  let result=await api(`/api/backups/${review.token}/restore`,json({mode:'restore'}));assert.equal(result.status,'restored');assert.equal(result.project.id,id);
  assert.equal(result.project.backupOrigin,undefined);assert.equal(result.project.words,undefined);assert.equal(result.project.files,undefined);
  assert.deepEqual(result.project.notes,project.notes);assert.deepEqual(result.project.insights,project.insights);
  const stored=JSON.parse(await fs.readFile(target,'utf8'));assert.deepEqual(stored.words,project.words);assert.deepEqual(stored.turns,project.turns);
  for(const role of ['original','source','playback','clean'])assert.deepEqual(await fs.readFile(path.join(media,stored.files[role])),await fs.readFile(path.join(root,'public/demo',demo.files[role])));
  const original=await fetch(`${base}/api/projects/${id}/audio/download`);assert.equal(original.status,200);
  const range=await fetch(`${base}/api/projects/${id}/audio/clean`,{headers:{Range:'bytes=0-255'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,256);
  result=await api(`/api/backups/${review.token}/restore`,json({mode:'restore'}));assert.equal(result.status,'duplicate');assert.equal((await api('/api/projects')).length,1);await discard(review.token);
  await kill();await boot();review=await inspect(bytes);assert.equal(review.status,'duplicate');await discard(review.token);
  // A separately exported snapshot with the same project ID must never replace local edits.
  const edited={...project,name:'Snapshot mới — có ghi chú khác',notes:[{id:'n2',time:3.5,text:'Bản khác trong ZIP.'}]};
  await fs.writeFile(target,JSON.stringify(edited));
  const conflictFile=await api(`/api/projects/${id}/backup`,json({})),conflictBytes=Buffer.from(await(await fetch(base+conflictFile.url)).arrayBuffer());
  await fs.writeFile(target,JSON.stringify(project));
  review=await inspect(conflictBytes);assert.equal(review.status,'conflict');
  const blocked=await api(`/api/backups/${review.token}/restore`,json({mode:'restore'}));assert.equal(blocked.status,'conflict');assert.equal((await api('/api/projects')).length,1);
  result=await api(`/api/backups/${review.token}/restore`,json({mode:'copy'}));assert.equal(result.status,'restored');assert.notEqual(result.project.id,id);
  assert.equal((await api(`/api/projects/${id}`)).name,project.name);assert.deepEqual(result.project.notes,edited.notes);await discard(review.token);
  review=await inspect(conflictBytes);assert.equal(review.status,'duplicate');assert.equal(review.existing.id,result.project.id);await discard(review.token);
  const invalid=new FormData();invalid.append('backup',new Blob(['not a zip']),'broken.zip');
  await assert.rejects(api('/api/backups/inspect',{method:'POST',body:invalid}),error=>error.status===400);
  const corrupt=await JSZip.loadAsync(bytes);corrupt.file('audio/source.wav',Buffer.from('tampered'),{createFolders:false});
  await assert.rejects(inspect(await corrupt.generateAsync({type:'nodebuffer'})),error=>error.status===400);
  // Even a self-consistent manifest cannot turn non-audio into a trusted project.
  const signed=await JSZip.loadAsync(bytes),signedManifest=JSON.parse(await signed.file('manifest.json').async('string')),record=signedManifest.files.find(item=>item.role==='source');
  const junk=Buffer.from('This is not PCM audio.');signed.file(record.path,junk,{createFolders:false});record.bytes=junk.length;record.sha256=hash(junk);
  const canonical=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);
  signedManifest.fingerprint=hash(canonical([...signedManifest.files].sort((a,b)=>a.role.localeCompare(b.role))));signed.file('manifest.json',JSON.stringify(signedManifest));
  await assert.rejects(inspect(await signed.generateAsync({type:'nodebuffer'})),error=>error.status===400&&/âm thanh/.test(error.message));
  const outside=await fetch(`${base}/api/projects/${id}/backup`,{...json({}),headers:{'Content-Type':'application/json',Origin:'https://outside.example'}});assert.equal(outside.status,403);
  assert.equal((await api('/api/projects')).length,2);
  const resultData={result:'passed',directory,sourceProjectId:id,restoredCopyId:result.project.id,archiveBytes:bytes.length,
    checked:['native streamed download','Unicode filename','full project and all audio byte equality','private AI state','timestamp preservation',
      'source unchanged','duplicate detection','restart idempotence','conflict copy','no overwrite','audio playback and Range','malformed/corrupt archive rejection','origin']};
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(resultData,null,2));console.log(JSON.stringify(resultData,null,2));
}finally{await kill();await fs.writeFile(path.join(directory,'server.log'),logs);}
