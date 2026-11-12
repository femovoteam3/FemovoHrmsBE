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

const actor = (role, extra = {}) => ({ id: 1, employee_id: 'ACTOR', name: 'Real Name', email: 'actor@example.test', role, department: 'Sales', status: 'Active', session_version: 0, has_dashboard_access: true, ...extra });
const permissionRows = ['view', 'edit'].map(action => ({ module: 'training', action, allowed: true }));
const QUIZ = [
  { question: 'One', options: ['a', 'b', 'c'], answer: 2 },
  { question: 'Two', options: ['a', 'b'], answer: 0 },
  { question: 'Three', options: ['a', 'b', 'c', 'd'], answer: 3 }
];
const COURSE = { title: 'SOP', department: 'Sales', description: 'd', duration: '30 mins', pass_percent: 60, status: 'Published', lessons: [{ title: 'L1', body: 'Text' }], quiz: [{ question: 'Q', options: ['a', 'b'], answer: 1 }] };
let account = actor('employee');
let course = { id: 1, status: 'Published', pass_percent: 60, quiz_items: QUIZ };
let opened = true;
let assignments = [];
let calls = [];

pool.query = async (sql, values) => {
  calls.push({ sql, values });
  if (sql.includes('FROM user_accounts u')) return { rows: [account], rowCount: 1 };
  if (sql.includes('FROM user_specific_permissions')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM role_permissions')) return { rows: permissionRows, rowCount: permissionRows.length };
  if (sql.includes('SELECT id FROM employees WHERE manager_id')) return { rows: [{ id: 'REPORT' }], rowCount: 1 };
  if (sql.includes("status NOT IN ('Inactive'")) return { rows: [{ id: 'REPORT', name: 'Report', department: 'Sales' }, { id: 'ACTOR', name: 'Me', department: 'Sales' }], rowCount: 2 };
  if (sql.includes('SELECT id FROM employees WHERE id')) return { rows: [{ id: values[0] }], rowCount: 1 };
  if (sql.includes('SELECT id FROM departments WHERE name')) return values[0] === 'Sales' ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (sql.includes('SELECT opened_at FROM training_progress')) return opened ? { rows: [{ opened_at: new Date() }], rowCount: 1 } : { rows: [], rowCount: 0 };
  if (/UPDATE training_progress/.test(sql)) return { rows: [{ attempts: 1, best_percent: values[0], passed_at: values[1] ? new Date() : null, certificate_no: values[1] ? values[2] : null }], rowCount: 1 };
  if (sql.includes('FROM training_progress')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM training_assignments')) return { rows: assignments, rowCount: assignments.length };
  if (/INSERT INTO training_assignments/.test(sql)) return { rows: [{ id: 2 }], rowCount: 1 };
  if (/DELETE FROM training_assignments/.test(sql)) return { rows: [], rowCount: 1 };
  if (/INSERT INTO training |UPDATE training SET/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
  if (sql.includes('jsonb_array_length') && sql.includes('WHERE id = $1')) {
    return {
      rows: [{ id: 1, title: 'SOP', status: 'Published', pass_percent: 60, lesson_items: [{ title: 'L1', body: 'Full body text' }], question_count: 3 }],
      rowCount: 1
    };
  }
  if (sql.includes('jsonb_array_length')) {
    return {
      rows: [{ id: 1, title: 'SOP', status: 'Published', lesson_items: [{ title: 'L1' }], lesson_count: 1, question_count: 3 }],
      rowCount: 1
    };
  }
  if (sql.includes('SELECT id, title FROM training')) return { rows: [{ id: 1, title: 'SOP' }], rowCount: 1 };
  if (sql.includes('FROM training')) return { rows: [course], rowCount: 1 };
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
const progressWrite = result => result.calls.find(call => /UPDATE training_progress/.test(call.sql));

test('a regular employee can pass a quiz and it is recorded only against them', async () => {
  account = actor('employee');
  const result = await request('POST', '/api/training/1/attempts', { answers: { 0: 2, 1: 0, 2: 3 }, employee_id: 'OTHER' });
  assert.equal(result.status, 201);
  assert.deepEqual([result.data.score, result.data.total, result.data.passed], [3, 3, true]);
  const write = progressWrite(result).values;
  assert.deepEqual(write.slice(3), ['ACTOR', 1]);
  assert.match(write[2], /^FEM-CERT-[0-9A-F]{12}$/);
  assert.ok(!result.calls.some(call => /UPDATE training SET/.test(call.sql)), 'nothing is shared across the company');
});

test('the server decides the score and failing issues no certificate', async () => {
  account = actor('employee');
  const failed = await request('POST', '/api/training/1/attempts', { answers: { 0: 0, 1: 1, 2: 3 }, passed: true, score: 3 });
  assert.equal(failed.status, 201);
  assert.deepEqual([failed.data.score, failed.data.passed], [1, false]);
  assert.equal(progressWrite(failed).values[1], false);
  assert.equal(failed.data.progress.certificate_no, null);
  assert.equal((await request('POST', '/api/training/1/attempts', { answers: { 0: 2 } })).status, 400);
  assert.equal((await request('POST', '/api/training/1/attempts', {})).status, 400);
});

test('the pass mark is applied and meeting it counts as a pass', async () => {
  account = actor('employee');
  assert.equal((await request('POST', '/api/training/1/attempts', { answers: { 0: 2, 1: 0, 2: 0 } })).data.passed, true);
  course = { ...course, pass_percent: 100 };
  try {
    assert.equal((await request('POST', '/api/training/1/attempts', { answers: { 0: 2, 1: 0, 2: 0 } })).data.passed, false);
  } finally { course = { ...course, pass_percent: 60 }; }
});

test('quiz questions never include the answers, and lessons must be opened first', async () => {
  account = actor('employee');
  const quiz = await request('GET', '/api/training/1/quiz');
  assert.equal(quiz.status, 200);
  assert.ok(!JSON.stringify(quiz.data).includes('"answer"'));
  assert.deepEqual(quiz.data.questions[0].options.map(o => o.id).sort(), [0, 1, 2]);
  opened = false;
  try {
    assert.equal((await request('GET', '/api/training/1/quiz')).status, 409);
    assert.equal((await request('POST', '/api/training/1/attempts', { answers: { 0: 2, 1: 0, 2: 3 } })).status, 409);
  } finally { opened = true; }
});

test('unpublished courses cannot be taken', async () => {
  account = actor('employee');
  const original = pool.query;
  pool.query = async (sql, values) => (sql.includes("status = 'Published'") && sql.includes('SELECT * FROM training') ? { rows: [], rowCount: 0 } : original(sql, values));
  try {
    assert.equal((await request('POST', '/api/training/1/open')).status, 404);
    assert.equal((await request('GET', '/api/training/1/quiz')).status, 404);
  } finally { pool.query = original; }
});

test('only HR and administrators can manage courses or see the answer key', async () => {
  for (const role of ['employee', 'manager', 'head']) {
    account = actor(role);
    assert.equal((await request('GET', '/api/training/1/admin')).status, 403, role);
    assert.equal((await request('POST', '/api/training', COURSE)).status, 403, role);
    assert.equal((await request('PUT', '/api/training/1', COURSE)).status, 403, role);
    assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'all' })).status, 403, role);
    assert.equal((await request('DELETE', '/api/training/assignments/1')).status, 403, role);
  }
  account = actor('hr');
  assert.equal((await request('GET', '/api/training/1/admin')).status, 200);
  assert.equal((await request('POST', '/api/training', COURSE)).status, 201);
  assert.equal((await request('PUT', '/api/training/1', COURSE)).status, 200);
  assert.equal((await request('GET', '/api/training/abc/quiz')).status, 403);
});

