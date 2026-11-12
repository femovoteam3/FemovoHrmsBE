import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import crypto from 'node:crypto';

process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'test';
const { pool, rawPool } = await import('../server/db.js');
const { app } = await import('../server/index.js');
const { generateToken } = await import('../server/auth.js');

const actor = (role, extra = {}) => ({ id: 1, employee_id: 'ACTOR', name: 'Real Name', email: 'actor@example.test', role, status: 'Active', session_version: 0, has_dashboard_access: true, ...extra });
const allowed = [['attendance', 'view'], ['attendance', 'regularize'], ['employees', 'view'], ['employees', 'edit'], ['exits', 'view'], ['exits', 'submit_resignation'], ['exits', 'clearance_settlement'], ['dashboard', 'view_analytics'], ['ats', 'issue_offers'], ['notices', 'view']].map(([module, action]) => ({ module, action, allowed: true }));
const EXIT = { employee_id: 'TARGET', resignation_date: '2026-11-01', last_working_date: '2026-11-30', reason: 'Moving' };
let account = actor('employee');
let openExits = 0;
let exitRow = {};
let targetRoles = {};
let candidate = {};
let announcement = { id: 1, reactions: { thumbs: 0, heart: 0, celebrate: 0 }, acknowledgements: [] };
let calls = [];

