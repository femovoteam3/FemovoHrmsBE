import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'test';
const { pool, rawPool } = await import('../server/db.js');
const { app } = await import('../server/index.js');
const { generateToken } = await import('../server/auth.js');
const { pendingMigrations } = await import('../server/migrate.js');
const { rateLimit } = await import('../server/security.js');

const actor = (role, extra = {}) => ({ id: 1, employee_id: 'ACTOR', name: 'Synthetic actor', email: 'actor@example.test', role, status: 'Active', session_version: 0, has_dashboard_access: true, ...extra });
const STAGE = 'Screening';
const NEXT = 'HR L1';
let account = actor('admin');
let targetRoles = {};
let applicant = {};
let interviewRows = [];
let atsRows = [];
let people = {};
let calls = [];
const moduleRows = [['employees','view'],['employees','add'],['employees','edit'],['attendance','view'],['permissions','view'],['permissions','edit_permissions']]
  .map(([module, action]) => ({ module, action, allowed: true }));

pool.query = async (sql, values) => {
  calls.push({ sql, values });
  if (sql.includes('FROM user_accounts u')) return { rows: [account], rowCount: 1 };
  if (sql.includes('SELECT role FROM user_accounts')) {
    const role = targetRoles[values[0]];
    return role ? { rows: [{ role }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes('FROM role_permissions')) return { rows: moduleRows, rowCount: moduleRows.length };
  if (sql.includes('SELECT id FROM employees WHERE manager_id')) return { rows: [{ id: 'REPORT' }], rowCount: 1 };
  if (sql.includes('FROM applicants')) return { rows: [applicant], rowCount: 1 };
  if (sql.includes('FROM ats_role_permissions')) return { rows: atsRows, rowCount: atsRows.length };
  if (sql.includes('FROM interviews')) {
    // The access check asks whether this person interviews the candidate.
    const rows = sql.startsWith('SELECT 1') ? interviewRows.filter(row => values[1].includes(row.interviewer_id)) : interviewRows;
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('FROM user_accounts WHERE status')) {
    const person = people[values?.[0]];
    return person ? { rows: [person], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/UPDATE applicants/.test(sql)) return { rows: [applicant], rowCount: 1 };
  if (/UPDATE employees/.test(sql)) return { rows: [{ id: values.at(-1) }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
rawPool.connect = async () => ({ query: (sql, values) => pool.query(sql, values), release() {} });

function request(method, url, body, token = generateToken(account)) {
  calls = [];
  return new Promise((resolve, reject) => {
    let output = '';
    const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { output += chunk.toString(); callback(); } });
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    req.body = body || {};
    const res = new http.ServerResponse(req); res.assignSocket(socket);
    res.on('finish', () => {
      const raw = output.slice(output.indexOf('\r\n\r\n') + 4);
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      resolve({ status: res.statusCode, data, calls: [...calls] });
    });
    res.on('error', reject);
    app.handle(req, res, reject);
  });
}
const wrote = result => result.calls.some(call => /^\s*(UPDATE|INSERT INTO) (employees|user_accounts|applicants)/.test(call.sql));

test('an admin cannot create, become, or take over a super admin', async () => {
  account = actor('admin');
  targetRoles = { ACTOR: 'admin', ROOT: 'super_admin' };
  for (const [method, url, body] of [
    ['PUT', '/api/employees/ACTOR', { access_role: 'super_admin' }],
    ['POST', '/api/employees', { name: 'New', access_role: ' super_admin ' }],
    ['PUT', '/api/employees/ROOT', { password: 'Synthetic-only-password' }],
    ['PUT', '/api/employees/ROOT/credentials', { newPassword: 'Synthetic-only-password' }],
    ['PATCH', '/api/employees/ROOT/status', { status: 'Terminated' }],
    ['POST', '/api/resources', { name: 'New', email: 'n@example.test', access_role: 'super_admin' }],
    ['PUT', '/api/resources/ACTOR', { access_role: 'super_admin' }],
    ['PUT', '/api/resources/ROOT', { access_role: 'employee' }],
    ['PATCH', '/api/resources/ROOT/revoke-access', { has_dashboard_access: false }],
  ]) {
    const result = await request(method, url, body);
    assert.equal(result.status, 403, `${method} ${url}`);
    assert.ok(!wrote(result), `${method} ${url} wrote data`);
  }
});

test('HR cannot change an existing role, including demoting to employee', async () => {
  account = actor('hr');
  targetRoles = { BOSS: 'admin', ROOT: 'super_admin', LEAD: 'manager', STAFF: 'employee' };
  for (const id of ['BOSS', 'ROOT', 'LEAD']) {
    assert.equal((await request('PUT', `/api/employees/${id}`, { access_role: 'employee' })).status, 403, id);
  }
  assert.equal((await request('PUT', '/api/employees/STAFF', { access_role: 'employee', name: 'Same role' })).status, 200);
});

test('legitimate role changes still work', async () => {
  targetRoles = { STAFF: 'employee', ROOT: 'super_admin' };
  account = actor('admin');
  assert.equal((await request('PUT', '/api/employees/STAFF', { access_role: 'manager' })).status, 200);
  account = actor('super_admin');
  assert.equal((await request('PUT', '/api/employees/STAFF', { access_role: 'super_admin' })).status, 200);
  assert.equal((await request('PUT', '/api/employees/ROOT', { name: 'Renamed' })).status, 200);
});

test('an assigned interviewer can give feedback but cannot move or price a candidate', async () => {
  account = actor('interviewer', { ats_role: 'hiring_manager' });
  applicant = { id: 1, name: 'Candidate', job: 'Role', stage: STAGE, interviewer_id: 'ACTOR', assigned_recruiter_id: 'REC' };
  interviewRows = [{ id: 5, applicant_id: 1, type: 'additional', status: 'Scheduled', interviewer_id: 'ACTOR', scheduled_at: '2026-11-18T10:00:00Z' }];
  for (const body of [
    { stage: NEXT, remarks: 'Advance' },
    { stage: 'Rejected', rejection_reason: 'No' },
    { monthly_salary: '₹1' },
    { interviewer_id: 'OTHER' },
    { interviewer: 'Someone else' },
  ]) {
    const result = await request('PATCH', '/api/applicants/1/stage', body);
    assert.equal(result.status, 403, JSON.stringify(body));
    assert.ok(!wrote(result), JSON.stringify(body));
  }
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { rating: 4, scorecard_notes: 'Good', stage: STAGE })).status, 200);
  const moved = await request('PATCH', '/api/applicants/1/stage', { interview_date: '2026-11-20T10:00:00Z', meet_link: 'https://example.test/x', stage: STAGE });
  assert.equal(moved.status, 200);
  assert.equal(moved.calls.find(call => /UPDATE interviews/.test(call.sql)).values.at(-1), 5);
  // Someone else's interview is not theirs to move or score.
  interviewRows = [{ id: 6, applicant_id: 1, type: 'additional', status: 'Scheduled', interviewer_id: 'OTHER' }];
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { interview_date: '2026-11-21T10:00:00Z', stage: STAGE })).status, 403);
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { rating: 4, scorecard_notes: '[HIRE] good', stage: STAGE })).status, 403);
  interviewRows = [];
});

