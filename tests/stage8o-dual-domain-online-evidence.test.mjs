import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const fail = message => { throw new Error(`阶段8O证据失败：${message}`); };

const evidence = readJson('release/edgeone-dual-domain-online-evidence-stage8o.json');

if (evidence.schemaVersion !== 1 || evidence.stage !== '8O') fail('证据版本无效');
if (evidence.project?.name !== 'cloud-collab'
    || evidence.project?.edgeOneProjectCount !== 1
    || evidence.project?.accelerationRegion !== 'global_excluding_chinese_mainland') fail('项目或区域证据无效');

for (const hostname of ['app.xiaxue.site', 'admin.xiaxue.site']) {
  const domain = evidence.domains?.[hostname];
  if (domain?.edgeOneStatus !== 'active'
      || domain?.cnameValidationStatus !== 'active'
      || domain?.httpsConsoleStatus !== 'configured'
      || domain?.associatedEnvironment !== 'production') fail(`${hostname}平台状态无效`);
  if (domain.ownerBrowserContentVerified !== false || domain.assistantExternalProbeVerified !== false) {
    fail(`${hostname}不得把尚未完成的在线内容探测记为通过`);
  }
}

if (evidence.assistantProbe?.attempted !== true
    || evidence.assistantProbe?.result !== 'inconclusive_due_to_sandbox_dns_resolution_unavailable'
    || evidence.assistantProbe?.mustNotOverridePlatformEvidence !== true) fail('外部探测边界无效');

if (evidence.environmentVariablesWritten !== false
    || evidence.realBlobOperationsPerformed !== 0
    || evidence.productionActivationAllowed !== false
    || evidence.productionActivationPerformed !== false
    || evidence.stablePromotionAuthorized !== false
    || evidence.stablePromotionPerformed !== false) fail('生产关闭边界无效');

console.log('阶段8O双域名在线证据与关闭边界通过');
