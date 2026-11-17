"""End-to-end order-save regression against an isolated local server.

Run: python tests/order_save_browser_smoke.py
Requires Playwright and /usr/bin/chromium. No production data is touched.
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Error, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = 'temporary-fixture-pass-123'
GATE = r'''() => {
  const original = window.fetch.bind(window);
  window.__saveGate = { blocked: false, mode: 'pass', requests: [] };
  window.fetch = async (url, options = {}) => {
    const path = typeof url === 'string' ? url : url.url;
    if (path.includes('/api/orders/draft-key') && window.__denyDraftKey) return new Response('{}', {status:503});
    if (path.includes('/api/data/orders/') && String(options.method || 'GET').toUpperCase() === 'PUT') {
      const gate = window.__saveGate;
      gate.requests.push({url: path, body: JSON.parse(options.body)});
      while (gate.blocked) await new Promise(resolve => setTimeout(resolve, 20));
      if (gate.mode === 'conflict') return new Response(JSON.stringify({ok:false,error:'資料已更新',conflict:true}), {status:409,headers:{'Content-Type':'application/json'}});
      const result = await original(url, options);
      if (gate.mode === 'lost') throw new TypeError('simulated lost response after write');
      return result;
    }
    return original(url, options);
  };
}'''


def wait_for_server(url, proc):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError('fixture server exited')
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except OSError:
            time.sleep(.1)
    raise RuntimeError('fixture server did not start')


def new_page(browser, base, deny_draft_key=False):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    ctx.add_init_script('(' + GATE + ')()')
    if deny_draft_key:
        ctx.add_init_script('window.__denyDraftKey = true')
    page = ctx.new_page()
    dialogs = []
    page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
    page.goto(base, wait_until='networkidle')
    page.locator('#username').fill('admin')
    page.locator('#password').fill(PASSWORD)
    page.locator('#loginForm button[type=submit]').click()
    page.locator('#dashboardView:not(.hidden)').wait_for(timeout=15000)
    page.locator('[data-target="ordersView"]').click()
    page.locator('#ordersListScreen:not(.hidden)').wait_for()
    return ctx, page, dialogs


def new_order(page, number):
    page.locator('#ordersView [data-order-screen="form"]').first.click()
    page.locator('#ordersFormScreen:not(.hidden)').wait_for()
    page.locator('#orderNumber').fill(number)
    page.locator('#orderItemName').fill('測試品名')
    page.locator('#sheetCount').fill('120')


def gate(page, mode='pass', blocked=True):
    page.evaluate('([mode, blocked]) => { Object.assign(window.__saveGate, {mode, blocked, requests: []}); }', [mode, blocked])


def wait_requests(page, n=1):
    try:
        page.wait_for_function('(n) => window.__saveGate.requests.length >= n', arg=n, timeout=10000)
    except Exception:
        print('save diagnostic:', page.evaluate("({status:document.querySelector('#orderSaveStatus')?.textContent, blocked:document.querySelector('#orderForm')?.dataset.saveBlocked, button:document.querySelector('#saveOrderBtn')?.textContent})"), flush=True)
        raise


def release(page):
    page.evaluate('window.__saveGate.blocked = false')


def count_requests(page):
    return page.evaluate('window.__saveGate.requests.length')


def open_saved_order(page, number):
    cell = page.locator('#ordersTbody tr').filter(has_text=number).first.locator('td.order-number-copy')
    for attempt in range(3):
        try:
            cell.scroll_into_view_if_needed()
            break
        except Error:
            if attempt == 2:
                raise
            page.wait_for_timeout(300)
    page.wait_for_timeout(350)  # allow mobile scroll events to settle before the tap
    cell.tap()
    page.locator('#ordersFormScreen:not(.hidden)').wait_for(timeout=5000)


def form_visible(page):
    return page.locator('#ordersFormScreen').is_visible()


def wait_idle(page):
    page.wait_for_function("() => !document.querySelector('#saveOrderBtn').disabled", timeout=15000)


def main():
    with tempfile.TemporaryDirectory(prefix='sanqing-order-ui-') as data_dir:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        env = dict(os.environ, APP_DATA_DIR=data_dir, DATABASE_URL='', INIT_ADMIN_PASSWORD=PASSWORD,
                   APP_SESSION_SECRET='isolated-order-fixture-secret')
        with tempfile.TemporaryFile(mode='w+') as log:
            proc = subprocess.Popen([sys.executable, 'api_server.py', '--host', '127.0.0.1', '--port', str(port)],
                                    cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                wait_for_server(base, proc)
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
                    try:
                        # A request in flight remains visible, indicates progress, and rejects a second submit.
                        ctx, page, dialogs = new_page(browser, base)
                        new_order(page, 'UI-WAIT-001')
                        gate(page)
                        page.locator('#saveOrderBtn').click()
                        wait_requests(page)
                        assert form_visible(page)
                        assert page.locator('#saveOrderBtn').is_disabled()
                        assert '處理' in page.locator('#saveOrderBtn').inner_text() or '儲存' in page.locator('#orderSaveStatus').inner_text()
                        page.evaluate("document.querySelector('#orderForm').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))")
                        page.wait_for_timeout(200)
                        assert count_requests(page) == 1, 'second submit sent a duplicate write'
                        # An edit made after submission must survive the first response.
                        page.locator('#orderItemName').fill('尚未送出的新內容')
                        release(page)
                        wait_idle(page)
                        assert form_visible(page), 'confirmation erased newer edits'
                        assert page.locator('#orderItemName').input_value() == '尚未送出的新內容'
                        print('pending, duplicate submit and edits during save: OK', flush=True)
                        ctx.close()

                        # A normal confirmed write can return to the list and must be editable.
                        ctx, page, dialogs = new_page(browser, base)
                        new_order(page, 'UI-CONFLICT-002')
                        gate(page, blocked=False)
                        page.locator('#saveOrderBtn').click()
                        page.locator('#ordersListScreen:not(.hidden)').wait_for(timeout=15000)
                        open_saved_order(page, 'UI-CONFLICT-002')
                        page.locator('#orderItemName').fill('本機編輯保留')
                        gate(page, mode='conflict')
                        page.locator('#saveOrderBtn').click()
                        wait_requests(page)
                        captured = page.evaluate('window.__saveGate.requests[0].body')
                        assert captured.get('_expectedVersion', 0), 'existing order was saved without the version that was opened'
                        release(page)
                        page.wait_for_function("() => document.querySelector('#orderForm').dataset.saveBlocked === 'conflict'", timeout=15000)
                        assert form_visible(page)
                        assert page.locator('#orderItemName').input_value() == '本機編輯保留'
                        print('server conflict retains the form and sends the viewed version: OK', flush=True)
                        ctx.close()

                        # Switching to another order while the first is in flight must not
                        # let the first response erase or close the newly opened form.
                        ctx, page, dialogs = new_page(browser, base)
                        new_order(page, 'UI-NAV-004')
                        gate(page)
                        page.locator('#saveOrderBtn').click()
                        wait_requests(page)
                        page.locator('#ordersView [data-order-screen="list"]').first.click()
                        page.locator('#ordersListScreen:not(.hidden)').wait_for()
                        open_saved_order(page, 'UI-CONFLICT-002')
                        page.locator('#orderItemName').fill('另一張工單的新內容')
                        release(page)
                        page.wait_for_timeout(800)
                        assert form_visible(page), 'first response closed a different order'
                        assert page.locator('#orderNumber').input_value() == 'UI-CONFLICT-002'
                        assert page.locator('#orderItemName').input_value() == '另一張工單的新內容'
                        print('list navigation and opening another order during save: OK', flush=True)
                        ctx.close()

                        # Model the critical case: server saved successfully, but the response vanished.
                        ctx, page, dialogs = new_page(browser, base)
                        new_order(page, 'UI-LOST-003')
                        gate(page, mode='lost')
                        page.locator('#saveOrderBtn').click()
                        wait_requests(page)
                        captured = page.evaluate('window.__saveGate.requests[0]')
                        release(page)
                        page.locator('#orderVerifySaveBtn').wait_for(state='visible', timeout=15000)
                        assert form_visible(page)
                        assert page.locator('#orderNumber').input_value() == 'UI-LOST-003'
                        assert page.locator('#saveOrderBtn').is_disabled(), 'unknown result may not be retried blindly'
                        page.evaluate("document.querySelector('#orderForm').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))")
                        page.wait_for_timeout(200)
                        assert count_requests(page) == 1
                        page.evaluate("window.__saveGate.mode = 'pass'")
                        page.locator('#orderVerifySaveBtn').click()
                        page.wait_for_function("() => document.querySelector('#orderSaveStatus').textContent.includes('已確認')", timeout=15000)
                        assert page.locator('#orderNumber').input_value() == 'UI-LOST-003'
                        assert page.evaluate("Number(document.querySelector('#orderForm').dataset.expectedVersion)") > 0
                        assert not page.locator('#saveOrderBtn').is_disabled()
                        assert count_requests(page) == 1, 'verification must not send another PUT'
                        assert captured['body'].get('id'), 'request needs a stable identifier for verification'
                        print('lost response blocks retry and verification does not write twice: OK', flush=True)
                        ctx.close()
                        # When the encryption key is unavailable, protect the
                        # current unsaved form without locking the work-order list.
                        ctx, page, dialogs = new_page(browser, base, deny_draft_key=True)
                        new_order(page, 'UI-UNPROTECTED-006')
                        page.wait_for_function("() => document.querySelector('[aria-label=\"工單草稿\"] [role=status]').textContent.includes('無法保護')", timeout=10000)
                        page.locator('#clearOrderBtn').click()
                        assert any('無法保存工單草稿' in message for message in dialogs), dialogs
                        assert page.locator('#orderNumber').input_value() == 'UI-UNPROTECTED-006'
                        page.locator('#ordersView [data-order-screen="list"]').first.click()
                        page.locator('#ordersListScreen:not(.hidden)').wait_for()
                        # Directly invoke the same row-edit handler after the list is visible;
                        # separate tests exercise the actual mobile tap and list rendering.
                        page.evaluate("""async () => {
                          const entries = performance.getEntriesByType('resource').map(e => e.name);
                          const {state} = await import(entries.find(url => url.includes('/js/store.js?')));
                          const {openOrderForEdit} = await import(entries.find(url => url.includes('/js/orders.js?')));
                          const other = state.orders.find(item => item.orderNumber === 'UI-CONFLICT-002');
                          if (!other) throw new Error('fixture order missing');
                          openOrderForEdit(state, other.id);
                        }""")
                        assert len(dialogs) >= 2, dialogs
                        assert page.locator('#orderNumber').input_value() == 'UI-UNPROTECTED-006'
                        print('unavailable draft protection preserves form while list remains accessible: OK', flush=True)
                        ctx.close()

                        # Draft data survives reload but stays private between accounts
                        # using the same browser profile. No order write is performed.
                        ctx, page, dialogs = new_page(browser, base)
                        new_order(page, 'PRIVATE-DRAFT-005')
                        page.locator('#orderItemName').fill('帳號私有草稿內容')
                        page.wait_for_function("() => [...document.querySelectorAll('[aria-label=\"選擇工單草稿\"] option')].some(o => o.textContent.includes('PRIVATE-DRAFT-005'))", timeout=15000)
                        stored = page.evaluate("Object.entries(localStorage).filter(([k]) => k.startsWith('sanqing-order-draft-v1:')).map(([,v]) => v).join(' ')")
                        assert stored and 'PRIVATE-DRAFT-005' not in stored and '帳號私有草稿內容' not in stored
                        created = page.evaluate("""async () => {
                          const storeUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(url => url.includes('/js/store.js?'));
                          const {state} = await import(storeUrl);
                          const res = await fetch('/api/users', {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.authToken},body:JSON.stringify({action:'create_account',username:'draft-other',password:'other-fixture-pass-123',display:'另一位員工',role:'ops',allowedViews:['ordersView']})});
                          return {status:res.status, data:await res.json()};
                        }""")
                        assert created['status'] == 200, created
                        page.reload(wait_until='networkidle')
                        page.locator('#loginView:not(.hidden)').wait_for(timeout=15000)
                        page.locator('#username').fill('admin')
                        page.locator('#password').fill(PASSWORD)
                        page.locator('#loginForm button[type=submit]').click()
                        page.locator('#dashboardView:not(.hidden)').wait_for(timeout=15000)
                        page.locator('[data-target="ordersView"]').click()
                        page.locator('#ordersView [data-order-screen="form"]').first.click()
                        select = page.locator('[aria-label="選擇工單草稿"]')
                        page.wait_for_function("() => [...document.querySelectorAll('[aria-label=\"選擇工單草稿\"] option')].some(o => o.textContent.includes('PRIVATE-DRAFT-005'))", timeout=15000)
                        select.select_option(label=next(o.inner_text() for o in select.locator('option').all() if 'PRIVATE-DRAFT-005' in o.inner_text()))
                        page.get_by_role('button', name='恢復草稿').click()
                        page.wait_for_function("() => document.querySelector('#orderItemName').value === '帳號私有草稿內容'")
                        assert page.locator('#orderNumber').input_value() == 'PRIVATE-DRAFT-005'
                        page.locator('#ordersView [data-back]').click()
                        page.locator('#logoutBtn').click()
                        page.locator('#loginView:not(.hidden)').wait_for(timeout=15000)
                        page.locator('#username').fill('draft-other')
                        page.locator('#password').fill('other-fixture-pass-123')
                        page.locator('#loginForm button[type=submit]').click()
                        page.locator('#dashboardView:not(.hidden)').wait_for(timeout=15000)
                        page.locator('[data-target="ordersView"]').click()
                        page.locator('#ordersView [data-order-screen="form"]').first.click()
                        page.wait_for_function("() => document.querySelector('[aria-label=\"工單草稿\"] [role=status]').textContent.includes('加密保存在')", timeout=15000)
                        assert 'PRIVATE-DRAFT-005' not in select.inner_text()
                        assert page.locator('#orderItemName').input_value() != '帳號私有草稿內容'
                        print('encrypted draft survives reload and stays isolated across accounts: OK', flush=True)
                        ctx.close()
                    finally:
                        browser.close()
            except Exception:
                log.seek(0)
                print('Fixture server log:\n' + log.read()[-4000:], file=sys.stderr)
                raise
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


if __name__ == '__main__':
    main()
