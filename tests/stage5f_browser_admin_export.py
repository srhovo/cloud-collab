from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-export-preview.html').read_text(encoding='utf-8')
CONFIRMATION = 'EXPORT_SYNTHETIC_PUBLIC_DATABASE'
PACKAGE_ID = f"pkg_v1_{'A' * 43}"
ZIP_BYTES = b'PK\x03\x04stage5f-browser-zip'
requests = []

CAPABILITIES = {
    'exportSummaryRead': True,
    'exportDownload': True,
    'publicMutationAllowed': False,
    'deviceMutation': False,
    'reviewMutation': False,
    'rollbackMutation': False,
    'syntheticFixtureOnly': True,
}


def fulfill_json(route, data, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(data, ensure_ascii=False),
    )


def envelope(data, service='cloud-collab-admin-export-preview'):
    return {
        'ok': True,
        'serviceId': service,
        'apiVersion': '2026-07-20-stage5f-browser',
        'data': data,
    }


def viewer():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'sessionIdSuffix': '5F01',
        'expiresAt': 1_784_460_900_000,
    }


def summary_result():
    return {
        'schemaVersion': 1,
        'packageId': PACKAGE_ID,
        'groupId': 'group_fixture',
        'libraryId': 'lib_receive_fixture',
        'publicVersion': 3,
        'eventCount': 3,
        'recordCount': 1,
        'rollbackCount': 1,
        'fileCount': 9,
        'packageByteLength': len(ZIP_BYTES),
        'generatedAt': '2026-07-20T02:00:00.000Z',
    }


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.method == 'POST' and request.post_data else None
    requests.append({'method': request.method, 'path': parsed.path, 'body': body})

    if parsed.path == '/admin-export-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return
    if parsed.path == '/api/admin/auth/session':
        assert request.method == 'GET'
        assert 'cloud_admin_session=browser-session' in request.headers.get('cookie', '')
        fulfill_json(route, envelope({
            **viewer(),
            'issuedAt': 1_784_460_000_000,
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
        route.fulfill(status=204, headers={
            'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            'Cache-Control': 'no-store',
        }, body='')
        return
    if parsed.path == '/api/admin/exports/summary':
        assert request.method == 'GET'
        fulfill_json(route, envelope({
            'viewer': viewer(),
            'result': summary_result(),
            'capabilities': CAPABILITIES,
        }))
        return
    if parsed.path == '/api/admin/exports/download':
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://stage5f-admin.test'
        assert request.headers.get('content-type', '').startswith('application/json')
        assert set(body.keys()) == {'schemaVersion', 'requestId', 'confirmation'}
        assert body['schemaVersion'] == 1
        assert body['requestId'].startswith('exrq_v1_')
        assert body['confirmation'] == CONFIRMATION
        route.fulfill(
            status=200,
            headers={
                'Content-Type': 'application/zip',
                'Content-Disposition': "attachment; filename*=UTF-8''%E7%A0%81%E5%8D%95%E5%99%A8%E5%85%AC%E5%85%B1%E6%95%B0%E6%8D%AE%E5%BA%93%E5%AF%BC%E5%87%BA.zip",
                'X-Mdq-Package-Id': PACKAGE_ID,
                'X-Mdq-Public-Version': '3',
                'X-Mdq-File-Count': '9',
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
    context.add_cookies([{
        'name': 'cloud_admin_session',
        'value': 'browser-session',
        'domain': 'stage5f-admin.test',
        'path': '/api/admin',
        'secure': True,
        'httpOnly': True,
        'sameSite': 'Strict',
    }])
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('https://stage5f-admin.test/**', route_handler)
    page.goto('https://stage5f-admin.test/admin-export-preview.html', wait_until='domcontentloaded')

    page.get_by_role('button', name='检查/恢复会话', exact=True).click()
    expect(page.locator('#authStatus')).to_contain_text('管理员会话有效', timeout=10_000)
    page.get_by_role('button', name='刷新导出摘要', exact=True).click()
    expect(page.locator('#summaryStatus')).to_contain_text('公共版本 3', timeout=10_000)
    expect(page.locator('#publicVersion')).to_have_text('3')
    expect(page.locator('#fileCount')).to_have_text('9')

    with page.expect_download(timeout=10_000) as download_info:
        page.get_by_role('button', name='下载标准导出包', exact=True).click()
    download = download_info.value
    expect(page.locator('#downloadStatus')).to_contain_text('下载完成', timeout=10_000)
    expect(page.locator('#downloadStatus')).to_contain_text('公共版本 3')
    assert download.suggested_filename == '码单器公共数据库导出.zip'

    page.get_by_role('button', name='退出并清除会话', exact=True).click()
    expect(page.locator('#authStatus')).to_contain_text('已退出', timeout=10_000)
    expect(page.locator('#summary')).to_have_class('hidden')

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert local_values == []
    download_requests = [item for item in requests if item['path'] == '/api/admin/exports/download']
    assert len(download_requests) == 1
    assert download_requests[0]['body']['confirmation'] == CONFIRMATION
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5F',
    'authenticatedSessionUsed': True,
    'summaryReadPassed': True,
    'fixedConfirmationPassed': True,
    'zipDownloadPassed': True,
    'finalStatusNotOverwritten': True,
    'exactAccessibleNamePassed': True,
    'browserStorageEmpty': True,
    'logoutClearedView': True,
}, ensure_ascii=False))
