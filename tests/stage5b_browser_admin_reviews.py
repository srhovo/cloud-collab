from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-reviews-preview.html').read_text(encoding='utf-8')
REVIEW_A = f"rv_v1_{'A' * 43}"
REVIEW_B = f"rv_v1_{'B' * 43}"
requests = []


CAPABILITIES = {
    'reviewQueueRead': True,
    'reviewDetailRead': True,
    'reviewMutation': False,
    'deviceMutation': False,
    'rollback': False,
    'export': False,
    'publicMutationAllowed': False,
}


def fulfill_json(route, data, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(data, ensure_ascii=False),
    )


def envelope(data, service='cloud-collab-admin-review-preview'):
    return {
        'ok': True,
        'serviceId': service,
        'apiVersion': '2026-07-19-stage5b-browser',
        'data': data,
    }


def identity():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'issuedAt': 1_784_420_000_000,
        'expiresAt': 1_784_420_900_000,
        'sessionIdSuffix': 'B5R1',
        'capabilities': {
            'reviewQueueRead': False,
            'reviewMutation': False,
            'deviceMutation': False,
            'rollback': False,
            'export': False,
            'publicMutationAllowed': False,
        },
    }


def review_item(review_id, price, tag):
    return {
        'reviewId': review_id,
        'status': 'pending_review',
        'reason': 'candidate_conflict',
        'groupId': 'group_fixture',
        'libraryId': 'lib_receive_fixture',
        'businessKey': f"bk_v1_{'K' * 43}",
        'contentHash': f"ch_v1_{tag * 43}",
        'dataType': 'exact_price',
        'operation': 'upsert',
        'serviceName': '阶段5B合成服务',
        'settleType': 'round',
        'candidateUnitPrice': price,
        'baseline': {
            'approvedVersion': 0,
            'contentHash': None,
            'unitPrice': None,
            'stillCurrent': True,
        },
        'distinctDeviceCount': 1,
        'deviceTags': [f'设备-{tag * 8}'],
        'createdAt': '2026-07-19T06:00:00.000Z',
        'receivedAt': '2026-07-19T05:59:59.000Z',
    }


ITEMS = [review_item(REVIEW_A, 100, 'A'), review_item(REVIEW_B, 105, 'B')]


def route_handler(route, request):
    parsed = urlparse(request.url)
    requests.append({
        'method': request.method,
        'path': parsed.path,
        'query': parse_qs(parsed.query),
    })
    if parsed.path == '/admin-reviews-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return
    if parsed.path == '/api/admin/auth/session':
        assert 'cloud_admin_session=browser-session' in request.headers.get('cookie', '')
        fulfill_json(route, envelope(identity(), service='cloud-collab-admin-auth-preview'))
        return
    if parsed.path == '/api/admin/reviews':
        fulfill_json(route, envelope({
            'viewer': {
                'authenticated': True,
                'username': 'admin@example.test',
                'sessionIdSuffix': 'B5R1',
                'expiresAt': 1_784_420_900_000,
            },
            'scope': {
                'groupId': 'group_fixture',
                'libraryId': 'lib_receive_fixture',
                'syntheticFixtureOnly': True,
            },
            'total': 2,
            'items': ITEMS,
            'capabilities': CAPABILITIES,
        }))
        return
    if parsed.path == '/api/admin/reviews/detail':
        assert parsed.query == f'id={REVIEW_A}'
        fulfill_json(route, envelope({
            'viewer': {
                'authenticated': True,
                'username': 'admin@example.test',
                'sessionIdSuffix': 'B5R1',
                'expiresAt': 1_784_420_900_000,
            },
            'scope': {
                'groupId': 'group_fixture',
                'libraryId': 'lib_receive_fixture',
                'syntheticFixtureOnly': True,
            },
            'review': ITEMS[0],
            'variants': ITEMS,
            'variantCount': 2,
            'conflictPresent': True,
            'capabilities': CAPABILITIES,
        }))
        return
    if parsed.path == '/api/admin/auth/logout':
        route.fulfill(status=204, headers={
            'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
            'Cache-Control': 'no-store',
        }, body='')
        return
    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    context.add_cookies([{
        'name': 'cloud_admin_session',
        'value': 'browser-session',
        'domain': 'stage5b-admin.test',
        'path': '/api/admin',
        'secure': True,
        'httpOnly': True,
        'sameSite': 'Strict',
    }])
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.route('https://stage5b-admin.test/**', route_handler)
    page.goto('https://stage5b-admin.test/admin-reviews-preview.html', wait_until='domcontentloaded')

    expect(page.locator('#status')).to_contain_text('2 项', timeout=10_000)
    expect(page.locator('#count')).to_have_text('2')
    expect(page.locator('.review')).to_have_count(2)
    expect(page.locator('body')).to_contain_text('阶段5B合成服务')
    expect(page.locator('body')).to_contain_text('100 元/局')
    expect(page.locator('body')).to_contain_text('105 元/局')

    page.locator('.review button').first.click()
    expect(page.locator('#detailSummary')).to_contain_text('2 个候选值', timeout=10_000)
    expect(page.locator('.detail-row')).to_have_count(2)
    body_text = page.locator('body').inner_text()
    for forbidden in [
        'dev_01JABCDEF0123456789XYZABCD',
        'sub_01JABCDEF0123456789XYZABCD',
        'ik_v1_',
        'reviews/',
        'submissions/',
        'stage5b-session-secret',
    ]:
        assert forbidden not in body_text

    page.locator('#logoutBtn').click()
    expect(page.locator('#status')).to_contain_text('已退出', timeout=10_000)
    expect(page.locator('#queueCard')).to_have_class('card hidden')

    storage_state = context.storage_state()
    local_values = [
        item.get('value', '')
        for origin in storage_state.get('origins', [])
        for item in origin.get('localStorage', [])
    ]
    assert local_values == []
    allowed_paths = {
        '/admin-reviews-preview.html',
        '/api/admin/auth/session',
        '/api/admin/auth/logout',
        '/api/admin/reviews',
        '/api/admin/reviews/detail',
    }
    assert all(item['path'] in allowed_paths for item in requests), requests
    assert not any(item['method'] != 'GET' and item['path'] != '/api/admin/auth/logout' for item in requests)
    assert not any(any(term in item['path'] for term in ['/approve', '/reject', '/rollback', '/export', '/devices']) for item in requests)
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5B',
    'authenticatedSessionUsed': True,
    'queueCount': 2,
    'conflictVariantsRendered': 2,
    'readOnlyRoutesOnly': True,
    'fullDeviceIdentifiersAbsent': True,
    'browserStorageEmpty': True,
    'logoutClearedView': True,
}, ensure_ascii=False))
