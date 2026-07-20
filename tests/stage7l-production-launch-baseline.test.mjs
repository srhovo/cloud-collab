import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planPath = path.join(root, 'release', 'production-launch-plan-v1.json');
const templatePath = path.join(root, 'config', 'production.env.template');
const ledgerPath = path.join(root, 'release', 'release-closure-ledger-v1.json');

function parseEnv(text) {
  return new Map(text.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
}

test('阶段7M固化生产目标与授权但不执行稳定晋升', () => {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

  assert.equal(plan.candidate.version, '8.2.31');
  assert.equal(plan.candidate.observationPeriod, 'passed');
  assert.equal(plan.stableRelease.targetVersion, '8.3.0');
  assert.equal(plan.stableRelease.versionSelected, true);
  assert.equal(plan.stableRelease.promotionAuthorized, false);
  assert.equal(plan.stableRelease.promotionPerformed, false);
  assert.equal(plan.stableRelease.separateFinalAuthorizationRequired, true);

  assert.equal(plan.scope.displayLabel, 'club');
  assert.equal(plan.scope.protocolField, 'groupId');
  assert.equal(plan.scope.mappingVersion, 1);
  assert.deepEqual(plan.scope.external, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(plan.scope.protocol, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(plan.scope.legacyPrefixedIdsRemainAccepted, true);

  for (const key of ['readSync', 'ordinarySubmission', 'sensitiveSubmission', 'automaticOrdinaryApproval']) {
    assert.equal(plan.capabilityAuthorization[key], true, `${key}授权必须记录`);
  }
  assert.equal(plan.capabilityAuthorization.activationPerformed, false);
  assert.equal(plan.storage.realBlobWritePerformed, false);
  assert.equal(plan.administrator.username, 'xiaxue');
  assert.equal(plan.administrator.submittedChatSecretAccepted, false);
  assert.equal(plan.access.platformProjectDomainStableWhileProjectExists, true);
  assert.equal(plan.access.platformDomainAnonymousPermanentAccess, false);
  assert.equal(plan.access.platformPreviewAccessTokenTtlHours, 3);

  assert.equal(ledger.stableVersion, '8.2.25');
  assert.equal(ledger.releasePolicy.stablePromotionAuthorized, false);
  assert.equal(ledger.releasePolicy.stablePromotionPerformed, false);
  assert.equal(ledger.releasePolicy.productionWriteEnablementIncluded, false);
});

test('生产环境模板不含真实密钥且所有能力默认关闭', () => {
  const text = fs.readFileSync(templatePath, 'utf8');
  const env = parseEnv(text);
  for (const name of [
    'CLOUD_PRODUCTION_ENABLED',
    'CLOUD_PRODUCTION_READ_SYNC_ENABLED',
    'CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED',
    'CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED',
    'CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED',
    'CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED',
    'CLOUD_ADMIN_PRODUCTION_ENABLED',
    'CLOUD_PRODUCTION_BOOTSTRAP_ENABLED',
  ]) assert.equal(env.get(name), '0');

  assert.equal(env.get('CLOUD_PRODUCTION_EXTERNAL_CLUB_ID'), 'see');
  assert.equal(env.get('CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID'), 'see_cz');
  assert.equal(env.get('CLOUD_PRODUCTION_GROUP_ID'), 'group_see');
  assert.equal(env.get('CLOUD_PRODUCTION_LIBRARY_ID'), 'lib_see_cz');
  assert.equal(env.get('CLOUD_ADMIN_USERNAME'), 'xiaxue');
  assert.equal(env.get('CLOUD_PRODUCTION_PUBLIC_ORIGIN'), '');
  assert.equal(env.get('CLOUD_ADMIN_PUBLIC_ORIGIN'), '');

  for (const name of [
    'CLOUD_ADMIN_PASSWORD',
    'CLOUD_PRODUCTION_CLIENT_ACCESS_KEY',
    'CLOUD_PRODUCTION_RATE_LIMIT_SALT',
    'CLOUD_ADMIN_SESSION_SECRET',
    'CLOUD_ADMIN_RATE_LIMIT_SALT',
    'CLOUD_ADMIN_DEVICE_REF_SALT',
    'CLOUD_ADMIN_ROLLBACK_REF_SALT',
    'CLOUD_ADMIN_EXPORT_AUDIT_SALT',
  ]) assert.equal(env.get(name), '', `${name}模板必须为空`);

  assert.doesNotMatch(text, /eo_token=/iu);
});

test('生产计划校验器与零写入初始化预演成功', () => {
  const validate = spawnSync(process.execPath, ['scripts/validate-production-launch-plan-v1.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(validate.status, 0, validate.stderr || validate.stdout);
  const readiness = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'production-launch-readiness-v1.json'), 'utf8'));
  assert.equal(readiness.status, 'production_preparation_ready_domain_blob_and_secrets_required');
  assert.deepEqual(readiness.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(readiness.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(readiness.githubPagesStaticBackupAuthorized, true);
  assert.equal(readiness.productionActivationPerformed, false);
  assert.equal(readiness.stablePromotionPerformed, false);

  const bootstrap = spawnSync(process.execPath, ['scripts/build-production-bootstrap-plan-v1.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr || bootstrap.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'production-bootstrap-plan-v1.json'), 'utf8'));
  assert.equal(report.mode, 'dry_run');
  assert.deepEqual(report.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(report.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.deepEqual(report.initialSnapshot.scope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(report.oneTimeConfirmation, 'INITIALIZE-see-see_cz-V1');
  assert.equal(report.realBlobReadsPerformed, 0);
  assert.equal(report.realBlobWritesPerformed, 0);
  assert.equal(report.realBlobDeletesPerformed, 0);
  assert.equal(report.productionFeatureFlagsChanged, 0);
  assert.equal(report.stablePromotionPerformed, false);
  assert.match(report.initialSnapshotSha256, /^[a-f0-9]{64}$/u);
});

test('密钥生成器拒绝在CI中运行且不输出密钥文件', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage7l-secrets-'));
  const target = path.join(temp, 'secrets.env');
  const result = spawnSync(process.execPath, ['scripts/generate-production-secrets-v1.mjs', '--output', target], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', GITHUB_ACTIONS: 'true' },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /禁止在CI或GitHub Actions中生成生产密钥/u);
  assert.equal(fs.existsSync(target), false);
  fs.rmSync(temp, { recursive: true, force: true });
});
