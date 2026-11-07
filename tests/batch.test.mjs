import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createBatchArchive, batchExportRequestSchema } from '../server/batch.mjs';

const project = {
  id: 'demo', name: 'Bài giảng tiếng Việt', fileName: 'bài giảng.wav', duration: 25,
  language: 'vi', speakers: [{ id: 's1', name: 'Cô Hương', color: '#7472e9' }],
  transcript: [{ id: 'a', time: 3.25, end: 20, speaker: 's1', text: 'Giữ tiếng Việt có dấu: ă â đ ê ô ơ ư.', confidence: 95 }],
  notes: [{ id: 'n1', time: 8.5, text: 'Ghi chú có mốc thời gian.' }], insights: null,
};

test('batch ZIP preserves Vietnamese and all formats, with distinct folders for identical names', async () => {
  const formats = ['docx', 'pdf', 'txt', 'json', 'srt', 'vtt'];
  const archive = await createBatchArchive({ layout: 'lesson', items: [
    { project, formats }, { project: { ...project, notes: [{ ...project.notes[0], text: 'Bản thứ hai.' }] }, formats },
  ] }, { exportedAt: '2026-10-24T01:02:03Z' });
  const zip = await JSZip.loadAsync(archive.buffer);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  assert.equal(entries.length, 13);
  const manifest = JSON.parse(await zip.file('audio-toolkit-manifest.json').async('string'));
  assert.equal(manifest.files.length, 12);
  assert.equal(new Set(manifest.files.map(item => item.path)).size, 12);
  for (const [index, prefix] of ['01 - ', '02 - '].entries()) {
    const files = manifest.files.filter(item => item.path.startsWith(prefix));
    assert.equal(files.length, formats.length);
    for (const entry of files) {
      const content = await zip.file(entry.path).async('nodebuffer');
      assert.equal(content.length, entry.bytes);
      if (entry.format === 'docx') {
        const xml = await (await JSZip.loadAsync(content)).file('word/document.xml').async('string');
        assert.ok(xml.includes(project.transcript[0].text));
        assert.ok(xml.includes(index ? 'Bản thứ hai.' : project.notes[0].text));
      } else if (entry.format === 'pdf') assert.equal(content.subarray(0, 5).toString(), '%PDF-');
      else if (entry.format === 'json') {
        const data = JSON.parse(content); assert.equal(data.transcript[0].text, project.transcript[0].text);
        assert.equal(data.files, undefined); assert.equal(data.audioUrl, undefined);
      } else { assert.ok(content.toString().includes(project.transcript[0].text)); assert.ok(content.toString().includes('Cô Hương')); }
    }
  }
});

test('batch export rejects malformed, oversized and unsupported requests without unsafe paths', async () => {
  const valid = { project, formats: ['txt'] };
  for (const body of [{ items: [] }, { items: Array(21).fill(valid) }, { items: [{ ...valid, formats: ['exe'] }] },
    { items: [{ ...valid, project: { ...project, files: { original: '../private.wav' } } }] },
    { items: [{ ...valid, project: { ...project, notes: [{ ...project.notes[0], time: 100 }] } }] }]) {
    assert.equal(batchExportRequestSchema.safeParse(body).success, false);
  }
  const archive = await createBatchArchive({ items: [{ project: { ...project, name: '../Bài\\giảng\r\n' }, formats: ['txt', 'txt'] }] });
  assert.equal(archive.files.length, 1);
  assert.ok(!archive.files[0].path.split('/').some(part => part === '..' || /[\r\n\\]/.test(part)));
});

