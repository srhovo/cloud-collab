const EMPTY_COUNTS = Object.freeze({
  exactPrice: 0,
  rankRangeRule: 0,
  surchargeRule: 0,
  giftRule: 0,
  playableName: 0,
  bossProfile: 0,
});

const FIXTURE_EVENTS = Object.freeze([
  Object.freeze({
    version: 1,
    approvedAt: '2026-07-18T00:00:01.000Z',
    businessKey: 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ',
    contentHash: 'ch_v1_fmOBmfqgyeg_JeMum9_V3xFSi9hzH_KUTdd8wGvnEls',
    dataType: 'exact_price',
    operation: 'upsert',
    payload: Object.freeze({ serviceName: '测试服务A', settleType: 'round', unitPrice: 100 }),
  }),
  Object.freeze({
    version: 2,
    approvedAt: '2026-07-18T00:00:02.000Z',
    businessKey: 'bk_v1_8NzIT8ASEfznmy1AXMAc2MFMpbMYf4hX3tor4g29P-k',
    contentHash: 'ch_v1_UeNOLpbqibRH7Yv9fojizF6qn-aTdRbXB3qOB8yeDXk',
    dataType: 'exact_price',
    operation: 'upsert',
    payload: Object.freeze({ serviceName: '测试服务B', settleType: 'hour', unitPrice: 80 }),
  }),
  Object.freeze({
    version: 3,
    approvedAt: '2026-07-18T00:00:03.000Z',
    businessKey: 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ',
    contentHash: 'ch_v1_8cLsoYwgKnmAXyDgNjXMkDLlD2t2JjdXyKrde_KhoqA',
    dataType: 'exact_price',
    operation: 'upsert',
    payload: Object.freeze({ serviceName: '测试服务A', settleType: 'round', unitPrice: 110 }),
  }),
]);

const FIXTURE_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  payloadSchemaVersion: 1,
  groupId: 'group_fixture',
  libraryId: 'lib_receive_fixture',
  publicVersion: 3,
  snapshotVersion: 3,
  cursor: 'pv_3',
  generatedAt: '2026-07-18T00:00:03.000Z',
  records: Object.freeze([
    Object.freeze({
      businessKey: 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ',
      contentHash: 'ch_v1_8cLsoYwgKnmAXyDgNjXMkDLlD2t2JjdXyKrde_KhoqA',
      dataType: 'exact_price',
      operation: 'upsert',
      approvedVersion: 3,
      payload: Object.freeze({ serviceName: '测试服务A', settleType: 'round', unitPrice: 110 }),
    }),
    Object.freeze({
      businessKey: 'bk_v1_8NzIT8ASEfznmy1AXMAc2MFMpbMYf4hX3tor4g29P-k',
      contentHash: 'ch_v1_UeNOLpbqibRH7Yv9fojizF6qn-aTdRbXB3qOB8yeDXk',
      dataType: 'exact_price',
      operation: 'upsert',
      approvedVersion: 2,
      payload: Object.freeze({ serviceName: '测试服务B', settleType: 'hour', unitPrice: 80 }),
    }),
  ]),
  tombstones: Object.freeze([]),
});

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
    snapshot: null,
    events: Object.freeze([]),
  }),
  // 仅供阶段3B远程验收，不会被普通用户自动绑定或写入真实价格库。
  'group_fixture/lib_receive_fixture': Object.freeze({
    groupId: 'group_fixture',
    libraryId: 'lib_receive_fixture',
    publicVersion: 3,
    snapshotVersion: 3,
    updatedAt: '2026-07-18T00:00:03.000Z',
    status: 'fixture_ready',
    fixtureOnly: true,
    snapshotAvailable: true,
    recordCounts: Object.freeze({ ...EMPTY_COUNTS, exactPrice: 2 }),
    snapshot: FIXTURE_SNAPSHOT,
    events: FIXTURE_EVENTS,
  }),
});

export function findPublicLibrary(groupId, libraryId) {
  return CATALOG[`${groupId}/${libraryId}`] || null;
}

export function listPublicLibraries() {
  return Object.values(CATALOG).map(({ snapshot, events, ...item }) => ({
    ...item,
    recordCounts: { ...item.recordCounts },
  }));
}

export function cloneSnapshot(library) {
  if (!library?.snapshot) return null;
  return JSON.parse(JSON.stringify(library.snapshot));
}

export function listChanges(library, sinceVersion, limit) {
  const events = Array.isArray(library?.events) ? library.events : [];
  const selected = events.filter(item => item.version > sinceVersion).slice(0, limit);
  const nextVersion = selected.length ? selected[selected.length - 1].version : sinceVersion;
  return {
    changes: JSON.parse(JSON.stringify(selected)),
    nextVersion,
    hasMore: events.some(item => item.version > nextVersion),
  };
}
