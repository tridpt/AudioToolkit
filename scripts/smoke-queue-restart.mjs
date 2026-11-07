import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import ffmpeg from 'ffmpeg-static';
import { stopProcess } from '../server/process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'data', 'checks', `queue-restart-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
// Reuse the already installed, read-only model cache in an isolated test data directory.
await fs.symlink(path.join(root, 'data', 'models'), path.join(directory, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`, queueFile = path.join(directory, 'queue.json');
let server, logs = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(action, description, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action(); if (result) return result;
    if (server?.exitCode != null) throw new Error(`Server exited: ${logs}`);
    await pause(50);
  }
  throw new Error(`Timeout: ${description}. ${logs.slice(-3000)}`);
}
async function boot() {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), AUDIO_DATA_DIR: directory, HF_HUB_OFFLINE: '1', AUDIO_MODEL_CACHE: path.join(root, 'data/models/whisper') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'server ready', 20000);
}
async function kill() {
  const old = server; if (!old) return; await stopProcess(old);
  if (old.exitCode === null && old.signalCode === null) await new Promise(resolve => old.once('close', resolve));
  server = null;
}
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function api(url, init = {}) {
  const response = await fetch(base + url, init), body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status });
  return body;
}
const readQueue = async () => JSON.parse(await fs.readFile(queueFile, 'utf8'));
const readProject = async id => JSON.parse(await fs.readFile(path.join(directory, 'projects', `${id}.json`), 'utf8'));
try {
  await boot(); let snapshot = await api('/api/queue'); const ids = [];
  for (const [index, start] of [4, 31].entries()) {
    const audio = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(start), '-i', path.join(root, 'public/demo/original.wav'),
      '-t', '12', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], { windowsHide: true });
    const id = randomUUID(), name = `Khôi phục — Bản thu ${index + 1}.wav`; ids.push(id);
    snapshot = await api('/api/queue/items', json({ generation: snapshot.generation, id, name, size: audio.length }));
    const form = new FormData(); form.append('audio', new Blob([audio]), name);
    snapshot = await api(`/api/queue/items/${id}/audio`, { method: 'PUT', body: form });
  }
  const options = { kind: 'all', model: 'tiny', language: 'en', numSpeakers: 1, noiseStrength: 'standard' };
  await api('/api/queue/start', json({ generation: snapshot.generation, options }));
  // No browser/client controller runs from here. Observe committed disk snapshots only.
  const interrupted = await waitFor(async () => {
    const state = await readQueue();
    if (state.items.some(item => item.status === 'failed')) throw new Error(JSON.stringify(state.items));
    if (state.items[0].status !== 'completed' || !state.items[1].imported) return false;
    const project = await readProject(state.items[1].projectId);
    return project.queueCheckpoint?.completed.includes('noise') && !project.queueCheckpoint.completed.includes('transcript') ? state : false;
  }, 'first file finished and second noise checkpoint committed');
  const projectIds = interrupted.items.map(item => item.projectId);
  const firstBytes = await fs.readFile(path.join(directory, 'projects', `${projectIds[0]}.json`));
  const clean = path.join(directory, 'media', projectIds[1], 'clean.mp3');
  const cleanHash = createHash('sha256').update(await fs.readFile(clean)).digest('hex'), cleanTime = (await fs.stat(clean)).mtimeMs;
  await kill(); console.log('Stopped owned server tree after the noise checkpoint. Restarting…');
  await boot();
  const completed = await waitFor(async () => {
    const state = await readQueue();
    if (state.items.some(item => item.status === 'failed')) throw new Error(JSON.stringify(state.items));
    return state.items.every(item => item.status === 'completed') ? state : false;
  }, 'automatic recovery and remaining real AI stages');
  assert.deepEqual(completed.items.map(item => item.id), ids);
  assert.deepEqual(completed.items.map(item => item.projectId), projectIds);
  assert.deepEqual(await fs.readFile(path.join(directory, 'projects', `${projectIds[0]}.json`)), firstBytes, 'Completed file must not run again.');
  assert.equal((await fs.stat(clean)).mtimeMs, cleanTime, 'Noise checkpoint must be skipped after restart.');
  assert.equal(createHash('sha256').update(await fs.readFile(clean)).digest('hex'), cleanHash);
  assert.equal((await fs.readdir(path.join(directory, 'projects'))).filter(file => file.endsWith('.json')).length, 2, 'No duplicate imports.');
  for (const id of projectIds) {
    const project = await api(`/api/projects/${id}`);
    assert.deepEqual(project.processed, { noise: true, transcript: true, speakers: true });
    assert.ok(project.transcript.length); assert.equal(project.speakers.length, 1); assert.equal(project.queueCheckpoint, undefined);
  }
  const unfinishedId = randomUUID();
  await api('/api/queue/items', json({ generation: completed.generation, id: unfinishedId, name: 'chưa tải.wav', size: 8 }));
  await kill(); await boot();
  snapshot = await api('/api/queue');
  assert.equal(snapshot.items.find(item => item.id === unfinishedId).status, 'awaiting-upload');
  await assert.rejects(api('/api/queue/start', json({ generation: snapshot.generation, options })), /Tải đủ/);
  const external = await fetch(`${base}/api/queue`, { method: 'DELETE', headers: { Origin: 'https://outside.example' } });
  assert.equal(external.status, 403);
  await api('/api/queue', { method: 'DELETE' });
  assert.equal((await api('/api/projects')).length, 2, 'Clearing queue preserves projects.');
  const result = { result: 'passed', directory, projectIds,
    checked: ['server-only scheduling', 'abrupt server and Python tree restart', 'automatic recovery', 'completed file untouched',
      'noise checkpoint skipped', 'same project IDs', 'no duplicate import', 'real transcript and speakers', 'incomplete upload recovery', 'origin', 'clear preserves results'] };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await kill(); await fs.writeFile(path.join(directory, 'server.log'), logs); }
