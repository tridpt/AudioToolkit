import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopProcess } from '../server/process.mjs';

test('Windows cancellation stops the owned process and its virtualenv-style child', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const source = `const {spawn}=require('node:child_process'); const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); console.log(worker.pid); setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let workerPid;
  try {
    workerPid = Number((await once(parent.stdout, 'data'))[0].toString().trim());
    assert.ok(workerPid > 0); process.kill(workerPid, 0);
    const closed = once(parent, 'close');
    await stopProcess(parent); await closed;
    assert.throws(() => process.kill(workerPid, 0), error => error.code === 'ESRCH');
    await stopProcess(parent);
  } finally {
    await stopProcess(parent);
    if (workerPid) { try { process.kill(workerPid); } catch {} }
  }
});
