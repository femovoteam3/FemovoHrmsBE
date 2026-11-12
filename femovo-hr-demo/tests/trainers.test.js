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

const employeeUser = {
  id: 10,
  employee_id: 'TR-A',
  name: 'Trainer A',
  email: 'trainera@example.test',
  role: 'employee',
  status: 'Active',
  session_version: 0,
  has_dashboard_access: true
};

const adminUser = {
  id: 1,
  employee_id: 'FEM-001',
  name: 'Admin User',
  email: 'admin@example.test',
  role: 'super_admin',
  status: 'Active',
  session_version: 0,
  has_dashboard_access: true
};

let currentAccount = { ...employeeUser };
let calls = [];

let mockStaff = [
  { id: 'TR-A', name: 'Trainer A', department: 'HR & Training', role: 'Yoga Trainer', designation: 'Yoga Trainer', access_role: 'employee', status: 'Active' },
  { id: 'TR-B', name: 'Trainer B', department: 'HR & Training', role: 'Zumba Trainer', designation: 'Zumba Trainer', access_role: 'employee', status: 'Active' }
];

let mockSchedules = [
  {
    id: 101,
    trainer_id: 'TR-A',
    trainer_name: 'Trainer A',
    trainer_department: 'HR & Training',
    trainer_role: 'Yoga Trainer',
    batch_name: '7 AM Morning Yoga',
    session_type: 'Yoga',
    days_of_week: [1, 2, 3, 4, 5],
    start_time: '07:00',
    duration_minutes: 60,
    payment_model: 'fixed_monthly',
    rate_amount: '5000',
    active: true,
    notes: null
  }
];

let mockSessions = [
  {
    id: 201,
    schedule_id: 101,
    schedule_payment_model: 'fixed_monthly',
    session_date: '2026-11-02',
    start_time: '07:00',
    duration_minutes: 60,
    batch_name: '7 AM Morning Yoga',
    session_type: 'Yoga',
    session_kind: 'scheduled',
    assigned_trainer_id: 'TR-A',
    assigned_trainer_name: 'Trainer A',
    conducted_by_trainer_id: 'TR-A',
    conducted_by_name: 'Trainer A',
    replacement_trainer_id: null,
    replacement_trainer_name: null,
    status: 'Completed',
    payment_amount: '0',
    replacement_pay: '0',
    deduction_amount: '0'
  },
  {
    id: 202,
    schedule_id: null,
    schedule_payment_model: null,
    session_date: '2026-11-03',
    start_time: '18:00',
    duration_minutes: 60,
    batch_name: 'Evening Extra Workshop',
    session_type: 'Face Yoga',
    session_kind: 'extra',
    assigned_trainer_id: 'TR-A',
    assigned_trainer_name: 'Trainer A',
    conducted_by_trainer_id: 'TR-A',
    conducted_by_name: 'Trainer A',
    replacement_trainer_id: null,
    replacement_trainer_name: null,
    status: 'Completed',
    payment_amount: '400',
    replacement_pay: '0',
    deduction_amount: '0'
  },
  {
    id: 203,
    schedule_id: 101,
    schedule_payment_model: 'fixed_monthly',
    session_date: '2026-11-04',
    start_time: '07:00',
    duration_minutes: 60,
    batch_name: '7 AM Morning Yoga',
    session_type: 'Yoga',
    session_kind: 'scheduled',
    assigned_trainer_id: 'TR-A',
    assigned_trainer_name: 'Trainer A',
    conducted_by_trainer_id: 'TR-B',
    conducted_by_name: 'Trainer B',
    replacement_trainer_id: 'TR-B',
    replacement_trainer_name: 'Trainer B',
    status: 'Leave',
    payment_amount: '0',
    replacement_pay: '350',
    deduction_amount: '200'
  }
];

let mockApprovals = [];

