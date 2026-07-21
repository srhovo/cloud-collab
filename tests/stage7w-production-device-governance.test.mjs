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
} from '../src/server/admin_device_governance_mode_dispatch_v1.js';
import {
  handleProductionAdminDeviceListRequest,
  handleProductionAdminDeviceTrustRequest,
  readProductionDeviceGovernanceConfig,
} from '../src/server/production_device_governance_http_v1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_784_640_000_000;
const ADMIN_ORIGIN = 'https://admin.example.invalid';
const DEVICE_REF = `devref_v1_${'A'.repeat(43)}`;
const REQUEST_ID = `dgrq_v1_${'B'.repeat(22)}`;
const secret = label => `${label}-${'x'.repeat(40)}`;

function productionEnv(overrides = {}) {
  return {
    CLOUD_PRODUCTION_ENABLED: '1',
    CLOUD_PRODUCTION_READ_SYNC_ENABLED: '1',
    CLOUD_PRODUCTION_ORDINARY_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_AUTO_APPROVAL_ENABLED: '0',
    CLOUD_PRODUCTION_SENSITIVE_SUBMISSION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '1',
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
    CLOUD_ADMIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
    CLOUD_ADMIN_USERNAME: 'xiaxue',
    CLOUD_ADMIN_PASSWORD: secret('password'),
    CLOUD_PRODUCTION_CLIENT_ACCESS_KEY: secret('client'),
    CLOUD_PRODUCTION_RATE_LIMIT_SALT: secret('public-rate'),
    CLOUD_ADMIN_SESSION_SECRET: secret('session'),
    CLOUD_ADMIN_RATE_LIMIT_SALT: secret('admin-rate'),
    CLOUD_ADMIN_DEVICE_REF_SALT: secret('device-ref'),
    CLOUD_ADMIN_ROLLBACK_REF_SALT: secret('rollback-ref'),
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: secret('export-audit'),
    ...overrides,
  };
}

function sessionCookie(runtimeEnv = productionEnv()) {
  const config = readProductionAdminAuthConfig(runtimeEnv);
  const token = createProductionAdminSessionToken({
    config,
    now: NOW,
    randomBytes: length => Buffer.alloc(length, 13),
  }).token;
  return createAdminSessionCookie(token).split(';')[0];
}

