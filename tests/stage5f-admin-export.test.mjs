import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ADMIN_PREVIEW_STORE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  createAdminSessionToken,
  readAdminAuthConfig,
} from '../src/server/admin_auth_v1.js';
import {
  approvalIndexKey,
  publicEventKey,
} from '../src/server/auto_approval_engine_v1.js';
import {
  ADMIN_EXPORT_ALLOWED_GROUP_ID,
  ADMIN_EXPORT_ALLOWED_LIBRARY_ID,
  ADMIN_EXPORT_PREVIEW_STORE_NAME,
  buildAdminExportBundle,
} from '../src/server/admin_export_bundle_v1.js';
import {
  ADMIN_EXPORT_CONFIRMATION,
  buildAdminExportSummary,
  createAdminExportDownload,
  readAdminExportConfig,
} from '../src/server/admin_export_v1.js';
import {
  handleAdminExportDownloadRequest,
  handleAdminExportSummaryRequest,
} from '../src/server/admin_export_http_v1.js';
import { canonicalize } from '../src/server/submission_policy_v1.js';
import { crc32, createStoredZip } from '../src/server/zip_store_v1.js';

const NOW = 1_784_460_000_000;
const GROUP_ID = ADMIN_EXPORT_ALLOWED_GROUP_ID;
const LIBRARY_ID = ADMIN_EXPORT_ALLOWED_LIBRARY_ID;
const USERNAME = 'stage5f-admin@example.test';
const PASSWORD = 'stage5f-admin-password-0123456789';
const SESSION_SECRET = 'stage5f-session-secret-012345678901234';
const RATE_SALT = 'stage5f-rate-limit-salt-01234567890123';
const AUDIT_SALT = 'stage5f-export-audit-salt-0123456789012';
const PUBLIC_ORIGIN = 'https://cloud-collab-stage5f-test-dpxqrhy0935t.edgeone.cool';
const DEVICE_A = 'dev_01JABCDEF0123456789XYZABCD';
const DEVICE_B = 'dev_01JABCDEF0123456789XYZABCE';
const SUBMISSION_A = 'sub_01JABCDEF0123456789XYZABCD';
const SUBMISSION_B = 'sub_01JABCDEF0123456789XYZABCE';

const ENV = Object.freeze({
  CLOUD_ADMIN_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  CLOUD_ADMIN_USERNAME: USERNAME,
  CLOUD_ADMIN_PASSWORD: PASSWORD,
  CLOUD_ADMIN_SESSION_SECRET: SESSION_SECRET,
  CLOUD_ADMIN_RATE_LIMIT_SALT: RATE_SALT,
  CLOUD_ADMIN_BLOB_STORE_NAME: ADMIN_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED: '1',
  CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME: ADMIN_EXPORT_PREVIEW_STORE_NAME,
  CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID: GROUP_ID,
  CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID: LIBRARY_ID,
  CLOUD_ADMIN_EXPORT_AUDIT_SALT: AUDIT_SALT,
});

const IDENTITY = Object.freeze({
  username: USERNAME,
  sessionIdSuffix: '5F01',
  expiresAt: NOW + 900_000,
});

class MemoryBlobStore {
  constructor() {
    this.values = new Map();
    this.listCalls = [];
  }

  clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
  }

  async get(key) {
    return this.values.has(key) ? this.clone(this.values.get(key)) : null;
  }

  async setJSON(key, value, options = {}) {
    if (options.onlyIfNew && this.values.has(key)) {
      const error = new Error('already exists');
      error.code = 'ALREADY_EXISTS';
      throw error;
    }
    this.values.set(key, this.clone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list(options = {}) {
    this.listCalls.push(this.clone(options));
    const prefix = String(options.prefix || '');
    return {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .sort()
        .map(key => ({ key })),
    };
  }
}

function digest(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function digestHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashes(payload) {
  const businessKey = `bk_v1_${digest(canonicalize({
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    normalizedServiceName: payload.serviceName.toLowerCase(),
    settleType: payload.settleType,
    ruleType: 'exact',
    variant: 'standard',
  }))}`;
  const contentHash = `ch_v1_${digest(canonicalize({
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    payload,
  }))}`;
  return { businessKey, contentHash };
}

async function putEvent(store, {
  version,
  payload,
  baseline,
  label,
  deviceIds,
  submissionIds,
  mode = 'admin_approved',
} = {}) {
  const { businessKey, contentHash } = hashes(payload);
  const approvalId = `ap_v1_${digest(label)}`;
  const eventKey = publicEventKey(LIBRARY_ID, version);
  const approvedAt = NOW + version * 1000;
  const event = {
    schemaVersion: 1,
    version,
    eventKey,
    approvalId,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    approvedAt: new Date(approvedAt).toISOString(),
    businessKey,
    contentHash,
    dataType: 'exact_price',
    operation: 'upsert',
    payload,
    baseline,
    approval: { mode, deviceIds, submissionIds },
  };
  await store.setJSON(eventKey, event);
  await store.setJSON(approvalIndexKey(LIBRARY_ID, approvalId), {
    schemaVersion: 1,
    approvalId,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    businessKey,
    contentHash,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    version,
    eventKey,
    createdAt: approvedAt,
  });
  return event;
}

async function seedRollbackChain(store) {
  const first = await putEvent(store, {
    version: 1,
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 100 },
    baseline: { approvedVersion: 0, contentHash: null, unitPrice: null },
    label: 'export-first',
    deviceIds: [DEVICE_A],
    submissionIds: [SUBMISSION_A],
  });
  const second = await putEvent(store, {
    version: 2,
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 120 },
    baseline: { approvedVersion: 1, contentHash: first.contentHash, unitPrice: 100 },
    label: 'export-second',
    deviceIds: [DEVICE_B],
    submissionIds: [SUBMISSION_B],
  });
  const third = await putEvent(store, {
    version: 3,
    payload: { serviceName: '鹅鸭杀', settleType: 'round', unitPrice: 100 },
    baseline: { approvedVersion: 2, contentHash: second.contentHash, unitPrice: 120 },
    label: 'export-rollback',
    deviceIds: [DEVICE_A],
    submissionIds: [SUBMISSION_A],
    mode: 'admin_edit_and_approved',
  });
  const auditId = `rbau_v1_${digest('export-rollback-audit')}`;
  await store.setJSON(`audit/2026/07/${auditId}.json`, {
    schemaVersion: 1,
    auditId,
    rollbackId: `rb_v1_${digest('export-rollback-id')}`,
    action: 'admin_rollback',
    actorTag: `admin_${digest(USERNAME).slice(0, 12)}`,
    occurredAt: NOW + 3000,
    groupId: GROUP_ID,
    libraryId: LIBRARY_ID,
    businessKey: third.businessKey,
    sourceVersion: 2,
    sourceContentHash: second.contentHash,
    restoreVersion: 1,
    restoreContentHash: first.contentHash,
    publicVersion: 3,
    eventVersion: 3,
    approvalId: third.approvalId,
  });
  return { first, second, third };
}

function parseStoredZip(bytes) {
  const buffer = Buffer.from(bytes);
  const files = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(flags & 0x0800, 0x0800);
    assert.equal(method, 0);
    assert.equal(compressedSize, uncompressedSize);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    assert.equal(crc32(data), expectedCrc);
    files.set(name, Buffer.from(data));
    offset = dataStart + compressedSize;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return files;
}

function command(label = 'DOWNLOAD') {
  return {
    schemaVersion: 1,
    requestId: `exrq_v1_${label.padEnd(22, 'A')}`,
    confirmation: ADMIN_EXPORT_CONFIRMATION,
  };
}

function sessionCookie() {
  const config = readAdminAuthConfig(ENV);
  const token = createAdminSessionToken({
    config,
    now: NOW,
    randomBytes: () => Buffer.alloc(16, 9),
  }).token;
  return `${ADMIN_SESSION_COOKIE_NAME}=${token}`;
}

