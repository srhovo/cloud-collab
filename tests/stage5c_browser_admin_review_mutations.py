from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-review-actions-preview.html').read_text(encoding='utf-8')
REVIEW_A = f"rv_v1_{'A' * 43}"
REVIEW_B = f"rv_v1_{'B' * 43}"
REVIEW_C = f"rv_v1_{'C' * 43}"
DECISION = f"rd_v1_{'D' * 43}"
AUDIT = f"au_v1_{'E' * 43}"
APPROVAL = f"ap_v1_{'F' * 43}"
requests = []
items = []
public_version = 0


READ_CAPABILITIES = {
    'reviewQueueRead': True,
    'reviewDetailRead': True,
    'reviewMutation': False,
    'deviceMutation': False,
    'rollback': False,
    'export': False,
    'publicMutationAllowed': False,
}


MUTATION_CAPABILITIES = {
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


def review_item(review_id, service, price, tag):
    return {
        'reviewId': review_id,
        'status': 'pending_review',
        'reason': 'candidate_conflict',
        'groupId': 'group_fixture',
        'libraryId': 'lib_receive_fixture',
        'businessKey': f"bk_v1_{tag * 43}",
        'contentHash': f"ch_v1_{tag * 43}",
        'dataType': 'exact_price',
        'operation': 'upsert',
        'serviceName': service,
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
        'createdAt': '2026-07-19T12:00:00.000Z',
        'receivedAt': '2026-07-19T11:59:59.000Z',
    }


items.extend([
    review_item(REVIEW_A, '合成批准服务', 100, 'A'),
    review_item(REVIEW_B, '合成拒绝服务', 105, 'B'),
    review_item(REVIEW_C, '合成编辑服务', 110, 'C'),
])


def fulfill_json(route, data, status=200, headers=None):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store', **(headers or {})},
        body=json.dumps(data, ensure_ascii=False),
    )


def envelope(data, service):
    return {
        'ok': True,
        'serviceId': service,
        'apiVersion': '2026-07-19-stage5c-browser',
        'data': data,
    }


def identity():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'issuedAt': 1_784_423_600_000,
        'expiresAt': 1_784_424_500_000,
        'sessionIdSuffix': '5C01',
        'capabilities': {
            'reviewQueueRead': False,
            'reviewMutation': False,
            'deviceMutation': False,
            'rollback': False,
            'export': False,
            'publicMutationAllowed': False,
        },
    }


