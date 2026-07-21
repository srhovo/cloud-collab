from pathlib import Path
from urllib.parse import urlparse, parse_qs
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-production-console.html').read_text(encoding='utf-8')
ZIP_BYTES = b'PK\x03\x04stage8b-production-admin-console'
PACKAGE_ID = f"pkg_v2_{'A' * 43}"
REVIEW_ID = f"rv_v1_{'B' * 43}"
ORDINARY_REVIEW_ID = f"rv_v1_{'C' * 43}"
SENSITIVE_REVIEW_ID = f"srv_v1_{'D' * 43}"
DEVICE_REF = f"devref_v1_{'E' * 43}"
ROLLBACK_REF = f"rbref_v1_{'F' * 43}"
BUSINESS_KEY = f"bk_v1_{'G' * 43}"
CONTENT_HASH = f"ch_v1_{'H' * 43}"

requests = []
state = {
    'logged_in': False,
    'exact_open': True,
    'ordinary_open': True,
    'sensitive_open': True,
    'device_trusted': False,
    'device_blocked': False,
    'rollback_open': True,
}

CAPABILITIES = {
    'productionAdmin': True,
    'syntheticFixtureOnly': False,
    'stablePromotionAuthorized': False,
}


def fulfill_json(route, payload, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(payload, ensure_ascii=False),
    )


def envelope(data, service='cloud-collab-admin-production'):
    return {
        'ok': True,
        'serviceId': service,
        'apiVersion': '2026-07-21-stage8b-browser',
        'data': data,
    }


def failure(code, message, status=400):
    return {
        'ok': False,
        'serviceId': 'cloud-collab-admin-production',
        'apiVersion': '2026-07-21-stage8b-browser',
        'error': {'code': code, 'message': message},
    }, status


def viewer():
    return {
        'authenticated': True,
        'username': 'xiaxue',
        'sessionIdSuffix': '8B01',
        'expiresAt': 1_784_641_000_000,
    }


def production_data(extra):
    return {
        **extra,
        'capabilities': {**CAPABILITIES},
        'stablePromotionAuthorized': False,
    }


def require_session(route):
    if state['logged_in']:
        return True
    payload, status = failure('ADMIN_SESSION_MISSING', '管理员会话不存在', 401)
    fulfill_json(route, payload, status=status, headers={
        'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
    })
    return False


def exact_queue():
    items = []
    if state['exact_open']:
        items.append({
            'reviewId': REVIEW_ID,
            'serviceName': '鹅鸭杀',
            'settleType': 'round',
            'candidateUnitPrice': 120,
            'reason': 'candidate_conflict',
            'distinctDeviceCount': 2,
            'receivedAt': 1_784_640_010_000,
            'baseline': {'unitPrice': 100, 'stillCurrent': True},
        })
    return production_data({
        'scope': {'groupId': 'group_see', 'libraryId': 'lib_see_cz'},
        'total': len(items),
        'items': items,
    })


def ordinary_queue():
    items = []
    if state['ordinary_open']:
        items.append({
            'reviewId': ORDINARY_REVIEW_ID,
            'dataType': 'playable_name',
            'reason': 'playable_name_public_conflict',
            'distinctDeviceCount': 2,
            'receivedAt': 1_784_640_020_000,
            'payload': {'name': '下雪'},
            'baseline': {
                'dataType': 'playable_name',
                'payload': {'name': '小雪'},
                'stillCurrent': True,
            },
        })
    return production_data({
        'scope': {'groupId': 'group_see', 'libraryId': 'lib_see_cz'},
        'total': len(items),
        'items': items,
    })


def sensitive_queue():
    items = []
    if state['sensitive_open']:
        items.append({
            'reviewId': SENSITIVE_REVIEW_ID,
            'dataType': 'gift_rule',
            'operation': 'upsert',
            'reason': 'gift_rule_manual_review',
            'receivedAt': 1_784_640_030_000,
            'tombstoneRequested': False,
            'businessKey': BUSINESS_KEY,
            'baselineContentHash': None,
        })
    return production_data({
        'scope': {'groupId': 'group_see', 'libraryId': 'lib_see_cz'},
        'count': len(items),
        'items': items,
    })


def sensitive_detail():
    return production_data({
        'scope': {'groupId': 'group_see', 'libraryId': 'lib_see_cz'},
        'item': {
            'reviewId': SENSITIVE_REVIEW_ID,
            'dataType': 'gift_rule',
            'operation': 'upsert',
            'reason': 'gift_rule_manual_review',
        },
        'candidate': {
            'dataType': 'gift_rule',
            'operation': 'upsert',
            'businessKey': BUSINESS_KEY,
            'contentHash': CONTENT_HASH,
            'payload': {'serviceName': '礼物', 'mode': 'fixed', 'unitPrice': 20},
        },
        'baseline': None,
    })


