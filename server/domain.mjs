import { z } from 'zod';
import { clipRangeError } from '../public/clips.js';

export const idSchema = z.union([z.literal('demo'), z.string().uuid()]);
export function uploadedFilename(name) {
  // Multipart filenames from browsers contain UTF-8 bytes, while Busboy defaults
  // to Latin-1 for a filename without an explicit charset. Decode exactly once.
  const raw = String(name || 'audio.wav');
  if (Array.from(raw).some(character => character.codePointAt(0) > 255)) return raw;
  const bytes = Buffer.from(raw, 'latin1');
  const decoded = bytes.toString('utf8');
  return !decoded.includes('\uFFFD') && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : raw;
}
export const speakerSchema = z.object({
  id: z.string().min(1).max(70), name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export const lineSchema = z.object({
  id: z.string().min(1).max(70), time: z.number().finite().min(0),
  end: z.number().finite().positive(), speaker: z.string().min(1).max(70),
  confidence: z.number().min(0).max(100).nullable().default(null),
  text: z.string().max(5000),
}).refine(line => line.end > line.time, 'Mốc kết thúc phải sau mốc bắt đầu.');
export const noteSchema = z.object({
  id: z.string().min(1).max(70), time: z.number().finite().min(0),
  text: z.string().trim().min(1).max(2000),
});
export const editSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  transcript: z.array(lineSchema).max(20000).optional(),
  notes: z.array(noteSchema).max(3000).optional(),
  speakers: z.array(speakerSchema).max(20).optional(),
}).strict();
export const optionsSchema = z.object({
  kind: z.enum(['all', 'noise', 'transcript', 'speakers']),
  model: z.enum(['tiny', 'base', 'small']).default('base'),
  language: z.enum(['auto', 'vi', 'en', 'ja', 'ko', 'zh', 'fr', 'de', 'es']).default('auto'),
  numSpeakers: z.number().int().min(0).max(8).default(0),
  noiseStrength: z.enum(['gentle', 'standard', 'strong']).default('standard'),
});

export const clipSchema = z.object({
  start: z.number().finite().min(0).max(7200),
  end: z.number().finite().positive().max(7200),
  variant: z.enum(['original', 'clean']),
  format: z.enum(['mp3', 'wav']),
}).strict();

export function validateClip(project, body) {
  const options = clipSchema.parse(body);
  const message = clipRangeError(options.start, options.end, project.duration);
  if (message) throw Object.assign(new Error(message), { status: 400 });
  if (options.variant === 'clean' && !project.processed.noise) {
    throw Object.assign(new Error('Lọc tiếng ồn trước khi cắt từ bản đã lọc.'), { status: 409 });
  }
  return options;
}

export function validateEdits(project, updates) {
  const invalid = message => Object.assign(new Error(message), { status: 400 });
  const next = { ...project, ...updates };
  const known = new Set(next.speakers.map(speaker => speaker.id));
  if (known.size !== next.speakers.length) throw invalid('Mã người nói bị trùng.');
  for (const line of next.transcript) {
    if (line.end > project.duration + .1 || !known.has(line.speaker)) throw invalid('Transcript có thời gian hoặc người nói không hợp lệ.');
  }
  if (new Set(next.transcript.map(line => line.id)).size !== next.transcript.length) throw invalid('Mã đoạn transcript bị trùng.');
  if (new Set(next.notes.map(note => note.id)).size !== next.notes.length) throw invalid('Mã ghi chú bị trùng.');
  if (next.notes.some(note => note.time > project.duration + .1)) throw invalid('Ghi chú nằm ngoài thời lượng bản thu.');
  return next;
}

export function publicProject(project) {
  const { words, files, queueCheckpoint, backupOrigin, transcriptHistory, ...view } = project;
  return { ...view, audioUrl: `/api/projects/${project.id}/audio/original`,
    cleanUrl: project.processed.noise ? `/api/projects/${project.id}/audio/clean?v=${project.updatedAt}` : null };
}
