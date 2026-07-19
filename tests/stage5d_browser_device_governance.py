from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-device-governance-preview.html').read_text(encoding='utf-8')
DEVICE_REF = f"devref_v1_{'A' * 43}"
requests = []
state = {'trusted': False, 'blocked': False, 'version': 0, 'events': []}

CAPABILITIES = {
    'deviceListRead': True,
    'deviceDetailRead': True,
    'deviceTrust': True,
    'deviceTrustRevoke': True,
    'deviceBlock': True,
    'deviceUnblock': True,
    'reviewMutation': False,
    'rollback': False,
    'export': False,
    'publicMutationAllowed': False,
    'syntheticFixtureOnly': True,
}


def fulfill_json(route, data, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(data, ensure_ascii=False),
    )


def envelope(data, service='cloud-collab-admin-device-governance-preview'):
    return {
        'ok': True,
        'serviceId': service,
        'apiVersion': '2026-07-20-stage5d-browser',
        'data': data,
    }


def viewer():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'sessionIdSuffix': '5D01',
        'expiresAt': 1_784_430_900_000,
    }


def device_projection():
    return {
        'schemaVersion': 1,
        'deviceRef': DEVICE_REF,
        'displayName': '合成设备 · ABCD',
        'nicknameTag': 'ABCD',
        'createdAt': 1_784_430_000_000,
        'updatedAt': 1_784_430_000_000,
        'issuedAt': 1_784_430_000_000,
        'expiresAt': 1_784_516_400_000,
        'lastAppVersion': '8.2.28',
        'trusted': state['trusted'],
        'blocked': state['blocked'],
        'governanceVersion': state['version'],
        'governanceUpdatedAt': state['events'][-1]['createdAt'] if state['events'] else None,
    }


def list_result():
    return {'schemaVersion': 1, 'count': 1, 'devices': [device_projection()]}


def detail_result():
    return {
        'schemaVersion': 1,
        'device': device_projection(),
        'events': list(reversed(state['events'])),
    }


