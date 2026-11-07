// Shared time and range rules for the clip editor and FFmpeg endpoint.
export const MIN_CLIP_DURATION = .25;

export function parseClipTime(value) {
  const parts = String(value).trim().replace(',', '.').split(':');
  if (!parts.length || parts.length > 3 || !/^\d+(?:\.\d{1,3})?$/.test(parts.at(-1))) return NaN;
  if (parts.slice(0, -1).some(part => !/^\d+$/.test(part))) return NaN;
  const values = parts.map(Number);
  if (values.length > 1 && values.at(-1) >= 60 || values.length === 3 && values[1] >= 60) return NaN;
  return values.reduce((total, part) => total * 60 + part, 0);
}

export function formatClipTime(seconds) {
  const total = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const rest = Math.floor(total / 1000) % 60;
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}

export function clipRangeError(start, end, duration) {
  if (![start, end, duration].every(Number.isFinite)) return 'Nhập thời gian dạng 00:12.500 hoặc số giây.';
  if (start < 0 || end > duration + 1e-7) return 'Mốc cắt phải nằm trong thời lượng bản thu.';
  if (end <= start) return 'Mốc kết thúc phải sau mốc bắt đầu.';
  if (end - start < MIN_CLIP_DURATION - 1e-7) return 'Clip cần dài ít nhất 0,25 giây.';
  return '';
}

export function selectedClipRange(transcript, anchorId, endId, duration) {
  const ordered = [...transcript].sort((a, b) => a.time - b.time || a.end - b.end);
  const first = ordered.findIndex(line => line.id === anchorId);
  const last = ordered.findIndex(line => line.id === endId);
  if (first < 0 || last < 0) return null;
  const lines = ordered.slice(Math.min(first, last), Math.max(first, last) + 1);
  const start = Math.max(0, Math.floor(Math.min(...lines.map(line => line.time)) * 1000) / 1000);
  const end = Math.min(Math.floor(duration * 1000) / 1000, Math.ceil(Math.max(...lines.map(line => line.end)) * 1000) / 1000);
  return { start, end, lines };
}

export function clipFilename(name, { start, end, variant, format }) {
  const stem = String(name).normalize('NFC').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80) || 'audio';
  const stamp = value => formatClipTime(value).replace(/[:.]/g, '-');
  return `${stem}-clip-${stamp(start)}-${stamp(end)}-${variant}.${format}`;
}
