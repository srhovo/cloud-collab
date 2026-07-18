import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src', '码单器8.2.26_公共协作本地候选版.html');
const readonlyClientPath = path.join(root, 'src', 'cloud_collab_readonly_client.js');
const snapshotSyncPath = path.join(root, 'src', 'cloud_collab_snapshot_sync.js');
const submissionClientPath = path.join(root, 'src', 'cloud_collab_submission_client.js');
const distDir = path.join(root, 'dist');
const outputPath = path.join(distDir, 'index.html');

function replaceOnce(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first < 0) throw new Error(`找不到构建锚点：${label}`);
  if (text.indexOf(search, first + search.length) >= 0) throw new Error(`构建锚点不唯一：${label}`);
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let html = fs.readFileSync(sourcePath, 'utf8');
const readonlyClientSource = fs.readFileSync(readonlyClientPath, 'utf8').trim();
const snapshotSyncSource = fs.readFileSync(snapshotSyncPath, 'utf8').trim();
const submissionClientSource = fs.readFileSync(submissionClientPath, 'utf8').trim();
const readonlyFeatureMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_readonly_feature_methods.fragment.js'), 'utf8').trim();
const submissionFeatureMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_submission_feature_methods.fragment.js'), 'utf8').trim();
const configuredApiBase = escapeHtmlAttribute(process.env.CLOUD_COLLAB_API_BASE || '');

html = replaceOnce(html,
  '<title>码单器8.2.26（公共协作本地候选）</title>',
  '<title>码单器8.2.28（公共协作候选派发客户端）</title>',
  'title');
html = replaceOnce(html,
  '/* ===== 公共协作数据库（8.2.26 本地候选；不联网） ===== */',
  '/* ===== 公共协作数据库（8.2.28 接收同步 + 隔离候选派发；正式公共写入关闭） ===== */',
  'cloud CSS comment');
html = replaceOnce(html,
  "<meta name=\"AIGC\" content='",
  `<meta name="cloud-collab-api-base" content="${configuredApiBase}">\n    <meta name="AIGC" content='`,
  'API base meta');
html = replaceOnce(html,
  '<!-- 码单器 8.2.26 公共协作数据库本地候选版：不连接服务器，不影响正常码单 -->',
  '<!-- 码单器 8.2.28 公共协作数据库候选派发客户端：只向隔离预览候选区提交，正式公共写入、自动批准和管理员审核保持关闭 -->',
  'body release comment');
html = replaceOnce(html,
  "const APP_VERSION = '8.2.26';",
  "const APP_VERSION = '8.2.28';",
  'APP_VERSION');
html = replaceOnce(html,
  '// Release note: 8.2.26 新增公共协作数据库本地候选层：独立身份/凭据/绑定/老板映射/待上传队列/同步状态Store，惰性创建身份，支持价格库本地/只接收/参与协作模式；本阶段不包含任何网络请求。',
  '// Release note: 8.2.28 在8.2.27只接收同步基础上增加隔离预览设备注册、本地设备凭据、pendingCloudChanges候选派发、幂等重试、错误分类、状态回写与断网降级；不开放正式公共写入、自动批准或管理员审核。',
  'release note');

html = replaceOnce(html,
` <div class="cloud-collab-banner">
 <div><strong>本地候选模式</strong><span>身份、绑定和待上传队列只保存在本机；当前版本不会访问服务器。</span></div>
 <span class="cloud-collab-badge">离线 · 不联网</span>
 </div>

 <section class="cloud-collab-section" aria-labelledby="cloudIdentityTitle">`,
` <div class="cloud-collab-banner">
 <div><strong>接收同步 + 隔离候选派发</strong><span>只接收公共普通精确价格；参与协作模式可把白名单价格逐条送入隔离候选区，不能直接修改正式公共库。</span></div>
 <span class="cloud-collab-badge" id="cloudServerBadge">同步 · 检查中</span>
 </div>

 <section class="cloud-collab-section" aria-labelledby="cloudServerTitle">
 <h4 id="cloudServerTitle">公共只读同步</h4>
 <div class="cloud-collab-status" id="cloudServerSummary">尚未检查只读测试接口。</div>
 <p class="cloud-collab-note">只发送无凭据GET请求及公共groupId/libraryId；不会上传设备令牌、历史、订单、聊天、备注、布局或其他私人内容。</p>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudServerCheckBtn" type="button">检查服务器</button>
 </div>
 </section>

 <section class="cloud-collab-section" aria-labelledby="cloudIdentityTitle">`,
  'cloud banner and server section');

