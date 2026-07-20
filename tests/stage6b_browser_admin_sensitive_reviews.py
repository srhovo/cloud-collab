from pathlib import Path
from urllib.parse import urlparse, parse_qs
import json
import os

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE_HTML = (ROOT / 'dist' / 'admin-sensitive-reviews-preview.html').read_text(encoding='utf-8')
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)

REVIEW_APPROVE = f"srv_v1_{'A' * 43}"
REVIEW_REJECT = f"srv_v1_{'B' * 43}"
REVIEW_EDIT = f"srv_v1_{'C' * 43}"
REVIEW_DELETE = f"srv_v1_{'D' * 43}"
DECISION_TAGS = iter(['E', 'F', 'G', 'H'])
requests = []
public_version = 4

CAPABILITIES = {
    'queueRead': True,
    'detailRead': True,
    'approve': True,
    'reject': True,
    'editAndApprove': True,
    'tombstonePublish': True,
    'automaticApproval': False,
    'trustedDeviceBypass': False,
    'twoDeviceBypass': False,
    'syntheticFixtureOnly': True,
}


def viewer():
    return {
        'authenticated': True,
        'username': 'admin@example.test',
        'sessionIdSuffix': '6B01',
        'expiresAt': 1_784_700_000_000,
    }


def queue_item(review_id, data_type, operation, reason, tag, baseline_hash=None):
    return {
        'reviewId': review_id,
        'status': 'pending_review',
        'action': None,
        'reason': reason,
        'dataType': data_type,
        'operation': operation,
        'businessKey': f"bk_v1_{tag * 43}",
        'contentHash': f"ch_v1_{tag * 43}",
        'baselineContentHash': baseline_hash,
        'tombstoneRequested': operation == 'delete',
        'receivedAt': 1_784_620_000_000,
    }


items = [
    queue_item(REVIEW_APPROVE, 'gift_rule', 'upsert', 'gift_rule_manual_review', 'A'),
    queue_item(REVIEW_REJECT, 'surcharge_rule', 'upsert', 'surcharge_rule_manual_review', 'B'),
    queue_item(REVIEW_EDIT, 'rank_range_rule', 'upsert', 'rank_range_rule_manual_review', 'C'),
    queue_item(REVIEW_DELETE, 'boss_profile', 'delete', 'explicit_delete_manual_review', 'D', f"ch_v1_{'P' * 43}"),
]

DETAILS = {
    REVIEW_APPROVE: {
        'candidate': {'dataType': 'gift_rule', 'operation': 'upsert', 'bossId': None,
                      'businessKey': items[0]['businessKey'], 'contentHash': items[0]['contentHash'],
                      'payload': {'serviceName': '红包', 'mode': 'fixed', 'unitPrice': 66}},
        'baseline': None,
    },
    REVIEW_REJECT: {
        'candidate': {'dataType': 'surcharge_rule', 'operation': 'upsert', 'bossId': None,
                      'businessKey': items[1]['businessKey'], 'contentHash': items[1]['contentHash'],
                      'payload': {'name': '甜蜜单', 'keywords': ['甜蜜单'], 'prices': {'round': 5, 'hour': None}, 'enabled': True}},
        'baseline': None,
    },
    REVIEW_EDIT: {
        'candidate': {'dataType': 'rank_range_rule', 'operation': 'upsert', 'bossId': None,
                      'businessKey': items[2]['businessKey'], 'contentHash': items[2]['contentHash'],
                      'payload': {'rangeLabel': '0-20星', 'alias': '', 'rankType': 'star', 'minStar': 0, 'maxStar': 20,
                                  'namedRanks': [], 'prices': {'normal': {'round': 12, 'hour': None},
                                                               'carry': {'round': None, 'hour': None},
                                                               'starGuarantee': {'round': None, 'hour': None}}}},
        'baseline': None,
    },
    REVIEW_DELETE: {
        'candidate': {'dataType': 'boss_profile', 'operation': 'delete', 'bossId': f"boss_v1_{'D' * 43}",
                      'businessKey': items[3]['businessKey'], 'contentHash': items[3]['contentHash'], 'payload': None},
        'baseline': {'approvedVersion': 4, 'contentHash': f"ch_v1_{'P' * 43}", 'dataType': 'boss_profile',
                     'bossId': f"boss_v1_{'D' * 43}",
                     'payload': {'bossName': '待删老板', 'paiDan': '直属A', 'discount': 0.96}},
    },
}


