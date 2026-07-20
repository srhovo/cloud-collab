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
    page.wait_for_function(
        'window.orderCalculator && window.CloudCollabSensitiveRules && window.CloudCollabSensitiveMerge',
        timeout=10_000,
    )

    queue_result = page.evaluate("""async () => {
      const app = window.orderCalculator;
      const localLibraryId = app.priceLibraries.activeLibraryId;
      app.cloudCollabStores.coordinator.initializeIdentity({ nickname: '阶段6B浏览器设备' });
      const bound = app.cloudCollabStores.coordinator.bindLibrary({
        localLibraryId,
        groupId: 'group_fixture',
        libraryId: 'lib_receive_fixture',
        mode: 'collaborate',
        basePublicVersion: 0
      });
      if (!bound.ok) throw bound.error;

      const range = {
        rangeLabel: '青铜-白银', alias: '低段', rankType: 'star', minStar: 0, maxStar: 20,
        namedRanks: [],
        prices: {
          normal: { round: 10, hour: null },
          carry: { round: 15, hour: null },
          starGuarantee: { round: null, hour: 20 }
        },
        id: 'local-range-id', updatedAt: 123
      };
      const surcharge = {
        name: '甜蜜单', keywords: ['甜蜜单', '甜蜜'], prices: { round: 5, hour: null }, enabled: true,
        id: 'local-surcharge-id', usageCount: 999
      };
      const gift = {
        serviceType: '小心心', mode: 'fixed', unitPrice: 9.9,
        id: 'local-gift-id', usageCount: 88, lastUsed: 123
      };

      const results = [];
      results.push(await app.cloudCollabFeature.enqueueSensitiveRuleUserChange('rank_range_rule', range, localLibraryId));
      results.push(await app.cloudCollabFeature.enqueueSensitiveRuleUserChange('surcharge_rule', surcharge, localLibraryId));
      results.push(await app.cloudCollabFeature.enqueueSensitiveRuleUserChange('gift_rule', gift, localLibraryId));
      results.push(await app.cloudCollabFeature.enqueueSensitiveDeleteUserChange('exact_price', {
        serviceType: '鹅鸭杀', settleType: 'round', unitPrice: 10
      }, localLibraryId));
      results.push(await app.cloudCollabFeature.enqueueSensitiveDeleteUserChange('playable_name', { name: '删除名字' }, localLibraryId));
      results.push(await app.cloudCollabFeature.enqueueSensitiveDeleteUserChange('boss_profile', {
        name: '删除老板', paiDan: '直属A', discount: 0.96
      }, localLibraryId));

      const records = app.cloudCollabStores.queueStore.list().map(item => item.submission);
      return {
        results,
        records,
        queueText: JSON.stringify(records),
        sensitivity: {
          newBoss: app.cloudCollabFeature.isStage6BSensitiveBossChange(null, { name: 'A', paiDan: 'X', discount: 0.96 }),
          directReport: app.cloudCollabFeature.isStage6BSensitiveBossChange({ name: 'A', paiDan: 'X', discount: 0.96 }, { name: 'A', paiDan: 'Y', discount: 0.96 }),
          increase: app.cloudCollabFeature.isStage6BSensitiveBossChange({ name: 'A', paiDan: 'X', discount: 0.95 }, { name: 'A', paiDan: 'X', discount: 0.97 }),
          abnormalDrop: app.cloudCollabFeature.isStage6BSensitiveBossChange({ name: 'A', paiDan: 'X', discount: 0.98 }, { name: 'A', paiDan: 'X', discount: 0.90 }),
          ordinaryDrop: app.cloudCollabFeature.isStage6BSensitiveBossChange({ name: 'A', paiDan: 'X', discount: 0.98 }, { name: 'A', paiDan: 'X', discount: 0.96 })
        }
      };
    }""")

    assert all(item['status'] == 'queued' for item in queue_result['results']), queue_result
    assert len(queue_result['records']) == 6, queue_result
    assert {item['dataType'] for item in queue_result['records']} == {
        'rank_range_rule', 'surcharge_rule', 'gift_rule', 'exact_price', 'playable_name', 'boss_profile'
    }
    assert sum(1 for item in queue_result['records'] if item['operation'] == 'upsert') == 3
    assert sum(1 for item in queue_result['records'] if item['operation'] == 'delete') == 3
    assert all(item['groupId'] == 'group_fixture' for item in queue_result['records'])
    assert all(item['libraryId'] == 'lib_receive_fixture' for item in queue_result['records'])
    assert all(item['origin'] == 'user' for item in queue_result['records'])
    assert all(item['payload'] is None for item in queue_result['records'] if item['operation'] == 'delete')
    for forbidden in ['local-range-id', 'local-surcharge-id', 'local-gift-id', 'usageCount', 'lastUsed', 'rawChat', 'orders', 'notes']:
        assert forbidden not in queue_result['queueText'], forbidden
    assert queue_result['sensitivity'] == {
        'newBoss': False,
        'directReport': True,
        'increase': True,
        'abnormalDrop': True,
        'ordinaryDrop': False,
    }

    receive_only = page.evaluate("""async () => {
      const app = window.orderCalculator;
      const localLibraryId = app.priceLibraries.activeLibraryId;
      app.cloudCollabStores.bindingStore.setMode(localLibraryId, 'receive');
      const before = app.cloudCollabStores.queueStore.list().length;
      const result = await app.cloudCollabFeature.enqueueSensitiveRuleUserChange('gift_rule', {
        serviceType: '不应入队', mode: 'variable', unitPrice: null
      }, localLibraryId);
      return { before, after: app.cloudCollabStores.queueStore.list().length, result };
    }""")
    assert receive_only['before'] == receive_only['after'] == 6
    assert receive_only['result']['status'] == 'collaborative_binding_required'

    merge_result = page.evaluate("""async () => {
      const rules = window.CloudCollabSensitiveRules;
      const merge = window.CloudCollabSensitiveMerge;
      const common = {
        deviceId: 'dev_01JABCDEF0123456789XYZABCD',
        groupId: 'group_fixture',
        libraryId: 'lib_receive_fixture',
        origin: 'user',
        clientCreatedAt: 0
      };
      const range = await rules.buildSensitiveSubmission({
        ...common,
        submissionId: 'sub_01JABCDEF0123456789XYZABCD',
        dataType: 'rank_range_rule',
        payload: {
          rangeLabel: '云端区间', alias: '', rankType: 'star', minStar: 21, maxStar: 40,
          namedRanks: [],
          prices: {
            normal: { round: 20, hour: null },
            carry: { round: null, hour: null },
            starGuarantee: { round: null, hour: null }
          }
        }
      });
      const localGift = { id: 'gift-local', serviceType: '待删礼物', mode: 'fixed', unitPrice: 8 };
      const giftUpsert = await rules.buildSensitiveSubmission({
        ...common,
        submissionId: 'sub_01JABCDEF0123456789XYZABCE',
        dataType: 'gift_rule',
        payload: { serviceName: '待删礼物', mode: 'fixed', unitPrice: 8 }
      });
      const giftDelete = await rules.buildSensitiveSubmission({
        ...common,
        submissionId: 'sub_01JABCDEF0123456789XYZABCF',
        dataType: 'gift_rule', operation: 'delete', payload: null,
        businessKey: giftUpsert.businessKey
      });
      const records = [{
        approvedVersion: 1,
        businessKey: range.businessKey,
        contentHash: range.contentHash,
        dataType: range.dataType,
        operation: 'upsert',
        payload: range.payload
      }];
      const tombstones = [{
        approvedVersion: 2,
        businessKey: giftDelete.businessKey,
        contentHash: giftDelete.contentHash,
        dataType: giftDelete.dataType,
        operation: 'delete',
        payload: null
      }];
      const beforeQueue = window.orderCalculator.cloudCollabStores.queueStore.list().length;
      const plan = await merge.planSensitiveMerge({
        groupId: common.groupId,
        libraryId: common.libraryId,
        records,
        tombstones,
        confirmedNames: [],
        bossMemory: [],
        rangeRules: [],
        surcharges: [],
        gifts: [localGift],
        baseHashes: { [giftUpsert.businessKey]: giftUpsert.contentHash }
      });
      const applied = await merge.applySensitiveMergePlan({
        groupId: common.groupId,
        libraryId: common.libraryId,
        confirmedNames: [],
        bossMemory: [],
        rangeRules: [],
        surcharges: [],
        gifts: [localGift],
        plan,
        now: 1784550000000
      });
      return {
        counts: plan.counts,
        rangeRules: applied.rangeRules,
        gifts: applied.gifts,
        beforeQueue,
        afterQueue: window.orderCalculator.cloudCollabStores.queueStore.list().length
      };
    }""")

    assert merge_result['counts'] == {
        'upserts': 1, 'deletes': 1, 'unchanged': 0,
        'preserveLocal': 0, 'conflicts': 0
    }
    assert len(merge_result['rangeRules']) == 1
    assert merge_result['rangeRules'][0]['rangeLabel'] == '云端区间'
    assert merge_result['rangeRules'][0]['source'] == 'cloudPull'
    assert merge_result['gifts'] == []
    assert merge_result['beforeQueue'] == merge_result['afterQueue'] == 6

    page.screenshot(path=str(OUT / '阶段6B_敏感候选与墓碑浏览器回归.png'), full_page=False)
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '6B',
    'sensitiveRuleQueuePassed': True,
    'explicitDeleteQueuePassed': True,
    'strictProjectionPassed': True,
    'bossSensitivityRoutingPassed': True,
    'receiveModeBlockedUpload': True,
    'sensitiveMergePassed': True,
    'tombstoneMergePassed': True,
    'cloudPullDidNotEnqueue': True,
    'browserConsoleClean': True,
}, ensure_ascii=False))
