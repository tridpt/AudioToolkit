import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import yazl from 'yazl';
import { BackupStore, createBackup, inspectBackup, portableProject } from '../server/backup.mjs';
import { atomicQueueWrite } from '../server/queue.mjs';
import { buildInsights } from '../public/insights.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const notFound = () => Object.assign(new Error('not found'), { status: 404 });
async function fixture(t, { clean = true, demo = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audiokit-backup-'));
  t.after(async () => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('audiokit-backup-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const media = path.join(directory, 'source'); await fs.mkdir(media);
  const originals = { original: Buffer.from('original audio bytes'), source: Buffer.from('16k mono audio'), playback: Buffer.from('playable mp3'), clean: Buffer.from('clean mp3') };
  const files = { original: 'original.wav', source: 'source.wav', playback: 'playback.mp3', clean: 'clean.mp3' };
  for (const role of ['original','source','playback',...(clean?['clean']:[])]) await fs.writeFile(path.join(media, files[role]), originals[role]);
  const project = { id: demo ? 'demo' : randomUUID(), name: 'Bài giảng — tiếng Việt', fileName: 'bài giảng.wav', duration: 12,
    format: 'WAV', sampleRate: 48000, channels: 2, size: originals.original.length, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z',
    language: 'vi', isDemo: demo, processed: { noise: clean, transcript: true, speakers: true }, metrics: { peaks: [.1,.8,.2], peakDb: -2, rmsDb: -20 },
    speakers: [{ id:'s1',name:'Cô Hương',color:'#7472e9' }], transcript: [{id:'a',time:1.25,end:8.75,speaker:'s1',text:'Giữ nguyên tiếng Việt: ă â đ ê ô ơ ư.\nDòng thứ hai.',confidence:94}],
    notes: [{id:'n1',time:2.5,text:'Ghi chú tại vị trí đang nghe.'}], words: [{text:'Giữ nguyên',start:1.25,end:2,probability:.94}],
    turns: [{start:1,end:10,speaker:'s1'}], model:'tiny',transcriptEdited:true, files,
    queueCheckpoint:{itemId:randomUUID(),completed:['noise','transcript','speakers']}, backupOrigin:{fingerprint:'f'.repeat(64),sourceId:randomUUID()} };
  project.insights = buildInsights(project);
  const archive = path.join(directory, 'archive.zip');
  const result = await createBackup(project, { mediaFile:role=>path.join(media,files[role]), target:archive });
  let inspectIndex = 0;
  const inspect = async (target = archive) => { const dest=path.join(directory,`inspect-${++inspectIndex}`);await fs.mkdir(dest);return inspectBackup(target,dest); };
  const destination = path.join(directory, 'destination'), projectsDir=path.join(destination,'projects'), mediaDir=path.join(destination,'media');
  await fs.mkdir(projectsDir,{recursive:true});await fs.mkdir(mediaDir,{recursive:true});
  const config = { directory:path.join(destination,'tmp'),projectsDir,mediaDir,
    loadProject:async id=>{try{return JSON.parse(await fs.readFile(path.join(projectsDir,`${id}.json`),'utf8'));}catch(error){if(error.code==='ENOENT')throw notFound();throw error;}},
    listProjects:async()=>Promise.all((await fs.readdir(projectsDir)).filter(name=>name.endsWith('.json')).map(async name=>JSON.parse(await fs.readFile(path.join(projectsDir,name),'utf8')))),
    persist:project=>atomicQueueWrite(path.join(projectsDir,`${project.id}.json`),project),
  };
  const store=new BackupStore(config);await store.init();
  const rewrite=async mutate=>{
    const zip=await JSZip.loadAsync(await fs.readFile(archive));await mutate(zip);
    for(const entry of Object.values(zip.files))if(entry.dir)delete zip.files[entry.name];
    const file=path.join(directory,`${randomUUID()}.zip`);await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));return file;
  };
  const rewriteProject=mutate=>rewrite(async zip=>{
    const metadata=JSON.parse(await zip.file('project.json').async('string'));mutate(metadata);
    const bytes=Buffer.from(canonical(metadata)),manifest=JSON.parse(await zip.file('manifest.json').async('string'));
    const record=manifest.files.find(item=>item.role==='project');record.bytes=bytes.length;record.sha256=digest(bytes);
    manifest.fingerprint=digest(canonical([...manifest.files].sort((a,b)=>a.role.localeCompare(b.role))));
    zip.file('project.json',bytes);zip.file('manifest.json',JSON.stringify(manifest));
  });
  return {directory,project,archive,result,originals,files,media,inspect,rewrite,rewriteProject,store,config,projectsDir,mediaDir};
}

test('backup round trip preserves audio bytes, Vietnamese, timings and private AI data without runtime state',async t=>{
  const f=await fixture(t),unpacked=await f.inspect();
  assert.equal(unpacked.manifest.format,'audio-toolkit-backup');assert.equal(unpacked.manifest.files.length,5);
  assert.deepEqual(unpacked.project,portableProject(f.project));
  assert.equal(unpacked.project.files,undefined);assert.equal(unpacked.project.queueCheckpoint,undefined);assert.equal(unpacked.project.backupOrigin,undefined);
  for(const role of ['original','source','playback','clean'])assert.deepEqual(await fs.readFile(path.join(unpacked.audio,unpacked.files[role])),f.originals[role]);
  assert.match(f.result.filename,/Bài giảng — tiếng Việt-sao-luu\.audiokit\.zip$/);
  const review=await f.store.inspect(f.archive);assert.equal(review.status,'new');
  const restored=await f.store.restore(review.token);assert.equal(restored.status,'restored');assert.equal(restored.project.id,f.project.id);
  assert.deepEqual(portableProject(restored.project),portableProject(f.project));assert.equal(restored.project.isDemo,false);
  assert.equal(restored.project.queueCheckpoint,undefined);assert.equal((await f.config.listProjects()).length,1);
});

test('unprocessed audio omits clean media and demo restores as a private UUID project',async t=>{
  const f=await fixture(t,{clean:false,demo:true});const data=await f.inspect();
  assert.equal(data.manifest.files.length,4);assert.equal(data.project.processed.noise,false);
  const review=await f.store.inspect(f.archive),first=await f.store.restore(review.token),again=await f.store.restore(review.token);
  assert.notEqual(first.project.id,'demo');assert.match(first.project.id,/^[0-9a-f-]{36}$/);
  assert.equal(first.project.isDemo,false);assert.equal(again.status,'duplicate');assert.equal(again.project.id,first.project.id);
});

test('identical local project opens existing, and a conflicting snapshot restores separately without overwriting',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.mediaDir,f.project.id));
  for(const [role,name]of Object.entries(f.files))await fs.copyFile(path.join(f.media,name),path.join(f.mediaDir,f.project.id,name));
  await f.config.persist(f.project);
  let review=await f.store.inspect(f.archive);assert.equal(review.status,'duplicate');assert.equal(review.reason,'same');
  await f.store.discard(review.token);
  const changed={...f.project,name:'Bản đang chỉnh sửa',notes:[{...f.project.notes[0],text:'Ghi chú mới hơn trên máy.'}]};
  await f.config.persist(changed);
  review=await f.store.inspect(f.archive);assert.equal(review.status,'conflict');
  const refused=await f.store.restore(review.token);assert.equal(refused.status,'conflict');assert.equal((await f.config.listProjects()).length,1);
  const restored=await f.store.restore(review.token,'copy');assert.notEqual(restored.project.id,f.project.id);
  assert.deepEqual(await f.config.loadProject(f.project.id),changed);
  const secondReview=await f.store.inspect(f.archive);assert.equal(secondReview.status,'duplicate');
  assert.equal(secondReview.existing.id,restored.project.id);assert.equal((await f.config.listProjects()).length,2);
});