const mockQuery = async (sql, values = []) => {
  calls.push({ sql, values });
  if (sql.includes('FROM user_accounts u')) return { rows: [currentAccount], rowCount: 1 };
  if (sql.includes('FROM user_specific_permissions')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM role_permissions')) {
    return {
      rows: [
        { module: 'employees', action: 'view', allowed: true },
        { module: 'employees', action: 'edit', allowed: currentAccount.role === 'super_admin' }
      ],
      rowCount: 2
    };
  }
  if (sql.includes('FROM employees WHERE id = $1')) {
    const found = mockStaff.find(s => s.id === values[0]);
    return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
  }
  if (sql.includes('FROM employees') && sql.includes("WHERE status NOT IN")) {
    return { rows: mockStaff, rowCount: mockStaff.length };
  }
  if (sql.includes('FROM trainer_schedules ts')) {
    const scope = values[0];
    const rows = scope ? mockSchedules.filter(s => s.trainer_id === scope) : mockSchedules;
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('SELECT * FROM trainer_sessions WHERE id = $1')) {
    const found = mockSessions.find(s => s.id === values[0]);
    return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
  }
  if (sql.includes('UPDATE trainer_sessions SET')) {
    const id = values[9];
    const idx = mockSessions.findIndex(s => s.id === id);
    if (idx === -1) return { rows: [], rowCount: 0 };
    mockSessions[idx] = {
      ...mockSessions[idx],
      status: values[0],
      conducted_by_trainer_id: values[1],
      replacement_trainer_id: values[2],
      payment_amount: values[3],
      replacement_pay: values[4],
      deduction_amount: values[5],
      notes: values[6],
      approved: values[7]
    };
    return { rows: [{ ...mockSessions[idx] }], rowCount: 1 };
  }
  if (sql.includes('INSERT INTO trainer_sessions')) {
    const row = { id: mockSessions.length + 300, status: values[7] || 'Completed' };
    return { rows: [row], rowCount: 1 };
  }
  if (sql.includes('FROM trainer_sessions s')) {
    const scope = values[2];
    const rows = scope
      ? mockSessions.filter(s => s.assigned_trainer_id === scope || s.replacement_trainer_id === scope || s.conducted_by_trainer_id === scope)
      : mockSessions;
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('INSERT INTO trainer_monthly_approvals')) {
    const [month, trainer_id, total_payable, status, notes, approved_by] = values;
    const idx = mockApprovals.findIndex(a => a.month === month && a.trainer_id === trainer_id);
    const saved = { id: idx >= 0 ? mockApprovals[idx].id : mockApprovals.length + 1, month, trainer_id, total_payable, status, notes, approved_by };
    if (idx >= 0) mockApprovals[idx] = saved;
    else mockApprovals.push(saved);
    return { rows: [saved], rowCount: 1 };
  }
  if (sql.includes('FROM trainer_monthly_approvals')) {
    if (sql.includes("status = 'Paid'")) {
      const [month, trainerIds] = values;
      const rows = mockApprovals.filter(a => a.month === month && Array.isArray(trainerIds) && trainerIds.includes(a.trainer_id) && a.status === 'Paid');
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FOR UPDATE')) {
      const [month, trainerId] = values;
      const rows = mockApprovals.filter(a => a.month === month && a.trainer_id === trainerId);
      return { rows, rowCount: rows.length };
    }
    const [month, scope] = values;
    const rows = mockApprovals.filter(a => a.month === month && (!scope || a.trainer_id === scope));
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: 0 };
};

pool.query = mockQuery;

rawPool.connect = async () => ({
  query: async (sql, values = []) => {
    const upper = String(sql).trim().toUpperCase();
    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    return mockQuery(sql, values);
  },
  release: () => {}
});

async function request(method, url, body, token) {
  calls = [];
  return new Promise((resolve, reject) => {
    let output = '';
    const socket = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        output += chunk.toString();
        cb();
      }
    });
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    req.body = body || {};
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = output.slice(output.indexOf('\r\n\r\n') + 4);
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      resolve({ status: res.statusCode, data, calls: [...calls] });
    });
    res.on('error', reject);
    app.handle(req, res, reject);
  });
}

