# Run against an isolated server on 127.0.0.1:4186; requires Playwright and Chromium.
# APP_DATA_DIR=/tmp/sanqing-remember-fixture DATABASE_URL='' INIT_ADMIN_PASSWORD=temporary-pass-123 APP_SESSION_SECRET=fixture-secret python api_server.py --host 127.0.0.1 --port 4186
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 c=b.new_context(viewport={'width':390,'height':844},has_touch=True,is_mobile=True)
 page=c.new_page();dialogs=[];requests=[]
 page.on('dialog',lambda d:(dialogs.append(d.message),d.accept()))
 page.on('request',lambda req:requests.append(req.url))
 def login(username='admin',password='temporary-pass-123',remember=False):
  page.locator('#username').fill(username);page.locator('#password').fill(password)
  if remember:page.locator('#rememberLogin').check()
  page.locator('#loginForm button[type=submit]').click();page.locator('#dashboardView:not(.hidden)').wait_for(timeout=12000)
 def login_screen(): page.locator('#loginView:not(.hidden)').wait_for(timeout=12000)
 page.goto('http://127.0.0.1:4186/',wait_until='networkidle'); assert not any('/api/session/' in x for x in requests),requests
 login();page.reload(wait_until='networkidle');login_screen();assert not any('/api/session/' in x for x in requests)
 print('unchecked login: no cookie and no background restore request',flush=True)
 login(remember=True);cookies=c.cookies();cookie=next(x for x in cookies if x['name']=='__Secure-sanqing_remember');assert cookie['httpOnly'] and cookie['secure'] and cookie['sameSite']=='Strict' and cookie['path']=='/api/session'
 keys=page.evaluate('Object.fromEntries(Object.entries(localStorage))');assert all('.' not in v for k,v in keys.items() if 'Remember' in k or 'Logout' in k)
 page.reload();page.locator('#dashboardView:not(.hidden)').wait_for(timeout=12000);print('opt-in: secure cookie restores without storing credentials in localStorage',flush=True)
 page.locator('#logoutBtn').click();login_screen();page.reload();login_screen();assert not any(x['name']=='__Secure-sanqing_remember' for x in c.cookies());print('online logout: cookie removed and reload remains logged out',flush=True)
 login(remember=True)
 page.route('**/api/session/logout',lambda route: route.abort())
 page.locator('#logoutBtn').click();login_screen();assert page.evaluate("localStorage.getItem('sanqingLogoutPending')")=='1';assert any('網路' in msg for msg in dialogs)
 requests.clear();page.reload();login_screen();page.wait_for_timeout(400);assert not any('/api/session/restore' in x for x in requests)
 page.unroute('**/api/session/logout');page.reload();login_screen();page.wait_for_timeout(600);assert page.evaluate("localStorage.getItem('sanqingLogoutPending')") is None;assert not any(x['name']=='__Secure-sanqing_remember' for x in c.cookies());print('offline logout: reload cannot restore, later online cleanup clears cookie',flush=True)
 login(remember=True);page.route('**/api/session/logout',lambda route: route.abort());requests.clear()
 page.evaluate("document.getElementById('logoutBtn').click(); location.reload()")
 login_screen();page.wait_for_timeout(600);assert page.evaluate("localStorage.getItem('sanqingLogoutPending')")=='1';assert not any('/api/session/restore' in x for x in requests)
 page.unroute('**/api/session/logout');page.reload();login_screen();page.wait_for_timeout(600);assert not any(x['name']=='__Secure-sanqing_remember' for x in c.cookies());print('reload racing logout cannot restore old cookie',flush=True)
 b.close()
