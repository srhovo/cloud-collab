import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ADMIN_CONSOLE_FILES } from '../scripts/prepare-admin-console-v1.mjs';
import { readProductionRuntimeConfig } from '../src/server/production_runtime_config_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'production-handoff-v1');
const adminBuild = path.join(root, '.edgeone-admin-artifact');
const secrets = [
  'CLOUD_ADMIN_PASSWORD',
  'CLOUD_PRODUCTION_CLIENT_ACCESS_KEY',
  'CLOUD_PRODUCTION_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_SESSION_SECRET',
  'CLOUD_ADMIN_RATE_LIMIT_SALT',
  'CLOUD_ADMIN_DEVICE_REF_SALT',
  'CLOUD_ADMIN_ROLLBACK_REF_SALT',
  'CLOUD_ADMIN_EXPORT_AUDIT_SALT',
];

function run(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}
function sha(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function secretValues() {
  return Object.fromEntries(secrets.map((name, index) => [name, `${name.toLowerCase()}-${index}-${'x'.repeat(40)}`]));
}
function phaseEnv(phase) {
  return {
    ...phase.flags,
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: 'group_see',
    CLOUD_PRODUCTION_LIBRARY_ID: 'lib_see_cz',
    CLOUD_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-production-v1',
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-admin-production-v1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://app.example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: 'https://admin.example.invalid',
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: phase.id === 'bootstrap_once' ? 'INITIALIZE-see-see_cz-V1' : '',
    ...secretValues(),
  };
}

test('生产交接包可重复构建且保持零部署零写入', () => {
  const result = run(['scripts/build-production-handoff-v1.mjs']);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'handoff-manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'prepared_not_deployed');
  assert.deepEqual(manifest.publicArtifactAllowlist, ['index.html', 'build-manifest.json', 'pages-release.json']);
  assert.equal(manifest.boundaries.containsRealSecrets, false);
  assert.equal(manifest.boundaries.edgeOneDeploymentPerformed, false);
  assert.equal(manifest.boundaries.blobReadsPerformed, 0);
  assert.equal(manifest.boundaries.blobWritesPerformed, 0);
  assert.equal(manifest.boundaries.blobDeletesPerformed, 0);
  assert.equal(manifest.boundaries.productionFlagsChanged, 0);
  assert.equal(manifest.boundaries.stablePromotionAuthorized, false);
  assert.equal(manifest.boundaries.stablePromotionPerformed, false);
});

test('交接包复用阶段8D管理员四文件产物且保持普通产物互斥', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'handoff-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.adminArtifactFiles, ADMIN_CONSOLE_FILES.map(name => `admin-artifact/${name}`));
  for (const filename of ADMIN_CONSOLE_FILES) {
    assert.equal(sha(path.join(adminBuild, filename)), sha(path.join(output, 'admin-artifact', filename)), filename);
  }
  assert.equal(fs.existsSync(path.join(output, 'index.html')), false);
  assert.equal(fs.existsSync(path.join(output, 'build-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(output, 'pages-release.json')), false);
  const adminRelease = JSON.parse(fs.readFileSync(path.join(output, 'admin-artifact', 'admin-release.json'), 'utf8'));
  assert.equal(adminRelease.includesOrdinaryUserCandidate, false);
  assert.equal(adminRelease.includesSecretValues, false);
  assert.equal(adminRelease.productionCapabilitiesDefaultOff, true);
});

test('八个分阶段开关组合全部通过正式运行时依赖校验', () => {
  const plan = JSON.parse(fs.readFileSync(path.join(output, 'activation-phases.json'), 'utf8'));
  assert.deepEqual(plan.phases.map(item => item.order), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(plan.stablePromotionAuthorized, false);
  for (const phase of plan.phases) {
    const config = readProductionRuntimeConfig(phaseEnv(phase));
    assert.equal(config.mode, phase.expectedMode, phase.id);
    assert.equal(config.stablePromotionAuthorized, false, phase.id);
  }
});

test('交接包只保留空秘密槽位且无聊天泄露值', () => {
  const template = fs.readFileSync(path.join(output, 'config', 'production.env.template'), 'utf8');
  for (const name of secrets) assert.match(template, new RegExp(`^${name}=$`, 'mu'));
  const texts = fs.readdirSync(output, { recursive: true })
    .filter(item => fs.statSync(path.join(output, item)).isFile())
    .map(item => fs.readFileSync(path.join(output, item), 'utf8'))
    .join('\n');
  assert.doesNotMatch(texts, /xiaxue76|2406048740@qq\.com|eo_token=/u);
  assert.doesNotMatch(texts, /CLOUD_ADMIN_PASSWORD=\S|EDGEONE_API_TOKEN=\S/u);
});

test('Blob初始化器默认只生成10资源零写入计划', () => {
  const report = 'dist/stage8e-test-bootstrap-plan.json';
  fs.rmSync(path.join(root, report), { force: true });
  const result = run(['scripts/run-edgeone-production-bootstrap-v1.mjs'], { BOOTSTRAP_REPORT_PATH: report });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.operation, 'plan');
  assert.equal(payload.status, 'ready_not_executed');
  assert.equal(payload.resourceCount, 10);
  assert.equal(payload.realBlobReadsPerformed, 0);
  assert.equal(payload.realBlobWritesPerformed, 0);
  assert.equal(payload.realBlobDeletesPerformed, 0);
  assert.equal(payload.realSecretValuesExposed, false);
});

test('真实初始化缺少项目ID或Token时在Store访问前失败', () => {
  const result = run(['scripts/run-edgeone-production-bootstrap-v1.mjs', '--execute'], {
    EDGEONE_PROJECT_ID: '',
    EDGEONE_API_TOKEN: '',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: 'INITIALIZE-see-see_cz-V1',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EDGEONE_PROJECT_ID_INVALID/u);
  assert.doesNotMatch(result.stderr, /[A-Za-z0-9_-]{32,}/u);
});

test('手动工作流默认plan且真实写入要求execute和精确确认', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/stage8e-edgeone-production-bootstrap.yml'), 'utf8');
  assert.match(workflow, /default:\s*plan/u);
  assert.match(workflow, /inputs\.operation == 'execute'/u);
  assert.match(workflow, /INITIALIZE-see-see_cz-V1/u);
  assert.match(workflow, /secrets\.EDGEONE_PROJECT_ID/u);
  assert.match(workflow, /secrets\.EDGEONE_API_TOKEN/u);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request):/mu);
});
