from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'stage5g6a6b-cleanup.html').read_text(encoding='utf-8')
ORIGIN = 'https://stage5g6a6b-cleanup.test'
CLEANUP_KEY = 'stage5g6a6b-browser-cleanup-key-012345678901'
PUBLIC_DIGEST = 'A' * 43
ADMIN_DIGEST = 'B' * 43
state = {'cleaned': False, 'inspect_count': 0, 'execute_count': 0}
requests = []


def envelope(data):
    return {
        'ok': True,
        'serviceId': 'stage5g6a6b-joint-cleanup',
        'apiVersion': 'test-v1',
        'data': data,
    }


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.post_data else None
    requests.append({'method': request.method, 'path': parsed.path, 'query': parsed.query, 'body': body})

    if parsed.path == '/stage5g6a6b-cleanup.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return

    if parsed.path == '/api/stage5g6a6b/cleanup':
        assert request.method == 'POST'
        assert request.headers.get('origin') == ORIGIN
        assert request.headers.get('x-cloud-stage5g6a6b-cleanup-key') == CLEANUP_KEY
        assert 'eo_token=test-token' in parsed.query
        assert 'eo_time=1785000000' in parsed.query
        if body == {'action': 'inspect'}:
            state['inspect_count'] += 1
            data = {
                'schemaVersion': 1,
                'publicObjectCount': 0 if state['cleaned'] else 42,
                'publicKeySetDigest': '0' * 43 if state['cleaned'] else PUBLIC_DIGEST,
                'adminObjectCount': 0 if state['cleaned'] else 1,
                'adminKeySetDigest': '0' * 43 if state['cleaned'] else ADMIN_DIGEST,
                'totalObjectCount': 0 if state['cleaned'] else 43,
                'readyToExecute': True,
            }
            route.fulfill(status=200, content_type='application/json', body=json.dumps(envelope(data)))
            return
        assert body == {
            'action': 'execute',
            'expectedPublicKeySetDigest': PUBLIC_DIGEST,
            'expectedAdminKeySetDigest': ADMIN_DIGEST,
        }
        state['execute_count'] += 1
        state['cleaned'] = True
        data = {
            'schemaVersion': 1,
            'deletedPublicObjectCount': 42,
            'deletedAdminObjectCount': 1,
            'publicObjectCount': 0,
            'adminObjectCount': 0,
            'totalObjectCount': 0,
            'strongConsistencyVerified': True,
        }
        route.fulfill(status=200, content_type='application/json', body=json.dumps(envelope(data)))
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
    page.goto(f'{ORIGIN}/stage5g6a6b-cleanup.html?eo_token=test-token&eo_time=1785000000', wait_until='domcontentloaded')

    page.locator('#cleanupKey').fill(CLEANUP_KEY)
    expect(page.locator('#executeBtn')).to_be_disabled()

    page.locator('#inspectBtn').click()
    expect(page.locator('#status')).to_contain_text('"publicObjectCount": 42', timeout=10_000)
    expect(page.locator('#status')).to_contain_text('"adminObjectCount": 1')
    expect(page.locator('#executeBtn')).to_be_enabled()

    page.locator('#executeBtn').click()
    expect(page.locator('#status')).to_contain_text('"deletedPublicObjectCount": 42', timeout=10_000)
    expect(page.locator('#status')).to_contain_text('"deletedAdminObjectCount": 1')
    expect(page.locator('#executeBtn')).to_be_disabled()

    page.locator('#verifyBtn').click()
    expect(page.locator('#status')).to_contain_text('第一次独立强一致复查', timeout=10_000)
    expect(page.locator('#status')).to_contain_text('公共 Blob=0')

    page.locator('#verifyAgainBtn').click()
    expect(page.locator('#status')).to_contain_text('第二次独立强一致复查', timeout=10_000)
    expect(page.locator('#status')).to_contain_text('关闭 PR #33')

    page.locator('#clearBtn').click()
    expect(page.locator('#cleanupKey')).to_have_value('')
    expect(page.locator('#status')).to_contain_text('页面内存已清除')

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
    'stage': '5G+6A+6B-cleanup',
    'inspectBeforeDeletePassed': True,
    'digestBoundDeletePassed': True,
    'twoIndependentZeroChecksPassed': True,
    'previewTokenForwardingPassed': True,
    'browserStorageEmpty': True,
    'memoryClearPassed': True,
}, ensure_ascii=False))
