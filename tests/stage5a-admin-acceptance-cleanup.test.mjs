import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ADMIN_ACCEPTANCE_CLEANUP_CONFIRM,
  ADMIN_ACCEPTANCE_CLEANUP_PREFIX,
  AdminAcceptanceCleanupError,
  assertAdminAcceptanceCleanupAccess,
  assertAdminAcceptanceCleanupConfirmation,
  cleanupAdminAcceptanceObjects,
  inspectAdminAcceptanceObjects,
  readAdminAcceptanceCleanupConfig,
} from '../src/server/admin_acceptance_cleanup_v1.js';
import {
  handleAdminAcceptanceCleanupRequest,
  handleAdminAcceptanceStatusRequest,
} from '../src/server/admin_acceptance_cleanup_http_v1.js';
import { ADMIN_PREVIEW_STORE_NAME } from '../src/server/admin_auth_v1.js';

const CLEANUP_KEY = 'stage5a-acceptance-cleanup-key-012345678901';
const ENV = Object.freeze({
  CLOUD_ADMIN_ACCEPTANCE_CLEANUP_ENABLED: '1',
  CLOUD_ADMIN_ACCEPTANCE_CLEANUP_KEY: CLEANUP_KEY,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_PREVIEW_ENABLED: '0',
  CLOUD_ADMIN_PASSWORD: 'stage5a-admin-password-0123456789',
  CLOUD_ADMIN_SESSION_SECRET: 'stage5a-session-secret-012345678901234',
  CLOUD_ADMIN_RATE_LIMIT_SALT: 'stage5a-rate-limit-salt-0123456789012',
  CLOUD_WRITE_PREVIEW_ENABLED: '0',
  CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '0',
});

const HASH_A = 'A'.repeat(43);
const HASH_B = 'B'.repeat(43);
const KEY_A = `${ADMIN_ACCEPTANCE_CLEANUP_PREFIX}${HASH_A}/178441000.json`;
const KEY_B = `${ADMIN_ACCEPTANCE_CLEANUP_PREFIX}${HASH_B}/178441001.json`;

class MemoryBlobStore {
  constructor(entries = []) {
    this.items = new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
    this.listOptions = [];
    this.getOptions = [];
    this.deleted = [];
  }

  async list(options = {}) {
    this.listOptions.push(options);
    return { blobs: [...this.items.keys()].sort().map(key => ({ key })) };
  }

  async get(key, options = {}) {
    this.getOptions.push(options);
    return this.items.has(key) ? structuredClone(this.items.get(key)) : null;
  }

  async setJSON(key, value) {
    this.items.set(key, structuredClone(value));
  }

  async delete(key) {
    this.deleted.push(key);
    this.items.delete(key);
  }
}

