import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withHistory, listHistory, previewHistory, restoreHistory, historyFingerprint, HISTORY_LIMIT, HISTORY_EDIT_WINDOW } from '../server/history.mjs';
import { publicProject } from '../server/domain.mjs';
import { atomicQueueWrite } from '../server/queue.mjs';
import { insightsAreCurrent } from '../public/insights.js';

const fixture = () => ({ id: randomUUID(), name: 'Bài giảng', duration: 60, language: 'vi', model: 'tiny',
  processed: { noise: true, transcript: true, speakers: true }, files: { original: 'original.wav', clean: 'clean.mp3' },
  speakers: [{ id: 's1', name: 'Cô Hương', color: '#7472e9' }],
  transcript: [{ id: 'line-1', time: 1.25, end: 5, speaker: 's1', confidence: 90, text: 'Lời gốc tiếng Việt.\nGiữ cả xuống dòng.' }],
  notes: [{ id: 'n1', time: 18.75, text: 'Ghi chú hiện tại.' }], words: [{ text: 'gốc', start: 1.25, end: 2 }],
  turns: [{ speaker: 's1', start: 1.25, end: 5 }], queueCheckpoint: { itemId: randomUUID(), completed: ['transcript'] }, insights: { old: true } });
const edit = (project, text) => ({ ...project, transcript: project.transcript.map((line, i) => i ? line : { ...line, text }) });
const checkpoint = (project, options = {}) => withHistory(project, project, { reason: 'manual', checkpoint: true, now: 1000, ...options });
const firstId = project => project.transcriptHistory.entries[0].id;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('notes, audio flags, insights, name and alignment changes do not create transcript versions', () => {
  const project = fixture();
  for (const updates of [{ notes: [] }, { name: 'Tên mới' }, { processed: { ...project.processed, noise: false } }, { files: {} }, { words: [], turns: [] }, { insights: null }]) {
    const next = { ...project, ...updates };
    assert.equal(withHistory(project, next), next); assert.equal(next.transcriptHistory, undefined);
    assert.equal(historyFingerprint(next), historyFingerprint(project));
  }
  assert.equal(withHistory(project, project), project);
});

test('versions are independent copies of transcript and speakers with millisecond timing and Unicode', () => {
  const project = fixture(), untouched = structuredClone(project);
  const next = withHistory(project, edit(project, 'Lời mới.'), { reason: 'subtitles', now: 1000 });
  assert.deepEqual(project, untouched);
  const saved = next.transcriptHistory.entries[0];
  assert.equal(saved.reason, 'subtitles'); assert.equal(saved.content.transcript[0].time, 1.25);
  assert.match(saved.content.transcript[0].text, /Việt\.\nGiữ/u);
  project.transcript[0].text = 'Thay đối tượng cũ'; project.speakers[0].name = 'Tên mới';
  next.transcript[0].text = 'Thay bản hiện tại';
  assert.match(saved.content.transcript[0].text, /Lời gốc/u); assert.equal(saved.content.speakers[0].name, 'Cô Hương');
  assert.deepEqual(Object.keys(saved.content), ['duration', 'transcript', 'speakers', 'processed', 'language', 'model']);
  assert.equal(saved.content.notes, undefined); assert.equal(saved.content.files, undefined); assert.equal(saved.content.words, undefined);
});

test('manual edits group within a fixed five-minute window, including speaker edits', () => {
  const a = fixture(), b = withHistory(a, edit(a, 'b'), { now: 1000 });
  const c = withHistory(b, edit(b, 'c'), { now: 1000 + HISTORY_EDIT_WINDOW - 1 });
  assert.equal(c.transcriptHistory.entries.length, 1); assert.equal(firstId(c), firstId(b));
  const d = withHistory(c, { ...c, speakers: [{ ...c.speakers[0], name: 'Giảng viên' }] }, { now: 1000 + HISTORY_EDIT_WINDOW });
  assert.equal(d.transcriptHistory.entries.length, 2); assert.equal(d.transcriptHistory.entries[0].content.transcript[0].text, 'c');
  assert.equal(d.transcriptHistory.editGroup.startedAt, 1000 + HISTORY_EDIT_WINDOW);
  const clockBack = withHistory(d, edit(d, 'Sau đổi đồng hồ'), { now: 500 });
  assert.equal(clockBack.transcriptHistory.entries.length, 3);
});

