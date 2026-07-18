import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src', '码单器8.2.26_公共协作本地候选版.html');
const clientPath = path.join(root, 'src', 'cloud_collab_readonly_client.js');
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
const clientSource = fs.readFileSync(clientPath, 'utf8').trim();
const featureMethods = fs.readFileSync(path.join(root, 'src', 'cloud_collab_readonly_feature_methods.fragment.js'), 'utf8').trim();
const configuredApiBase = escapeHtmlAttribute(process.env.CLOUD_COLLAB_API_BASE || '');

html = replaceOnce(html,
  '<title>码单器8.2.26（公共协作本地候选）</title>',
  '<title>码单器8.2.27（公共协作只读联调候选）</title>',
  'title');
html = replaceOnce(html,
  '/* ===== 公共协作数据库（8.2.26 本地候选；不联网） ===== */',
  '/* ===== 公共协作数据库（8.2.27 只读联调候选；服务器失败可降级） ===== */',
  'cloud CSS comment');
html = replaceOnce(html,
  "<meta name=\"AIGC\" content='",
  `<meta name="cloud-collab-api-base" content="${configuredApiBase}">\n    <meta name="AIGC" content='`,
  'API base meta');
html = replaceOnce(html,
  '<!-- 码单器 8.2.26 公共协作数据库本地候选版：不连接服务器，不影响正常码单 -->',
  '<!-- 码单器 8.2.27 公共协作数据库只读联调候选版：异步只读检查，服务器失败不影响正常码单 -->',
  'body release comment');
html = replaceOnce(html,
  "const APP_VERSION = '8.2.26';",
  "const APP_VERSION = '8.2.27';",
  'APP_VERSION');
html = replaceOnce(html,
  '// Release note: 8.2.26 新增公共协作数据库本地候选层：独立身份/凭据/绑定/老板映射/待上传队列/同步状态Store，惰性创建身份，支持价格库本地/只接收/参与协作模式；本阶段不包含任何网络请求。',
  '// Release note: 8.2.27 在8.2.26本地候选层上新增可降级的异步只读联调：health、protocol和public-version；不开放提交、审核或管理员写入。',
  'release note');

html = replaceOnce(html,
` <div class="cloud-collab-banner">
 <div><strong>本地候选模式</strong><span>身份、绑定和待上传队列只保存在本机；当前版本不会访问服务器。</span></div>
 <span class="cloud-collab-badge">离线 · 不联网</span>
 </div>

 <section class="cloud-collab-section" aria-labelledby="cloudIdentityTitle">`,
` <div class="cloud-collab-banner">
 <div><strong>只读联调候选</strong><span>页面启动不等待服务器；只读取健康状态、协议版本和公共版本，失败时正常码单不受影响。</span></div>
 <span class="cloud-collab-badge" id="cloudServerBadge">只读 · 检查中</span>
 </div>

 <section class="cloud-collab-section" aria-labelledby="cloudServerTitle">
 <h4 id="cloudServerTitle">测试服务器</h4>
 <div class="cloud-collab-status" id="cloudServerSummary">尚未检查只读测试接口。</div>
 <p class="cloud-collab-note">只发送无凭据GET请求；不会上传身份、绑定、价格、老板、历史或任何本地数据。</p>
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
` <div class="cloud-collab-status" id="cloudBindingSummary">选择价格库后可建立本地绑定；保存绑定不会向服务器发送数据。</div>
 <div class="cloud-collab-actions">
 <button class="app-btn app-btn--primary app-btn--sm" id="cloudBindingSaveBtn" type="button">保存本地绑定</button>
 <button class="app-btn app-btn--secondary app-btn--sm" id="cloudPublicVersionCheckBtn" type="button">检查公共版本</button>
 <button class="app-btn app-btn--danger app-btn--sm" id="cloudBindingRemoveBtn" type="button">解除绑定</button>
 </div>
 <div class="cloud-collab-status" id="cloudPublicVersionSummary">公共版本尚未检查。</div>`,
  'public version controls');
html = replaceOnce(html,
  '<p class="cloud-collab-note">本阶段仅验证本地结构。不会自动监听 localStorage，也不会从导入、迁移、云端拉取或回滚流程生成提交。</p>',
  '<p class="cloud-collab-note">本阶段只读联调。不会生成提交，不会拉取快照，不会监听 localStorage，也不会从导入、迁移、回滚或服务器响应创建待上传记录。</p>',
  'queue note');

html = replaceOnce(html,
  '// ===== 公共协作数据库：本地Store实现结束 =====\n\n\n\nclass CloudCollabFeature {',
  `// ===== 公共协作数据库：本地Store实现结束 =====\n\n\n// ===== 公共协作数据库：只读API客户端（阶段3A） =====\n${clientSource}\n// ===== 公共协作数据库：只读API客户端结束 =====\n\n\nclass CloudCollabFeature {`,
  'readonly client insertion');

html = replaceOnce(html,
` constructor(app, stores) {
  this.app = app;
  this.stores = stores;
  this._eventScope = new FeatureEventScope();
  this.selectedLocalLibraryId = '';
  this.lastError = null;
 }`,
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
 }`,
  'CloudCollabFeature constructor');

html = replaceOnce(html,
`   this._eventScope.on(el.cloudCollabBtn, 'click', () => this.open());
   this._eventScope.on(el.cloudIdentitySaveBtn, 'click', () => this.saveIdentity());`,
`   this._eventScope.on(el.cloudCollabBtn, 'click', () => this.open());
   this._eventScope.on(el.cloudServerCheckBtn, 'click', () => this.checkServer({ interactive: true }));
   this._eventScope.on(el.cloudPublicVersionCheckBtn, 'click', () => this.checkSelectedPublicVersion());
   this._eventScope.on(el.cloudIdentitySaveBtn, 'click', () => this.saveIdentity());`,
  'readonly event bindings');

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
   serverErrorCode: previous.serverErrorCode || null
  };
  return this.app.cloudCollabState;
 }`,
  'preserve server state');

