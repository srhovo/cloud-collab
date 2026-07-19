from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import os
import re

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
DEVICE_HTML = (ROOT / 'dist' / 'stage5bc-device-acceptance.html').read_text(encoding='utf-8')
ADMIN_HTML = (ROOT / 'dist' / 'stage5bc-admin-acceptance.html').read_text(encoding='utf-8')
CLEANUP_HTML = (ROOT / 'dist' / 'stage5bc-cleanup.html').read_text(encoding='utf-8')
PREVIEW_KEY = 'stage5bc-browser-preview-key-0123456789'
CLEANUP_KEY = 'stage5bc-browser-cleanup-key-0123456789'
DEVICE_ID = 'dev_01JABCDEF0123456789XYZABCD'
DEVICE_TOKEN = f"dt_v1_{'T' * 43}"
REVIEWS = [
    {'id': f"rv_v1_{'A' * 43}", 'service': '阶段5BC-TEST-approve', 'price': 100},
    {'id': f"rv_v1_{'B' * 43}", 'service': '阶段5BC-TEST-reject', 'price': 200},
    {'id': f"rv_v1_{'C' * 43}", 'service': '阶段5BC-TEST-edit', 'price': 300},
]
READ_CAPS = {
    'reviewQueueRead': True,
    'reviewDetailRead': True,
    'reviewMutation': False,
    'deviceMutation': False,
    'rollback': False,
    'export': False,
    'publicMutationAllowed': False,
}
MUTATION_CAPS = {
    'reviewQueueRead': True,
    'reviewDetailRead': True,
    'reviewMutation': True,
    'reviewApprove': True,
    'reviewReject': True,
    'reviewEditAndApprove': True,
    'deviceMutation': False,
    'rollback': False,
    'export': False,
    'publicMutationAllowed': True,
    'syntheticFixtureOnly': True,
}


def envelope(data, service='stage5bc-browser'):
    return {'ok': True, 'serviceId': service, 'apiVersion': '2026-07-19-browser', 'data': data}


def fulfill_json(route, data, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(data, ensure_ascii=False),
    )


def public_payload(version):
    records = [
        {
            'businessKey': f"bk_v1_{str(index) * 43}",
            'contentHash': f"ch_v1_{chr(65 + index) * 43}",
            'approvedVersion': index,
            'payload': {'serviceName': f'合成{index}', 'settleType': 'round', 'unitPrice': 100 + index},
        }
        for index in range(1, version + 1)
    ]
    changes = [
        {
            'version': index,
            'businessKey': records[index - 1]['businessKey'],
            'contentHash': records[index - 1]['contentHash'],
            'payload': records[index - 1]['payload'],
        }
        for index in range(1, version + 1)
    ]
    return records, changes


