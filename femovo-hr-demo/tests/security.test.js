import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import crypto from 'node:crypto';

process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'test';
const { pool, rawPool } = await import('../server/db.js');
const { app } = await import('../server/index.js');
const { generateToken, hashPin } = await import('../server/auth.js');
const { rateLimit } = await import('../server/security.js');
const { parsePagination, parseDateRange } = await import('../server/domain.js');
const user={id:1,employee_id:'SELF',name:'Synthetic employee',email:'self@example.test',role:'employee',status:'Active',session_version:0,has_dashboard_access:true};
let account={...user};
let calls=[];
let overrides=[];
pool.query=async(sql,values)=>{
  calls.push({sql,values});
  if(sql.includes('FROM user_accounts u')) return {rows:[account],rowCount:1};
  if(sql.includes('FROM user_specific_permissions')) { const rows=values?.length===2?overrides.filter(row=>row.permission_key===values[1]):overrides; return {rows,rowCount:rows.length}; }
  if(sql.includes('FROM role_permissions')) return {rows:[{module:'employees',action:'view',allowed:true},{module:'onboarding',action:'view',allowed:true}],rowCount:2};
  if(sql.includes('FROM employees WHERE')) return {rows:[{id:'SELF',name:'Self'},{id:'OTHER',name:'Other'}],rowCount:2};
  if(sql.includes('FROM applicants')) return {rows:[{id:1,resume_upload_token_hash:'not-a-capability',resume_upload_expires_at:new Date(Date.now()+10000)}],rowCount:1};
  return {rows:[],rowCount:0};
};
rawPool.connect=async()=>{throw Error('A denied request reached a mutation transaction');};
// Exercise Express middleware and routes without a listening port or a database connection.
async function request(method,url,body,token=generateToken(user),extraHeaders={}) {
  calls=[];
  return new Promise((resolve,reject)=>{
    let output='';
    const socket=new Duplex({read(){},write(chunk,encoding,callback){output+=chunk.toString();callback();}});
    socket.remoteAddress='127.0.0.1';
    const req=new http.IncomingMessage(socket);
    req.method=method;req.url=url;req.headers={...(token?{authorization:`Bearer ${token}`}:{ }),...extraHeaders};req.body=body||{};
    const res=new http.ServerResponse(req);res.assignSocket(socket);
    res.on('finish',()=>{
      const raw=output.slice(output.indexOf('\r\n\r\n')+4);
      let data;try{data=JSON.parse(raw);}catch{data=raw;}
      resolve({status:res.statusCode,data,calls:[...calls]});
    });
    res.on('error',reject);
    app.handle(req,res,reject);
  });
}
test('anonymous private API and upload requests are rejected',async()=>{
  assert.equal((await request('GET','/api/employees',null,null)).status,401);
  assert.equal((await request('GET','/api/auth/accounts',null,null)).status,401);
  assert.equal((await request('GET','/uploads/sample_aadhaar.pdf',null,null)).status,401);
});
test('real Express route chain denies privilege and record escalation before writes',async()=>{
  for(const [method,url,body] of [
    ['PUT','/api/employees/SELF',{access_role:'super_admin'}],
    ['PUT','/api/employees/OTHER',{password:'Synthetic-only-password'}],
    ['PUT','/api/roles/employee/permissions',{permissions:{employees:{edit:true}}}],
    ['POST','/api/attendance/regularize',{employeeId:'OTHER'}],
    ['GET','/api/onboarding/profile/OTHER',{}],
    ['PATCH','/api/onboarding/document/1/status',{status:'Verified'}],
    ['POST','/api/ats/resources',{name:'Unapproved'}],
    ['POST','/api/leaves',{employeeId:'SELF'}],
    ['POST','/api/tickets',{employee_id:'SELF'}],
    ['GET','/api/tickets',{}],
    ['POST','/api/exits',{employee_id:'SELF'}],
  ]) {
    const result=await request(method,url,body);
    assert.equal(result.status,403,`${method} ${url}: ${JSON.stringify(result.data)}`);
    assert.ok(!result.calls.some(call=>/^\s*(INSERT|UPDATE|DELETE)/.test(call.sql)));
  }
});
test('server response filters another employee even if a query returns extra rows',async()=>{
  const result=await request('GET','/api/employees');
  assert.equal(result.status,200);
  assert.deepEqual(result.data.map(row=>row.id),['SELF']);
});

