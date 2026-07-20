from pathlib import Path
from urllib.parse import urlparse
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-ordinary-reviews-preview.html').read_text(encoding='utf-8')
REVIEW_APPROVE = f"rv_v1_{'A' * 43}"
REVIEW_REJECT = f"rv_v1_{'B' * 43}"
REVIEW_EDIT = f"rv_v1_{'C' * 43}"
REVIEW_SENSITIVE = f"rv_v1_{'D' * 43}"
DECISION = f"rd_v1_{'E' * 43}"
AUDIT = f"au_v1_{'F' * 43}"
APPROVAL = f"ap_v1_{'G' * 43}"
requests = []
public_version = 1

READ_CAPABILITIES = {
    'reviewQueueRead': True,
    'reviewDetailRead': True,
    'reviewMutation': False,
    'ordinaryTypes': ['exact_price', 'playable_name', 'boss_profile'],
    'publicMutationAllowed': False,
    'syntheticFixtureOnly': True,
}
MUTATION_CAPABILITIES = {
    'reviewQueueRead': True,
    'reviewDetailRead': True,
    'reviewMutation': True,
    'reviewApprove': True,
    'reviewReject': True,
    'reviewEditAndApprove': True,
    'ordinaryTypes': ['playable_name', 'boss_profile'],
    'exactPriceUsesExistingStage5C': True,
    'stage6SensitiveChangesBlocked': True,
    'publicMutationAllowed': True,
    'syntheticFixtureOnly': True,
}


def baseline(data_type=None, payload=None, version=0):
    return {
        'approvedVersion': version,
        'contentHash': None if version == 0 else f"ch_v1_{'P' * 43}",
        'dataType': data_type,
        'payload': payload,
        'unitPrice': None,
        'stillCurrent': True,
    }


def item(review_id, tag, data_type, reason, payload, base):
    return {
        'reviewId': review_id,
        'status': 'pending_review',
        'reason': reason,
        'groupId': 'group_fixture',
        'libraryId': 'lib_receive_fixture',
        'businessKey': f"bk_v1_{tag * 43}",
        'contentHash': f"ch_v1_{tag * 43}",
        'dataType': data_type,
        'operation': 'upsert',
        'payload': payload,
        'baseline': base,
        'distinctDeviceCount': 1,
        'deviceTags': [f'设备-{tag * 8}'],
        'createdAt': '2026-07-20T00:00:00.000Z',
        'receivedAt': '2026-07-19T23:59:59.000Z',
    }


items = [
    item(REVIEW_APPROVE, 'A', 'boss_profile', 'candidate_conflict',
         {'bossName': '老板批准', 'paiDan': '直属A', 'discount': 0.97}, baseline()),
    item(REVIEW_REJECT, 'B', 'playable_name', 'candidate_conflict',
         {'name': '拒绝名字'}, baseline()),
    item(REVIEW_EDIT, 'C', 'playable_name', 'playable_name_public_conflict',
         {'name': 'ALICE'}, baseline('playable_name', {'name': 'Alice'}, 1)),
    item(REVIEW_SENSITIVE, 'D', 'boss_profile', 'boss_direct_report_change_sensitive',
         {'bossName': '敏感老板', 'paiDan': '直属B', 'discount': 0.97},
         baseline('boss_profile', {'bossName': '敏感老板', 'paiDan': '直属A', 'discount': 0.97}, 1)),
]


def fulfill_json(route, data, status=200):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store'},
        body=json.dumps(data, ensure_ascii=False),
    )


def envelope(data, service):
    return {'ok': True, 'serviceId': service, 'apiVersion': '2026-07-20-stage5g-browser', 'data': data}


def viewer():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'sessionIdSuffix': '5G01',
        'expiresAt': 1_784_541_000_000,
    }


def queue_data():
    return {
        'viewer': viewer(),
        'scope': {'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture', 'syntheticFixtureOnly': True},
        'total': len(items),
        'items': items,
        'capabilities': READ_CAPABILITIES,
    }