function request(pathname, {
  method = 'GET',
  body,
  origin = ADMIN_ORIGIN,
  runtimeEnv = productionEnv(),
} = {}) {
  return new Request(`${ADMIN_ORIGIN}${pathname}`, {
    method,
    headers: {
      Cookie: sessionCookie(runtimeEnv),
      'Sec-Fetch-Site': origin === ADMIN_ORIGIN ? 'same-origin' : 'cross-site',
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('正式设备治理配置绑定公共生产Store、正式作用域和独立引用盐值', () => {
  const config = readProductionDeviceGovernanceConfig(productionEnv());
  assert.equal(config.mode, 'production');
  assert.equal(config.storeName, 'cloud-collab-production-v1');
  assert.deepEqual(config.externalScope, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(config.protocolScope, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(config.publicOrigin, ADMIN_ORIGIN);
  assert.equal(config.syntheticFixtureOnly, false);
  assert.equal(config.stablePromotionAuthorized, false);
  assert.equal(config.deviceRefSalt, secret('device-ref'));
});

test('正式设备列表使用生产会话和公共Store，仅返回不可逆deviceRef', async () => {
  let storeName = null;
  const result = {
    schemaVersion: 1,
    count: 1,
    devices: [{
      schemaVersion: 1,
      deviceRef: DEVICE_REF,
      displayName: '下雪 · AB12',
      nicknameTag: 'AB12',
      createdAt: NOW - 1000,
      updatedAt: NOW - 500,
      issuedAt: NOW - 1000,
      expiresAt: NOW + 1000,
      lastAppVersion: '8.2.31',
      trusted: false,
      blocked: false,
      governanceVersion: 0,
      governanceUpdatedAt: null,
    }],
  };
  const response = await handleProductionAdminDeviceListRequest({
    env: productionEnv(),
    request: request('/api/admin/devices'),
  }, {
    now: () => NOW,
    createStore(name) {
      storeName = name;
      return {};
    },
    listDevices: async ({ config }) => {
      assert.equal(config.deviceRefSalt, secret('device-ref'));
      return result;
    },
  });
  assert.equal(response.status, 200);
  assert.equal(storeName, 'cloud-collab-production-v1');
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.mode, 'production');
  assert.equal(body.data.viewer.username, 'xiaxue');
  assert.equal(body.data.result.devices[0].deviceRef, DEVICE_REF);
  assert.equal(body.data.capabilities.productionAdmin, true);
  assert.equal(body.data.capabilities.syntheticFixtureOnly, false);
  assert.equal(body.data.capabilities.publicMutationAllowed, false);
  assert.equal(body.data.realSecretValuesExposed, false);
  assert.equal(body.data.stablePromotionAuthorized, false);
  assert.doesNotMatch(text, /dev_[0-9A-HJKMNP-TV-Z]{26}/u);
  assert.equal(text.includes(secret('device-ref')), false);
});

test('正式设为可信传递显式动作、生产身份、公共Store和真实协议正文', async () => {
  let captured = null;
  const input = {
    schemaVersion: 1,
    deviceRef: DEVICE_REF,
    requestId: REQUEST_ID,
    reasonCode: 'verified_operator',
  };
  const response = await handleProductionAdminDeviceTrustRequest({
    env: productionEnv(),
    request: request('/api/admin/devices/trust', { method: 'POST', body: input }),
  }, {
    now: () => NOW + 1,
    createStore: name => ({ name }),
    mutateDevice: async value => {
      captured = value;
      return {
        schemaVersion: 1,
        deviceRef: DEVICE_REF,
        action: 'trust',
        reasonCode: 'verified_operator',
        trusted: true,
        blocked: false,
        governanceVersion: 1,
        governanceUpdatedAt: NOW + 1,
        duplicate: false,
      };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.store.name, 'cloud-collab-production-v1');
  assert.equal(captured.identity.username, 'xiaxue');
  assert.equal(captured.command.action, 'trust');
  assert.deepEqual(captured.command.input, input);
  assert.equal(captured.config.protocolScope.groupId, 'group_see');
  const body = await response.json();
  assert.equal(body.data.result.trusted, true);
  assert.equal(body.data.capabilities.publicMutationAllowed, false);
});

test('跨站设备治理写入在正文解析和Store创建前阻断', async () => {
  let storeCreates = 0;
  const response = await handleProductionAdminDeviceTrustRequest({
    env: productionEnv(),
    request: request('/api/admin/devices/trust', {
      method: 'POST',
      body: { broken: true },
      origin: 'https://attacker.example.invalid',
    }),
  }, {
    createStore: () => {
      storeCreates += 1;
      return {};
    },
  });
  assert.equal(response.status, 403);
  assert.equal(storeCreates, 0);
});

test('生产总开关开启时管理员子开关关闭不得回退阶段5D预览治理', async () => {
  const closed = productionEnv({
    CLOUD_ADMIN_PRODUCTION_ENABLED: '0',
    CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED: '0',
    CLOUD_ADMIN_PASSWORD: '',
    CLOUD_ADMIN_SESSION_SECRET: '',
    CLOUD_ADMIN_RATE_LIMIT_SALT: '',
    CLOUD_ADMIN_DEVICE_REF_SALT: '',
    CLOUD_ADMIN_ROLLBACK_REF_SALT: '',
    CLOUD_ADMIN_EXPORT_AUDIT_SALT: '',
  });
  let storeCreates = 0;
  const response = await handleAdminDeviceListByMode({
    env: {
      ...closed,
      CLOUD_ADMIN_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED: '1',
      CLOUD_ADMIN_BLOB_STORE_NAME: 'cloud-collab-admin-preview-v1',
      CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME: 'cloud-collab-preview-v1',
      CLOUD_ADMIN_PUBLIC_ORIGIN: ADMIN_ORIGIN,
    },
    request: new Request(`${ADMIN_ORIGIN}/api/admin/devices`, { method: 'GET' }),
  }, {
    createStore: () => {
      storeCreates += 1;
      return {};
    },
    listDevices: async () => assert.fail('生产模式不得调用预览设备列表'),
  });
  assert.equal(response.status, 503);
  assert.equal(storeCreates, 0);
});

test('非法生产总开关在进入任何设备治理处理器前失败关闭', async () => {
  let stores = 0;
  const response = await handleAdminDeviceListByMode({
    env: { CLOUD_PRODUCTION_ENABLED: 'invalid' },
    request: new Request(`${ADMIN_ORIGIN}/api/admin/devices`, { method: 'GET' }),
  }, {
    createStore: () => {
      stores += 1;
      return {};
    },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PRODUCTION_FLAG_INVALID');
  assert.equal(stores, 0);
});

test('六个Cloud Function入口只依赖设备治理模式分发器', () => {
  for (const [relative, handler] of [
    ['cloud-functions/api/admin/devices.js', 'handleAdminDeviceListRequest'],
    ['cloud-functions/api/admin/devices/detail.js', 'handleAdminDeviceDetailRequest'],
    ['cloud-functions/api/admin/devices/trust.js', 'handleAdminDeviceTrustRequest'],
    ['cloud-functions/api/admin/devices/revoke-trust.js', 'handleAdminDeviceRevokeTrustRequest'],
    ['cloud-functions/api/admin/devices/block.js', 'handleAdminDeviceBlockRequest'],
    ['cloud-functions/api/admin/devices/unblock.js', 'handleAdminDeviceUnblockRequest'],
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /admin_device_governance_mode_dispatch_v1/u);
    assert.match(source, new RegExp(handler, 'u'));
    assert.doesNotMatch(source, /from ['"][^'"]*device_governance_http_v1/u);
  }
});

test('正式设备治理静态边界使用production issuer、总开关分发和脱敏投影', () => {
  const http = fs.readFileSync(path.join(root, 'src/server/production_device_governance_http_v1.js'), 'utf8');
  const dispatch = fs.readFileSync(path.join(root, 'src/server/admin_device_governance_mode_dispatch_v1.js'), 'utf8');
  assert.match(http, /verifyProductionAdminSessionToken/u);
  assert.match(http, /readProductionAdminAuthConfig/u);
  assert.match(http, /runtime\.publicStoreName/u);
  assert.match(http, /CLOUD_ADMIN_DEVICE_REF_SALT/u);
  assert.match(http, /stablePromotionAuthorized:\s*false/u);
  assert.doesNotMatch(http, /readAdminAuthConfig|verifyAdminSessionToken/u);
  assert.doesNotMatch(http, /Access-Control-Allow-Origin/u);
  assert.match(dispatch, /resolveAdminAuthMode/u);
  assert.doesNotMatch(dispatch, /CLOUD_ADMIN_PRODUCTION_ENABLED|CLOUD_PRODUCTION_ADMIN_REVIEW_ENABLED/u);
});
