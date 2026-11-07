import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lineSchema, speakerSchema, validateEdits } from './domain.mjs';
import { buildInsights } from '../public/insights.js';

export const HISTORY_LIMIT = 20;
export const HISTORY_MAX_BYTES = 64 * 1024 * 1024;
export const HISTORY_EDIT_WINDOW = 5 * 60 * 1000;
export const historyReasonSchema = z.enum(['manual', 'edit', 'transcript', 'speakers', 'subtitles', 'restore']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const contentSchema = z.object({
  duration: z.number().finite().positive().max(7200),
  transcript: z.array(lineSchema).max(20000), speakers: z.array(speakerSchema).max(20),
  processed: z.object({ transcript: z.boolean(), speakers: z.boolean() }).strict(),
  language: z.string().max(30).nullable(), model: z.string().max(80).nullable(),
}).strict();
const entrySchema = z.object({
  id: z.string().uuid(), createdAt: z.iso.datetime(), reason: historyReasonSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), content: z.unknown(),
}).strict();
const historySchema = z.object({
  version: z.literal(1), entries: z.array(entrySchema).max(HISTORY_LIMIT),
  editGroup: z.object({ id: z.string().uuid(), startedAt: z.number().finite() }).nullable(),
  lastRestore: z.object({ id: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();

function content(project) {
  // Only editorial content belongs to a version; audio, notes and private AI
  // alignment keep their own lifetime. Stable field order also prevents false
  // changes when an API/schema reorders properties on a transcript line.
  return { duration: project.duration,
    transcript: project.transcript.map(line => ({ id: line.id, time: line.time, end: line.end, speaker: line.speaker, confidence: line.confidence ?? null, text: line.text })),
    speakers: project.speakers.map(person => ({ id: person.id, name: person.name, color: person.color })),
    processed: { transcript: !!project.processed.transcript, speakers: !!project.processed.speakers },
    language: project.language || null, model: project.model || null };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const historyFingerprint = project => digest(content(project));

function state(project) {
  if (!project.transcriptHistory) return { version: 1, entries: [], editGroup: null };
  try {
    const result = historySchema.parse(project.transcriptHistory);
    if (new Set(result.entries.map(entry => entry.id)).size !== result.entries.length) throw new Error('duplicate');
    return result;
  } catch { throw fail(409, 'Lịch sử phiên bản không đọc được. Dự án được giữ nguyên; kiểm tra file dữ liệu trước khi thay transcript.'); }
}

function checkedContent(entry, project) {
  try {
    const saved = contentSchema.parse(entry.content);
    if (digest(saved) !== entry.fingerprint || saved.duration !== project.duration) throw new Error('mismatch');
    validateEdits({ ...project, notes: [] }, { transcript: saved.transcript, speakers: saved.speakers });
    return saved;
  } catch { throw fail(409, 'Phiên bản có nội dung hoặc mốc thời gian không hợp lệ. Dự án hiện tại được giữ nguyên.'); }
}

/** Add the old content to the new project's atomic commit, before replacement. */
export function withHistory(previous, next, { reason = 'edit', checkpoint = false, now = Date.now(), maxEntries = HISTORY_LIMIT, maxBytes = HISTORY_MAX_BYTES } = {}) {
  historyReasonSchema.parse(reason);
  const before = content(previous), fingerprint = digest(before);
  if (!checkpoint && fingerprint === historyFingerprint(next)) return next;
  const history = state(previous), newest = history.entries[0];
  const receipt = reason === 'restore' ? state(next).lastRestore : history.lastRestore;
  const restoreReceipt = receipt ? { lastRestore: receipt } : {};
  const same = newest?.fingerprint === fingerprint;
  const grouped = reason === 'edit' && !checkpoint && !!history.editGroup && history.editGroup.id === newest?.id && now >= history.editGroup.startedAt && now - history.editGroup.startedAt < HISTORY_EDIT_WINDOW;
  if (same || grouped) {
    checkedContent(newest, previous);
    return { ...next, transcriptHistory: { ...history, ...restoreReceipt, editGroup: reason === 'edit' && !checkpoint
      ? grouped ? history.editGroup : { id: newest.id, startedAt: now } : null } };
  }
  const saved = contentSchema.parse(before);
  validateEdits({ ...previous, notes: [] }, { transcript: saved.transcript, speakers: saved.speakers });
  const entry = { id: randomUUID(), createdAt: new Date(now).toISOString(), reason, fingerprint, content: saved };
  const entries = [entry, ...history.entries];
  const limit = Math.max(1, Math.min(maxEntries, HISTORY_LIMIT));
  // Refuse replacement if its recovery copy cannot be stored. The caller's
  // atomic project write then either saves both, or leaves both unchanged.
  const sizes = entries.map(value => Buffer.byteLength(JSON.stringify(value)));
  if (sizes[0] + 2 > maxBytes) throw fail(413, 'Transcript quá lớn để lưu phiên bản khôi phục (tối đa 64 MB). Xuất bản sao lưu trước khi tiếp tục.');
  let bytes = 2 + sizes.reduce((sum, size) => sum + size, 0) + entries.length - 1;
  while (entries.length > limit || bytes > maxBytes) {
    entries.pop(); bytes -= sizes.pop() + (entries.length ? 1 : 0);
  }
  return { ...next, transcriptHistory: { version: 1, entries, ...restoreReceipt, editGroup: reason === 'edit' ? { id: entry.id, startedAt: now } : null } };
}

function metadata(entry, currentFingerprint) {
  const saved = entry.content;
  if (!saved || !Array.isArray(saved.transcript) || !Array.isArray(saved.speakers)
    || saved.speakers.some(person => !person || typeof person.name !== 'string')) {
    throw fail(409, 'Lịch sử phiên bản không đọc được. Dự án hiện tại được giữ nguyên.');
  }
  return { id: entry.id, createdAt: entry.createdAt, reason: entry.reason,
    transcriptCount: saved?.transcript?.length ?? 0, speakerNames: (saved?.speakers || []).map(person => person.name),
    isCurrent: entry.fingerprint === currentFingerprint };
}
export function listHistory(project) {
  const fingerprint = historyFingerprint(project);
  return { versions: state(project).entries.map(entry => metadata(entry, fingerprint)), currentFingerprint: fingerprint,
    retention: { maxEntries: HISTORY_LIMIT, maxBytes: HISTORY_MAX_BYTES, editWindowMinutes: HISTORY_EDIT_WINDOW / 60000 } };
}
function entryFor(project, id) {
  z.string().uuid().parse(id);
  const entry = state(project).entries.find(item => item.id === id);
  if (!entry) throw fail(404, 'Phiên bản không còn trong lịch sử. Tải lại danh sách để xem các bản gần nhất.');
  return entry;
}
const lineKey = line => JSON.stringify([line.time, line.end, line.speaker, line.confidence, line.text]);
export function previewHistory(project, id) {
  const entry = entryFor(project, id), saved = checkedContent(entry, project), fingerprint = historyFingerprint(project);
  const current = new Map(project.transcript.map(line => [line.id, line]));
  const ids = new Set(saved.transcript.map(line => line.id));
  const people = new Map(project.speakers.map(person => [person.id, person]));
  const savedPeople = new Set(saved.speakers.map(person => person.id));
  return { version: metadata(entry, fingerprint), ...saved, currentFingerprint: fingerprint,
    comparison: { added: saved.transcript.filter(line => !current.has(line.id)).length,
      removed: project.transcript.filter(line => !ids.has(line.id)).length,
      changed: saved.transcript.filter(line => current.has(line.id) && lineKey(line) !== lineKey(current.get(line.id))).length,
      speakersChanged: saved.speakers.filter(person => !people.has(person.id) || person.name !== people.get(person.id).name || person.color !== people.get(person.id).color).length
        + project.speakers.filter(person => !savedPeople.has(person.id)).length } };
}

export function restoreHistory(project, id, expectedFingerprint) {
  z.string().uuid().parse(id);
  const history = state(project);
  // Restoring the oldest of twenty versions may evict that very entry. Keep a
  // small receipt so a lost response remains safe to retry after that eviction.
  if (!history.entries.some(entry => entry.id === id) && history.lastRestore?.id === id
    && history.lastRestore.fingerprint === historyFingerprint(project)) return project;
  const entry = entryFor(project, id), saved = checkedContent(entry, project), current = historyFingerprint(project);
  if (current === entry.fingerprint) return project; // Response retry is safe, including after restart.
  if (expectedFingerprint !== current) throw fail(409, 'Transcript hoặc người nói vừa thay đổi. Tải lại lịch sử và xem trước lần nữa trước khi khôi phục.');
  const next = { ...validateEdits(project, { transcript: saved.transcript, speakers: saved.speakers }),
    processed: { ...project.processed, ...saved.processed }, language: saved.language, transcriptEdited: true,
    words: [], turns: [], insights: null,
    transcriptHistory: { ...history, lastRestore: { id, fingerprint: entry.fingerprint } } };
  if (saved.model) next.model = saved.model; else delete next.model;
  delete next.queueCheckpoint;
  if (next.transcript.some(line => /[\p{L}\p{N}]/u.test(line.text))) next.insights = buildInsights(next);
  return next;
}
