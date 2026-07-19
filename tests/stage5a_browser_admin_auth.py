from pathlib import Path
from urllib.parse import urlparse
import json

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ADMIN_HTML = (ROOT / 'dist' / 'admin-preview.html').read_text(encoding='utf-8')
PASSWORD = 'stage5a-browser-password-0123456789'
requests = []


def fulfill_json(route, data, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(data, ensure_ascii=False),
    )


def envelope(data):
    return {
        'ok': True,
        'serviceId': 'cloud-collab-admin-auth-preview',
        'apiVersion': '2026-07-19-stage5a-browser',
        'data': data,
    }


def identity():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'issuedAt': 1_784_410_000_000,
        'expiresAt': 1_784_410_900_000,
        'sessionIdSuffix': 'A5B1',
        'capabilities': {
            'reviewQueueRead': False,
            'reviewMutation': False,
            'deviceMutation': False,
            'rollback': False,
            'export': False,
            'publicMutationAllowed': False,
        },
    }


def route_handler(route, request):
    path = urlparse(request.url).path
    requests.append({'method': request.method, 'path': path, 'body': request.post_data or ''})
    if path == '/admin-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=ADMIN_HTML)
        return
    if path == '/api/admin/auth/session':
        if 'cloud_admin_session=browser-session' in request.headers.get('cookie', ''):
            fulfill_json(route, envelope(identity()))
        else:
            fulfill_json(route, {
                'ok': False,
                'serviceId': 'cloud-collab-admin-auth-preview',
                'apiVersion': '2026-07-19-stage5a-browser',
                'error': {'code': 'ADMIN_SESSION_MISSING', 'message': '管理员会话不存在'},
            }, status=401)
        return
    if path == '/api/admin/auth/login':
        body = request.post_data_json
        assert body == {'schemaVersion': 1, 'username': 'admin@example.test', 'password': PASSWORD}
        fulfill_json(route, envelope(identity()), headers={
            'Set-Cookie': 'cloud_admin_session=browser-session; Path=/api/admin; Max-Age=900; HttpOnly; Secure; SameSite=Strict',
        })
        return
    if path == '/api/admin/auth/logout':
        route.fulfill(status=204, headers={
            'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            'Cache-Control': 'no-store',
        }, body='')
        return
    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    console_errors = []
    expected_unauthorized_console = []

    def capture_console(message):
        if message.type != 'error':
            return
        if (
            message.text.startswith('Failed to load resource:')
            and '401 (Unauthorized)' in message.text
        ):
            expected_unauthorized_console.append(message.text)
            return
        console_errors.append(message.text)

    page.on('console', capture_console)
    page.route('https://admin-preview.test/**', route_handler)
    page.goto('https://admin-preview.test/admin-preview.html', wait_until='domcontentloaded')
    expect(page.locator('#status')).to_contain_text('没有有效管理员会话', timeout=10_000)

    page.locator('#username').fill('admin@example.test')
    page.locator('#password').fill(PASSWORD)
    page.locator('#loginBtn').click()
    expect(page.locator('#status')).to_contain_text('登录成功', timeout=10_000)
    assert page.locator('#password').input_value() == ''
    assert 'admin@example.test' in page.locator('#identity').text_content()
    assert PASSWORD not in page.locator('body').inner_text()

    page.locator('#sessionBtn').click()
    expect(page.locator('#status')).to_contain_text('会话有效', timeout=10_000)
    page.locator('#logoutBtn').click()
    expect(page.locator('#status')).to_contain_text('已退出', timeout=10_000)

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert all(PASSWORD not in value for value in local_values)
    assert all(item['path'].startswith('/api/admin/auth/') or item['path'] == '/admin-preview.html' for item in requests)
    assert not any('/api/submissions' in item['path'] or '/api/preview' in item['path'] for item in requests)
    assert len(expected_unauthorized_console) == 1, expected_unauthorized_console
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5A',
    'loginSucceeded': True,
    'passwordInputCleared': True,
    'httpOnlySessionObserved': True,
    'sessionCheckSucceeded': True,
    'logoutClearedSession': True,
    'adminRoutesOnly': True,
    'browserStorageSecretFree': True,
}, ensure_ascii=False))