pool.query = async (sql, values) => {
  calls.push({ sql, values });
  if (sql.includes('FROM user_accounts u')) return { rows: [account], rowCount: 1 };
  if (sql.includes('SELECT role FROM user_accounts')) { const role = targetRoles[values[0]]; return role ? { rows: [{ role }], rowCount: 1 } : { rows: [], rowCount: 0 }; }
  if (sql.includes('FROM user_specific_permissions')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM role_permissions')) return { rows: allowed, rowCount: allowed.length };
  if (sql.includes("SELECT id, name, department, role, status, to_char(joining_date")) return values[0] === 'MISSING' ? { rows: [], rowCount: 0 } : { rows: [{ id: values[0], status: values[0] === 'GONE' ? 'Exited' : 'Confirmed', name: 'From Record', department: 'Records', role: 'Analyst', joining_date: '2025-01-01' }], rowCount: 1 };
  if (sql.includes("status <> 'Completed' FOR UPDATE")) return { rows: Array(openExits).fill({ id: 1 }), rowCount: openExits };
  if (/INSERT INTO exits/.test(sql)) return { rows: [{ id: 2, employee_name: values[0] }], rowCount: 1 };
  if (sql.includes('FROM applicants WHERE id = $1 FOR UPDATE')) return { rows: [candidate], rowCount: 1 };
  if (sql.includes('SELECT employee_id FROM exits')) return { rows: [exitRow], rowCount: 1 };
  if (sql.includes('SELECT * FROM exits')) return { rows: [exitRow], rowCount: 1 };
  if (/UPDATE exits SET/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
  if (/UPDATE employees SET\s+name = COALESCE/.test(sql)) return { rows: [{ id: values[12], manager: values[4], manager_id: values[5] }], rowCount: 1 };
  if (/UPDATE announcements\s+SET reactions/.test(sql)) {
    const reactions = { ...announcement.reactions, [values[1]]: (announcement.reactions?.[values[1]] || 0) + 1 };
    announcement = { ...announcement, reactions };
    return { rows: [announcement], rowCount: 1 };
  }
  if (/UPDATE announcements\s+SET acknowledgements/.test(sql)) {
    const acknowledgements = announcement.acknowledgements.includes(values[1])
      ? announcement.acknowledgements
      : [...announcement.acknowledgements, values[1]];
    announcement = { ...announcement, acknowledgements };
    return { rows: [announcement], rowCount: 1 };
  }
  if (sql.includes('COUNT(*)')) return { rows: [{ count: '3' }], rowCount: 1 };
  if (sql.includes('SELECT id FROM employees WHERE id')) return { rows: [{ id: values[0] }], rowCount: 1 };
  if (sql.includes('TO_CHAR(date') || sql.includes('GROUP BY department')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM employees WHERE')) return { rows: [{ id: 'ACTOR', attendance: 'Not marked' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
rawPool.connect = async () => ({ query: (sql, values) => pool.query(sql, values), release() {} });

function request(method, url, body) {
  calls = [];
  return new Promise((resolve, reject) => {
    let output = '';
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method; req.url = url; req.headers = { authorization: `Bearer ${generateToken(account)}` }; req.body = body || {};
    const res = new http.ServerResponse(req); res.assignSocket(socket);
    res.on('finish', () => {
      let data; try { data = JSON.parse(output.slice(output.indexOf('\r\n\r\n') + 4)); } catch { data = null; }
      resolve({ status: res.statusCode, data, calls: [...calls] });
    });
    res.on('error', reject);
    app.handle(req, res, reject);
  });
}
const call = (result, pattern) => result.calls.find(item => pattern.test(item.sql));
const employeeUpdates = result => result.calls.filter(item => /UPDATE employees SET/.test(item.sql));

test('today\'s attendance comes from real records', async () => {
  account = actor('super_admin');
  const stats = await request('GET', '/api/stats');
  assert.match(call(stats, /attendance_records ar JOIN employees/).sql, /ar\.date = CURRENT_DATE/);
  assert.ok(!stats.calls.some(item => /FROM employees WHERE attendance/.test(item.sql)));
  assert.ok(stats.data.upcomingHolidays.every(holiday => holiday.date >= new Date().toISOString().slice(0, 10)));
  const list = await request('GET', '/api/employees');
  assert.match(call(list, /FROM employees WHERE/).sql, /AS attendance FROM employees/);
});

test('HR corrections write the real attendance record', async () => {
  account = actor('hr');
  const saved = await request('PATCH', '/api/employees/TARGET/attendance', { attendance: 'WFH', date: '2026-11-03' });
  assert.equal(saved.status, 200);
  assert.deepEqual(call(saved, /INSERT INTO attendance_records/).values, ['TARGET', '2026-11-03', 'WFH']);
  assert.ok(call(await request('PATCH', '/api/employees/TARGET/attendance', { attendance: 'Not marked', date: '2026-11-03' }), /DELETE FROM attendance_records/));
  assert.equal((await request('PATCH', '/api/employees/TARGET/attendance', { attendance: 'Sleeping' })).status, 400);
  assert.equal((await request('PATCH', '/api/employees/TARGET/attendance', { attendance: 'WFH', date: 'soon' })).status, 400);
});

test('HR can log an exit for someone else, using the employee\'s own record', async () => {
  account = actor('hr');
  targetRoles = {};
  const result = await request('POST', '/api/exits', { ...EXIT, employee_name: 'Forged', department: 'Forged' });
  assert.equal(result.status, 201);
  const row = call(result, /INSERT INTO exits/).values;
  assert.deepEqual([row[0], row[1], row[5], row[6], row[7]], ['From Record', 'Records', 'TARGET', 'Analyst', '2025-01-01']);
});

test('exit requests are limited and validated', async () => {
  account = actor('employee');
  assert.equal((await request('POST', '/api/exits', { ...EXIT, employee_id: 'ACTOR' })).status, 201, 'an employee can resign');
  assert.equal((await request('POST', '/api/exits', EXIT)).status, 403, 'but not for someone else');
  account = actor('hr');
  assert.equal((await request('POST', '/api/exits', { ...EXIT, employee_id: 'MISSING' })).status, 400);
  assert.equal((await request('POST', '/api/exits', { ...EXIT, employee_id: 'GONE' })).status, 409);
  assert.equal((await request('POST', '/api/exits', { ...EXIT, last_working_date: '2026-10-01' })).status, 400);
  openExits = 1;
  try { assert.equal((await request('POST', '/api/exits', EXIT)).status, 409); } finally { openExits = 0; }
  targetRoles = { BOSS: 'super_admin' };
  assert.equal((await request('POST', '/api/exits', { ...EXIT, employee_id: 'BOSS' })).status, 403);
  targetRoles = {};
});

test('revoking access and finishing an exit really end the login', async () => {
  account = actor('hr');
  exitRow = { id: 1, employee_id: 'TARGET', employee_name: 'T', status: 'In Progress', handover: true, assets: true, access_removal: false, settlement: false };
  const revoked = await request('PATCH', '/api/exits/1', { access_removal: true });
  assert.equal(revoked.status, 200);
  assert.deepEqual(employeeUpdates(revoked)[0].values, [false, 'TARGET']);
  assert.equal(employeeUpdates(revoked).length, 1);

  exitRow = { ...exitRow, access_removal: true };
  const finished = await request('PATCH', '/api/exits/1', { settlement: true });
  assert.match(employeeUpdates(finished)[0].sql, /status = 'Exited', has_dashboard_access = false/);
  assert.ok(call(finished, /EMPLOYEE_EXITED/));
});

test('a finished exit stays finished, and nobody clears their own', async () => {
  account = actor('hr');
  exitRow = { id: 1, employee_id: 'TARGET', status: 'Completed', handover: true, assets: true, access_removal: true, settlement: true };
  assert.equal((await request('PATCH', '/api/exits/1', { access_removal: false })).status, 409);
  assert.equal((await request('PATCH', '/api/exits/1', { rating: 4 })).status, 200, 'other details can still be added');
  exitRow = { ...exitRow, employee_id: 'ACTOR', status: 'In Progress' };
  assert.equal((await request('PATCH', '/api/exits/1', { handover: true })).status, 403);
  targetRoles = { BOSS: 'super_admin' };
  exitRow = { ...exitRow, employee_id: 'BOSS' };
  assert.equal((await request('PATCH', '/api/exits/1', { handover: true })).status, 403);
  targetRoles = {};
});

test('old exits with no employee link can still be updated', async () => {
  account = actor('hr');
  exitRow = { id: 1, employee_id: null, status: 'In Progress', handover: true, assets: true, access_removal: true, settlement: false };
  const result = await request('PATCH', '/api/exits/1', { settlement: true });
  assert.equal(result.status, 200);
  assert.equal(employeeUpdates(result).length, 0);
});

test('only candidates with a final decision can be onboarded', async () => {
  account = actor('hr');
  for (const stage of ['New', 'Screening', 'HR L1', 'Head HR Round', 'CEO Approval']) {
    candidate = { id: 7, stage };
    const result = await request('POST', '/api/applicants/7/promote', { basic: 1 });
    assert.equal(result.status, 409, stage);
    assert.ok(!call(result, /INSERT INTO employees/), stage);
  }
  candidate = { id: 7, stage: 'Approved', promoted_employee_id: 'FEM-9' };
  assert.equal((await request('POST', '/api/applicants/7/promote', { basic: 1 })).status, 409);
  // CEO approval alone is not enough: the candidate must have accepted an offer.
  candidate = { id: 7, stage: 'Approved', email: 'c@example.test' };
  const noOffer = await request('POST', '/api/applicants/7/promote', { basic: 1 });
  assert.equal(noOffer.status, 409);
  assert.ok(!call(noOffer, /INSERT INTO employees/));
});

test('an explicit null clears both manager fields without changing partial updates', async () => {
  account = actor('hr');
  const cleared = await request('PUT', '/api/employees/TARGET', { manager_id: null, manager: null });
  assert.equal(cleared.status, 200);
  const clearUpdate = call(cleared, /UPDATE employees SET\s+name = COALESCE/);
  assert.match(clearUpdate.sql, /manager = CASE WHEN \$12::boolean/);
  assert.deepEqual([clearUpdate.values[4], clearUpdate.values[5], clearUpdate.values[11], clearUpdate.values[12]], [null, null, true, 'TARGET']);

  const partial = await request('PUT', '/api/employees/TARGET', { phone: '9999999999' });
  assert.equal(partial.status, 200);
  const partialUpdate = call(partial, /UPDATE employees SET\s+name = COALESCE/);
  assert.equal(partialUpdate.values[11], false);
});

test('announcement reactions and acknowledgements update JSON atomically', async () => {
  account = actor('employee');
  announcement = { id: 1, reactions: { thumbs: 0, heart: 0, celebrate: 0 }, acknowledgements: [] };

  const reacted = await request('PATCH', '/api/announcements/1/react', { type: 'heart' });
  assert.equal(reacted.status, 200);
  assert.match(call(reacted, /UPDATE announcements\s+SET reactions/).sql, /jsonb_set/);
  assert.equal(reacted.data.reactions.heart, 1);

  const acknowledged = await request('PATCH', '/api/announcements/1/acknowledge', { employeeName: 'Forged Name' });
  assert.equal(acknowledged.status, 200);
  assert.match(call(acknowledged, /UPDATE announcements\s+SET acknowledgements/).sql, /jsonb_build_array/);
  assert.deepEqual(acknowledged.data.acknowledgements, ['Real Name']);
});

test('attendance, onboarding document review, and user permissions enforce explicit input validation', async () => {
  const origQuery = pool.query;
  pool.query = async (sql, values = []) => {
    if (sql.includes('SELECT id FROM employees WHERE id = $1')) {
      return values[0] === 'MISSING' ? { rows: [], rowCount: 0 } : { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM user_accounts WHERE employee_id = $1')) {
      return { rows: [{ id: 2, employee_id: values[0], name: 'Target User', role: 'employee' }], rowCount: 1 };
    }
    return origQuery(sql, values);
  };

  try {
    account = actor('super_admin');

    // 1. GET /api/attendance/monthly
    assert.equal((await request('GET', '/api/attendance/monthly?month=13&year=2026')).status, 400);
    assert.equal((await request('GET', '/api/attendance/monthly?month=0&year=2026')).status, 400);
    assert.equal((await request('GET', '/api/attendance/monthly?month=abc&year=2026')).status, 400);
    assert.equal((await request('GET', '/api/attendance/monthly?month=11&year=bad')).status, 400);
    assert.equal((await request('GET', '/api/attendance/monthly?month=11&year=2026')).status, 200);

    // 2. POST /api/attendance/regularize
    assert.equal((await request('POST', '/api/attendance/regularize', { employeeId: 'TARGET', date: '2026-11-05', status: 'Sleeping' })).status, 400);
    assert.equal((await request('POST', '/api/attendance/regularize', { employeeId: 'TARGET', date: 'not-a-date', status: 'Present' })).status, 400);
    assert.equal((await request('POST', '/api/attendance/regularize', { employeeId: 'TARGET', date: '2026-11-05', status: 'Present', workDurationMinutes: 2000 })).status, 400);
    assert.equal((await request('POST', '/api/attendance/regularize', { employeeId: 'TARGET', date: '2026-11-05', status: 'Present', workDurationMinutes: -5 })).status, 400);
    assert.equal((await request('POST', '/api/attendance/regularize', { employeeId: 'MISSING', date: '2026-11-05', status: 'Present' })).status, 404);
    assert.equal((await request('POST', '/api/attendance/regularize', { employeeId: 'TARGET', date: '2026-11-05', status: 'WFH', workDurationMinutes: 480 })).status, 200);

    // 3. PATCH /api/onboarding/document/:id/status
    assert.equal((await request('PATCH', '/api/onboarding/document/1/status', { status: 'ApprovedHack' })).status, 400);
    assert.equal((await request('PATCH', '/api/onboarding/document/bad-id/status', { status: 'Verified' })).status, 400);

    // 4. PUT /api/users/:employeeId/permissions
    assert.equal((await request('PUT', '/api/users/TARGET/permissions', { permissions: { 'nonexistent:perm': true } })).status, 400);
    assert.equal((await request('PUT', '/api/users/TARGET/permissions', { permissions: { 'employees:view': 'yes' } })).status, 400);
    assert.equal((await request('PUT', '/api/users/TARGET/permissions', { permissions: { 'employees:view': true, view_candidates: false } })).status, 200);
  } finally {
    pool.query = origQuery;
  }
});

test('department rename, employee update, and exit access revocation keep related records synced', async () => {
  const origQuery = pool.query;
  pool.query = async (sql, values = []) => {
    if (sql.includes('SELECT * FROM departments WHERE id = $1')) {
      return { rows: [{ id: 1, name: 'Old Dept', head_of_department: null, head_employee_id: null }], rowCount: 1 };
    }
    if (/UPDATE departments/.test(sql)) {
      return { rows: [{ id: 1, name: values[0], code: values[1] }], rowCount: 1 };
    }
    return origQuery(sql, values);
  };

  try {
    account = actor('super_admin');

    // 1. Department rename syncs training, training_assignments, recruiter_assignments, and exits
    const deptRes = await request('PUT', '/api/departments/1', { name: 'New Dept', code: 'NEWD' });
    assert.equal(deptRes.status, 200);
    assert.ok(deptRes.calls.some(c => /UPDATE training SET department/.test(c.sql) && c.values[0] === 'New Dept' && c.values[1] === 'Old Dept'));
    assert.ok(deptRes.calls.some(c => /UPDATE training_assignments SET target/.test(c.sql) && c.values[0] === 'New Dept'));
    assert.ok(deptRes.calls.some(c => /UPDATE recruiter_assignments SET target/.test(c.sql) && c.values[0] === 'New Dept'));
    assert.ok(deptRes.calls.some(c => /UPDATE exits SET department/.test(c.sql) && c.values[0] === 'New Dept'));

    // 2. Employee update syncs name/email/department to recruitment_team
    const empRes = await request('PUT', '/api/employees/TARGET', { name: 'Updated Name', email: 'Updated@Example.test', department: 'New Dept' });
    assert.equal(empRes.status, 200);
    const rtSync = empRes.calls.find(c => /UPDATE recruitment_team SET/.test(c.sql));
    assert.ok(rtSync);
    assert.deepEqual(rtSync.values, ['Updated Name', 'updated@example.test', 'New Dept', 'TARGET']);

    // 3. Exit access_removal revokes recruitment_team ATS access and marks Inactive
    exitRow = { id: 1, employee_id: 'TARGET', employee_name: 'Target', department: 'Sales', handover: true, assets: true, access_removal: false, settlement: false, status: 'In Progress' };
    const exitRes = await request('PATCH', '/api/exits/1', { access_removal: true });
    assert.equal(exitRes.status, 200);
    assert.ok(exitRes.calls.some(c => /UPDATE recruitment_team SET has_ats_access = false, status = 'Inactive'/.test(c.sql) && c.values[0] === 'TARGET'));
  } finally {
    pool.query = origQuery;
  }
});

test('GET /api/stats upcomingHolidays reads from HOLIDAYS_JSON rather than hardcoded 2026 dates', async () => {
  const prevHolidays = process.env.HOLIDAYS_JSON;
  process.env.HOLIDAYS_JSON = JSON.stringify([
    '2020-01-01',
    '2099-01-26',
    { date: '2099-12-25', name: 'Christmas Day', type: 'Mandatory' }
  ]);
  try {
    account = actor('super_admin');
    const stats = await request('GET', '/api/stats');
    assert.equal(stats.status, 200);
    assert.equal(stats.data.upcomingHolidays.length, 2);
    assert.deepEqual(stats.data.upcomingHolidays.map(h => h.date), ['2099-01-26', '2099-12-25']);
    assert.equal(stats.data.upcomingHolidays[0].name, 'Company Holiday');
    assert.equal(stats.data.upcomingHolidays[1].name, 'Christmas Day');
    assert.equal(stats.data.upcomingHolidays[1].day, 'Friday');
  } finally {
    if (prevHolidays === undefined) delete process.env.HOLIDAYS_JSON;
    else process.env.HOLIDAYS_JSON = prevHolidays;
  }
});