def envelope(data):
    return {'ok': True, 'serviceId': 'cloud-collab-admin-sensitive-review-preview',
            'apiVersion': '2026-07-20-stage6b-browser', 'data': data}


def fulfill_json(route, data, status=200):
    route.fulfill(status=status, content_type='application/json; charset=utf-8',
                  headers={'Cache-Control': 'no-store'}, body=json.dumps(data, ensure_ascii=False))


def queue_data():
    return {
        'viewer': viewer(),
        'schemaVersion': 1,
        'scope': {'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture'},
        'count': len(items),
        'items': items,
        'capabilities': CAPABILITIES,
    }


def detail_data(review_id):
    row = next(item for item in items if item['reviewId'] == review_id)
    return {
        'viewer': viewer(),
        'schemaVersion': 1,
        'scope': {'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture'},
        'item': row,
        **DETAILS[review_id],
        'capabilities': CAPABILITIES,
    }


def mutation_data(action, review_id):
    global public_version
    tag = next(DECISION_TAGS)
    decision_id = f"srd_v1_{tag * 43}"
    if action != 'reject':
        public_version += 1
    operation = next(item['operation'] for item in items if item['reviewId'] == review_id)
    return {
        'viewer': viewer(),
        'schemaVersion': 1,
        'duplicate': False,
        'resolution': {
            'schemaVersion': 1,
            'reviewId': review_id,
            'decisionId': decision_id,
            'auditId': f"sau_v1_{tag * 43}",
            'action': action,
            'groupId': 'group_fixture',
            'libraryId': 'lib_receive_fixture',
            'businessKey': next(item['businessKey'] for item in items if item['reviewId'] == review_id),
            'sourceContentHash': next(item['contentHash'] for item in items if item['reviewId'] == review_id),
            'targetContentHash': None if action == 'reject' else f"ch_v1_{tag * 43}",
            'resolvedAt': 1_784_620_001_000,
        },
        'publicResult': None if action == 'reject' else {
            'approvalId': f"sap_v1_{tag * 43}",
            'version': public_version,
            'eventKey': f"public/lib_receive_fixture/sensitive-events/{public_version:012d}.json",
            'operation': operation,
            'snapshotKey': f"public/lib_receive_fixture/sensitive-snapshots/{public_version:012d}.json",
        },
        'capabilities': CAPABILITIES,
    }


