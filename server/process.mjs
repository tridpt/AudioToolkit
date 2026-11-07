import { spawn } from 'node:child_process';

export async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') { child.kill(); return; }
  // A Windows virtualenv Python launcher can have a second Python process.
  // Stop the whole owned tree so cancelling a queue item releases the AI worker.
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const fallback = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); resolve(); };
    killer.once('error', fallback);
    killer.once('close', code => { if (code !== 0) fallback(); else resolve(); });
  });
}