def run_device_test(browser):
    requests = []
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)

    def handler(route, request):
        parsed = urlparse(request.url)
        requests.append({'method': request.method, 'path': parsed.path, 'headers': request.headers, 'body': request.post_data})
        if parsed.path == '/stage5bc-device-acceptance.html':
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=DEVICE_HTML)
            return
        if parsed.path == '/api/stage5bc/acceptance/device-register':
            assert request.method == 'POST'
            assert request.headers.get('x-cloud-collab-preview-key') == PREVIEW_KEY
            body = request.post_data_json
            assert body['deviceId'].startswith('dev_')
            fulfill_json(route, envelope({
                'schemaVersion': 1,
                'deviceId': DEVICE_ID,
                'deviceToken': DEVICE_TOKEN,
                'expiresAt': 1_792_000_000_000,
                'publicMutationAllowed': False,
                'autoApprovalEnabled': False,
            }))
            return
        if parsed.path == '/api/stage5bc/acceptance/submissions-create':
            assert request.headers.get('authorization') == f'Bearer {DEVICE_TOKEN}'
            assert request.headers.get('x-cloud-collab-preview-key') == PREVIEW_KEY
            body = request.post_data_json
            assert body['deviceId'] == DEVICE_ID
            assert body['groupId'] == 'group_fixture'
            assert body['libraryId'] == 'lib_receive_fixture'
            assert body['payload'] == {'serviceName': '阶段5BC-TEST-approve', 'settleType': 'round', 'unitPrice': 100}
            assert re.fullmatch(r'bk_v1_[A-Za-z0-9_-]{43}', body['businessKey'])
            assert re.fullmatch(r'ch_v1_[A-Za-z0-9_-]{43}', body['contentHash'])
            assert re.fullmatch(r'ik_v1_[A-Za-z0-9_-]{43}', body['idempotencyKey'])
            fulfill_json(route, envelope({
                'status': 'waiting_confirmation',
                'reason': 'second_device_required',
                'previewPublicVersion': 0,
                'publicMutationAllowed': False,
                'autoApprovalEnabled': False,
            }), status=202)
            return
        if parsed.path.startswith('/api/stage5bc/acceptance/public-'):
            assert request.headers.get('x-cloud-collab-preview-key') == PREVIEW_KEY
            query = parse_qs(parsed.query)
            assert query['groupId'] == ['group_fixture']
            assert query['libraryId'] == ['lib_receive_fixture']
            records, changes = public_payload(2)
            if parsed.path.endswith('public-version'):
                data = {'publicVersion': 2}
            elif parsed.path.endswith('public-snapshot'):
                data = {'publicVersion': 2, 'snapshot': {'publicVersion': 2, 'records': records}}
            else:
                data = {'publicVersion': 2, 'nextVersion': 2, 'changes': changes}
            fulfill_json(route, envelope(data))
            return
        route.fulfill(status=404, body='not found')

    page.route('https://stage5bc.test/**', handler)
    page.goto('https://stage5bc.test/stage5bc-device-acceptance.html', wait_until='domcontentloaded')
    page.locator('#role').select_option('A')
    page.locator('#batch').fill('TEST')
    page.locator('#previewKey').fill(PREVIEW_KEY)
    page.get_by_role('button', name='建立本设备验收会话').click()
    expect(page.locator('#sessionStatus')).to_contain_text('设备A已就绪', timeout=10_000)
    assert page.locator('#previewKey').input_value() == ''
    assert PREVIEW_KEY not in page.evaluate('JSON.stringify(sessionStorage) + JSON.stringify(localStorage)')
    stored = json.loads(page.evaluate("sessionStorage.getItem('stage5bcAcceptanceDeviceV1')"))
    assert stored['deviceToken'] == DEVICE_TOKEN

    page.get_by_role('button', name='1. 批准组').click()
    expect(page.locator('#submitStatus')).to_contain_text('waiting_confirmation', timeout=10_000)
    page.get_by_role('button', name='读取版本、快照与增量').click()
    expect(page.locator('#readStatus')).to_contain_text('一致性通过', timeout=10_000)
    assert re.fullmatch(r'[0-9a-f]{16}', page.locator('#fingerprint').inner_text())

    page.get_by_role('button', name='清除本机设备数据').click()
    expect(page.locator('#sessionStatus')).to_contain_text('已清除', timeout=10_000)
    assert page.evaluate("sessionStorage.getItem('stage5bcAcceptanceDeviceV1')") is None
    assert not console_errors, console_errors
    assert any(item['path'].endswith('device-register') for item in requests)
    assert any(item['path'].endswith('submissions-create') for item in requests)
    context.close()


def review_item(item):
    return {
        'reviewId': item['id'],
        'status': 'pending_review',
        'reason': 'candidate_conflict',
        'groupId': 'group_fixture',
        'libraryId': 'lib_receive_fixture',
        'businessKey': f"bk_v1_{item['id'][-1] * 43}",
        'contentHash': f"ch_v1_{item['id'][-1] * 43}",
        'dataType': 'exact_price',
        'operation': 'upsert',
        'serviceName': item['service'],
        'settleType': 'round',
        'candidateUnitPrice': item['price'],
        'baseline': {'approvedVersion': 0, 'contentHash': None, 'unitPrice': None, 'stillCurrent': True},
        'distinctDeviceCount': 1,
        'deviceTags': ['设备-TEST0001'],
        'createdAt': '2026-07-19T12:00:00.000Z',
        'receivedAt': '2026-07-19T11:59:59.000Z',
    }