test('course content is validated', async () => {
  account = actor('hr');
  for (const change of [
    { title: ' ' }, { pass_percent: 0 }, { pass_percent: 101 }, { status: 'Live' }, { lessons: [] }, { quiz: [] },
    { lessons: [{ title: 'L', body: '' }] },
    { lessons: [{ title: 'L', body: '', video_url: 'https://vimeo.com/123456' }] },
    { lessons: [{ title: 'L', body: '', video_url: 'http://youtu.be/dQw4w9WgXcQ' }] },
    { lessons: [{ title: 'L', body: '', video_url: 'https://www.youtube.com/watch' }] },
    { lessons: [{ title: 'L', body: 'B', link: 'javascript:alert(1)' }] },
    { quiz: [{ question: 'Q', options: ['only'], answer: 0 }] },
    { quiz: [{ question: 'Q', options: ['a', 'b'], answer: 5 }] },
    { quiz: [{ question: 'Q', options: ['a', ' '], answer: 0 }] }
  ]) {
    assert.equal((await request('POST', '/api/training', { ...COURSE, ...change })).status, 400, JSON.stringify(change));
  }
  const videoOnly = await request('POST', '/api/training', {
    ...COURSE,
    lessons: [{ title: 'Video lesson', body: '', video_url: 'https://youtu.be/dQw4w9WgXcQ?t=10' }]
  });
  assert.equal(videoOnly.status, 201);
  const savedLessons = JSON.parse(videoOnly.calls.find(call => /INSERT INTO training /.test(call.sql)).values[6]);
  assert.deepEqual(savedLessons, [{
    title: 'Video lesson', body: '',
    video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', video_id: 'dQw4w9WgXcQ'
  }]);
  assert.equal((await request('POST', '/api/training', { ...COURSE, status: 'Draft', lessons: [], quiz: [] })).status, 201, 'drafts can be unfinished');
});

