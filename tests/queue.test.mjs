import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DurableQueue, atomicQueueWrite } from '../server/queue.mjs';
import { BatchQueue } from '../public/batch-queue.js';

const options = { kind: 'all', model: 'tiny', language: 'en', numSpeakers: 1, noiseStrength: 'standard' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Queue did not settle.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-queue-test-'));
  const projects = new Map(), calls = []; let current;
  const config = { directory, hasProject: async id => projects.has(id), onError: () => {},
    acquire: item => ({ id: randomUUID(), kind: (item.options || options).kind, projectId: item.projectId, status: 'running', progress: null }),
    execute: async (item, task, imported) => {
      calls.push(item.projectId); projects.set(item.projectId, { saved: true }); await imported();
    }, ...overrides };
  const reopen = async () => { current = await DurableQueue.open(config); return current; };
  const queue = await reopen();
  t.after(async () => {
    await current.close(); await until(() => !current.active);
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('audio-queue-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const add = async (name = 'Bản thu.wav') => {
    const id = randomUUID(); await current.reserve({ generation: current.state.generation, id, name, size: 8 });
    const input = path.join(directory, `${randomUUID()}.upload`); await fs.writeFile(input, '12345678');
    await current.attach(id, input, 8); return id;
  };
  const start = () => current.start({ generation: current.state.generation, options });
  return { queue, add, start, reopen, projects, calls, config, directory };
}

test('durable queue runs sequentially without a browser and resumes only failed files with stable IDs', async t => {
  const f = await fixture(t); let simultaneous = 0, maximum = 0, failFirst = true;
  f.config.execute = f.queue.execute = async (item, task, imported) => {
    simultaneous++; maximum = Math.max(maximum, simultaneous);
    if (!f.projects.has(item.projectId)) { f.calls.push(item.projectId); f.projects.set(item.projectId, {}); }
    await imported(); await new Promise(resolve => setTimeout(resolve, 10)); simultaneous--;
    if (failFirst) { failFirst = false; throw new Error('Processing failed'); }
  };
  const one = await f.add(), two = await f.add(); await f.start();
  await until(() => f.queue.state.items.every(item => ['failed', 'completed'].includes(item.status)) && !f.queue.active);
  assert.deepEqual(f.queue.state.items.map(item => item.status), ['failed', 'completed']);
  const ids = f.queue.state.items.map(item => item.projectId); assert.equal(maximum, 1);
  await f.queue.close(); const restored = await f.reopen();
  assert.deepEqual(restored.state.items.map(item => item.projectId), ids);
  assert.equal(restored.state.items[1].id, two); assert.equal(restored.state.items[1].status, 'completed');
  await restored.retry(one); await f.start();
  await until(() => restored.state.items.every(item => item.status === 'completed') && !restored.active);
  assert.deepEqual(f.calls, ids, 'A retry must reuse the committed project.');
  assert.equal(restored.state.items[0].options.model, 'tiny');
});

test('restart recovers in-flight import and uploaded bytes even if the upload response was never committed', async t => {
  const f = await fixture(t); const one = await f.add();
  const two = randomUUID(); await f.queue.reserve({ generation: f.queue.state.generation, id: two, name: 'lost-response.wav', size: 8 });
  await fs.writeFile(f.queue.uploadPath(two), '12345678'); // Crash between the file rename and queue JSON write.
  await f.queue.change(next => { next.enabled = true; next.options = options; next.items[0].status = 'importing'; next.items[0].options = options; });
  const stableId = f.queue.state.items[0].projectId;
  f.projects.set(stableId, { saved: true }); // Crash after project commit but before queue commit.
  await f.queue.close(); const restored = await f.reopen();
  assert.equal(restored.state.items[0].id, one); assert.equal(restored.state.items[0].imported, true);
  assert.equal(restored.state.items[0].projectId, stableId);
  assert.deepEqual(restored.state.items.map(item => item.status), ['queued', 'queued']);
  assert.equal(restored.state.items[1].uploaded, true);
  restored.startWorker(); await until(() => restored.state.items.every(item => item.status === 'completed') && !restored.active);
  assert.equal(f.projects.size, 2);
});

test('missing upload remains recoverable, cannot start early, and idempotent registration does not duplicate entries', async t => {
  const f = await fixture(t), id = randomUUID();
  const input = { generation: f.queue.state.generation, id, name: 'interrupted.wav', size: 8 };
  await f.queue.reserve(input); await f.queue.reserve(input);
  await assert.rejects(f.start(), /Tải đủ/); assert.equal(f.queue.state.items.length, 1);
  await f.queue.close(); const restored = await f.reopen();
  assert.equal(restored.state.items[0].status, 'awaiting-upload');
  const source = path.join(f.directory, 'retry.upload'); await fs.writeFile(source, '12345678');
  await assert.rejects(restored.attach(id, source, 7), /Kích thước/);
  await restored.attach(id, source, 8); await f.start();
  await until(() => restored.state.items[0].status === 'completed' && !restored.active);
  assert.equal(f.projects.size, 1);
});

test('worker ownership is reserved before disk writes, and an external job keeps the queue waiting', async t => {
  let busy = true, starts = 0;
  const f = await fixture(t, { acquire: item => busy ? null : (starts++, { id: randomUUID(), kind: 'all', projectId: item.projectId }) });
  await f.add(); await f.add(); await f.start(); await f.queue.pump(); assert.equal(starts, 0);
  busy = false;
  await Promise.all([f.queue.pump(), f.queue.pump(), f.queue.pump()]);
  await until(() => f.queue.state.items.every(item => item.status === 'completed') && !f.queue.active);
  assert.equal(starts, 2); assert.equal(f.calls.length, 2);
});

test('cancel intent survives restart, retry preserves options, and clear cannot resurrect stale uploads or delete projects', async t => {
  const f = await fixture(t); const id = await f.add();
  await f.queue.change(next => { next.items[0].options = options; });
  await f.queue.cancel(id); await f.queue.close(); const restored = await f.reopen();
  assert.equal(restored.state.items[0].status, 'cancelled');
  await restored.retry(id); assert.deepEqual(restored.state.items[0].options, options);
  await f.start(); await until(() => restored.state.items[0].status === 'completed' && !restored.active);
  const oldGeneration = restored.state.generation;
  await restored.clear();
  assert.equal(restored.state.items.length, 0); assert.equal(f.projects.size, 1);
  await assert.rejects(restored.reserve({ generation: oldGeneration, id: randomUUID(), name: 'late.wav', size: 8 }), /đã thay đổi/);
  assert.deepEqual(await fs.readdir(restored.staging), []);
});

test('clearing active work persists cancellation before stopping the process and keeps committed projects', async t => {
  const entered = deferred(), stopped = deferred(); let observed = false;
  const f = await fixture(t, { execute: async (item, task, imported) => {
    f.projects.set(item.projectId, {}); await imported(); entered.resolve(); await stopped.promise;
    assert.equal(task.cancelled, true); throw new Error('stopped');
  }, stop: async () => { observed = f.queue.state.clearing && f.queue.state.items[0].cancelRequested; stopped.resolve(); } });
  await f.add(); await f.start(); await entered.promise; await f.queue.clear();
  await until(() => !f.queue.active && !f.queue.state.clearing);
  assert.equal(observed, true); assert.equal(f.queue.state.items.length, 0); assert.equal(f.projects.size, 1);
});

test('failed persistence never acknowledges or starts untracked work and leaves the last snapshot readable', async t => {
  let broken = false;
  const f = await fixture(t, { write: async (file, state) => { if (broken) throw new Error('disk full'); await atomicQueueWrite(file, state); } });
  await f.add(); const before = await fs.readFile(f.queue.file, 'utf8'); broken = true;
  await assert.rejects(f.start(), /disk full/); await f.queue.pump();
  assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(f.queue.file, 'utf8'), before);
  assert.match(f.queue.view().error, /disk full/); assert.equal(f.queue.state.enabled, false);
  broken = false; await f.start(); await until(() => f.queue.state.items[0].status === 'completed' && !f.queue.active);
});

test('corrupt durable queue fails closed and preserves the original bytes', async t => {
  const f = await fixture(t); await f.queue.close(); await fs.writeFile(f.queue.file, '{broken');
  await assert.rejects(f.reopen(), /File được giữ nguyên/);
  assert.equal(await fs.readFile(f.queue.file, 'utf8'), '{broken');
});

test('a disk failure after project commit stops scheduling until explicit recovery reuses that project', async t => {
  let broken = false, runs = 0;
  const f = await fixture(t, { write: async (file, state) => { if (broken) throw new Error('disk unavailable'); await atomicQueueWrite(file, state); },
    execute: async (item, task, imported) => {
      runs++; f.projects.set(item.projectId, { committed: true });
      if (runs === 1) broken = true;
      await imported();
    } });
  await f.add(); const projectId = f.queue.state.items[0].projectId; await f.start();
  await until(() => !f.queue.active && !!f.queue.storageError);
  assert.equal(f.queue.state.items[0].imported, false); assert.equal(f.projects.size, 1);
  broken = false; await f.queue.retryStorage();
  await until(() => f.queue.state.items[0].status === 'completed' && !f.queue.active);
  assert.equal(f.queue.state.items[0].projectId, projectId); assert.equal(f.projects.size, 1); assert.equal(runs, 2);
});

function browserService(queue) {
  const calls = [];
  const request = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (url === '/api/queue' && init.method === 'DELETE') return queue.clear();
    if (url === '/api/queue') return queue.view();
    if (url === '/api/queue/items') return queue.reserve(JSON.parse(init.body));
    if (url === '/api/queue/start') return queue.start(JSON.parse(init.body));
    const id = url.split('/')[4];
    if (url.endsWith('/audio')) {
      const file = init.body.get('audio'), temporary = path.join(path.dirname(queue.file), `${randomUUID()}.upload`);
      await fs.writeFile(temporary, Buffer.from(await file.arrayBuffer())); return queue.attach(id, temporary, file.size);
    }
    if (url.endsWith('/retry')) return queue.retry(id);
    if (url.endsWith('/cancel')) return queue.cancel(id);
    if (init.method === 'DELETE') return queue.remove(id);
    throw new Error(url);
  };
  return { request, calls };
}

