from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'stage5g6a6b-acceptance.html').read_text(encoding='utf-8')
ORIGIN = 'https://stage5g6a6b-acceptance.test'
ACCEPTANCE_KEY = 'stage5g6a6b-browser-acceptance-key-0123456789'
PREVIEW_KEY = 'stage5g6a6b-browser-preview-key-0123456789012'
requests = []
state = {'ordinary': 0, 'sensitive': 0, 'delete': 0}

DEVICES = [
    {
        'slot': 'A',
        'deviceId': 'dev_01JSTAGE5G6A6B000000000001',
        'deviceToken': 'dt_v1_' + ('A' * 43),
        'tokenVersion': 1,
        'expiresAt': 1_793_000_000_000,
    },
    {
        'slot': 'B',
        'deviceId': 'dev_01JSTAGE5G6A6B000000000002',
        'deviceToken': 'dt_v1_' + ('B' * 43),
        'tokenVersion': 1,
        'expiresAt': 1_793_000_000_000,
    },
]

SURCHARGE_RECORD = {
    'businessKey': 'bk_v1_' + ('C' * 43),
    'contentHash': 'ch_v1_' + ('D' * 43),
    'dataType': 'surcharge_rule',
    'operation': 'upsert',
    'approvedVersion': 2,
    'payload': {
        'name': '联合验收教学',
        'keywords': ['教学', '教学单'],
        'prices': {'round': 6, 'hour': 20},
        'enabled': True,
    },
}


def envelope(data):
    return {
        'ok': True,
        'serviceId': 'stage5g6a6b-browser-mock',
        'apiVersion': 'test-v1',
        'data': data,
    }