html = replaceOnce(html,
` <div class="cloud-collab-status" id="cloudBindingSummary">选择价格库后可建立本地绑定；当前不会校验云端是否存在该团或公共库。</div>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--primary app-btn--sm" id="cloudBindingSaveBtn" type="button">保存本地绑定</button>
 <button class="app-btn app-btn--danger app-btn--sm" id="cloudBindingRemoveBtn" type="button">解除绑定</button>
 </div>`,
` <div class="cloud-collab-status" id="cloudBindingSummary">选择价格库后可建立本地绑定；只有“参与协作”模式会生成白名单候选提交。</div>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--primary app-btn--sm" id="cloudBindingSaveBtn" type="button">保存本地绑定</button>
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudPublicVersionCheckBtn" type="button">检查并接收更新</button>
 <button class="app-btn app-btn--danger app-btn--sm" id="cloudBindingRemoveBtn" type="button">解除绑定</button>
 </div>
 <div class="cloud-collab-status" id="cloudPublicVersionSummary">公共更新尚未检查。</div>`,
  'public version controls');

html = replaceOnce(html,
` <section class="cloud-collab-section" aria-labelledby="cloudQueueTitle">
 <h4 id="cloudQueueTitle">本地协作状态</h4>`,
` <section class="cloud-collab-section" aria-labelledby="cloudUploadTitle">
 <h4 id="cloudUploadTitle">隔离预览候选派发</h4>
 <div class="cloud-collab-grid">
 <div class="cloud-collab-field cloud-collab-field--wide">
 <label for="cloudPreviewAccessInput">预览门禁凭据（只保留在本次页面内）</label>
 <input id="cloudPreviewAccessInput" type="password" autocomplete="new-password" spellcheck="false" placeholder="不写入本地存储、备份或日志">
 </div>
 </div>
 <p class="cloud-collab-note">设备令牌仅保存在独立的本地凭据区；预览门禁凭据不持久化。候选区只接收普通精确价格，服务端仍禁止正式公共变更和自动批准。</p>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudUploadRetryBtn" type="button">立即派发 / 重试可恢复项</button>
 </div>
 <div class="cloud-collab-status" id="cloudUploadSummary">候选派发尚未启动。</div>
 </section>

 <section class="cloud-collab-section" aria-labelledby="cloudQueueTitle">
 <h4 id="cloudQueueTitle">本地协作状态</h4>`,
  'submission controls');

html = replaceOnce(html,
  '<p class="cloud-collab-note">本阶段仅验证本地结构。不会自动监听 localStorage，也不会从导入、迁移、云端拉取或回滚流程生成提交。</p>',
  '<p class="cloud-collab-note">仅“参与协作”绑定会逐条生成普通精确价格候选；只接收模式、导入、迁移、云端拉取、回滚、系统记忆和私人数据永远不会进入上传队列。</p>',
  'queue note');

html = replaceOnce(html,
  '// ===== 公共协作数据库：本地Store实现结束 =====\n\n\n\nclass CloudCollabFeature {',
  `// ===== 公共协作数据库：本地Store实现结束 =====\n\n\n// ===== 公共协作数据库：只读API客户端（阶段3B） =====\n${readonlyClientSource}\n// ===== 公共协作数据库：只读API客户端结束 =====\n\n// ===== 公共协作数据库：公共快照校验与三方合并（阶段3B） =====\n${snapshotSyncSource}\n// ===== 公共协作数据库：公共快照合并结束 =====\n\n// ===== 公共协作数据库：隔离候选提交客户端（阶段4C） =====\n${submissionClientSource}\n// ===== 公共协作数据库：隔离候选提交客户端结束 =====\n\n\nclass CloudCollabFeature {`,
  'cloud clients insertion');