def device_list():
    return production_data({
        'result': {
            'count': 1,
            'devices': [{
                'deviceRef': DEVICE_REF,
                'displayName': '下雪 · ABCD',
                'nicknameTag': 'ABCD',
                'createdAt': 1_784_640_000_000,
                'expiresAt': 1_792_416_000_000,
                'lastAppVersion': '8.2.31',
                'trusted': state['device_trusted'],
                'blocked': state['device_blocked'],
                'governanceVersion': 1 if state['device_trusted'] else 0,
            }],
        },
    })


def device_detail():
    return production_data({
        'result': {
            'device': {
                'deviceRef': DEVICE_REF,
                'displayName': '下雪 · ABCD',
                'createdAt': 1_784_640_000_000,
                'expiresAt': 1_792_416_000_000,
                'lastAppVersion': '8.2.31',
                'trusted': state['device_trusted'],
                'blocked': state['device_blocked'],
                'governanceVersion': 1 if state['device_trusted'] else 0,
            },
            'events': ([{
                'action': 'trust',
                'reasonCode': 'verified_operator',
                'version': 1,
                'createdAt': 1_784_640_040_000,
                'actorTag': 'admin_ABCDEFGH1234',
            }] if state['device_trusted'] else []),
        },
    })


def rollback_list():
    candidates = []
    if state['rollback_open']:
        candidates.append({
            'rollbackRef': ROLLBACK_REF,
            'serviceName': '鹅鸭杀',
            'dataType': 'exact_price',
            'settleType': 'round',
            'currentUnitPrice': 120,
            'previousUnitPrice': 100,
            'currentVersion': 7,
            'previousVersion': 6,
            'currentApprovedAt': '2026-07-21T00:00:00.000Z',
            'previousApprovedAt': '2026-07-20T00:00:00.000Z',
        })
    return production_data({'result': {'count': len(candidates), 'candidates': candidates}})


def export_summary():
    return production_data({
        'result': {
            'schemaVersion': 1,
            'packageFormatVersion': 2,
            'packageId': PACKAGE_ID,
            'publicVersion': 8,
            'recordCount': 6,
            'tombstoneCount': 1,
            'ordinaryEventCount': 5,
            'sensitiveEventCount': 3,
            'fileCount': 13,
            'packageByteLength': len(ZIP_BYTES),
            'generatedAt': '2026-07-21T01:00:00.000Z',
        },
    })


def parse_body(request):
    return request.post_data_json if request.method == 'POST' and request.post_data else None


