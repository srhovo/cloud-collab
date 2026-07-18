from pathlib import Path
import json
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
HTML = (ROOT/'dist/index.html').read_text(encoding='utf-8')
TEST_HTML = HTML.replace('<meta name="cloud-collab-api-base" content="">', '<meta name="cloud-collab-api-base" content="https://api.test">')
CLOUD_KEYS = ['cloudCollabMeta','cloudDeviceCredential','cloudLibraryBindings','cloudBossLinks','pendingCloudChanges','cloudSyncState']

def envelope(data):
    return {'ok': True, 'serviceId': 'cloud-collab-readonly', 'apiVersion': '2026-07-18', 'data': data}

def api_payload(path, mode):
    if mode == 'offline':
        return 503, {'ok': False, 'serviceId': 'cloud-collab-readonly', 'apiVersion': '2026-07-18', 'error': {'code': 'TEST_OFFLINE', 'message': '测试服务器离线'}}
    if path == '/api/health':
        return 200, envelope({'status': 'ok', 'environment': 'browser-test', 'protocolVersion': 1, 'writeEnabled': False, 'capabilities': {'submission': False}})
    if path == '/api/protocol':
        return 200, envelope({'protocolVersion': 2 if mode == 'protocol2' else 1, 'writeEnabled': False, 'capabilities': {'snapshotRead': False, 'submission': False}})
    if path == '/api/public-version':
        return 200, envelope({'groupId': 'group_xiacijian', 'libraryId': 'lib_xiacijian_regular', 'publicVersion': 0, 'snapshotVersion': 0, 'updatedAt': None, 'status': 'empty_test_library', 'snapshotAvailable': False, 'recordCounts': {}, 'writeEnabled': False})
    return 404, {'ok': False, 'serviceId': 'cloud-collab-readonly', 'apiVersion': '2026-07-18', 'error': {'code': 'NOT_FOUND', 'message': 'not found'}}

def storage_snapshot(page):
    return page.evaluate("keys => Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)]))", CLOUD_KEYS)

def calculate(page):
    values = {
        'totalPrice': '100', 'discount': '1', 'paiDan': '派单A', 'peiPei': '陪陪A',
        'boss': '老板A', 'type': '王者荣耀', 'duration': '1小时', 'note': '兼容测试'
    }
    for key, value in values.items():
        page.locator(f'#{key}').fill(value)
    page.locator('#calculateBtn').click()
    page.wait_for_function("document.querySelector('#orderOutput').textContent.includes('到手：75')")
    return page.locator('#orderOutput').text_content()

def run_case(browser, mode):
    page = browser.new_page(viewport={'width': 430, 'height': 932})
    console_errors = []
    requests = []
    page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)

    def route_handler(route, request):
        parsed = urlparse(request.url)
        if parsed.path.startswith('/api/'):
            requests.append({'method': request.method, 'url': request.url})
            status, payload = api_payload(parsed.path, mode)
            route.fulfill(status=status, content_type='application/json; charset=utf-8', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(payload, ensure_ascii=False))
            return
        route.abort()

    page.route('https://api.test/**', route_handler)
    page.goto('about:blank')
    page.evaluate("""Object.defineProperty(window,'localStorage',{value:{_d:{},getItem(k){return Object.prototype.hasOwnProperty.call(this._d,k)?this._d[k]:null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]},clear(){this._d={}},get length(){return Object.keys(this._d).length},key(i){return Object.keys(this._d)[i]??null}}, configurable:true})""")
    page.set_content(TEST_HTML, wait_until='domcontentloaded', timeout=15000)
    page.wait_for_function('window.orderCalculator', timeout=8000)
    output = calculate(page)
    if mode == 'online':
        page.wait_for_function("window.orderCalculator.cloudCollabState.serverStatus === 'online'", timeout=8000)
        startup_storage = storage_snapshot(page)
        assert all(v is None for v in startup_storage.values()), startup_storage
        page.locator('#cloudCollabBtn').click()
        page.locator('#cloudGroupIdInput').fill('group_xiacijian')
        page.locator('#cloudLibraryIdInput').fill('lib_xiacijian_regular')
        page.locator('#cloudBindingModeSelect').select_option('receive')
        page.locator('#cloudBindingSaveBtn').click()
        page.wait_for_function("document.querySelector('#cloudOperationStatus').textContent.includes('本地绑定已保存')")
        before_version = storage_snapshot(page)
        page.locator('#cloudPublicVersionCheckBtn').click()
        page.wait_for_function("document.querySelector('#cloudPublicVersionSummary').textContent.includes('公共版本：0')")
        after_version = storage_snapshot(page)
        assert before_version == after_version, (before_version, after_version)
        page.screenshot(path=str(OUT/'阶段3A_移动端只读联调弹窗.png'), full_page=False)
        final_status = 'online'
        public_text = page.locator('#cloudPublicVersionSummary').text_content()
    elif mode == 'offline':
        page.wait_for_function("window.orderCalculator.cloudCollabState.serverStatus === 'offline'", timeout=8000)
        startup_storage = storage_snapshot(page)
        assert all(v is None for v in startup_storage.values()), startup_storage
        final_status = 'offline'
        public_text = ''
    else:
        page.wait_for_function("window.orderCalculator.cloudCollabState.serverStatus === 'protocol_mismatch'", timeout=8000)
        startup_storage = storage_snapshot(page)
        assert all(v is None for v in startup_storage.values()), startup_storage
        final_status = 'protocol_mismatch'
        public_text = ''
    assert {item['method'] for item in requests} <= {'GET'}
    assert '到手：75' in output
    result = {
        'mode': mode,
        'finalStatus': final_status,
        'coreCalculationOk': True,
        'apiRequests': requests,
        'publicVersionText': public_text,
        'startupCreatedNoCloudKeys': all(v is None for v in startup_storage.values()),
        'consoleErrors': console_errors,
    }
    page.close()
    return result

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    results = [run_case(browser, 'online'), run_case(browser, 'offline'), run_case(browser, 'protocol2')]
    browser.close()

checks = {
    'onlineEventuallyConnected': results[0]['finalStatus'] == 'online',
    'offlineDoesNotBreakCalculation': results[1]['finalStatus'] == 'offline' and results[1]['coreCalculationOk'],
    'protocolMismatchDoesNotBreakCalculation': results[2]['finalStatus'] == 'protocol_mismatch' and results[2]['coreCalculationOk'],
    'startupCreatesNoCloudIdentity': all(r['startupCreatedNoCloudKeys'] for r in results),
    'onlyGetRequests': all(all(req['method'] == 'GET' for req in r['apiRequests']) for r in results),
    'noUnexpectedConsoleErrors': all(not [e for e in r['consoleErrors'] if not ('Failed to load resource' in e and '503' in e)] for r in results),
    'publicVersionReadOnly': '公共版本：0' in results[0]['publicVersionText'],
}
result = {'total': len(checks), 'passed': sum(checks.values()), 'failed': len(checks)-sum(checks.values()), 'checks': checks, 'cases': results}
(OUT/'阶段3A_Chromium只读联调结果.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'total': result['total'], 'passed': result['passed'], 'failed': result['failed']}, ensure_ascii=False))
if result['failed']:
    raise SystemExit(1)
