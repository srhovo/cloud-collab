import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'release/edgeone-owner-browser-access-stage8p.json'), 'utf8'));
const fail = message => { throw new Error(`阶段8P证据失败：${message}`); };

if (evidence.schemaVersion !== 1 || evidence.stage !== '8P') fail('证据版本无效');
if (evidence.project?.name !== 'cloud-collab'
    || evidence.project?.edgeOneProjectCount !== 1
    || evidence.project?.accelerationRegion !== 'global_excluding_chinese_mainland') fail('项目边界无效');

for (const [origin, surface] of [
  ['https://app.xiaxue.site', 'public_user'],
  ['https://admin.xiaxue.site', 'administrator'],
]) {
  const state = evidence.origins?.[origin];
  if (state?.reachable !== true
      || state?.certificateWarningObserved !== false
      || state?.expectedSurfaceVisible !== true
      || state?.surface !== surface) fail(`${origin}真实浏览器证据无效`);
}

if (evidence.crossHostIsolation?.sourceCodeAndCiVerified !== true
    || evidence.crossHostIsolation?.realOriginPathChecksVerified !== false
    || evidence.crossHostIsolation?.pendingChecks?.length !== 3) fail('跨Host验收边界无效');

if (evidence.environmentVariablesWritten !== false
    || evidence.realPrivateValuesGenerated !== false
    || evidence.realBlobOperationsPerformed !== 0
    || evidence.productionActivationAllowed !== false
    || evidence.productionActivationPerformed !== false
    || evidence.stablePromotionAuthorized !== false
    || evidence.stablePromotionPerformed !== false) fail('生产关闭边界无效');

console.log('阶段8P真实浏览器访问证据与关闭边界通过');