def route_handler(route, request):
    parsed = urlparse(request.url)
    path = parsed.path
    body = parse_body(request)
    requests.append({'method': request.method, 'path': path, 'body': body, 'origin': request.headers.get('origin')})

    if path == '/admin-production-console.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return

    if path == '/api/admin/auth/login':
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://admin.example.invalid'
        assert body == {'schemaVersion': 1, 'username': 'xiaxue', 'password': 'browser-only-password'}
        state['logged_in'] = True
        fulfill_json(route, envelope(viewer()), headers={
            'Set-Cookie': 'cloud_admin_session=browser-session; Path=/api/admin; HttpOnly; Secure; SameSite=Strict',
        })
        return

    if path == '/api/admin/auth/session':
        if not require_session(route):
            return
        fulfill_json(route, envelope(viewer()))
        return

    if path == '/api/admin/auth/logout':
        assert request.method == 'POST'
        state['logged_in'] = False
        route.fulfill(status=204, headers={
            'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            'Cache-Control': 'no-store',
        }, body='')
        return

    if not require_session(route):
        return

    if path == '/api/admin/reviews' and request.method == 'GET':
        fulfill_json(route, envelope(exact_queue(), 'cloud-collab-admin-exact-review-production'))
        return
    if path == '/api/admin/reviews/approve':
        assert body == {'reviewId': REVIEW_ID, 'confirmation': 'APPROVE'}
        state['exact_open'] = False
        fulfill_json(route, envelope(production_data({'result': {'status': 'approved', 'publicVersion': 8}})))
        return

    if path == '/api/admin/ordinary-reviews' and request.method == 'GET':
        fulfill_json(route, envelope(ordinary_queue(), 'cloud-collab-admin-ordinary-review-production'))
        return
    if path == '/api/admin/ordinary-reviews/approve':
        assert body == {'reviewId': ORDINARY_REVIEW_ID, 'confirmation': 'APPROVE_ORDINARY'}
        state['ordinary_open'] = False
        fulfill_json(route, envelope(production_data({'result': {'status': 'approved', 'publicVersion': 9}})))
        return

    if path == '/api/admin/sensitive-reviews' and request.method == 'GET':
        fulfill_json(route, envelope(sensitive_queue(), 'cloud-collab-admin-sensitive-review-production'))
        return
    if path == '/api/admin/sensitive-reviews/detail':
        assert parse_qs(parsed.query).get('id') == [SENSITIVE_REVIEW_ID]
        fulfill_json(route, envelope(sensitive_detail(), 'cloud-collab-admin-sensitive-review-production'))
        return
    if path == '/api/admin/sensitive-reviews/approve':
        assert body == {'reviewId': SENSITIVE_REVIEW_ID, 'confirmation': 'APPROVE_SENSITIVE'}
        state['sensitive_open'] = False
        fulfill_json(route, envelope(production_data({
            'resolution': {'decisionId': f"srd_v1_{'I' * 43}"},
            'publicResult': {'version': 10},
        })))
        return

    if path == '/api/admin/devices' and request.method == 'GET':
        fulfill_json(route, envelope(device_list(), 'cloud-collab-admin-device-governance-production'))
        return
    if path == '/api/admin/devices/detail':
        assert parse_qs(parsed.query).get('id') == [DEVICE_REF]
        fulfill_json(route, envelope(device_detail(), 'cloud-collab-admin-device-governance-production'))
        return
    if path == '/api/admin/devices/trust':
        assert body['schemaVersion'] == 1
        assert body['deviceRef'] == DEVICE_REF
        assert body['requestId'].startswith('dgrq_v1_')
        assert body['reasonCode'] == 'verified_operator'
        state['device_trusted'] = True
        fulfill_json(route, envelope(production_data({'result': {
            'trusted': True, 'blocked': False, 'governanceVersion': 1,
        }})))
        return

    if path == '/api/admin/rollbacks' and request.method == 'GET':
        fulfill_json(route, envelope(rollback_list(), 'cloud-collab-admin-rollback-production'))
        return
    if path == '/api/admin/rollbacks/execute':
        assert body['schemaVersion'] == 1
        assert body['rollbackRef'] == ROLLBACK_REF
        assert body['requestId'].startswith('rbrq_v1_')
        assert body['confirmation'] == 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'
        state['rollback_open'] = False
        fulfill_json(route, envelope(production_data({'result': {
            'publicVersion': 11, 'eventVersion': 8,
        }})))
        return

    if path == '/api/admin/exports/summary':
        fulfill_json(route, envelope(export_summary(), 'cloud-collab-admin-export-production'))
        return
    if path == '/api/admin/exports/download':
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://admin.example.invalid'
        assert body['schemaVersion'] == 1
        assert body['requestId'].startswith('exrq_v1_')
        assert body['confirmation'] == 'EXPORT_FULL_PUBLIC_DATABASE'
        route.fulfill(
            status=200,
            headers={
                'Content-Type': 'application/zip',
                'Content-Disposition': "attachment; filename*=UTF-8''%E7%A0%81%E5%8D%95%E5%99%A8%E5%85%AC%E5%85%B1%E6%95%B0%E6%8D%AE%E5%BA%93%E5%AE%8C%E6%95%B4%E5%AF%BC%E5%87%BA.zip",
                'X-Mdq-Package-Id': PACKAGE_ID,
                'X-Mdq-Public-Version': '8',
                'Cache-Control': 'no-store',
            },
            body=ZIP_BYTES,
        )
        return

    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932}, accept_downloads=True)
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('https://admin.example.invalid/**', route_handler)
    page.goto('https://admin.example.invalid/admin-production-console.html', wait_until='domcontentloaded')

    expect(page.locator('#authStatus')).to_contain_text('当前没有有效管理员会话', timeout=10_000)
    expect(page.get_by_role('button', name='精确价格审核')).to_be_disabled()

    page.locator('#username').fill('xiaxue')
    page.locator('#password').fill('browser-only-password')
    page.get_by_role('button', name='同源安全登录', exact=True).click()
    expect(page.locator('#authStatus')).to_contain_text('登录成功', timeout=10_000)
    expect(page.locator('#password')).to_have_value('')
    expect(page.get_by_role('button', name='精确价格审核')).to_be_enabled()

    page.get_by_role('button', name='精确价格审核', exact=True).click()
    page.get_by_role('button', name='刷新队列', exact=True).click()
    expect(page.locator('#exactStatus')).to_contain_text('1 项', timeout=10_000)
    page.get_by_role('button', name='批准候选值', exact=True).click()
    expect(page.locator('#exactStatus')).to_contain_text('批准完成', timeout=10_000)
    expect(page.locator('#exactList')).to_contain_text('当前没有精确价格待审核项目')

    page.get_by_role('button', name='普通资料审核', exact=True).click()
    page.get_by_role('button', name='刷新队列', exact=True).click()
    expect(page.locator('#ordinaryStatus')).to_contain_text('1 项', timeout=10_000)
    page.get_by_role('button', name='批准候选', exact=True).click()
    expect(page.locator('#ordinaryStatus')).to_contain_text('批准完成', timeout=10_000)

    page.get_by_role('button', name='敏感人工审核', exact=True).click()
    page.get_by_role('button', name='刷新敏感队列', exact=True).click()
    expect(page.locator('#sensitiveStatus')).to_contain_text('1 项', timeout=10_000)
    page.get_by_role('button', name='读取基线与候选详情', exact=True).click()
    expect(page.get_by_role('button', name='批准候选', exact=True)).to_be_visible(timeout=10_000)
    page.get_by_role('button', name='批准候选', exact=True).click()
    expect(page.locator('#sensitiveStatus')).to_contain_text('敏感批准完成', timeout=10_000)

    page.get_by_role('button', name='设备治理', exact=True).click()
    page.get_by_role('button', name='刷新设备列表', exact=True).click()
    expect(page.locator('#devicesStatus')).to_contain_text('1 台', timeout=10_000)
    page.get_by_role('button', name='查看设备详情', exact=True).click()
    expect(page.locator('#deviceMutationStatus')).to_contain_text('设备详情已读取', timeout=10_000)
    page.get_by_role('button', name='设为可信', exact=True).click()
    expect(page.locator('#deviceMutationStatus')).to_contain_text('设为可信完成', timeout=10_000)

    page.get_by_role('button', name='公共数据回滚', exact=True).click()
    page.get_by_role('button', name='刷新可回滚项目', exact=True).click()
    expect(page.locator('#rollbackStatus')).to_contain_text('1 项', timeout=10_000)
    page.get_by_role('button', name='回滚到上一批准值', exact=True).click()
    expect(page.locator('#rollbackStatus')).to_contain_text('回滚完成', timeout=10_000)

    page.get_by_role('button', name='完整迁移导出', exact=True).click()
    page.get_by_role('button', name='刷新导出摘要', exact=True).click()
    expect(page.locator('#exportStatus')).to_contain_text('公共版本 8', timeout=10_000)
    expect(page.locator('#exportRecordCount')).to_have_text('6')
    expect(page.locator('#exportTombstoneCount')).to_have_text('1')
    with page.expect_download(timeout=10_000) as download_info:
        page.get_by_role('button', name='下载完整迁移包', exact=True).click()
    download = download_info.value
    expect(page.locator('#exportStatus')).to_contain_text('下载完成', timeout=10_000)
    assert download.suggested_filename == '码单器公共数据库完整导出.zip'

    # Simulate a server-side session expiry after privileged data has been shown.
    state['logged_in'] = False
    page.get_by_role('button', name='精确价格审核', exact=True).click()
    page.get_by_role('button', name='刷新队列', exact=True).click()
    expect(page.locator('#sessionChip')).to_have_text('会话失效', timeout=10_000)
    expect(page.locator('#module-auth')).to_be_visible()
    expect(page.get_by_role('button', name='精确价格审核')).to_be_disabled()
    expect(page.locator('#exactList')).to_be_empty()
    expect(page.locator('#ordinaryList')).to_be_empty()
    expect(page.locator('#sensitiveList')).to_be_empty()
    expect(page.locator('#devicesList')).to_be_empty()
    expect(page.locator('#rollbackList')).to_be_empty()
    expect(page.locator('#exportFacts')).to_have_class('facts hidden')

    storage = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert local_values == []
    assert not console_errors, console_errors

    assert any(item['path'] == '/api/admin/auth/login' for item in requests)
    assert any(item['path'] == '/api/admin/reviews/approve' and item['body']['confirmation'] == 'APPROVE' for item in requests)
    assert any(item['path'] == '/api/admin/ordinary-reviews/approve' and item['body']['confirmation'] == 'APPROVE_ORDINARY' for item in requests)
    assert any(item['path'] == '/api/admin/sensitive-reviews/approve' and item['body']['confirmation'] == 'APPROVE_SENSITIVE' for item in requests)
    assert any(item['path'] == '/api/admin/devices/trust' and item['body']['reasonCode'] == 'verified_operator' for item in requests)
    assert any(item['path'] == '/api/admin/rollbacks/execute' and item['body']['confirmation'] == 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE' for item in requests)
    assert any(item['path'] == '/api/admin/exports/download' and item['body']['confirmation'] == 'EXPORT_FULL_PUBLIC_DATABASE' for item in requests)

    context.close()
    browser.close()

print(json.dumps({
    'stage': '8B',
    'loginPasswordCleared': True,
    'exactReviewPassed': True,
    'ordinaryReviewPassed': True,
    'sensitiveReviewPassed': True,
    'deviceGovernancePassed': True,
    'rollbackPassed': True,
    'fullExportPassed': True,
    'sessionExpiryClearedAllViews': True,
    'browserStorageEmpty': True,
    'consoleErrors': 0,
}, ensure_ascii=False))
