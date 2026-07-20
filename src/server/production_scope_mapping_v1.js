export const PRODUCTION_SCOPE_MAPPING_VERSION = 1;

const EXTERNAL_CLUB_ID_PATTERN = /^[a-z0-9][a-z0-9_]{2,47}$/;
const EXTERNAL_LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9_]{2,55}$/;
const PROTOCOL_GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const PROTOCOL_LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;

export class ProductionScopeMappingError extends Error {
  constructor(code, message, details = null) {
    super(message || code || '生产作用域映射失败');
    this.name = 'ProductionScopeMappingError';
    this.code = code || 'PRODUCTION_SCOPE_MAPPING_ERROR';
    this.details = details;
  }
}

function normalize(value, pattern, code, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!pattern.test(text)) {
    throw new ProductionScopeMappingError(code, `${label}只允许小写英文字母、数字和下划线，长度必须符合协议`);
  }
  return text;
}

export function normalizeExternalClubId(value) {
  return normalize(value, EXTERNAL_CLUB_ID_PATTERN, 'INVALID_EXTERNAL_CLUB_ID', 'club ID');
}

export function normalizeExternalLibraryId(value) {
  return normalize(value, EXTERNAL_LIBRARY_ID_PATTERN, 'INVALID_EXTERNAL_LIBRARY_ID', 'library ID');
}

export function normalizeProtocolGroupId(value) {
  return normalize(value, PROTOCOL_GROUP_ID_PATTERN, 'INVALID_PROTOCOL_GROUP_ID', '协议groupId');
}

export function normalizeProtocolLibraryId(value) {
  return normalize(value, PROTOCOL_LIBRARY_ID_PATTERN, 'INVALID_PROTOCOL_LIBRARY_ID', '协议libraryId');
}

export function externalClubIdToProtocolGroupId(value) {
  const external = normalizeExternalClubId(value);
  return normalizeProtocolGroupId(external.startsWith('group_') ? external : `group_${external}`);
}

export function externalLibraryIdToProtocolLibraryId(value) {
  const external = normalizeExternalLibraryId(value);
  return normalizeProtocolLibraryId(external.startsWith('lib_') ? external : `lib_${external}`);
}

export function protocolGroupIdToExternalClubId(value) {
  const protocol = normalizeProtocolGroupId(value);
  return normalizeExternalClubId(protocol.slice('group_'.length));
}

export function protocolLibraryIdToExternalLibraryId(value) {
  const protocol = normalizeProtocolLibraryId(value);
  return normalizeExternalLibraryId(protocol.slice('lib_'.length));
}

export function buildProductionScopeMapping({ clubId, libraryId } = {}) {
  const externalClubId = normalizeExternalClubId(clubId);
  const externalLibraryId = normalizeExternalLibraryId(libraryId);
  const groupId = externalClubIdToProtocolGroupId(externalClubId);
  const protocolLibraryId = externalLibraryIdToProtocolLibraryId(externalLibraryId);
  return Object.freeze({
    schemaVersion: PRODUCTION_SCOPE_MAPPING_VERSION,
    external: Object.freeze({ clubId: externalClubId, libraryId: externalLibraryId }),
    protocol: Object.freeze({ groupId, libraryId: protocolLibraryId }),
    legacyPrefixedIdsRemainAccepted: true,
  });
}

export function assertProductionScopeMapping(mapping) {
  if (!mapping || mapping.schemaVersion !== PRODUCTION_SCOPE_MAPPING_VERSION) {
    throw new ProductionScopeMappingError('INVALID_SCOPE_MAPPING_VERSION', '生产作用域映射版本无效');
  }
  const expected = buildProductionScopeMapping({
    clubId: mapping.external?.clubId,
    libraryId: mapping.external?.libraryId,
  });
  if (mapping.protocol?.groupId !== expected.protocol.groupId
      || mapping.protocol?.libraryId !== expected.protocol.libraryId) {
    throw new ProductionScopeMappingError('PRODUCTION_SCOPE_MAPPING_MISMATCH', '外部ID与协议ID映射不一致', {
      expected: expected.protocol,
      actual: mapping.protocol || null,
    });
  }
  return expected;
}