function adminRequest(path, { method = 'GET', body = null, origin = PUBLIC_ORIGIN, cookie = '' } = {}) {
  const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin' });
  if (origin) headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  if (body !== null) headers.set('Content-Type', 'application/json');
  return new Request(`http://edgeone-cloud-function.internal${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
}

test('Stage5F defaults closed, hard-locks fixture scope, and requires audit salt', () => {
  assert.throws(() => readAdminExportConfig({}), error => error.code === 'ADMIN_EXPORT_PREVIEW_DISABLED');
  assert.throws(
    () => readAdminExportConfig({ ...ENV, CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME: 'formal-public' }),
    error => error.code === 'ADMIN_EXPORT_SCOPE_INVALID',
  );
  assert.throws(
    () => readAdminExportConfig({ ...ENV, CLOUD_ADMIN_EXPORT_AUDIT_SALT: 'short' }),
    error => error.code === 'ADMIN_EXPORT_AUDIT_SALT_INVALID',
  );
  assert.equal(readAdminExportConfig(ENV).storeName, ADMIN_EXPORT_PREVIEW_STORE_NAME);
});

test('Stage5F builds a portable ZIP with stable hashes and no private identities', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminExportConfig(ENV);
  await seedRollbackChain(store);
  const bundle = await buildAdminExportBundle({ store, config, now: NOW + 5000 });
  assert.equal(bundle.publicVersion, 3);
  assert.equal(bundle.eventCount, 3);
  assert.equal(bundle.recordCount, 1);
  assert.equal(bundle.rollbackCount, 1);
  assert.equal(bundle.contentType, 'application/zip');
  assert.equal(bundle.bytes.readUInt32LE(0), 0x04034b50);

  const files = parseStoredZip(bundle.bytes);
  const expected = [
    '码单器公共数据库导出/manifest.json',
    '码单器公共数据库导出/schema.json',
    '码单器公共数据库导出/groups.json',
    `码单器公共数据库导出/libraries/${LIBRARY_ID}.json`,
    '码单器公共数据库导出/bosses/index.json',
    '码单器公共数据库导出/playable-names/index.json',
    '码单器公共数据库导出/rules/index.json',
    '码单器公共数据库导出/audit/public-events.json',
    '码单器公共数据库导出/audit/rollbacks.json',
  ];
  assert.deepEqual([...files.keys()].sort(), expected.sort());
  const manifest = JSON.parse(files.get('码单器公共数据库导出/manifest.json').toString('utf8'));
  assert.equal(manifest.packageId, bundle.packageId);
  assert.equal(manifest.publicVersion, 3);
  assert.equal(manifest.files.length, 8);
  for (const descriptor of manifest.files) {
    const data = files.get(`码单器公共数据库导出/${descriptor.name}`);
    assert.ok(data, descriptor.name);
    assert.equal(data.length, descriptor.byteLength);
    assert.equal(digestHex(data), descriptor.sha256);
  }
  const library = JSON.parse(files.get(`码单器公共数据库导出/libraries/${LIBRARY_ID}.json`).toString('utf8'));
  assert.equal(library.records[0].payload.unitPrice, 100);
  const serialized = bundle.bytes.toString('utf8');
  for (const forbidden of [DEVICE_A, DEVICE_B, SUBMISSION_A, SUBMISSION_B, 'tokenHash', 'approvalId', 'eventKey', 'actorTag', 'rollbackId']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(store.listCalls.every(item => item.consistency === 'strong'), true);
});

test('Stage5F download is byte-stable and audit-idempotent for the same request', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminExportConfig(ENV);
  await seedRollbackChain(store);
  const input = command('SAME');
  const first = await createAdminExportDownload({ store, config, identity: IDENTITY, command: input, now: NOW + 5000 });
  const second = await createAdminExportDownload({ store, config, identity: IDENTITY, command: input, now: NOW + 9000 });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.packageId, second.packageId);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`exports/${LIBRARY_ID}/requests/`)).length, 1);
  assert.equal([...store.values.keys()].filter(key => key.startsWith(`exports/${LIBRARY_ID}/decisions/`)).length, 1);
  assert.equal([...store.values.values()].filter(value => value?.action === 'admin_export').length, 1);

  await assert.rejects(
    () => createAdminExportDownload({
      store,
      config,
      identity: { ...IDENTITY, username: 'another-admin@example.test' },
      command: input,
      now: NOW + 10_000,
    }),
    error => error.code === 'ADMIN_EXPORT_REQUEST_CONFLICT' && error.status === 409,
  );
});

test('Stage5F fails closed on a rollback audit that does not match the public event', async () => {
  const store = new MemoryBlobStore();
  const config = readAdminExportConfig(ENV);
  await seedRollbackChain(store);
  const auditKey = [...store.values.keys()].find(key => key.startsWith('audit/'));
  const audit = await store.get(auditKey);
  audit.restoreContentHash = `ch_v1_${'A'.repeat(43)}`;
  await store.setJSON(auditKey, audit);
  await assert.rejects(
    () => buildAdminExportSummary({ store, config, now: NOW + 5000 }),
    error => error.code === 'ADMIN_EXPORT_ROLLBACK_EVENT_MISMATCH',
  );
});

test('Stage5F ZIP writer enforces the configured byte limit', () => {
  assert.throws(
    () => createStoredZip([{ name: 'a.txt', data: Buffer.alloc(100) }], { createdAt: NOW, maxBytes: 32 }),
    error => error.code === 'ZIP_SIZE_LIMIT_EXCEEDED' && error.status === 413,
  );
});

test('Stage5F HTTP reuses admin session and accepts EdgeOne internal HTTP only for same-project origin', async () => {
  const store = new MemoryBlobStore();
  await seedRollbackChain(store);
  const cookie = sessionCookie();
  const createStore = () => store;

  const summaryResponse = await handleAdminExportSummaryRequest(
    { request: adminRequest('/api/admin/exports/summary', { cookie, origin: '' }), env: ENV },
    { createStore, now: () => NOW + 5000 },
  );
  assert.equal(summaryResponse.status, 200);
  const summaryPayload = await summaryResponse.json();
  assert.equal(summaryPayload.data.result.publicVersion, 3);
  assert.equal(JSON.stringify(summaryPayload).includes('deviceId'), false);

  const downloadResponse = await handleAdminExportDownloadRequest(
    {
      request: adminRequest('/api/admin/exports/download', {
        method: 'POST',
        body: command('HTTP'),
        cookie,
      }),
      env: ENV,
    },
    { createStore, now: () => NOW + 6000 },
  );
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get('content-type'), 'application/zip');
  assert.equal(downloadResponse.headers.get('x-mdq-public-version'), '3');
  assert.match(downloadResponse.headers.get('content-disposition'), /attachment/);
  const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
  assert.equal(downloaded.readUInt32LE(0), 0x04034b50);

  const crossProject = await handleAdminExportDownloadRequest(
    {
      request: adminRequest('/api/admin/exports/download', {
        method: 'POST',
        body: command('EVIL'),
        cookie,
        origin: 'https://evil-project-aaaaaaaaaaaa.edgeone.cool',
      }),
      env: ENV,
    },
    { createStore, now: () => NOW + 7000 },
  );
  assert.equal(crossProject.status, 403);
  assert.equal((await crossProject.json()).error.code, 'ADMIN_REQUEST_ORIGIN_INVALID');
});
