// Parser and project adapter shared by the browser and the local API.
// Subtitle files are deliberately parsed without a DOM so the same validation
// rules are used before an import is previewed and when it is committed.

export const MAX_SUBTITLE_BYTES = 25 * 1024 * 1024;
export const MAX_SUBTITLE_CUES = 20_000;
export const MAX_CUE_TEXT = 5_000;
export const SUBTITLE_DURATION_TOLERANCE = 0.1;

const SPEAKER_COLORS = ['#7472e9', '#ec8068', '#dcb151', '#44b998', '#5d9bd7', '#cc79bd'];
const controlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_SUBTITLE' });
}

function asBytes(input) {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  invalid('Nội dung phụ đề không hợp lệ.');
}

/** Decode UTF-8 (including BOM) and UTF-16 subtitle files. */
export function decodeSubtitle(input) {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_SUBTITLE_BYTES) invalid('File phụ đề vượt quá 25 MB.');
    if (controlCharacters.test(input)) invalid('File phụ đề chứa ký tự điều khiển không hợp lệ.');
    return input.replace(/^\uFEFF/u, '');
  }
  const bytes = asBytes(input);
  if (bytes.byteLength > MAX_SUBTITLE_BYTES) invalid('File phụ đề vượt quá 25 MB.');
  let encoding = 'utf-8';
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) offset = 3;
  else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) { encoding = 'utf-16be'; offset = 2; }
  else if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] !== 0 && bytes[2] === 0 && bytes[3] !== 0) encoding = 'utf-16be';
  else if (bytes.length >= 4 && bytes[0] !== 0 && bytes[1] === 0 && bytes[2] !== 0 && bytes[3] === 0) encoding = 'utf-16le';
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    invalid('Không đọc được mã hoá file phụ đề. Dùng UTF-8 hoặc UTF-16.');
  }
  if (controlCharacters.test(text)) invalid('File phụ đề chứa ký tự điều khiển không hợp lệ.');
  return text.replace(/^\uFEFF/u, '');
}

/** Parse an SRT or WebVTT timestamp and return seconds. */
export function parseTimestamp(value) {
  const source = String(value ?? '').trim();
  const match = source.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?$/u);
  if (!match) invalid(`Mốc thời gian không hợp lệ: ${source || '(trống)'}.`);
  const first = Number(match[1]), second = Number(match[2]);
  const hasHours = match[3] !== undefined;
  const third = hasHours ? Number(match[3]) : 0;
  if (second > 59 || third > 59 || (!hasHours && first > 59)) invalid(`Mốc thời gian không hợp lệ: ${source}.`);
  const milliseconds = match[4] ? Number(match[4].padEnd(3, '0')) : 0;
  const seconds = (hasHours ? first * 3600 + second * 60 + third : first * 60 + second) + milliseconds / 1000;
  if (!Number.isFinite(seconds)) invalid(`Mốc thời gian không hợp lệ: ${source}.`);
  return seconds;
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm);|&#(?:x[\da-f]{1,6}|\d{1,7});/giu, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&lrm;': '\u200E', '&rlm;': '\u200F' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = entity.match(/^&#x([\da-f]+);$/iu);
    const code = hex ? Number.parseInt(hex[1], 16) : Number(entity.slice(2, -1));
    if (code > 0x10FFFF || code >= 0xD800 && code <= 0xDFFF) invalid('Phụ đề có mã ký tự Unicode không hợp lệ.');
    return String.fromCodePoint(code);
  });
}

function cleanCueText(value) {
  return decodeEntities(String(value || '').replace(/\r/g, '').replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^<>\r\n]*>/gu, '')).replace(/[ \t]+\n/gu, '\n').replace(/\n[ \t]+/gu, '\n').trim();
}