def fulfill(route, data, status=200):
    route.fulfill(status=status, content_type='application/json; charset=utf-8', body=json.dumps(envelope(data), ensure_ascii=False))


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.post_data else None
    requests.append({
        'method': request.method,
        'path': parsed.path,
        'query': parsed.query,
        'body': body,
        'acceptance': request.headers.get('x-cloud-stage5g6a6b-acceptance-key'),
        'preview': request.headers.get('x-cloud-collab-preview-key'),
    })

    if parsed.path == '/stage5g6a6b-acceptance.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return

    assert 'eo_token=test-token' in parsed.query
    assert 'eo_time=1785000000' in parsed.query
    assert request.headers.get('x-cloud-stage5g6a6b-acceptance-key') == ACCEPTANCE_KEY

    if parsed.path == '/api/stage5g6a6b/acceptance/seed':
        assert request.method == 'POST'
        assert request.headers.get('x-cloud-collab-preview-key') is None
        assert body == {'confirmation': 'SEED_STAGE5G6A6B_SYNTHETIC_V1'}
        fulfill(route, {
            'schemaVersion': 1,
            'duplicate': False,
            'groupId': 'group_fixture',
            'libraryId': 'lib_receive_fixture',
            'devices': DEVICES,
        }, 201)
        return

    if parsed.path == '/api/stage5g6a6b/acceptance/status':
        assert request.headers.get('x-cloud-collab-preview-key') is None
        fulfill(route, {
            'schemaVersion': 1,
            'seeded': True,
            'registeredDeviceCount': 2,
            'ordinaryPendingCount': state['ordinary'],
            'sensitivePendingCount': state['sensitive'] + state['delete'],
            'publicVersion': 3,
            'recordCount': 1,
            'tombstoneCount': 1,
        })
        return

    assert request.headers.get('x-cloud-collab-preview-key') == PREVIEW_KEY

    if parsed.path == '/api/stage5g6a6b/acceptance/ordinary-submissions-create':
        assert request.method == 'POST'
        assert body['dataType'] == 'boss_profile'
        assert body['operation'] == 'upsert'
        assert body['groupId'] == 'group_fixture'
        assert body['libraryId'] == 'lib_receive_fixture'
        assert set(body['payload']) == {'bossName', 'paiDan', 'discount'}
        state['ordinary'] += 1
        fulfill(route, {
            'status': 'pending_review' if state['ordinary'] == 2 else 'waiting_confirmation',
            'decision': 'pending_review' if state['ordinary'] == 2 else 'waiting_confirmation',
            'reason': 'candidate_conflict' if state['ordinary'] == 2 else 'second_device_required',
            'duplicate': False,
        }, 202)
        return

    if parsed.path == '/api/stage5g6a6b/acceptance/sensitive-submissions-create':
        assert request.method == 'POST'
        assert body['groupId'] == 'group_fixture'
        assert body['libraryId'] == 'lib_receive_fixture'
        assert body['dataType'] in {'rank_range_rule', 'surcharge_rule', 'gift_rule'}
        if body['operation'] == 'delete':
            assert body['payload'] is None
            assert body['dataType'] == 'surcharge_rule'
            state['delete'] += 1
            reason = 'explicit_delete_manual_review'
        else:
            state['sensitive'] += 1
            reason = f"{body['dataType']}_manual_review"
        fulfill(route, {
            'status': 'pending_review',
            'decision': 'pending_review',
            'reason': reason,
            'autoApprovalEnabled': False,
            'publicMutationAllowed': False,
            'duplicate': False,
        }, 202)
        return

    if parsed.path == '/api/stage5g6a6b/acceptance/public-version':
        fulfill(route, {
            'groupId': 'group_fixture',
            'libraryId': 'lib_receive_fixture',
            'publicVersion': 3,
            'snapshotVersion': 3,
            'recordCounts': {'surchargeRule': 1},
            'tombstoneCounts': {'surchargeRule': 1},
        })
        return

    if parsed.path == '/api/stage5g6a6b/acceptance/public-snapshot':
        fulfill(route, {
            'status': 'snapshot',
            'groupId': 'group_fixture',
            'libraryId': 'lib_receive_fixture',
            'publicVersion': 3,
            'snapshotVersion': 3,
            'snapshot': {
                'schemaVersion': 1,
                'groupId': 'group_fixture',
                'libraryId': 'lib_receive_fixture',
                'publicVersion': 3,
                'records': [SURCHARGE_RECORD],
                'tombstones': [{
                    'businessKey': SURCHARGE_RECORD['businessKey'],
                    'contentHash': 'ch_v1_' + ('E' * 43),
                    'dataType': 'surcharge_rule',
                    'operation': 'delete',
                    'approvedVersion': 3,
                }],
            },
        })
        return

    if parsed.path == '/api/stage5g6a6b/acceptance/public-changes':
        fulfill(route, {
            'status': 'changes',
            'groupId': 'group_fixture',
            'libraryId': 'lib_receive_fixture',
            'sinceVersion': 0,
            'publicVersion': 3,
            'nextVersion': 3,
            'hasMore': False,
            'changes': [
                {'version': 2, 'dataType': 'surcharge_rule', 'operation': 'upsert'},
                {'version': 3, 'dataType': 'surcharge_rule', 'operation': 'delete'},
            ],
        })
        return

    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.route(f'{ORIGIN}/**', route_handler)
    page.goto(f'{ORIGIN}/stage5g6a6b-acceptance.html?eo_token=test-token&eo_time=1785000000', wait_until='domcontentloaded')

    page.locator('#acceptanceKey').fill(ACCEPTANCE_KEY)
    page.locator('#previewKey').fill(PREVIEW_KEY)
    expect(page.locator('#ordinaryBtn')).to_be_disabled()
    expect(page.locator('#sensitiveBtn')).to_be_disabled()

    page.locator('#seedBtn').click()
    expect(page.locator('#topStatus')).to_contain_text('设备已就绪', timeout=10_000)
    expect(page.locator('#ordinaryBtn')).to_be_enabled()
    expect(page.locator('#sensitiveBtn')).to_be_enabled()

    page.locator('#ordinaryBtn').click()
    expect(page.locator('#candidateStatus')).to_contain_text('普通候选B：pending_review', timeout=10_000)

    page.locator('#sensitiveBtn').click()
    expect(page.locator('#candidateStatus')).to_contain_text('区间：pending_review', timeout=10_000)
    expect(page.locator('#candidateStatus')).to_contain_text('礼物：pending_review')

    page.locator('#snapshotBtn').click()
    expect(page.locator('#candidateStatus')).to_contain_text('surcharge_rule', timeout=10_000)
    expect(page.locator('#deleteBtn')).to_be_enabled()

    page.locator('#deleteBtn').click()
    expect(page.locator('#candidateStatus')).to_contain_text('explicit_delete_manual_review', timeout=10_000)

    page.locator('#finalBtn').click()
    expect(page.locator('#finalStatus')).to_contain_text('"tombstoneCount": 1', timeout=10_000)
    expect(page.locator('#ordinaryAdmin')).to_have_attribute('href', f'{ORIGIN}/admin-ordinary-reviews-preview.html?eo_token=test-token&eo_time=1785000000')
    expect(page.locator('#sensitiveAdmin')).to_have_attribute('href', f'{ORIGIN}/admin-sensitive-reviews-preview.html?eo_token=test-token&eo_time=1785000000')

    page.locator('#clearBtn').click()
    expect(page.locator('#acceptanceKey')).to_have_value('')
    expect(page.locator('#previewKey')).to_have_value('')
    expect(page.locator('#ordinaryBtn')).to_be_disabled()

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert local_values == []
    assert state == {'ordinary': 2, 'sensitive': 3, 'delete': 1}
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5G+6A+6B-acceptance',
    'ordinaryConflictPassed': True,
    'sensitiveManualReviewPassed': True,
    'explicitDeletePassed': True,
    'unifiedReadPassed': True,
    'previewTokenForwardingPassed': True,
    'browserStorageEmpty': True,
    'memoryClearPassed': True,
}, ensure_ascii=False))