def mutation_result(action, review_id, target_hash):
    global public_version
    if action != 'reject':
        public_version += 1
    status = {
        'approve': 'approved_by_admin',
        'reject': 'rejected',
        'edit_and_approve': 'edited_and_approved',
    }[action]
    return {
        'viewer': {
            'authenticated': True,
            'username': 'admin@example.test',
            'sessionIdSuffix': '5C01',
            'expiresAt': 1_784_424_500_000,
        },
        'result': {
            'reviewId': review_id,
            'decisionId': DECISION,
            'auditId': AUDIT,
            'action': action,
            'status': status,
            'targetContentHash': target_hash,
            'publicVersion': public_version,
            'eventVersion': public_version if action != 'reject' else None,
            'approvalId': APPROVAL if action != 'reject' else None,
            'publicMutationApplied': action != 'reject',
            'resolvedReviewCount': 1,
            'duplicate': False,
        },
        'capabilities': MUTATION_CAPABILITIES,
    }


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.method == 'POST' and request.post_data else None
    requests.append({'method': request.method, 'path': parsed.path, 'body': body})
    if parsed.path == '/admin-review-actions-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return
    if parsed.path == '/api/admin/auth/session':
        assert 'cloud_admin_session=browser-session' in request.headers.get('cookie', '')
        fulfill_json(route, envelope(identity(), 'cloud-collab-admin-auth-preview'))
        return
    if parsed.path == '/api/admin/reviews':
        fulfill_json(route, envelope({
            'viewer': {
                'authenticated': True,
                'username': 'admin@example.test',
                'sessionIdSuffix': '5C01',
                'expiresAt': 1_784_424_500_000,
            },
            'scope': {
                'groupId': 'group_fixture',
                'libraryId': 'lib_receive_fixture',
                'syntheticFixtureOnly': True,
            },
            'total': len(items),
            'items': items,
            'capabilities': READ_CAPABILITIES,
        }, 'cloud-collab-admin-review-preview'))
        return
    mutation_routes = {
        '/api/admin/reviews/approve': ('approve', 'APPROVE'),
        '/api/admin/reviews/reject': ('reject', 'REJECT'),
        '/api/admin/reviews/edit-and-approve': ('edit_and_approve', 'EDIT_AND_APPROVE'),
    }
    if parsed.path in mutation_routes:
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://stage5c-admin.test'
        assert request.headers.get('content-type', '').startswith('application/json')
        action, confirmation = mutation_routes[parsed.path]
        assert body.get('confirmation') == confirmation
        review_id = body.get('reviewId')
        if action == 'reject':
            assert body.get('reasonCode') in {
                'invalid_price', 'insufficient_evidence', 'conflicting_candidates',
                'outdated_baseline', 'unsupported_change',
            }
            target_hash = None
        elif action == 'edit_and_approve':
            assert body.get('unitPrice') == 112.5
            target_hash = f"ch_v1_{'Z' * 43}"
        else:
            target_hash = next(item['contentHash'] for item in items if item['reviewId'] == review_id)
        items[:] = [item for item in items if item['reviewId'] != review_id]
        fulfill_json(route, envelope(
            mutation_result(action, review_id, target_hash),
            'cloud-collab-admin-review-mutation-preview',
        ))
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
        'domain': 'stage5c-admin.test',
        'path': '/api/admin',
        'secure': True,
        'httpOnly': True,
        'sameSite': 'Strict',
    }])
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('https://stage5c-admin.test/**', route_handler)
    page.goto('https://stage5c-admin.test/admin-review-actions-preview.html', wait_until='domcontentloaded')

    expect(page.locator('#status')).to_contain_text('3 项', timeout=10_000)
    expect(page.locator('.review')).to_have_count(3)
    body_text = page.locator('body').inner_text()
    assert '合成批准服务' in body_text
    assert '合成拒绝服务' in body_text
    assert '合成编辑服务' in body_text

    page.locator('.review').filter(has_text='合成批准服务').get_by_role('button', name='批准候选值').click()
    expect(page.locator('#status')).to_contain_text('批准完成', timeout=10_000)
    expect(page.locator('.review')).to_have_count(2)

    page.locator('.review').filter(has_text='合成拒绝服务').get_by_role('button', name='拒绝此候选').click()
    expect(page.locator('#status')).to_contain_text('拒绝完成', timeout=10_000)
    expect(page.locator('.review')).to_have_count(1)

    edit_card = page.locator('.review').filter(has_text='合成编辑服务')
    edit_card.get_by_label('合成编辑服务 编辑后单价').fill('112.5')
    edit_card.get_by_role('button', name='按输入值批准').click()
    expect(page.locator('#status')).to_contain_text('编辑后批准完成', timeout=10_000)
    expect(page.locator('.review')).to_have_count(0)
    expect(page.locator('#queue')).to_contain_text('当前没有待审核合成项目')

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
    mutation_requests = [item for item in requests if item['path'].startswith('/api/admin/reviews/')]
    assert [item['path'] for item in mutation_requests] == [
        '/api/admin/reviews/approve',
        '/api/admin/reviews/reject',
        '/api/admin/reviews/edit-and-approve',
    ]
    assert all(item['method'] == 'POST' for item in mutation_requests)
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5C',
    'authenticatedSessionUsed': True,
    'approvePassed': True,
    'rejectPassed': True,
    'editAndApprovePassed': True,
    'explicitConfirmationPassed': True,
    'queueRefreshPassed': True,
    'browserStorageEmpty': True,
    'logoutClearedView': True,
}, ensure_ascii=False))
