import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { stopProcess } from '../server/process.mjs';
import { createExport } from '../public/exports.js';
import { parseSubtitle } from '../public/subtitles.js';
import { insightsAreCurrent } from '../public/insights.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data', 'checks', `subtitles-${Date.now()}`), id = randomUUID();
const projects = path.join(directory, 'projects'), media = path.join(directory, 'media', id), file = path.join(projects, `${id}.json`);
await fs.mkdir(projects, { recursive: true }); await fs.mkdir(media, { recursive: true });
const demo = JSON.parse(await fs.readFile(path.join(root, 'public', 'demo', 'project.json'), 'utf8'));
const project = { ...demo, id, isDemo: false, name: 'Kiểm tra nhập phụ đề',
  notes: [{ id: 'note-import', time: 18.75, text: 'Giữ ghi chú gốc.\nTiếng Việt: ă â đ ê ô ơ ư.' }],
  words: [{ text: 'old', start: 0, end: .5 }], turns: [{ start: 0, end: 5, speaker: demo.speakers[0].id }] };
await fs.writeFile(file, JSON.stringify(project));
for (const role of ['original', 'source', 'playback', 'clean']) await fs.copyFile(path.join(root, 'public', 'demo', demo.files[role]), path.join(media, demo.files[role]));
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`, endpoint = `/api/projects/${id}/subtitles`, json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sha = value => createHash('sha256').update(value).digest('hex');
const srt = '1\n00:00:01,250 --> 00:00:04,500\nNgười dẫn: Ghi âm cần thử micro trước.\nGiữ cả dòng thứ hai.\n\n2\n00:00:18,750 --> 00:00:24,000\nKhách mời: Tạo phụ đề có tên &amp; mốc thời gian.\n';
let server, logs = '';
async function boot() {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, PORT: String(port), AUDIO_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => { logs += bytes; }); server.stderr.on('data', bytes => { logs += bytes; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    if (server.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Máy chủ kiểm tra chưa khởi động. ' + logs);
}
async function kill() {
  if (!server) return; const child = server;
  await stopProcess(child);
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  server = null;
}
async function api(url, init = {}) {
  const response = await fetch(base + url, init), body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
  return body;
}
function inspect(input = srt, filename = 'bài giảng.srt', url = endpoint, field = 'subtitle') {
  const form = new FormData(); form.append(field, new Blob([input]), filename);
  return api(`${url}/inspect`, { method: 'POST', body: form });
}
const commit = token => api(`${endpoint}/${token}/import`, json({}));
const patch = updates => api(`/api/projects/${id}`, { ...json(updates), method: 'PATCH' });
try {
  await boot();
  const before = await fs.readFile(file), originalSha = sha(await fs.readFile(path.join(media, demo.files.original)));
  let review = await inspect(); assert.equal(review.cueCount, 2); assert.equal(review.filename, 'bài giảng.srt');
  assert.equal(review.projectId, id); assert.equal(review.firstTime, 1.25); assert.equal(review.lastTime, 24);
  assert.deepEqual(await fs.readFile(file), before, 'Preview must not modify the project.');
  await patch({ notes: [...project.notes, { id: 'after-preview', time: 6, text: 'Thêm trong lúc xem trước.' }] });
  let result = await commit(review.token); assert.equal(result.transcript.length, 2); assert.equal(result.notes.length, 2);
  assert.equal(result.transcript[1].time, 18.75); assert.match(result.transcript[0].text, /\nGiữ cả/u);
  assert.equal(result.files, undefined); assert.equal(result.words, undefined); assert.equal(insightsAreCurrent(result), true);
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(persisted.words, []); assert.deepEqual(persisted.turns, []); assert.equal(persisted.processed.speakers, false); assert.equal(persisted.processed.noise, true);
  await commit(review.token); assert.equal((await api(`/api/projects/${id}`)).transcript.length, 2);
  // Each validation failure leaves committed project bytes intact and removes uploaded temporary files.
  const validBytes = await fs.readFile(file);
  for (const [input, filename] of [['broken', 'broken.srt'], [srt.replace('00:00:24,000', '00:10:24,000'), 'long.srt'], [srt, 'wrong.txt'], [Buffer.from([0xC3, 0x28]), 'bad.srt']]) {
    await assert.rejects(inspect(input, filename), error => error.status === 400);
    assert.deepEqual(await fs.readFile(file), validBytes);
  }
  await assert.rejects(inspect(srt, 'file.srt', endpoint, 'wrong-field'), error => error.status === 400);
  await assert.rejects(inspect(Buffer.alloc(25 * 1024 * 1024 + 1, 0x20)), error => error.status === 413 && /25 MB/u.test(error.message));
  await assert.rejects(inspect(srt, 'file.srt', '/api/projects/not-a-uuid/subtitles'), error => error.status === 400);
  await assert.rejects(inspect(srt, 'file.srt', '/api/projects/demo/subtitles'), error => error.status === 400);
  review = await inspect();
  await patch({ transcript: result.transcript.map((line, index) => index ? line : { ...line, text: 'Đã chỉnh ở tab khác.' }) });
  const changed = await fs.readFile(file);
  await assert.rejects(commit(review.token), error => error.status === 409); assert.deepEqual(await fs.readFile(file), changed);
  review = await inspect(); await api(`/api/subtitles/${review.token}`, { method: 'DELETE' });
  await assert.rejects(commit(review.token), error => error.status === 410);
  await assert.rejects(commit(randomUUID()), error => error.status === 410);
  // Existing projects in an unfinished durable queue cannot have their transcript replaced.
  const queue = await api('/api/queue'), queueId = randomUUID();
  await api('/api/queue/items', json({ generation: queue.generation, id: queueId, name: 'queue.wav', size: 10 }));
  const queueState = JSON.parse(await fs.readFile(path.join(directory, 'queue.json'), 'utf8'));
  const queuedId = queueState.items[0].projectId;
  await fs.writeFile(path.join(projects, `${queuedId}.json`), JSON.stringify({ ...project, id: queuedId }));
  await assert.rejects(inspect(srt, 'queued.srt', `/api/projects/${queuedId}/subtitles`), error => error.status === 409);
  await api(`/api/queue/items/${queueId}`, { method: 'DELETE' });
  const vtt = 'WEBVTT\n\nNOTE Test\n\nchapter-1\n00:01.250 --> 00:04.500 align:start\n<v Cô Hương>Giữ tiếng Việt và tên người nói.</v>\n\n00:18.750 --> 00:24.000\n<v Học viên>Ghi chú &amp; thời gian.</v>\n';
  review = await inspect(Buffer.concat([Buffer.from([255, 254]), Buffer.from(vtt, 'utf16le')]), 'tiếng Việt.vtt');
  assert.equal(review.format, 'vtt'); result = await commit(review.token);
  for (const type of ['srt', 'vtt']) assert.equal(parseSubtitle(createExport(result, type).content).cues.length, 2);
  assert.equal(sha(await fs.readFile(path.join(media, demo.files.original))), originalSha);
  assert.deepEqual(result.notes, persisted.notes);
  const audio = await fetch(`${base}${result.audioUrl}`, { headers: { Range: 'bytes=0-255' } }); assert.equal(audio.status, 206); assert.equal((await audio.arrayBuffer()).byteLength, 256);
  const outside = await fetch(`${base}${endpoint}/inspect`, { method: 'POST', headers: { Origin: 'https://outside.example' } }); assert.equal(outside.status, 403);
  const uncommitted = await inspect();
  await kill(); await boot();
  assert.deepEqual((await api(`/api/projects/${id}`)).transcript, result.transcript);
  await assert.rejects(commit(uncommitted.token), error => error.status === 410);
  const temporaryFiles = (await fs.readdir(path.join(directory, 'tmp'), { withFileTypes: true })).filter(entry => entry.isFile()); assert.deepEqual(temporaryFiles, []);
  const summary = { result: 'passed', directory, checked: ['SRT preview/import', 'UTF-16 WebVTT with voice labels', 'Vietnamese and multiline text', 'notes/audio preservation', 'fresh insights and cleared alignment', 'invalid/oversized upload cleanup', 'stale preview conflict', 'idempotent retry', 'discarded/missing sessions', 'queue busy guard', 'SRT/VTT export round trip', 'HTTP Range playback', 'origin', 'restart persistence'] };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
} finally { await kill(); await fs.writeFile(path.join(directory, 'server.log'), logs); }
