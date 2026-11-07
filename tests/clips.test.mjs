import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClipTime, formatClipTime, clipRangeError, selectedClipRange, clipFilename } from '../public/clips.js';
import { validateClip } from '../server/domain.mjs';

test('clip time inputs preserve milliseconds and support long recordings', () => {
  for (const [input, expected] of [['00:12.500', 12.5], ['1:02:03.125', 3723.125], ['12,345', 12.345], ['120:00', 7200], ['0', 0]]) {
    assert.equal(parseClipTime(input), expected);
    assert.equal(parseClipTime(formatClipTime(expected)), expected);
  }
  assert.equal(formatClipTime(59.9996), '01:00.000');
  for (const invalid of ['', 'abc', '-1', '1e2', '00:60', '01:60:00', '1:2:3:4', '00:01.1234', '1::2', 'Infinity']) assert.ok(Number.isNaN(parseClipTime(invalid)), invalid);
});

test('clip bounds reject reversed, short, non-finite and out-of-recording intervals', () => {
  for (const [start, end] of [[-1, 1], [1, 1], [4, 2], [0, .249], [0, 10.001], [NaN, 1], [0, Infinity]]) assert.ok(clipRangeError(start, end, 10));
  assert.equal(clipRangeError(9.75, 10, 10), '');
  assert.equal(clipRangeError(.1, .35, 10), '');
});

test('range selection includes unselected middle passages, silence and overlaps in either direction', () => {
  const lines = [{ id: 'c', time: 9, end: 12 }, { id: 'a', time: 1.1234, end: 5 }, { id: 'b', time: 3, end: 10 }];
  const selection = selectedClipRange(lines, 'c', 'a', 11.9999);
  assert.deepEqual(selection, { start: 1.123, end: 11.999, lines: [lines[1], lines[2], lines[0]] });
  assert.deepEqual(selectedClipRange(lines, 'a', 'c', 11.9999), selection);
  assert.equal(selectedClipRange(lines, 'deleted', 'a', 12), null);
  assert.equal(selectedClipRange([], null, null, 12), null);
  assert.equal(lines[0].id, 'c');
});

test('clip endpoint schema allows only valid sources, formats and bounded numeric fields', () => {
  const project = { duration: 10, processed: { noise: false } };
  const valid = { start: 1.125, end: 9.875, variant: 'original', format: 'wav' };
  assert.deepEqual(validateClip(project, valid), valid);
  for (const patch of [{ start: '1' }, { end: 11 }, { end: 1 }, { end: 1.2 }, { start: -1 }, { format: '../../file' }, { variant: 'source' }, { file: 'private.wav' }]) assert.throws(() => validateClip(project, { ...valid, ...patch }));
  assert.throws(() => validateClip(project, { ...valid, variant: 'clean' }), error => error.status === 409);
  assert.equal(validateClip({ ...project, processed: { noise: true } }, { ...valid, variant: 'clean' }).variant, 'clean');
});

test('download names preserve Vietnamese and cannot contain path or header characters', () => {
  const name = clipFilename('../Bài giảng: "ý tưởng"\r\n/test', { start: 1.25, end: 61.5, variant: 'original', format: 'mp3' });
  assert.match(name, /Bài giảng ý tưởngtest-clip-00-01-250-01-01-500-original\.mp3$/);
  assert.doesNotMatch(name, /[\\/\r\n:"]/);
});
