import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdminSessionCookie } from '../src/server/admin_auth_v1.js';
import {
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
} from '../src/server/production_admin_auth_v1.js';
import {
  handleAdminDeviceListByMode,
} from '../src/server/device_governance_mode_dispatch_v1.js';
import {
  handleProductionAdminDeviceBlockRequest,
  handleProductionAdminDeviceListRequest,
  readProductionDeviceGovernanceConfig,
} from '../src/server/production_device_governance_http_v1.js';
import { readProductionRuntimeConfig } from '../src/server/production_runtime_config_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_640_000_000;
const ORIGIN = 'https://admin.example.invalid';
const value = name => `${name}-${'q'.repeat(40)}`;

function env(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '0',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '1',
    CLOUD_ADMIN_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_BOOTSTRAP_ENABLED: '0',
    CLOUD_PRODUCTION_BOOTSTRAP_CONFIRMATION: '',
    CLOUD_PRODUCTION_EXTERNAL_CLUB_ID: 'see',
    CLOUD_PRODUCTION_EXTERNAL_LIBRARY_ID: 'see_cz',
    CLOUD_PRODUCTION_GROUP_ID: 'group_see',
    CLOUD_PRODUCTION_LIBRARY_ID: 'lib_see_cz',
    CLOUD_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-production-v1',
    CLOUD_ADMIN_PRODUCTION_BLOB_STORE_NAME: 'cloud-collab-admin-production-v1',
    CLOUD_PRODUCTION_PUBLIC_ORIGIN: 'https://app.example.invalid',
    CLOUD_ADMIN_PUBLIC_ORIGIN: ORIGIN,
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: value('password'),
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: value('client'),
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: value('public-rate'),
    CLOUD_ADMIN_SESSION_SECRET: value('session'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: value('admin-rate'),
    CLOUD_ADMIN_DEVICE_REF_SALT: value('device-ref'),
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
    ...overrides,
  };
}

function cookie(runtimeEnv = env()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const token = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 13),
  }).token;
  return createAdminSessionCookie(token).split(';')[0];
}