function request(path, { method = 'GET', body, key = CLEANUP_KEY, headers = {} } = {}) {
  return new Request(`https://stage5a-acceptance.test${path}`, {
    method,
    headers: {
      ...(key === null ? {} : { 'X-Cloud-Admin-Acceptance-Key': key }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'POST' ? { Origin: 'https://stage5a-acceptance.test' } : {}),
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function confirmation(overrides = {}) {
  return { schemaVersion: 1, confirm: ADMIN_ACCEPTANCE_CLEANUP_CONFIRM, ...overrides };
}

test('cleanup config is default-off, secret-gated, store-locked, and incompatible with public preview writes', () => {
  assert.throws(
    () => readAdminAcceptanceCleanupConfig({}),
    error => error.code === 'ADMIN_ACCEPTANCE_CLEANUP_DISABLED',
  );
  assert.throws(
    () => readAdminAcceptanceCleanupConfig({ ...ENV, CLOUD_ADMIN_ACCEPTANCE_CLEANUP_KEY: '' }),
    error => error.code === 'ADMIN_ACCEPTANCE_CLEANUP_KEY_NOT_CONFIGURED',
  );
  assert.throws(
    () => readAdminAcceptanceCleanupConfig({ ...ENV, CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-preview-v1' }),
    error => error.code === 'ADMIN_ACCEPTANCE_STORE_MISCONFIGURED',
  );
  assert.throws(
    () => readAdminAcceptanceCleanupConfig({ ...ENV, CLOUD_ADMIN_PREVIEW_ENABLED: '1' }),
    error => error.code === 'ADMIN_ACCEPTANCE_REQUIRES_ADMIN_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readAdminAcceptanceCleanupConfig({ ...ENV, CLOUD_WRITE_PREVIEW_ENABLED: '1' }),
    error => error.code === 'ADMIN_ACCEPTANCE_REQUIRES_PUBLIC_PREVIEW_DISABLED',
  );
  assert.throws(
    () => readAdminAcceptanceCleanupConfig({ ...ENV, CLOUD_ADMIN_SESSION_SECRET: CLEANUP_KEY }),
    error => error.code === 'ADMIN_ACCEPTANCE_SECRETS_MUST_BE_DISTINCT',
  );
  assert.equal(readAdminAcceptanceCleanupConfig(ENV).storeName, ADMIN_PREVIEW_STORE_NAME);
});

test('cleanup access requires same-origin HTTPS and exact temporary key', () => {
  const config = readAdminAcceptanceCleanupConfig(ENV);
  assert.equal(assertAdminAcceptanceCleanupAccess(request('/api/admin/acceptance/status'), config), true);
  for (const key of [null, 'wrong-cleanup-key-value-012345678901234']) {
    assert.throws(
      () => assertAdminAcceptanceCleanupAccess(request('/api/admin/acceptance/status', { key }), config),
      error => error.code === 'ADMIN_ACCEPTANCE_CLEANUP_ACCESS_DENIED',
    );
  }
  assert.throws(
    () => assertAdminAcceptanceCleanupAccess(new Request('http://stage5a-acceptance.test/api/admin/acceptance/status'), config),
    error => error.code === 'ADMIN_HTTPS_REQUIRED',
  );
});

test('status uses strong list and reads, returns only counts, and exposes no object key', async () => {
  const store = new MemoryBlobStore([
    [KEY_A, { schemaVersion: 1, slot: 178441000 }],
    [KEY_B, { schemaVersion: 1, slot: 178441001 }],
  ]);
  const result = await inspectAdminAcceptanceObjects({ store });
  assert.deepEqual(result, {
    objectCount: 2,
    namespaceClean: false,
    cleanupPrefix: ADMIN_ACCEPTANCE_CLEANUP_PREFIX,
  });
  assert.ok(store.listOptions.every(options => options.consistency === 'strong'));
  assert.ok(store.getOptions.every(options => options.consistency === 'strong'));
  assert.equal(JSON.stringify(result).includes(HASH_A), false);
});

test('cleanup deletes every allowed rate object and strong reread proves remaining zero', async () => {
  const store = new MemoryBlobStore([
    [KEY_A, { schemaVersion: 1, slot: 178441000 }],
    [KEY_B, { schemaVersion: 1, slot: 178441001 }],
  ]);
  const result = await cleanupAdminAcceptanceObjects({ store });
  assert.deepEqual(result, {
    deletedObjectCount: 2,
    remainingObjectCount: 0,
    namespaceClean: true,
    cleanupPrefix: ADMIN_ACCEPTANCE_CLEANUP_PREFIX,
  });
  assert.deepEqual(store.deleted.sort(), [KEY_A, KEY_B].sort());
  assert.equal(store.items.size, 0);
  assert.ok(store.listOptions.length >= 2);
  assert.ok(store.listOptions.every(options => options.consistency === 'strong'));
  assert.ok(store.getOptions.every(options => options.consistency === 'strong'));
});

test('unexpected namespace object blocks all deletion without revealing its key', async () => {
  const unexpected = 'public/events/000000000001.json';
  const store = new MemoryBlobStore([
    [KEY_A, { schemaVersion: 1 }],
    [unexpected, { schemaVersion: 1 }],
  ]);
  await assert.rejects(
    () => cleanupAdminAcceptanceObjects({ store }),
    error => error instanceof AdminAcceptanceCleanupError
      && error.code === 'ADMIN_ACCEPTANCE_UNEXPECTED_OBJECTS'
      && JSON.stringify(error.details).includes(unexpected) === false,
  );
  assert.deepEqual(store.deleted, []);
  assert.equal(store.items.size, 2);
});

test('confirmation is strict and fixed to the Stage5A acceptance cleanup phrase', () => {
  assert.equal(assertAdminAcceptanceCleanupConfirmation(confirmation()), true);
  for (const value of [
    confirmation({ confirm: 'DELETE_ALL' }),
    { ...confirmation(), extra: true },
    null,
  ]) {
    assert.throws(
      () => assertAdminAcceptanceCleanupConfirmation(value),
      error => error.code === 'ADMIN_ACCEPTANCE_CONFIRMATION_INVALID',
    );
  }
});

test('HTTP gates access before store creation and keeps cleanup capabilities closed', async () => {
  let stores = 0;
  const denied = await handleAdminAcceptanceStatusRequest({
    env: ENV,
    request: request('/api/admin/acceptance/status', { key: 'wrong-cleanup-key-value-012345678901234' }),
  }, { createStore: () => { stores += 1; return new MemoryBlobStore(); } });
  assert.equal(denied.status, 403);
  assert.equal(stores, 0);

  const store = new MemoryBlobStore([[KEY_A, { schemaVersion: 1 }]]);
  const cleaned = await handleAdminAcceptanceCleanupRequest({
    env: ENV,
    request: request('/api/admin/acceptance/cleanup', { method: 'POST', body: confirmation() }),
  }, { createStore: env => {
    stores += 1;
    assert.equal(env.CLOUD_BLOB_STORE_NAME, ADMIN_PREVIEW_STORE_NAME);
    return store;
  } });
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.headers.get('access-control-allow-origin'), null);
  const text = await cleaned.text();
  const payload = JSON.parse(text);
  assert.equal(payload.data.deletedObjectCount, 1);
  assert.equal(payload.data.remainingObjectCount, 0);
  assert.equal(payload.data.publicMutationAllowed, false);
  assert.equal(payload.data.reviewMutationAllowed, false);
  assert.equal(payload.data.acceptanceCleanupOnly, true);
  for (const forbidden of [CLEANUP_KEY, KEY_A, HASH_A]) assert.equal(text.includes(forbidden), false);
});

test('cleanup HTTP body is JSON-only, bounded, strict, and POST-only', async () => {
  const dependencies = { createStore: () => new MemoryBlobStore() };
  const wrongConfirm = await handleAdminAcceptanceCleanupRequest({
    env: ENV,
    request: request('/api/admin/acceptance/cleanup', {
      method: 'POST',
      body: confirmation({ confirm: 'WRONG' }),
    }),
  }, dependencies);
  assert.equal(wrongConfirm.status, 400);
  const textBody = await handleAdminAcceptanceCleanupRequest({
    env: ENV,
    request: request('/api/admin/acceptance/cleanup', {
      method: 'POST',
      body: JSON.stringify(confirmation()),
      headers: { 'Content-Type': 'text/plain' },
    }),
  }, dependencies);
  assert.equal(textBody.status, 415);
  const wrongMethod = await handleAdminAcceptanceCleanupRequest({
    env: ENV,
    request: request('/api/admin/acceptance/cleanup'),
  }, dependencies);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
});

test('temporary cleanup page is unlinked, secret-free, and calls only acceptance routes', () => {
  const page = fs.readFileSync('dist/admin-acceptance-cleanup.html', 'utf8');
  const adminPage = fs.readFileSync('dist/admin-preview.html', 'utf8');
  const userSource = fs.readFileSync('src/码单器8.2.26_公共协作本地候选版.html', 'utf8');
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.match(page, /DO NOT MERGE|禁止合并/);
  assert.match(page, /\/api\/admin\/acceptance\/status/);
  assert.match(page, /\/api\/admin\/acceptance\/cleanup/);
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.setItem/);
  assert.doesNotMatch(page, /indexedDB\.(?:open|deleteDatabase)/);
  assert.doesNotMatch(page, /console\.(?:log|warn|error)/);
  assert.doesNotMatch(page, /CLOUD_ADMIN_ACCEPTANCE_CLEANUP_KEY\s*=/);
  assert.doesNotMatch(page, /\/api\/(?:submissions|preview|public-)/);
  assert.doesNotMatch(adminPage, /admin-acceptance-cleanup|\/api\/admin\/acceptance/);
  assert.doesNotMatch(userSource, /admin-acceptance-cleanup|\/api\/admin\/acceptance/);
});

test('temporary env defaults are off and empty, and routes import only acceptance cleanup handlers', async () => {
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.match(env, /^CLOUD_ADMIN_ACCEPTANCE_CLEANUP_ENABLED=0$/m);
  assert.match(env, /^CLOUD_ADMIN_ACCEPTANCE_CLEANUP_KEY=$/m);

  const statusRoute = fs.readFileSync('cloud-functions/api/admin/acceptance/status.js', 'utf8');
  const cleanupRoute = fs.readFileSync('cloud-functions/api/admin/acceptance/cleanup.js', 'utf8');
  assert.match(statusRoute, /handleAdminAcceptanceStatusRequest/);
  assert.match(cleanupRoute, /handleAdminAcceptanceCleanupRequest/);
  for (const source of [statusRoute, cleanupRoute]) {
    assert.doesNotMatch(source, /handle[A-Za-z]*(?:Submission|Review|Approval|Rollback|Export)/);
  }
  const modules = await Promise.all([
    import('../cloud-functions/api/admin/acceptance/status.js'),
    import('../cloud-functions/api/admin/acceptance/cleanup.js'),
  ]);
  assert.ok(modules.every(module => typeof module.default === 'function'));
});
