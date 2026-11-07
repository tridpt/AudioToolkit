import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeSubtitle, parseTimestamp, parseSubtitle, prepareImportedTranscript, MAX_SUBTITLE_BYTES } from '../public/subtitles.js';
import { createExport } from '../public/exports.js';
import { insightsAreCurrent } from '../public/insights.js';
import { editSchema, validateEdits } from '../server/domain.mjs';
import { SubtitleStore, applySubtitleImport } from '../server/subtitles.mjs';

const srt = '1\n00:00:01,250 --> 00:00:04,500\nCô Hương: Bài giảng giữ tiếng Việt: ă â đ ê ô ơ ư.\nDòng thứ hai.\n\n2\n00:00:05,000 --> 00:00:08,000\nKhách mời: Nội dung &amp; trích dẫn &lt;b&gt;nguyên văn&lt;/b&gt;.\n';
const fixture = () => ({ id: randomUUID(), name: 'Bài giảng', duration: 60, language: 'vi',
  processed: { noise: true, transcript: true, speakers: true }, files: { source: 'source.wav' },
  speakers: [{ id: 's1', name: 'Cô Hương', color: '#7472e9' }],
  transcript: [{ id: 'old', time: 0, end: 3, speaker: 's1', confidence: 90, text: 'Nội dung cũ.' }],
  notes: [{ id: 'n1', time: 1.25, text: 'Ghi chú vẫn được giữ.' }],
  words: [{ start: 0, end: 1, text: 'cũ' }], turns: [{ start: 0, end: 3, speaker: 's1' }],
  queueCheckpoint: { itemId: randomUUID(), completed: ['noise', 'transcript', 'speakers'] }, insights: { old: true } });
const invalid = callback => assert.throws(callback, error => error.status === 400);
const missing = error => error.status === 410;

test('SRT preserves Vietnamese, multiline text, identifiers, spaced blank lines and escaped literals', () => {
  const parsed = parseSubtitle('\uFEFF' + srt.replace(/\n/g, '\r\n').replace('\r\n\r\n', '\r\n \t\r\n'), { duration: 60 });
  assert.equal(parsed.format, 'srt'); assert.equal(parsed.cues.length, 2);
  assert.deepEqual(parsed.speakerNames, ['Cô Hương', 'Khách mời']);
  assert.equal(parsed.cues[0].start, 1.25); assert.equal(parsed.cues[0].end, 4.5);
  assert.match(parsed.cues[0].text, /ư\.\nDòng thứ hai\./u);
  assert.equal(parsed.cues[1].text, 'Nội dung & trích dẫn <b>nguyên văn</b>.');
});

test('WebVTT handles metadata, settings, identifiers, voice classes, formatting and inline timestamps', () => {
  const text = 'WEBVTT - Bài giảng\nKind: captions\nLanguage: vi\n\nNOTE Bình luận\n00:00:00.000 --> ignored\n\nSTYLE\n::cue { color: red; }\n\nREGION\nid:region1\n\ncue-a\n00:01.250 --> 00:04.500 align:start position:10%\n<v.teacher Cô Hương><b>Xin</b> <00:02.000>chào &quot;bạn&quot;.</v>\n\n00:05.000 --> 00:08.000\n<v Khách mời>Thứ hai.</v>\n';
  const parsed = parseSubtitle(text, { duration: 60 });
  assert.equal(parsed.format, 'vtt'); assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].text, 'Xin chào "bạn".'); assert.equal(parsed.cues[0].speaker, 'Cô Hương');
  assert.equal(parsed.cues[1].speaker, 'Khách mời');
});

test('subtitle export round trips preserve names, escaped text and millisecond timing', () => {
  const project = applySubtitleImport(fixture(), parseSubtitle(srt));
  for (const type of ['srt', 'vtt']) {
    const parsed = parseSubtitle(createExport(project, type).content, { duration: project.duration });
    assert.equal(parsed.format, type);
    assert.deepEqual(parsed.cues.map(({ start, end, text, speaker }) => ({ start, end, text, speaker })), project.transcript.map(line => ({
      start: line.time, end: line.end, text: line.text.replace(/\n/g, ' '), speaker: project.speakers.find(speaker => speaker.id === line.speaker).name,
    })));
  }
});

test('UTF-8 BOM, UTF-16 LE/BE with and without BOM decode without damaging diacritics', () => {
  const le = Buffer.from(srt, 'utf16le'), be = Buffer.from(le).swap16();
  for (const input of [Buffer.from('\uFEFF' + srt), Buffer.concat([Buffer.from([255, 254]), le]), Buffer.concat([Buffer.from([254, 255]), be]), le, be]) {
    assert.equal(decodeSubtitle(input), srt);
    assert.equal(parseSubtitle(input).cues[0].speaker, 'Cô Hương');
  }
  invalid(() => decodeSubtitle(Buffer.from([0xC3, 0x28])));
  invalid(() => decodeSubtitle(Buffer.from([255, 254, 0x61])));
  invalid(() => decodeSubtitle('text\u0000'));
});

