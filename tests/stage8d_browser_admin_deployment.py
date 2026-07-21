from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'deploy' / 'admin' / '.edgeone-admin-artifact'
FILES = {
    '/': ('text/html; charset=utf-8', OUTPUT / 'index.html'),
    '/index.html': ('text/html; charset=utf-8', OUTPUT / 'index.html'),
    '/production-console.css': ('text/css; charset=utf-8', OUTPUT / 'production-console.css'),
    '/production-console.js': ('text/javascript; charset=utf-8', OUTPUT / 'production-console.js'),
    '/admin-release.json': ('application/json; charset=utf-8', OUTPUT / 'admin-release.json'),
}

for _, file_path in FILES.values():
    assert file_path.is_file(), file_path

requests = []
console_errors = []


def route_handler(route, request):
    parsed = urlparse(request.url)
    requests.append({'method': request.method, 'path': parsed.path, 'host': parsed.hostname})
    if parsed.path == '/api/admin/auth/session':
        route.fulfill(
            status=401,
            content_type='application/json; charset=utf-8',
            headers={
                'Cache-Control': 'no-store',
                'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            },
            body=json.dumps({
                'ok': False,
                'serviceId': 'cloud-collab-admin-auth-production',
                'apiVersion': '2026-07-21-stage8d-browser',
                'error': {'code': 'ADMIN_SESSION_MISSING', 'message': '管理员会话不存在'},
            }, ensure_ascii=False),
        )
        return
    static = FILES.get(parsed.path)
    if static:
        content_type, file_path = static
        route.fulfill(
            status=200,
            content_type=content_type,
            headers={'Cache-Control': 'no-store'},
            body=file_path.read_bytes(),
        )
        return
    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=chromium_path,
        args=['--no-sandbox'],
    )
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.route('https://admin.example.invalid/**', route_handler)
    response = page.goto('https://admin.example.invalid/', wait_until='networkidle')
    assert response is not None and response.status == 200

    expect(page).to_have_title('码单器正式管理员控制台')
    expect(page.locator('#authStatus')).to_contain_text('当前没有有效管理员会话', timeout=10_000)
    expect(page.locator('#sessionChip')).to_have_text('未登录')
    expect(page.get_by_role('button', name='精确价格审核')).to_be_disabled()
    expect(page.get_by_role('button', name='敏感人工审核')).to_be_disabled()
    expect(page.get_by_role('button', name='设备治理')).to_be_disabled()
    expect(page.get_by_role('button', name='公共数据回滚')).to_be_disabled()
    expect(page.get_by_role('button', name='完整迁移导出')).to_be_disabled()

    assert page.locator('link[href="./production-console.css"]').count() == 1
    assert page.locator('script[src="./production-console.js"]').count() == 1
    assert page.locator('script:not([src])').count() == 0
    assert page.locator('style').count() == 0
    assert page.evaluate("getComputedStyle(document.querySelector('.card')).borderRadius") != '0px'

    storage = context.storage_state()
    assert all(not origin.get('localStorage') for origin in storage.get('origins', []))
    assert not console_errors, console_errors
    assert all(item['host'] == 'admin.example.invalid' for item in requests)
    assert any(item['path'] == '/production-console.css' for item in requests)
    assert any(item['path'] == '/production-console.js' for item in requests)
    assert any(item['path'] == '/api/admin/auth/session' for item in requests)
    assert not any(item['path'].startswith('/api/device/') for item in requests)
    assert not any(item['path'].startswith('/api/submissions/') for item in requests)

    context.close()
    browser.close()

print(json.dumps({
    'stage': '8D',
    'deploymentArtifactLoaded': True,
    'sameOriginCssLoaded': True,
    'sameOriginScriptLoaded': True,
    'initialMissingSessionVisible': True,
    'privilegedNavigationLocked': True,
    'browserStorageEmpty': True,
    'externalRequests': 0,
    'consoleErrors': 0,
}, ensure_ascii=False))
