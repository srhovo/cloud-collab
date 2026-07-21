#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'admin' / 'production-console.html').read_text(encoding='utf-8')
CSS = (ROOT / 'admin' / 'production-console.css').read_text(encoding='utf-8')
JS = (ROOT / 'admin' / 'production-console.js').read_text(encoding='utf-8')
ORIGIN = 'http://stage8c.test'

MOCK = r'''
(() => {
  let session = false;
  const response = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
    status,
    headers: {'Content-Type': 'application/json', ...headers},
  });
  const envelope = data => ({ok: true, serviceId: 'stage8c-browser', apiVersion: 'test', mode: 'production', data});
  const production = extra => ({
    ...extra,
    capabilities: {productionAdmin: true, syntheticFixtureOnly: false},
    stablePromotionAuthorized: false,
    realSecretValuesExposed: false,
  });
  window.__stage8cRequests = [];
  window.fetch = async (path, init = {}) => {
    path = String(path);
    window.__stage8cRequests.push({path, method: init.method || 'GET', body: init.body || null});
    if (path === '/api/admin/auth/session') {
      return session
        ? response(envelope({authenticated: true, username: 'xiaxue', sessionIdSuffix: 'A8C1', expiresAt: 1784670900000, capabilities: {productionAdmin: true, stablePromotionAuthorized: false}, realSecretValuesExposed: false}))
        : response({ok: false, error: {code: 'ADMIN_SESSION_MISSING', message: 'missing'}}, 401);
    }
    if (path === '/api/admin/auth/login') {
      const body = JSON.parse(init.body || '{}');
      if (JSON.stringify(body) !== JSON.stringify({schemaVersion: 1, username: 'xiaxue', password: 'secret-value'})) throw new Error('unexpected login body');
      session = true;
      return response(envelope({authenticated: true, username: 'xiaxue', sessionIdSuffix: 'A8C1', expiresAt: 1784670900000, capabilities: {productionAdmin: true, stablePromotionAuthorized: false}, realSecretValuesExposed: false}));
    }
    if (path === '/api/admin/auth/logout') { session = false; return new Response(null, {status: 204}); }
    if (path === '/api/admin/reviews') return response(envelope(production({total: 0, items: []})));
    if (path === '/api/admin/sensitive-reviews') return response(envelope(production({count: 0, items: [], sensitiveSubmissionIntakeEnabled: false})));
    if (path === '/api/admin/exports/summary') return response(envelope(production({
      viewer: {authenticated: true},
      summary: {
        publicVersion: 12,
        packageId: 'pkg_v2_' + 'A'.repeat(43),
        filename: 'test.zip',
        byteLength: 2048,
        fileCount: 5,
        recordCount: 7,
        tombstoneCount: 1,
        ordinaryEventCount: 9,
        sensitiveEventCount: 3,
        countsByType: {},
        generatedAt: '2026-07-21T00:00:00.000Z',
      },
    })));
    if (path === '/api/admin/exports/download') {
      const body = JSON.parse(init.body || '{}');
      if (body.confirmation !== 'EXPORT_FULL_PUBLIC_DATABASE' || !String(body.requestId).startsWith('exrq_v1_')) throw new Error('unexpected export body');
      return new Response(new Uint8Array([80, 75, 3, 4, 1]), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'X-Cloud-Collab-Package-Id': 'pkg_v2_' + 'B'.repeat(43),
          'X-Cloud-Collab-Public-Version': '12',
          'X-Cloud-Collab-Export-Duplicate': '0',
          'X-Cloud-Collab-Stable-Promotion-Authorized': '0',
        },
      });
    }
    return response({ok: false, error: {code: 'UNMOCKED', message: path}}, 404);
  };
})();
'''


def serve_console(route) -> None:
    path = route.request.url.removeprefix(ORIGIN)
    if path == '/admin/production-console.html':
        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=HTML)
        return
    if path == '/admin/production-console.css':
        route.fulfill(status=200, content_type='text/css; charset=utf-8', body=CSS)
        return
    if path == '/admin/production-console.js':
        route.fulfill(status=200, content_type='application/javascript; charset=utf-8', body=f'{MOCK}\n{JS}')
        return
    route.abort()


def main() -> None:
    with sync_playwright() as playwright:
      browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
      page = browser.new_page(accept_downloads=True)
      page.set_default_timeout(5000)
      page.route(f'{ORIGIN}/**', serve_console)
      page.goto(f'{ORIGIN}/admin/production-console.html', wait_until='domcontentloaded')

      expect(page.locator('#sessionChip')).to_have_text('未登录')
      expect(page.locator('#loginBtn')).to_be_enabled()
      assert page.evaluate('location.origin') == ORIGIN
      assert page.evaluate('localStorage.length') == 0
      assert page.evaluate('sessionStorage.length') == 0

      page.fill('#username', 'xiaxue')
      page.fill('#password', 'secret-value')
      page.click('#loginBtn')
      expect(page.locator('#sessionChip')).to_contain_text('xiaxue')
      expect(page.locator('#password')).to_have_value('')

      page.click('button[data-module="exact"]')
      page.click('button[data-refresh="exact"]')
      expect(page.locator('#exactStatus')).to_contain_text('0 项')

      page.click('button[data-module="sensitive"]')
      page.click('button[data-refresh="sensitive"]')
      expect(page.locator('#sensitiveStatus')).to_contain_text('入口已暂停')

      page.click('button[data-module="export"]')
      page.click('button[data-refresh="export"]')
      expect(page.locator('#exportPublicVersion')).to_have_text('12')
      expect(page.locator('#exportBytes')).to_have_text('2.0 KB')
      expect(page.locator('#exportPackageSuffix')).to_contain_text('AAAAAAAAAA')

      page.on('dialog', lambda dialog: dialog.accept())
      with page.expect_download() as download_info:
        page.click('#downloadBtn')
      assert download_info.value.suggested_filename == '码单器公共数据库完整导出.zip'
      expect(page.locator('#exportStatus')).to_contain_text('公共版本 12')
      expect(page.locator('#exportStatus')).to_contain_text('BBBBBBBBBB')
      requests = page.evaluate('window.__stage8cRequests')
      export_request = [item for item in requests if item['path'] == '/api/admin/exports/download'][-1]
      assert 'EXPORT_FULL_PUBLIC_DATABASE' in export_request['body']

      page.click('button[data-module="auth"]')
      page.click('#logoutBtn')
      expect(page.locator('#sessionChip')).to_contain_text('已退出')
      expect(page.locator('#exportFacts')).to_be_hidden()
      assert page.evaluate('localStorage.length') == 0
      assert page.evaluate('sessionStorage.length') == 0
      browser.close()

    print('stage8c production admin console browser regression passed')


if __name__ == '__main__':
    main()