test('browser stages all files before starting and a new browser sees authoritative progress without duplicate starts', async t => {
  const f = await fixture(t), api = browserService(f.queue), first = new BatchQueue(api);
  t.after(() => first.dispose()); await first.connect({ poll: false });
  await first.add([new File(['12345678'], 'one.wav'), new File(['12345678'], 'two.wav')]);
  assert.equal(first.hasUnuploaded, false); assert.equal(f.calls.length, 0);
  assert.deepEqual(first.items.map(item => item.status), ['queued', 'queued']);
  await first.start(options); first.dispose();
  const next = new BatchQueue(api); t.after(() => next.dispose()); await next.connect({ poll: false });
  await until(() => f.queue.state.items.every(item => item.status === 'completed') && !f.queue.active); await next.refresh();
  assert.deepEqual(next.items.map(item => item.status), ['completed', 'completed']);
  assert.equal(f.projects.size, 2); assert.equal(api.calls.filter(call => call === 'POST /api/queue/start').length, 1);
});

test('browser recovers an incomplete upload using the existing item and rejects a different replacement file', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.queue.reserve({ generation: f.queue.state.generation, id, name: 'original.wav', size: 8 });
  const client = new BatchQueue(browserService(f.queue)); t.after(() => client.dispose()); await client.connect({ poll: false });
  assert.equal(client.items[0].needsUpload, true); assert.equal(client.hasUnuploaded, false);
  await assert.rejects(client.replaceFile(id, new File(['12345678'], 'wrong.wav')), /Chọn đúng file/);
  await client.replaceFile(id, new File(['12345678'], 'original.wav'));
  assert.equal(client.items[0].id, id); assert.equal(client.items[0].status, 'queued'); assert.equal(client.items.length, 1);
});

