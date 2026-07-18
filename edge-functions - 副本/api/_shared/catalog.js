const EMPTY_COUNTS = Object.freeze({
  exactPrice: 0,
  rankRangeRule: 0,
  surchargeRule: 0,
  giftRule: 0,
  playableName: 0,
  bossProfile: 0,
});

// 阶段3A仅提供空测试库身份，不包含任何真实用户或价格数据。
const CATALOG = Object.freeze({
  'group_xiacijian/lib_xiacijian_regular': Object.freeze({
    groupId: 'group_xiacijian',
    libraryId: 'lib_xiacijian_regular',
    publicVersion: 0,
    snapshotVersion: 0,
    updatedAt: null,
    status: 'empty_test_library',
    snapshotAvailable: false,
    recordCounts: EMPTY_COUNTS,
  }),
});

export function findPublicLibrary(groupId, libraryId) {
  return CATALOG[`${groupId}/${libraryId}`] || null;
}

export function listPublicLibraries() {
  return Object.values(CATALOG).map(item => ({ ...item, recordCounts: { ...item.recordCounts } }));
}