test('timestamps support comma/dot milliseconds and reject invalid ranges and non-finite data', () => {
  for (const [value, expected] of [['01:02:03,456', 3723.456], ['01:02:03.456', 3723.456], ['02:03.4', 123.4], ['00:00:01,02', 1.02]]) assert.equal(parseTimestamp(value), expected);
  for (const value of ['-00:01.000', '00:60:00,000', '00:00:60.000', '60:00.000', '00:00:00.1234', 'Infinity', '1', '01:02junk']) invalid(() => parseTimestamp(value));
});

test('bad timing, unsorted cues, missing separators and empty payloads fail rather than losing content', () => {
  for (const input of ['', 'not subtitles', '1\n00:bad --> 00:02.000\nText', '1\n00:03.000 --> 00:02.000\nText',
    '1\n00:00.000 --> 00:01.000\n<b></b>', 'WEBVTT\n\nmalformed block',
    'WEBVTT\n00:00.000 --> 00:01.000\nFirst\n\n00:02.000 --> 00:03.000\nSecond',
    '1\n00:00.000 --> 00:01.000\nFirst\n2\n00:02.000 --> 00:03.000\nSecond',
    '1\n00:02.000 --> 00:03.000\nFirst\n\n2\n00:01.000 --> 00:02.000\nSecond']) invalid(() => parseSubtitle(input));
});

test('ordered overlapping cues are retained and counted, with the furthest end in preview', () => {
  const text = 'WEBVTT\n\n00:01.000 --> 00:10.000\n<v A>Lời dài.</v>\n\n00:02.000 --> 00:03.000\n<v B>Nói chồng.</v>';
  const parsed = parseSubtitle(text); assert.equal(parsed.overlappingCueCount, 1);
  const review = new SubtitleStore().inspect(text, 'overlap.vtt', fixture());
  assert.equal(review.lastTime, 10); assert.equal(review.overlappingCueCount, 1);
});

test('duration tolerance permits rounding only, and never collapses a positive cue on import', () => {
  invalid(() => parseSubtitle(srt, { duration: 3 }));
  invalid(() => parseSubtitle(srt, { duration: NaN }));
  const parsed = parseSubtitle('1\n00:01.000 --> 00:01.001\nNội dung', { duration: 1.0004 });
  const prepared = prepareImportedTranscript(parsed, { speakers: [] });
  assert.equal(prepared.transcript[0].end, 1.0004); assert.ok(prepared.transcript[0].end > prepared.transcript[0].time);
});

test('file, cue, text and speaker limits produce actionable errors', () => {
  invalid(() => parseSubtitle(Buffer.alloc(MAX_SUBTITLE_BYTES + 1, 0x20)));
  invalid(() => parseSubtitle('a'.repeat(MAX_SUBTITLE_BYTES + 1)));
  invalid(() => parseSubtitle(srt, { maxCues: 1 }));
  const repeatedCues = Array.from({ length: 20001 }, (_, index) => `${index + 1}\n00:00.000 --> 00:01.000\nNội dung.`).join('\n\n');
  invalid(() => parseSubtitle(repeatedCues));
  invalid(() => parseSubtitle('1\n00:00.000 --> 00:01.000\n' + 'a'.repeat(5001)));
  invalid(() => parseSubtitle('WEBVTT\n\n00:00.000 --> 00:01.000\n<v ' + 'N'.repeat(41) + '>Nội dung.</v>'));
  const manySpeakers = { ...fixture(), speakers: Array.from({ length: 20 }, (_, index) => ({ id: `s-${index}`, name: `Người ${index}`, color: '#7472e9' })) };
  invalid(() => prepareImportedTranscript(parseSubtitle(srt), manySpeakers));
  invalid(() => parseSubtitle('1\n00:00.000 --> 00:01.000\n' + 'x\n'.repeat(100000)));
  invalid(() => parseSubtitle('1\n00:00.000 --> 00:01.000\n' + '<v.a'.repeat(5000)));
});

test('entities decode once, controls cannot be smuggled, and multiple voices never get silently misassigned', () => {
  const text = parseSubtitle('1\n00:00.000 --> 00:01.000\n&#272;úng &amp;lt; &#x1F3A4; &apos;câu&apos;.').cues[0].text;
  assert.equal(text, "Đúng &lt; 🎤 'câu'.");
  invalid(() => parseSubtitle('1\n00:00.000 --> 00:01.000\n&#0; Xin chào'));
  invalid(() => parseSubtitle('1\n00:00.000 --> 00:01.000\n&#xD800; Xin chào'));
  invalid(() => parseSubtitle('WEBVTT\n\n00:00.000 --> 00:01.000\n<v A>Thứ nhất.</v> <v B>Thứ hai.</v>'));
  assert.equal(parseSubtitle('1\n00:00.000 --> 00:01.000\n…').cues[0].text, '…');
});

