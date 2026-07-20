import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'scripts', 'validate.mjs');
const original = fs.readFileSync(sourcePath, 'utf8');
const frozenBlock = `const packageJson = JSON.parse(read('package.json'));
const activeBuildScript = String(packageJson?.scripts?.build || '').includes('build-stage5g.mjs')
  ? 'scripts/build-stage5g.mjs'
  : 'scripts/build.mjs';`;
const activeBlock = `const packageJson = JSON.parse(read('package.json'));
const buildCommand = String(packageJson?.scripts?.build || '');
const activeBuildScript = buildCommand.includes('build-stage6b.mjs')
  ? 'scripts/build-stage6b.mjs'
  : (buildCommand.includes('build-stage5g.mjs') ? 'scripts/build-stage5g.mjs' : 'scripts/build.mjs');`;
if (!original.includes(frozenBlock)) throw new Error('阶段4C兼容验证器的活动构建锚点已变化');
const adapted = original.replace(frozenBlock, activeBlock);
const tempPath = path.join(root, 'scripts', `.validate-active-${process.pid}-${Date.now()}.mjs`);
try {
  fs.writeFileSync(tempPath, adapted, 'utf8');
  const result = spawnSync(process.execPath, [tempPath], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(tempPath, { force: true });
}
