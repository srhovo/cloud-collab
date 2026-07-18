import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultDir = path.join(root, 'test-results');
fs.mkdirSync(resultDir, { recursive: true });

const stages = [
  ['build-base', ['run', 'build:base']],
  ['unit-tests', ['test']],
  ['validate-base', ['run', 'validate:base']],
  ['build-stage4c', ['run', 'build:stage4c']],
  ['validate-stage4c', ['run', 'validate:stage4c']],
];
const summary = [];

for (const [name, args] of stages) {
  const result = spawnSync('npm', args, { cwd: root, encoding: 'utf8', env: process.env });
  const entry = {
    name,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || '').slice(-12000),
    stderr: String(result.stderr || '').slice(-12000),
  };
  summary.push(entry);
  console.log(JSON.stringify({ stage: name, ok: entry.ok, status: entry.status }));
  if (!entry.ok) {
    fs.writeFileSync(path.join(resultDir, 'ci-failure.json'), JSON.stringify({ failedStage: name, stages: summary }, null, 2), 'utf8');
    console.error(entry.stdout);
    console.error(entry.stderr);
    process.exit(result.status || 1);
  }
}

fs.writeFileSync(path.join(resultDir, 'ci-summary.json'), JSON.stringify({ ok: true, stages: summary.map(({ stdout, stderr, ...entry }) => entry) }, null, 2), 'utf8');