def run_admin_test(browser):
    remaining = [dict(item) for item in REVIEWS]
    mutation_attempts = {}
    mutation_requests = []
    public_version = {'value': 0}
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    page.on('dialog', lambda dialog: dialog.accept())
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)

    def auth_data():
        return {
            'authenticated': True,
            'username': 'admin@example.test',
            'issuedAt': 1_784_423_600_000,
            'expiresAt': 1_784_424_500_000,
            'sessionIdSuffix': '5BC1',
            'capabilities': {
                'reviewQueueRead': False,
                'reviewMutation': False,
                'deviceMutation': False,
                'rollback': False,
                'export': False,
                'publicMutationAllowed': False,
            },
        }

    def review_data(items):
        return {
            'viewer': {'authenticated': True, 'username': 'admin@example.test', 'sessionIdSuffix': '5BC1', 'expiresAt': 1_784_424_500_000},
            'scope': {'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture', 'syntheticFixtureOnly': True},
            'total': len(items),
            'items': [review_item(item) for item in items],
            'capabilities': READ_CAPS,
        }

    def handler(route, request):
        parsed = urlparse(request.url)
        if parsed.path == '/stage5bc-admin-acceptance.html':
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=ADMIN_HTML)
            return
        if parsed.path == '/api/admin/auth/session':
            if 'cloud_admin_session=browser-session' in request.headers.get('cookie', ''):
                fulfill_json(route, envelope(auth_data()))
            else:
                fulfill_json(route, {
                    'ok': False,
                    'serviceId': 'admin-auth',
                    'apiVersion': 'v1',
                    'error': {'code': 'ADMIN_SESSION_MISSING', 'message': 'no session'},
                }, status=401)
            return
        if parsed.path == '/api/admin/auth/login':
            assert request.method == 'POST'
            assert request.headers.get('origin') == 'https://stage5bc.test'
            assert request.post_data_json == {
                'schemaVersion': 1,
                'username': 'admin@example.test',
                'password': 'browser-admin-password-12345',
            }
            fulfill_json(route, envelope(auth_data()), headers={
                'Set-Cookie': 'cloud_admin_session=browser-session; Path=/api/admin; Max-Age=900; HttpOnly; Secure; SameSite=Strict',
            })
            return
        if parsed.path == '/api/admin/reviews' and request.method == 'GET':
            fulfill_json(route, envelope(review_data(remaining)))
            return
        if parsed.path == '/api/admin/reviews/detail':
            review_id = parse_qs(parsed.query)['id'][0]
            item = next(item for item in remaining if item['id'] == review_id)
            data = review_data([])
            data.update({
                'review': review_item(item),
                'variantCount': 2,
                'variants': [
                    {'candidateUnitPrice': item['price'], 'deviceTags': ['设备-TEST0001'], 'contentHash': f"ch_v1_{'D' * 43}"},
                    {'candidateUnitPrice': item['price'] + 1, 'deviceTags': ['设备-TEST0002'], 'contentHash': f"ch_v1_{'E' * 43}"},
                ],
            })
            fulfill_json(route, envelope(data))
            return
        mutation_paths = {
            '/api/admin/reviews/approve': 'approve',
            '/api/admin/reviews/reject': 'reject',
            '/api/admin/reviews/edit-and-approve': 'edit_and_approve',
        }
        if parsed.path in mutation_paths:
            assert request.method == 'POST'
            assert request.headers.get('origin') == 'https://stage5bc.test'
            body = request.post_data_json
            action = mutation_paths[parsed.path]
            review_id = body['reviewId']
            key = json.dumps(body, sort_keys=True)
            attempt = mutation_attempts.get(key, 0) + 1
            mutation_attempts[key] = attempt
            mutation_requests.append((parsed.path, body, attempt))
            if attempt == 1:
                remaining[:] = [item for item in remaining if item['id'] != review_id]
                if action != 'reject':
                    public_version['value'] += 1
            result = {
                'reviewId': review_id,
                'decisionId': f"rd_v1_{'D' * 43}",
                'auditId': f"au_v1_{'E' * 43}",
                'action': action,
                'status': {'approve': 'approved_by_admin', 'reject': 'rejected', 'edit_and_approve': 'edited_and_approved'}[action],
                'targetContentHash': None if action == 'reject' else f"ch_v1_{'F' * 43}",
                'publicVersion': public_version['value'],
                'eventVersion': None if action == 'reject' else public_version['value'],
                'approvalId': None if action == 'reject' else f"ap_v1_{'G' * 43}",
                'publicMutationApplied': action != 'reject',
                'resolvedReviewCount': 1,
                'duplicate': attempt == 2,
            }
            data = {
                'viewer': {'authenticated': True, 'username': 'admin@example.test', 'sessionIdSuffix': '5BC1', 'expiresAt': 1_784_424_500_000},
                'result': result,
                'capabilities': MUTATION_CAPS,
            }
            fulfill_json(route, envelope(data))
            return
        if parsed.path.startswith('/api/stage5bc/acceptance/public-'):
            assert request.headers.get('x-cloud-collab-preview-key') == PREVIEW_KEY
            version = public_version['value']
            records, changes = public_payload(version)
            if parsed.path.endswith('public-version'):
                data = {'publicVersion': version}
            elif parsed.path.endswith('public-snapshot'):
                data = {'publicVersion': version, 'snapshot': None if version == 0 else {'publicVersion': version, 'records': records}}
            else:
                data = {'publicVersion': version, 'nextVersion': version, 'changes': changes}
            fulfill_json(route, envelope(data))
            return
        if parsed.path == '/api/admin/auth/logout':
            route.fulfill(status=204, headers={
                'Set-Cookie': 'cloud_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
                'Cache-Control': 'no-store',
            }, body='')
            return
        route.fulfill(status=404, body='not found')

    page.route('https://stage5bc.test/**', handler)
    page.goto('https://stage5bc.test/stage5bc-admin-acceptance.html', wait_until='domcontentloaded')
    expect(page.locator('#authStatus')).to_contain_text('没有有效管理员会话', timeout=10_000)
    page.locator('#username').fill('admin@example.test')
    page.locator('#password').fill('browser-admin-password-12345')
    page.get_by_role('button', name='同源安全登录').click()
    expect(page.locator('#authStatus')).to_contain_text('登录成功', timeout=10_000)
    assert page.locator('#password').input_value() == ''
    expect(page.locator('.review')).to_have_count(3)

    page.reload(wait_until='domcontentloaded')
    expect(page.locator('#authStatus')).to_contain_text('刷新恢复通过', timeout=10_000)
    expect(page.locator('.review')).to_have_count(3)

    page.locator('#previewKey').fill(PREVIEW_KEY)
    page.get_by_role('button', name='载入预览密钥到内存').click()
    expect(page.locator('#publicStatus')).to_contain_text('页面内存', timeout=10_000)
    assert page.locator('#previewKey').input_value() == ''
    assert PREVIEW_KEY not in page.evaluate('JSON.stringify(sessionStorage) + JSON.stringify(localStorage)')

    approve_card = page.locator('.review').filter(has_text='阶段5BC-TEST-approve')
    approve_card.get_by_role('button', name='读取5B详情').click()
    expect(page.locator('#actionStatus')).to_contain_text('详情读取通过', timeout=10_000)
    approve_card.get_by_role('button', name='批准并重放').click()
    expect(page.locator('#actionStatus')).to_contain_text('未产生重复版本', timeout=10_000)

    reject_card = page.locator('.review').filter(has_text='阶段5BC-TEST-reject')
    reject_card.get_by_role('button', name='拒绝并重放').click()
    expect(page.locator('#actionStatus')).to_contain_text('公共版本 1 → 1', timeout=10_000)

    edit_card = page.locator('.review').filter(has_text='阶段5BC-TEST-edit')
    edit_card.get_by_label('阶段5BC-TEST-edit 编辑后单价').fill('305.5')
    edit_card.get_by_role('button', name='编辑后批准并重放').click()
    expect(page.locator('#actionStatus')).to_contain_text('公共版本 1 → 2', timeout=10_000)
    expect(page.locator('.review')).to_have_count(0)

    page.get_by_role('button', name='强一致读取并计算指纹').click()
    expect(page.locator('#publicStatus')).to_contain_text('动态读取一致', timeout=10_000)
    assert page.locator('#version').inner_text() == '2'
    assert len(mutation_requests) == 6
    for index in range(0, 6, 2):
        first, second = mutation_requests[index], mutation_requests[index + 1]
        assert first[0] == second[0]
        assert first[1] == second[1]
        assert first[2] == 1 and second[2] == 2

    page.get_by_role('button', name='退出并清除会话').click()
    expect(page.locator('#authStatus')).to_contain_text('已退出', timeout=10_000)
    assert not console_errors, console_errors
    context.close()