html = replaceOnce(html,
` constructor(app, stores) {
  this.app = app;
  this.stores = stores;
  this._eventScope = new FeatureEventScope();
  this.selectedLocalLibraryId = '';
  this.lastError = null;
 }`,
` constructor(app, stores, apiClient, submissionApi, submissionDispatcher, submissionIdFactory, previewSession) {
  this.app = app;
  this.stores = stores;
  this.apiClient = apiClient;
  this.submissionApi = submissionApi;
  this.submissionDispatcher = submissionDispatcher;
  this.submissionIdFactory = submissionIdFactory;
  this.previewSession = previewSession;
  this._eventScope = new FeatureEventScope();
  this.selectedLocalLibraryId = '';
  this.lastError = null;
  this.lastServerError = null;
  this.lastPublicVersion = null;
  this._readonlyCheckScheduled = false;
  this._receivePollTimer = null;
  this._syncLocks = new Set();
  this._submissionDispatchScheduled = false;
  this._uploadFlushTimer = null;
  this._uploadPollTimer = null;
  this._uploadOnlineHandler = null;
 }`,
  'CloudCollabFeature constructor');

html = replaceOnce(html,
`   this._eventScope.on(el.cloudCollabBtn, 'click', () => this.open());
   this._eventScope.on(el.cloudIdentitySaveBtn, 'click', () => this.saveIdentity());`,
`   this._eventScope.on(el.cloudCollabBtn, 'click', () => this.open());
   this._eventScope.on(el.cloudServerCheckBtn, 'click', () => this.checkServer({ interactive: true }));
   this._eventScope.on(el.cloudPublicVersionCheckBtn, 'click', () => this.checkSelectedPublicVersion());
   this._eventScope.on(el.cloudPreviewAccessInput, 'input', event => this.setPreviewAccessKey(event.currentTarget.value));
   this._eventScope.on(el.cloudUploadRetryBtn, 'click', () => this.retryRecoverableUploads());
   this._eventScope.on(el.cloudIdentitySaveBtn, 'click', () => this.saveIdentity());`,
  'cloud event bindings');

html = replaceOnce(html,
` loadLocalState() {
  const inspection = this.safeRead();
  const bindings = inspection?.bindings?.ok ? inspection.bindings.value.bindings : [];
  const queue = inspection?.queue?.ok ? inspection.queue.value.records : [];
  const scopes = inspection?.sync?.ok ? inspection.sync.value.scopes : [];
  const meta = inspection?.meta?.ok && inspection.meta.exists ? inspection.meta.value : null;
  this.app.cloudCollabState = {
   available: Boolean(inspection) && !this.lastError,
   identityReady: Boolean(meta) && !this.lastError,
   bindingCount: bindings.length,
   queuedCount: queue.filter(item => item.deliveryState !== 'acknowledged').length,
   conflictCount: scopes.reduce((sum, scope) => sum + scope.conflicts.filter(item => item.status === 'open').length, 0),
   errorCode: this.lastError?.code || null
  };
  return this.app.cloudCollabState;
 }`,
` loadLocalState() {
  const inspection = this.safeRead();
  const bindings = inspection?.bindings?.ok ? inspection.bindings.value.bindings : [];
  const queue = inspection?.queue?.ok ? inspection.queue.value.records : [];
  const scopes = inspection?.sync?.ok ? inspection.sync.value.scopes : [];
  const meta = inspection?.meta?.ok && inspection.meta.exists ? inspection.meta.value : null;
  const previous = this.app.cloudCollabState || {};
  this.app.cloudCollabState = {
   available: Boolean(inspection) && !this.lastError,
   identityReady: Boolean(meta) && !this.lastError,
   bindingCount: bindings.length,
   queuedCount: queue.filter(item => item.deliveryState !== 'acknowledged').length,
   conflictCount: scopes.reduce((sum, scope) => sum + scope.conflicts.filter(item => item.status === 'open').length, 0),
   errorCode: this.lastError?.code || null,
   serverStatus: previous.serverStatus || 'idle',
   serverProtocolVersion: previous.serverProtocolVersion ?? null,
   serverCheckedAt: previous.serverCheckedAt || null,
   serverErrorCode: previous.serverErrorCode || null,
   uploadStatus: previous.uploadStatus || 'idle',
   uploadErrorCode: previous.uploadErrorCode || null,
   uploadErrorCategory: previous.uploadErrorCategory || null,
   uploadCheckedAt: previous.uploadCheckedAt || null
  };
  return this.app.cloudCollabState;
 }`,
  'preserve cloud state');