test('checkpoints deduplicate consecutive identical content and start a fresh edit group', () => {
  const a = checkpoint(fixture());
  const b = checkpoint(a, { reason: 'transcript', now: 2000 });
  assert.equal(b.transcriptHistory.entries.length, 1); assert.equal(firstId(b), firstId(a)); assert.equal(b.transcriptHistory.editGroup, null);
  const c = withHistory(b, edit(b, 'b'), { now: 2000 });
  const d = withHistory(c, edit(c, 'c'), { now: 3000 });
  assert.equal(d.transcriptHistory.entries.length, 1); assert.equal(d.transcriptHistory.editGroup.startedAt, 2000);
});

test('AI, subtitle and restore replacements break manual edit grouping', () => {
  for (const reason of ['transcript', 'speakers', 'subtitles', 'restore']) {
    const a = fixture(), b = withHistory(a, edit(a, 'b'), { now: 1000 });
    const c = withHistory(b, edit(b, 'c'), { reason, now: 2000 });
    assert.equal(c.transcriptHistory.entries.length, 2); assert.equal(c.transcriptHistory.editGroup, null);
    assert.equal(c.transcriptHistory.entries[0].reason, reason);
    const d = withHistory(c, edit(c, 'd'), { now: 3000 }); assert.equal(d.transcriptHistory.entries.length, 3);
  }
});

test('history retains the most recent twenty versions and counts exact serialized byte boundaries', () => {
  let project = edit(fixture(), 'v0');
  for (let i = 1; i <= 25; i++) project = withHistory(project, edit(project, `v${i}`), { reason: 'subtitles', now: i * 1000 });
  assert.equal(project.transcriptHistory.entries.length, HISTORY_LIMIT);
  assert.equal(project.transcriptHistory.entries[0].content.transcript[0].text, 'v24');
  assert.equal(project.transcriptHistory.entries.at(-1).content.transcript[0].text, 'v5');
  const a = fixture(), saved = checkpoint(a), exactBytes = Buffer.byteLength(JSON.stringify(saved.transcriptHistory.entries));
  const exact = checkpoint(a, { maxBytes: exactBytes }); assert.equal(exact.transcriptHistory.entries.length, 1);
  const before = structuredClone(a);
  assert.throws(() => checkpoint(a, { maxBytes: exactBytes - 1 }), error => error.status === 413);
  assert.deepEqual(a, before);
  const b = edit(saved, 'b');
  const limited = withHistory(b, edit(b, 'c'), { reason: 'subtitles', maxBytes: exactBytes, now: 2000 });
  assert.equal(limited.transcriptHistory.entries.length, 1); assert.equal(limited.transcriptHistory.entries[0].content.transcript[0].text, 'b');
});

test('history metadata and previews report the effect of restoring lines and speakers', () => {
  const a = fixture(); a.transcript.push({ ...a.transcript[0], id: 'line-2', time: 6, end: 9 });
  const b = withHistory(a, { ...edit(a, 'Thay đoạn đầu'), transcript: [{ ...a.transcript[0], text: 'Thay đoạn đầu' }, { ...a.transcript[1], id: 'line-3' }],
    speakers: [{ ...a.speakers[0], name: 'Đổi tên' }, { id: 's2', name: 'Khách mời', color: '#ec8068' }] }, { reason: 'subtitles' });
  const list = listHistory(b), preview = previewHistory(b, firstId(b));
  assert.equal(list.versions[0].transcriptCount, 2); assert.deepEqual(list.versions[0].speakerNames, ['Cô Hương']);
  assert.equal(list.versions[0].isCurrent, false); assert.equal(list.versions[0].content, undefined);
  assert.deepEqual(preview.comparison, { added: 1, removed: 1, changed: 1, speakersChanged: 2 });
  assert.equal(preview.currentFingerprint, historyFingerprint(b)); assert.deepEqual(preview.transcript, a.transcript);
  assert.equal(listHistory(checkpoint(a)).versions[0].isCurrent, true);
});