function parseCuePayload(lines) {
  const raw = lines.join('\n').trim();
  if (!raw) invalid('Phụ đề có một cue trống.');
  if (raw.length > MAX_CUE_TEXT * 12) invalid('Một cue phụ đề vượt quá giới hạn nội dung.');
  let speaker = null;
  let body = raw;
  // WebVTT voice span: <v Tên người nói>nội dung</v>. A voice may contain
  // spaces and Vietnamese diacritics, so only the opening tag is captured.
  const voices = [...raw.matchAll(/<v(?:\.[^\s.<>]+)*(?:[ \t]+([^<>\r\n]*))?>/giu)].map(match => cleanCueText(match[1] || '')).filter(Boolean);
  if (new Set(voices.map(normalizedName)).size > 1) invalid('Một cue chứa nhiều nhãn người nói. Tách từng người thành cue riêng trước khi nhập.');
  if (voices.length) {
    speaker = voices[0];
    body = raw.replace(/<v(?:\.[^\s.<>]+)*(?:[ \t]+[^<>\r\n]*)?>/giu, '').replace(/<\/v>/giu, '');
  }
  body = cleanCueText(body);
  // Audio Toolkit's own SRT/VTT exports use `Speaker: text`; accept that
  // format on re-import while keeping ordinary colons inside the text.
  const firstLine = body.split('\n')[0];
  const prefix = firstLine.match(/^([^:\n]{1,40}):[ \t]+(.+)$/u);
  if (!speaker && prefix && /[\p{L}\p{N}]/u.test(prefix[1]) && !/^https?$/iu.test(prefix[1].trim())) {
    speaker = prefix[1].trim();
    body = `${prefix[2]}${body.slice(firstLine.length)}`.trim();
  }
  if (!body) invalid('Cue phụ đề không có nội dung.');
  if (controlCharacters.test(body) || speaker && controlCharacters.test(speaker)) invalid('Phụ đề chứa ký tự điều khiển không hợp lệ.');
  if (speaker) speaker = speaker.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (speaker?.length > 40) invalid('Tên người nói trong phụ đề vượt quá 40 ký tự.');
  if (body.length > MAX_CUE_TEXT) invalid('Một cue phụ đề vượt quá 5.000 ký tự.');
  return { text: body, speaker };
}

function timingLine(line) {
  const match = String(line).trim().match(/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/u);
  if (!match) return null;
  return { start: parseTimestamp(match[1]), end: parseTimestamp(match[2]) };
}

function* blocks(text) {
  const source = text.replace(/\r\n?/gu, '\n').trim();
  let offset = 0;
  // Iterate lazily so malformed files with millions of short lines cannot
  // allocate a large array before cue and content limits are checked.
  for (const match of source.matchAll(/\n[ \t]*\n(?:[ \t]*\n)*/gu)) {
    yield source.slice(offset, match.index); offset = match.index + match[0].length;
  }
  if (offset < source.length) yield source.slice(offset);
}

function formatFromText(text) {
  const first = text.match(/^[^\r\n]*/u)[0].trim();
  if (/^WEBVTT(?:[ \t].*)?$/iu.test(first)) return 'vtt';
  return 'srt';
}