test('permission revocation is reflected in both the UI capability response and the protected route',async()=>{
  overrides=[{permission_key:'employees:view',allowed:false}];
  try {
    const capabilities=await request('GET','/api/auth/me/permissions');
    assert.equal(capabilities.status,200);
    assert.equal(capabilities.data.permissions.employees.view,false);
    assert.equal((await request('GET','/api/employees')).status,403);
  } finally { overrides=[]; }
});
test('a formerly valid token fails after revocation or account deactivation',async()=>{
  const token=generateToken(user);
  account={...user,session_version:1};assert.equal((await request('GET','/api/employees',null,token)).status,401);
  account={...user,status:'Inactive'};assert.equal((await request('GET','/api/employees',null,token)).status,401);
  account={...user,has_dashboard_access:false};assert.equal((await request('GET','/api/employees',null,token)).status,401);
  account={...user};
});
test('public resume replacement requires the specific application capability before upload parsing',async()=>{
  assert.equal((await request('POST','/api/applicants/1/resume',{},null)).status,403);
  assert.equal((await request('POST','/api/applicants/1/resume',{},null,{'x-application-token':'unrelated-token'})).status,403);
});
test('configured CORS rejects an unapproved browser origin',async()=>{
  assert.equal((await request('GET','/api/employees',null,undefined,{origin:'https://unapproved.example'})).status,403);
});
test('every registered API route is wrapped by the policy layer',()=>{
  const routes=app._router.stack.filter(layer=>layer.route?.path.startsWith('/api/'));
  assert.ok(routes.length>90);
  assert.equal(routes.length,app.locals.routePolicies.length);
  assert.ok(routes.every(layer=>layer.route.stack.length>=2));
  const paths = new Set(routes.map(layer=>layer.route.path));
  for (const retired of ['/api/salaries', '/api/salaries/:employee_id', '/api/payroll/runs', '/api/payroll/run', '/api/payroll/batches/:id/approve', '/api/payroll/batches/:id/paid', '/api/payroll/bank-neft', '/api/export/payroll', '/api/export/bank-payout']) {
    assert.equal(paths.has(retired), false, `${retired} must remain retired`);
  }
});

test('rateLimit evicts oldest LRU buckets under unique-key flood instead of locking out legitimate users', () => {
  const invoke = (limiter, ip) => {
    let nextCalled = false;
    let statusCode = 200;
    let body = null;
    const req = { ip, headers: {} };
    const res = {
      set() {},
      status(code) { statusCode = code; return this; },
      json(payload) { body = payload; return this; },
      on() {}
    };
    limiter(req, res, () => { nextCalled = true; });
    return { nextCalled, statusCode, body };
  };

  // Flood with >10,000 distinct keys on default capacity; a legitimate new user must still be admitted.
  const defaultLimiter = rateLimit({ max: 2, windowMs: 60_000 });
  for (let i = 0; i < 10050; i++) {
    const res = invoke(defaultLimiter, `203.0.113.${i}`);
    assert.equal(res.nextCalled, true);
    assert.equal(res.statusCode, 200);
  }
  const legitRes = invoke(defaultLimiter, '198.51.100.42');
  assert.equal(legitRes.nextCalled, true);
  assert.equal(legitRes.statusCode, 200);

  // Verify LRU ordering: touching key-A keeps it alive while idle key-B is evicted first when key-C arrives.
  const lruLimiter = rateLimit({ max: 1, maxBuckets: 2, windowMs: 60_000 });
  assert.equal(invoke(lruLimiter, 'key-A').nextCalled, true);
  assert.equal(invoke(lruLimiter, 'key-B').nextCalled, true);
  // Touch key-A again so it exceeds max=1 AND moves to most-recently-used tail; key-B is now oldest.
  const blockedA = invoke(lruLimiter, 'key-A');
  assert.equal(blockedA.nextCalled, false);
  assert.equal(blockedA.statusCode, 429);
  // key-C evicts oldest (key-B), NOT active key-A.
  assert.equal(invoke(lruLimiter, 'key-C').nextCalled, true);
  assert.equal(invoke(lruLimiter, 'key-A').statusCode, 429);
  // key-B was evicted so it receives a fresh bucket when seen again.
  assert.equal(invoke(lruLimiter, 'key-B').nextCalled, true);
});

test('pagination and date-range helpers enforce safe bounds while preserving endpoint arrays', async () => {
  assert.deepEqual(parsePagination({}), { limit: 500, offset: 0 });
  assert.deepEqual(parsePagination({ limit: '50', offset: '10' }), { limit: 50, offset: 10 });
  assert.deepEqual(parsePagination({ limit: '99999' }, { defaultLimit: 500, maxLimit: 1000 }), { limit: 1000, offset: 0 });
  assert.throws(() => parsePagination({ limit: '0' }), /positive whole number/);
  assert.throws(() => parsePagination({ offset: '-1' }), /zero or a positive/);

  assert.deepEqual(parseDateRange({}, { defaultDays: 90, maxDays: 366, anchorDate: '2026-11-11' }), { from: '2026-08-14', to: '2026-11-11' });
  assert.throws(() => parseDateRange({ from: '2024-01-01', to: '2026-11-11' }, { maxDays: 366, anchorDate: '2026-11-11' }), /366 days/);
  assert.throws(() => parseDateRange({ from: '2026-11-12', to: '2026-11-11' }, { maxDays: 366, anchorDate: '2026-11-11' }), /Invalid date range/);

  const empRes = await request('GET', '/api/employees?limit=25&offset=0');
  assert.equal(empRes.status, 200);
  const empCall = empRes.calls.find(c => c.sql.includes('FROM employees WHERE'));
  assert.match(empCall.sql, /LIMIT \$\d+ OFFSET \$\d+/);
  assert.deepEqual(empCall.values.slice(-2), [25, 0]);
});