def mutation_data(action, review_id, target_hash):
    global public_version
    if action != 'reject':
        public_version += 1
    status = {
        'approve': 'approved_by_admin',
        'reject': 'rejected',
        'edit_and_approve': 'edited_and_approved',
    }[action]
    return {
        'viewer': viewer(),
        'result': {
            'reviewId': review_id,
            'decisionId': DECISION,
            'auditId': AUDIT,
            'action': action,
            'status': status,
            'dataType': 'playable_name' if review_id != REVIEW_APPROVE else 'boss_profile',
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
    if parsed.path == '/admin-ordinary-reviews-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return
    if parsed.path == '/api/admin/auth/session':
        assert 'cloud_admin_session=browser-session' in request.headers.get('cookie', '')
        fulfill_json(route, envelope({**viewer(), 'issuedAt': 1_784_540_000_000, 'capabilities': {}}, 'cloud-collab-admin-auth-preview'))
        return
    if parsed.path == '/api/admin/ordinary-reviews':
        fulfill_json(route, envelope(queue_data(), 'cloud-collab-admin-ordinary-review-preview'))
        return
    mutation_routes = {
        '/api/admin/ordinary-reviews/approve': ('approve', 'APPROVE_ORDINARY'),
        '/api/admin/ordinary-reviews/reject': ('reject', 'REJECT_ORDINARY'),
        '/api/admin/ordinary-reviews/edit-and-approve': ('edit_and_approve', 'EDIT_AND_APPROVE_ORDINARY'),
    }
    if parsed.path in mutation_routes:
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://stage5g-admin.test'
        assert request.headers.get('content-type', '').startswith('application/json')
        action, confirmation = mutation_routes[parsed.path]
        assert body.get('confirmation') == confirmation
        review_id = body.get('reviewId')
        assert review_id != REVIEW_SENSITIVE
        if action == 'reject':
            assert body.get('reasonCode') in {'invalid_data', 'insufficient_evidence', 'conflicting_candidates', 'unsupported_change'}
            target_hash = None
        elif action == 'edit_and_approve':
            assert body.get('payload') == {'name': 'AliCe'}
            target_hash = f"ch_v1_{'Z' * 43}"
        else:
            target_hash = next(row['contentHash'] for row in items if row['reviewId'] == review_id)
        items[:] = [row for row in items if row['reviewId'] != review_id]
        fulfill_json(route, envelope(mutation_data(action, review_id, target_hash), 'cloud-collab-admin-ordinary-review-mutation-preview'))
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
        'domain': 'stage5g-admin.test',
        'path': '/api/admin',
        'secure': True,
        'httpOnly': True,
        'sameSite': 'Strict',
    }])
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('https://stage5g-admin.test/**', route_handler)
    page.goto('https://stage5g-admin.test/admin-ordinary-reviews-preview.html', wait_until='domcontentloaded')

    expect(page.locator('#status')).to_contain_text('4 项', timeout=10_000)
    expect(page.locator('.review')).to_have_count(4)

    sensitive = page.locator('.review').filter(has_text='敏感老板')
    expect(sensitive.get_by_role('button', name='批准候选值')).to_be_disabled()
    expect(sensitive.get_by_role('button', name='拒绝此候选')).to_be_disabled()
    expect(sensitive.get_by_role('button', name='按输入内容批准')).to_be_disabled()
    expect(sensitive).to_contain_text('任何写入都会被服务器')

    page.locator('.review').filter(has_text='老板批准').get_by_role('button', name='批准候选值').click()
    expect(page.locator('#status')).to_contain_text('批准完成', timeout=10_000)
    expect(page.locator('.review')).to_have_count(3)

    page.locator('.review').filter(has_text='拒绝名字').get_by_role('button', name='拒绝此候选').click()
    expect(page.locator('#status')).to_contain_text('拒绝完成', timeout=10_000)
    expect(page.locator('.review')).to_have_count(2)

    edit_card = page.locator('.review').filter(has_text='ALICE')
    edit_card.get_by_label('编辑陪玩名字').fill('AliCe')
    edit_card.get_by_role('button', name='按输入内容批准').click()
    expect(page.locator('#status')).to_contain_text('编辑后批准完成', timeout=10_000)
    expect(page.locator('.review')).to_have_count(1)
    expect(page.locator('.review')).to_contain_text('敏感老板')

    page.locator('#logoutBtn').click()
    expect(page.locator('#status')).to_contain_text('已退出', timeout=10_000)
    expect(page.locator('#queueCard')).to_have_class('card hidden')

    storage_state = context.storage_state()
    local_values = [
        entry.get('value', '')
        for origin in storage_state.get('origins', [])
        for entry in origin.get('localStorage', [])
    ]
    assert local_values == []
    mutation_requests = [row for row in requests if row['path'].startswith('/api/admin/ordinary-reviews/') and row['path'] != '/api/admin/ordinary-reviews/detail']
    assert [row['path'] for row in mutation_requests] == [
        '/api/admin/ordinary-reviews/approve',
        '/api/admin/ordinary-reviews/reject',
        '/api/admin/ordinary-reviews/edit-and-approve',
    ]
    assert all(row['method'] == 'POST' for row in mutation_requests)
    assert not any(row['body'] and row['body'].get('reviewId') == REVIEW_SENSITIVE for row in mutation_requests)
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '5G',
    'authenticatedSessionUsed': True,
    'approvePassed': True,
    'rejectPassed': True,
    'editAndApprovePassed': True,
    'stage6SensitiveActionsDisabled': True,
    'explicitConfirmationPassed': True,
    'queueRefreshPassed': True,
    'browserStorageEmpty': True,
    'logoutClearedView': True,
}, ensure_ascii=False))
