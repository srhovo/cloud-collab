from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'stage5def-admin-acceptance.html').read_text(encoding='utf-8')
ORIGIN = 'https://stage5def-admin.test'
ACCEPTANCE_KEY = 'stage5def-browser-acceptance-key-0123456789'
DEVICE_A_REF = f"devref_v1_{'A' * 43}"
DEVICE_B_REF = f"devref_v1_{'B' * 43}"
ROLLBACK_REF = f"rbref_v1_{'C' * 43}"
PACKAGE_ID = f"pkg_v1_{'D' * 43}"
ZIP_BYTES = b'PK\x03\x04' + b'\x00' * 64
state = {
    'blocked': False,
    'rollback_request': None,
    'rollback_done': False,
    'export_request': None,
    'export_count': 0,
}
requests = []


def envelope(data, service='stage5def-test'):
    return {'ok': True, 'serviceId': service, 'apiVersion': 'test-v1', 'data': data}


def fulfill_json(route, payload, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(payload, ensure_ascii=False),
    )


def error_payload(code, message):
    return {'ok': False, 'serviceId': 'stage5def-test', 'apiVersion': 'test-v1', 'error': {'code': code, 'message': message}}


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.method == 'POST' and request.post_data else None
    requests.append({
        'method': request.method,
        'path': parsed.path,
        'query': parsed.query,
        'body': body,
        'headers': dict(request.headers),
    })

    if parsed.path == '/stage5def-admin-acceptance.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return

    if parsed.path.startswith('/api/stage5def/acceptance/'):
        assert request.headers.get('x-cloud-stage5def-acceptance-key') == ACCEPTANCE_KEY

    if parsed.path == '/api/stage5def/acceptance/seed':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert body == {'schemaVersion': 1, 'confirmation': 'SEED_STAGE5DEF_SYNTHETIC_V1'}
        fulfill_json(route, envelope({'result': {
            'schemaVersion': 1,
            'seeded': True,
            'groupId': 'group_fixture',
            'libraryId': 'lib_receive_fixture',
            'devices': [
                {'slot': 'A', 'deviceRef': DEVICE_A_REF},
                {'slot': 'B', 'deviceRef': DEVICE_B_REF},
            ],
            'firstEventVersion': 1,
            'secondEventVersion': 2,
            'publicVersion': 2,
            'currentUnitPrice': 120,
        }, 'capabilities': {}}))
        return

    if parsed.path == '/api/admin/auth/login':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert body['schemaVersion'] == 1
        assert body['username'] == 'admin@example.test'
        assert body['password'] == 'browser-password'
        fulfill_json(route, envelope({
            'authenticated': True,
            'username': 'admin@example.test',
            'expiresAt': 1_784_500_900_000,
        }, 'cloud-collab-admin-auth-preview'), headers={
            'Set-Cookie': 'cloud_admin_session=browser-session; Path=/api/admin; HttpOnly; Secure; SameSite=Strict',
        })
        return

    if parsed.path == '/api/admin/auth/session':
        assert request.method == 'GET'
        fulfill_json(route, envelope({
            'authenticated': True,
            'username': 'admin@example.test',
            'issuedAt': 1_784_500_000_000,
            'expiresAt': 1_784_500_900_000,
            'sessionIdSuffix': 'DEF1',
            'capabilities': {},
        }, 'cloud-collab-admin-auth-preview'))
        return

    if parsed.path == '/api/admin/auth/logout':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        route.fulfill(status=204, headers={
            'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            'Cache-Control': 'no-store',
        }, body='')
        return

    if parsed.path in [
        '/api/admin/devices/trust',
        '/api/admin/devices/revoke-trust',
        '/api/admin/devices/block',
        '/api/admin/devices/unblock',
    ]:
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert body['schemaVersion'] == 1
        assert body['requestId'].startswith('dgrq_v1_')
        if parsed.path.endswith('/trust'):
            assert body['deviceRef'] == DEVICE_A_REF
            assert body['reasonCode'] == 'verified_operator'
        elif parsed.path.endswith('/revoke-trust'):
            assert body['deviceRef'] == DEVICE_A_REF
            assert body['reasonCode'] == 'trust_withdrawn'
        elif parsed.path.endswith('/block'):
            assert body['deviceRef'] == DEVICE_B_REF
            assert body['reasonCode'] == 'manual_safety'
            state['blocked'] = True
        else:
            assert body['deviceRef'] == DEVICE_B_REF
            assert body['reasonCode'] == 'manual_review_cleared'
            state['blocked'] = False
        fulfill_json(route, envelope({'viewer': {}, 'result': {'schemaVersion': 1}, 'capabilities': {}}))
        return

    if parsed.path == '/api/stage5def/acceptance/device-auth':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert body == {'schemaVersion': 1, 'slot': 'B'}
        if state['blocked']:
            fulfill_json(route, error_payload('DEVICE_BLOCKED', '设备已被管理员封禁'), status=403)
        else:
            fulfill_json(route, envelope({'result': {
                'schemaVersion': 1,
                'authenticated': True,
                'slot': 'B',
                'deviceRef': DEVICE_B_REF,
                'nicknameTag': 'ABCE',
                'expiresAt': 1_792_000_000_000,
            }, 'capabilities': {}}))
        return

    if parsed.path == '/api/admin/rollbacks':
        assert request.method == 'GET'
        fulfill_json(route, envelope({'viewer': {}, 'result': {
            'schemaVersion': 1,
            'count': 1,
            'candidates': [{
                'schemaVersion': 1,
                'rollbackRef': ROLLBACK_REF,
                'serviceName': '阶段5DEF联合验收普通单价',
                'settleType': 'round',
                'currentUnitPrice': 120,
                'previousUnitPrice': 100,
                'currentVersion': 2,
                'previousVersion': 1,
                'currentApprovedAt': '2026-07-20T01:00:00.000Z',
                'previousApprovedAt': '2026-07-20T00:00:00.000Z',
            }],
        }, 'capabilities': {}}))
        return

    if parsed.path == '/api/admin/rollbacks/execute':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert body['confirmation'] == 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE'
        if state['rollback_request'] is None:
            state['rollback_request'] = body
            state['rollback_done'] = True
            duplicate = False
        elif body == state['rollback_request']:
            duplicate = True
        else:
            fulfill_json(route, error_payload('ADMIN_ROLLBACK_TARGET_STALE', '回滚目标已不是当前公共值'), status=409)
            return
        fulfill_json(route, envelope({'viewer': {}, 'result': {
            'schemaVersion': 1,
            'rollbackRef': ROLLBACK_REF,
            'status': 'rolled_back',
            'serviceName': '阶段5DEF联合验收普通单价',
            'settleType': 'round',
            'restoredUnitPrice': 100,
            'replacedUnitPrice': 120,
            'restoredFromVersion': 1,
            'replacedVersion': 2,
            'eventVersion': 3,
            'publicVersion': 3,
            'publicMutationApplied': True,
            'duplicate': duplicate,
        }, 'capabilities': {}}))
        return

    if parsed.path == '/api/admin/exports/summary':
        assert request.method == 'GET'
        fulfill_json(route, envelope({'viewer': {}, 'result': {
            'schemaVersion': 1,
            'packageId': PACKAGE_ID,
            'groupId': 'group_fixture',
            'libraryId': 'lib_receive_fixture',
            'publicVersion': 3,
            'eventCount': 3,
            'recordCount': 1,
            'rollbackCount': 1,
            'fileCount': 10,
            'packageByteLength': len(ZIP_BYTES),
            'generatedAt': '2026-07-20T02:00:00.000Z',
        }, 'capabilities': {}}))
        return

    if parsed.path == '/api/admin/exports/download':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert body['confirmation'] == 'EXPORT_SYNTHETIC_PUBLIC_DATABASE'
        if state['export_request'] is None:
            state['export_request'] = body
        else:
            assert body == state['export_request']
        state['export_count'] += 1
        route.fulfill(status=200, headers={
            'Content-Type': 'application/zip',
            'Content-Length': str(len(ZIP_BYTES)),
            'Content-Disposition': "attachment; filename*=UTF-8''stage5def.zip",
            'X-Mdq-Package-Id': PACKAGE_ID,
            'X-Mdq-Public-Version': '3',
            'X-Mdq-File-Count': '10',
            'X-Mdq-Duplicate': '1' if state['export_count'] > 1 else '0',
            'Cache-Control': 'no-store',
        }, body=ZIP_BYTES)
        return

    if parsed.path == '/api/stage5def/acceptance/status':
        assert request.method == 'GET'
        fulfill_json(route, envelope({'result': {
            'schemaVersion': 1,
            'seedMarkerValid': True,
            'eventCount': 3,
            'publicVersion': 3,
            'recordCount': 1,
            'currentUnitPrice': 100,
            'rollbackCandidateCount': 1,
            'exportPackageId': PACKAGE_ID,
            'exportFileCount': 10,
            'publicObjectCount': 35,
            'publicKeySetDigest': 'E' * 43,
            'audits': {'governance': 4, 'rollback': 1, 'export': 1},
            'devices': [],
            'governanceComplete': True,
            'rollbackComplete': True,
            'exportComplete': True,
            'readyForCleanup': True,
        }, 'capabilities': {}}))
        return

    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932}, accept_downloads=True)
    page = context.new_page()
    console_errors = []
    page_errors = []

    def record_console_error(message):
        if message.type == 'error' and not message.text.startswith('Failed to load resource:'):
            console_errors.append(message.text)

    page.on('console', record_console_error)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.route(f'{ORIGIN}/**', route_handler)
    page.goto(f'{ORIGIN}/stage5def-admin-acceptance.html?eo_token=test-token&eo_time=1784500000', wait_until='domcontentloaded')

    page.locator('#acceptanceKey').fill(ACCEPTANCE_KEY)
    page.locator('#username').fill('admin@example.test')
    page.locator('#password').fill('browser-password')
    page.get_by_role('button', name='创建并核验合成种子', exact=True).click()
    expect(page.locator('#status')).to_contain_text('合成种子就绪', timeout=10_000)
    page.get_by_role('button', name='管理员安全登录', exact=True).click()
    expect(page.locator('#status')).to_contain_text('管理员登录和会话恢复通过', timeout=10_000)
    page.get_by_role('button', name='运行设备治理、回滚与导出联合验收', exact=True).click()
    expect(page.locator('#status')).to_contain_text('联合验收全部通过', timeout=15_000)
    expect(page.locator('.step.ok')).to_have_count(9)
    expect(page.locator('#steps')).to_contain_text('DEVICE_BLOCKED')
    expect(page.locator('#steps')).to_contain_text('ADMIN_ROLLBACK_TARGET_STALE')
    assert state['export_count'] == 2

    page.get_by_role('button', name='退出并清除页面状态', exact=True).click()
    expect(page.locator('#status')).to_contain_text('已退出并清除页面内存状态', timeout=10_000)
    expect(page.locator('#acceptanceKey')).to_have_value('')
    expect(page.locator('#password')).to_have_value('')

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    stage5def_requests = [item for item in requests if item['path'].startswith('/api/stage5def/')]
    assert local_values == []
    assert not console_errors, console_errors
    assert not page_errors, page_errors
    assert stage5def_requests
    assert all('eo_token=test-token' in item['query'] and 'eo_time=1784500000' in item['query'] for item in stage5def_requests)
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5DEF',
    'seedPassed': True,
    'adminSessionPassed': True,
    'deviceGovernancePassed': True,
    'blockedAuthenticationPassed': True,
    'rollbackAndReplayPassed': True,
    'staleRollbackPassed': True,
    'exportAndReplayPassed': True,
    'finalCleanupReadinessPassed': True,
    'previewTokenForwardingPassed': True,
    'browserStorageEmpty': True,
}, ensure_ascii=False))