test('cookie JWT auth issues HttpOnly/SameSite=Lax/Secure cookies, enforces CSRF on writes, and clears on logout', async () => {
  const origQuery = pool.query;
  const origConnect = rawPool.connect;
  const origNodeEnv = process.env.NODE_ENV;
  const hashedPin = await hashPin('Synthetic-Cookie-Pass-123!');

  const rawRequest = (method, url, body, extraHeaders = {}) => new Promise((resolve, reject) => {
    let output = '';
    const socket = new Duplex({ read() {}, write(chunk, _e, cb) { output += chunk.toString(); cb(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = { ...extraHeaders };
    req.body = body || {};
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => {
      const splitIdx = output.indexOf('\r\n\r\n');
      const head = output.slice(0, splitIdx);
      const raw = output.slice(splitIdx + 4);
      const setCookies = head.split('\r\n').filter(l => /^set-cookie:/i.test(l)).map(l => l.replace(/^set-cookie:\s*/i, ''));
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      resolve({ status: res.statusCode, data, setCookies });
    });
    res.on('error', reject);
    app.handle(req, res, reject);
  });

  const adminAcc = {
    ...user,
    role: 'super_admin',
    employee_id: 'SELF',
    pin: hashedPin,
    role_title: 'Super Admin',
    department: 'Exec',
    avatar: 'SA',
    is_head_hr: true
  };
  account = adminAcc;
  pool.query = async (sql, values) => {
    if (sql.includes('FROM user_accounts')) return { rows: [adminAcc], rowCount: 1 };
    if (sql.includes('SELECT has_dashboard_access')) return { rows: [{ has_dashboard_access: true, status: 'Active' }], rowCount: 1 };
    return origQuery(sql, values);
  };
  rawPool.connect = async () => ({
    query: async (sql, values) => (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql) ? { rows: [], rowCount: 0 } : pool.query(sql, values)),
    release() {}
  });

  try {
    // 1. Login over HTTPS sets HttpOnly + Secure + SameSite=Lax femovo_session cookie, femovo_csrf cookie, and omits JSON token
    const loginRes = await rawRequest('POST', '/api/auth/login', { identifier: 'self@example.test', pin: 'Synthetic-Cookie-Pass-123!' }, { 'x-forwarded-proto': 'https' });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.data.token, undefined);
    const sessionLine = loginRes.setCookies.find(c => c.startsWith('femovo_session='));
    const csrfLine = loginRes.setCookies.find(c => c.startsWith('femovo_csrf='));
    assert.ok(sessionLine && /HttpOnly/i.test(sessionLine) && /Secure/i.test(sessionLine) && /SameSite=Lax/i.test(sessionLine));
    assert.ok(csrfLine && !/HttpOnly/i.test(csrfLine) && /Secure/i.test(csrfLine) && /SameSite=Lax/i.test(csrfLine));

    const sessionVal = sessionLine.split(';')[0].split('=')[1];
    const csrfVal = csrfLine.split(';')[0].split('=')[1];
    const cookieHdr = `femovo_session=${sessionVal}; femovo_csrf=${csrfVal}`;

    // 2. GET /api/auth/me works solely via HttpOnly cookie
    const meRes = await rawRequest('GET', '/api/auth/me', null, { cookie: cookieHdr });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.authenticated, true);
    assert.equal(meRes.data.user.selfId, 'SELF');

    // 3. State-changing request with cookie WITHOUT matching X-CSRF-Token -> 403 CSRF_INVALID
    const missingCsrf = await rawRequest('POST', '/api/departments', { name: 'NewDept' }, { cookie: cookieHdr });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.data.code, 'CSRF_INVALID');

    const badCsrf = await rawRequest('POST', '/api/departments', { name: 'NewDept' }, { cookie: cookieHdr, 'x-csrf-token': 'forged' });
    assert.equal(badCsrf.status, 403);

    // 4. POST /api/auth/logout requires matching CSRF token when session cookie exists and clears cookies
    const badLogout = await rawRequest('POST', '/api/auth/logout', {}, { cookie: cookieHdr });
    assert.equal(badLogout.status, 403);

    const logoutRes = await rawRequest('POST', '/api/auth/logout', {}, { cookie: cookieHdr, 'x-csrf-token': csrfVal });
    assert.equal(logoutRes.status, 200);
    assert.ok(logoutRes.setCookies.some(c => c.startsWith('femovo_session=;') || /femovo_session=.*Expires=Thu, 01 Jan 1970/i.test(c)));
  } finally {
    pool.query = origQuery;
    rawPool.connect = origConnect;
    process.env.NODE_ENV = origNodeEnv;
    account = { ...user };
  }
});
