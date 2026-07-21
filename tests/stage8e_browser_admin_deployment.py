#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import subprocess
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / 'deploy' / 'admin'
OUTPUT = PROJECT / '.edgeone-admin-artifact'
ORIGIN = 'http://admin-stage8e.test'
COMMIT = 'e' * 40

mimetypes.add_type('application/javascript', '.js')


def prepare() -> None:
    env = {**os.environ, 'GITHUB_SHA': COMMIT}
    subprocess.run(
        ['node', 'scripts/prepare-admin-deployment-root-v1.mjs', '--repository-root', '.', '--project-root', 'deploy/admin', '--commit', COMMIT],
        cwd=ROOT,
        check=True,
        env=env,
        capture_output=True,
        text=True,
    )


def mime(path: Path) -> str:
    if path.name == 'admin-release.json':
        return 'application/json; charset=utf-8'
    if path.suffix == '.html':
        return 'text/html; charset=utf-8'
    if path.suffix == '.css':
        return 'text/css; charset=utf-8'
    if path.suffix == '.js':
        return 'application/javascript; charset=utf-8'
    return 'application/octet-stream'


def main() -> None:
    prepare()
    release = json.loads((OUTPUT / 'admin-release.json').read_text(encoding='utf-8'))
    assert release['sourceCommit'] == COMMIT
    assert release['frozenPublicCandidate']['sha256'] == '9a9719e70dce94d875befb287d247fca0755183da7c813779310abb57ba3882b'

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        messages: list[str] = []
        page.on('console', lambda message: messages.append(f'{message.type}: {message.text}'))
        page.on('pageerror', lambda error: messages.append(f'pageerror: {error}'))

        def route_handler(route):
            url = route.request.url
            path = '/' + url.split('/', 3)[3] if url.count('/') >= 3 else '/'
            if path == '/':
                path = '/index.html'
            if path.startswith('/api/admin/'):
                route.fulfill(
                    status=503,
                    content_type='application/json; charset=utf-8',
                    body=json.dumps({
                        'ok': False,
                        'serviceId': 'stage8e-browser',
                        'apiVersion': 'test',
                        'error': {'code': 'PRODUCTION_ADMIN_DISABLED', 'message': '正式管理员身份能力未开启'},
                    }, ensure_ascii=False),
                )
                return
            target = OUTPUT / path.removeprefix('/')
            if target.exists() and target.is_file():
                route.fulfill(status=200, content_type=mime(target), body=target.read_bytes())
                return
            route.fulfill(status=404, content_type='text/plain; charset=utf-8', body='not found')

        page.route(f'{ORIGIN}/**', route_handler)
        page.goto(f'{ORIGIN}/', wait_until='domcontentloaded')
        expect(page).to_have_title('码单器正式管理员控制台')
        expect(page.locator('#authStatus')).to_contain_text('错误码：PRODUCTION_ADMIN_DISABLED')
        expect(page.locator('#sessionChip')).to_have_text('未登录')
        for module in ['exact', 'ordinary', 'sensitive', 'devices', 'rollback', 'export']:
            expect(page.locator(f'button[data-module="{module}"]')).to_be_disabled()
        assert page.evaluate('localStorage.length') == 0
        assert page.evaluate('sessionStorage.length') == 0
        assert not messages, messages
        browser.close()

    print('stage8e admin deployment browser regression passed')


if __name__ == '__main__':
    main()