def route_handler(route, request):
    parsed = urlparse(request.url)
    body = request.post_data_json if request.method == 'POST' and request.post_data else None
    requests.append({'method': request.method, 'path': parsed.path, 'body': body})
    if parsed.path == '/admin-sensitive-reviews-preview.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=PAGE_HTML)
        return
    if parsed.path == '/api/admin/auth/session':
        assert 'cloud_admin_session=browser-session' in request.headers.get('cookie', '')
        fulfill_json(route, {'ok': True, 'serviceId': 'cloud-collab-admin-auth-preview',
                             'apiVersion': 'browser', 'data': {**viewer(), 'issuedAt': 1_784_619_000_000}})
        return
    if parsed.path == '/api/admin/sensitive-reviews' and request.method == 'GET':
        fulfill_json(route, envelope(queue_data()))
        return
    if parsed.path == '/api/admin/sensitive-reviews/detail':
        review_id = parse_qs(parsed.query).get('id', [''])[0]
        fulfill_json(route, envelope(detail_data(review_id)))
        return
    mutation_routes = {
        '/api/admin/sensitive-reviews/approve': ('approve', 'APPROVE_SENSITIVE'),
        '/api/admin/sensitive-reviews/reject': ('reject', 'REJECT_SENSITIVE'),
        '/api/admin/sensitive-reviews/edit-and-approve': ('edit_and_approve', 'EDIT_AND_APPROVE_SENSITIVE'),
    }
    if parsed.path in mutation_routes:
        action, confirmation = mutation_routes[parsed.path]
        assert request.method == 'POST'
        assert request.headers.get('origin') == 'https://stage6b-admin.test'
        assert request.headers.get('content-type', '').startswith('application/json')
        assert body.get('confirmation') == confirmation
        review_id = body.get('reviewId')
        if action == 'reject':
            assert body.get('reasonCode') in {'invalid_data', 'insufficient_evidence', 'conflicting_candidates',
                                               'unsupported_change', 'identity_uncertain', 'delete_not_confirmed'}
        if action == 'edit_and_approve':
            assert body.get('payload')['prices']['normal']['round'] == 15
        response_data = mutation_data(action, review_id)
        items[:] = [item for item in items if item['reviewId'] != review_id]
        fulfill_json(route, envelope(response_data), status=201)
        return
    if parsed.path == '/api/admin/auth/logout':
        fulfill_json(route, {'ok': True, 'serviceId': 'cloud-collab-admin-auth-preview',
                             'apiVersion': 'browser', 'data': {'loggedOut': True}})
        return
    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    chromium_path = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = playwright.chromium.launch(headless=True, executable_path=chromium_path, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    context.add_cookies([{
        'name': 'cloud_admin_session', 'value': 'browser-session', 'domain': 'stage6b-admin.test',
        'path': '/api/admin', 'secure': True, 'httpOnly': True, 'sameSite': 'Strict',
    }])
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('https://stage6b-admin.test/**', route_handler)
    page.goto('https://stage6b-admin.test/admin-sensitive-reviews-preview.html', wait_until='domcontentloaded')

    expect(page.locator('#status')).to_contain_text('4 项', timeout=10_000)
    expect(page.locator('.review')).to_have_count(4)
    expect(page.locator('#scope')).to_contain_text('group_fixture / lib_receive_fixture')

    approve_card = page.locator('.review').filter(has_text='礼物规则 · 修改')
    approve_card.get_by_role('button', name='读取基线与候选详情').click()
    expect(approve_card).to_contain_text('红包')
    approve_card.get_by_role('button', name='批准候选').click()
    expect(page.locator('#status')).to_contain_text('批准完成；公共版本 5', timeout=10_000)
    expect(page.locator('.review')).to_have_count(3)

    reject_card = page.locator('.review').filter(has_text='加价规则 · 修改')
    reject_card.get_by_role('button', name='读取基线与候选详情').click()
    reject_card.get_by_role('button', name='拒绝候选').click()
    expect(page.locator('#status')).to_contain_text('拒绝完成', timeout=10_000)
    expect(page.locator('.review')).to_have_count(2)

    edit_card = page.locator('.review').filter(has_text='区间规则 · 修改')
    edit_card.get_by_role('button', name='读取基线与候选详情').click()
    textarea = edit_card.get_by_label('敏感候选编辑JSON')
    payload = json.loads(textarea.input_value())
    payload['prices']['normal']['round'] = 15
    textarea.fill(json.dumps(payload, ensure_ascii=False))
    edit_card.get_by_role('button', name='按JSON编辑后批准').click()
    expect(page.locator('#status')).to_contain_text('编辑后批准完成；公共版本 6', timeout=10_000)
    expect(page.locator('.review')).to_have_count(1)

    delete_card = page.locator('.review').filter(has_text='老板资料 · 删除')
    delete_card.get_by_role('button', name='读取基线与候选详情').click()
    expect(delete_card.get_by_label('敏感候选编辑JSON')).to_be_disabled()
    expect(delete_card.get_by_role('button', name='按JSON编辑后批准')).to_be_disabled()
    delete_card.get_by_role('button', name='批准并发布墓碑').click()
    expect(page.locator('#status')).to_contain_text('批准完成；公共版本 7', timeout=10_000)
    expect(page.locator('.review')).to_have_count(0)
    expect(page.locator('#queue')).to_contain_text('当前没有敏感待审核项目')

    page.locator('#logoutBtn').click()
    expect(page.locator('#status')).to_contain_text('已退出', timeout=10_000)
    expect(page.locator('#queueCard')).to_have_class('card hidden')

    mutation_paths = [row['path'] for row in requests if row['method'] == 'POST' and '/sensitive-reviews/' in row['path']]
    assert mutation_paths == [
        '/api/admin/sensitive-reviews/approve',
        '/api/admin/sensitive-reviews/reject',
        '/api/admin/sensitive-reviews/edit-and-approve',
        '/api/admin/sensitive-reviews/approve',
    ]
    storage_state = context.storage_state()
    assert all(not origin.get('localStorage') for origin in storage_state.get('origins', []))
    assert not console_errors, console_errors
    page.screenshot(path=str(OUT / '阶段6B_管理员敏感审核浏览器回归.png'), full_page=True)
    context.close()
    browser.close()

print(json.dumps({
    'stage': '6B',
    'authenticatedSessionUsed': True,
    'approvePassed': True,
    'rejectPassed': True,
    'editAndApprovePassed': True,
    'tombstoneApprovePassed': True,
    'explicitConfirmationsPassed': True,
    'browserStorageEmpty': True,
    'logoutClearedView': True,
    'browserConsoleClean': True,
}, ensure_ascii=False))