test('restore replaces editorial content, preserves current notes/audio/noise, rebuilds insights and is reversible', () => {
  const a = fixture();
  let b = withHistory(a, { ...edit(a, 'Nội dung mới cần lưu lại trước khi khôi phục.'), language: 'en', model: 'base',
    speakers: [{ ...a.speakers[0], name: 'Tên đã đổi' }] }, { reason: 'subtitles' });
  b = { ...b, name: 'Tên dự án hiện tại', files: { ...b.files, clean: 'new-clean.mp3' },
    notes: [...b.notes, { id: 'n2', time: 7, text: 'Ghi chú thêm sau phiên bản.' }], processed: { ...b.processed, noise: false } };
  const originalId = firstId(b), preview = previewHistory(b, originalId), untouched = structuredClone(b);
  const restored = withHistory(b, restoreHistory(b, originalId, preview.currentFingerprint), { reason: 'restore' });
  assert.deepEqual(b, untouched); assert.deepEqual(restored.transcript, a.transcript); assert.deepEqual(restored.speakers, a.speakers);
  assert.equal(restored.name, b.name); assert.deepEqual(restored.notes, b.notes); assert.deepEqual(restored.files, b.files);
  assert.equal(restored.processed.noise, false); assert.equal(restored.model, 'tiny'); assert.equal(restored.language, 'vi');
  assert.equal(restored.transcriptEdited, true); assert.deepEqual(restored.words, []); assert.deepEqual(restored.turns, []);
  assert.equal(restored.queueCheckpoint, undefined); assert.equal(insightsAreCurrent(restored), true);
  assert.equal(restored.transcriptHistory.entries[0].reason, 'restore');
  const undo = restoreHistory(restored, firstId(restored), historyFingerprint(restored));
  assert.deepEqual(undo.transcript, b.transcript); assert.deepEqual(undo.speakers, b.speakers); assert.deepEqual(undo.notes, b.notes);
});

test('an empty unprocessed transcript can be restored without stale model or insights', () => {
  const a = fixture(); a.transcript = []; a.speakers = []; a.language = null; delete a.model;
  a.processed = { noise: true, transcript: false, speakers: false };
  const b = withHistory(a, fixture(), { reason: 'transcript' });
  const restored = restoreHistory(b, firstId(b), historyFingerprint(b));
  assert.deepEqual(restored.transcript, []); assert.deepEqual(restored.speakers, []); assert.equal(restored.model, undefined);
  assert.equal(restored.language, null); assert.equal(restored.insights, null); assert.equal(restored.processed.transcript, false);
  assert.equal(restored.processed.speakers, false);
});

test('stale previews reject transcript or speaker changes, but permit newer notes and audio state', () => {
  const a = fixture(), b = withHistory(a, edit(a, 'Nội dung mới'), { reason: 'subtitles' });
  const id = firstId(b), preview = previewHistory(b, id);
  for (const changed of [edit(b, 'Đã đổi sau preview'), { ...b, speakers: [{ ...b.speakers[0], name: 'Tên mới' }] }]) {
    assert.throws(() => restoreHistory(changed, id, preview.currentFingerprint), error => error.status === 409);
  }
  const notes = [...b.notes, { id: 'new-note', time: 3, text: 'Ghi chú tab khác.' }];
  const result = restoreHistory({ ...b, notes, processed: { ...b.processed, noise: false } }, id, preview.currentFingerprint);
  assert.deepEqual(result.notes, notes); assert.equal(result.processed.noise, false);
});

test('retrying a successful restore is idempotent even with the old preview fingerprint', () => {
  const a = fixture(), b = withHistory(a, edit(a, 'Nội dung mới'), { reason: 'subtitles' });
  const id = firstId(b), expected = historyFingerprint(b);
  const restored = withHistory(b, restoreHistory(b, id, expected), { reason: 'restore' });
  assert.equal(restoreHistory(restored, id, expected), restored);
  assert.equal(withHistory(restored, restoreHistory(restored, id, expected), { reason: 'restore' }), restored);
});

