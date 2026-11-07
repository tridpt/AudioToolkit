import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { reportProjectSchema } from './report.mjs';

const MB = 1024 * 1024;
export const MAX_BACKUP_BYTES = 1536 * MB;
const MAX_METADATA_BYTES = 32 * MB;
const MAX_EXPANDED_BYTES = 2048 * MB;
const fail = message => Object.assign(new Error(message), { status: 400 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const boundedTime = z.number().finite().min(0).max(7230);
const wordSchema = z.object({ text: z.string().max(2000), start: boundedTime, end: boundedTime,
  probability: z.number().finite().min(0).max(1).nullable().optional() }).strict().refine(word => word.end >= word.start);
const turnSchema = z.object({ start: boundedTime, end: boundedTime, speaker: z.string().min(1).max(70) }).strict().refine(turn => turn.end > turn.start);
export const backupProjectSchema = reportProjectSchema.safeExtend({
  duration: z.number().finite().min(.5).max(7200),
  format: z.string().min(1).max(30), sampleRate: z.number().int().positive().max(768000), channels: z.number().int().min(1).max(64),
  createdAt: z.string().min(1).max(100),
  updatedAt: z.string().max(100), size: z.number().int().nonnegative().max(250 * MB),
  processed: z.object({ noise: z.boolean(), transcript: z.boolean(), speakers: z.boolean() }).strict(),
  metrics: z.object({ peaks: z.array(z.number().finite().min(0).max(1)).min(1).max(2000),
    peakDb: z.number().finite().min(-300).max(50), rmsDb: z.number().finite().min(-300).max(50) }).strict(),
  words: z.array(wordSchema).max(150000), turns: z.array(turnSchema).max(50000).optional(),
  model: z.enum(['tiny', 'base', 'small']).optional(), transcriptEdited: z.boolean().optional(),
}).strict().superRefine((project, ctx) => {
  if ((project.turns || []).some(turn => turn.end > project.duration + .1) || project.words.some(word => word.end > project.duration + 30)
    || [...(project.insights?.summary || []), ...(project.insights?.highlights || [])].some(item => item.end > project.duration + .1)
    || (project.insights?.chapters || []).some(item => item.end > project.duration + .1)) {
    ctx.addIssue({ code: 'custom', message: 'Dữ liệu có mốc thời gian nằm ngoài bản thu.' });
  }
});
const projectKeys = ['id', 'name', 'fileName', 'duration', 'format', 'sampleRate', 'channels', 'size', 'createdAt', 'updatedAt',
  'language', 'processed', 'metrics', 'speakers', 'transcript', 'notes', 'insights', 'words', 'turns', 'model', 'transcriptEdited'];
export const portableProject = project => backupProjectSchema.parse(Object.fromEntries(projectKeys.filter(key => project[key] !== undefined).map(key => [key, project[key]])));
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const recordSchema = z.object({ role: z.enum(['project', 'original', 'source', 'playback', 'clean']), path: z.string().max(60),
  bytes: z.number().int().positive().max(512 * MB), sha256: sha }).strict();
export const backupManifestSchema = z.object({
  format: z.literal('audio-toolkit-backup'), version: z.literal(1), exportedAt: z.string().max(100),
  fingerprint: sha, files: z.array(recordSchema).min(4).max(5),
}).strict();

function entryLimit(name) {
  if (name === 'manifest.json') return 32768;
  if (name === 'project.json') return MAX_METADATA_BYTES;
  if (/^audio\/original\.[a-z0-9]{1,9}$/.test(name)) return 250 * MB;
  if (name === 'audio/source.wav') return 256 * MB;
  if (['audio/playback.mp3', 'audio/clean.mp3'].includes(name)) return 512 * MB;
  throw fail('ZIP chứa đường dẫn hoặc file không thuộc bản sao lưu Audio Toolkit.');
}
function recordPath(role, original) {
  return role === 'project' ? 'project.json' : `audio/${role === 'original' ? original : role === 'source' ? 'source.wav' : `${role}.mp3`}`;
}
function fingerprint(records) { return digest(canonical([...records].sort((a, b) => a.role.localeCompare(b.role)))); }
function verifyRecords(manifest, project) {
  const roles = new Set(manifest.files.map(record => record.role)), paths = new Set(manifest.files.map(record => record.path));
  const wanted = ['project', 'original', 'source', 'playback', ...(project.processed.noise ? ['clean'] : [])];
  if (roles.size !== wanted.length || paths.size !== wanted.length || wanted.some(role => !roles.has(role))) throw fail('Danh sách file trong bản sao lưu không đầy đủ hoặc bị trùng.');
  const original = manifest.files.find(record => record.role === 'original');
  if (!/^audio\/original\.[a-z0-9]{1,9}$/.test(original.path)) throw fail('Tên âm thanh gốc trong bản sao lưu không hợp lệ.');
  for (const record of manifest.files) {
    if (record.path !== recordPath(record.role, path.posix.basename(original.path)) || record.bytes > entryLimit(record.path)) throw fail('File trong bản sao lưu không hợp lệ hoặc vượt giới hạn.');
  }
  if (original.bytes !== project.size) throw fail('Kích thước âm thanh gốc không khớp thông tin dự án.');
  if (fingerprint(manifest.files) !== manifest.fingerprint) throw fail('Thông tin kiểm tra bản sao lưu không khớp.');
}

async function fileHash(file, signal) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}
export function backupFilename(name) {
  const safe = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'audio-toolkit';
  return `${safe}-sao-luu.audiokit.zip`;
}
export async function createBackup(projectInput, { mediaFile, target, signal }) {
  const project = portableProject(projectInput), metadata = Buffer.from(canonical(project));
  if (metadata.length > MAX_METADATA_BYTES) throw fail('Thông tin dự án quá lớn để sao lưu.');
  const original = projectInput.files.original;
  entryLimit(`audio/${original}`);
  const records = [{ role: 'project', path: 'project.json', bytes: metadata.length, sha256: digest(metadata) }], sources = [];
  for (const role of ['original', 'source', 'playback', ...(project.processed.noise ? ['clean'] : [])]) {
    const file = mediaFile(role), name = recordPath(role, original);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > entryLimit(name)) throw fail('Âm thanh dự án bị thiếu hoặc vượt giới hạn sao lưu.');
    const record = { role, path: name, ...await fileHash(file, signal) };
    records.push(record); sources.push({ file, record });
  }
  const manifest = { format: 'audio-toolkit-backup', version: 1, exportedAt: new Date().toISOString(), fingerprint: fingerprint(records), files: records };
  verifyRecords(manifest, project);
  const zip = new yazl.ZipFile();
  const inputs = new Set();
  const limit = new Transform({ transform(chunk, encoding, done) {
    this.bytes = (this.bytes || 0) + chunk.length;
    done(this.bytes > MAX_BACKUP_BYTES ? fail('Bản sao lưu vượt giới hạn 1,5 GB.') : null, chunk);
  } });
  zip.on('error', error => zip.outputStream.destroy(error));
  const writing = pipeline(zip.outputStream, limit, createWriteStream(target, { flags: 'wx' }), { signal });
  try {
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
    zip.addBuffer(metadata, 'project.json');
    for (const { file, record } of sources) zip.addReadStreamLazy(record.path, { compressionLevel: 3, mode: 0o100600, size: record.bytes }, done => {
      if (signal?.aborted) { done(signal.reason); return; }
      const input = createReadStream(file, { signal }); inputs.add(input);
      input.once('close', () => inputs.delete(input)); done(null, input);
    });
    zip.end(); await writing;
    return { filename: backupFilename(project.name), fingerprint: manifest.fingerprint, bytes: (await fs.stat(target)).size };
  } catch (error) {
    for (const input of inputs) input.destroy(error);
    zip.outputStream.destroy(error); await writing.catch(() => {}); await fs.unlink(target).catch(() => {}); throw error;
  }
}

