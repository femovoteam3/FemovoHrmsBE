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
const helpdeskRows = ['view', 'submit_ticket', 'resolve_ticket'].map(action => ({ module: 'helpdesk', action, allowed: true }));
const POSH = { category: 'POSH / Harassment', respondent_name: 'Respondent', incident_date: '2026-10-01', description: 'What happened' };
const MESSAGE = { category: 'Suggestion', recipient: 'HR', subject: 'Idea', description: 'Details' };
let account = actor('employee');
let ticket = {};
let iccCount = 1;
let ceo = { id: 'BOSS', name: 'The CEO' };
let teamHead = { id: 'LEAD', name: 'The Lead' };
let calls = [];

pool.query = async (sql, values) => {
  calls.push({ sql, values });
  if (sql.includes('FROM user_accounts u')) return { rows: [account], rowCount: 1 };
  if (sql.includes('COUNT(*)::int AS count FROM user_accounts')) return { rows: [{ count: iccCount }], rowCount: 1 };
  if (sql.includes('FROM user_specific_permissions')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM role_permissions')) return { rows: helpdeskRows, rowCount: helpdeskRows.length };
  if (sql.includes('chief executive') || sql.includes("role = 'super_admin'")) return ceo ? { rows: [ceo], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes('FROM employees me')) return teamHead ? { rows: [teamHead], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes('nextval')) return { rows: [{ value: 7 }], rowCount: 1 };
  if (/INSERT INTO support_tickets/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
  if (/UPDATE support_tickets/.test(sql)) return { rows: [], rowCount: 1 };
  if (/INSERT INTO ticket_messages/.test(sql)) return { rows: [{ id: 5, body: values[3] }], rowCount: 1 };
  if (sql.includes('FROM ticket_messages WHERE ticket_id = $1 ORDER')) return { rows: [{ id: 5, body: 'Hello' }], rowCount: 1 };
  if (sql.includes('FROM support_tickets')) return { rows: [ticket], rowCount: 1 };
  if (/UPDATE user_accounts/.test(sql)) return { rows: [{ employee_id: values[1], name: 'Member', is_icc_member: values[0] }], rowCount: 1 };
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
const listCall = result => result.calls.find(call => call.sql.includes('ORDER BY last_activity'));
const updated = result => result.calls.some(call => /UPDATE support_tickets/.test(call.sql));
const inserted = result => result.calls.find(call => /INSERT INTO support_tickets/.test(call.sql));
const messaged = result => result.calls.some(call => /INSERT INTO ticket_messages/.test(call.sql));
const auditRow = result => result.calls.find(call => /INSERT INTO audit_logs \(actor_name, actor_id/.test(call.sql));

test('only ICC members receive POSH complaints, whatever their role', async () => {
  for (const role of ['hr', 'admin', 'super_admin']) {
    account = actor(role);
    const sql = listCall(await request('GET', '/api/tickets')).sql;
    assert.match(sql, /recipient_type = 'HR' AND t\.is_confidential IS NOT TRUE/, role);
    assert.doesNotMatch(sql, /is_confidential = TRUE/, role);
  }
  account = actor('employee', { is_icc_member: true });
  assert.match(listCall(await request('GET', '/api/tickets')).sql, /is_confidential = TRUE/);
});

test('people only see conversations they sent or that were addressed to them', async () => {
  account = actor('employee');
  const own = listCall(await request('GET', '/api/tickets'));
  assert.match(own.sql, /WHERE t\.employee_id = \$1 OR t\.recipient_id = \$1 ORDER/);
  assert.deepEqual(own.values, ['ACTOR']);
  account = actor('hr');
  assert.doesNotMatch(listCall(await request('GET', '/api/tickets')).sql, /recipient_type = 'CEO'|Team Head/);
});

test('a message to the CEO or team head is addressed to that person', async () => {
  account = actor('employee');
  const toCeo = await request('POST', '/api/tickets', { ...MESSAGE, recipient: 'CEO', employee_id: 'OTHER', employee_name: 'Forged' });
  assert.equal(toCeo.status, 201);
  const ceoRow = inserted(toCeo).values;
  assert.deepEqual([ceoRow[1], ceoRow[2], ceoRow[3], ceoRow[6]], ['ACTOR', 'Real Name', 'Suggestion', false]);
  assert.deepEqual(ceoRow.slice(14), ['CEO', 'BOSS', 'The CEO']);
  assert.deepEqual(inserted(await request('POST', '/api/tickets', { ...MESSAGE, recipient: 'Team Head' })).values.slice(14), ['Team Head', 'LEAD', 'The Lead']);
  assert.deepEqual(inserted(await request('POST', '/api/tickets', MESSAGE)).values.slice(14), ['HR', null, 'HR Team']);
});

test('a conversation needs a real recipient and a valid type', async () => {
  account = actor('employee');
  assert.equal((await request('POST', '/api/tickets', { ...MESSAGE, recipient: 'Everyone' })).status, 400);
  assert.equal((await request('POST', '/api/tickets', { ...MESSAGE, category: 'Made up' })).status, 400);
  assert.equal((await request('POST', '/api/tickets', { ...MESSAGE, subject: 'x'.repeat(201) })).status, 400);
  assert.equal((await request('POST', '/api/tickets', { ...MESSAGE, description: ' ' })).status, 400);
  teamHead = null;
  try {
    const result = await request('POST', '/api/tickets', { ...MESSAGE, recipient: 'Team Head' });
    assert.equal(result.status, 409);
    assert.ok(!inserted(result));
  } finally { teamHead = { id: 'LEAD', name: 'The Lead' }; }
  ceo = { id: 'ACTOR', name: 'Me' };
  try {
    assert.equal((await request('POST', '/api/tickets', { ...MESSAGE, recipient: 'CEO' })).status, 400);
  } finally { ceo = { id: 'BOSS', name: 'The CEO' }; }
});

test('a conversation with the CEO stays between the two people', async () => {
  ticket = { id: 3, employee_id: 'SENDER', recipient_type: 'CEO', recipient_id: 'BOSS', is_confidential: false, status: 'Open' };
  for (const [role, id] of [['hr', 'HR1'], ['admin', 'ADM1'], ['super_admin', 'SA2'], ['employee', 'OTHER']]) {
    account = actor(role, { employee_id: id });
    assert.equal((await request('GET', '/api/tickets/3/messages')).status, 403, role);
    const reply = await request('POST', '/api/tickets/3/messages', { body: 'Hi' });
    assert.equal(reply.status, 403, role);
    assert.ok(!messaged(reply), role);
    assert.equal((await request('PATCH', '/api/tickets/3', { status: 'Resolved' })).status, 403, role);
  }
  account = actor('employee', { employee_id: 'BOSS' });
  assert.equal((await request('GET', '/api/tickets/3/messages')).status, 200);
  assert.equal((await request('PATCH', '/api/tickets/3', { status: 'Resolved' })).status, 200);
  account = actor('employee', { employee_id: 'SENDER' });
  assert.equal((await request('GET', '/api/tickets/3/messages')).status, 200);
  assert.equal((await request('PATCH', '/api/tickets/3', { status: 'Resolved' })).status, 403);
});

test('replies record the signed-in author and move the conversation along', async () => {
  ticket = { id: 3, employee_id: 'SENDER', recipient_type: 'CEO', recipient_id: 'BOSS', is_confidential: false, status: 'Open' };
  account = actor('employee', { employee_id: 'BOSS', name: 'Boss Name' });
  const reply = await request('POST', '/api/tickets/3/messages', { body: ' Thanks ', author_name: 'Forged' });
  assert.equal(reply.status, 201);
  assert.deepEqual(reply.calls.find(call => /INSERT INTO ticket_messages/.test(call.sql)).values, [3, 'BOSS', 'Boss Name', 'Thanks']);
  assert.ok(updated(reply), 'first reply moves it to In Progress');
  assert.equal((await request('POST', '/api/tickets/3/messages', { body: '   ' })).status, 400);

  account = actor('employee', { employee_id: 'SENDER' });
  assert.ok(!updated(await request('POST', '/api/tickets/3/messages', { body: 'More' })), 'the sender does not progress an open conversation');
  ticket = { ...ticket, status: 'Resolved' };
  assert.ok(updated(await request('POST', '/api/tickets/3/messages', { body: 'Still broken' })), 'a reply reopens a resolved conversation');
});

test('only ICC members can update a POSH complaint', async () => {
  ticket = { id: 1, is_confidential: true, status: 'Received', recipient_type: 'ICC' };
  for (const role of ['hr', 'admin', 'super_admin', 'employee']) {
    account = actor(role);
    const result = await request('PATCH', '/api/tickets/1', { status: 'Under Inquiry' });
    assert.equal(result.status, 403, role);
    assert.ok(!updated(result), role);
  }
  account = actor('employee', { is_icc_member: true });
  const allowed = await request('PATCH', '/api/tickets/1', { status: 'Under Inquiry' });
  assert.equal(allowed.status, 200);
  assert.ok(updated(allowed));
  assert.equal(auditRow(allowed).values[0], 'Confidential');
  assert.equal(auditRow(allowed).values[1], null);
  assert.equal((await request('PATCH', '/api/tickets/1', { status: 'Closed' })).status, 400);
});

test('an ICC member gets no special rights over HR conversations', async () => {
  ticket = { id: 2, is_confidential: false, status: 'Open', recipient_type: 'HR' };
  account = actor('employee', { is_icc_member: true });
  assert.equal((await request('PATCH', '/api/tickets/2', { status: 'In Progress' })).status, 403);
  account = actor('hr');
  assert.equal((await request('PATCH', '/api/tickets/2', { status: 'In Progress' })).status, 200);
});

test('filing a POSH complaint is confidential regardless of what the browser sends', async () => {
  account = actor('employee');
  const result = await request('POST', '/api/tickets', { ...POSH, recipient: 'CEO', is_confidential: false, employee_id: 'OTHER', employee_name: 'Forged' });
  assert.equal(result.status, 201);
  const row = inserted(result).values;
  assert.deepEqual([row[1], row[2], row[6], row[7], row[9]], ['ACTOR', 'Real Name', true, 'Received', 'Internal Complaints Committee (ICC)']);
  assert.deepEqual(row.slice(14), ['ICC', null, 'Internal Complaints Committee (ICC)']);
  assert.equal(auditRow(result).values[0], 'Confidential');
  assert.ok(!result.calls.some(call => /audit_logs/.test(call.sql) && JSON.stringify(call.values).includes('Real Name')));
});

test('a POSH complaint needs the required details and a committee to receive it', async () => {
  account = actor('employee');
  assert.equal((await request('POST', '/api/tickets', { ...POSH, respondent_name: ' ' })).status, 400);
  assert.equal((await request('POST', '/api/tickets', { ...POSH, incident_date: 'yesterday' })).status, 400);
  assert.equal((await request('POST', '/api/tickets', { ...POSH, incident_date: '2999-01-01' })).status, 400);
  assert.equal((await request('POST', '/api/tickets', { ...POSH, description: '' })).status, 400);
  iccCount = 0;
  try {
    const result = await request('POST', '/api/tickets', POSH);
    assert.equal(result.status, 409);
    assert.ok(!inserted(result));
  } finally { iccCount = 1; }
});

test('a conversation cannot be made confidential from the browser', async () => {
  account = actor('employee');
  const result = await request('POST', '/api/tickets', { ...MESSAGE, is_confidential: true });
  assert.equal(result.status, 201);
  assert.equal(inserted(result).values[6], false);
  assert.equal(inserted(result).values[9], 'HR Team');
});

test('status updates follow the right track', async () => {
  account = actor('hr');
  ticket = { id: 2, is_confidential: false, status: 'Open', priority: 'Medium', recipient_type: 'HR' };
  assert.equal((await request('PATCH', '/api/tickets/2', { status: 'Under Inquiry' })).status, 400);
  assert.equal((await request('PATCH', '/api/tickets/2', { priority: 'Urgent' })).status, 400);
  assert.equal((await request('PATCH', '/api/tickets/2', { status: 'Resolved' })).status, 200);
  assert.equal((await request('PATCH', '/api/tickets/abc', { status: 'Open' })).status, 403);
});

test('only a super admin can manage ICC membership', async () => {
  for (const role of ['admin', 'hr', 'employee']) {
    account = actor(role);
    assert.equal((await request('GET', '/api/tickets/icc-members')).status, 403, role);
    assert.equal((await request('PUT', '/api/tickets/icc-members/PERSON', { member: true })).status, 403, role);
  }
  account = actor('super_admin');
  assert.equal((await request('PUT', '/api/tickets/icc-members/PERSON', { member: 'yes' })).status, 400);
  const result = await request('PUT', '/api/tickets/icc-members/PERSON', { member: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls.find(call => /UPDATE user_accounts/.test(call.sql)).values, [true, 'PERSON']);
  assert.ok(result.calls.some(call => /ICC_MEMBERSHIP_UPDATED/.test(call.sql)));
});

test('the access summary names who the person can reach', async () => {
  account = actor('employee');
  assert.deepEqual((await request('GET', '/api/tickets/access')).data, { canHandle: false, isIccMember: false, canManageIcc: false, iccConfigured: true, recipients: { ceo: { name: 'The CEO' }, teamHead: { name: 'The Lead' } } });
  account = actor('super_admin', { employee_id: 'BOSS' });
  const asCeo = (await request('GET', '/api/tickets/access')).data;
  assert.equal(asCeo.recipients.ceo, null);
  assert.equal(asCeo.canManageIcc, true);
});
