import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { stopProcess } from '../server/process.mjs';
import { historyFingerprint } from '../server/history.mjs';
import { insightsAreCurrent } from '../public/insights.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data', 'checks', `history-${Date.now()}`), id = randomUUID();
const projects = path.join(directory, 'projects'), media = path.join(directory, 'media', id), file = path.join(projects, `${id}.json`);
await fs.mkdir(projects, { recursive: true }); await fs.mkdir(media, { recursive: true });
await fs.symlink(path.join(root, 'data', 'models'), path.join(directory, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
const demo = JSON.parse(await fs.readFile(path.join(root, 'public', 'demo', 'project.json'), 'utf8'));
const initial = { ...demo, id, isDemo: false, name: 'Kiểm tra lịch sử phiên bản',
  notes: [{ id: 'note-history', time: 18.75, text: 'Giữ ghi chú gốc.\nTiếng Việt: ă â đ ê ô ơ ư.' }],
  words: [{ text: 'old', start: 0, end: .5 }], turns: [{ start: 0, end: 5, speaker: demo.speakers[0].id }] };
await fs.writeFile(file, JSON.stringify(initial));
const roles = ['original', 'source', 'playback', 'clean'];
for (const role of roles) await fs.copyFile(path.join(root, 'public', 'demo', demo.files[role]), path.join(media, demo.files[role]));
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`, endpoint = `/api/projects/${id}`, ai = process.argv.includes('--ai');
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sha = value => createHash('sha256').update(value).digest('hex');
let server, logs = '';
async function waitFor(action, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action(); if (result) return result;
    if (server?.exitCode != null) throw new Error(`Server exited: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${description}. ${logs.slice(-2000)}`);
}
async function boot() {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: root, windowsHide: true, env: { ...process.env,
    PORT: String(port), AUDIO_DATA_DIR: directory, HF_HUB_OFFLINE: '1', AUDIO_MODEL_CACHE: path.join(root, 'data/models/whisper') }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => { logs += bytes; }); server.stderr.on('data', bytes => { logs += bytes; });
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'server ready');
}
async function kill() {
  const child = server; if (!child) return;
  await stopProcess(child);
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  server = null;
}
async function api(url, init = {}) {
  const response = await fetch(base + url, init), body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
  return body;
}
const patch = updates => api(endpoint, { ...json(updates), method: 'PATCH' });
const list = () => api(`${endpoint}/history`);
const preview = versionId => api(`${endpoint}/history/${versionId}`);
const restore = (versionId, expectedFingerprint) => api(`${endpoint}/history/${versionId}/restore`, json({ expectedFingerprint }));
try {
  await boot();
  const hashes = await Promise.all(roles.map(async role => sha(await fs.readFile(path.join(media, demo.files[role])))));
  const originalBytes = await fs.readFile(file);
  assert.deepEqual((await list()).versions, []); assert.deepEqual(await fs.readFile(file), originalBytes);
  let history = await api(`${endpoint}/history`, json({}));
  const initialId = history.versions[0].id;
  assert.equal(history.versions.length, 1); assert.equal(history.versions[0].reason, 'manual'); assert.equal(history.versions[0].isCurrent, true);
  assert.equal((await api(`${endpoint}/history`, json({}))).versions[0].id, initialId);
  let current = await patch({ transcript: initial.transcript.map((line, i) => i ? line : { ...line, text: 'Bản đã chỉnh sửa.\nGiữ tiếng Việt và xuống dòng.' }) });
  current = await patch({ speakers: current.speakers.map((person, i) => i ? person : { ...person, name: 'Người dẫn đã đổi tên' }) });
  assert.equal((await list()).versions.length, 1, 'Manual edits should reuse and group the checkpoint.');
  const edited = structuredClone(current);
  const srt = '1\n00:00:01,250 --> 00:00:04,500\nCô Hương: Nội dung nhập từ phụ đề.\nGiữ cả dòng hai.\n\n2\n00:00:18,750 --> 00:00:24,000\nHọc viên: Ghi chú vẫn được giữ.\n';
  const form = new FormData(); form.append('subtitle', new Blob([srt]), 'bài giảng.srt');
  const inspected = await api(`${endpoint}/subtitles/inspect`, { method: 'POST', body: form });
  current = await api(`${endpoint}/subtitles/${inspected.token}/import`, json({}));
  const imported = structuredClone(current); history = await list();
  assert.equal(history.versions.length, 2); assert.equal(history.versions[0].reason, 'subtitles');
  const editedId = history.versions[0].id;
  const editedPreview = await preview(editedId); assert.deepEqual(editedPreview.transcript, edited.transcript); assert.deepEqual(editedPreview.speakers, edited.speakers);
  const beforePreview = await fs.readFile(file), review = await preview(initialId);
  assert.deepEqual(await fs.readFile(file), beforePreview, 'Preview must not mutate data.');
  const notes = [...current.notes, { id: 'after-preview', time: 7, text: 'Ghi chú thêm sau khi xem trước.' }];
  await patch({ notes });
  current = await restore(initialId, review.currentFingerprint);
  assert.deepEqual(current.transcript, initial.transcript); assert.deepEqual(current.speakers, initial.speakers); assert.deepEqual(current.notes, notes);
  assert.equal(current.transcriptHistory, undefined); assert.equal(insightsAreCurrent(current), true);
  let stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(stored.words, []); assert.deepEqual(stored.turns, []); assert.equal(stored.queueCheckpoint, undefined);
  assert.equal(stored.processed.noise, true); assert.deepEqual(stored.files, initial.files);
  history = await list(); const importedId = history.versions[0].id; assert.equal(history.versions[0].reason, 'restore');
  assert.deepEqual((await preview(importedId)).transcript, imported.transcript);
  const restoredBytes = await fs.readFile(file);
  await restore(initialId, review.currentFingerprint); assert.deepEqual(await fs.readFile(file), restoredBytes, 'A retried restore must not write or duplicate history.');
  current = await restore(importedId, (await preview(importedId)).currentFingerprint);
  assert.deepEqual(current.transcript, imported.transcript); assert.deepEqual(current.speakers, imported.speakers); assert.deepEqual(current.notes, notes);
  const stale = await preview(initialId);
  current = await patch({ transcript: current.transcript.map((line, i) => i ? line : { ...line, text: 'Đã thay đổi sau preview.' }) });
  const changedBytes = await fs.readFile(file);
  await assert.rejects(restore(initialId, stale.currentFingerprint), error => error.status === 409); assert.deepEqual(await fs.readFile(file), changedBytes);
  await assert.rejects(preview(randomUUID()), error => error.status === 404);
  await assert.rejects(preview('invalid'), error => error.status === 400);
  const otherId = randomUUID(), otherFile = path.join(projects, `${otherId}.json`);
  await fs.writeFile(otherFile, JSON.stringify({ ...initial, id: otherId }));
  await assert.rejects(api(`/api/projects/${otherId}/history/${initialId}`), error => error.status === 404);
  await assert.rejects(api('/api/projects/demo/history'), error => error.status === 400);
  for (const route of [`${endpoint}/history`, `${endpoint}/history/${initialId}/restore`]) {
    const response = await fetch(base + route, { ...json({ expectedFingerprint: historyFingerprint(current) }), headers: { 'Content-Type': 'application/json', Origin: 'https://outside.example' } });
    assert.equal(response.status, 403);
  }
  const queue = await api('/api/queue'), queueId = randomUUID();
  await api('/api/queue/items', json({ generation: queue.generation, id: queueId, name: 'queue.wav', size: 10 }));
  const queueState = JSON.parse(await fs.readFile(path.join(directory, 'queue.json'), 'utf8')), queuedId = queueState.items[0].projectId;
  await fs.writeFile(path.join(projects, `${queuedId}.json`), JSON.stringify({ ...stored, id: queuedId }));
  for (const suffix of ['history', `history/${initialId}/restore`]) await assert.rejects(api(`/api/projects/${queuedId}/${suffix}`, json(suffix === 'history' ? {} : { expectedFingerprint: historyFingerprint(stored) })), error => error.status === 409);
  await api(`/api/queue/items/${queueId}`, { method: 'DELETE' });
  current = await patch({ transcript: current.transcript.map((line, i) => i ? line : { ...line, text: 'Bản sửa trước khi chạy lại AI để kiểm tra checkpoint.' }) });
  const beforeAI = structuredClone(current), job = await api(`${endpoint}/jobs`, json({ kind: 'transcript', model: 'tiny', language: 'en', numSpeakers: 2, noiseStrength: 'standard' }));
  const aiVersion = await waitFor(async () => {
    const latest = JSON.parse(await fs.readFile(file, 'utf8')), entry = latest.transcriptHistory?.entries[0];
    const status = await api(`/api/jobs/${job.id}`);
    if (status.status === 'failed') throw new Error(`AI failed before its checkpoint: ${status.message}`);
    return entry?.reason === 'transcript' && entry.fingerprint === historyFingerprint(beforeAI) ? entry : null;
  }, 'checkpoint before worker starts');
  await assert.rejects(api(`${endpoint}/history`, json({})), error => error.status === 409);
  await assert.rejects(restore(initialId, historyFingerprint(beforeAI)), error => error.status === 409);
  if (!ai) await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
  const settled = await waitFor(async () => { const result = await api(`/api/jobs/${job.id}`); return result.status !== 'running' ? result : null; }, 'AI finishes or cancels', 300000);
  assert.equal(settled.status, ai ? 'completed' : 'cancelled', settled.message);
  if (ai) {
    current = await api(endpoint); assert.ok(current.transcript.some(line => /\p{L}/u.test(line.text))); assert.equal(insightsAreCurrent(current), true);
    current = await restore(aiVersion.id, (await preview(aiVersion.id)).currentFingerprint);
    assert.deepEqual(current.transcript, beforeAI.transcript); assert.deepEqual(current.notes, notes);
  } else assert.deepEqual((await api(endpoint)).transcript, beforeAI.transcript);
  current = await restore(initialId, (await preview(initialId)).currentFingerprint);
  const finalHistory = await list(), finalBytes = await fs.readFile(file);
  await kill(); await boot();
  assert.deepEqual((await api(endpoint)).transcript, current.transcript); assert.deepEqual((await api(endpoint)).notes, notes);
  assert.deepEqual(await list(), finalHistory); assert.deepEqual(await fs.readFile(file), finalBytes);
  assert.deepEqual(await Promise.all(roles.map(async role => sha(await fs.readFile(path.join(media, demo.files[role]))))), hashes);
  const audio = await fetch(`${base}${current.audioUrl}`, { headers: { Range: 'bytes=0-255' } }); assert.equal(audio.status, 206); assert.equal((await audio.arrayBuffer()).byteLength, 256);
  // Malformed local history cannot overwrite the current transcript.
  const broken = { ...initial, id: otherId, transcriptHistory: { version: 99, entries: [], editGroup: null } };
  await fs.writeFile(otherFile, JSON.stringify(broken)); const corruptBytes = await fs.readFile(otherFile);
  await assert.rejects(api(`/api/projects/${otherId}/history`), error => error.status === 409);
  await assert.rejects(api(`/api/projects/${otherId}/history`, json({})), error => error.status === 409);
  assert.deepEqual(await fs.readFile(otherFile), corruptBytes);
  const summary = { result: 'passed', ai, directory, projectId: id, port, checked: ['manual checkpoint and deduplication', 'grouped edits and speaker names', 'automatic subtitle checkpoint', 'preview without mutation', 'restoration preserves newer notes and audio bytes', 'reversible restore', 'idempotent retry', 'stale preview guard', 'missing/malformed/cross-project version', 'busy queue/AI guards', 'AI checkpoint before worker', ...(ai ? ['real Whisper tiny completion and recovery'] : ['cancelled AI retains current transcript']), 'fresh insights and cleared alignment', 'HTTP Range', 'origin rejection', 'restart persistence', 'corrupt history preserves current project'] };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
} finally { await kill(); await fs.writeFile(path.join(directory, 'server.log'), logs); }