test('scheduling saves the interviewer ID that grants access', async () => {
  account = actor('hr');
  applicant = { id: 1, name: 'Candidate', job: 'Role', stage: STAGE };
  people = { PERSON: { employee_id: 'PERSON', name: 'Person' } };
  const body = { interview_date: '2026-11-20T10:00:00Z', interviewer: 'Typed name', interviewer_id: 'PERSON', meet_link: 'https://example.test/x', stage: STAGE };
  const result = await request('PATCH', '/api/applicants/1/stage', body);
  assert.equal(result.status, 200);
  // The name comes from the account, never from the browser.
  assert.deepEqual(result.calls.find(call => /INSERT INTO interviews/.test(call.sql)).values.slice(1, 4), ['screening', 'PERSON', 'Person']);
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { ...body, interviewer_id: 'NOBODY' })).status, 400);
  people = {};
});

test('a recruiter chosen as interviewer can read and score only, and only that candidate', async () => {
  account = actor('recruiter', { ats_role: 'rec_associate' });
  applicant = { id: 1, name: 'Candidate', job: 'Role', stage: STAGE, interviewer_id: 'ACTOR', assigned_recruiter_id: 'REC' };
  assert.equal((await request('GET', '/api/applicants/1')).status, 200);
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { rating: 4, scorecard_notes: 'Good', stage: STAGE })).status, 200);
  for (const body of [{ stage: NEXT, remarks: 'Advance' }, { rating: 1, monthly_salary: '₹1' }]) {
    const result = await request('PATCH', '/api/applicants/1/stage', body);
    assert.equal(result.status, 403, JSON.stringify(body));
    assert.ok(!wrote(result), JSON.stringify(body));
  }
  const list = await request('GET', '/api/applicants');
  assert.match(list.calls.find(call => call.sql.includes('FROM applicants')).sql, /assigned_recruiter_id = ANY\(\$1\).*interviewer_id = ANY\(\$1\).*FROM interviews/);
  applicant = { ...applicant, interviewer_id: 'OTHER' };
  assert.equal((await request('GET', '/api/applicants/1')).status, 403);
});

