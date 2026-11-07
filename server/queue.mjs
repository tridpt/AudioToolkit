import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { optionsSchema } from './domain.mjs';
import { batchProgress } from '../public/batch-progress.js';

export const MAX_QUEUE_FILES = 20;
const uuid = z.string().uuid();
export const queueFileSchema = z.object({
  generation: uuid, id: uuid, name: z.string().min(1).max(255), size: z.number().int().positive().max(250 * 1024 * 1024),
}).strict();
const itemSchema = queueFileSchema.omit({ generation: true }).extend({
  projectId: uuid, uploaded: z.boolean(), imported: z.boolean(),
  status: z.enum(['awaiting-upload', 'queued', 'importing', 'processing', 'cancelling', 'completed', 'failed', 'cancelled']),
  cancelRequested: z.boolean(), options: optionsSchema.nullable(), error: z.string(), message: z.string(),
  createdAt: z.string(), finishedAt: z.string().nullable(),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), generation: uuid, revision: z.number().int().nonnegative(), enabled: z.boolean(),
  clearing: z.boolean(), options: optionsSchema.nullable(), items: z.array(itemSchema).max(MAX_QUEUE_FILES),
}).strict().refine(state => new Set(state.items.map(item => item.id)).size === state.items.length
  && new Set(state.items.map(item => item.projectId)).size === state.items.length, 'Mã hàng đợi bị trùng.');
const terminal = new Set(['completed', 'failed', 'cancelled']);
const failure = (status, message) => Object.assign(new Error(message), { status });

