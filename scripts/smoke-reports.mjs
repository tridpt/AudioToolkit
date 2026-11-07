import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import { buildInsights } from '../public/insights.js';
import { reportSnapshot } from '../public/reports.js';

const base = process.env.AUDIO_URL || 'http://127.0.0.1:4188';
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const getProject = async () => (await fetch(`${base}/api/projects/demo`)).json();
const before = await getProject();
const project = reportSnapshot(before);
project.name = 'Báo cáo tiếng Việt — Phỏng vấn sáng tạo';
project.transcript[0].text += '\nGhi nhận bổ sung: chữ Việt ă â đ ê ô ơ ư ắ ằ ặ ễ ỗ ỡ ự & <đối chiếu>.';
project.notes.unshift({ id: 'report-qa', time: 10.5, text: 'Ghi chú kiểm tra: báo cáo giữ nguyên tiếng Việt có dấu.' });
project.insights = buildInsights(project);
const directory = 'data/checks/reports';
await fs.mkdir(directory, { recursive: true });
const exported = [];
for (const layout of ['podcast', 'lesson', 'interview']) for (const format of ['docx', 'pdf']) {
  const response = await fetch(`${base}/api/projects/demo/reports`, json({ format, layout, project }));
  assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-disposition').includes("filename*=UTF-8''"));
  const filename = decodeURIComponent(response.headers.get('content-disposition').match(/filename\*=UTF-8''([^;]+)/)[1]);
  assert.equal(filename, `${project.name}-bao-cao.${format}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), buffer.length);
  if (format === 'docx') {
    assert.match(response.headers.get('content-type'), /wordprocessingml/);
    const zip = await JSZip.loadAsync(buffer), xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes(project.name)); assert.ok(xml.includes(project.notes[0].text)); assert.match(xml, /&lt;đối chiếu&gt;/);
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    assert.match(rels, /project=demo&amp;t=10\.5/);
  } else { assert.match(response.headers.get('content-type'), /application\/pdf/); assert.equal(buffer.subarray(0, 5).toString(), '%PDF-'); }
  await fs.writeFile(`${directory}/${layout}.${format}`, buffer);
  exported.push({ layout, format, size: buffer.length });
}
const persisted = await fetch(`${base}/api/projects/demo/reports`, json({ format: 'docx' }));
assert.equal(persisted.status, 200);
const savedXml = await (await JSZip.loadAsync(Buffer.from(await persisted.arrayBuffer()))).file('word/document.xml').async('string');
assert.ok(!savedXml.includes(project.notes[0].text), 'Without a snapshot, the API exports the persisted project.');
const stale = structuredClone(project); stale.transcript[0].text = 'Transcript đã sửa sau khi tạo tóm tắt.';
const staleResponse = await fetch(`${base}/api/projects/demo/reports`, json({ format: 'docx', project: stale }));
assert.equal(staleResponse.status, 200);
const staleBuffer = Buffer.from(await staleResponse.arrayBuffer());
assert.match(await (await JSZip.loadAsync(staleBuffer)).file('word/document.xml').async('string'), /Tóm tắt chưa cập nhật/);
await fs.writeFile(`${directory}/stale.docx`, staleBuffer);
const long = { ...project, name: 'Bài giảng dài có tiếng Việt', insights: null,
  transcript: [{ ...project.transcript[0], end: project.duration, text: 'Đoạn lời giảng dài vẫn giữ nguyên tiếng Việt và mốc thời gian. '.repeat(70) + ' Kết thúc transcript.' }],
  notes: [{ id: 'long-note', time: 30, text: 'Ghi chú nhiều dòng.\n'.repeat(60) + 'Kết thúc ghi chú.' }],
};
for (const format of ['docx', 'pdf']) {
  const response = await fetch(`${base}/api/projects/demo/reports`, json({ format, layout: 'interview', project: long }));
  assert.equal(response.status, 200);
  await fs.writeFile(`${directory}/long.${format}`, Buffer.from(await response.arrayBuffer()));
}
for (const body of [{ format: 'exe' }, { format: 'pdf', layout: 'custom' }, { format: 'docx', project: { ...project, duration: -1 } },
  { format: 'pdf', project: { ...project, id: '00000000-0000-4000-8000-000000000000' } }, { format: 'pdf', file: '../secret' }]) {
  assert.equal((await fetch(`${base}/api/projects/demo/reports`, json(body))).status, 400, JSON.stringify(body));
}
const outside = await fetch(`${base}/api/projects/demo/reports`, { ...json({ format: 'pdf' }), headers: { 'Content-Type': 'application/json', Origin: 'https://outside.example' } });
assert.equal(outside.status, 403);
assert.equal((await fetch(`${base}/api/projects/00000000-0000-4000-8000-000000000000/reports`, json({ format: 'pdf' }))).status, 404);
assert.deepEqual(await getProject(), before, 'Report exports must not change project data.');
console.log(JSON.stringify({ result: 'passed', exported, checked: ['Unicode', 'MIME and filename headers', 'timestamp hyperlinks', 'three layouts', 'current snapshot and persisted fallback', 'stale summary', 'input errors', 'origin', 'source preservation'] }, null, 2));
