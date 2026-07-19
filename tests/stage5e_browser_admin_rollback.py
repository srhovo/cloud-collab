from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-rollback-preview.html').read_text(encoding='utf-8')
ROLLBACK_REF = f"rbref_v1_{'A' * 43}"
requests = []
state = {'executed': False}

CAPABILITIES = {
    'rollbackListRead': True,
    'rollbackExecute': True,
    'deviceMutation': False,
    'reviewMutation': False,
    'export': False,
    'publicMutationAllowed': True,
    'syntheticFixtureOnly': True,
}


def fulfill_json(route, data, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(data, ensure_ascii=False),
    )


def envelope(data, service='cloud-collab-admin-rollback-preview'):
    return {
        'ok': True,
        'serviceId': service,
        'apiVersion': '2026-07-20-stage5e-browser',
        'data': data,
    }


def viewer():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'sessionIdSuffix': '5E01',
        'expiresAt': 1_784_440_900_000,
    }


def candidates_result():
    candidates = [] if state['executed'] else [{
        'schemaVersion': 1,
        'rollbackRef': ROLLBACK_REF,
        'serviceName': '鹅鸭杀',
        'settleType': 'round',
        'currentUnitPrice': 120,
        'previousUnitPrice': 100,
        'currentVersion': 2,
        'previousVersion': 1,
        'currentApprovedAt': '2026-07-20T01:00:00.000Z',
        'previousApprovedAt': '2026-07-20T00:00:00.000Z',
    }]
    return {'schemaVersion': 1, 'count': len(candidates), 'candidates': candidates}


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.method == 'POST' and request.post_data else None
    requests.append({'method': request.method, 'path': parsed.path, 'body': body})

    if parsed.path == '/admin-rollback-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return
    if parsed.path == '/api/admin/auth/session':
        assert request.method == 'GET'
        assert 'cloud_admin_session=browser-session' in request.headers.get('cookie', '')
        fulfill_json(route, envelope({
            **viewer(),
            'issuedAt': 1_784_440_000_000,
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
        assert request.headers.get('origin') == 'https://stage5e-admin.test'
        route.fulfill(status=204, headers={
            'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            'Cache-Control': 'no-store',
        }, body='')
        return
    if parsed.path == '/api/admin/rollbacks':
        assert request.method == 'GET'
        fulfill_json(route, envelope({
            'viewer': viewer(),
            'result': candidates_result(),
            'capabilities': CAPABILITIES,
        }))
        return
    if parsed.path == '/api/admin/rollbacks/execute':
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://stage5e-admin.test'
        assert request.headers.get('content-type', '').startswith('application/json')
        assert body['schemaVersion'] == 1
        assert body['rollbackRef'] == ROLLBACK_REF
        assert body['requestId'].startswith('rbrq_v1_')
        assert body['reasonCode'] == 'restore_previous_approved_value'
        state['executed'] = True
        fulfill_json(route, envelope({
            'viewer': viewer(),
            'result': {
                'schemaVersion': 1,
                'rollbackRef': ROLLBACK_REF,
                'serviceName': '鹅鸭杀',
                'settleType': 'round',
                'restoredUnitPrice': 100,
                'replacedUnitPrice': 120,
                'restoredFromVersion': 1,
                'replacedVersion': 2,
                'eventVersion': 3,
                'publicVersion': 3,
                'duplicate': False,
            },
            'capabilities': CAPABILITIES,
        }))
        return

    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    context.add_cookies([{
        'name': 'cloud_admin_session',
        'value': 'browser-session',
        'domain': 'stage5e-admin.test',
        'path': '/api/admin',
        'secure': True,
        'httpOnly': True,
        'sameSite': 'Strict',
    }])
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('https://stage5e-admin.test/**', route_handler)
    page.goto('https://stage5e-admin.test/admin-rollback-preview.html', wait_until='domcontentloaded')

    page.get_by_role('button', name='检查/恢复会话', exact=True).click()
    expect(page.locator('#authStatus')).to_contain_text('管理员会话有效', timeout=10_000)
    page.get_by_role('button', name='刷新回滚候选', exact=True).click()
    expect(page.locator('#listStatus')).to_contain_text('1个可回滚项目', timeout=10_000)
    expect(page.locator('.candidate')).to_have_count(1)
    assert 'businessKey' not in page.locator('body').inner_text()
    assert 'contentHash' not in page.locator('body').inner_text()

    page.get_by_role('button', name='回滚到上一批准值', exact=True).click()
    expect(page.locator('#mutationStatus')).to_contain_text('回滚完成', timeout=10_000)
    expect(page.locator('#mutationStatus')).to_contain_text('已从 120 恢复为 100')
    expect(page.locator('#mutationStatus')).to_contain_text('公共版本：3')
    expect(page.locator('#listStatus')).to_contain_text('0个可回滚项目')
    expect(page.locator('.candidate')).to_have_count(0)

    page.get_by_role('button', name='退出并清除会话', exact=True).click()
    expect(page.locator('#authStatus')).to_contain_text('已退出', timeout=10_000)
    expect(page.locator('#resultCard')).to_have_class('card hidden')

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert local_values == []
    mutation_requests = [item for item in requests if item['path'] == '/api/admin/rollbacks/execute']
    assert len(mutation_requests) == 1
    assert mutation_requests[0]['method'] == 'POST'
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5E',
    'authenticatedSessionUsed': True,
    'redactedCandidateListPassed': True,
    'rollbackMutationPassed': True,
    'finalStatusNotOverwritten': True,
    'exactAccessibleNamePassed': True,
    'browserStorageEmpty': True,
    'logoutClearedView': True,
}, ensure_ascii=False))
