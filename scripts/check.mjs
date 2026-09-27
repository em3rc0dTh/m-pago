import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const folder of ['src', 'examples', 'scripts', 'test']) {
  for (const entry of readdirSync(folder, { recursive: true })) {
    if (!/\.(mjs|js)$/.test(entry)) continue;
    const result = spawnSync(process.execPath, ['--check', `${folder}/${entry}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(1);
  }
}
console.log('All JavaScript files parse successfully.');
