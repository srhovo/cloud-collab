from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = (ROOT/'src/码单器8.2.26_公共协作本地候选版.html').read_text(encoding='utf-8')
CAND = (ROOT/'dist/index.html').read_text(encoding='utf-8')
OUT = ROOT/'test-results/阶段3B_核心计算对比结果.json'

def run(browser, html):
    page = browser.new_page()
    page.goto('about:blank')
    page.evaluate("""Object.defineProperty(window,'localStorage',{value:{_d:{},getItem(k){return Object.prototype.hasOwnProperty.call(this._d,k)?this._d[k]:null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]},clear(){this._d={}},get length(){return Object.keys(this._d).length},key(i){return Object.keys(this._d)[i]??null}}, configurable:true})""")
    page.set_content(html, wait_until='domcontentloaded')
    page.wait_for_function('window.orderCalculator')
    for key, value in {'totalPrice':'100','discount':'1','paiDan':'派单A','peiPei':'陪陪A','boss':'老板A','type':'王者荣耀','duration':'1小时','note':'兼容测试'}.items():
        page.locator(f'#{key}').fill(value)
    page.locator('#calculateBtn').click()
    page.wait_for_function("document.querySelector('#orderOutput').textContent.includes('到手：75')")
    data = {
        'discountedPrice': page.locator('#discountedPrice').text_content(),
        'groupCommission': page.locator('#groupCommission').text_content(),
        'platformCommission': page.locator('#platformCommission').text_content(),
        'earnings': page.locator('#earnings').text_content(),
        'output': page.locator('#orderOutput').text_content(),
    }
    page.close()
    return data

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    base=run(browser,BASE)
    cand=run(browser,CAND)
    browser.close()
result={'baseVersion':'8.2.26','candidateVersion':'8.2.27','same':base==cand,'base':base,'candidate':cand}
OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'same':result['same']},ensure_ascii=False))
if not result['same']: raise SystemExit(1)