/** Parse a complete SRT or WebVTT document. */
export function parseSubtitle(input, { duration = null, maxCues = MAX_SUBTITLE_CUES } = {}) {
  const text = decodeSubtitle(input).trim();
  const format = formatFromText(text);
  const groups = blocks(text);
  const cues = [];
  if (!Number.isInteger(maxCues) || maxCues < 1) invalid('Giới hạn số đoạn phụ đề không hợp lệ.');
  for (const block of groups) {
    const first = block.slice(0, block.indexOf('\n') < 0 ? block.length : block.indexOf('\n')).trim();
    if (format === 'vtt' && /^WEBVTT(?:[ \t].*)?$/iu.test(first)) {
      if (block.includes('-->')) invalid('Cần có dòng trống sau tiêu đề WEBVTT.');
      continue;
    }
    if (format === 'vtt' && /^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/iu.test(first)) continue;
    if (block.length > MAX_CUE_TEXT * 12 + 4096) invalid('Một cue phụ đề vượt quá giới hạn nội dung.');
    const group = block.split('\n');
    const timingIndex = group[0].includes('-->') ? 0 : group[1]?.includes('-->') ? 1 : -1;
    if (timingIndex < 0) invalid('Không tìm thấy mốc thời gian hợp lệ. Kiểm tra dòng trống giữa các cue.');
    const timing = timingLine(group[timingIndex]);
    if (!timing || timing.end <= timing.start) invalid('Mốc kết thúc phải sau mốc bắt đầu.');
    if (group.slice(timingIndex + 1).some(line => /^\s*\d[\d:.,]*\s*-->/u.test(line))) invalid('Cần có dòng trống giữa các cue phụ đề.');
    const payload = parseCuePayload(group.slice(timingIndex + 1));
    cues.push({ index: cues.length + 1, start: timing.start, end: timing.end, text: payload.text, speaker: payload.speaker });
    if (cues.length > maxCues || cues.length > MAX_SUBTITLE_CUES) invalid(`File phụ đề có quá ${Math.min(maxCues, MAX_SUBTITLE_CUES).toLocaleString('vi-VN')} cue.`);
  }
  if (!cues.length) invalid('Không tìm thấy cue SRT/VTT hợp lệ.');
  let previous = null;
  for (const cue of cues) {
    if (previous && cue.start < previous.start) invalid('Các cue phụ đề phải theo thứ tự thời gian.');
    if (duration != null) {
      const length = Number(duration);
      if (!Number.isFinite(length) || length <= 0) invalid('Thời lượng dự án không hợp lệ.');
      if (cue.start > length + SUBTITLE_DURATION_TOLERANCE || cue.end > length + SUBTITLE_DURATION_TOLERANCE) invalid('Cue phụ đề nằm ngoài thời lượng bản thu.');
      cue.start = Math.max(0, Math.min(length, cue.start));
      cue.end = Math.max(0, Math.min(length, cue.end));
      if (cue.end <= cue.start) invalid('Cue phụ đề quá ngắn sau khi đối chiếu thời lượng.');
    }
    previous = cue;
  }
  const speakerNames = [];
  const seen = new Set();
  for (const cue of cues) if (cue.speaker && !seen.has(normalizedName(cue.speaker))) { seen.add(normalizedName(cue.speaker)); speakerNames.push(cue.speaker); }
  let furthestEnd = 0, overlappingCueCount = 0;
  for (const cue of cues) { if (cue.start < furthestEnd) overlappingCueCount++; furthestEnd = Math.max(furthestEnd, cue.end); }
  return { format, cues, speakerNames, overlappingCueCount };
}

function normalizedName(value) {
  return String(value || '').normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

/** Convert parsed cues to the project's transcript and speaker schema. */
export function prepareImportedTranscript(parsed, project) {
  if (!parsed?.cues?.length) invalid('Chưa có cue để nhập.');
  const sourceSpeakers = Array.isArray(project?.speakers) ? project.speakers : [];
  const speakers = sourceSpeakers.map(speaker => ({ ...speaker }));
  const byName = new Map(speakers.map(speaker => [normalizedName(speaker.name), speaker]));
  const nextId = () => {
    let index = speakers.length + 1;
    while (speakers.some(speaker => speaker.id === `import-speaker-${index}`)) index++;
    return `import-speaker-${index}`;
  };
  const ensureSpeaker = name => {
    const normalized = normalizedName(name);
    if (normalized && byName.has(normalized)) return byName.get(normalized);
    if (!normalized) return defaultSpeaker;
    if (String(name).length > 40) invalid('Tên người nói trong phụ đề vượt quá 40 ký tự.');
    if (speakers.length >= 20) invalid('Dự án hỗ trợ tối đa 20 người nói. File có thêm nhãn người nói vượt giới hạn này.');
    const speaker = { id: nextId(), name: String(name).normalize('NFC').replace(/\s+/gu, ' ').trim(), color: SPEAKER_COLORS[speakers.length % SPEAKER_COLORS.length] };
    speakers.push(speaker); byName.set(normalized, speaker); return speaker;
  };
  const defaultSpeaker = parsed.cues.some(cue => !cue.speaker) ? sourceSpeakers[0] || ensureSpeaker('Người nói 1') : null;
  const transcript = parsed.cues.map((cue, index) => {
    const speaker = ensureSpeaker(cue.speaker || '');
    return { id: `import-line-${index + 1}`, time: cue.start, end: cue.end, speaker: speaker.id, confidence: null, text: cue.text };
  });
  return { transcript, speakers };
}

