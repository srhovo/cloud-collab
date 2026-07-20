import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'scripts', 'validate.mjs');
const original = fs.readFileSync(sourcePath, 'utf8');
const frozenBuildBlock = `const packageJson = JSON.parse(read('package.json'));
const activeBuildScript = String(packageJson?.scripts?.build || '').includes('build-stage5g.mjs')
  ? 'scripts/build-stage5g.mjs'
  : 'scripts/build.mjs';`;
const activeBuildBlock = `const packageJson = JSON.parse(read('package.json'));
const buildCommand = String(packageJson?.scripts?.build || '');
const activeBuildScript = buildCommand.includes('build-stage7g-release-candidate.mjs')
  ? 'scripts/build-stage7g-release-candidate.mjs'
  : (buildCommand.includes('build-stage6b-compatible.mjs')
    ? 'scripts/build-stage6b-compatible.mjs'
    : (buildCommand.includes('build-stage6b-active.mjs')
      ? 'scripts/build-stage6b-active.mjs'
      : (buildCommand.includes('build-stage6b.mjs')
        ? 'scripts/build-stage6b.mjs'
        : (buildCommand.includes('build-stage5g.mjs') ? 'scripts/build-stage5g.mjs' : 'scripts/build.mjs'))));`;
const frozenShellCheck = `check('candidate retains the 8.2.28 shell and Stage4C compatibility', output.includes("const APP_VERSION = '8.2.28';") && output.includes('<title>码单器8.2.28（公共协作候选派发客户端）</title>'));`;
const activeShellCheck = `check('candidate uses the owner-approved 8.2.30 shell and retains Stage4C compatibility', output.includes("const APP_VERSION = '8.2.30';") && output.includes('<title>码单器8.2.30（公共协作完整候选版）</title>'));`;
if (!original.includes(frozenBuildBlock)) throw new Error('阶段4C兼容验证器的活动构建锚点已变化');
if (!original.includes(frozenShellCheck)) throw new Error('阶段4C兼容验证器的8.2.28外壳锚点已变化');
const adapted = original
  .replace(frozenBuildBlock, activeBuildBlock)
  .replace(frozenShellCheck, activeShellCheck);
const tempPath = path.join(root, 'scripts', `.validate-active-${process.pid}-${Date.now()}.mjs`);
try {
  fs.writeFileSync(tempPath, adapted, 'utf8');
  const result = spawnSync(process.execPath, [tempPath], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(tempPath, { force: true });
}
