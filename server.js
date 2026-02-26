const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4173;
const DB_FILE = path.join(__dirname, 'db.json');

const companies = [
  { id: 'alpha', name: '上光廠 A 公司' },
  { id: 'beta', name: '上光廠 B 公司' },
  { id: 'gamma', name: '上光廠 C 公司' },
];

const users = {
  alpha: [{ username: 'admin', password: '123456' }],
  beta: [{ username: 'admin', password: '123456' }],
  gamma: [{ username: 'admin', password: '123456' }],
};

const sessions = new Map();
const eventClients = new Map();

function createDefaultDb() {
  return {
    companies: {
      alpha: { workOrders: [], customers: [], finances: [] },
      beta: { workOrders: [], customers: [], finances: [] },
      gamma: { workOrders: [], customers: [], finances: [] },
    },
  };
}

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    const fresh = createDefaultDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

let db = loadDb();

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function getSession(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !sessions.has(token)) {
    return null;
  }
  return sessions.get(token);
}

function broadcast(companyId, payload) {
  const clients = eventClients.get(companyId) || [];
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

function serveStatic(req, res, pathname) {
  const map = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css',
  };
  const file = map[pathname];
  if (!file) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const fullPath = path.join(__dirname, file);
  const ext = path.extname(file);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain; charset=utf-8' });
  fs.createReadStream(fullPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/companies' && req.method === 'GET') {
        return json(res, 200, { companies });
      }

      if (pathname === '/api/login' && req.method === 'POST') {
        const body = await parseBody(req);
        const { companyId, username, password } = body;
        const account = (users[companyId] || []).find((u) => u.username === username && u.password === password);
        if (!account) {
          return json(res, 401, { message: '帳號、密碼或公司錯誤' });
        }
        const token = crypto.randomUUID();
        sessions.set(token, { companyId, username });
        return json(res, 200, { token, companyId, username });
      }

      const session = getSession(req);
      if (!session) {
        return json(res, 401, { message: '請先登入' });
      }

      const companyData = db.companies[session.companyId];

      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        return json(res, 200, companyData);
      }

      if (pathname === '/api/work-orders' && req.method === 'POST') {
        const body = await parseBody(req);
        const item = {
          id: crypto.randomUUID(),
          orderNo: String(body.orderNo || ''),
          product: String(body.product || ''),
          qty: String(body.qty || ''),
          status: String(body.status || '未完成'),
          createdAt: new Date().toISOString(),
        };
        companyData.workOrders.unshift(item);
        saveDb();
        broadcast(session.companyId, { type: 'sync' });
        return json(res, 201, item);
      }

      if (pathname === '/api/customers' && req.method === 'POST') {
        const body = await parseBody(req);
        const item = {
          id: crypto.randomUUID(),
          name: String(body.name || ''),
          contact: String(body.contact || ''),
          level: String(body.level || ''),
          createdAt: new Date().toISOString(),
        };
        companyData.customers.unshift(item);
        saveDb();
        broadcast(session.companyId, { type: 'sync' });
        return json(res, 201, item);
      }

      if (pathname === '/api/finances' && req.method === 'POST') {
        const body = await parseBody(req);
        const item = {
          id: crypto.randomUUID(),
          type: String(body.type || ''),
          amount: String(body.amount || ''),
          note: String(body.note || ''),
          createdAt: new Date().toISOString(),
        };
        companyData.finances.unshift(item);
        saveDb();
        broadcast(session.companyId, { type: 'sync' });
        return json(res, 201, item);
      }

      if (pathname === '/api/delete' && req.method === 'POST') {
        const body = await parseBody(req);
        const { domain, id } = body;
        if (!['workOrders', 'customers', 'finances'].includes(domain)) {
          return json(res, 400, { message: 'invalid domain' });
        }
        companyData[domain] = companyData[domain].filter((item) => item.id !== id);
        saveDb();
        broadcast(session.companyId, { type: 'sync' });
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { message: 'Not found' });
    } catch (error) {
      return json(res, 500, { message: error.message || 'Server error' });
    }
  }

  if (pathname === '/events' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const session = sessions.get(token);
    if (!session) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');

    const current = eventClients.get(session.companyId) || [];
    current.push(res);
    eventClients.set(session.companyId, current);

    req.on('close', () => {
      const now = eventClients.get(session.companyId) || [];
      eventClients.set(
        session.companyId,
        now.filter((client) => client !== res),
      );
    });
    return;
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
