import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProductionScopeMappingError,
  assertProductionScopeMapping,
  buildProductionScopeMapping,
  externalClubIdToProtocolGroupId,
  externalLibraryIdToProtocolLibraryId,
  protocolGroupIdToExternalClubId,
  protocolLibraryIdToExternalLibraryId,
} from '../src/server/production_scope_mapping_v1.js';

test('see与see_cz稳定映射到既有协议前缀', () => {
  const mapping = buildProductionScopeMapping({ clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(mapping.external, { clubId: 'see', libraryId: 'see_cz' });
  assert.deepEqual(mapping.protocol, { groupId: 'group_see', libraryId: 'lib_see_cz' });
  assert.equal(mapping.legacyPrefixedIdsRemainAccepted, true);
  assert.deepEqual(assertProductionScopeMapping(mapping), mapping);
});

test('既有前缀ID不被重复添加前缀', () => {
  assert.equal(externalClubIdToProtocolGroupId('group_fixture'), 'group_fixture');
  assert.equal(externalLibraryIdToProtocolLibraryId('lib_receive_fixture'), 'lib_receive_fixture');
});

test('协议ID可投影回用户可见ID', () => {
  assert.equal(protocolGroupIdToExternalClubId('group_see'), 'see');
  assert.equal(protocolLibraryIdToExternalLibraryId('lib_see_cz'), 'see_cz');
});

test('中文、空格、连字符和过短ID失败关闭', () => {
  for (const value of ['下雪', 'see club', 'see-club', 'a']) {
    assert.throws(
      () => buildProductionScopeMapping({ clubId: value, libraryId: 'see_cz' }),
      ProductionScopeMappingError,
    );
  }
  for (const value of ['价格库', 'see cz', 'see-cz', 'x']) {
    assert.throws(
      () => buildProductionScopeMapping({ clubId: 'see', libraryId: value }),
      ProductionScopeMappingError,
    );
  }
});

test('显式错误协议映射不能通过审计', () => {
  assert.throws(() => assertProductionScopeMapping({
    schemaVersion: 1,
    external: { clubId: 'see', libraryId: 'see_cz' },
    protocol: { groupId: 'group_other', libraryId: 'lib_see_cz' },
  }), error => error instanceof ProductionScopeMappingError
    && error.code === 'PRODUCTION_SCOPE_MAPPING_MISMATCH');
});
