import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(`${new URL('./build-stage5g.mjs', import.meta.url).href}?stage6b=${Date.now()}`);

const outputPath = path.join(root, 'dist', 'index.html');
const manifestPath = path.join(root, 'dist', 'build-manifest.json');
const sensitiveClient = fs.readFileSync(path.join(root, 'src', 'cloud_collab_sensitive_rules_client.js'), 'utf8').trim();
const sensitiveMergeClient = fs.readFileSync(path.join(root, 'src', 'cloud_collab_sensitive_merge_client.js'), 'utf8').trim();
const ordinaryFeatureMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_ordinary_feature_methods.fragment.js'), 'utf8').trim();
const ordinaryReadonlyMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_ordinary_readonly_methods.fragment.js'), 'utf8').trim();
const sensitiveFeatureMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_sensitive_feature_methods.fragment.js'), 'utf8').trim();
const sensitiveReadonlyMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_sensitive_readonly_methods.fragment.js'), 'utf8').trim();
let html = fs.readFileSync(outputPath, 'utf8');

function replaceOnce(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first < 0) throw new Error(`找不到阶段6B构建锚点：${label}`);
  if (text.indexOf(search, first + search.length) >= 0) throw new Error(`阶段6B构建锚点不唯一：${label}`);
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

html = replaceOnce(
  html,
  '// ===== 公共协作数据库：阶段5G普通共享客户端结束 =====\n\n\nclass CloudCollabFeature {',
  `// ===== 公共协作数据库：阶段5G普通共享客户端结束 =====\n\n// ===== 公共协作数据库：阶段6B敏感规则候选客户端 =====\n${sensitiveClient}\n// ===== 公共协作数据库：阶段6B敏感规则候选客户端结束 =====\n\n// ===== 公共协作数据库：阶段6B敏感规则与墓碑合并客户端 =====\n${sensitiveMergeClient}\n// ===== 公共协作数据库：阶段6B敏感规则与墓碑合并客户端结束 =====\n\n\nclass CloudCollabFeature {`,
  'sensitive browser module insertion',
);

html = replaceOnce(
  html,
  `${ordinaryFeatureMethods}\n\n${ordinaryReadonlyMethods}\n\n getModeLabel(mode) {`,
  `${ordinaryFeatureMethods}\n\n${ordinaryReadonlyMethods}\n\n${sensitiveFeatureMethods}\n\n${sensitiveReadonlyMethods}\n\n getModeLabel(mode) {`,
  'sensitive feature and unified receive methods',
);

html = replaceOnce(
  html,
  "        if (!isPreviewOrdinarySubmissionScope(submission)) {\n          this.queueStore.markBlocked(submission.submissionId, 'PREVIEW_SCOPE_CLIENT_BLOCKED');\n          summary.blocked += 1;\n          summary.errorCode = 'PREVIEW_SCOPE_CLIENT_BLOCKED';\n          summary.category = 'forbidden';\n        } else if (!this.hasCollaborativeBinding(submission)) summary.skippedMode += 1;\n        else due.push(item);",
  "        if (!isPreviewOrdinarySubmissionScope(submission)) {\n          if (globalThis.CloudCollabSensitiveRules?.isPreviewSensitiveSubmissionScope?.(submission)) continue;\n          this.queueStore.markBlocked(submission.submissionId, 'PREVIEW_SCOPE_CLIENT_BLOCKED');\n          summary.blocked += 1;\n          summary.errorCode = 'PREVIEW_SCOPE_CLIENT_BLOCKED';\n          summary.category = 'forbidden';\n        } else if (!this.hasCollaborativeBinding(submission)) summary.skippedMode += 1;\n        else due.push(item);",
  'ordinary dispatcher leaves sensitive queue items for sensitive dispatcher',
);

html = replaceOnce(
  html,
  'const result = this.commitStage5GMixedPlan(binding, scope, plans);',
  'const result = await this.commitStage5GMixedPlan(binding, scope, plans);',
  'await unified sensitive merge commit',
);

html = replaceOnce(
  html,
  " this.showSuccess(resolution.replaced.length ? `已用新规则替换${resolution.replaced.length}条冲突规则` : (previous ? `已更新区间规则：${finalRule.rangeLabel}` : `已添加区间规则：${finalRule.rangeLabel}`));\n return true;",
  " this.showSuccess(resolution.replaced.length ? `已用新规则替换${resolution.replaced.length}条冲突规则` : (previous ? `已更新区间规则：${finalRule.rangeLabel}` : `已添加区间规则：${finalRule.rangeLabel}`));\n setTimeout(() => this.app.cloudCollabFeature?.enqueueSensitiveRuleUserChange?.('rank_range_rule', finalRule).catch(error => appLogSilent(error)), 0);\n return true;",
  'explicit rank range save enqueue',
);