test('anonymous requests to trainer routes are rejected', async () => {
  assert.equal((await request('GET', '/api/trainers/overview?month=2026-11', null, null)).status, 401);
  assert.equal((await request('POST', '/api/trainers/schedules', {}, null)).status, 401);
});

test('non-manager employees cannot mutate trainer schedules, sessions, or payouts', async () => {
  currentAccount = { ...employeeUser };
  const token = generateToken(employeeUser);
  for (const [method, url, body] of [
    ['POST', '/api/trainers/schedules', { trainer_id: 'TR-A', batch_name: 'Test', session_type: 'Yoga', days_of_week: [1], start_time: '07:00', payment_model: 'fixed_monthly', rate_amount: 5000 }],
    ['PUT', '/api/trainers/schedules/101', { rate_amount: 6000 }],
    ['DELETE', '/api/trainers/schedules/101', {}],
    ['POST', '/api/trainers/sessions/generate', { month: '2026-11' }],
    ['POST', '/api/trainers/sessions', { session_date: '2026-11-05', start_time: '08:00', batch_name: 'Extra', session_type: 'Yoga', assigned_trainer_id: 'TR-A' }],
    ['PATCH', '/api/trainers/sessions/201', { status: 'Completed' }],
    ['POST', '/api/trainers/payouts/approve', { month: '2026-11', trainer_id: 'TR-A', action: 'approve' }]
  ]) {
    const res = await request(method, url, body, token);
    assert.equal(res.status, 403, `Expected 403 for ${method} ${url}, got ${res.status}`);
  }
});

test('trainer payout calculation avoids double pay and credits replacements accurately', async () => {
  currentAccount = { ...adminUser };
  const adminToken = generateToken(adminUser);

  const res = await request('GET', '/api/trainers/overview?month=2026-11', null, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.canManage, true);

  const trA = res.data.payoutSummary.find(p => p.trainer_id === 'TR-A');
  const trB = res.data.payoutSummary.find(p => p.trainer_id === 'TR-B');

  // Trainer A: fixed_monthly (5000) + extra_pay (400) - adjustment (200) = 5200 (scheduled completed pays ₹0 extra)
  assert.equal(trA.fixed_monthly, 5000);
  assert.equal(trA.per_session_pay, 0);
  assert.equal(trA.extra_pay, 400);
  assert.equal(trA.adjustments, 200);
  assert.equal(trA.net_payable, 5200);
  assert.equal(trA.counts.leave, 1);

  // Trainer B: covered 1 session as replacement for ₹350
  assert.equal(trB.fixed_monthly, 0);
  assert.equal(trB.replacement_pay, 350);
  assert.equal(trB.net_payable, 350);
  assert.equal(trB.counts.replacement, 1);
});

test('employee scope only returns own trainer schedule and payouts', async () => {
  currentAccount = { ...employeeUser };
  const empToken = generateToken(employeeUser);

  const res = await request('GET', '/api/trainers/overview?month=2026-11', null, empToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.canManage, false);
  assert.deepEqual(res.data.payoutSummary.map(p => p.trainer_id), ['TR-A']);
});