// The old file remains intact until the new, flushed snapshot is renamed into place.
export async function atomicQueueWrite(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

export class DurableQueue {
  static async open(config) {
    const queue = new DurableQueue(config);
    await fs.mkdir(queue.staging, { recursive: true });
    try { queue.state = stateSchema.parse(JSON.parse(await fs.readFile(queue.file, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Không đọc được hàng đợi tại ${queue.file}. File được giữ nguyên. ${error.message}`);
      queue.state = { version: 1, generation: randomUUID(), revision: 0, enabled: false, clearing: false, options: null, items: [] };
    }
    await queue.recover();
    return queue;
  }

  constructor({ directory, acquire, execute, release = () => {}, stop = async () => {}, hasProject = async () => false,
    write = atomicQueueWrite, onError = error => console.error(error.message) }) {
    this.file = path.join(directory, 'queue.json');
    this.staging = path.join(directory, 'queue-uploads');
    Object.assign(this, { acquire, execute, release, stop, hasProject, write, onError });
    this.serial = Promise.resolve(); this.active = null; this.stopping = false; this.storageError = '';
  }

  uploadPath(id) { uuid.parse(id); return path.join(this.staging, `${id}.audio`); }

  async recover() {
    await this.change(async next => {
      if (next.clearing) { next.items = []; next.clearing = false; next.enabled = false; }
      for (const item of next.items) {
        const stat = await fs.stat(this.uploadPath(item.id)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        item.uploaded = stat?.size === item.size;
        item.imported = await this.hasProject(item.projectId);
        if (item.cancelRequested || item.status === 'cancelling') {
          item.status = 'cancelled'; item.message = 'Đã huỷ. Kết quả đã xong vẫn được giữ.';
        } else if (['importing', 'processing'].includes(item.status)) {
          item.status = 'queued'; item.message = 'Đã khôi phục. Sẽ tiếp tục từ bước chưa xong.';
        } else if (item.status === 'awaiting-upload' && item.uploaded) {
          item.status = 'queued'; item.message = 'File đã được lưu trên máy.';
        }
        if (item.status === 'queued' && !item.uploaded && !item.imported) {
          item.status = 'awaiting-upload'; item.message = 'Tải file chưa xong. Chọn lại file để tiếp tục.';
        }
        if (item.status === 'completed' && !item.imported) {
          item.status = 'failed'; item.error = 'Không tìm thấy dự án đã lưu. Chọn lại file để thử lại.';
        }
      }
      if (!next.items.some(item => !terminal.has(item.status))) next.enabled = false;
    });
    await this.cleanUploads();
  }

  change(operation) {
    const result = this.serial.catch(() => {}).then(async () => {
      const next = structuredClone(this.state);
      await operation(next);
      next.revision++;
      stateSchema.parse(next);
      try { await this.write(this.file, next); }
      catch (error) { this.storageError = `Không lưu được hàng đợi: ${error.message}`; throw failure(503, this.storageError); }
      this.state = next; this.storageError = '';
      return this.view();
    });
    this.serial = result;
    return result;
  }

  view() {
    const { generation, revision, enabled, clearing, options } = this.state;
    return { generation, revision, enabled, clearing, options, error: this.storageError,
      running: !!this.active || enabled && this.state.items.some(item => ['queued', 'importing', 'processing'].includes(item.status)),
      items: this.state.items.map(item => {
        const task = this.active?.id === item.id ? this.active.task : null;
        const job = task ? { id: task.id, projectId: item.projectId, kind: task.kind, status: task.status,
          stage: task.stage, progress: task.progress, message: task.message } : null;
        return { id: item.id, name: item.name, size: item.size, status: item.status, uploaded: item.uploaded, imported: item.imported,
          project: item.imported ? { id: item.projectId } : null, options: item.options, error: item.error,
          message: item.status === 'cancelling' ? 'Đang huỷ tác vụ…' : job?.message || item.message,
          stage: job?.stage || '', progress: item.status === 'completed' ? 1 : job ? batchProgress(job) : null, job };
      }),
    };
  }

  find(state, id) {
    uuid.parse(id);
    const item = state.items.find(entry => entry.id === id);
    if (!item) throw failure(404, 'Không tìm thấy file trong hàng đợi.');
    return item;
  }

  async reserve(body) {
    const input = queueFileSchema.parse(body);
    return this.change(next => {
      if (next.clearing || next.generation !== input.generation) throw failure(409, 'Hàng đợi đã thay đổi. Mở lại hàng đợi rồi thêm file.');
      const existing = next.items.find(item => item.id === input.id);
      if (existing) {
        if (existing.name !== input.name || existing.size !== input.size) throw failure(409, 'Mã này đã thuộc về file khác.');
        return;
      }
      if (next.items.length >= MAX_QUEUE_FILES) throw failure(409, `Mỗi hàng đợi nhận tối đa ${MAX_QUEUE_FILES} file.`);
      next.items.push({ id: input.id, name: input.name, size: input.size, projectId: randomUUID(),
        uploaded: false, imported: false, status: 'awaiting-upload', cancelRequested: false, options: null, error: '',
        message: 'Đang chờ tải file lên máy.', createdAt: new Date().toISOString(), finishedAt: null });
    });
  }

  async attach(id, source, size) {
    const snapshot = await this.change(async next => {
      const item = this.find(next, id);
      if (next.clearing || item.cancelRequested) throw failure(409, 'File đã bị huỷ hoặc bỏ khỏi hàng đợi.');
      if (size !== item.size) throw failure(400, 'Kích thước file không khớp. Chọn lại đúng file ban đầu.');
      if (item.uploaded || item.imported) return; // Retrying a lost HTTP response never replaces durable input.
      if (item.status !== 'awaiting-upload') throw failure(409, 'Nhấn Thử lại trước khi tải lại file.');
      await fs.rename(source, this.uploadPath(id));
      const handle = await fs.open(this.uploadPath(id), 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      item.uploaded = true; item.status = 'queued'; item.error = ''; item.message = 'File đã được lưu trên máy.';
    });
    this.wake(); return snapshot;
  }

  async start(body) {
    const { generation, options } = z.object({ generation: uuid, options: optionsSchema }).strict().parse(body);
    const snapshot = await this.change(next => {
      if (next.generation !== generation || next.clearing) throw failure(409, 'Hàng đợi đã thay đổi. Hãy tải lại danh sách.');
      if (next.enabled) return; // Idempotent across tabs and a lost start response.
      if (next.items.some(item => item.status === 'awaiting-upload')) throw failure(409, 'Tải đủ các file lên máy trước khi bắt đầu.');
      if (!next.items.some(item => item.status === 'queued')) throw failure(409, 'Không có file chờ xử lý.');
      next.enabled = true; next.options = options;
      for (const item of next.items) if (item.status === 'queued' && !item.options) item.options = options;
    });
    this.wake(); return snapshot;
  }

  async cancel(id) {
    const snapshot = await this.change(next => {
      const item = this.find(next, id);
      if (terminal.has(item.status)) return;
      item.cancelRequested = true;
      item.status = this.active?.id === id ? 'cancelling' : 'cancelled';
      item.message = 'Đã huỷ. Kết quả đã xong vẫn được giữ.';
    });
    if (this.active?.id === id) { this.active.task.cancelled = true; await this.stop(this.active.task); }
    this.wake(); return snapshot;
  }

  async retry(id) {
    const snapshot = await this.change(next => {
      const item = this.find(next, id);
      if (!terminal.has(item.status) || item.status === 'completed' || this.active?.id === id) throw failure(409, 'Đợi file dừng trước khi thử lại.');
      item.cancelRequested = false; item.error = ''; item.finishedAt = null;
      item.status = item.uploaded || item.imported ? 'queued' : 'awaiting-upload';
      item.message = item.options ? 'Tiếp tục bước chưa xong với thiết lập của lần chạy trước.' : 'Chọn lại file để tải lên máy.';
    });
    this.wake(); return snapshot;
  }

  async retryStorage() {
    if (this.active) throw failure(409, 'Đợi tác vụ hiện tại dừng trước khi thử lưu lại.');
    await this.recover(); this.wake(); return this.view();
  }

  async remove(id) {
    const snapshot = await this.change(next => {
      const item = this.find(next, id);
      if (this.active?.id === id || ['importing', 'processing', 'cancelling'].includes(item.status)) throw failure(409, 'Huỷ file trước khi bỏ khỏi hàng đợi.');
      next.items = next.items.filter(entry => entry.id !== item.id);
    });
    await this.discardUpload(id); this.wake(); return snapshot;
  }

  async clear() {
    const snapshot = await this.change(next => {
      next.generation = randomUUID(); next.enabled = false; next.clearing = true;
      next.items = next.items.filter(item => this.active?.id === item.id);
      if (next.items.length) { next.items[0].cancelRequested = true; next.items[0].status = 'cancelling'; }
      else next.clearing = false;
    });
    if (this.active) { this.active.task.cancelled = true; await this.stop(this.active.task); }
    await this.cleanUploads(); this.wake(); return snapshot;
  }

  async discardUpload(id) { await fs.unlink(this.uploadPath(id)).catch(error => { if (error.code !== 'ENOENT') this.onError(error); }); }
  async cleanUploads() {
    const keep = new Set(this.state.items.filter(item => !item.imported).map(item => `${item.id}.audio`));
    for (const file of await fs.readdir(this.staging)) {
      if (/^[0-9a-f-]{36}\.audio$/.test(file) && !keep.has(file)) await fs.unlink(path.join(this.staging, file)).catch(error => this.onError(error));
    }
  }

  startWorker() {
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  wake() {
    if (this.stopping || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.pump().catch(error => this.onError(error));
    }, 0);
  }

  async pump() {
    if (this.active || this.stopping || this.storageError) return;
    await this.serial.catch(() => {});
    if (this.active || this.stopping || !this.state.enabled || this.state.clearing || this.storageError) return;
    const item = this.state.items.find(entry => entry.status === 'queued');
    if (!item) {
      if (!this.state.items.some(entry => entry.status === 'awaiting-upload')) await this.change(next => { next.enabled = false; });
      return;
    }
    const task = this.acquire(item);
    if (!task) return; // A single-project job, import or clip owns the same worker slot.
    const active = { id: item.id, task }; this.active = active;
    try {
      await this.change(next => {
        const current = this.find(next, item.id);
        if (current.cancelRequested || next.clearing || current.status !== 'queued') throw failure(409, 'File đã thay đổi.');
        current.options ||= next.options;
        current.status = current.imported ? 'processing' : 'importing'; current.error = '';
      });
      const input = structuredClone(this.find(this.state, item.id));
      await this.execute({ ...input, path: this.uploadPath(item.id) }, task, async () => {
        await this.change(next => {
          const current = this.find(next, item.id); current.imported = true;
          if (!current.cancelRequested) current.status = 'processing';
        });
        // A saved project now owns its own original, so the staged copy is disposable.
        await this.discardUpload(item.id);
      });
      await this.finish(item.id, task, null);
    } catch (error) {
      // Never launch another file after a persistence failure. A restart recovers
      // from the last snapshot and the atomic per-project stage checkpoint.
      if (!this.storageError) await this.finish(item.id, task, error);
      else this.onError(error);
    } finally {
      this.release(task); if (this.active === active) this.active = null;
      this.wake();
    }
  }

  async finish(id, task, error) {
    await this.change(next => {
      const item = this.find(next, id);
      if (next.clearing) { next.items = []; next.clearing = false; return; }
      if (this.stopping && !item.cancelRequested) {
        item.status = 'queued'; item.message = 'Sẽ tiếp tục khi máy chủ khởi động lại.'; return;
      }
      const cancelled = item.cancelRequested || task.cancelled;
      item.status = cancelled ? 'cancelled' : error ? 'failed' : 'completed';
      item.error = cancelled ? '' : error?.message || '';
      item.message = cancelled ? 'Đã huỷ. Kết quả đã xong vẫn được giữ.' : error ? '' : 'Đã xử lý xong bản thu.';
      item.finishedAt = new Date().toISOString();
    });
  }

  async close() {
    this.stopping = true; clearInterval(this.timer); clearTimeout(this.scheduled);
    if (this.active) { this.active.task.interrupted = true; this.active.task.cancelled = true; await this.stop(this.active.task); }
    await this.serial.catch(() => {});
  }
}