def run_cleanup_test(browser):
    cleaned = {'value': False}
    calls = []
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    page.on('dialog', lambda dialog: dialog.accept())
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)

    def handler(route, request):
        parsed = urlparse(request.url)
        if parsed.path == '/stage5bc-cleanup.html':
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=CLEANUP_HTML)
            return
        if parsed.path == '/api/stage5bc/cleanup':
            assert request.method == 'POST'
            assert request.headers.get('origin') == 'https://stage5bc.test'
            assert request.headers.get('x-cloud-stage5bc-cleanup-key') == CLEANUP_KEY
            body = request.post_data_json
            calls.append(body)
            common = {
                'acceptanceEnabled': False,
                'publicMutationAllowed': False,
                'reviewMutationAllowed': False,
                'cleanupOnly': True,
            }
            if body['action'] == 'execute':
                assert body['expectedPublicKeySetDigest'] == 'P' * 43
                assert body['expectedAdminKeySetDigest'] == 'A' * 43
                cleaned['value'] = True
                data = {
                    'completed': True,
                    'publicDeletedCount': 5,
                    'adminDeletedCount': 1,
                    'deletedObjectCount': 6,
                    'publicRemainingCount': 0,
                    'adminRemainingCount': 0,
                    'remainingObjectCount': 0,
                    **common,
                }
            else:
                count_public = 0 if cleaned['value'] else 5
                count_admin = 0 if cleaned['value'] else 1
                data = {
                    'publicObjectCount': count_public,
                    'adminObjectCount': count_admin,
                    'totalObjectCount': count_public + count_admin,
                    'publicKeySetDigest': 'P' * 43,
                    'adminKeySetDigest': 'A' * 43,
                    'readyToExecute': True,
                    **common,
                }
            fulfill_json(route, {'ok': True, 'serviceId': 'cleanup', 'apiVersion': 'v1', 'data': data})
            return
        route.fulfill(status=404, body='not found')

    page.route('https://stage5bc.test/**', handler)
    page.goto('https://stage5bc.test/stage5bc-cleanup.html', wait_until='domcontentloaded')
    page.locator('#cleanupKey').fill(CLEANUP_KEY)
    page.get_by_role('button', name='1. 强一致检查两套Blob').click()
    expect(page.locator('#status')).to_contain_text('公共合成5个、管理员合成1个', timeout=10_000)
    assert page.locator('#cleanupKey').input_value() == ''
    assert CLEANUP_KEY not in page.evaluate('JSON.stringify(sessionStorage) + JSON.stringify(localStorage)')

    page.get_by_role('button', name='2. 按检查摘要执行删除').click()
    expect(page.locator('#status')).to_contain_text('强一致剩余0', timeout=10_000)
    page.get_by_role('button', name='3. 二次强一致复查').click()
    expect(page.locator('#status')).to_contain_text('二次强一致复查通过', timeout=10_000)
    assert [call['action'] for call in calls] == ['inspect', 'execute', 'inspect']
    assert not console_errors, console_errors
    context.close()


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    run_device_test(browser)
    run_admin_test(browser)
    run_cleanup_test(browser)
    browser.close()

print(json.dumps({
    'stage': '5BC',
    'devicePage': 'passed',
    'adminReplay': 'passed',
    'dualBlobCleanup': 'passed',
}, ensure_ascii=False))
