import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

test('xiaxue.site注册实名续费和DNS控制权已由负责人证据确认', () => {
  const plan = readJson('release/production-domain-selection-v1.json');
  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.stage, '8L');
  assert.equal(plan.registrableDomain, 'xiaxue.site');
  assert.equal(plan.publicHostname, 'app.xiaxue.site');
  assert.equal(plan.administratorHostname, 'admin.xiaxue.site');
  assert.equal(plan.publicOrigin, 'https://app.xiaxue.site');
  assert.equal(plan.administratorOrigin, 'https://admin.xiaxue.site');
  assert.equal(plan.evidenceSource, 'owner_provided_tencent_cloud_domain_console_screenshot');
  assert.equal(plan.domainStatusConfirmed, true);
  assert.equal(plan.realNameStatusConfirmed, true);
  assert.equal(plan.registrationDate, '2026-07-21');
  assert.equal(plan.expirationDate, '2027-07-21');
  assert.equal(plan.autoRenewEnabled, true);
  assert.equal(plan.dnsProvider, 'DNSPod');
  assert.deepEqual(plan.authoritativeNameServers, ['blake.dnspod.net', 'herman.dnspod.net']);
  assert.equal(plan.dnsControlConfirmed, true);
  assert.equal(plan.dnsConfigured, false);
  assert.equal(plan.httpsVerified, false);
});

test('首发使用全球不含中国大陆且当前不购买备案云资源', () => {
  const plan = readJson('release/production-domain-selection-v1.json');
  assert.equal(plan.initialAccelerationRegion, 'global_excluding_chinese_mainland');
  assert.equal(plan.icpFilingRequiredForInitialRegion, false);
  assert.equal(plan.icpFilingDeferred, true);
  assert.equal(plan.mainlandAccelerationEnabled, false);
  assert.equal(plan.mainlandAccelerationFutureRequirement, 'icp_filing_and_eligible_mainland_cloud_resource');
});

test('单项目双域名拓扑保持解决跨项目Blob边界且不需要运行时平台令牌', () => {
  const plan = readJson('release/production-domain-selection-v1.json');
  assert.equal(plan.topology, 'single_edgeone_project_two_custom_domains');
  assert.equal(plan.edgeOneProjectCount, 1);
  assert.equal(plan.administratorSeparateProjectRequired, false);
  assert.equal(plan.singleProjectHostIsolationImplemented, true);
  assert.equal(plan.accountApiTokenRequiredAtRuntime, false);
  assert.equal(plan.realBlobBootstrapAllowed, false);
  assert.equal(plan.productionActivationAllowed, false);
  assert.equal(plan.stablePromotionAuthorized, false);
});