test('moving a candidate forward requires remarks on the server', async () => {
  account = actor('hr');
  applicant = { id: 1, name: 'Candidate', job: 'Role', stage: STAGE };
  interviewRows = [{ id: 3, applicant_id: 1, type: 'screening', status: 'Completed', recommendation: 'Hire' }];
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: NEXT })).status, 400);
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: NEXT, remarks: '   ' })).status, 400);
  // Without a logged screening call the candidate cannot leave Screening.
  interviewRows = [];
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: NEXT, remarks: 'Strong call' })).status, 409);
  interviewRows = [{ id: 3, applicant_id: 1, type: 'screening', status: 'Completed', recommendation: 'Hire' }];
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: NEXT, remarks: 'Strong call' })).status, 200);
  // A scorecard sent with the move is recorded first and then counts as the evidence.
  interviewRows = [];
  const scored = await request('PATCH', '/api/applicants/1/stage', { stage: NEXT, rating: 4, scorecard_notes: '[HIRE] solid' });
  assert.equal(scored.status, 200);
  assert.ok(scored.calls.some(call => /INSERT INTO interviews/.test(call.sql)));
  interviewRows = [{ id: 3, applicant_id: 1, type: 'screening', status: 'Completed', recommendation: 'Hire' }];
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: 'Rejected', rejection_reason: 'Gap' })).status, 200);
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: NEXT, interview_date: '2026-11-20T10:00:00Z' })).status, 400);
  applicant = { ...applicant, stage: 'New' };
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: STAGE, interview_date: '2026-11-20T10:00:00Z' })).status, 200);
  applicant = { ...applicant, stage: 'Rejected' };
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: 'New' })).status, 400);
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: 'New', remarks: 'Reconsidered' })).status, 200);
  // Approval is the CEO's decision, not a stage move.
  applicant = { ...applicant, stage: 'CEO Approval' };
  assert.equal((await request('PATCH', '/api/applicants/1/stage', { stage: 'Approved', remarks: 'Skip the CEO' })).status, 409);
  assert.equal((await request('POST', '/api/applicants/1/ceo-decision', { decision: 'approved' })).status, 403);
  account = actor('recruiter', { ats_role: 'ceo' });
  assert.equal((await request('POST', '/api/applicants/1/ceo-decision', { decision: 'rejected' })).status, 400);
  assert.equal((await request('POST', '/api/applicants/1/ceo-decision', { decision: 'approved' })).status, 200);
  interviewRows = [];
});

test('a manager sees a direct report\'s attendance but not anyone else\'s', async () => {
  account = actor('manager');
  const monthly = await request('GET', '/api/attendance/monthly?employeeId=REPORT&month=10&year=2026');
  assert.equal(monthly.status, 200);
  assert.equal(monthly.calls.find(call => call.sql.includes('FROM attendance_records')).values[0], 'REPORT');
  assert.equal((await request('GET', '/api/attendance/monthly?employeeId=STRANGER&month=10&year=2026')).status, 403);
});

function throughLimiter(limiter, req, status) {
  return new Promise(resolve => {
    const res = Object.assign(new EventEmitter(), { statusCode: status, set() {}, status(code) { this.statusCode = code; return this; }, json() { resolve(this.statusCode); } });
    limiter(req, res, () => { res.emit('finish'); resolve('passed'); });
  });
}

test('sign-in limits ignore successful logins and isolate accounts', async () => {
  const limiter = rateLimit({ max: 2, countSuccess: false, key: req => `${req.ip}:${req.id}` });
  for (let i = 0; i < 20; i++) assert.equal(await throughLimiter(limiter, { ip: 'office', id: 'a' }, 200), 'passed');
  assert.equal(await throughLimiter(limiter, { ip: 'office', id: 'b' }, 401), 'passed');
  assert.equal(await throughLimiter(limiter, { ip: 'office', id: 'b' }, 401), 'passed');
  assert.equal(await throughLimiter(limiter, { ip: 'office', id: 'b' }, 401), 429);
  assert.equal(await throughLimiter(limiter, { ip: 'office', id: 'a' }, 200), 'passed');
});

test('skipped requests never consume the limit', async () => {
  const limiter = rateLimit({ max: 1, skip: req => Boolean(req.headers.authorization) });
  for (let i = 0; i < 5; i++) assert.equal(await throughLimiter(limiter, { ip: 'office', headers: { authorization: 'Bearer x' } }, 200), 'passed');
  assert.equal(await throughLimiter(limiter, { ip: 'office', headers: {} }, 200), 'passed');
  assert.equal(await throughLimiter(limiter, { ip: 'office', headers: {} }, 200), 429);
});

