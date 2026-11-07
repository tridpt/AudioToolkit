export const RECORDING_MAX_BYTES = 250 * 1024 * 1024;
export const RECORDING_MAX_SECONDS = 7199;

export function recordingMimeType(Recorder) {
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => Recorder?.isTypeSupported?.(type)) || '';
}

export function recordingFilename(name, mimeType) {
  const extension = /mp4|aac/i.test(mimeType) ? 'm4a' : /ogg/i.test(mimeType) ? 'ogg' : /wav/i.test(mimeType) ? 'wav' : 'webm';
  const stem = String(name).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim().slice(0, 140) || 'Bản thu mới';
  return `${stem}.${extension}`;
}

export function recordingError(error) {
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) return 'Chưa được phép dùng micro. Cho phép micro cho trang này trong trình duyệt rồi thử lại. Nếu khung trình duyệt không hỗ trợ, mở trang bằng Chrome hoặc Edge.';
  if (error?.name === 'NotFoundError') return 'Không tìm thấy micro. Kết nối micro hoặc kiểm tra thiết bị đầu vào của máy.';
  if (['NotReadableError', 'AbortError'].includes(error?.name)) return 'Không mở được micro. Kiểm tra micro có đang bị ứng dụng khác chiếm dụng rồi thử lại.';
  if (error?.name === 'NotSupportedError') return 'Trình duyệt chưa hỗ trợ thu âm. Mở Audio Toolkit bằng Chrome, Edge hoặc Safari mới.';
  return 'Không thể thu âm. Kiểm tra micro và quyền của trình duyệt rồi thử lại.';
}

export class AudioRecorder extends EventTarget {
  constructor({ mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder,
    now = () => performance.now(), every = (callback, milliseconds) => globalThis.setInterval(callback, milliseconds), cancelEvery = id => globalThis.clearInterval(id),
    maxSeconds = RECORDING_MAX_SECONDS, maxBytes = RECORDING_MAX_BYTES - 1024 * 1024 } = {}) {
    super();
    Object.assign(this, { mediaDevices, Recorder, now, every, cancelEvery, maxSeconds, maxBytes });
    this.phase = 'idle';
    this.chunks = [];
    this.bytes = 0;
    this.elapsed = 0;
    this.blob = null;
    this.error = '';
    this.notice = '';
    this.saved = false;
  }

  get duration() { return this.elapsed + (this.phase === 'recording' ? Math.max(0, this.now() - this.startedAt) / 1000 : 0); }
  get active() { return ['requesting', 'recording', 'paused', 'stopping'].includes(this.phase); }
  get unsaved() { return !this.saved && (!!this.blob || this.active && this.phase !== 'requesting'); }
  changed() { this.dispatchEvent(new Event('change')); }

  async start() {
    if (this.active || this.blob) return;
    this.error = ''; this.notice = ''; this.saved = false;
    if (!this.mediaDevices?.getUserMedia || !this.Recorder) {
      this.error = recordingError({ name: 'NotSupportedError' }); this.changed(); return;
    }
    this.phase = 'requesting';
    const request = Symbol('microphone'); this.request = request; this.changed();
    try {
      const stream = await this.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false }, video: false });
      if (this.request !== request) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      if (!stream.getAudioTracks().some(track => track.readyState === 'live')) throw Object.assign(new Error(), { name: 'NotFoundError' });
      const mimeType = recordingMimeType(this.Recorder);
      try { this.capture = new this.Recorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128000 }); }
      catch { this.capture = new this.Recorder(stream); }
      this.chunks = []; this.bytes = 0; this.elapsed = 0;
      this.capture.addEventListener('dataavailable', event => {
        if (event.data?.size) { this.chunks.push(event.data); this.bytes += event.data.size; }
        if (this.bytes >= this.maxBytes && ['recording', 'paused'].includes(this.phase)) {
          this.notice = 'Đã dừng khi gần giới hạn 250 MB. Nghe lại rồi lưu bản thu.'; this.stop();
        }
      });
      this.capture.addEventListener('stop', () => this.finish(), { once: true });
      this.capture.addEventListener('error', () => {
        this.notice = 'Trình duyệt đã ngắt thu âm. Phần đã thu được giữ để nghe lại hoặc tải xuống.';
        this.stop();
      });
      this.trackEnded = () => {
        if (['recording', 'paused'].includes(this.phase)) {
          this.notice = 'Micro đã ngắt kết nối. Phần đã thu được giữ để nghe lại hoặc tải xuống.'; this.stop();
        }
      };
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', this.trackEnded));
      this.capture.start(1000);
      this.startedAt = this.now(); this.phase = 'recording';
      this.timer = this.every(() => {
        if (this.duration >= this.maxSeconds) { this.notice = 'Đã dừng khi gần giới hạn 2 giờ. Nghe lại rồi lưu bản thu.'; this.stop(); }
        else this.changed();
      }, 250);
      this.changed();
    } catch (error) {
      if (this.request !== request) return;
      this.release(); this.phase = 'idle'; this.error = recordingError(error); this.changed();
    }
  }

  pause() {
    if (this.phase !== 'recording') return;
    try {
      this.capture.pause(); this.elapsed = this.duration; this.phase = 'paused'; this.changed();
    } catch { this.error = 'Chưa tạm dừng được. Hãy dừng bản thu để giữ phần đã thu.'; this.changed(); }
  }

  resume() {
    if (this.phase !== 'paused') return;
    try { this.capture.resume(); this.startedAt = this.now(); this.phase = 'recording'; this.error = ''; this.changed(); }
    catch { this.error = 'Chưa tiếp tục được. Hãy dừng bản thu để giữ phần đã thu.'; this.changed(); }
  }

  cancelRequest() {
    if (this.phase !== 'requesting') return;
    this.request = null; this.release(); this.phase = 'idle'; this.changed();
  }

  stop() {
    if (this.phase === 'requesting') return this.cancelRequest();
    if (!['recording', 'paused'].includes(this.phase)) return;
    this.elapsed = this.duration; this.phase = 'stopping';
    this.cancelEvery(this.timer); this.timer = null;
    try { if (this.capture.state !== 'inactive') this.capture.stop(); }
    catch { this.error = 'Bản thu đã bị gián đoạn. Hãy tải file dự phòng nếu có.'; this.finish(); }
    this.release(); this.changed();
  }

  finish() {
    if (this.phase === 'ready') return;
    if (this.phase === 'recording') this.elapsed = this.duration;
    this.cancelEvery(this.timer); this.timer = null; this.release();
    const type = this.capture?.mimeType || this.chunks.find(chunk => chunk.type)?.type || 'audio/webm';
    this.blob = this.chunks.length ? new Blob(this.chunks, { type }) : null;
    this.chunks = [];
    this.phase = this.blob ? 'ready' : 'idle';
    if (!this.blob) this.error = 'Chưa nhận được dữ liệu âm thanh. Thử thu lại và kiểm tra micro.';
    this.changed();
  }

  release() {
    this.stream?.getTracks().forEach(track => { track.removeEventListener('ended', this.trackEnded); track.stop(); });
    this.stream = null;
  }

  reset() {
    if (this.active) return;
    this.blob = null; this.chunks = []; this.bytes = 0; this.elapsed = 0; this.saved = false;
    this.error = ''; this.notice = ''; this.phase = 'idle'; this.changed();
  }
}