test('concurrent restores and response retries are idempotent even after the restored copy has edits',async t=>{
  const f=await fixture(t),first=await f.store.inspect(f.archive),second=await f.store.inspect(f.archive);
  const result=await Promise.all([f.store.restore(first.token),f.store.restore(second.token)]);
  assert.deepEqual(result.map(item=>item.status),['restored','duplicate']);
  await f.config.persist({...result[0].project,name:'Chỉnh sửa sau khôi phục'});
  const retried=await f.store.restore(first.token);assert.equal(retried.status,'duplicate');assert.equal(retried.project.name,'Chỉnh sửa sau khôi phục');
  assert.equal((await f.config.listProjects()).length,1);
});

test('restore rechecks conflicts after preview and expires/discards temporary review files',async t=>{
  const f=await fixture(t),review=await f.store.inspect(f.archive);
  await f.config.persist({...f.project,name:'Tạo sau lúc xem trước'});
  const result=await f.store.restore(review.token);assert.equal(result.status,'conflict');assert.equal(result.review.existing.name,'Tạo sau lúc xem trước');
  await f.store.discard(review.token);assert.equal((await fs.readdir(f.store.directory)).length,0);
  await assert.rejects(f.store.restore(review.token),error=>error.status===410);
  const next=await f.store.inspect(f.archive);f.store.now=()=>Date.now()+31*60*1000;
  await f.store.cleanup();await assert.rejects(f.store.restore(next.token),error=>error.status===410);
});