test('every migration file must be applied before the server is ready', async () => {
  const applied = versions => ({ query: async () => ({ rows: versions.map(version => ({ version })) }) });
  const fs = await import('node:fs/promises');
  const files = (await fs.readdir(new URL('../server/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(await pendingMigrations(applied(files.slice(0, -1))), [files.at(-1)]);
  assert.deepEqual(await pendingMigrations(applied(files)), []);
});

test('a recruitment switch is read only from its own module', async () => {
  account = actor('recruiter', { ats_role: 'rec_associate' });
  applicant = { id: 1, name: 'Candidate', job: 'Role', stage: STAGE, assigned_recruiter_id: 'ACTOR' };
  const scope = async () => (await request('GET', '/api/applicants')).calls.find(call => call.sql.includes('FROM applicants')).sql;
  // A leftover copy under an old module name cannot switch a permission off or on.
  atsRows = [{ module: 'candidate_lifecycle', action: 'view_candidates', allowed: true }, { module: 'candidate_pipeline', action: 'view_candidates', allowed: false }];
  assert.ok(!(await scope()).includes('1=0'));
  atsRows = [{ module: 'recruiter_allocation', action: 'view_all_candidates', allowed: true }];
  assert.match(await scope(), /assigned_recruiter_id = ANY/);
  // The real switch still works.
  atsRows = [{ module: 'candidate_lifecycle', action: 'view_candidates', allowed: false }];
  assert.ok((await scope()).includes('1=0'));
  atsRows = [];
});

test('concurrent duplicate POST /api/applicants maps unique violation 23505 cleanly to HTTP 409', async () => {
  const origQuery = pool.query;
  const activePairs = new Set();
  let checkCount = 0;
  let releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });

  pool.query = async (sql, values = []) => {
    if (sql.includes('FROM job_requisitions')) {
      return { rows: [{ id: 7, role: 'Yoga Trainer', department: 'Wellness', status: 'Active', assigned_recruiter_id: null, backup_recruiter_id: null }], rowCount: 1 };
    }
    if (sql.includes('SELECT 1 FROM applicants WHERE LOWER(email)')) {
      checkCount += 1;
      if (checkCount === 2) releaseBarrier();
      await barrier;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO applicants')) {
      const key = `${String(values[3]).toLowerCase()}::${values[2]}`;
      if (activePairs.has(key)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "idx_applicants_unique_active_email_job"'), { code: '23505' });
      }
      activePairs.add(key);
      return { rows: [{ id: 501, name: values[0], job: values[1], department: values[10] }], rowCount: 1 };
    }
    return origQuery(sql, values);
  };

  try {
    const payload = {
      name: 'Concurrent Applicant',
      job: 'Yoga Trainer',
      job_id: 7,
      email: 'Race@Example.Test',
      phone: '+919876543210'
    };
    const [r1, r2] = await Promise.all([
      request('POST', '/api/applicants', payload, null),
      request('POST', '/api/applicants', payload, null)
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409]);
    const rejected = r1.status === 409 ? r1 : r2;
    assert.match(rejected.data.error, /already with us for this job/i);
  } finally {
    pool.query = origQuery;
  }
});

test('recruitment team directory requires manage_ats_users and /api/recruiters redacts email/phone for general viewers', async () => {
  const origQuery = pool.query;
  const mockRecruiters = [
    { id: 'REC-1', name: 'Recruiter One', department: 'Wellness', ats_role: 'rec_associate', is_head: false, has_ats_access: true, email: 'private-rec@example.test', phone: '9998887776' }
  ];

  pool.query = async (sql, values = []) => {
    if (sql.includes('FROM role_permissions')) return { rows: [...moduleRows, { module: 'ats', action: 'view', allowed: true }], rowCount: moduleRows.length + 1 };
    if (sql.includes('FROM recruitment_team')) return { rows: mockRecruiters, rowCount: mockRecruiters.length };
    if (sql.includes("FROM applicants WHERE stage != 'Rejected'")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM job_requisitions WHERE status = 'Active'")) return { rows: [], rowCount: 0 };
    return origQuery(sql, values);
  };

  try {
    // Manager / interviewer (ats:view without manage_ats_users)
    account = actor('manager', { ats_role: 'hiring_manager' });
    atsRows = [];
    const teamDenied = await request('GET', '/api/recruitment/team');
    assert.equal(teamDenied.status, 403);

    const recListViewer = await request('GET', '/api/recruiters');
    assert.equal(recListViewer.status, 200);
    assert.equal(recListViewer.data[0].id, 'REC-1');
    assert.equal(recListViewer.data[0].name, 'Recruiter One');
    assert.equal('email' in recListViewer.data[0], false);
    assert.equal('phone' in recListViewer.data[0], false);

    // Role with manage_ats_users (CEO / ats_role 'ceo')
    account = actor('head', { ats_role: 'ceo' });
    const teamAllowed = await request('GET', '/api/recruitment/team');
    assert.equal(teamAllowed.status, 200);

    const recListManager = await request('GET', '/api/recruiters');
    assert.equal(recListManager.status, 200);
    assert.equal(recListManager.data[0].email, 'private-rec@example.test');
    assert.equal(recListManager.data[0].phone, '9998887776');
  } finally {
    pool.query = origQuery;
    atsRows = [];
  }
});

test('applicant mutation and workflow endpoints redact salary fields when view_salary is false', async () => {
  const origQuery = pool.query;
  const origInterviews = interviewRows;
  let currentCand = {
    id: 42,
    name: 'Salary Guard Candidate',
    job: 'Trainer',
    stage: 'Head HR Round',
    assigned_recruiter_id: 'ACTOR',
    current_ctc: '5 LPA',
    expected_ctc: '6 LPA',
    monthly_salary: '45000'
  };

  pool.query = async (sql, values = []) => {
    if (sql.includes('FROM role_permissions')) {
      return { rows: [...moduleRows, { module: 'ats', action: 'view', allowed: true }], rowCount: moduleRows.length + 1 };
    }
    if (sql.includes('FROM interviews')) {
      return { rows: interviewRows, rowCount: interviewRows.length };
    }
    if (sql.includes('FROM applicants WHERE id = $1')) {
      return { rows: [currentCand], rowCount: 1 };
    }
    if (/UPDATE applicants SET/.test(sql)) {
      currentCand = { ...currentCand, stage: values[0] };
      return { rows: [currentCand], rowCount: 1 };
    }
    return origQuery(sql, values);
  };

  try {
    interviewRows = [{ id: 1, applicant_id: 42, type: 'head_hr', status: 'Completed', recommendation: 'Hire', interviewer_id: 'ACTOR' }];

    // 1. Head HR without view_salary moves candidate to CEO Approval via PATCH /stage -> monthly_salary must be redacted.
    account = actor('hr', { ats_role: 'rec_lead' });
    atsRows = [
      { module: 'candidate_lifecycle', action: 'edit_candidates', allowed: true },
      { module: 'workflow', action: 'recommend_to_ceo', allowed: true },
      { module: 'offers', action: 'view_salary', allowed: false }
    ];
    const stageMoveRes = await request('PATCH', '/api/applicants/42/stage', { stage: 'CEO Approval', remarks: 'Ready for CEO' });
    assert.equal(stageMoveRes.status, 200);
    assert.equal('monthly_salary' in stageMoveRes.data, false);

    // 2. POST /recommend without view_salary -> monthly_salary must be redacted.
    currentCand = { ...currentCand, stage: 'Head HR Round' };
    const recNoSalary = await request('POST', '/api/applicants/42/recommend', { recommendation: 'Strong fit' });
    assert.equal(recNoSalary.status, 200);
    assert.equal('monthly_salary' in recNoSalary.data, false);

    // 3. POST /ceo-decision without view_salary -> monthly_salary must be redacted.
    currentCand = { ...currentCand, stage: 'CEO Approval' };
    account = actor('head', { ats_role: 'ceo' });
    atsRows = [
      { module: 'workflow', action: 'final_approval', allowed: true },
      { module: 'offers', action: 'view_salary', allowed: false }
    ];
    const ceoNoSalary = await request('POST', '/api/applicants/42/ceo-decision', { decision: 'approved' });
    assert.equal(ceoNoSalary.status, 200);
    assert.equal('monthly_salary' in ceoNoSalary.data, false);

    // 4. With view_salary=true -> monthly_salary is preserved.
    currentCand = { ...currentCand, stage: 'CEO Approval' };
    atsRows = [
      { module: 'workflow', action: 'final_approval', allowed: true },
      { module: 'offers', action: 'view_salary', allowed: true }
    ];
    const ceoWithSalary = await request('POST', '/api/applicants/42/ceo-decision', { decision: 'approved' });
    assert.equal(ceoWithSalary.status, 200);
    assert.equal(ceoWithSalary.data.monthly_salary, '45000');
  } finally {
    pool.query = origQuery;
    interviewRows = origInterviews;
    atsRows = [];
  }
});
