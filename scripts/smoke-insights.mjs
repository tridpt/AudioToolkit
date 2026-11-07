import assert from 'node:assert/strict';
import { transcriptFingerprint, insightsAreCurrent } from '../public/insights.js';
import { createExport } from '../public/exports.js';

const base = process.env.AUDIO_URL || 'http://127.0.0.1:4188';
const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
async function api(route, options) {
  const response = await fetch(base + route, options); const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data)); return data;
}
const demo = await api('/api/projects/demo');
const project = await api('/api/demo/copy', { method: 'POST' });
const path = `/api/projects/${project.id}`;
const generation = value => api(path + '/insights', json('POST', { sourceFingerprint: transcriptFingerprint(value.transcript) }));
let response = await fetch(base + path + '/insights', json('POST', { sourceFingerprint: transcriptFingerprint([]) }));
assert.equal(response.status, 400);
const note = { id: 'original-note', time: 12.25, text: 'Ghi chú gốc cần được giữ nguyên.' };
await api(path, json('PATCH', { name: 'Kiểm tra tóm tắt', speakers: demo.speakers, transcript: demo.transcript, notes: [note] }));
await generation(demo);
let restored = await api(path);
assert.equal(insightsAreCurrent(restored), true); assert.deepEqual(restored.notes, [note]);
assert.ok(restored.insights.chapters.length > 1); assert.ok(restored.insights.highlights.length >= 3);
for (const point of restored.insights.highlights) {
  const source = restored.transcript.find(line => line.id === point.sourceIds[0]);
  assert.equal(point.time, source.time); assert.equal(point.speaker, source.speaker);
}
const changed = restored.transcript.map((line, index) => index ? line : { ...line, text: 'Xin chào. Đây là bản transcript đã chỉnh sửa.' });
await api(path, json('PATCH', { transcript: changed }));
restored = await api(path); assert.equal(insightsAreCurrent(restored), false);
response = await fetch(base + path + '/insights', json('POST', { sourceFingerprint: transcriptFingerprint(demo.transcript) }));
assert.equal(response.status, 409);
response = await fetch(base + path + '/insights', json('POST', { sourceFingerprint: transcriptFingerprint(changed), arbitrary: true }));
assert.equal(response.status, 400);
response = await fetch(base + path + '/insights', { ...json('POST', { sourceFingerprint: transcriptFingerprint(changed) }), headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' } });
assert.equal(response.status, 403);
await generation(restored); restored = await api(path);
assert.equal(insightsAreCurrent(restored), true); assert.deepEqual(restored.notes, [note]);
const text = createExport(restored, 'txt').content;
assert.match(text, /TÓM TẮT/); assert.match(text, /CHƯƠNG NỘI DUNG/); assert.ok(text.includes(note.text));
const exported = JSON.parse(createExport(restored, 'json').content);
assert.equal(exported.insights.stale, false); assert.equal(exported.schemaVersion, 2);
if (process.argv.includes('--transcribe')) {
  const job = await api(path + '/jobs', json('POST', { kind: 'transcript', language: 'en', model: 'base' }));
  response = await fetch(base + path + '/insights', json('POST', { sourceFingerprint: transcriptFingerprint(restored.transcript) }));
  assert.equal(response.status, 409);
  const started = Date.now(); let status = job;
  while (status.status === 'running') {
    assert.ok(Date.now() - started < 20 * 60 * 1000, 'Transcription timed out');
    await new Promise(resolve => setTimeout(resolve, 1500)); status = await api(`/api/jobs/${job.id}`);
  }
  assert.equal(status.status, 'completed', status.message);
  restored = await api(path); assert.equal(insightsAreCurrent(restored), true);
  assert.deepEqual(restored.notes, [note]); assert.equal(restored.processed.transcript, true);
  assert.ok(restored.insights.summary.length); assert.match(restored.transcript.map(line => line.text).join(' '), /creative habit/i);
}
console.log(JSON.stringify({ result: 'passed', projectId: project.id, summary: restored.insights.summary.length,
  chapters: restored.insights.chapters.length, highlights: restored.insights.highlights.length, preservedNotes: restored.notes.length,
  automaticAfterWhisper: process.argv.includes('--transcribe') }, null, 2));