html = replaceOnce(html,
`  this.renderBindingForm(bindings);
  this.loadLocalState();
  if (this.lastError) this.setStatus(this.formatError(this.lastError), 'error');
 }`,
`  this.renderBindingForm(bindings);
  this.loadLocalState();
  this.renderServerStatus();
  this.renderPublicVersionSummary();
  this.renderUploadStatus();
  if (this.lastError) this.setStatus(this.formatError(this.lastError), 'error');
 }`,
  'render cloud status');

html = replaceOnce(html,
`  if (el.cloudBindingRemoveBtn) el.cloudBindingRemoveBtn.disabled = !binding;
  if (el.cloudBindingSaveBtn) el.cloudBindingSaveBtn.disabled = !localLibraryId;
 }

 getModeLabel(mode) {`,
`  if (el.cloudBindingRemoveBtn) el.cloudBindingRemoveBtn.disabled = !binding;
  if (el.cloudBindingSaveBtn) el.cloudBindingSaveBtn.disabled = !localLibraryId;
  if (el.cloudPublicVersionCheckBtn) el.cloudPublicVersionCheckBtn.disabled = !binding || !this.apiClient?.isConfigured?.();
 }

${readonlyFeatureMethods}

${submissionFeatureMethods}

 getModeLabel(mode) {`,
  'cloud feature methods');

html = replaceOnce(html,
  "   this.setStatus(`本地绑定已保存：${this.getModeLabel(mode)}。当前不会连接服务器。`, 'success');",
  "   this.setStatus(`本地绑定已保存：${this.getModeLabel(mode)}。${mode === 'local' ? '不会接收或提交。' : mode === 'receive' ? '将异步接收公共更新，不会上传。' : '将先接收比较，再逐条生成白名单候选。'}`, 'success');\n   setTimeout(async () => {\n    const savedBinding = this.stores.bindingStore.getByLocalLibraryId(localLibraryId);\n    if (mode !== 'local') await this.syncBinding(savedBinding, { interactive: false, force: false, reason: 'binding' });\n    if (mode === 'collaborate') await this.enqueueInitialBindingSubmissions(localLibraryId);\n   }, 0);",
  'binding receive and enqueue trigger');

html = replaceOnce(html,
` this.priceLibraryStore = new PriceLibraryStore(storage, this.priceMemoryStore);
 this.cloudCollabStores = CloudCollabLocalStores.createCloudCollabStores(storage);
 this.extractorService = new ExtractorService();`,
` this.priceLibraryStore = new PriceLibraryStore(storage, this.priceMemoryStore);
 this.cloudCollabStores = CloudCollabLocalStores.createCloudCollabStores(storage);
 this.cloudCollabPreviewSession = { accessKey: '' };
 this.cloudCollabApi = CloudCollabReadonly.createConfiguredClient({ documentRef: document, locationRef: window.location, timeoutMs: 3500 });
 this.cloudCollabSubmissionApi = CloudCollabSubmission.createConfiguredClient({
  documentRef: document,
  locationRef: window.location,
  timeoutMs: 8000,
  previewAccessKeyProvider: () => this.cloudCollabPreviewSession.accessKey
 });
 this.cloudCollabSubmissionIdFactory = CloudCollabLocalStores.createIdFactory();
 this.cloudCollabSubmissionDispatcher = new CloudCollabSubmission.SubmissionDispatcher({
  apiClient: this.cloudCollabSubmissionApi,
  metaStore: this.cloudCollabStores.metaStore,
  credentialStore: this.cloudCollabStores.credentialStore,
  queueStore: this.cloudCollabStores.queueStore,
  appVersion: '8.2.28',
  onState: state => {
   this.cloudCollabState = {
    ...(this.cloudCollabState || {}),
    uploadStatus: state.status || 'idle',
    uploadErrorCode: state.errorCode || null,
    uploadErrorCategory: state.category || null,
    uploadCheckedAt: state.at || Date.now()
   };
   try { this.cloudCollabFeature?.renderUploadStatus?.(); } catch (error) { appLogSilent(error); }
  }
 });
 this.extractorService = new ExtractorService();`,
  'create cloud clients');