test('replacement_pay is not credited for Scheduled or Missed replacement sessions', async () => {
  currentAccount = { ...adminUser };
  const adminToken = generateToken(adminUser);

  const extraNonCovered = [
    {
      id: 204,
      schedule_id: 101,
      schedule_payment_model: 'fixed_monthly',
      session_date: '2026-11-05',
      start_time: '07:00',
      duration_minutes: 60,
      batch_name: '7 AM Morning Yoga',
      session_type: 'Yoga',
      session_kind: 'scheduled',
      assigned_trainer_id: 'TR-A',
      assigned_trainer_name: 'Trainer A',
      conducted_by_trainer_id: null,
      conducted_by_name: null,
      replacement_trainer_id: 'TR-B',
      replacement_trainer_name: 'Trainer B',
      status: 'Scheduled',
      payment_amount: '0',
      replacement_pay: '500',
      deduction_amount: '0'
    },
    {
      id: 205,
      schedule_id: 101,
      schedule_payment_model: 'fixed_monthly',
      session_date: '2026-11-06',
      start_time: '07:00',
      duration_minutes: 60,
      batch_name: '7 AM Morning Yoga',
      session_type: 'Yoga',
      session_kind: 'scheduled',
      assigned_trainer_id: 'TR-A',
      assigned_trainer_name: 'Trainer A',
      conducted_by_trainer_id: null,
      conducted_by_name: null,
      replacement_trainer_id: 'TR-B',
      replacement_trainer_name: 'Trainer B',
      status: 'Missed',
      payment_amount: '0',
      replacement_pay: '500',
      deduction_amount: '0'
    }
  ];

  mockSessions.push(...extraNonCovered);
  try {
    const res = await request('GET', '/api/trainers/overview?month=2026-11', null, adminToken);
    assert.equal(res.status, 200);
    const trainerB = res.data.payoutSummary.find(p => p.trainer_id === 'TR-B');
    // Only session #203 (status 'Leave') is eligible; Scheduled #204 and Missed #205 contribute 0.
    assert.equal(trainerB.counts.replacement, 1);
    assert.equal(trainerB.replacement_pay, 350);
    assert.equal(trainerB.net_payable, 350);
  } finally {
    mockSessions.splice(mockSessions.length - extraNonCovered.length, extraNonCovered.length);
  }
});

test('payout approval computes total_payable server-side and locks month once Paid', async () => {
  currentAccount = { ...adminUser };
  const adminToken = generateToken(adminUser);
  mockApprovals = [];

  try {
    // 1. Approve with spoofed client total_payable -> must persist server-computed 5200
    const approveRes = await request(
      'POST',
      '/api/trainers/payouts/approve',
      { month: '2026-11', trainer_id: 'TR-A', total_payable: 9999999, status: 'Approved' },
      adminToken
    );
    assert.equal(approveRes.status, 200);
    assert.equal(Number(approveRes.data.total_payable), 5200);

    // 2. Mark Paid -> allowed transition from Approved
    const paidRes = await request(
      'POST',
      '/api/trainers/payouts/approve',
      { month: '2026-11', trainer_id: 'TR-A', total_payable: 1, status: 'Paid' },
      adminToken
    );
    assert.equal(paidRes.status, 200);
    assert.equal(paidRes.data.status, 'Paid');
    assert.equal(Number(paidRes.data.total_payable), 5200);

    // 3. Attempting to modify approval again after Paid -> 409
    const reApproveRes = await request(
      'POST',
      '/api/trainers/payouts/approve',
      { month: '2026-11', trainer_id: 'TR-A', status: 'Pending' },
      adminToken
    );
    assert.equal(reApproveRes.status, 409);

    // 4. Attempting to modify an existing session in Paid month -> 409
    const patchSessionRes = await request(
      'PATCH',
      '/api/trainers/sessions/201',
      { status: 'Completed', deduction_amount: 1000 },
      adminToken
    );
    assert.equal(patchSessionRes.status, 409);

    // 5. Attempting to add a new session in Paid month for locked trainer -> 409
    const createSessionRes = await request(
      'POST',
      '/api/trainers/sessions',
      {
        session_date: '2026-11-10',
        start_time: '08:00',
        batch_name: 'Extra Paid Month Session',
        session_type: 'Yoga',
        assigned_trainer_id: 'TR-A',
        status: 'Completed',
        payment_amount: 500
      },
      adminToken
    );
    assert.equal(createSessionRes.status, 409);
  } finally {
    mockApprovals = [];
  }
});

