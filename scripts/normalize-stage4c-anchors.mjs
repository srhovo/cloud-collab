import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'dist', 'index.html');
let html = fs.readFileSync(outputPath, 'utf8');

function normalizeUnique(pattern, replacement, label) {
  const matches = html.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) || [];
  if (matches.length !== 1) throw new Error(`阶段4C${label}锚点数量异常：${matches.length}`);
  html = html.replace(pattern, replacement);
}

normalizeUnique(
  /\sconstructor\(app,\s*stores,\s*apiClient\)\s*\{[\s\S]*?this\._syncLocks\s*=\s*new Set\(\);\s*\}/,
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
  '构造函数',
);

normalizeUnique(
  /\s*this\._eventScope\.on\(el\.cloudCollabBtn,\s*'click',\s*\(\)\s*=>\s*this\.open\(\)\);[\s\S]*?this\._eventScope\.on\(el\.cloudIdentitySaveBtn,\s*'click',\s*\(\)\s*=>\s*this\.saveIdentity\(\)\);/,
`   this._eventScope.on(el.cloudCollabBtn, 'click', () => this.open());
    this._eventScope.on(el.cloudServerCheckBtn, 'click', () => this.checkServer({ interactive: true }));
    this._eventScope.on(el.cloudPublicVersionCheckBtn, 'click', () => this.checkSelectedPublicVersion());
    this._eventScope.on(el.cloudIdentitySaveBtn, 'click', () => this.saveIdentity());`,
  '事件绑定',
);

normalizeUnique(
  /\s*this\.renderServerStatus\(\);\s*this\.renderPublicVersionSummary\(\);\s*if \(this\.lastError\) this\.setStatus\(this\.formatError\(this\.lastError\), 'error'\);/,
`  this.renderServerStatus();
   this.renderPublicVersionSummary();
   if (this.lastError) this.setStatus(this.formatError(this.lastError), 'error');`,
  '状态渲染',
);

normalizeUnique(
  /\s*this\.setStatus\(`本地绑定已保存：\$\{this\.getModeLabel\(mode\)\}。\$\{mode === 'local' \? '不会接收公共更新。' : '将异步检查公共更新。'\}`, 'success'\);\s*if \(mode !== 'local'\) setTimeout\(\(\) => this\.syncBinding\(this\.stores\.bindingStore\.getByLocalLibraryId\(localLibraryId\), \{ interactive: false, force: false, reason: 'binding' \}\), 0\);/,
`   this.setStatus(\`本地绑定已保存：\${this.getModeLabel(mode)}。\${mode === 'local' ? '不会接收公共更新。' : '将异步检查公共更新。'}\`, 'success');
   if (mode !== 'local') setTimeout(() => this.syncBinding(this.stores.bindingStore.getByLocalLibraryId(localLibraryId), { interactive: false, force: false, reason: 'binding' }), 0);`,
  '绑定触发',
);

normalizeUnique(
  /\s*this\.priceLibraryStore\s*=\s*new PriceLibraryStore\(storage,\s*this\.priceMemoryStore\);\s*this\.cloudCollabStores\s*=\s*CloudCollabLocalStores\.createCloudCollabStores\(storage\);\s*this\.cloudCollabApi\s*=\s*CloudCollabReadonly\.createConfiguredClient\(\{ documentRef: document, locationRef: window\.location, timeoutMs: 3500 \}\);\s*this\.extractorService\s*=\s*new ExtractorService\(\);/,
` this.priceLibraryStore = new PriceLibraryStore(storage, this.priceMemoryStore);
  this.cloudCollabStores = CloudCollabLocalStores.createCloudCollabStores(storage);
  this.cloudCollabApi = CloudCollabReadonly.createConfiguredClient({ documentRef: document, locationRef: window.location, timeoutMs: 3500 });
  this.extractorService = new ExtractorService();`,
  '客户端初始化',
);

normalizeUnique(
  /\s*try \{ this\.cloudCollabFeature\.loadLocalState\(\); \} catch \(error\) \{ appLogError\('cloudCollabLocalInit', error\); \}\s*try \{ this\.cloudCollabFeature\.scheduleReadonlyCheck\(\); \} catch \(error\) \{ appLogError\('cloudCollabReadonlySchedule', error\); \}\s*this\.initClearButtons\(\);/,
` try { this.cloudCollabFeature.loadLocalState(); } catch (error) { appLogError('cloudCollabLocalInit', error); }
  try { this.cloudCollabFeature.scheduleReadonlyCheck(); } catch (error) { appLogError('cloudCollabReadonlySchedule', error); }
  this.initClearButtons();`,
  '启动调度',
);

fs.writeFileSync(outputPath, html, 'utf8');
