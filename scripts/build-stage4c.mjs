import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const outputPath = path.join(distDir, 'index.html');
const namedOutputPath = path.join(distDir, '码单器8.2.28_云端协作候选版.html');

function replaceOnce(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first < 0) throw new Error(`找不到阶段4C构建锚点：${label}`);
  if (text.indexOf(search, first + search.length) >= 0) throw new Error(`阶段4C构建锚点不唯一：${label}`);
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').trim();
let html = fs.readFileSync(outputPath, 'utf8');
const writeClient = read('src/cloud_collab_write_client.js');
const submissionBuilder = read('src/cloud_collab_submission_builder.js');
const queueDispatcher = read('src/cloud_collab_queue_dispatcher.js');
const writeFeatureMethods = read('src/cloud_collab_write_feature_methods.fragment.js');

html = replaceOnce(html,
  '<title>码单器8.2.27（公共协作只接收同步候选）</title>',
  '<title>码单器8.2.28（云端协作上传基础候选）</title>',
  'title');
html = replaceOnce(html,
  '/* ===== 公共协作数据库（8.2.27 只接收同步候选；三方合并与失败回滚） ===== */',
  '/* ===== 公共协作数据库（8.2.28 云端协作候选；上传门禁默认关闭） ===== */',
  'cloud CSS comment');
html = replaceOnce(html,
  '<meta name="cloud-collab-api-base" content="">',
  '<meta name="cloud-collab-api-base" content="">\n    <meta name="cloud-collab-write-enabled" content="0">',
  'fail-closed write meta');
html = replaceOnce(html,
  '<!-- 码单器 8.2.27 公共协作数据库只接收同步候选版：公共快照三方合并，服务器失败不影响正常码单 -->',
  '<!-- 码单器 8.2.28 云端协作候选版：设备注册与待上传队列派发基础已实现；上传门禁默认关闭，云端失败不影响正常码单 -->',
  'body release comment');
html = replaceOnce(html, "const APP_VERSION = '8.2.27';", "const APP_VERSION = '8.2.28';", 'APP_VERSION');
html = replaceOnce(html,
  '// Release note: 8.2.27 完成只接收公共普通精确价格：版本检查、增量/快照拉取、三方比较、冲突隔离、事务回滚与五分钟轮询；不开放提交、审核或管理员写入。',
  '// Release note: 8.2.28 新增设备注册、本地专用凭据、普通精确价格首绑候选、pendingCloudChanges派发、幂等重试、错误分类和断网降级；上传门禁默认关闭，不开放正式写入、自动批准或管理员审核。',
  'release note');
html = replaceOnce(html,
  '<div><strong>只接收同步候选</strong><span>页面启动不等待服务器；绑定为“只接收”或“参与协作”时异步合并公共普通精确价格。</span></div>',
  '<div><strong>云端协作候选</strong><span>只读同步继续运行；参与协作模式可生成普通精确价格待上传队列，但本候选上传门禁默认关闭。</span></div>',
  'cloud banner');

html = replaceOnce(html,
` <p class="cloud-collab-note">只发送无凭据GET请求及公共groupId/libraryId；不会上传设备身份、令牌、价格、老板、历史或其他本地内容。</p>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudServerCheckBtn" type="button">检查服务器</button>
 </div>
 </section>

 <section class="cloud-collab-section" aria-labelledby="cloudIdentityTitle">`,
` <p class="cloud-collab-note">只发送无凭据GET请求及公共groupId/libraryId；不会上传设备身份、令牌、价格、老板、历史或其他本地内容。</p>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudServerCheckBtn" type="button">检查服务器</button>
 </div>
 </section>

 <section class="cloud-collab-section" aria-labelledby="cloudWriteTitle">
 <h4 id="cloudWriteTitle">设备注册与待上传队列</h4>
 <div class="cloud-collab-status" id="cloudWriteSummary">上传门禁关闭；待上传记录只保存在本机。</div>
 <p class="cloud-collab-note">明文设备令牌只保存在 cloudDeviceCredential 专用本地凭据区。只接收模式永不上传；仅参与协作模式的普通精确价格可进入 pendingCloudChanges。历史、订单、备注、自定义比例、聊天、布局和使用记录永不上传。</p>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudDeviceRegisterBtn" type="button">注册此设备</button>
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudQueueDispatchBtn" type="button">派发待上传队列</button>
 </div>
 </section>

 <section class="cloud-collab-section" aria-labelledby="cloudIdentityTitle">`,
  'write status section');

html = replaceOnce(html,
`// ===== 公共协作数据库：公共快照合并结束 =====


class CloudCollabFeature {`,
`// ===== 公共协作数据库：公共快照合并结束 =====

// ===== 公共协作数据库：设备注册与提交客户端（阶段4C；门禁默认关闭） =====
${writeClient}
// ===== 公共协作数据库：设备注册与提交客户端结束 =====

// ===== 公共协作数据库：普通精确价格候选投影（阶段4C） =====
${submissionBuilder}
// ===== 公共协作数据库：候选投影结束 =====

// ===== 公共协作数据库：pendingCloudChanges派发器（阶段4C） =====
${queueDispatcher}
// ===== 公共协作数据库：队列派发器结束 =====


class CloudCollabFeature {`,
  'write module insertion');