test('a failed project commit exposes no partial project and retry reuses the stable destination',async t=>{
  const f=await fixture(t),review=await f.store.inspect(f.archive);let fail=true;
  f.store.persist=async project=>{if(fail)throw new Error('disk full');return f.config.persist(project);};
  await assert.rejects(f.store.restore(review.token),/disk full/);assert.deepEqual(await fs.readdir(f.mediaDir),[]);assert.deepEqual(await fs.readdir(f.projectsDir),[]);
  fail=false;const result=await f.store.restore(review.token);assert.equal(result.project.id,f.project.id);assert.equal(result.status,'restored');
});

test('corrupt audio or metadata and missing/extra files cannot be restored',async t=>{
  const f=await fixture(t);
  const badAudio=await f.rewrite(zip=>zip.file('audio/original.wav','modified audio bytes'));
  await assert.rejects(f.inspect(badAudio),/khớp|SHA-256/);
  const badJSON=await f.rewrite(zip=>zip.file('project.json','{broken'));
  await assert.rejects(f.inspect(badJSON),/SHA-256/);
  const missing=await f.rewrite(zip=>zip.remove('audio/source.wav'));await assert.rejects(f.inspect(missing),/khớp|ZIP/);
  const extra=await f.rewrite(zip=>zip.file('private.txt','unexpected'));await assert.rejects(f.inspect(extra),/ZIP|đường dẫn/);
  assert.equal((await f.config.listProjects()).length,0);
});

test('unsupported versions, unsafe metadata, invalid references and timestamps are rejected',async t=>{
  const f=await fixture(t);
  const version=await f.rewrite(async zip=>{const m=JSON.parse(await zip.file('manifest.json').async('string'));m.version=99;zip.file('manifest.json',JSON.stringify(m));});
  await assert.rejects(f.inspect(version));
  for(const mutation of [p=>{p.files={original:'../../private'};},p=>{p.notes[0].time=40;},p=>{p.transcript[0].speaker='missing';},p=>{p.words[0].start=-1;},p=>{p.id='../project';},p=>{p.backupOrigin={sourceId:'fake'};},p=>{p.insights.summary[0].end=99;},p=>{p.turns[0].end=99;},p=>{delete p.sampleRate;}]) {
    const invalid=await f.rewriteProject(mutation);await assert.rejects(f.inspect(invalid));
  }
});

