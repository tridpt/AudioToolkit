import test from 'node:test';
import assert from 'node:assert/strict';
import { editSchema, optionsSchema, validateEdits, publicProject, uploadedFilename } from '../server/domain.mjs';

test('multipart filenames decode UTF-8 once while preserving existing Unicode and Latin-1',()=>{
  const name='Hàng loạt — Bài giảng số 1.wav';
  assert.equal(uploadedFilename(Buffer.from(name,'utf8').toString('latin1')),name);
  assert.equal(uploadedFilename(name),name);
  assert.equal(uploadedFilename('café.wav'),'café.wav');
  assert.equal(uploadedFilename('audio.wav'),'audio.wav');
});

const project = {id:'project',duration:10,files:{original:'private.wav'},words:[{text:'private'}],processed:{noise:false},
  speakers:[{id:'s1',name:'Minh',color:'#7472e9'}],transcript:[{id:'line-1',time:0,end:5,speaker:'s1',confidence:90,text:'Xin chào'}],notes:[]};
test('reject non-finite, reversed and over-duration times',()=>{
  assert.equal(editSchema.safeParse({transcript:[{...project.transcript[0],end:0}]}).success,false);
  assert.equal(editSchema.safeParse({notes:[{id:'n1',time:Infinity,text:'Note'}]}).success,false);
  assert.throws(()=>validateEdits(project,{notes:[{id:'n1',time:11,text:'Note'}]}),error=>error.status===400);
  assert.throws(()=>validateEdits(project,{transcript:[{...project.transcript[0],end:11}]}));
});
test('speaker references and duplicate IDs are validated',()=>{
  assert.throws(()=>validateEdits(project,{transcript:[{...project.transcript[0],speaker:'unknown'}]}));
  assert.throws(()=>validateEdits(project,{speakers:[project.speakers[0],project.speakers[0]]}));
  assert.throws(()=>validateEdits(project,{notes:[{id:'same',time:0,text:'a'},{id:'same',time:1,text:'b'}]}));
});
test('partial note edits preserve transcript and project remains immutable',()=>{
  const updated=validateEdits(project,editSchema.parse({notes:[{id:'n1',time:2.25,text:'Ý tưởng'}]}));
  assert.equal(updated.transcript,project.transcript);assert.equal(project.notes.length,0);assert.equal(updated.notes[0].time,2.25);
});
test('public project omits disk paths and word data',()=>{
  const view=publicProject(project);assert.equal(view.files,undefined);assert.equal(view.words,undefined);assert.equal(view.cleanUrl,null);
  assert.match(view.audioUrl,/\/audio\/original$/);
});
test('processing accepts bounded options and rejects arbitrary model or language',()=>{
  assert.equal(optionsSchema.parse({kind:'all'}).model,'base');
  assert.equal(optionsSchema.safeParse({kind:'all',model:'../../model'}).success,false);
  assert.equal(optionsSchema.safeParse({kind:'speakers',numSpeakers:50}).success,false);
});
