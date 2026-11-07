import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';

const base = process.env.AUDIO_URL || 'http://127.0.0.1:4188';
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const getProject = async () => (await fetch(`${base}/api/projects/demo`)).json();
const before = await getProject();
const directory = 'data/checks/clips';
await fs.mkdir(directory, { recursive: true });
const cases = [
  { start: 3.125, end: 9.875, variant: 'original', format: 'wav' },
  { start: 3.125, end: 9.875, variant: 'clean', format: 'mp3' },
  { start: before.duration - .5, end: before.duration, variant: 'original', format: 'wav' },
  { start: 0, end: .25, variant: 'original', format: 'mp3' },
];
for (const [index, options] of cases.entries()) {
  const response = await fetch(`${base}/api/projects/demo/clips`, json(options));
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.match(result.url, /^\/api\/clips\/[0-9a-f-]{36}$/);
  assert.equal(result.duration, options.end - options.start);
  const download = await fetch(base + result.url);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.match(download.headers.get('content-type'), /^audio\//);
  const target = `${directory}/clip-${index}.${options.format}`;
  await fs.writeFile(target, Buffer.from(await download.arrayBuffer()));
  const media = JSON.parse(execFileSync(ffprobe.path, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', target], { windowsHide: true }));
  assert.equal(media.streams.filter(stream => stream.codec_type === 'audio').length, 1);
  const tolerance = options.format === 'wav' ? .001 : .08;
  assert.ok(Math.abs(Number(media.format.duration) - result.duration) < tolerance, `${options.format}: ${media.format.duration} vs ${result.duration}`);
  const range = await fetch(base + result.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  if (index === 0) {
    const decode = args => execFileSync(ffmpeg, ['-v', 'error', ...args, '-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le', '-'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const expected = decode(['-ss', String(options.start), '-i', 'public/demo/original.wav', '-t', String(result.duration)]);
    const actual = decode(['-i', target]);
    assert.deepEqual(actual, expected, 'The exported PCM must contain the requested source samples.');
  }
}
for (const patch of [{ start: -1 }, { end: before.duration + 1 }, { end: 3 }, { end: 3.2 }, { format: 'aac' }, { start: '3' }, { file: '../private' }]) {
  const response = await fetch(`${base}/api/projects/demo/clips`, json({ ...cases[0], ...patch }));
  assert.equal(response.status, 400, JSON.stringify(patch));
}
const outside = await fetch(`${base}/api/projects/demo/clips`, { ...json(cases[0]), headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' } });
assert.equal(outside.status, 403);
const missing = await fetch(`${base}/api/clips/00000000-0000-4000-8000-000000000000`);
assert.equal(missing.status, 404);
const health = async () => (await (await fetch(`${base}/api/health`)).json());
const filesBefore = (await fs.readdir('data/tmp/clips')).sort();
const controller = new AbortController();
const pending = fetch(`${base}/api/projects/demo/clips`, { ...json({ ...cases[1], start: 0, end: before.duration }), signal: controller.signal }).catch(error => error);
let observedActive = false;
for (let attempt = 0; attempt < 100; attempt++) {
  if ((await health()).activeClip) { observedActive = true; break; }
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.ok(observedActive, 'The running export must be visible in health.');
const concurrent = await fetch(`${base}/api/projects/demo/clips`, json(cases[0]));
assert.equal(concurrent.status, 409, 'Concurrent exports must not start another FFmpeg process.');
controller.abort();
assert.equal((await pending).name, 'AbortError');
for (let attempt = 0; (await health()).activeClip && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
assert.equal((await health()).activeClip, null);
assert.deepEqual((await fs.readdir('data/tmp/clips')).sort(), filesBefore, 'Cancelling must remove its partial file.');
assert.deepEqual(await getProject(), before, 'Clipping must preserve the source project.');
assert.equal((await (await fetch(`${base}/api/health`)).json()).activeClip, null);
console.log(JSON.stringify({ result: 'passed', clips: cases.length, checked: ['PCM source samples', 'MP3/WAV durations', 'original/clean', 'recording boundaries', 'HTTP Range', 'invalid input', 'origin', 'project preservation', 'concurrency', 'cancellation cleanup'] }, null, 2));