html = replaceOnce(html,
` constructor(app, stores, apiClient) {
   this.app = app;
   this.stores = stores;
   this.apiClient = apiClient;
   this._eventScope = new FeatureEventScope();
   this.selectedLocalLibraryId = '';
   this.lastError = null;
   this.lastServerError = null;
   this.lastPublicVersion = null;
   this._readonlyCheckScheduled = false;
   this._receivePollTimer = null;
   this._syncLocks = new Set();
  }`,
` constructor(app, stores, apiClient, writeClient, dispatcher) {
   this.app = app;
   this.stores = stores;
   this.apiClient = apiClient;
   this.writeClient = writeClient;
   this.dispatcher = dispatcher;
   this._eventScope = new FeatureEventScope();
   this.selectedLocalLibraryId = '';
   this.lastError = null;
   this.lastServerError = null;
   this.lastPublicVersion = null;
   this._readonlyCheckScheduled = false;
   this._receivePollTimer = null;
   this._syncLocks = new Set();
   this._submissionIdFactory = null;
  }`,
  'CloudCollabFeature write constructor');

html = replaceOnce(html,
`   this._eventScope.on(el.cloudCollabBtn, 'click', () => this.open());
    this._eventScope.on(el.cloudServerCheckBtn, 'click', () => this.checkServer({ interactive: true }));
    this._eventScope.on(el.cloudPublicVersionCheckBtn, 'click', () => this.checkSelectedPublicVersion());
    this._eventScope.on(el.cloudIdentitySaveBtn, 'click', () => this.saveIdentity());`,
`   this._eventScope.on(el.cloudCollabBtn, 'click', () => this.open());
    this._eventScope.on(el.cloudServerCheckBtn, 'click', () => this.checkServer({ interactive: true }));
    this._eventScope.on(el.cloudPublicVersionCheckBtn, 'click', () => this.checkSelectedPublicVersion());
    this._eventScope.on(el.cloudDeviceRegisterBtn, 'click', () => this.registerCloudDevice());
    this._eventScope.on(el.cloudQueueDispatchBtn, 'click', () => this.dispatchCloudQueue({ interactive: true, reason: 'manual' }));
    this._eventScope.on(el.cloudIdentitySaveBtn, 'click', () => this.saveIdentity());`,
  'write event bindings');

html = replaceOnce(html,
`  this.renderServerStatus();
   this.renderPublicVersionSummary();
   if (this.lastError) this.setStatus(this.formatError(this.lastError), 'error');`,
`  this.renderServerStatus();
   this.renderPublicVersionSummary();
   this.renderWriteStatus();
   if (this.lastError) this.setStatus(this.formatError(this.lastError), 'error');`,
  'render write status');

html = replaceOnce(html,
` ${read('src/cloud_collab_readonly_feature_methods.fragment.js')}

  getModeLabel(mode) {`,
` ${read('src/cloud_collab_readonly_feature_methods.fragment.js')}

${writeFeatureMethods}

  getModeLabel(mode) {`,
  'write feature methods');

html = replaceOnce(html,
`   this.setStatus(\`本地绑定已保存：${'${'}this.getModeLabel(mode)}。${'${'}mode === 'local' ? '不会接收公共更新。' : '将异步检查公共更新。'}\`, 'success');
   if (mode !== 'local') setTimeout(() => this.syncBinding(this.stores.bindingStore.getByLocalLibraryId(localLibraryId), { interactive: false, force: false, reason: 'binding' }), 0);`,
`   this.setStatus(\`本地绑定已保存：${'${'}this.getModeLabel(mode)}。${'${'}mode === 'local' ? '不会接收或上传。' : '将异步检查公共更新。'}\`, 'success');
   if (mode !== 'local') setTimeout(async () => {
    const binding = this.stores.bindingStore.getByLocalLibraryId(localLibraryId);
    const syncResult = await this.syncBinding(binding, { interactive: false, force: false, reason: 'binding' });
    if (mode === 'collaborate') await this.handleCollaborativeBindingReady(binding, syncResult);
   }, 0);`,
  'collaborative binding queue trigger');

html = replaceOnce(html,
` this.priceLibraryStore = new PriceLibraryStore(storage, this.priceMemoryStore);
  this.cloudCollabStores = CloudCollabLocalStores.createCloudCollabStores(storage);
  this.cloudCollabApi = CloudCollabReadonly.createConfiguredClient({ documentRef: document, locationRef: window.location, timeoutMs: 3500 });
  this.extractorService = new ExtractorService();`,
` this.priceLibraryStore = new PriceLibraryStore(storage, this.priceMemoryStore);
  this.cloudCollabStores = CloudCollabLocalStores.createCloudCollabStores(storage);
  this.cloudCollabApi = CloudCollabReadonly.createConfiguredClient({ documentRef: document, locationRef: window.location, timeoutMs: 3500 });
  this.cloudCollabWriteApi = CloudCollabWriteClient.createConfiguredClient({ documentRef: document, locationRef: window.location, timeoutMs: 5000 });
  this.cloudCollabDispatcher = CloudCollabQueueDispatcher.createDispatcher({
   client: this.cloudCollabWriteApi,
   metaStore: this.cloudCollabStores.metaStore,
   credentialStore: this.cloudCollabStores.credentialStore,
   bindingStore: this.cloudCollabStores.bindingStore,
   queueStore: this.cloudCollabStores.queueStore,
   navigatorRef: navigator,
   documentRef: document,
   windowRef: window,
   onState: state => {
    this.cloudCollabState = { ...(this.cloudCollabState || {}), writeState: state };
    this.cloudCollabFeature?.renderWriteStatus?.();
   }
  });
  this.extractorService = new ExtractorService();`,
  'create write client and dispatcher');

