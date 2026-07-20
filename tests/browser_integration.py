import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

parser = argparse.ArgumentParser(description='Run the read-only browser regression against an explicit candidate HTML file.')
parser.add_argument('--html', default='dist/index.html')
parser.add_argument('--expected-version')
parser.add_argument('--output-dir', default='test-results')
parser.add_argument('--chromium', default=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'))
args = parser.parse_args()

def resolve(value):
    path = Path(value)
    return path if path.is_absolute() else ROOT / path

ledger = json.loads((ROOT / 'release/release-closure-ledger-v1.json').read_text(encoding='utf-8'))
expected_version = args.expected_version or ledger['currentCompatibleCandidateVersion']
candidate_path = resolve(args.html)
OUT = resolve(args.output_dir)
OUT.mkdir(parents=True, exist_ok=True)
HTML = candidate_path.read_text(encoding='utf-8')
if f'<title>码单器{expected_version}' not in HTML:
    raise SystemExit(f'candidate title does not contain expected version {expected_version}: {candidate_path}')
TEST_HTML = HTML.replace('<meta name="cloud-collab-api-base" content="">', '<meta name="cloud-collab-api-base" content="https://api.test">')
CLOUD_KEYS = ['cloudCollabMeta','cloudDeviceCredential','cloudLibraryBindings','cloudBossLinks','pendingCloudChanges','cloudSyncState']
A_KEY = 'bk_v1_ja06mv-cCqOze_uiSIK4YjKoixcrewF-NIQXmAiTyTQ'
A100 = 'ch_v1_fmOBmfqgyeg_JeMum9_V3xFSi9hzH_KUTdd8wGvnEls'
A110 = 'ch_v1_8cLsoYwgKnmAXyDgNjXMkDLlD2t2JjdXyKrde_KhoqA'
B_KEY = 'bk_v1_8NzIT8ASEfznmy1AXMAc2MFMpbMYf4hX3tor4g29P-k'
B80 = 'ch_v1_UeNOLpbqibRH7Yv9fojizF6qn-aTdRbXB3qOB8yeDXk'
SNAPSHOT = {
    'schemaVersion': 1, 'payloadSchemaVersion': 1,
    'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture',
    'publicVersion': 3, 'snapshotVersion': 3, 'cursor': 'pv_3',
    'generatedAt': '2026-07-18T00:00:03.000Z',
    'records': [
        {'approvedVersion': 3, 'businessKey': A_KEY, 'contentHash': A110, 'dataType': 'exact_price', 'operation': 'upsert', 'payload': {'serviceName': '测试服务A', 'settleType': 'round', 'unitPrice': 110}},
        {'approvedVersion': 2, 'businessKey': B_KEY, 'contentHash': B80, 'dataType': 'exact_price', 'operation': 'upsert', 'payload': {'serviceName': '测试服务B', 'settleType': 'hour', 'unitPrice': 80}},
    ],
    'tombstones': [],
}
EVENTS = [
    {'version': 1, 'approvedAt': '2026-07-18T00:00:01.000Z', 'businessKey': A_KEY, 'contentHash': A100, 'dataType': 'exact_price', 'operation': 'upsert', 'payload': {'serviceName': '测试服务A', 'settleType': 'round', 'unitPrice': 100}},
    {'version': 2, 'approvedAt': '2026-07-18T00:00:02.000Z', 'businessKey': B_KEY, 'contentHash': B80, 'dataType': 'exact_price', 'operation': 'upsert', 'payload': {'serviceName': '测试服务B', 'settleType': 'hour', 'unitPrice': 80}},
    {'version': 3, 'approvedAt': '2026-07-18T00:00:03.000Z', 'businessKey': A_KEY, 'contentHash': A110, 'dataType': 'exact_price', 'operation': 'upsert', 'payload': {'serviceName': '测试服务A', 'settleType': 'round', 'unitPrice': 110}},
]

def envelope(data):
    return {'ok': True, 'serviceId': 'cloud-collab-readonly', 'apiVersion': '2026-07-18', 'data': data}

def api_payload(path, query, mode):
    if mode == 'offline':
        return 503, {'ok': False, 'serviceId': 'cloud-collab-readonly', 'apiVersion': '2026-07-18', 'error': {'code': 'TEST_OFFLINE', 'message': '测试服务器离线'}}
    if path == '/api/health':
        return 200, envelope({'status': 'ok', 'environment': 'browser-test', 'protocolVersion': 1, 'writeEnabled': False, 'capabilities': {'health': True, 'protocol': True, 'publicVersion': True, 'snapshotRead': True, 'incrementalRead': True, 'exactPriceReceive': True, 'submission': False, 'adminWrite': False}})
    if path == '/api/protocol':
        capabilities = {'publicVersion': True, 'snapshotRead': True, 'incrementalRead': True, 'exactPriceReceive': True, 'submission': False, 'adminReview': False}
        return 200, envelope({'protocolVersion': 2 if mode == 'protocol2' else 1, 'minimumClientProtocolVersion': 1, 'latestClientProtocolVersion': 1, 'publicDataSchemaVersion': 1, 'submissionSchemaVersion': 1, 'localCloudStoreSchemaVersion': 1, 'writeEnabled': False, 'polling': {'recommendedIntervalSeconds': 300, 'minimumIntervalSeconds': 60}, 'capabilities': capabilities})
    if path == '/api/public-version':
        group = (query.get('groupId') or [''])[0]
        library = (query.get('libraryId') or [''])[0]
        if group == 'group_emptytest' and library == 'lib_emptytest':
            return 200, envelope({'groupId': group, 'libraryId': library, 'publicVersion': 1, 'snapshotVersion': 1, 'updatedAt': '2026-07-18T00:00:01.000Z', 'status': 'empty_test_library', 'snapshotAvailable': False, 'recordCounts': {'exactPrice': 0}, 'writeEnabled': False})
        return 200, envelope({'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture', 'publicVersion': 3, 'snapshotVersion': 3, 'updatedAt': '2026-07-18T00:00:03.000Z', 'status': 'fixture_ready', 'snapshotAvailable': True, 'recordCounts': {'exactPrice': 2}, 'writeEnabled': False})
    if path == '/api/public-snapshot':
        if_version = int((query.get('ifVersion') or ['0'])[0])
        if if_version >= 3:
            return 200, envelope({'status': 'not_modified', 'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture', 'publicVersion': 3, 'snapshotVersion': 3, 'snapshot': None, 'writeEnabled': False})
        return 200, envelope({'status': 'snapshot', 'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture', 'publicVersion': 3, 'snapshotVersion': 3, 'snapshot': SNAPSHOT, 'writeEnabled': False})
    if path == '/api/public-changes':
        since = int((query.get('sinceVersion') or ['0'])[0])
        limit = int((query.get('limit') or ['100'])[0])
        changes = [x for x in EVENTS if x['version'] > since][:limit]
        next_version = changes[-1]['version'] if changes else since
        return 200, envelope({'status': 'changes' if changes else 'not_modified', 'groupId': 'group_fixture', 'libraryId': 'lib_receive_fixture', 'sinceVersion': since, 'publicVersion': 3, 'snapshotVersion': 3, 'changes': changes, 'nextVersion': next_version, 'hasMore': any(x['version'] > next_version for x in EVENTS), 'writeEnabled': False})
    return 404, {'ok': False, 'serviceId': 'cloud-collab-readonly', 'apiVersion': '2026-07-18', 'error': {'code': 'NOT_FOUND', 'message': 'not found'}}

def storage_snapshot(page):
    return page.evaluate("keys => Object.fromEntries(keys.map(k => [k, localStorage.getItem('pw_ultimate_' + k)]))", CLOUD_KEYS)

def calculate(page):
    values = {'totalPrice': '100', 'discount': '1', 'paiDan': '派单A', 'peiPei': '陪陪A', 'boss': '老板A', 'type': '王者荣耀', 'duration': '1小时', 'note': '兼容测试'}
    for key, value in values.items():
        page.locator(f'#{key}').fill(value)
    page.locator('#calculateBtn').click()
    page.wait_for_function("document.querySelector('#orderOutput').textContent.includes('到手：75')")
    return page.locator('#orderOutput').text_content()

def create_page(browser, mode_ref, base_url=None):
    context = browser.new_context(viewport={'width': 430, 'height': 932})
    page = context.new_page()
    console_errors, requests = [], []
    page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
    def route_handler(route, request):
        parsed = urlparse(request.url)
        if parsed.path.startswith('/api/'):
            requests.append({'method': request.method, 'url': request.url})
            status, payload = api_payload(parsed.path, parse_qs(parsed.query), mode_ref[0])
            route.fulfill(status=status, content_type='application/json; charset=utf-8', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(payload, ensure_ascii=False))
            return
        route.abort()
    page.route('https://api.test/**', route_handler)
    page.goto('about:blank')
    page.evaluate("""Object.defineProperty(window,'localStorage',{value:{_d:{},getItem(k){return Object.prototype.hasOwnProperty.call(this._d,k)?this._d[k]:null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]},clear(){this._d={}},get length(){return Object.keys(this._d).length},key(i){return Object.keys(this._d)[i]??null}}, configurable:true})""")
    page.set_content(TEST_HTML, wait_until='domcontentloaded', timeout=15000)
    page.wait_for_function('window.orderCalculator', timeout=8000)
    return context, page, console_errors, requests

def fresh_receive_case(browser, base_url):
    mode = ['online']
    context, page, console_errors, requests = create_page(browser, mode, base_url)
    output = calculate(page)
    page.wait_for_function("window.orderCalculator.cloudCollabState.serverStatus === 'online'", timeout=8000)
    startup = storage_snapshot(page)
    assert all(v is None for v in startup.values()), startup
    page.locator('#cloudCollabBtn').click()
    page.locator('#cloudGroupIdInput').fill('group_fixture')
    page.locator('#cloudLibraryIdInput').fill('lib_receive_fixture')
    page.locator('#cloudBindingModeSelect').select_option('receive')
    page.locator('#cloudBindingSaveBtn').click()
    page.wait_for_function("""() => {
      const app=window.orderCalculator;
      const binding=app.cloudCollabStores.bindingStore.list()[0];
      if(!binding) return false;
      const lib=app.priceLibraries.libraries.find(x=>x.id===binding.localLibraryId);
      return lib && lib.items.some(x=>x.serviceType==='测试服务A' && x.unitPrice===110) && lib.items.some(x=>x.serviceType==='测试服务B' && x.unitPrice===80);
    }""", timeout=30000)
    state = page.evaluate("""() => {
      const app=window.orderCalculator;
      const binding=app.cloudCollabStores.bindingStore.list()[0];
      const scope=app.cloudCollabStores.syncStore.getScope(binding.groupId,binding.libraryId);
      const queue=app.cloudCollabStores.queueStore.loadResult();
      const lib=app.priceLibraries.libraries.find(x=>x.id===binding.localLibraryId);
      return {binding,scope,queueRecords:queue.value.records,items:lib.items.map(x=>({serviceType:x.serviceType,settleType:x.settleType,unitPrice:x.unitPrice}))};
    }""")
    assert state['scope']['publicVersion'] == 3
    assert len(state['scope']['baseHashes']) == 2
    assert state['scope']['conflicts'] == []
    assert state['queueRecords'] == []
    before = state['items']
    page.wait_for_timeout(2200)
    page.screenshot(path=str(OUT/'阶段3B_移动端只接收同步弹窗.png'), full_page=False)
    mode[0] = 'offline'
    page.locator('#cloudServerCheckBtn').click()
    page.wait_for_function("window.orderCalculator.cloudCollabState.serverStatus === 'offline'", timeout=8000)
    after = page.evaluate("""() => {const app=window.orderCalculator; const b=app.cloudCollabStores.bindingStore.list()[0]; return app.priceLibraries.libraries.find(x=>x.id===b.localLibraryId).items.map(x=>({serviceType:x.serviceType,settleType:x.settleType,unitPrice:x.unitPrice}));}""")
    assert before == after
    result = {'mode':'fresh_receive','coreCalculationOk':'到手：75' in output,'publicVersion':state['scope']['publicVersion'],'baseHashCount':len(state['scope']['baseHashes']),'conflictCount':len(state['scope']['conflicts']),'queueCount':len(state['queueRecords']),'offlinePreservedPrices':before==after,'onlyGetRequests':all(x['method']=='GET' for x in requests),'startupCreatedNoCloudKeys':all(v is None for v in startup.values()),'consoleErrors':console_errors,'apiRequests':requests}
    context.close(); return result

def conflict_incremental_case(browser, base_url):
    mode=['online']
    context, page, console_errors, requests=create_page(browser, mode, base_url)
    page.wait_for_function("window.orderCalculator.cloudCollabState.serverStatus === 'online'", timeout=8000)
    result=page.evaluate("""async ({A_KEY,A100}) => {
      const app=window.orderCalculator;
      const localLibraryId=app.priceLibraries.activeLibraryId;
      app.cloudCollabStores.coordinator.initializeIdentity({nickname:'冲突测试'});
      const tx=app.cloudCollabStores.coordinator.bindLibrary({localLibraryId,groupId:'group_fixture',libraryId:'lib_receive_fixture',mode:'receive',basePublicVersion:1});
      if(!tx.ok) throw tx.error;
      const oldCanonical=JSON.parse(JSON.stringify(app.priceLibraries));
      const oldLegacy=JSON.parse(JSON.stringify(app.priceMemory));
      const data=app.priceLibraryStore.normalizeData(app.priceLibraries);
      const lib=data.libraries.find(x=>x.id===localLibraryId);
      const now=Date.now();
      lib.items=app.priceLibraryStore.normalizeItems([{serviceType:'测试服务A',settleType:'round',unitPrice:90,usageCount:1,createdAt:now,updatedAt:now,lastUsed:now}]).items;
      const saved=app.priceLibraryStore.persist(data,{previousCanonical:oldCanonical,previousLegacy:oldLegacy});
      if(!saved.ok) throw new Error('seed persist failed');
      app.priceLibraries=saved.data; app.priceMemory=saved.activeItems;
      app.cloudCollabStores.syncStore.upsertScope({groupId:'group_fixture',libraryId:'lib_receive_fixture',publicVersion:1,cursor:'pv_1',lastSuccessfulCheckAt:Date.now(),baseHashes:{[A_KEY]:A100},conflicts:[]});
      const binding=app.cloudCollabStores.bindingStore.getByLocalLibraryId(localLibraryId);
      const syncResult=await app.cloudCollabFeature.syncBinding(binding,{interactive:false,force:false,reason:'browser-conflict'});
      const conflictScope=app.cloudCollabStores.syncStore.getScope('group_fixture','lib_receive_fixture');
      const conflictItems=app.priceLibraries.libraries.find(x=>x.id===localLibraryId).items.map(x=>({serviceType:x.serviceType,settleType:x.settleType,unitPrice:x.unitPrice}));

      const beforeResolveCanonical=JSON.parse(JSON.stringify(app.priceLibraries));
      const beforeResolveLegacy=JSON.parse(JSON.stringify(app.priceMemory));
      const resolvedData=app.priceLibraryStore.normalizeData(app.priceLibraries);
      const resolvedLib=resolvedData.libraries.find(x=>x.id===localLibraryId);
      const a=resolvedLib.items.find(x=>x.serviceType==='测试服务A' && x.settleType==='round');
      a.unitPrice=110; a.updatedAt=Date.now();
      const resolvedSaved=app.priceLibraryStore.persist(resolvedData,{previousCanonical:beforeResolveCanonical,previousLegacy:beforeResolveLegacy});
      if(!resolvedSaved.ok) throw new Error('resolve persist failed');
      app.priceLibraries=resolvedSaved.data; app.priceMemory=resolvedSaved.activeItems;
      await app.cloudCollabFeature.syncBinding(binding,{interactive:false,force:true,reason:'browser-conflict-resolve'});
      const resolvedScope=app.cloudCollabStores.syncStore.getScope('group_fixture','lib_receive_fixture');
      return {syncResult,conflictScope,conflictItems,resolvedScope,queue:app.cloudCollabStores.queueStore.loadResult().value.records};
    }""", {'A_KEY':A_KEY,'A100':A100})
    item_map={(x['serviceType'],x['settleType']):x['unitPrice'] for x in result['conflictItems']}
    assert item_map[('测试服务A','round')] == 90
    assert item_map[('测试服务B','hour')] == 80
    assert result['conflictScope']['publicVersion'] == 3
    assert len(result['conflictScope']['conflicts']) == 1
    assert result['conflictScope']['conflicts'][0]['businessKey'] == A_KEY
    assert len(result['resolvedScope']['conflicts']) == 0
    assert result['queue'] == []
    out={'mode':'conflict_incremental','localAWasPreserved':item_map[('测试服务A','round')]==90,'safeBWasApplied':item_map[('测试服务B','hour')]==80,'publicVersion':result['conflictScope']['publicVersion'],'conflictCount':len(result['conflictScope']['conflicts']),'resolvedConflictCount':len(result['resolvedScope']['conflicts']),'queueCount':len(result['queue']),'usedIncrementalEndpoint':any('/api/public-changes' in x['url'] for x in requests),'onlyGetRequests':all(x['method']=='GET' for x in requests),'consoleErrors':console_errors,'apiRequests':requests}
    context.close(); return out

def metadata_rollback_case(browser, base_url):
    mode=['online']
    context, page, console_errors, requests=create_page(browser, mode, base_url)
    page.wait_for_function("window.orderCalculator.cloudCollabState.serverStatus === 'online'", timeout=8000)
    result=page.evaluate("""async () => {
      const app=window.orderCalculator;
      const localLibraryId=app.priceLibraries.activeLibraryId;
      app.cloudCollabStores.coordinator.initializeIdentity({nickname:'回滚测试'});
      const tx=app.cloudCollabStores.coordinator.bindLibrary({localLibraryId,groupId:'group_emptytest',libraryId:'lib_emptytest',mode:'receive',basePublicVersion:0});
      if(!tx.ok) throw tx.error;
      const beforeBindings=JSON.stringify(app.cloudCollabStores.bindingStore.readRaw());
      const beforeSync=JSON.stringify(app.cloudCollabStores.syncStore.readRaw());
      const original=app.cloudCollabStores.bindingStore.updateBasePublicVersion.bind(app.cloudCollabStores.bindingStore);
      app.cloudCollabStores.bindingStore.updateBasePublicVersion=()=>{throw new Error('forced metadata failure')};
      const binding=app.cloudCollabStores.bindingStore.getByLocalLibraryId(localLibraryId);
      const syncResult=await app.cloudCollabFeature.syncBinding(binding,{interactive:false,force:false,reason:'browser-rollback'});
      app.cloudCollabStores.bindingStore.updateBasePublicVersion=original;
      return {syncResult,beforeBindings,afterBindings:JSON.stringify(app.cloudCollabStores.bindingStore.readRaw()),beforeSync,afterSync:JSON.stringify(app.cloudCollabStores.syncStore.readRaw()),lastError:app.cloudCollabFeature.lastError?.code||null,queue:app.cloudCollabStores.queueStore.loadResult().value.records};
    }""")
    assert result['syncResult'] is None
    assert result['beforeBindings'] == result['afterBindings']
    assert result['beforeSync'] == result['afterSync']
    assert result['lastError'] is None
    assert result['queue'] == []
    out={'mode':'metadata_rollback','syncAndBindingRolledBack':result['beforeBindings']==result['afterBindings'] and result['beforeSync']==result['afterSync'],'cloudFeatureStillAvailable':result['lastError'] is None,'queueCount':len(result['queue']),'onlyGetRequests':all(x['method']=='GET' for x in requests),'consoleErrors':console_errors,'apiRequests':requests}
    context.close(); return out

def degraded_case(browser, mode_name, expected, base_url):
    mode=[mode_name]
    context, page, console_errors, requests=create_page(browser, mode, base_url)
    output=calculate(page)
    page.wait_for_function(f"window.orderCalculator.cloudCollabState.serverStatus === '{expected}'", timeout=8000)
    startup=storage_snapshot(page)
    result={'mode':mode_name,'finalStatus':expected,'coreCalculationOk':'到手：75' in output,'startupCreatedNoCloudKeys':all(v is None for v in startup.values()),'onlyGetRequests':all(x['method']=='GET' for x in requests),'consoleErrors':console_errors,'apiRequests':requests}
    context.close(); return result

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path=args.chromium, args=['--no-sandbox'])
    results=[fresh_receive_case(browser, None), conflict_incremental_case(browser, None), metadata_rollback_case(browser, None), degraded_case(browser,'offline','offline',None), degraded_case(browser,'protocol2','protocol_mismatch',None)]
    browser.close()

