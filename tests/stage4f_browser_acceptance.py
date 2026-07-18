from pathlib import Path
from urllib.parse import urlparse
import json
import time

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ACCEPTANCE_HTML = (ROOT / 'dist' / 'stage4f-real-device-acceptance.html').read_text(encoding='utf-8')
CLIENT_HTML = (ROOT / 'dist' / 'index.html').read_text(encoding='utf-8')
PREVIEW_KEY = 'browser-stage4f-preview-key-0123456789012345'
requests = []


def envelope(service_id, data):
    return {
        'ok': True,
        'serviceId': service_id,
        'apiVersion': '2026-07-19-stage4f-browser',
        'data': data,
    }


def json_response(route, payload, status=200):
    route.fulfill(
        status=status,
        content_type='application/json; charset=utf-8',
        headers={'Cache-Control': 'no-store'},
        body=json.dumps(payload, ensure_ascii=False),
    )


def route_handler(route, request):
    parsed = urlparse(request.url)
    path = parsed.path
    if path == '/stage4f-real-device-acceptance.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=ACCEPTANCE_HTML)
        return
    if path == '/index.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=CLIENT_HTML)
        return

    header_present = bool(request.headers.get('x-cloud-collab-preview-key'))
    requests.append({'method': request.method, 'path': path, 'previewHeaderPresent': header_present})

    readonly_flags = {
        'writeEnabled': False,
        'publicMutationAllowed': False,
        'autoApprovalEnabled': False,
        'previewWriteEnabled': True,
        'previewAutoApprovalEnabled': True,
    }
    if path == '/api/health':
        json_response(route, envelope('cloud-collab-readonly', {
            'status': 'ok', 'environment': 'stage4f-browser', 'protocolVersion': 1,
            'writeEnabled': False,
            'capabilities': {'health': True, 'protocol': True, 'publicVersion': True, 'snapshotRead': True, 'incrementalRead': True, 'exactPriceReceive': True, 'submission': False, 'adminWrite': False},
        }))
        return
    if path == '/api/protocol':
        json_response(route, envelope('cloud-collab-readonly', {
            'protocolVersion': 1, 'minimumClientProtocolVersion': 1, 'latestClientProtocolVersion': 1,
            'publicDataSchemaVersion': 1, 'submissionSchemaVersion': 1, 'localCloudStoreSchemaVersion': 1,
            'writeEnabled': False, 'polling': {'recommendedIntervalSeconds': 300, 'minimumIntervalSeconds': 60},
            'capabilities': {'publicVersion': True, 'snapshotRead': True, 'incrementalRead': True, 'exactPriceReceive': True, 'submission': False, 'adminReview': False},
        }))
        return
    if path == '/api/device/register':
        body = request.post_data_json
        now = int(time.time() * 1000)
        json_response(route, envelope('cloud-collab-preview-write', {
            'schemaVersion': 1,
            'deviceId': body['deviceId'],
            'deviceToken': 'dt_v1_browser_stage4f_token_012345678901234567890',
            'issuedAt': now,
            'expiresAt': now + 86_400_000,
            'tokenVersion': 1,
            'nicknameTag': body['deviceId'][-4:],
            'writeEnabled': False,
            'publicMutationAllowed': False,
            'autoApprovalEnabled': False,
        }), status=201)
        return
    if path == '/api/preview/submissions/create':
        json_response(route, envelope('cloud-collab-preview-write', {
            'schemaVersion': 1,
            'status': 'waiting_confirmation',
            'decision': 'waiting_confirmation',
            'reason': 'second_device_required',
            'approvalMode': None,
            'baselineApprovedVersion': 0,
            'matchingDistinctDeviceCount': 1,
            'conflictingCandidateCount': 0,
            'changeRatio': None,
            'previewPublicVersion': 0,
            'previewEventVersion': 0,
            'previewSnapshotKey': None,
            'previewMutationApplied': False,
            'previewDuplicateApproval': False,
            'previewAutoApprovalEnabled': True,
            **readonly_flags,
        }), status=202)
        return
    if path == '/api/preview/public-version':
        json_response(route, envelope('cloud-collab-readonly', {
            'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture',
            'publicVersion': 0, 'snapshotVersion': 0, 'updatedAt': None,
            'status': 'preview_dynamic_empty', 'snapshotAvailable': False,
            'recordCounts': {'exactPrice': 0}, **readonly_flags,
        }))
        return
    if path == '/api/preview/public-snapshot':
        json_response(route, envelope('cloud-collab-readonly', {
            'status': 'snapshot_unavailable', 'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture',
            'publicVersion': 0, 'snapshotVersion': 0, 'snapshot': None, **readonly_flags,
        }))
        return
    if path == '/api/preview/public-changes':
        json_response(route, envelope('cloud-collab-readonly', {
            'status': 'not_modified', 'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture',
            'sinceVersion': 0, 'publicVersion': 0, 'snapshotVersion': 0, 'changes': [],
            'nextVersion': 0, 'hasMore': False, **readonly_flags,
        }))
        return
    route.fulfill(status=404, content_type='text/plain', body='not found')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    console_errors = []
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.route('https://preview.test/**', route_handler)
    page.goto('https://preview.test/stage4f-real-device-acceptance.html', wait_until='domcontentloaded')

    page.locator('#previewKey').fill(PREVIEW_KEY)
    page.locator('#batchId').fill('BROWSER4F')
    page.locator('#loadBtn').click()
    page.wait_for_function("document.querySelector('#loadStatus').textContent.includes('已加载')", timeout=20_000)
    assert page.locator('#previewKey').input_value() == ''
    assert '…' in page.locator('#deviceMetric').text_content()

    page.locator('#caseName').select_option('offline')
    page.locator('#unitPrice').fill('77')
    page.locator('#offlineBtn').click()
    page.locator('#submitBtn').click()
    page.wait_for_function("document.querySelector('#submitStatus').textContent.includes('离线降级')", timeout=10_000)
    assert '待发1' in page.locator('#queueMetric').text_content()
    assert not any(item['path'] in ['/api/device/register', '/api/preview/submissions/create'] for item in requests)

    page.locator('#recoverBtn').click()
    page.wait_for_function("document.querySelector('#submitStatus').textContent.includes('恢复重试完成')", timeout=15_000)
    assert any(item['path'] == '/api/device/register' and item['previewHeaderPresent'] for item in requests)
    assert any(item['path'] == '/api/preview/submissions/create' and item['previewHeaderPresent'] for item in requests)
    assert not any(item['path'] == '/api/submissions/create' for item in requests)

    page.locator('#readBtn').click()
    page.wait_for_function("document.querySelector('#readStatus').textContent.includes('一致性通过')", timeout=10_000)
    for path in ['/api/preview/public-version', '/api/preview/public-snapshot', '/api/preview/public-changes']:
        assert any(item['path'] == path and item['previewHeaderPresent'] for item in requests), path
    assert page.locator('#consistencyMetric').text_content() == '通过'

    storage_values = page.evaluate("Object.keys(localStorage).map(key => localStorage.getItem(key))")
    assert all(PREVIEW_KEY not in (value or '') for value in storage_values)
    assert PREVIEW_KEY not in page.locator('body').inner_text()
    assert not console_errors, console_errors
    context.close()
    browser.close()

print(json.dumps({
    'stage': '4F',
    'realClientLoaded': True,
    'offlineQueueHeld': True,
    'recoveryRetrySucceeded': True,
    'previewRoutesOnly': True,
    'dynamicReadsConsistent': True,
    'previewKeyNotPersisted': True,
}, ensure_ascii=False))
