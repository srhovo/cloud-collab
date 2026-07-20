import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProductionBootstrapResources } from '../src/server/production_bootstrap_v1.js';
import {
  PRODUCTION_BOOTSTRAP_CONFIRMATION,
  projectProductionRuntimeStatus,
  readProductionRuntimeConfig,
} from '../src/server/production_runtime_config_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(root, 'config', 'production.env.template');
const outputPath = path.join(root, 'dist', 'production-runtime-default-audit-v1.json');

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const index = line.indexOf('=');
      if (index < 1) throw new Error(`环境变量模板行无效：${line}`);
      return [line.slice(0, index), line.slice(index + 1)];
    }));
}

const template = fs.readFileSync(templatePath, 'utf8');
const env = parseEnv(template);
const disabled = readProductionRuntimeConfig(env);
if (disabled.mode !== 'disabled' || disabled.runtimeEnabled !== false) {
  throw new Error('生产环境模板默认状态必须完全关闭');
}

const bootstrapEnv = {
  ...env,
  CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '1',
  CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: PRODUCTION_BOOTSTRAP_CONFIRMATION,
};
const bootstrapConfig = readProductionRuntimeConfig(bootstrapEnv);
const bootstrapPlan = buildProductionBootstrapResources(bootstrapConfig);

const report = Object.freeze({
  schemaVersion: 1,
  status: 'production_runtime_and_bootstrap_code_ready_not_executed',
  defaultRuntime: projectProductionRuntimeStatus(disabled),
  bootstrap: Object.freeze({
    mode: bootstrapConfig.mode,
    resourceCount: bootstrapPlan.entries.length,
    manifestSha256: bootstrapPlan.manifestSha256,
    externalScope: bootstrapPlan.manifest.externalScope,
    protocolScope: bootstrapPlan.manifest.protocolScope,
    realBlobReadsPerformed: 0,
    realBlobWritesPerformed: 0,
    realBlobDeletesPerformed: 0,
  }),
  realSecretsGenerated: false,
  productionActivationPerformed: false,
  stablePromotionAuthorized: false,
  stablePromotionPerformed: false,
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
