import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mappings = [['../tests/browser/recorder.html', '../public/recording-check.html'], ['../tests/browser/recorder-check.js', '../public/recording-check.js']];
for (const [source, target] of mappings) {
  const destination = fileURLToPath(new URL(target, import.meta.url));
  if (process.argv.includes('--remove')) await fs.unlink(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
  else await fs.copyFile(new URL(source, import.meta.url), destination);
}
console.log(process.argv.includes('--remove') ? 'Removed the two temporary browser recording fixtures.' : 'Open http://127.0.0.1:4188/recording-check.html to test recording with synthetic audio, then run node scripts/recording-fixture.mjs --remove.');
