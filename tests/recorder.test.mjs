import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioRecorder, recordingMimeType, recordingFilename, recordingError } from '../public/recorder.js';

class Track extends EventTarget {
  readyState = 'live';
  stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
}
const stream = () => { const track = new Track(); return { track, getTracks: () => [track], getAudioTracks: () => [track] }; };
class Capture extends EventTarget {
  static isTypeSupported(type) { return type.startsWith('audio/webm'); }
  constructor(source, options = {}) { super(); this.source = source; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  chunk(text = 'audio') { this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([text], { type: this.mimeType }) })); }
  stop() { this.state = 'inactive'; queueMicrotask(() => { this.chunk('final'); this.dispatchEvent(new Event('stop')); }); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let time = 0, tick;
  const source = stream();
  const recorder = new AudioRecorder({ mediaDevices: { getUserMedia: async () => source }, Recorder: Capture, now: () => time, every: callback => { tick = callback; return 1; }, cancelEvery: () => {}, ...options });
  return { recorder, source, advance: milliseconds => { time += milliseconds; }, tick: () => tick() };
}

test('recording clock excludes pauses and the final data event is retained before tracks are released', async () => {
  const { recorder, source, advance } = fixture();
  assert.equal(recorder.unsaved, false);
  await recorder.start(); advance(1500); recorder.capture.chunk('first');
  recorder.pause(); advance(8000); assert.equal(recorder.duration, 1.5);
  recorder.resume(); advance(1250); recorder.stop();
  assert.equal(recorder.phase, 'stopping'); assert.equal(source.track.readyState, 'ended');
  await flush();
  assert.equal(recorder.duration, 2.75); assert.equal(recorder.phase, 'ready');
  assert.equal(await recorder.blob.text(), 'firstfinal');
  assert.equal(recorder.unsaved, true); assert.equal(source.track.stops, 1);
  recorder.saved = true; assert.equal(recorder.unsaved, false);
});

test('cancelling a pending microphone request releases late streams and cannot overwrite a newer session', async () => {
  let resolve;
  const source = stream();
  const { recorder } = fixture({ mediaDevices: { getUserMedia: () => new Promise(done => { resolve = done; }) } });
  const pending = recorder.start(); assert.equal(recorder.phase, 'requesting');
  recorder.cancelRequest(); assert.equal(recorder.phase, 'idle');
  resolve(source); await pending;
  assert.equal(source.track.stops, 1); assert.equal(recorder.phase, 'idle'); assert.equal(recorder.blob, null);
});

test('permission denial and capture setup failures leave no live microphone', async () => {
  const denied = fixture({ mediaDevices: { getUserMedia: async () => { throw { name: 'NotAllowedError' }; } } }).recorder;
  await denied.start(); assert.equal(denied.phase, 'idle'); assert.match(denied.error, /phép dùng micro/);
  const source = stream();
  class BrokenCapture { static isTypeSupported() { return false; } constructor() { throw new Error('Unavailable'); } }
  const { recorder } = fixture({ mediaDevices: { getUserMedia: async () => source }, Recorder: BrokenCapture });
  await recorder.start(); assert.equal(source.track.stops, 1); assert.equal(recorder.phase, 'idle'); assert.ok(recorder.error);
});

test('microphone disconnection finalizes and preserves the recorded portion', async () => {
  const { recorder, source, advance } = fixture();
  await recorder.start(); advance(2000); recorder.capture.chunk('retained');
  source.track.dispatchEvent(new Event('ended')); await flush();
  assert.equal(recorder.phase, 'ready'); assert.match(recorder.notice, /ngắt kết nối/);
  assert.equal(await recorder.blob.text(), 'retainedfinal'); assert.equal(recorder.stream, null);
});

test('time and byte limits stop recording and preserve a downloadable result', async () => {
  const timed = fixture({ maxSeconds: 2 }); await timed.recorder.start(); timed.advance(2100); timed.tick(); await flush();
  assert.equal(timed.recorder.phase, 'ready'); assert.match(timed.recorder.notice, /giới hạn 2 giờ/);
  const sized = fixture({ maxBytes: 5 }); await sized.recorder.start(); sized.recorder.capture.chunk('123456'); await flush();
  assert.equal(sized.recorder.phase, 'ready'); assert.match(sized.recorder.notice, /250 MB/);
  assert.ok(sized.recorder.blob.size >= 6);
});

test('unsupported browsers report a useful error without requesting a microphone', async () => {
  const { recorder } = fixture({ Recorder: undefined });
  await recorder.start(); assert.equal(recorder.phase, 'idle'); assert.match(recorder.error, /hỗ trợ thu âm/);
  assert.match(recordingError({ name: 'NotFoundError' }), /Không tìm thấy micro/);
});

test('reset cannot discard an active recording and a new take requires an explicit reset', async () => {
  const { recorder, advance } = fixture(); await recorder.start(); recorder.reset(); assert.equal(recorder.phase, 'recording');
  advance(1000); recorder.stop(); await flush(); const previous = recorder.blob;
  await recorder.start(); assert.equal(recorder.blob, previous); assert.equal(recorder.phase, 'ready');
  recorder.reset(); assert.equal(recorder.blob, null); assert.equal(recorder.unsaved, false); assert.equal(recorder.duration, 0);
});

test('format negotiation falls back and filenames keep Vietnamese without filesystem control characters', () => {
  assert.equal(recordingMimeType(Capture), 'audio/webm;codecs=opus');
  assert.equal(recordingMimeType({ isTypeSupported: () => false }), '');
  assert.equal(recordingFilename('Bài giảng / "ý tưởng"\r\n', 'audio/webm;codecs=opus'), 'Bài giảng  ý tưởng.webm');
  assert.equal(recordingFilename('', 'audio/mp4'), 'Bản thu mới.m4a');
  assert.equal(recordingFilename('Phỏng vấn', 'audio/ogg'), 'Phỏng vấn.ogg');
});
