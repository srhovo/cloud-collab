#!/usr/bin/env python3
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools'
ORIGIN = 'http://stage8e.test'
FILES = {
    '/tools/production-secret-generator.html': ('text/html; charset=utf-8', 'production-secret-generator.html'),
    '/tools/production-secret-generator.css': ('text/css; charset=utf-8', 'production-secret-generator.css'),
    '/tools/production-secret-generator.js': ('application/javascript; charset=utf-8', 'production-secret-generator.js'),
}


def main() -> None:
    requested, unexpected = [], []

    def serve(route) -> None:
        path = route.request.url.removeprefix(ORIGIN)
        requested.append(path)
        if path not in FILES:
            if path != '/favicon.ico':
                unexpected.append(path)
            route.abort()
            return
        content_type, filename = FILES[path]
        route.fulfill(status=200, content_type=content_type, body=(TOOL / filename).read_text(encoding='utf-8'))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        page.set_default_timeout(5000)
        page.route(f'{ORIGIN}/**', serve)
        page.goto(f'{ORIGIN}/tools/production-secret-generator.html', wait_until='networkidle')

        assert page.evaluate('window.PRODUCTION_GENERATOR_READY') is True
        assert page.evaluate('localStorage.length') == 0
        assert page.evaluate('sessionStorage.length') == 0
        expect(page.locator('#selectAll')).to_be_disabled()

        page.click('#generate')
        values = page.locator('[data-private-name]').evaluate_all('(nodes) => nodes.map(node => node.value)')
        assert len(values) == 8 and len(set(values)) == 8
        assert all(len(value) == 64 for value in values)
        expect(page.locator('#selectAll')).to_be_enabled()

        block = page.locator('#envBlock').input_value()
        assert 'CLOUD_PRODUCTION_ENABLED=0' in block
        assert 'CLOUD_PRODUCTION_BOOTSTRAP_ENABLED=0' in block
        assert all(value in block for value in values)
        assert '=1\n' not in block

        page.fill('#publicOrigin', 'https://app.example.com')
        page.fill('#adminOrigin', 'https://admin.example.com')
        block = page.locator('#envBlock').input_value()
        assert 'CLOUD_PRODUCTION_PUBLIC_ORIGIN=https://app.example.com' in block
        assert 'CLOUD_ADMIN_PUBLIC_ORIGIN=https://admin.example.com' in block

        page.fill('#publicOrigin', 'https://example.com/?eo_token=forbidden')
        expect(page.locator('#envBlock')).to_have_value('')
        expect(page.locator('#status')).to_contain_text('不得使用临时预览链接')

        page.fill('#publicOrigin', '')
        page.click('#clear')
        expect(page.locator('#envBlock')).to_have_value('')
        assert page.locator('[data-private-name]').evaluate_all('(nodes) => nodes.every(node => node.value === "")')

        page.click('#generate')
        page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        expect(page.locator('#envBlock')).to_have_value('')
        assert page.locator('[data-private-name]').evaluate_all('(nodes) => nodes.every(node => node.value === "")')
        browser.close()

    assert set(FILES).issubset(set(requested))
    assert unexpected == []
    print('stage8e offline production generator browser regression passed')


if __name__ == '__main__':
    main()