async function readEntry(zip, entry, limit, signal) {
  const stream = await zip.openReadStreamPromise(entry), chunks = []; let bytes = 0;
  const abort = () => stream.destroy(signal.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      bytes += chunk.length; if (bytes > limit) throw fail('File trong ZIP vượt giới hạn.'); chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { signal?.removeEventListener('abort', abort); }
}
function parseJSON(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw fail(`${label} trong bản sao lưu bị hỏng.`); }
}
function checkHash(record, bytes) {
  if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw fail('Bản sao lưu bị hỏng: kích thước hoặc SHA-256 không khớp.');
}
export async function inspectBackup(archive, directory, { signal } = {}) {
  const stat = await fs.stat(archive);
  if (stat.size > MAX_BACKUP_BYTES) throw fail('File sao lưu vượt quá 1,5 GB.');
  let zip;
  try {
    zip = await yauzl.openPromise(archive, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
    if (zip.entryCount < 5 || zip.entryCount > 6) throw fail('Chọn ZIP sao lưu dự án Audio Toolkit có kèm âm thanh.');
    const entries = new Map(); let total = 0;
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const type = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (entries.has(entry.fileName) || entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod) || type && type !== 0x8000) throw fail('ZIP chứa file trùng, mã hoá hoặc loại file không được hỗ trợ.');
      const limit = entryLimit(entry.fileName);
      total += entry.uncompressedSize;
      if (entry.uncompressedSize <= 0 || entry.uncompressedSize > limit || total > MAX_EXPANDED_BYTES) throw fail('Nội dung giải nén vượt giới hạn.');
      entries.set(entry.fileName, entry);
    }
    if (!entries.has('manifest.json') || !entries.has('project.json')) throw fail('ZIP thiếu thông tin sao lưu Audio Toolkit.');
    const manifest = backupManifestSchema.parse(parseJSON(await readEntry(zip, entries.get('manifest.json'), 32768, signal), 'Manifest'));
    const metadata = await readEntry(zip, entries.get('project.json'), MAX_METADATA_BYTES, signal);
    const metadataRecord = manifest.files.find(record => record.role === 'project');
    if (!metadataRecord) throw fail('ZIP thiếu thông tin dự án.');
    checkHash(metadataRecord, metadata);
    const project = backupProjectSchema.parse(parseJSON(metadata, 'Dự án'));
    verifyRecords(manifest, project);
    if (entries.size !== manifest.files.length + 1 || manifest.files.some(record => !entries.has(record.path) || entries.get(record.path).uncompressedSize !== record.bytes)) throw fail('Danh sách file thực tế không khớp bản sao lưu.');
    const audio = path.join(directory, 'audio'); await fs.mkdir(audio);
    const files = {};
    for (const record of manifest.files.filter(record => record.role !== 'project')) {
      const name = path.posix.basename(record.path), target = path.join(audio, name), hash = createHash('sha256'); let bytes = 0;
      const checker = new Transform({ transform(chunk, encoding, done) {
        bytes += chunk.length;
        if (bytes > record.bytes) return done(fail('Nội dung giải nén lớn hơn khai báo.'));
        hash.update(chunk); done(null, chunk);
      } });
      await pipeline(await zip.openReadStreamPromise(entries.get(record.path)), checker, createWriteStream(target, { flags: 'wx' }), { signal });
      if (bytes !== record.bytes || hash.digest('hex') !== record.sha256) throw fail('Bản sao lưu bị hỏng: âm thanh không vượt qua kiểm tra SHA-256.');
      files[record.role] = name;
    }
    files.clean ||= 'clean.mp3';
    return { project, manifest, files, audio };
  } catch (error) {
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.status || error instanceof z.ZodError || ['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    throw fail(`Không đọc được ZIP sao lưu: ${error.message}`);
  } finally { zip?.close(); }
}