ignored=lambda e: ('Failed to load resource' in e and ('503' in e or '404' in e)) or 'forced metadata failure' in e
checks={
    'freshSnapshotApplied':results[0]['publicVersion']==3 and results[0]['baseHashCount']==2,
    'offlineAfterSyncPreservesPrices':results[0]['offlinePreservedPrices'],
    'receiveNeverQueuesSubmission':results[0]['queueCount']==0 and results[1]['queueCount']==0,
    'incrementalConflictPreservesLocal':results[1]['localAWasPreserved'] and results[1]['safeBWasApplied'] and results[1]['conflictCount']==1 and results[1]['resolvedConflictCount']==0 and results[1]['usedIncrementalEndpoint'],
    'metadataFailureRollsBackBothKeys':results[2]['syncAndBindingRolledBack'] and results[2]['cloudFeatureStillAvailable'] and results[2]['queueCount']==0,
    'offlineDoesNotBreakCalculation':results[3]['finalStatus']=='offline' and results[3]['coreCalculationOk'],
    'protocolMismatchDoesNotBreakCalculation':results[4]['finalStatus']=='protocol_mismatch' and results[4]['coreCalculationOk'],
    'startupCreatesNoCloudIdentity':results[0]['startupCreatedNoCloudKeys'] and results[3]['startupCreatedNoCloudKeys'] and results[4]['startupCreatedNoCloudKeys'],
    'onlyCredentialFreeGetRequests':all(r['onlyGetRequests'] for r in results),
    'noUnexpectedConsoleErrors':all(not [e for e in r['consoleErrors'] if not ignored(e)] for r in results),
}
report={'stage':'3B-regression','targetVersion':expected_version,'candidateFile':str(candidate_path),'total':len(checks),'passed':sum(checks.values()),'failed':len(checks)-sum(checks.values()),'checks':checks,'cases':results}
(OUT/'阶段3B_Chromium只接收同步结果.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'total':report['total'],'passed':report['passed'],'failed':report['failed']},ensure_ascii=False))
if report['failed']: raise SystemExit(1)
