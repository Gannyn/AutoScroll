import { mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['scripts/check.js'], { stdio: 'inherit' });
const { version } = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const archive = `dist/autoscroll-${version}.zip`;
await mkdir('dist', { recursive: true });
await rm(archive, { force: true });
execFileSync('zip', ['-q', '-r', archive, 'extension', 'README.md', '-x', '*.DS_Store'], { stdio: 'inherit' });
console.log(`已生成 ${archive}`);
