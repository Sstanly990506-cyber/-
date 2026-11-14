# Run against isolated fixture server on 127.0.0.1:4186; requires Playwright and Chromium.
# APP_DATA_DIR=/tmp/sanqing-remember-fixture DATABASE_URL='' INIT_ADMIN_PASSWORD=temporary-pass-123 APP_SESSION_SECRET=fixture-secret python api_server.py --host 127.0.0.1 --port 4186
import uuid
from playwright.sync_api import sync_playwright
username = "remember_" + uuid.uuid4().hex[:8]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox']);c=b.new_context();page=c.new_page();messages=[];requests=[]
 page.on('dialog',lambda d:(messages.append(d.message),d.accept()));page.on('request',lambda req:requests.append(req.url))
 api=p.request.new_context(base_url='http://127.0.0.1:4186');response=api.post('/api/users',data={'action':'login','username':'admin','password':'temporary-pass-123'});token=response.json()['token']
 result=api.post('/api/users',headers={'Authorization':'Bearer '+token},data={'action':'create_account','username':username,'display':'Second user','role':'viewer','allowedViews':[],'password':'different-pass-123'});assert result.ok, result.text()
 page.goto('http://127.0.0.1:4186/');page.locator('#username').fill('admin');page.locator('#password').fill('temporary-pass-123');page.locator('#rememberLogin').check();page.locator('#loginForm button[type=submit]').click();page.locator('#dashboardView:not(.hidden)').wait_for(timeout=10000)
 old_cookie=next(x for x in c.cookies() if x['name']=='__Secure-sanqing_remember')
 page.locator('#logoutBtn').click();page.locator('#loginView:not(.hidden)').wait_for();c.add_cookies([old_cookie])
 page.locator('#username').fill(username);page.locator('#password').fill('different-pass-123');page.locator('#rememberLogin').check()
 page.route('**/api/session/remember',lambda route: route.abort())
 page.locator('#loginForm button[type=submit]').click();page.wait_for_timeout(700)
 assert page.evaluate("localStorage.getItem('sanqingLogoutPending')")=='1';assert page.locator('#loginView').is_visible()
 page.unroute('**/api/session/remember');requests.clear();page.reload();page.locator('#loginView:not(.hidden)').wait_for();page.wait_for_timeout(500)
 assert not any('/api/session/restore' in x for x in requests),requests
 assert not any(x['name']=='__Secure-sanqing_remember' for x in c.cookies())
 print('switch accounts: interrupted remember never restores prior account',flush=True)
 b.close()