def mutate(action, reason_code):
    previous_trusted = state['trusted']
    previous_blocked = state['blocked']
    if action == 'trust':
        assert not state['trusted'] and not state['blocked']
        state['trusted'] = True
    elif action == 'revoke_trust':
        assert state['trusted']
        state['trusted'] = False
    elif action == 'block':
        assert not state['blocked']
        state['trusted'] = False
        state['blocked'] = True
    elif action == 'unblock':
        assert state['blocked']
        state['blocked'] = False
        state['trusted'] = False
    else:
        raise AssertionError(action)
    state['version'] += 1
    state['events'].append({
        'schemaVersion': 1,
        'action': action,
        'reasonCode': reason_code,
        'actorTag': 'admin_ABCDEFGHIJKL',
        'fromVersion': state['version'] - 1,
        'version': state['version'],
        'previousTrusted': previous_trusted,
        'previousBlocked': previous_blocked,
        'trusted': state['trusted'],
        'blocked': state['blocked'],
        'createdAt': 1_784_430_000_000 + state['version'] * 1000,
    })
    return {
        'schemaVersion': 1,
        'deviceRef': DEVICE_REF,
        'action': action,
        'reasonCode': reason_code,
        'trusted': state['trusted'],
        'blocked': state['blocked'],
        'governanceVersion': state['version'],
        'governanceUpdatedAt': state['events'][-1]['createdAt'],
        'duplicate': False,
    }


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.method == 'POST' and request.post_data else None
    requests.append({'method': request.method, 'path': parsed.path, 'query': parsed.query, 'body': body})

    if parsed.path == '/admin-device-governance-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return
    if parsed.path == '/api/admin/auth/session':
        assert request.method == 'GET'
        assert 'cloud_admin_session=browser-session' in request.headers.get('cookie', '')
        fulfill_json(route, envelope({
            **viewer(),
            'issuedAt': 1_784_430_000_000,
            'capabilities': {
                'reviewQueueRead': False,
                'reviewMutation': False,
                'deviceMutation': False,
                'rollback': False,
                'export': False,
                'publicMutationAllowed': False,
            },
        }, 'cloud-collab-admin-auth-preview'))
        return
    if parsed.path == '/api/admin/auth/logout':
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://stage5d-admin.test'
        route.fulfill(status=204, headers={
            'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            'Cache-Control': 'no-store',
        }, body='')
        return
    if parsed.path == '/api/admin/devices':
        assert request.method == 'GET'
        fulfill_json(route, envelope({'viewer': viewer(), 'result': list_result(), 'capabilities': CAPABILITIES}))
        return
    if parsed.path == '/api/admin/devices/detail':
        assert request.method == 'GET'
        assert parse_qs(parsed.query) == {'id': [DEVICE_REF]}
        fulfill_json(route, envelope({'viewer': viewer(), 'result': detail_result(), 'capabilities': CAPABILITIES}))
        return

    mutation_routes = {
        '/api/admin/devices/trust': ('trust', 'verified_operator'),
        '/api/admin/devices/revoke-trust': ('revoke_trust', 'trust_withdrawn'),
        '/api/admin/devices/block': ('block', 'manual_safety'),
        '/api/admin/devices/unblock': ('unblock', 'manual_review_cleared'),
    }
    if parsed.path in mutation_routes:
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://stage5d-admin.test'
        assert request.headers.get('content-type', '').startswith('application/json')
        action, expected_reason = mutation_routes[parsed.path]
        assert body['schemaVersion'] == 1
        assert body['deviceRef'] == DEVICE_REF
        assert body['requestId'].startswith('dgrq_v1_')
        assert body['reasonCode'] == expected_reason
        result = mutate(action, body['reasonCode'])
        fulfill_json(route, envelope({'viewer': viewer(), 'result': result, 'capabilities': CAPABILITIES}))
        return

    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    context.add_cookies([{
        'name': 'cloud_admin_session',
        'value': 'browser-session',
        'domain': 'stage5d-admin.test',
        'path': '/api/admin',
        'secure': True,
        'httpOnly': True,
        'sameSite': 'Strict',
    }])
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('https://stage5d-admin.test/**', route_handler)
    page.goto('https://stage5d-admin.test/admin-device-governance-preview.html', wait_until='domcontentloaded')

    page.get_by_role('button', name='检查/恢复会话', exact=True).click()
    expect(page.locator('#authStatus')).to_contain_text('管理员会话有效', timeout=10_000)
    page.get_by_role('button', name='刷新设备列表', exact=True).click()
    expect(page.locator('#listStatus')).to_contain_text('1台设备', timeout=10_000)
    expect(page.locator('.device')).to_have_count(1)
    assert 'dev_01' not in page.locator('body').inner_text()
    assert 'tokenHash' not in page.locator('body').inner_text()

    page.get_by_role('button', name='查看设备详情', exact=True).click()
    expect(page.locator('#detailCard')).not_to_have_class('card hidden')
    expect(page.locator('#mutationStatus')).to_contain_text('强一致读取', timeout=10_000)

    page.get_by_role('button', name='设为可信', exact=True).click()
    expect(page.locator('#mutationStatus')).to_contain_text('设为可信完成', timeout=10_000)
    expect(page.locator('#detail')).to_contain_text('可信')

    page.get_by_role('button', name='撤销可信', exact=True).click()
    expect(page.locator('#mutationStatus')).to_contain_text('撤销可信完成', timeout=10_000)

    page.get_by_role('button', name='设为可信', exact=True).click()
    expect(page.locator('#mutationStatus')).to_contain_text('设为可信完成', timeout=10_000)
    page.get_by_role('button', name='封禁设备', exact=True).click()
    expect(page.locator('#mutationStatus')).to_contain_text('封禁设备完成', timeout=10_000)
    expect(page.locator('#detail')).to_contain_text('已封禁')
    assert state['trusted'] is False and state['blocked'] is True

    page.get_by_role('button', name='解除封禁', exact=True).click()
    expect(page.locator('#mutationStatus')).to_contain_text('解除封禁完成', timeout=10_000)
    assert state['trusted'] is False and state['blocked'] is False

    page.get_by_role('button', name='退出并清除会话', exact=True).click()
    expect(page.locator('#authStatus')).to_contain_text('已退出', timeout=10_000)
    expect(page.locator('#detailCard')).to_have_class('card hidden')

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert local_values == []
    mutation_requests = [item for item in requests if item['path'] in {
        '/api/admin/devices/trust', '/api/admin/devices/revoke-trust',
        '/api/admin/devices/block', '/api/admin/devices/unblock',
    }]
    assert [item['path'] for item in mutation_requests] == [
        '/api/admin/devices/trust',
        '/api/admin/devices/revoke-trust',
        '/api/admin/devices/trust',
        '/api/admin/devices/block',
        '/api/admin/devices/unblock',
    ]
    assert all(item['method'] == 'POST' for item in mutation_requests)
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5D',
    'authenticatedSessionUsed': True,
    'redactedListPassed': True,
    'detailPassed': True,
    'trustAndRevokePassed': True,
    'blockRevokedTrustPassed': True,
    'unblockDidNotRestoreTrust': True,
    'exactAccessibleNamesPassed': True,
    'browserStorageEmpty': True,
    'logoutClearedView': True,
}, ensure_ascii=False))