html = replaceOnce(html,
`  this.renderBindingForm(bindings);
  this.loadLocalState();
  if (this.lastError) this.setStatus(this.formatError(this.lastError), 'error');
 }`,
`  this.renderBindingForm(bindings);
  this.loadLocalState();
  this.renderServerStatus();
  this.renderPublicVersionSummary();
  if (this.lastError) this.setStatus(this.formatError(this.lastError), 'error');
 }`,
  'render readonly status');

html = replaceOnce(html,
`  if (el.cloudBindingRemoveBtn) el.cloudBindingRemoveBtn.disabled = !binding;
  if (el.cloudBindingSaveBtn) el.cloudBindingSaveBtn.disabled = !localLibraryId;
 }

 getModeLabel(mode) {`,
`  if (el.cloudBindingRemoveBtn) el.cloudBindingRemoveBtn.disabled = !binding;
  if (el.cloudBindingSaveBtn) el.cloudBindingSaveBtn.disabled = !localLibraryId;
  if (el.cloudPublicVersionCheckBtn) el.cloudPublicVersionCheckBtn.disabled = !binding || !this.apiClient?.isConfigured?.();
 }

${featureMethods}

 getModeLabel(mode) {`,
  'readonly feature methods');

html = replaceOnce(html,
` this.priceLibraryStore = new PriceLibraryStore(storage, this.priceMemoryStore);
 this.cloudCollabStores = CloudCollabLocalStores.createCloudCollabStores(storage);
 this.extractorService = new ExtractorService();`,
` this.priceLibraryStore = new PriceLibraryStore(storage, this.priceMemoryStore);
 this.cloudCollabStores = CloudCollabLocalStores.createCloudCollabStores(storage);
 this.cloudCollabApi = CloudCollabReadonly.createConfiguredClient({ documentRef: document, locationRef: window.location, timeoutMs: 3500 });
 this.extractorService = new ExtractorService();`,
  'create readonly client');
html = replaceOnce(html,
  "this.registerFeature('cloudCollabFeature', new CloudCollabFeature(this, this.cloudCollabStores));",
  "this.registerFeature('cloudCollabFeature', new CloudCollabFeature(this, this.cloudCollabStores, this.cloudCollabApi));",
  'register readonly client');
html = replaceOnce(html,
` cloudCollabState: { available: true, identityReady: false, bindingCount: 0, queuedCount: 0, conflictCount: 0, errorCode: null },`,
` cloudCollabState: { available: true, identityReady: false, bindingCount: 0, queuedCount: 0, conflictCount: 0, errorCode: null, serverStatus: 'idle', serverProtocolVersion: null, serverCheckedAt: null, serverErrorCode: null },`,
  'initial cloud state');
html = replaceOnce(html,
` try { this.cloudCollabFeature.loadLocalState(); } catch (error) { appLogError('cloudCollabLocalInit', error); }
 this.initClearButtons();`,
` try { this.cloudCollabFeature.loadLocalState(); } catch (error) { appLogError('cloudCollabLocalInit', error); }
 try { this.cloudCollabFeature.scheduleReadonlyCheck(); } catch (error) { appLogError('cloudCollabReadonlySchedule', error); }
 this.initClearButtons();`,
  'schedule readonly check');
html = replaceOnce(html,
` 'cloudCollabBtn', 'cloudCollabModal', 'cloudNicknameInput', 'cloudIdentitySummary', 'cloudIdentitySaveBtn', 'cloudLocalLibrarySelect', 'cloudGroupIdInput', 'cloudLibraryIdInput', 'cloudBindingModeSelect', 'cloudBindingSummary', 'cloudBindingSaveBtn', 'cloudBindingRemoveBtn', 'cloudBindingCount', 'cloudQueueCount', 'cloudConflictCount', 'cloudRefreshBtn', 'cloudOperationStatus',`,
` 'cloudCollabBtn', 'cloudCollabModal', 'cloudServerBadge', 'cloudServerSummary', 'cloudServerCheckBtn', 'cloudNicknameInput', 'cloudIdentitySummary', 'cloudIdentitySaveBtn', 'cloudLocalLibrarySelect', 'cloudGroupIdInput', 'cloudLibraryIdInput', 'cloudBindingModeSelect', 'cloudBindingSummary', 'cloudBindingSaveBtn', 'cloudPublicVersionCheckBtn', 'cloudPublicVersionSummary', 'cloudBindingRemoveBtn', 'cloudBindingCount', 'cloudQueueCount', 'cloudConflictCount', 'cloudRefreshBtn', 'cloudOperationStatus',`,
  'cache readonly elements');

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(outputPath, html, 'utf8');
const digest = crypto.createHash('sha256').update(Buffer.from(html)).digest('hex');
const manifest = {
  version: '8.2.27',
  source: path.relative(root, sourcePath),
  output: path.relative(root, outputPath),
  apiBase: process.env.CLOUD_COLLAB_API_BASE || 'same-origin-or-disabled-for-file',
  sha256: digest,
  bytes: Buffer.byteLength(html),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(distDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(JSON.stringify(manifest, null, 2));