html = replaceOnce(html,
  "this.registerFeature('cloudCollabFeature', new CloudCollabFeature(this, this.cloudCollabStores, this.cloudCollabApi));",
  "this.registerFeature('cloudCollabFeature', new CloudCollabFeature(this, this.cloudCollabStores, this.cloudCollabApi, this.cloudCollabWriteApi, this.cloudCollabDispatcher));",
  'register write client and dispatcher');
html = replaceOnce(html,
` cloudCollabState: { available: true, identityReady: false, bindingCount: 0, queuedCount: 0, conflictCount: 0, errorCode: null, serverStatus: 'idle', serverProtocolVersion: null, serverCheckedAt: null, serverErrorCode: null },`,
` cloudCollabState: { available: true, identityReady: false, bindingCount: 0, queuedCount: 0, conflictCount: 0, errorCode: null, serverStatus: 'idle', serverProtocolVersion: null, serverCheckedAt: null, serverErrorCode: null, writeState: { status: 'disabled', errorCode: 'WRITE_CLIENT_DISABLED' } },`,
  'initial write state');
html = replaceOnce(html,
` try { this.cloudCollabFeature.loadLocalState(); } catch (error) { appLogError('cloudCollabLocalInit', error); }
  try { this.cloudCollabFeature.scheduleReadonlyCheck(); } catch (error) { appLogError('cloudCollabReadonlySchedule', error); }
  this.initClearButtons();`,
` try { this.cloudCollabFeature.loadLocalState(); } catch (error) { appLogError('cloudCollabLocalInit', error); }
  try { this.cloudCollabFeature.scheduleReadonlyCheck(); } catch (error) { appLogError('cloudCollabReadonlySchedule', error); }
  try { this.cloudCollabFeature.scheduleWriteDispatcher(); } catch (error) { appLogError('cloudCollabWriteSchedule', { code: error?.code || 'WRITE_SCHEDULE_FAILED' }); }
  this.initClearButtons();`,
  'schedule upload dispatcher');
html = replaceOnce(html,
` 'cloudCollabBtn', 'cloudCollabModal', 'cloudServerBadge', 'cloudServerSummary', 'cloudServerCheckBtn', 'cloudNicknameInput', 'cloudIdentitySummary', 'cloudIdentitySaveBtn', 'cloudLocalLibrarySelect', 'cloudGroupIdInput', 'cloudLibraryIdInput', 'cloudBindingModeSelect', 'cloudBindingSummary', 'cloudBindingSaveBtn', 'cloudPublicVersionCheckBtn', 'cloudPublicVersionSummary', 'cloudBindingRemoveBtn', 'cloudBindingCount', 'cloudQueueCount', 'cloudConflictCount', 'cloudRefreshBtn', 'cloudOperationStatus',`,
` 'cloudCollabBtn', 'cloudCollabModal', 'cloudServerBadge', 'cloudServerSummary', 'cloudServerCheckBtn', 'cloudWriteSummary', 'cloudDeviceRegisterBtn', 'cloudQueueDispatchBtn', 'cloudNicknameInput', 'cloudIdentitySummary', 'cloudIdentitySaveBtn', 'cloudLocalLibrarySelect', 'cloudGroupIdInput', 'cloudLibraryIdInput', 'cloudBindingModeSelect', 'cloudBindingSummary', 'cloudBindingSaveBtn', 'cloudPublicVersionCheckBtn', 'cloudPublicVersionSummary', 'cloudBindingRemoveBtn', 'cloudBindingCount', 'cloudQueueCount', 'cloudConflictCount', 'cloudRefreshBtn', 'cloudOperationStatus',`,
  'cache write elements');

fs.writeFileSync(outputPath, html, 'utf8');
fs.writeFileSync(namedOutputPath, html, 'utf8');
const digest = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
const manifest = {
  version: '8.2.28',
  source: 'dist/index.html (8.2.27 base build + Stage4C injection)',
  output: path.relative(root, outputPath),
  namedOutput: path.relative(root, namedOutputPath),
  apiBase: process.env.CLOUD_COLLAB_API_BASE || 'same-origin-or-disabled-for-file',
  writeEnabled: false,
  stage: '4C-client-upload-foundation-fail-closed',
  sha256: digest,
  bytes: Buffer.byteLength(html),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(distDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
