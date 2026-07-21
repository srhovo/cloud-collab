import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('阶段8E交接报告已由阶段8M推进到双域名已添加并等待CNAME', () => {
  const stdout = execFileSync(process.execPath, ['scripts/build-production-handoff-v1.mjs'], { cwd: root, encoding: 'utf8' }).trim();
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 6);
  assert.equal(report.stage, '8E');
  assert.equal(report.revisedAtStage, '8M');
  assert.equal(report.status, 'handoff_ready_custom_domains_added_waiting_cname');
  assert.equal(report.candidate.version, '8.2.31');
  assert.equal(report.stable.current, '8.2.25');
  assert.equal(report.stable.target, '8.3.0');
  assert.equal(report.stable.promotionAuthorized, false);
  assert.deepEqual(report.artifacts.public, ['index.html', 'build-manifest.json', 'pages-release.json']);
  assert.equal(report.artifacts.administratorInternalDirectory, '__admin');
  assert.deepEqual(report.artifacts.administrator, ['index.html', 'production-console.css', 'production-console.js', 'admin-release.json']);
  assert.equal(report.artifacts.toolsDeployed, false);
  assert.equal(report.offlineGenerator.privateValueCount, 8);
  assert.equal(report.offlineGenerator.randomBytesPerValue, 48);

  assert.equal(report.domain.registrableDomain, 'xiaxue.site');
  assert.equal(report.domain.publicHostname, 'app.xiaxue.site');
  assert.equal(report.domain.administratorHostname, 'admin.xiaxue.site');
  assert.equal(report.domain.publicOrigin, 'https://app.xiaxue.site');
  assert.equal(report.domain.administratorOrigin, 'https://admin.xiaxue.site');
  assert.equal(report.domain.ownershipConfirmed, true);
  assert.equal(report.domain.realNameConfirmed, true);
  assert.equal(report.domain.autoRenewEnabled, true);
  assert.equal(report.domain.dnsProvider, 'DNSPod');
  assert.equal(report.domain.dnsControlConfirmed, true);
  assert.equal(report.domain.customDomainsAddedToSameProject, true);
  for (const hostname of ['app.xiaxue.site', 'admin.xiaxue.site']) {
    assert.equal(report.domain.customDomainProvisioning[hostname].status, 'deploying');
    assert.equal(report.domain.customDomainProvisioning[hostname].cnameVisible, false);
    assert.equal(report.domain.customDomainProvisioning[hostname].httpsConfigured, false);
  }
  assert.equal(report.domain.dnsConfigured, false);
  assert.equal(report.domain.httpsVerified, false);

  assert.equal(report.deployment.initialAccelerationRegion, 'global_excluding_chinese_mainland');
  assert.equal(report.deployment.accelerationRegionVerified, false);
  assert.equal(report.deployment.icpFilingRequiredForInitialRegion, false);
  assert.equal(report.deployment.icpFilingDeferred, true);
  assert.equal(report.deployment.mainlandAccelerationEnabled, false);
  assert.equal(report.deployment.eligibleMainlandCloudResourcePurchased, false);
  assert.equal(report.deployment.cloudServerPurchaseRequiredNow, false);
  assert.equal(report.deployment.futureMainlandAccelerationRequiresIcpFiling, true);

  assert.equal(report.architecture.topology, 'single_edgeone_project_two_custom_domains');
  assert.equal(report.architecture.edgeOneProjectCount, 1);
  assert.equal(report.architecture.singleProjectHostIsolationImplemented, true);
  assert.equal(report.architecture.currentProjectScopedBlobResolved, true);
  assert.equal(report.architecture.accountApiTokenInLongRunningRuntimeAllowed, false);
  assert.equal(report.architecture.administratorSeparateProjectRequired, false);
  assert.equal(report.architecture.administratorSeparateProjectCreationForbidden, true);
  assert.equal(report.architecture.realBootstrapBlockedByArchitecture, false);
  assert.equal(report.architecture.realBootstrapAuthorized, false);
  assert.equal(report.bootstrap.recommendedWorkflow, 'stage8h-edgeone-production-bootstrap');
  assert.equal(report.bootstrap.domainRequired, false);
  assert.equal(report.bootstrap.automaticTrigger, false);
  assert.equal(report.bootstrap.operationDefault, 'plan');
  assert.equal(report.bootstrap.blockedByArchitectureReview, false);
  assert.equal(report.bootstrap.authorized, false);
  assert.equal(report.bootstrap.executed, false);
  assert.equal(report.manualActions.length, 7);
  assert.equal(report.manualActions[0].completed, true);
  assert.equal(report.manualActions[1].completed, true);
  assert.equal(report.manualActions[2].requiredNow, true);
  assert.equal(report.manualActions.slice(3).every(item => item.requiredNow === false), true);
  assert.deepEqual(report.optionalPreDomainActions, []);
  assert.equal(report.activationBlockers.includes('domain_status_unconfirmed'), false);
  assert.equal(report.activationBlockers.includes('custom_domain_provisioning_incomplete'), true);
  assert.equal(report.activationBlockers.includes('cname_values_unavailable'), true);
  assert.equal(report.activationBlockers.includes('edgeone_acceleration_region_unverified'), true);
  assert.equal(report.boundaries.deploymentPerformed, false);
  assert.equal(report.boundaries.realBlobOperationsPerformed, 0);
  assert.equal(report.boundaries.productionActivationPerformed, false);
  assert.equal(report.boundaries.stablePromotionAuthorized, false);
});

test('离线工具强随机且没有网络、持久化、Cookie或剪贴板能力', () => {
  const html = read('tools/production-secret-generator.html');
  const js = read('tools/production-secret-generator.js');
  const combined = `${html}\n${js}\n${read('tools/production-secret-generator.css')}`;
  assert.match(html, /connect-src 'none'/u);
  assert.equal((html.match(/data-private-name=/gu) || []).length, 8);
  assert.match(js, /crypto\.getRandomValues/u);
  assert.match(js, /new Uint8Array\(48\)/u);
  assert.match(js, /pagehide/u);
  assert.doesNotMatch(combined, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon/u);
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard/u);
});

test('交接输出明确双域名已添加但CNAME尚未显示且当前不购买备案云资源', () => {
  const files = [
    read('dist/production-handoff-v1.json'),
    read('dist/production-owner-actions-v1.md'),
    read('dist/production-edgeone-env-template-v1.txt'),
  ].join('\n');
  assert.doesNotMatch(files, /eo_token=/iu);
  assert.doesNotMatch(files, /CLOUD_PRODUCTION_ENABLED=1/u);
  assert.doesNotMatch(files, /CLOUD_PRODUCTION_BOOTSTRAP_ENABLED=1/u);
  assert.doesNotMatch(files, /"stablePromotionAuthorized"\s*:\s*true/u);
  assert.match(files, /stage8h-edgeone-production-bootstrap/u);
  assert.doesNotMatch(files, /stage8g-edgeone-production-bootstrap/u);
  assert.match(files, /xiaxue\.site/u);
  assert.match(files, /同一个EdgeOne项目/u);
  assert.match(files, /不创建独立管理员项目/u);
  assert.match(files, /账户级访问令牌/u);
  assert.match(files, /全球可用区（不含中国大陆）/u);
  assert.match(files, /当前不需要购买云服务器/u);
  assert.match(files, /CNAME尚未显示/u);
});