async function rawZip(file,records) {
  const zip=new yazl.ZipFile(),chunks=[];
  const complete=new Promise((resolve,reject)=>{zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.once('end',resolve);zip.outputStream.once('error',reject);zip.on('error',reject);});
  for(const record of records)zip.addBuffer(Buffer.from(record.data||'x'),record.name,{mode:record.mode||0o100600});
  zip.end();await complete;await fs.writeFile(file,Buffer.concat(chunks));
}
test('archive duplicates, symlinks, traversal and dishonest expanded sizes fail before extraction',async t=>{
  const f=await fixture(t),names=['manifest.json','project.json','audio/original.wav','audio/source.wav','audio/playback.mp3'];
  const duplicate=path.join(f.directory,'duplicate.zip');await rawZip(duplicate,[...names.map(name=>({name})),{name:'project.json'}]);
  await assert.rejects(f.inspect(duplicate),/trùng/);
  const symlink=path.join(f.directory,'symlink.zip');await rawZip(symlink,names.map(name=>({name,mode:name==='audio/source.wav'?0o120777:0o100600})));
  await assert.rejects(f.inspect(symlink),/loại file/);
  const traversal=Buffer.from(await fs.readFile(f.archive));
  // Same-length raw filename mutation, including both local and central headers.
  const source=Buffer.from('audio/source.wav'),evil=Buffer.from('../xx/source.wav');
  let position=0;while((position=traversal.indexOf(source,position))!==-1){evil.copy(traversal,position);position+=source.length;}
  const traversalFile=path.join(f.directory,'traversal.zip');await fs.writeFile(traversalFile,traversal);await assert.rejects(f.inspect(traversalFile),/ZIP|đường dẫn/);
  const bomb=Buffer.from(await fs.readFile(f.archive));
  for(let at=0;at<bomb.length-46;at++)if(bomb.readUInt32LE(at)===0x02014b50&&bomb.subarray(at+46,at+62).toString()==='audio/source.wav'){bomb.writeUInt32LE(300*1024*1024,at+24);break;}
  const bombFile=path.join(f.directory,'oversized.zip');await fs.writeFile(bombFile,bomb);await assert.rejects(f.inspect(bombFile),/giới hạn|size|ZIP/);
});

test('busy worker and failed audio verification preserve projects and clean staged copies',async t=>{
  const f=await fixture(t),review=await f.store.inspect(f.archive);f.store.isBusy=()=>true;
  await assert.rejects(f.store.restore(review.token),error=>error.status===409);assert.equal((await f.config.listProjects()).length,0);
  await f.store.discard(review.token);f.store.validateAudio=async()=>{throw new Error('invalid audio');};
  await assert.rejects(f.store.inspect(f.archive),/invalid audio/);assert.deepEqual(await fs.readdir(f.store.directory),[]);
});

test('cancelling ZIP generation or inspection closes streams and removes incomplete temporary output',async t=>{
  const f=await fixture(t),controller=new AbortController(),target=path.join(f.directory,'cancelled.zip');
  await fs.writeFile(path.join(f.media,f.files.source),randomBytes(4*1024*1024));
  const watcher=watch(f.directory,(event,name)=>{if(String(name)==='cancelled.zip')controller.abort();});
  try{
    await assert.rejects(createBackup(f.project,{mediaFile:role=>path.join(f.media,f.files[role]),target,signal:controller.signal}),error=>error.name==='AbortError'||error.code==='ABORT_ERR');
  }finally{watcher.close();}
  await assert.rejects(fs.stat(target),error=>error.code==='ENOENT');
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(f.store.inspect(f.archive,{signal:cancelled.signal}),error=>error.name==='AbortError');
  assert.deepEqual(await fs.readdir(f.store.directory),[]);assert.equal((await f.config.listProjects()).length,0);
});