test('browser cancellation while registration is in flight persists intent before transferring bytes', async t => {
  const f = await fixture(t), registered = deferred(), release = deferred(), api = browserService(f.queue);
  const client = new BatchQueue({ request: async (url, init) => {
    const result = await api.request(url, init);
    if (url === '/api/queue/items') { registered.resolve(); await release.promise; }
    return result;
  } });
  t.after(() => client.dispose()); await client.connect({ poll: false });
  const adding = client.add([new File(['12345678'], 'cancel.wav')]); await registered.promise;
  await client.cancel(client.items[0].id); release.resolve(); await adding;
  assert.equal(f.queue.state.items[0].status, 'cancelled');
  assert.equal(api.calls.some(call => call.endsWith('/audio')), false); assert.equal(client.hasUnuploaded, false);
});

test('browser retains local bytes on a transient upload failure and ignores stale snapshots', async t => {
  const f = await fixture(t), api = browserService(f.queue); let fail = true;
  const client = new BatchQueue({ request: async (url, init) => {
    if (url.endsWith('/audio') && fail) { fail = false; throw new Error('connection lost'); }
    return api.request(url, init);
  } });
  t.after(() => client.dispose()); await client.connect({ poll: false });
  const stale = f.queue.view(); await client.add([new File(['12345678'], 'retry.wav')]);
  assert.equal(client.items[0].status, 'failed'); assert.equal(client.hasUnuploaded, true);
  await client.retry(client.items[0].id); client.apply(stale);
  assert.equal(client.items[0].status, 'queued'); assert.equal(client.items.length, 1); assert.equal(client.hasUnuploaded, false);
});

test('invalid selections stay actionable locally while valid files can run on the server', async t => {
  const f = await fixture(t), client = new BatchQueue(browserService(f.queue));
  t.after(() => client.dispose()); await client.connect({ poll: false });
  await client.add([new File(['text'], 'wrong.txt'), new File(['12345678'], 'valid.wav')]);
  assert.deepEqual(client.items.map(item => item.status).sort(), ['failed', 'queued']);
  assert.equal(client.hasUnuploaded, false); assert.equal(f.queue.state.items.length, 1);
  await client.start(options); await until(() => f.queue.state.items[0].status === 'completed' && !f.queue.active);
  const invalid = client.items.find(item => item.name === 'wrong.txt'); await client.remove(invalid.id);
  assert.equal(client.items.length, 1);
});
