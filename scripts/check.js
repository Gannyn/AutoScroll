import { readFile, readdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
for (const file of [manifest.background.service_worker, manifest.action.default_popup]) await access(`extension/${file}`);
for (const directory of ['extension', 'scripts', 'tests']) {
  for (const file of await readdir(directory)) {
    if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'pipe' });
  }
}
const popup = await readFile('extension/popup.html', 'utf8');
for (const [, file] of popup.matchAll(/(?:src|href)="([^"#]+)"/g)) await access(`extension/${file}`);
console.log('Manifest、资源引用与所有 JavaScript 语法检查通过。');