export class BackupStore {
  constructor({ directory, projectsDir, mediaDir, loadProject, listProjects, persist, isBusy = () => false, validateAudio = async () => {}, now = () => Date.now() }) {
    Object.assign(this, { directory, projectsDir, mediaDir, loadProject, listProjects, persist, isBusy, validateAudio, now });
    this.sessions = new Map(); this.serial = Promise.resolve(); this.lifetime = 30 * 60 * 1000;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    // Session folders are temporary review copies, owned solely by this feature.
    for (const name of await fs.readdir(this.directory)) if (z.string().uuid().safeParse(name).success) await this.removeFolder(path.join(this.directory, name));
  }
  async removeFolder(folder) {
    const resolved = path.resolve(folder);
    if (path.dirname(resolved) !== path.resolve(this.directory) || !z.string().uuid().safeParse(path.basename(resolved)).success) throw new Error('Thư mục sao lưu tạm không hợp lệ.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
  summary(project) { return { id: project.id, name: project.name, fileName: project.fileName, duration: project.duration,
    updatedAt: project.updatedAt, transcriptCount: project.transcript.length, noteCount: project.notes.length,
    speakerCount: project.speakers.length, hasClean: project.processed.noise, hasInsights: !!project.insights }; }
  async inspect(archive, { signal } = {}) {
    await this.cleanup();
    if (this.sessions.size >= 3) throw Object.assign(new Error('Đóng bản sao lưu đang xem trước rồi chọn file khác.'), { status: 409 });
    const token = randomUUID(), folder = path.join(this.directory, token); await fs.mkdir(folder);
    try {
      const unpacked = await inspectBackup(archive, folder, { signal });
      await this.validateAudio(unpacked, signal);
      const session = { ...unpacked, token, folder, expiresAt: this.now() + this.lifetime, inUse: false };
      const review = await this.review(session); this.sessions.set(token, session); return review;
    } catch (error) { await this.removeFolder(folder); throw error; }
  }
  async review(session) {
    const candidates = await this.listProjects();
    const imported = candidates.find(project => project.backupOrigin?.fingerprint === session.manifest.fingerprint);
    let existing = imported || candidates.find(project => project.id === session.project.id), status = 'new', reason = '';
    if (imported) { status = 'duplicate'; reason = 'restored'; }
    else if (existing) {
      const metadataRecord = session.manifest.files.find(record => record.role === 'project');
      let same = false;
      try {
        same = digest(canonical(portableProject(existing))) === metadataRecord.sha256;
        if (same) for (const record of session.manifest.files.filter(record => record.role !== 'project')) {
          const file = path.join(this.mediaDir, existing.id, existing.files[record.role]);
          const actual = await fileHash(file);
          if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) { same = false; break; }
        }
      } catch { same = false; }
      status = same ? 'duplicate' : 'conflict'; reason = same ? 'same' : 'different';
    }
    return { token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), status, reason,
      project: this.summary(session.project), exportedAt: session.manifest.exportedAt,
      totalBytes: session.manifest.files.reduce((sum, record) => sum + record.bytes, 0), existing: existing ? this.summary(existing) : null };
  }
  session(token) {
    z.string().uuid().parse(token);
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= this.now()) throw Object.assign(new Error('Bản xem trước đã hết hạn. Chọn lại file ZIP.'), { status: 410 });
    return session;
  }
  restore(token, mode = 'restore') {
    const operation = this.serial.catch(() => {}).then(async () => {
      z.enum(['restore', 'copy']).parse(mode);
      const session = this.session(token); session.inUse = true;
      try {
        const review = await this.review(session);
        if (review.status === 'duplicate') return { status: 'duplicate', project: await this.loadProject(review.existing.id) };
        if (review.status === 'conflict' && mode !== 'copy') return { status: 'conflict', review };
        if (this.isBusy()) throw Object.assign(new Error('Đợi tác vụ hiện tại hoàn tất trước khi khôi phục.'), { status: 409 });
        let id = session.project.id;
        if (id === 'demo' || review.status === 'conflict') {
          // Deterministic per-snapshot ID makes a retried or interrupted copy idempotent.
          const hex = digest(`audio-toolkit-restore:${session.manifest.fingerprint}`).slice(0, 32).split('');
          hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
          const value = hex.join(''); id = `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
        }
        try { await this.loadProject(id); throw Object.assign(new Error('Mã dự án khôi phục đã được sử dụng. Dự án hiện có được giữ nguyên.'), { status: 409 }); }
        catch (error) { if (error.status !== 404) throw error; }
        const destination = path.join(this.mediaDir, id), pending = path.join(session.folder, 'commit');
        await fs.mkdir(pending, { recursive: true });
        const project = { ...session.project, id, isDemo: false, files: session.files,
          backupOrigin: { fingerprint: session.manifest.fingerprint, sourceId: session.project.id, restoredAt: new Date(this.now()).toISOString() } };
        try {
          for (const role of ['original', 'source', 'playback', ...(project.processed.noise ? ['clean'] : [])]) {
            const output = path.join(pending, session.files[role]);
            await fs.copyFile(path.join(session.audio, session.files[role]), output);
            const handle = await fs.open(output, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
          }
          // The directory can only be an incomplete import for this unused UUID.
          // Never replace media attached to a committed project.
          const target = path.resolve(destination);
          if (path.dirname(target) !== path.resolve(this.mediaDir) || !z.string().uuid().safeParse(path.basename(target)).success) throw new Error('Thư mục dự án không hợp lệ.');
          await fs.rm(target, { recursive: true, force: true });
          await fs.rename(pending, target);
          await this.persist(project);
          return { status: 'restored', project };
        } catch (error) {
          // A failed commit exposes no partial library entry. Existing projects are untouched.
          try { await this.loadProject(id); }
          catch (missing) { if (missing.status === 404) await fs.rm(destination, { recursive: true, force: true }); }
          throw error;
        }
      } finally { session.inUse = false; }
    });
    this.serial = operation; return operation;
  }
  async discard(token) {
    const session = this.sessions.get(token);
    if (session?.inUse) return;
    if (session) { this.sessions.delete(token); await this.removeFolder(session.folder); }
  }
  async cleanup() {
    for (const session of this.sessions.values()) if (!session.inUse && session.expiresAt <= this.now()) await this.discard(session.token);
  }
}
