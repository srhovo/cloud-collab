from pathlib import Path
import json

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'dist' / 'index.html').read_text(encoding='utf-8')
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)

LOCAL_STORAGE_POLYFILL = """
Object.defineProperty(window, 'localStorage', {
  value: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
    clear() { this._d = {}; },
    get length() { return Object.keys(this._d).length; },
    key(i) { return Object.keys(this._d)[i] ?? null; }
  },
  configurable: true
});
"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path='/usr/bin/chromium',
        args=['--no-sandbox'],
    )
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.goto('about:blank')
    page.evaluate(LOCAL_STORAGE_POLYFILL)
    page.set_content(HTML, wait_until='domcontentloaded', timeout=20_000)
    page.wait_for_function('window.orderCalculator && window.CloudCollabOrdinaryTypes', timeout=10_000)

    queue_result = page.evaluate("""async () => {
      const app = window.orderCalculator;
      const localLibraryId = app.priceLibraries.activeLibraryId;
      app.cloudCollabStores.coordinator.initializeIdentity({ nickname: '阶段5G浏览器设备' });
      const bound = app.cloudCollabStores.coordinator.bindLibrary({
        localLibraryId,
        groupId: 'group_fixture',
        libraryId: 'lib_receive_fixture',
        mode: 'collaborate',
        basePublicVersion: 0
      });
      if (!bound.ok) throw bound.error;

      const playable = await app.cloudCollabFeature.enqueuePlayableNameUserChange(' Alice ', localLibraryId);
      const boss = await app.cloudCollabFeature.enqueueBossProfileUserChange({
        name: '老板甲',
        paiDan: '直属A',
        discount: 0.97,
        usageCount: 999,
        lastUsed: 123
      }, localLibraryId);
      const records = app.cloudCollabStores.queueStore.list().map(item => item.submission);
      const queueText = JSON.stringify(records);
      return {
        playable,
        boss,
        localLibraryId,
        records,
        queueText,
        binding: app.cloudCollabStores.bindingStore.getByLocalLibraryId(localLibraryId)
      };
    }""")

    assert queue_result['playable']['status'] == 'queued', queue_result
    assert queue_result['boss']['status'] == 'queued', queue_result
    assert len(queue_result['records']) == 2, queue_result
    assert queue_result['binding']['mode'] == 'collaborate'
    assert {row['dataType'] for row in queue_result['records']} == {'playable_name', 'boss_profile'}
    assert all(row['libraryId'] == 'lib_receive_fixture' for row in queue_result['records'])
    assert all(row['groupId'] == 'group_fixture' for row in queue_result['records'])
    assert all(row['origin'] == 'user' for row in queue_result['records'])
    assert all(row['operation'] == 'upsert' for row in queue_result['records'])
    boss_submission = next(row for row in queue_result['records'] if row['dataType'] == 'boss_profile')
    assert boss_submission['bossId'].startswith('boss_v1_')
    assert len(boss_submission['bossId']) == len('boss_v1_') + 43
    assert boss_submission['payload'] == {'bossName': '老板甲', 'paiDan': '直属A', 'discount': 0.97}
    playable_submission = next(row for row in queue_result['records'] if row['dataType'] == 'playable_name')
    assert playable_submission['payload'] == {'name': 'Alice'}
    for forbidden in ['usageCount', 'lastUsed', 'rawChat', 'orders', 'note', 'history']:
        assert forbidden not in queue_result['queueText'], forbidden

    receive_only = page.evaluate("""async () => {
      const app = window.orderCalculator;
      const localLibraryId = app.priceLibraries.activeLibraryId;
      app.cloudCollabStores.bindingStore.setMode(localLibraryId, 'receive');
      const before = app.cloudCollabStores.queueStore.list().length;
      const result = await app.cloudCollabFeature.enqueuePlayableNameUserChange('不应入队', localLibraryId);
      const after = app.cloudCollabStores.queueStore.list().length;
      return { before, after, result };
    }""")
    assert receive_only['before'] == receive_only['after'] == 2
    assert receive_only['result']['status'] == 'collaborative_binding_required'

    merge_result = page.evaluate("""async () => {
      const api = window.CloudCollabOrdinaryTypes;
      const deviceId = 'dev_01JABCDEF0123456789XYZABCD';
      const playable = await api.buildOrdinarySubmission({
        deviceId,
        submissionId: 'sub_01JABCDEF0123456789XYZABCD',
        groupId: 'group_fixture',
        libraryId: 'lib_receive_fixture',
        dataType: 'playable_name',
        payload: { name: '云端名字' },
        origin: 'initialBinding',
        clientCreatedAt: 0
      });
      const boss = await api.buildOrdinarySubmission({
        deviceId,
        submissionId: 'sub_01JABCDEF0123456789XYZABCE',
        groupId: 'group_fixture',
        libraryId: 'lib_receive_fixture',
        dataType: 'boss_profile',
        payload: { bossName: '云端老板', paiDan: '直属云', discount: 0.96 },
        origin: 'initialBinding',
        clientCreatedAt: 0
      });
      const records = [playable, boss].map((item, index) => ({
        approvedVersion: index + 1,
        businessKey: item.businessKey,
        contentHash: item.contentHash,
        dataType: item.dataType,
        operation: item.operation,
        payload: item.payload
      }));
      const beforeQueue = window.orderCalculator.cloudCollabStores.queueStore.list().length;
      const plan = await api.planOrdinaryMerge({
        groupId: 'group_fixture',
        libraryId: 'lib_receive_fixture',
        records,
        confirmedNames: [],
        bossMemory: [],
        baseHashes: {}
      });
      const applied = api.applyOrdinaryMergePlan({
        confirmedNames: [],
        bossMemory: [],
        plan,
        now: 1784550000000
      });
      const afterQueue = window.orderCalculator.cloudCollabStores.queueStore.list().length;
      let tombstoneCode = null;
      try {
        window.orderCalculator.cloudCollabFeature.splitStage5GPublicSnapshot({
          schemaVersion: 1,
          payloadSchemaVersion: 1,
          groupId: 'group_fixture',
          libraryId: 'lib_receive_fixture',
          publicVersion: 2,
          snapshotVersion: 2,
          cursor: 'pv_2',
          generatedAt: '2026-07-20T00:00:00.000Z',
          records: [],
          tombstones: [{
            approvedVersion: 2,
            businessKey: playable.businessKey,
            contentHash: playable.contentHash,
            dataType: 'playable_name',
            operation: 'delete'
          }]
        });
      } catch (error) {
        tombstoneCode = error?.code || null;
      }
      return {
        counts: plan.counts,
        confirmedNames: applied.confirmedNames,
        bossMemory: applied.bossMemory,
        beforeQueue,
        afterQueue,
        tombstoneCode
      };
    }""")

    assert merge_result['counts'] == {'upserts': 2, 'unchanged': 0, 'preserveLocal': 0, 'conflicts': 0}
    assert merge_result['confirmedNames'] == [{
        'name': '云端名字',
        'original': '云端名字',
        'timestamp': 1_784_550_000_000,
        'source': 'cloudPull',
    }]
    assert merge_result['bossMemory'] == [{'name': '云端老板', 'paiDan': '直属云', 'discount': 0.96}]
    assert merge_result['beforeQueue'] == merge_result['afterQueue'] == 2
    assert merge_result['tombstoneCode'] == 'ORDINARY_DELETE_REQUIRES_STAGE6'

    invalid_result = page.evaluate("""async () => {
      const app = window.orderCalculator;
      app.cloudCollabStores.bindingStore.setMode(app.priceLibraries.activeLibraryId, 'collaborate');
      const before = app.cloudCollabStores.queueStore.list().length;
      let code = null;
      try {
        await app.cloudCollabFeature.enqueueBossProfileUserChange({
          name: '老板联系方式 wx123456',
          paiDan: '直属A',
          discount: 0.97
        }, app.priceLibraries.activeLibraryId);
      } catch (error) {
        code = error?.code || null;
      }
      return { before, after: app.cloudCollabStores.queueStore.list().length, code };
    }""")
    assert invalid_result['before'] == invalid_result['after'] == 2
    assert invalid_result['code'] == 'ORDINARY_CONTACT_INFO_FORBIDDEN'

    page.screenshot(path=str(OUT / '阶段5G_普通名字老板候选浏览器回归.png'), full_page=False)
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5G',
    'ordinaryUserQueuePassed': True,
    'bossV1IdentityQueuePassed': True,
    'fixtureLibraryScopePassed': True,
    'receiveModeBlockedUpload': True,
    'strictProjectionPassed': True,
    'cloudPullDidNotEnqueue': True,
    'ordinaryDeleteDeferredToStage6': True,
    'browserConsoleClean': True,
}, ensure_ascii=False))