test('restoring the oldest version can be retried after retention evicts that entry and the server restarts', () => {
  let project = edit(fixture(), 'v0');
  for (let i = 1; i <= HISTORY_LIMIT; i++) project = withHistory(project, edit(project, `v${i}`), { reason: 'subtitles', now: i * 1000 });
  const oldestId = project.transcriptHistory.entries.at(-1).id, expected = historyFingerprint(project);
  const restored = withHistory(project, restoreHistory(project, oldestId, expected), { reason: 'restore' });
  assert.equal(restored.transcript[0].text, 'v0'); assert.equal(restored.transcriptHistory.entries.length, HISTORY_LIMIT);
  assert.ok(!restored.transcriptHistory.entries.some(entry => entry.id === oldestId));
  const reopened = JSON.parse(JSON.stringify(restored)); assert.equal(restoreHistory(reopened, oldestId, expected), reopened);
  assert.throws(() => restoreHistory(edit(reopened, 'Thay đổi sau khôi phục'), oldestId, expected), error => error.status === 404);
});

test('missing versions and corrupt history headers fail without changing the project', () => {
  const a = checkpoint(fixture());
  assert.throws(() => previewHistory(a, randomUUID()), error => error.status === 404);
  assert.throws(() => previewHistory(a, 'not-a-uuid'));
  for (const mutate of [h => h.version = 2, h => h.entries.push(h.entries[0]), h => h.entries[0].reason = 'bad', h => h.entries[0].content.speakers = {}]) {
    const bad = structuredClone(a); mutate(bad.transcriptHistory); const before = structuredClone(bad);
    assert.throws(() => listHistory(bad), error => error.status === 409); assert.deepEqual(bad, before);
  }
});

test('corrupt content, hashes, references and timing cannot be previewed, restored or deduplicated away', () => {
  const saved = checkpoint(fixture());
  for (const mutate of [c => c.transcript[0].text = 'Sai hash', c => c.duration = 120, c => c.transcript[0].speaker = 'missing',
    c => c.transcript[0].end = 61, c => c.transcript.push(c.transcript[0]), c => c.speakers.push(c.speakers[0]), c => c.transcript[0].confidence = 101]) {
    for (const rehash of [false, true]) {
      const bad = structuredClone(saved), entry = bad.transcriptHistory.entries[0]; mutate(entry.content);
      if (rehash) entry.fingerprint = digest(entry.content);
      // A valid text change with its own matching hash is a legitimate version.
      if (rehash && entry.content.transcript[0].text === 'Sai hash') continue;
      const before = structuredClone(bad);
      assert.throws(() => previewHistory(bad, entry.id), error => error.status === 409);
      assert.throws(() => restoreHistory(bad, entry.id, historyFingerprint(bad)), error => error.status === 409);
      assert.deepEqual(bad, before);
    }
  }
  const bad = structuredClone(saved); bad.transcriptHistory.entries[0].content.transcript[0].text = 'Sai hash';
  assert.throws(() => withHistory(bad, edit(bad, 'Thay mới')), error => error.status === 409);
});

test('historical transcripts are excluded from ordinary project responses', () => {
  const project = checkpoint(fixture()), view = publicProject(project);
  assert.equal(view.transcriptHistory, undefined); assert.equal(view.words, undefined); assert.equal(view.files, undefined);
  assert.deepEqual(view.transcript, project.transcript); assert.deepEqual(view.notes, project.notes);
});

test('failed atomic persistence keeps both old transcript and its history, then retry commits both', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-history-test-')), file = path.join(directory, 'project.json');
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('audio-history-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const a = checkpoint(fixture()); await atomicQueueWrite(file, a); const before = await fs.readFile(file);
  const b = withHistory(a, edit(a, 'Thay đổi chưa được ghi'), { reason: 'subtitles' });
  const original = fs.rename;
  const rename = t.mock.method(fs, 'rename', async (source, target) => { if (target === file) throw Object.assign(new Error('disk failure'), { code: 'EIO' }); return original(source, target); });
  await assert.rejects(atomicQueueWrite(file, b), /disk failure/); rename.mock.restore();
  assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readdir(directory), ['project.json']);
  await atomicQueueWrite(file, b); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), b);
});
