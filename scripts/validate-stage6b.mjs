import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(root, relative));
const html = read('dist/index.html');
const manifest = JSON.parse(read('dist/build-manifest.json'));
const build = read('scripts/build-stage6b.mjs');
const policy = read('src/server/sensitive_rules_policy_v1.js');
const acceptance = read('src/server/sensitive_submission_acceptance_v1.js');
const publicEngine = read('src/server/sensitive_public_engine_v1.js');
const adminReview = read('src/server/admin_sensitive_review_v1.js');
const client = read('src/cloud_collab_sensitive_rules_client.js');
const merge = read('src/cloud_collab_sensitive_merge_client.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`Stage6B验证失败：${message}`);
  passed += 1;
}

assert(['6B-sensitive-review-publish', '7G-release-candidate'].includes(manifest.stage), '构建清单必须保留阶段6B能力或进入阶段7G候选封装');
assert(manifest.compatibleShellRetained === true, '必须保留已验证兼容候选壳能力');
assert(manifest.sensitiveCandidateClientEnabled === true, '敏感候选客户端必须启用');
assert(manifest.sensitiveAdminReviewEnabled === true, '敏感管理员审核必须启用');
assert(manifest.sensitivePublicEventsEnabled === true, '敏感公共事件必须启用');
assert(manifest.sensitiveTombstonesEnabled === true, '删除墓碑必须启用');
assert(manifest.sensitiveReceiveMergeEnabled === true, '敏感三方合并必须启用');
assert(manifest.sensitiveBossRoutingEnabled === true, '老板敏感变化路由必须启用');
assert(manifest.formalPublicWritesEnabled === false, '正式公共写入必须保持关闭');
assert(Array.isArray(manifest.sensitiveExplicitDeleteTypes) && manifest.sensitiveExplicitDeleteTypes.length === 6, '显式删除类型必须完整冻结');
assert(/码单器8\.2\.30（公共协作完整候选版）/.test(html), '页面必须使用项目负责人确认的8.2.30完整候选壳');
assert(!html.includes('码单器8.2.31（敏感候选人工审核协作版）'), '阶段号不得暴露为内部阶段标题');
assert(!html.includes('码单器8.2.28（公共协作候选派发客户端）'), '发布候选不得残留8.2.28标题');
assert(html.includes('CloudCollabSensitiveRules'), '页面必须内嵌敏感提交客户端');
assert(html.includes('CloudCollabSensitiveMerge'), '页面必须内嵌敏感合并客户端');
assert(html.includes('enqueueSensitiveRuleUserChange'), '页面必须包含敏感规则显式入队');
assert(html.includes('enqueueSensitiveDeleteUserChange'), '页面必须包含显式删除入队');
assert(html.includes('enqueueSensitiveBossUserChange'), '页面必须包含老板敏感变化入队');
assert(html.includes("'rank_range_rule', finalRule"), '区间规则保存必须显式入队');
assert(html.includes("'surcharge_rule', finalRule"), '加价规则保存必须显式入队');
assert(html.includes("'gift_rule', savedGift"), '礼物规则保存必须显式入队');
assert(html.includes("'exact_price', removedRecord"), '普通单价删除必须显式入队');
assert(html.includes("'playable_name', { name }"), '陪玩名字删除必须显式入队');
assert(html.includes("'boss_profile', deletedBossForCloud"), '老板删除必须显式入队');
assert(html.includes('isStage6BSensitiveBossChange'), '老板保存必须区分普通与敏感变化');
assert(!html.includes('码单器8.2.25.html'), '稳定版8.2.25不得进入构建输入');
assert(client.includes("'/api/preview/sensitive-submissions/create'"), '敏感客户端必须使用独立预览提交路由');
assert(client.includes("new Set(['rank_range_rule', 'surcharge_rule', 'gift_rule'])"), '敏感客户端规则白名单必须冻结');
assert(client.includes("new Set(['exact_price', 'playable_name', 'boss_profile', 'rank_range_rule', 'surcharge_rule', 'gift_rule'])"), '敏感客户端删除白名单必须冻结');
assert(policy.includes("decision: 'pending_review'"), '敏感协议必须固定人工审核');
assert(policy.includes('trustedDeviceBypassAllowed: false'), '可信设备不得绕过敏感审核');
assert(policy.includes('twoDeviceBypassAllowed: false'), '两设备一致不得绕过敏感审核');
assert(acceptance.includes("candidateKind: 'sensitive_review'"), '敏感候选必须使用独立不可变类型');
assert(acceptance.includes('publicMutationAllowed: false'), '候选接收不得直接修改公共库');
assert(acceptance.includes('autoApprovalEnabled: false'), '候选接收不得自动批准');
assert(publicEngine.includes("operation: 'delete'"), '公共引擎必须支持墓碑事件');
assert(publicEngine.includes('tombstones'), '公共快照必须投影墓碑');
assert(adminReview.includes("const ACTIONS = new Set(['approve', 'reject', 'edit_and_approve'])"), '管理员动作必须严格冻结');
assert(adminReview.includes('ADMIN_SENSITIVE_REVIEW_STALE_BASELINE'), '管理员批准必须阻断陈旧基线');
assert(adminReview.includes('automaticApproval: false'), '管理员能力必须声明无自动批准');
assert(merge.includes("const DELETE_TYPES = new Set(['playable_name', 'boss_profile', 'rank_range_rule', 'surcharge_rule', 'gift_rule'])"), '本地敏感墓碑合并白名单必须冻结');
assert(build.includes('globalThis.CloudCollabSensitiveRules?.isPreviewSensitiveSubmissionScope'), '普通派发器不得误阻断敏感队列项');
assert(build.includes('await this.commitStage5GMixedPlan'), '敏感合并提交必须等待原子持久化完成');

for (const route of [
  'cloud-functions/api/preview/sensitive-submissions/create.js',
  'cloud-functions/api/preview/sensitive-public-version.js',
  'cloud-functions/api/preview/sensitive-public-snapshot.js',
  'cloud-functions/api/preview/sensitive-public-changes.js',
  'cloud-functions/api/admin/sensitive-reviews.js',
  'cloud-functions/api/admin/sensitive-reviews/detail.js',
  'cloud-functions/api/admin/sensitive-reviews/approve.js',
  'cloud-functions/api/admin/sensitive-reviews/reject.js',
  'cloud-functions/api/admin/sensitive-reviews/edit-and-approve.js',
]) assert(exists(route), `缺少阶段6B路由：${route}`);

console.log(`Stage6B验证通过：${passed}/${passed}`);
