from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'stage5def-cleanup.html').read_text(encoding='utf-8')
ORIGIN = 'https://stage5def-cleanup.test'
CLEANUP_KEY = 'stage5def-browser-cleanup-key-01234567890'
PUBLIC_DIGEST = 'A' * 43
ADMIN_DIGEST = 'B' * 43
state = {'cleaned': False, 'inspect_count': 0, 'execute_count': 0}
requests = []


def payload(action, result):
    return {
        'ok': True,
        'serviceId': 'cloud-collab-stage5def-cleanup',
        'apiVersion': 'test-v1',
        'action': action,
        'data': {
            'result': result,
            'acceptanceEnabled': False,
            'adminCapabilitiesEnabled': False,
            'cleanupOnly': True,
        },
    }


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.post_data else None
    requests.append({'method': request.method, 'path': parsed.path, 'query': parsed.query, 'body': body})

    if parsed.path == '/stage5def-cleanup.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return

    if parsed.path == '/api/stage5def/cleanup':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert request.headers.get('x-cloud-stage5def-cleanup-key') == CLEANUP_KEY
        assert body['schemaVersion'] == 1
        assert body['confirmation'] == 'DELETE_STAGE5DEF_SYNTHETIC_PREVIEW_V1'
        assert 'eo_token=test-token' in parsed.query
        assert 'eo_time=1784500000' in parsed.query
        if body['action'] == 'inspect':
            state['inspect_count'] += 1
            result = {
                'schemaVersion': 1,
                'publicObjectCount': 0 if state['cleaned'] else 37,
                'publicKeySetDigest': '0' * 43 if state['cleaned'] else PUBLIC_DIGEST,
                'adminObjectCount': 0 if state['cleaned'] else 1,
                'adminKeySetDigest': '0' * 43 if state['cleaned'] else ADMIN_DIGEST,
                'totalObjectCount': 0 if state['cleaned'] else 38,
                'readyToExecute': True,
            }
            route.fulfill(status=200, content_type='application/json', body=json.dumps(payload('inspect', result)))
            return
        assert body['action'] == 'execute'
        assert body['expectedPublicKeySetDigest'] == PUBLIC_DIGEST
        assert body['expectedAdminKeySetDigest'] == ADMIN_DIGEST
        state['execute_count'] += 1
        state['cleaned'] = True
        result = {
            'schemaVersion': 1,
            'publicDeletedCount': 37,
            'adminDeletedCount': 1,
            'totalDeletedCount': 38,
            'publicRemainingCount': 0,
            'adminRemainingCount': 0,
            'publicKeySetDigest': '0' * 43,
            'adminKeySetDigest': '0' * 43,
            'cleanupComplete': True,
        }
        route.fulfill(status=200, content_type='application/json', body=json.dumps(payload('execute', result)))
        return

    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route(f'{ORIGIN}/**', route_handler)
    page.goto(f'{ORIGIN}/stage5def-cleanup.html?eo_token=test-token&eo_time=1784500000', wait_until='domcontentloaded')

    page.locator('#cleanupKey').fill(CLEANUP_KEY)
    expect(page.get_by_role('button', name='按检查摘要执行删除', exact=True)).to_be_disabled()

    page.get_by_role('button', name='强一致检查两套Blob', exact=True).click()
    expect(page.locator('#status')).to_contain_text('公共对象：37', timeout=10_000)
    expect(page.locator('#status')).to_contain_text('管理员对象：1')
    expect(page.get_by_role('button', name='按检查摘要执行删除', exact=True)).to_be_enabled()

    page.get_by_role('button', name='按检查摘要执行删除', exact=True).click()
    expect(page.locator('#status')).to_contain_text('公共删除：37', timeout=10_000)
    expect(page.locator('#status')).to_contain_text('管理员删除：1')
    expect(page.get_by_role('button', name='按检查摘要执行删除', exact=True)).to_be_disabled()

    page.get_by_role('button', name='再次强一致复查', exact=True).click()
    expect(page.locator('#status')).to_contain_text('第1次独立强一致复查通过', timeout=10_000)
    page.get_by_role('button', name='再次强一致复查', exact=True).click()
    expect(page.locator('#status')).to_contain_text('第2次独立强一致复查通过', timeout=10_000)
    expect(page.locator('#status')).to_contain_text('两次复查均为0')

    page.get_by_role('button', name='清除页面内存状态', exact=True).click()
    expect(page.locator('#cleanupKey')).to_have_value('')
    expect(page.locator('#status')).to_contain_text('已清除页面内存状态')

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert local_values == []
    assert state['execute_count'] == 1
    assert state['inspect_count'] == 3
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5DEF-cleanup',
    'inspectBeforeDeletePassed': True,
    'digestBoundDeletePassed': True,
    'twoIndependentZeroChecksPassed': True,
    'previewTokenForwardingPassed': True,
    'browserStorageEmpty': True,
    'memoryClearPassed': True,
}, ensure_ascii=False))