html = replaceOnce(html,
  "this.registerFeature('cloudCollabFeature', new CloudCollabFeature(this, this.cloudCollabStores));",
  "this.registerFeature('cloudCollabFeature', new CloudCollabFeature(this, this.cloudCollabStores, this.cloudCollabApi, this.cloudCollabSubmissionApi, this.cloudCollabSubmissionDispatcher, this.cloudCollabSubmissionIdFactory, this.cloudCollabPreviewSession));",
  'register cloud clients');
html = replaceOnce(html,
` cloudCollabState: { available: true, identityReady: false, bindingCount: 0, queuedCount: 0, conflictCount: 0, errorCode: null },`,
` cloudCollabState: { available: true, identityReady: false, bindingCount: 0, queuedCount: 0, conflictCount: 0, errorCode: null, serverStatus: 'idle', serverProtocolVersion: null, serverCheckedAt: null, serverErrorCode: null, uploadStatus: 'idle', uploadErrorCode: null, uploadErrorCategory: null, uploadCheckedAt: null },`,
  'initial cloud state');
html = replaceOnce(html,
` try { this.cloudCollabFeature.loadLocalState(); } catch (error) { appLogError('cloudCollabLocalInit', error); }
 this.initClearButtons();`,
` try { this.cloudCollabFeature.loadLocalState(); } catch (error) { appLogError('cloudCollabLocalInit', error); }
 try { this.cloudCollabFeature.scheduleReadonlyCheck(); } catch (error) { appLogError('cloudCollabReadonlySchedule', error); }
 try { this.cloudCollabFeature.scheduleSubmissionDispatch(); } catch (error) { appLogError('cloudCollabSubmissionSchedule', error); }
 this.initClearButtons();`,
  'schedule cloud clients');
html = replaceOnce(html,
` 'cloudCollabBtn', 'cloudCollabModal', 'cloudNicknameInput', 'cloudIdentitySummary', 'cloudIdentitySaveBtn', 'cloudLocalLibrarySelect', 'cloudGroupIdInput', 'cloudLibraryIdInput', 'cloudBindingModeSelect', 'cloudBindingSummary', 'cloudBindingSaveBtn', 'cloudBindingRemoveBtn', 'cloudBindingCount', 'cloudQueueCount', 'cloudConflictCount', 'cloudRefreshBtn', 'cloudOperationStatus',`,
` 'cloudCollabBtn', 'cloudCollabModal', 'cloudServerBadge', 'cloudServerSummary', 'cloudServerCheckBtn', 'cloudNicknameInput', 'cloudIdentitySummary', 'cloudIdentitySaveBtn', 'cloudLocalLibrarySelect', 'cloudGroupIdInput', 'cloudLibraryIdInput', 'cloudBindingModeSelect', 'cloudBindingSummary', 'cloudBindingSaveBtn', 'cloudPublicVersionCheckBtn', 'cloudPublicVersionSummary', 'cloudBindingRemoveBtn', 'cloudPreviewAccessInput', 'cloudUploadRetryBtn', 'cloudUploadSummary', 'cloudBindingCount', 'cloudQueueCount', 'cloudConflictCount', 'cloudRefreshBtn', 'cloudOperationStatus',`,
  'cache cloud elements');

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(outputPath, html, 'utf8');
const digest = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
const manifest = {
  version: '8.2.28',
  source: path.relative(root, sourcePath),
  output: path.relative(root, outputPath),
  apiBase: process.env.CLOUD_COLLAB_API_BASE || 'same-origin-or-disabled-for-file',
  stage: '4C-preview-submission-client',
  sha256: digest,
  bytes: Buffer.byteLength(html),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(distDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