html = replaceOnce(
  html,
  " this.showSuccess(`已删除区间规则：${rule.rangeLabel}`);\n return true;",
  " this.showSuccess(`已删除区间规则：${rule.rangeLabel}`);\n setTimeout(() => this.app.cloudCollabFeature?.enqueueSensitiveDeleteUserChange?.('rank_range_rule', rule).catch(error => appLogSilent(error)), 0);\n return true;",
  'explicit rank range delete enqueue',
);

html = replaceOnce(
  html,
  " this.app.showSuccess(previous ? `已更新加价规则：${finalRule.name}` : `已添加加价规则：${finalRule.name}`);\n return true;",
  " this.app.showSuccess(previous ? `已更新加价规则：${finalRule.name}` : `已添加加价规则：${finalRule.name}`);\n setTimeout(() => this.app.cloudCollabFeature?.enqueueSensitiveRuleUserChange?.('surcharge_rule', finalRule).catch(error => appLogSilent(error)), 0);\n return true;",
  'explicit surcharge save enqueue',
);

html = replaceOnce(
  html,
  " this.app.showSuccess(`已删除加价规则：${rule.name}`);\n return true;",
  " this.app.showSuccess(`已删除加价规则：${rule.name}`);\n setTimeout(() => this.app.cloudCollabFeature?.enqueueSensitiveDeleteUserChange?.('surcharge_rule', rule).catch(error => appLogSilent(error)), 0);\n return true;",
  'explicit surcharge delete enqueue',
);

html = replaceOnce(
  html,
  " this.app.showSuccess(existing ? `已更新礼物记忆：${serviceType}` : `已添加礼物记忆：${serviceType}`);\n return true;",
  " this.app.showSuccess(existing ? `已更新礼物记忆：${serviceType}` : `已添加礼物记忆：${serviceType}`);\n const savedGift = this.getMemories().find(item => item.serviceKey === PriceRuleEngine.buildServiceKey(serviceType));\n if (savedGift) setTimeout(() => this.app.cloudCollabFeature?.enqueueSensitiveRuleUserChange?.('gift_rule', savedGift).catch(error => appLogSilent(error)), 0);\n return true;",
  'explicit gift save enqueue',
);

html = replaceOnce(
  html,
  " this.app.showSuccess(`已删除礼物记忆：${item.serviceType}`);\n return true;",
  " this.app.showSuccess(`已删除礼物记忆：${item.serviceType}`);\n setTimeout(() => this.app.cloudCollabFeature?.enqueueSensitiveDeleteUserChange?.('gift_rule', item).catch(error => appLogSilent(error)), 0);\n return true;",
  'explicit gift delete enqueue',
);

html = replaceOnce(
  html,
  " deletePriceMemoryItem(key) {\n try {\n const next = this.priceMemoryStore.removeByKey(this.priceMemory, key);",
  " deletePriceMemoryItem(key) {\n try {\n const removedRecord = this.priceMemoryStore.normalize(this.priceMemory).find(item => this.priceMemoryStore.buildKey(item) === key);\n const next = this.priceMemoryStore.removeByKey(this.priceMemory, key);",
  'capture exact price record before explicit delete',
);

html = replaceOnce(
  html,
  " this.refreshServicePriceMatchAfterLibraryChange();\n this.showSuccess('已删除单价记录');\n } catch (error) {\n this.handleError('deletePriceMemory', error, '删除失败，请重试');",
  " this.refreshServicePriceMatchAfterLibraryChange();\n this.showSuccess('已删除单价记录');\n if (removedRecord) setTimeout(() => this.app.cloudCollabFeature?.enqueueSensitiveDeleteUserChange?.('exact_price', removedRecord).catch(error => appLogSilent(error)), 0);\n } catch (error) {\n this.handleError('deletePriceMemory', error, '删除失败，请重试');",
  'explicit exact price delete enqueue',
);

html = html
  .replace('公共更新会三方合并普通精确价格、已确认陪玩名字和老板资料。', '公共更新会三方合并普通价格、陪玩名字、老板资料、区间、加价、礼物规则与人工批准的删除墓碑。')
  .replace('仅“参与协作”绑定会逐条生成普通精确价格、已确认陪玩名字和明确保存老板资料候选；只接收模式、导入、迁移、云端拉取、回滚、系统记忆和私人数据永远不会进入上传队列。', '仅“参与协作”绑定会上传明确用户操作；区间、加价、礼物规则及删除全部进入人工审核。只接收模式、导入、迁移、云端拉取、回滚、系统记忆和私人数据永远不会进入上传队列。');

fs.writeFileSync(outputPath, html, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.stage = '6B-sensitive-review-publish';
manifest.sensitiveCandidateClientEnabled = true;
manifest.sensitiveAdminReviewEnabled = true;
manifest.sensitivePublicEventsEnabled = true;
manifest.sensitiveTombstonesEnabled = true;
manifest.sensitiveReceiveMergeEnabled = true;
manifest.stage6SensitiveChangesEnabled = true;
manifest.formalPublicWritesEnabled = false;
manifest.sha256 = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
manifest.bytes = Buffer.byteLength(html);
manifest.generatedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
