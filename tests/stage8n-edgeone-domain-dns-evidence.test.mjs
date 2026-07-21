import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'release/edgeone-domain-dns-evidence-stage8n.json'), 'utf8'));

test('阶段8N确认一个EdgeOne项目、全球不含中国大陆区域和免备案首发边界', () => {
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.stage, '8N');
  assert.equal(evidence.project.name, 'cloud-collab');
  assert.equal(evidence.project.status, 'running');
  assert.equal(evidence.project.productionBranch, 'main');
  assert.equal(evidence.project.accelerationRegion, 'global_excluding_chinese_mainland');
  assert.equal(evidence.project.accelerationRegionVerified, true);
  assert.equal(evidence.project.icpFilingRequiredForCurrentRegion, false);
  assert.equal(evidence.project.cloudServerRequiredNow, false);
  assert.equal(evidence.topology.edgeOneProjectCount, 1);
  assert.equal(evidence.topology.singleProjectTwoCustomDomains, true);
  assert.equal(evidence.topology.administratorSeparateProjectRequired, false);
});

test('阶段8N只接受xiaxue.site根区域中的两个冻结CNAME目标', () => {
  assert.equal(evidence.authoritativeDns.provider, 'DNSPod');
  assert.equal(evidence.authoritativeDns.zone, 'xiaxue.site');
  assert.equal(evidence.authoritativeDns.rootZoneRecordsEntered, true);
  assert.equal(evidence.authoritativeDns.rootZoneRecordsEnabled, true);
  assert.equal(evidence.authoritativeDns.ownershipTxtRecordsEntered, true);
  assert.equal(evidence.domains['app.xiaxue.site'].rootZoneHost, 'app');
  assert.equal(evidence.domains['app.xiaxue.site'].cnameTarget, 'app.xiaxue.site.pages.dnsoe6.com.');
  assert.equal(evidence.domains['admin.xiaxue.site'].rootZoneHost, 'admin');
  assert.equal(evidence.domains['admin.xiaxue.site'].cnameTarget, 'admin.xiaxue.site.pages.dnsoe4.com.');
});

test('阶段8N独立子域解析区不参与生产且公网与HTTPS仍待验证', () => {
  assert.deepEqual(evidence.authoritativeDns.standaloneChildZonesObserved, ['app.xiaxue.site', 'admin.xiaxue.site']);
  assert.equal(evidence.authoritativeDns.standaloneChildZonesDelegatedByNs, false);
  assert.equal(evidence.authoritativeDns.standaloneChildZoneWarningsExpected, true);
  assert.equal(evidence.authoritativeDns.standaloneChildZonesUsedForProduction, false);
  assert.equal(evidence.authoritativeDns.publicPropagationVerified, false);
  assert.equal(evidence.domains['app.xiaxue.site'].propagationVerified, false);
  assert.equal(evidence.domains['admin.xiaxue.site'].propagationVerified, false);
  assert.equal(evidence.domains['app.xiaxue.site'].httpsConfigured, false);
  assert.equal(evidence.domains['admin.xiaxue.site'].httpsConfigured, false);
  assert.equal(evidence.realBlobBootstrapAllowed, false);
  assert.equal(evidence.productionActivationAllowed, false);
  assert.equal(evidence.stablePromotionAuthorized, false);
});
