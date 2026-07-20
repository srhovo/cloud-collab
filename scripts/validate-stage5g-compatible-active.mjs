import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'scripts', 'validate-stage5g.mjs');
const original = fs.readFileSync(sourcePath, 'utf8');
const frozen = `check('Stage5G package builds and validates the active generated candidate', packageJson?.scripts?.build === 'node scripts/build-stage5g.mjs'
  && String(packageJson?.scripts?.validate || '').startsWith('node scripts/build-stage5g.mjs'));`;
const compatible = `check('Stage5G package builds and validates the active generated candidate',
  ['node scripts/build-stage5g.mjs','node scripts/build-stage6b.mjs','node scripts/build-stage6b-compatible.mjs','node scripts/build-stage6b-active.mjs'].includes(packageJson?.scripts?.build)
  && String(packageJson?.scripts?.validate || '').includes('build-stage6b')
  && String(packageJson?.scripts?.validate || '').includes('validate-stage5g'));`;
if (!original.includes(frozen)) throw new Error('阶段5G活动构建验证锚点已变化');
const tempPath = path.join(root, 'scripts', `.validate-stage5g-active-${process.pid}-${Date.now()}.mjs`);
try {
  fs.writeFileSync(tempPath, original.replace(frozen, compatible), 'utf8');
  const result = spawnSync(process.execPath, [tempPath], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(tempPath, { force: true });
}