function request(pathName, { method = 'GET', body, origin = ORIGIN, runtimeEnv = env() } = {}) {
  return new Request(`${ORIGIN}${pathName}`, {
    method,
    headers: {
      Cookie: cookie(runtimeEnv),
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      'Sec-Fetch-Site': origin === ORIGIN ? 'same-origin' : 'cross-site',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('new device governance flag is backward compatible but explicit in the template', () => {
  const without = { ...env() };
  delete without.CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED;
  assert.equal(readProductionRuntimeConfig(without).flags.deviceGovernance, false);
  assert.equal(readProductionRuntimeConfig(env()).flags.deviceGovernance, true);
  assert.throws(
    () => readProductionRuntimeConfig(env({ CLOUD_ADMIN_PRODUCTION_ENABLED: '0', CLOUD_ADMIN_PASSWORD: '', CLOUD_ADMIN_SESSION_SECRET: '', CLOUD_ADMIN_RATE_LIMIT_SALT: '' })),
    error => error.code === 'PRODUCTION_ROLLOUT_ORDER_INVALID',
  );
  const template = fs.readFileSync(path.join(root, 'config/production.env.template'), 'utf8');
  assert.match(template, /^CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED=0$/mu);
});

test('production governance config uses public production store and independent ref salt', () => {
  const config = readProductionDeviceGovernanceConfig(env());
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.equal(config.deviceRefSalt, value('device-ref'));
  assert.equal(config.syntheticFixtureOnly, false);
  assert.equal(config.stablePromotionAuthorized, false);
});

test('device list accepts production session and exposes only irreversible refs', async () => {
  let storeName = null;
  const deviceRef = `devref_v1_${'A'.repeat(43)}`;
  const response = await handleProductionAdminDeviceListRequest({
    env: env(),
    request: request('/api/admin/devices'),
  }, {
    now: () => NOW + 1,
    createStore: name => { storeName = name; return {}; },
    listDevices: async () => ({
      schemaVersion: 1,
      count: 1,
      devices: [{ deviceRef, displayName: '设备 · ABCD', trusted: false, blocked: false }],
      capabilities: {},
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(storeName, 'cloud-collab-production-v1');
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.data.viewer.username, 'xiaxue');
  assert.equal(body.data.result.devices[0].deviceRef, deviceRef);
  assert.equal(body.data.capabilities.productionAdmin, true);
  assert.equal(body.data.capabilities.publicMutationAllowed, false);
  assert.equal(body.data.realSecretValuesExposed, false);
  assert.equal(/dev_[0-9A-HJKMNP-TV-Z]{26}/u.test(text), false);
  assert.equal(text.includes('tokenHash'), false);
});

test('block action forwards production identity and explicit immutable command', async () => {
  const deviceRef = `devref_v1_${'B'.repeat(43)}`;
  const input = {
    schemaVersion: 1,
    deviceRef,
    requestId: `dgrq_v1_${'C'.repeat(22)}`,
    reasonCode: 'manual_safety',
  };
  let captured = null;
  const response = await handleProductionAdminDeviceBlockRequest({
    env: env(),
    request: request('/api/admin/devices/block', { method: 'POST', body: input }),
  }, {
    now: () => NOW + 2,
    createStore: name => ({ name }),
    mutateDevice: async value => {
      captured = value;
      return { schemaVersion: 1, deviceRef, action: 'block', trusted: false, blocked: true, governanceVersion: 1, duplicate: false };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.store.name, 'cloud-collab-production-v1');
  assert.equal(captured.identity.username, 'xiaxue');
  assert.deepEqual(captured.command, { action: 'block', input });
  assert.equal((await response.json()).data.result.blocked, true);
});

test('cross-origin mutation is blocked before parsing and store creation', async () => {
  let stores = 0;
  const response = await handleProductionAdminDeviceBlockRequest({
    env: env(),
    request: request('/api/admin/devices/block', {
      method: 'POST', body: {}, origin: 'https://other.example.invalid',
    }),
  }, { createStore: () => { stores += 1; return {}; } });
  assert.equal(response.status, 403);
  assert.equal(stores, 0);
});

test('production mode never falls back to preview when governance is disabled', async () => {
  const closed = env({ CLOUD_PRODUCTION_DEVICE_GOVERNANCE_ENABLED: '0', CLOUD_ADMIN_DEVICE_REF_SALT: '' });
  let stores = 0;
  const response = await handleAdminDeviceListByMode({
    env: {
      ...closed,
      CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
      CLOUD_ADMIN_DEVICE_REF_SALT: value('preview-ref'),
    },
    request: new Request(`${ORIGIN}/api/admin/devices`, { method: 'GET' }),
  }, { createStore: () => { stores += 1; return {}; } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_DEVICE_GOVERNANCE_DISABLED');
  assert.equal(stores, 0);
});

test('six cloud functions only depend on the mode dispatcher', () => {
  for (const [relative, handler] of [
    ['cloud-functions/api/admin/devices.js', 'handleAdminDeviceListByMode'],
    ['cloud-functions/api/admin/devices/detail.js', 'handleAdminDeviceDetailByMode'],
    ['cloud-functions/api/admin/devices/trust.js', 'handleAdminDeviceTrustByMode'],
    ['cloud-functions/api/admin/devices/revoke-trust.js', 'handleAdminDeviceRevokeTrustByMode'],
    ['cloud-functions/api/admin/devices/block.js', 'handleAdminDeviceBlockByMode'],
    ['cloud-functions/api/admin/devices/unblock.js', 'handleAdminDeviceUnblockByMode'],
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, new RegExp(handler, 'u'));
    assert.match(source, /device_governance_mode_dispatch_v1/u);
    assert.doesNotMatch(source, /from ['"][^'"]*device_governance_http_v1/u);
  }
});
