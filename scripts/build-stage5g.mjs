import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(`${new URL('./build.mjs', import.meta.url).href}?stage5g=${Date.now()}`);

const outputPath = path.join(root, 'dist', 'index.html');
const manifestPath = path.join(root, 'dist', 'build-manifest.json');
const ordinaryClientSource = fs.readFileSync(path.join(root, 'src', 'cloud_collab_ordinary_types_client.js'), 'utf8').trim();
const ordinaryFeatureMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_ordinary_feature_methods.fragment.js'), 'utf8').trim();
const submissionFeatureMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_submission_feature_methods.fragment.js'), 'utf8').trim();
let html = fs.readFileSync(outputPath, 'utf8');

function replaceOnce(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first < 0) throw new Error(`找不到阶段5G构建锚点：${label}`);
  if (text.indexOf(search, first + search.length) >= 0) throw new Error(`阶段5G构建锚点不唯一：${label}`);
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

html = replaceOnce(
  html,
  '// ===== 公共协作数据库：隔离候选提交客户端结束 =====\n\n\nclass CloudCollabFeature {',
  `// ===== 公共协作数据库：隔离候选提交客户端结束 =====\n\n// ===== 公共协作数据库：普通名字与老板候选/同步客户端（阶段5G） =====\n${ordinaryClientSource}\n// ===== 公共协作数据库：阶段5G普通共享客户端结束 =====\n\n\nclass CloudCollabFeature {`,
  'ordinary client insertion',
);

html = replaceOnce(
  html,
  `${submissionFeatureMethods}\n\n getModeLabel(mode) {`,
  `${submissionFeatureMethods}\n\n${ordinaryFeatureMethods}\n\n getModeLabel(mode) {`,
  'ordinary feature methods',
);

html = replaceOnce(
  html,
  'new CloudCollabSubmission.SubmissionDispatcher({',
  'new CloudCollabOrdinaryTypes.OrdinarySubmissionDispatcher({',
  'combined submission dispatcher',
);

html = replaceOnce(
  html,
  "if (mode === 'collaborate' && previousBinding?.mode !== 'collaborate') await this.enqueueInitialBindingSubmissions(localLibraryId);",
  `if (mode === 'collaborate' && previousBinding?.mode !== 'collaborate') {\n     await this.enqueueInitialBindingSubmissions(localLibraryId);\n     await this.enqueueInitialOrdinarySubmissions(localLibraryId);\n    }`,
  'initial ordinary enqueue',
);

html = replaceOnce(
  html,
  ` const correctedNames = this.getCorrectedNames();\n this.service.enhancedExtractor.saveData();\n this.close(correctedNames);`,
  ` const correctedNames = this.getCorrectedNames();\n this.service.enhancedExtractor.saveData();\n setTimeout(() => {\n  const feature = globalThis.orderCalculator?.cloudCollabFeature;\n  if (!feature?.enqueuePlayableNameUserChange) return;\n  correctedNames.forEach(name => feature.enqueuePlayableNameUserChange(name).catch(error => appLogSilent(error)));\n }, 0);\n this.close(correctedNames);`,
  'interactive confirmed playable enqueue',
);

html = replaceOnce(
  html,
  ` this.showSuccess(updated ? \`"\${name}" 老板信息已更新\` : \`"\${name}" 已添加到老板记忆库\`);\n this.save();\n this.resetEditor({ clear: true });`,
  ` this.showSuccess(updated ? \`"\${name}" 老板信息已更新\` : \`"\${name}" 已添加到老板记忆库\`);\n this.save();\n setTimeout(() => {\n  this.app.cloudCollabFeature?.enqueueBossProfileUserChange?.({ name, paiDan, discount }).catch(error => appLogSilent(error));\n }, 0);\n this.resetEditor({ clear: true });`,
  'interactive boss editor enqueue',
);

html = replaceOnce(
  html,
  ` const result = this.bossMemoryFeature.upsertRecord(boss);\n this.bossMemory = result.memory;\n this.updateRecentBossUI();`,
  ` const result = this.bossMemoryFeature.upsertRecord(boss);\n this.bossMemory = result.memory;\n setTimeout(() => {\n  this.app.cloudCollabFeature?.enqueueBossProfileUserChange?.(boss).catch(error => appLogSilent(error));\n }, 0);\n this.updateRecentBossUI();`,
  'explicit recent boss save enqueue',
);

html = replaceOnce(
  html,
  '只接收公共普通精确价格；参与协作模式可把白名单价格逐条送入隔离候选区，不能直接修改正式公共库。',
  '当前接收同步仍保持普通精确价格；参与协作模式可把普通精确价格、明确确认的陪玩名字和明确保存的老板资料逐条送入隔离候选区，不能直接修改正式公共库。',
  'stage5g collaboration banner',
);

html = replaceOnce(
  html,
  '仅“参与协作”绑定会逐条生成普通精确价格候选；只接收模式、导入、迁移、云端拉取、回滚、系统记忆和私人数据永远不会进入上传队列。',
  '仅“参与协作”绑定会逐条生成普通精确价格、已确认陪玩名字和明确保存老板资料候选；只接收模式、导入、迁移、云端拉取、回滚、系统记忆和私人数据永远不会进入上传队列。',
  'stage5g queue note',
);

fs.writeFileSync(outputPath, html, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.stage = '5G-ordinary-shared-client';
manifest.ordinaryTypesClientEnabled = true;
manifest.ordinaryTypes = ['playable_name', 'boss_profile'];
manifest.stage6SensitiveChangesEnabled = false;
manifest.sha256 = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
manifest.bytes = Buffer.byteLength(html);
manifest.generatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