test('speaker matching is Unicode/case insensitive; unlabelled cues get a stable fallback', () => {
  const project = fixture(); const before = structuredClone(project);
  const parsed = parseSubtitle(srt.replace('Cô Hương', 'cô hương'.normalize('NFD')));
  const prepared = prepareImportedTranscript(parsed, project);
  assert.equal(prepared.transcript[0].speaker, 's1'); assert.equal(prepared.speakers.length, 2);
  assert.equal(prepared.speakers[1].name, 'Khách mời'); assert.deepEqual(project, before);
  const plain = parseSubtitle('1\n00:00.000 --> 00:01.000\nNội dung không nhãn.');
  assert.equal(prepareImportedTranscript(plain, project).transcript[0].speaker, 's1');
  const empty = prepareImportedTranscript(plain, { speakers: [] });
  assert.equal(empty.speakers[0].name, 'Người nói 1'); assert.equal(empty.transcript[0].speaker, empty.speakers[0].id);
  assert.doesNotThrow(() => editSchema.parse(prepared)); assert.doesNotThrow(() => validateEdits(project, prepared));
});

test('import clears stale alignment/checkpoint and regenerates insights while preserving audio, notes and noise result', () => {
  const project = fixture(), before = structuredClone(project), imported = applySubtitleImport(project, parseSubtitle(srt));
  assert.deepEqual(project, before); assert.deepEqual(imported.notes, before.notes); assert.deepEqual(imported.files, before.files);
  assert.deepEqual(imported.words, []); assert.deepEqual(imported.turns, []); assert.equal(imported.queueCheckpoint, undefined);
  assert.deepEqual(imported.processed, { noise: true, transcript: true, speakers: false });
  assert.equal(imported.transcriptEdited, true); assert.equal(insightsAreCurrent(imported), true);
  assert.equal(imported.transcript[0].confidence, null);
  const punctuation = applySubtitleImport(project, parseSubtitle('1\n00:00.000 --> 00:01.000\n…'));
  assert.equal(punctuation.insights, null);
});

test('inspect does not mutate the project; commits use latest notes and repeated tokens cannot replace later edits', async () => {
  let saved = fixture(); const before = structuredClone(saved), store = new SubtitleStore();
  const review = store.inspect(srt, 'bài giảng.srt', saved);
  assert.deepEqual(saved, before); assert.equal(review.cueCount, 2); assert.equal(review.replacesTranscript, true);
  assert.equal(review.transcriptPreview[0].speaker, 'Cô Hương');
  saved.notes.push({ id: 'n2', time: 6, text: 'Thêm sau preview.' });
  const mutate = async (id, operation) => { assert.equal(id, saved.id); const next = operation(structuredClone(saved)); saved = next; return next; };
  await store.commit(review.token, saved.id, mutate);
  assert.equal(saved.notes.length, 2); assert.equal(saved.transcript.length, 2);
  saved.transcript[0].text = 'Chỉnh sau khi nhập.';
  await store.commit(review.token, saved.id, mutate); assert.equal(saved.transcript[0].text, 'Chỉnh sau khi nhập.');
});

test('stale preview and failed persistence never overwrite a project; persistence can be retried', async () => {
  const project = fixture(), store = new SubtitleStore(), review = store.inspect(srt, 'file.srt', project);
  const changed = structuredClone(project); changed.transcript[0].text = 'Đã chỉnh ở tab khác.';
  await assert.rejects(store.commit(review.token, project.id, async (_id, operation) => operation(changed)), error => error.status === 409);
  assert.equal(changed.transcript[0].text, 'Đã chỉnh ở tab khác.');
  const renamed = structuredClone(project); renamed.speakers[0].name = 'Tên vừa đổi';
  await assert.rejects(store.commit(review.token, project.id, async (_id, operation) => operation(renamed)), error => error.status === 409);
  await assert.rejects(store.commit(review.token, project.id, async (_id, operation) => { operation(project); throw new Error('Disk full'); }), /Disk full/u);
  const imported = await store.commit(review.token, project.id, async (_id, operation) => operation(project));
  assert.equal(imported.transcript.length, 2); assert.equal(project.transcript[0].id, 'old');
});

test('expired, discarded, mismatched and duplicate in-flight tokens are guarded; previews are bounded', async () => {
  let now = Date.now(); const project = fixture(), store = new SubtitleStore({ now: () => now, lifetime: 1000, maxSessions: 2 });
  const first = store.inspect(srt, 'file.srt', project);
  assert.throws(() => store.get(first.token, randomUUID()), error => error.status === 404);
  invalid(() => store.inspect('broken', 'file.srt', project)); invalid(() => store.inspect(srt, 'file.exe', project));
  invalid(() => store.inspect(srt, 'file.srt', { ...project, id: 'demo' }));
  let release; const pending = store.commit(first.token, project.id, async (_id, operation) => { await new Promise(resolve => { release = resolve; }); return operation(project); });
  await assert.rejects(store.commit(first.token, project.id, async () => project), error => error.status === 409);
  store.discard(first.token); assert.ok(store.get(first.token, project.id)); release(); await pending;
  const second = store.inspect(srt, 'file.srt', project), third = store.inspect(srt, 'file.srt', project);
  assert.throws(() => store.get(first.token, project.id), missing);
  store.discard(second.token); assert.throws(() => store.get(second.token, project.id), missing);
  now += 1001; store.cleanup(); assert.throws(() => store.get(third.token, project.id), missing);
  assert.equal(store.sessions.size, 0);
});