test('assignments require a real target', async () => {
  account = actor('hr');
  assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'all', due_date: '2026-12-31' })).status, 201);
  assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'department', target: 'Sales' })).status, 201);
  assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'department', target: 'Missing' })).status, 404);
  assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'employee', target: 'ACTOR' })).status, 201);
  assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'nobody' })).status, 400);
  assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'department', target: ' ' })).status, 400);
  assert.equal((await request('POST', '/api/training/1/assignments', { scope: 'all', due_date: 'soon' })).status, 400);
});

test('learners see assignments that match them, with overdue dates flagged', async () => {
  account = actor('employee');
  assignments = [{ id: 1, training_id: 1, scope: 'department', target: 'Sales', due_date: '2000-01-01' }];
  try {
    const mine = (await request('GET', '/api/training')).data.courses[0];
    assert.deepEqual([mine.assigned, mine.due_date, mine.overdue], [true, '2000-01-01', true]);
    assignments = [{ id: 1, training_id: 1, scope: 'department', target: 'Clinical', due_date: '2000-01-01' }];
    const other = (await request('GET', '/api/training')).data.courses[0];
    assert.deepEqual([other.assigned, other.overdue], [false, false]);
  } finally { assignments = []; }
});

test('team tracking is limited to the people someone is responsible for', async () => {
  assignments = [{ training_id: 1, scope: 'all', target: null, due_date: '2000-01-01' }];
  const scopeOf = result => result.calls.find(call => call.sql.includes("status NOT IN ('Inactive'")).values[0];
  try {
    account = actor('employee');
    assert.deepEqual(scopeOf(await request('GET', '/api/training/tracking')), ['ACTOR']);
    assert.equal((await request('GET', '/api/training')).data.hasTeam, false);
    account = actor('manager');
    const team = await request('GET', '/api/training/tracking');
    assert.deepEqual(scopeOf(team), ['ACTOR', 'REPORT']);
    assert.equal(team.data[0].status, 'Overdue');
    assert.equal((await request('GET', '/api/training')).data.hasTeam, true);
    account = actor('hr');
    assert.equal(scopeOf(await request('GET', '/api/training/tracking')), null);
  } finally { assignments = []; }
});

test('training list omits lesson bodies while course detail returns full lessons without quiz answers', async () => {
  account = actor('employee');
  const listRes = await request('GET', '/api/training');
  assert.equal(listRes.status, 200);
  const listSql = listRes.calls.find(call => call.sql.includes('FROM training')).sql;
  assert.ok(!listSql.includes('SELECT id, title, department, description, duration, pass_percent, status, lesson_items,'), 'list query should project lightweight titles instead of full lesson_items bodies');
  assert.equal(listRes.data.courses[0].lesson_count, 1);
  assert.equal(listRes.data.courses[0].lesson_items[0].body, undefined);

  const detailRes = await request('GET', '/api/training/1');
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.data.lesson_items[0].body, 'Full body text');
  assert.ok(!JSON.stringify(detailRes.data).includes('"answer"'));
});
