import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

test('xiaxue.site域名选择已固定但平台状态仍未伪造为完成', () => {
  const plan = readJson('release/production-domain-selection-v1.json');
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.stage, '8I');
  assert.equal(plan.registrableDomain, 'xiaxue.site');
  assert.equal(plan.publicHostname, 'app.xiaxue.site');
  assert.equal(plan.administratorHostname, 'admin.xiaxue.site');
  assert.equal(plan.publicOrigin, 'https://app.xiaxue.site');
  assert.equal(plan.administratorOrigin, 'https://admin.xiaxue.site');
  assert.equal(plan.domainStatusConfirmed, false);
  assert.equal(plan.realNameStatusConfirmed, false);
  assert.equal(plan.dnsConfigured, false);
  assert.equal(plan.httpsVerified, false);
});

test('架构未闭环前管理员项目、真实初始化和生产启用全部禁止', () => {
  const plan = readJson('release/production-domain-selection-v1.json');
  assert.equal(plan.administratorProjectCreationAllowed, false);
  assert.equal(plan.realBlobBootstrapAllowed, false);
  assert.equal(plan.productionActivationAllowed, false);
  assert.equal(plan.stablePromotionAuthorized, false);
});
