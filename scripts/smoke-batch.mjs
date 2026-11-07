import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import JSZip from 'jszip';
import { BatchQueue } from '../public/batch-queue.js';
import { reportSnapshot } from '../public/reports.js';

const base = process.env.AUDIO_URL || 'http://127.0.0.1:4188';
const ai = process.argv.includes('--ai');
const directory = 'data/checks/batch';
await fs.mkdir(directory, { recursive: true });
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const api = async (url, init = {}) => {
  const response = await fetch(base + url, init);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const health = await api('/api/health');
assert.equal(health.activeJob, null, 'Finish any existing job before running this smoke.');
const files = [];
for (const [index, start] of [4, 31].entries()) {
  const target = `${directory}/Bản thu ${index + 1}.wav`;
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(start), '-i', 'public/demo/original.wav', '-t', '12', '-ac', '1', '-ar', '16000', target], { windowsHide: true });
  files.push(new File([await fs.readFile(target)], `Hàng loạt — Bản thu ${index + 1}.wav`, { type: 'audio/wav' }));
}
const queue = new BatchQueue({ request: api });
await queue.connect({ poll: false });
assert.ok(queue.items.every(item => ['completed', 'failed', 'cancelled'].includes(item.status)), 'Finish pending user files before this smoke.');
const existing = new Set(queue.items.map(item => item.id));
await queue.add(files);
await queue.start({ kind: ai ? 'all' : 'noise', model: 'tiny', language: 'en', numSpeakers: 1, noiseStrength: 'standard' });
const deadline = Date.now() + 5 * 60 * 1000;
do {
  if (Date.now() > deadline) throw new Error('Batch timed out.');
  await new Promise(resolve => setTimeout(resolve, 500)); await queue.refresh();
} while (queue.running);
queue.dispose();
queue.items = queue.items.filter(item => !existing.has(item.id));
assert.equal(queue.items.length, 2);
for (const item of queue.items) if (item.project) item.project = await api(`/api/projects/${item.project.id}`);
assert.deepEqual(queue.items.map(item => item.status), ['completed', 'completed'], JSON.stringify(queue.items.map(item => ({ status: item.status, error: item.error }))));
for (const item of queue.items) {
  assert.equal(item.project.fileName, item.name, 'Uploaded Vietnamese filenames must survive multipart decoding.');
  assert.equal(item.project.processed.noise, true);
  if (ai) {
    assert.equal(item.project.processed.transcript, true); assert.equal(item.project.processed.speakers, true);
    assert.ok(item.project.transcript.length); assert.equal(item.project.speakers.length, 1); assert.ok(item.project.insights.summary.length);
  }
}
const snapshots = queue.items.map(item => reportSnapshot(item.project));
const formats = ai ? ['docx', 'pdf', 'txt', 'json', 'srt', 'vtt'] : ['docx', 'pdf', 'txt', 'json'];
snapshots[0].notes.unshift({ id: 'batch-smoke-note', time: 2.5, text: 'Ghi chú tiếng Việt — chỉ nằm trong bản xuất.' });
const request = { layout: 'interview', items: snapshots.map(project => ({ project, formats })) };
const response = await fetch(`${base}/api/batch/export`, json(request));
assert.equal(response.status, 200, response.ok ? '' : await response.text());
assert.match(response.headers.get('content-type'), /application\/zip/); assert.equal(response.headers.get('cache-control'), 'no-store');
assert.match(response.headers.get('content-disposition'), /attachment; filename="audio-toolkit/);
const buffer = Buffer.from(await response.arrayBuffer());
assert.equal(Number(response.headers.get('content-length')), buffer.length);
const zip = await JSZip.loadAsync(buffer), manifest = JSON.parse(await zip.file('audio-toolkit-manifest.json').async('string'));
assert.equal(manifest.files.length, snapshots.length * formats.length);
for (const entry of manifest.files) {
  const content = await zip.file(entry.path).async('nodebuffer');
  assert.equal(content.length, entry.bytes);
  if (entry.format === 'docx') {
    const xml = await (await JSZip.loadAsync(content)).file('word/document.xml').async('string');
    assert.ok(xml.includes(entry.project));
    if (entry.path.startsWith('01 - ')) assert.ok(xml.includes(snapshots[0].notes[0].text));
  } else if (entry.format === 'pdf') assert.equal(content.subarray(0, 5).toString(), '%PDF-');
  else if (entry.format === 'json') assert.ok(JSON.parse(content).schemaVersion === 2);
}
await fs.writeFile(`${directory}/results.zip`, buffer);
for (const item of queue.items) assert.deepEqual(await api(`/api/projects/${item.project.id}`), item.project, 'ZIP export must leave the saved project unchanged.');
for (const body of [{ items: [] }, { items: [{ project: snapshots[0], formats: ['exe'] }] },
  { items: [{ project: { ...snapshots[0], id: '00000000-0000-4000-8000-000000000000' }, formats: ['txt'] }] }]) {
  const rejected = await fetch(`${base}/api/batch/export`, json(body)); assert.ok([400, 404].includes(rejected.status));
}
const outside = await fetch(`${base}/api/batch/export`, { ...json(request), headers: { 'Content-Type': 'application/json', Origin: 'https://outside.example' } });
assert.equal(outside.status, 403);
console.log(JSON.stringify({ result: 'passed', ai, projectIds: queue.items.map(item => item.project.id), files: manifest.files.length, size: buffer.length,
  checked: ['real audio import', 'sequential queue', 'all processing steps when --ai', 'ZIP API', 'Unicode', 'headers', 'snapshots', 'source preservation', 'invalid requests', 'origin'] }, null, 2));
