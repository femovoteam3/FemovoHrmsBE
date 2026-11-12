import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';

// The recruitment workflow, end to end, on a disposable PostgreSQL database with synthetic people only.
const testUrl = process.env.TEST_DATABASE_URL;
test('recruitment workflow on isolated PostgreSQL', { skip: !testUrl, timeout: 180000 }, async t => {
  const url = new URL(testUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '55439' && url.pathname === '/femovo_security_test', 'Refuse to run mutation tests outside the dedicated local test database.');
  process.env.DATABASE_URL = testUrl;
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.WORK_WEEK = '1,2,3,4,5';
  process.env.HOLIDAYS_JSON = '[]';
  process.env.UPLOAD_DIR = path.resolve('.test-uploads');
  const { rawPool } = await import('../../server/db.js');
  const { migrate } = await import('../../server/migrate.js');
  const { hashPin, generateToken } = await import('../../server/auth.js');
  let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await rawPool.end(); });
  await rawPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate();

  const tokens = {};
  const ids = {};
  const admin = (await rawPool.query("INSERT INTO user_accounts(employee_id,email,pin,name,role,department,role_title,avatar) VALUES('ROOT','root@example.test',$1,'Root Admin','super_admin','Test','Admin','RA') RETURNING *", [await hashPin('Synthetic-Only-Password')])).rows[0];
  tokens.ROOT = generateToken(admin);

  const { app } = await import('../../server/index.js');
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, endpoint, body, user = 'ROOT') => {
    const response = await fetch(base + endpoint, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(user ? { Authorization: 'Bearer ' + tokens[user] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  };
  const ok = async (method, endpoint, body, user, expected = 200) => {
    const result = await request(method, endpoint, body, user);
    assert.equal(result.status, expected, `${user} ${method} ${endpoint}: ${JSON.stringify(result.data)}`);
    return result.data;
  };
  const signIn = async (key, email) => {
    const row = (await rawPool.query('SELECT * FROM user_accounts WHERE email=$1', [email])).rows[0];
    tokens[key] = generateToken(row); ids[key] = row.employee_id;
  };
  const addPerson = async (key, name, ats_role, by, department = 'Test') => {
    const email = `${key.toLowerCase()}@example.test`;
    await ok('POST', '/api/ats/resources', { name, email, ats_role, department }, by, 201);
    await signIn(key, email);
  };
  const stageOf = async id => (await rawPool.query('SELECT stage FROM applicants WHERE id=$1', [id])).rows[0].stage;
  const visibleTo = async user => (await ok('GET', '/api/applicants', null, user)).map(row => row.id).sort((a, b) => a - b);
  const notesFor = async user => (await ok('GET', '/api/notifications', null, user)).items.map(item => item.title);
  const feedback = { rating: 4, notes: 'Clear and suitable', recommendation: 'Hire' };
  const soon = () => new Date(Date.now() + 86400000).toISOString();

  await t.test('Super Admin and CEO create the team; nobody creates people at their own level', async () => {
    await addPerson('CEO', 'Test CEO', 'ceo', 'ROOT');
    await addPerson('HEAD', 'Test Head HR', 'rec_lead', 'CEO');
    await addPerson('A', 'Assistant A', 'rec_associate', 'CEO');
    await addPerson('B', 'Assistant B', 'rec_associate', 'CEO');
    await addPerson('INT', 'Interviewer I', 'hiring_manager', 'CEO');
    const person = { name: 'Extra', email: 'extra@example.test' };
    assert.equal((await request('POST', '/api/ats/resources', { ...person, ats_role: 'ceo' }, 'CEO')).status, 403);
    assert.equal((await request('POST', '/api/ats/resources', { ...person, ats_role: 'rec_associate' }, 'HEAD')).status, 403);
    assert.equal((await request('POST', '/api/ats/resources', { ...person, ats_role: 'rec_associate' }, 'A')).status, 403);
    assert.equal((await request('POST', '/api/ats/resources', { name: 'Copy', email: 'a@example.test', ats_role: 'rec_associate' }, 'CEO')).status, 409);
    assert.equal((await request('PUT', `/api/ats/resources/${ids.CEO}`, { name: 'Renamed' }, 'CEO')).status, 403);
    // New accounts never get a default password.
    const pins = (await rawPool.query('SELECT pin, plain_pin FROM user_accounts')).rows;
    assert.ok(pins.every(row => /^\$2[aby]\$/.test(row.pin) && row.plain_pin === null));
  });

  const jobs = {};
  await t.test('Head HR creates jobs and sets which assistant handles what', async () => {
    for (const [key, role, department, extra] of [['design', 'Graphic Designer', 'Marketing'], ['ops', 'Operations Executive', 'Operations'], ['finance', 'Accountant', 'Finance', { assigned_recruiter_id: ids.B }], ['legal', 'Legal Counsel', 'Legal']]) {
      jobs[key] = await ok('POST', '/api/requisitions', { role, department, openings: 2, requirements: 'Synthetic', ...extra }, 'HEAD', 201);
    }
    assert.equal(jobs.finance.assigned_recruiter_name, 'Assistant B');
    assert.equal(jobs.design.assigned_recruiter_id, null);
    assert.equal((await request('POST', '/api/requisitions', { role: 'X', department: 'Y' }, 'A')).status, 403);
    assert.equal((await request('POST', '/api/requisitions', { role: 'X', department: 'Y', assigned_recruiter_id: 'NOBODY' }, 'HEAD')).status, 400);
    await ok('PUT', `/api/ats/resources/${ids.A}/assignments`, { departments: ['Marketing', 'Operations'] }, 'HEAD');
    assert.equal((await request('PUT', `/api/ats/resources/${ids.A}/assignments`, { departments: ['Finance'] }, 'A')).status, 403);
  });

  const cand = {};
  const apply = async (key, job, user = null) => {
    const created = await ok('POST', '/api/applicants', { name: `Candidate ${key}`, job: job.role, job_id: job.id, email: `${key}@example.test`, phone: '9822012345' }, user, 201);
    cand[key] = created.id;
    return created;
  };

  await t.test('Scenario C: one assistant handles two departments and sees only those candidates', async () => {
    const publicReply = await apply('design1', jobs.design);
    assert.deepEqual(Object.keys(publicReply).sort(), ['department', 'id', 'job', 'name', 'uploadToken']);
    await apply('ops1', jobs.ops);
    await apply('finance1', jobs.finance);
    await apply('legal1', jobs.legal);
    const rows = (await rawPool.query('SELECT id, assigned_recruiter_id, job_id, stage, notice_period, expected_ctc FROM applicants ORDER BY id')).rows;
    assert.deepEqual(rows.map(row => row.assigned_recruiter_id), [ids.A, ids.A, ids.B, null]);
    assert.ok(rows.every(row => row.stage === 'New' && row.job_id && row.notice_period === null && row.expected_ctc === null));
    assert.deepEqual(await visibleTo('A'), [cand.design1, cand.ops1]);
    assert.deepEqual(await visibleTo('B'), [cand.finance1]);
    assert.deepEqual(await visibleTo('INT'), []);
    assert.equal((await visibleTo('HEAD')).length, 4);
    assert.equal((await visibleTo('CEO')).length, 4);
    assert.ok((await notesFor('A')).some(title => title.includes('Candidate design1')));
    // Nobody handles Legal, so Head HR and the CEO are told and the candidate waits in the Unassigned queue.
    assert.ok((await notesFor('HEAD')).some(title => title.includes('Candidate legal1 has no HR Assistant')));
    assert.ok((await notesFor('CEO')).some(title => title.includes('Candidate legal1 has no HR Assistant')));
    assert.equal((await ok('GET', '/api/ats/queues', null, 'HEAD')).unassigned, 1);
    assert.equal((await ok('GET', '/api/ats/queues', null, 'A')).unassigned, 0);
  });

  await t.test('Scenario D: two assistants in one department follow the primary owner, then workload', async () => {
    await ok('PUT', `/api/ats/resources/${ids.B}/assignments`, { departments: ['Marketing'], primary: { departments: ['Marketing'] } }, 'HEAD');
    await apply('design2', jobs.design);
    assert.equal((await rawPool.query('SELECT assigned_recruiter_id FROM applicants WHERE id=$1', [cand.design2])).rows[0].assigned_recruiter_id, ids.B);
    await ok('PUT', `/api/ats/resources/${ids.B}/assignments`, { departments: ['Marketing'] }, 'HEAD');
    await apply('design3', jobs.design);
    // B has 2 active candidates and A has 2: the tie goes to the same person every time, never at random.
    const owner = (await rawPool.query('SELECT assigned_recruiter_id FROM applicants WHERE id=$1', [cand.design3])).rows[0].assigned_recruiter_id;
    assert.ok([ids.A, ids.B].includes(owner));
    assert.ok(!(await visibleTo('A')).includes(cand.design2));
    // Changing the rules did not move anyone who was already assigned.
    assert.equal((await rawPool.query('SELECT assigned_recruiter_id FROM applicants WHERE id=$1', [cand.design1])).rows[0].assigned_recruiter_id, ids.A);
    await ok('PUT', `/api/ats/resources/${ids.B}/assignments`, {}, 'HEAD');
  });

  await t.test("Scenario H: another assistant's candidate is refused on every route", async () => {
    const other = cand.finance1;
    for (const [method, endpoint, body] of [
      ['GET', `/api/applicants/${other}`], ['GET', `/api/applicants/${other}/history`],
      ['PUT', `/api/applicants/${other}`, { name: 'Changed' }], ['PATCH', `/api/applicants/${other}/stage`, { stage: 'Rejected', rejection_reason: 'x' }],
      ['POST', `/api/applicants/${other}/interviews`, { type: 'screening' }], ['PATCH', `/api/applicants/${other}/assign`, { assigned_recruiter_id: ids.A }],
      ['DELETE', `/api/applicants/${other}`], ['POST', `/api/applicants/${other}/recommend`, { recommendation: 'x' }], ['POST', `/api/applicants/${other}/ceo-decision`, { decision: 'approved' }]
    ]) assert.equal((await request(method, endpoint, body, 'A')).status, 403, `${method} ${endpoint}`);
    assert.deepEqual((await ok('GET', `/api/interviews?applicant_id=${other}`, null, 'A')), []);
    assert.equal((await request('GET', '/api/export/applicants', null, 'A')).status, 403);
    assert.equal((await request('GET', '/api/offers', null, 'A')).status, 403);
    assert.equal((await request('GET', '/api/ats/resources', null, 'A')).status, 403);
    assert.equal((await request('GET', `/api/applicants/${other}`, null, null)).status, 401);
    assert.equal(await stageOf(other), 'New');
  });

  // Takes a candidate through screening and HR L1 as their HR Assistant.
  const throughHrL1 = async (id, assistant) => {
    const screening = await ok('POST', `/api/applicants/${id}/interviews`, { type: 'screening' }, assistant, 201);
    await ok('POST', `/api/interviews/${screening.interview.id}/feedback`, { ...feedback, scorecard: { call_status: 'Connected', expected_salary: '30000', notice_period: '30 days' } }, assistant);
    await ok('PATCH', `/api/applicants/${id}/stage`, { stage: 'HR L1', remarks: 'Good call' }, assistant);
    const l1 = await ok('POST', `/api/applicants/${id}/interviews`, { type: 'hr_l1', scheduled_at: soon(), meeting_url: 'https://meet.google.com/test-link' }, assistant, 201);
    await ok('POST', `/api/interviews/${l1.interview.id}/feedback`, feedback, assistant);
  };
  const throughHeadHr = async id => {
    const round = await ok('POST', `/api/applicants/${id}/interviews`, { type: 'head_hr', scheduled_at: soon() }, 'HEAD', 201);
    await ok('POST', `/api/interviews/${round.interview.id}/feedback`, { ...feedback, recommendation: 'Strong Hire' }, 'HEAD');
  };

  await t.test('Scenario A: application to EMS employee, with every gate on the way', async () => {
    const id = cand.design1;
    const screening = await ok('POST', `/api/applicants/${id}/interviews`, { type: 'screening' }, 'A', 201);
    assert.equal(screening.applicant.stage, 'Screening');
    assert.equal(screening.interview.interviewer_name, 'Assistant A');
    assert.equal((await request('PATCH', `/api/applicants/${id}/stage`, { stage: 'HR L1', remarks: 'Skip the call' }, 'A')).status, 409);
    assert.equal((await request('POST', `/api/interviews/${screening.interview.id}/feedback`, { rating: 4, notes: 'x' }, 'A')).status, 400);
    await ok('POST', `/api/interviews/${screening.interview.id}/feedback`, { ...feedback, scorecard: { call_status: 'Connected', expected_salary: '30000' } }, 'A');
    assert.equal((await request('PATCH', `/api/applicants/${id}/stage`, { stage: 'Head HR Round', remarks: 'Skip a stage' }, 'A')).status, 409);
    await ok('PATCH', `/api/applicants/${id}/stage`, { stage: 'HR L1', remarks: 'Good call' }, 'A');

    assert.equal((await request('POST', `/api/applicants/${id}/interviews`, { type: 'hr_l1', meeting_url: 'http://insecure.example' }, 'A')).status, 400);
    const l1 = await ok('POST', `/api/applicants/${id}/interviews`, { type: 'hr_l1', scheduled_at: soon(), meeting_url: 'https://meet.google.com/test-link' }, 'A', 201);
    assert.equal((await request('PATCH', `/api/applicants/${id}/stage`, { stage: 'Head HR Round', remarks: 'No scorecard yet' }, 'A')).status, 409);
    // Rescheduling keeps the earlier time in the history.
    const moved = await ok('PATCH', `/api/interviews/${l1.interview.id}`, { scheduled_at: new Date(Date.now() + 2 * 86400000).toISOString() }, 'A');
    assert.equal(moved.status, 'Rescheduled');
    await ok('POST', `/api/interviews/${l1.interview.id}/feedback`, feedback, 'A');
    assert.equal((await request('POST', `/api/interviews/${l1.interview.id}/feedback`, feedback, 'A')).status, 409);
    await ok('PATCH', `/api/applicants/${id}/stage`, { stage: 'Head HR Round', remarks: 'Recommended by HR L1' }, 'A');
    assert.ok((await notesFor('HEAD')).some(title => title.includes('Candidate design1 was forwarded for the Head HR round by Assistant A')));

    // The assistant still owns and sees the candidate, but the next steps are not theirs.
    assert.ok((await visibleTo('A')).includes(id));
    assert.equal((await request('POST', `/api/applicants/${id}/recommend`, { recommendation: 'Hire' }, 'A')).status, 403);
    assert.equal((await request('POST', `/api/applicants/${id}/interviews`, { type: 'head_hr' }, 'A')).status, 403);
    assert.equal((await request('POST', `/api/applicants/${id}/recommend`, { recommendation: 'Hire' }, 'HEAD')).status, 409);
    await throughHeadHr(id);
    assert.equal((await request('POST', `/api/applicants/${id}/recommend`, {}, 'HEAD')).status, 400);
    const recommended = await ok('POST', `/api/applicants/${id}/recommend`, { recommendation: 'Strong designer, hire', monthly_salary: '₹45,000' }, 'HEAD');
    assert.equal(recommended.stage, 'CEO Approval');
    assert.ok((await notesFor('CEO')).some(title => title.includes('Candidate design1 is waiting for your approval')));
    assert.equal((await ok('GET', '/api/ats/queues', null, 'CEO')).ceo, 1);

    // Only the CEO decides, and nothing about the offer can start before that.
    const offer = { applicant_id: id, annual_ctc: 540000, basic: 30000, hra: 10000, allowances: 5000, deductions: 0, joining_date: '2026-12-01' };
    assert.equal((await request('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'approved' }, 'HEAD')).status, 403);
    assert.equal((await request('PATCH', `/api/applicants/${id}/stage`, { stage: 'Approved', remarks: 'Skip the CEO' }, 'HEAD')).status, 409);
    assert.equal((await request('POST', '/api/offers', offer, 'HEAD')).status, 409);
    assert.equal((await request('POST', `/api/applicants/${id}/promote`, {}, 'HEAD')).status, 409);
    const history = await ok('GET', `/api/applicants/${id}/history`, null, 'CEO');
    assert.equal(history.interviews.filter(i => i.status === 'Completed').length, 3);
    assert.ok(history.events.some(event => event.kind === 'recommendation' && event.actor_name === 'Test Head HR'));
    assert.equal((await ok('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'approved' }, 'CEO')).stage, 'Approved');
    assert.ok((await notesFor('HEAD')).some(title => title.includes('Candidate design1 was approved by Test CEO')));
    assert.ok((await notesFor('A')).some(title => title.includes('Candidate design1 was approved by Test CEO')));

    // Offer, acceptance, then onboarding. The CEO approves people but does not issue offers by default.
    assert.equal((await request('POST', '/api/offers', offer, 'CEO')).status, 403);
    assert.equal((await request('POST', '/api/offers', { ...offer, basic: 1 }, 'HEAD')).status, 400);
    const issued = await ok('POST', '/api/offers', offer, 'HEAD', 201);
    assert.equal(issued.status, 'Issued');
    assert.equal((await request('POST', '/api/offers', offer, 'HEAD')).status, 409);
    assert.equal((await request('POST', `/api/applicants/${id}/promote`, {}, 'HEAD')).status, 409);
    assert.equal((await request('PATCH', `/api/offers/${issued.id}/status`, { status: 'Declined' }, 'HEAD')).status, 400);
    assert.equal((await request('PATCH', `/api/offers/${issued.id}/status`, { status: 'Accepted' }, 'A')).status, 403);
    await ok('PATCH', `/api/offers/${issued.id}/status`, { status: 'Accepted' }, 'HEAD');
    assert.equal((await request('POST', `/api/applicants/${id}/promote`, {}, 'A')).status, 403);
    const onboarded = await ok('POST', `/api/applicants/${id}/promote`, {}, 'HEAD', 201);
    assert.equal(onboarded.passwordSetupRequired, true);
    const employee = (await rawPool.query("SELECT role, department, to_char(joining_date,'YYYY-MM-DD') AS joining FROM employees WHERE id=$1", [onboarded.empId])).rows[0];
    assert.deepEqual(employee, { role: 'Graphic Designer', department: 'Marketing', joining: '2026-12-01' });
    assert.equal((await request('POST', `/api/applicants/${id}/promote`, {}, 'HEAD')).status, 409);
    assert.equal(Number((await rawPool.query('SELECT COUNT(*) FROM employees WHERE LOWER(email)=$1', ['design1@example.test'])).rows[0].count), 1);
    assert.equal((await request('PATCH', `/api/offers/${issued.id}/status`, { status: 'Withdrawn', notes: 'Too late' }, 'HEAD')).status, 409);
    const kinds = (await ok('GET', `/api/applicants/${id}/history`, null, 'HEAD')).events.map(event => event.kind);
    for (const kind of ['stage', 'assignment', 'interview', 'recommendation', 'ceo_decision', 'offer', 'onboarding']) assert.ok(kinds.includes(kind), kind);
  });

  await t.test('Scenario B: an additional interviewer round before the Head HR round', async () => {
    const id = cand.ops1;
    await throughHrL1(id, 'A');
    assert.equal((await request('POST', `/api/applicants/${id}/interviews`, { type: 'additional', interviewer_id: ids.INT, scheduled_at: soon() }, 'A')).status, 403);
    assert.equal((await request('POST', `/api/applicants/${id}/interviews`, { type: 'additional' }, 'HEAD')).status, 400);
    const extra = await ok('POST', `/api/applicants/${id}/interviews`, { type: 'additional', interviewer_id: ids.INT, scheduled_at: soon(), meeting_url: 'https://meet.google.com/extra' }, 'HEAD', 201);
    assert.ok((await notesFor('INT')).some(title => title.includes('Additional interview assigned to you: Candidate ops1')));
    assert.equal(await stageOf(id), 'HR L1');
    assert.equal((await request('PATCH', `/api/applicants/${id}/stage`, { stage: 'Head HR Round', remarks: 'Forward' }, 'A')).status, 409);

    // The interviewer sees this candidate and this interview only, with no salary figures.
    assert.deepEqual(await visibleTo('INT'), [id]);
    const seen = (await ok('GET', `/api/applicants/${id}`, null, 'INT'));
    assert.ok(!('expected_ctc' in seen) && !('monthly_salary' in seen) && !('current_ctc' in seen));
    assert.deepEqual((await ok('GET', '/api/interviews?scope=mine', null, 'INT')).map(row => row.id), [extra.interview.id]);
    assert.equal((await ok('GET', '/api/ats/queues', null, 'INT')).my_interviews, 1);
    assert.equal((await request('GET', `/api/applicants/${cand.design2}`, null, 'INT')).status, 403);
    for (const [method, endpoint, body] of [
      ['PATCH', `/api/applicants/${id}/stage`, { stage: 'Head HR Round', remarks: 'x' }], ['PATCH', `/api/applicants/${id}/stage`, { stage: 'Rejected', rejection_reason: 'x' }],
      ['PUT', `/api/applicants/${id}`, { name: 'Changed' }], ['POST', `/api/applicants/${id}/ceo-decision`, { decision: 'approved' }], ['POST', '/api/offers', { applicant_id: id }],
      ['POST', '/api/requisitions', { role: 'X', department: 'Y' }], ['GET', '/api/ats/resources']
    ]) assert.equal((await request(method, endpoint, body, 'INT')).status, 403, `${method} ${endpoint}`);
    // Nobody else can fill the interviewer's scorecard.
    assert.equal((await request('POST', `/api/interviews/${extra.interview.id}/feedback`, feedback, 'A')).status, 403);
    assert.equal((await request('POST', `/api/interviews/${extra.interview.id}/feedback`, feedback, 'HEAD')).status, 403);
    await ok('POST', `/api/interviews/${extra.interview.id}/feedback`, { ...feedback, recommendation: 'Another review' }, 'INT');
    assert.ok((await notesFor('A')).some(title => title.includes('Additional interview feedback for Candidate ops1')));
    await ok('PATCH', `/api/applicants/${id}/stage`, { stage: 'Head HR Round', remarks: 'All rounds done' }, 'A');
    // Once their interview is over the interviewer keeps the record of it, and nothing more.
    assert.deepEqual(await visibleTo('INT'), [id]);
  });

  await t.test('Scenario E: the CEO rejects with a reason and the history stays', async () => {
    const id = cand.ops1;
    await throughHeadHr(id);
    await ok('POST', `/api/applicants/${id}/recommend`, { recommendation: 'Mixed feedback, your call' }, 'HEAD');
    assert.equal((await request('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'rejected' }, 'CEO')).status, 400);
    assert.equal((await request('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'maybe', remarks: 'x' }, 'CEO')).status, 400);
    const before = (await ok('GET', `/api/applicants/${id}/history`, null, 'HEAD')).events.length;
    const rejected = await ok('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'rejected', remarks: 'Not the right level' }, 'CEO');
    assert.equal(rejected.stage, 'Rejected');
    assert.equal(rejected.rejection_reason, 'Not the right level');
    const history = await ok('GET', `/api/applicants/${id}/history`, null, 'A');
    assert.ok(history.events.length > before);
    assert.equal(history.interviews.length, 4);
    assert.ok((await notesFor('A')).some(title => title.includes('Candidate ops1 was rejected by Test CEO')));
    assert.equal((await request('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'approved' }, 'CEO')).status, 409);
  });

  await t.test('Scenario F: the CEO asks for another interview and the candidate comes back by itself', async () => {
    const id = cand.design2;
    await ok('PATCH', `/api/applicants/${id}/assign`, { assigned_recruiter_id: ids.A }, 'HEAD');
    assert.ok((await visibleTo('A')).includes(id) && !(await visibleTo('B')).includes(id));
    await throughHrL1(id, 'A');
    await ok('PATCH', `/api/applicants/${id}/stage`, { stage: 'Head HR Round', remarks: 'Forward' }, 'A');
    await throughHeadHr(id);
    await ok('POST', `/api/applicants/${id}/recommend`, { recommendation: 'Hire' }, 'HEAD');
    assert.equal((await request('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'interview_requested' }, 'CEO')).status, 400);
    const asked = await ok('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'interview_requested', remarks: 'Check design portfolio in depth' }, 'CEO');
    assert.equal(asked.stage, 'Head HR Round');
    assert.ok((await notesFor('HEAD')).some(title => title.includes('The CEO asked for another interview for Candidate design2')));
    assert.equal((await request('POST', `/api/applicants/${id}/recommend`, { recommendation: 'Again' }, 'HEAD')).status, 409);
    const extra = await ok('POST', `/api/applicants/${id}/interviews`, { type: 'additional', interviewer_id: ids.INT, scheduled_at: soon() }, 'HEAD', 201);
    const done = await ok('POST', `/api/interviews/${extra.interview.id}/feedback`, feedback, 'INT');
    assert.equal(done.applicant.stage, 'CEO Approval');
    assert.ok((await notesFor('CEO')).filter(title => title.includes('Candidate design2 is waiting for your approval')).length >= 2);
    // Sending back needs a reason and returns the candidate to Head HR.
    assert.equal((await ok('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'sent_back', remarks: 'Salary too high' }, 'CEO')).stage, 'Head HR Round');
    assert.equal((await ok('POST', `/api/applicants/${id}/recommend`, { recommendation: 'Revised salary', monthly_salary: '₹40,000' }, 'HEAD')).stage, 'CEO Approval');
    assert.equal((await ok('POST', `/api/applicants/${id}/ceo-decision`, { decision: 'approved', remarks: 'Fine now' }, 'CEO')).stage, 'Approved');
  });

  await t.test('offers can be declined or withdrawn, and a new one issued afterwards', async () => {
    const id = cand.design2;
    const offer = { applicant_id: id, annual_ctc: 480000, basic: 30000, hra: 10000, allowances: 0, joining_date: '2026-12-15' };
    const first = await ok('POST', '/api/offers', offer, 'HEAD', 201);
    await ok('PATCH', `/api/offers/${first.id}/status`, { status: 'Declined', notes: 'Took another job' }, 'HEAD');
    assert.equal((await request('POST', `/api/applicants/${id}/promote`, {}, 'HEAD')).status, 409);
    assert.equal((await request('PATCH', `/api/offers/${first.id}/status`, { status: 'Accepted' }, 'HEAD')).status, 409);
    const second = await ok('POST', '/api/offers', { ...offer, status: 'Draft' }, 'HEAD', 201);
    assert.equal(second.status, 'Draft');
    await ok('PATCH', `/api/offers/${second.id}/status`, { status: 'Issued' }, 'HEAD');
    assert.equal((await rawPool.query('SELECT offer_status FROM applicants WHERE id=$1', [id])).rows[0].offer_status, 'Issued');
    assert.equal((await ok('GET', '/api/offers', null, 'HEAD')).length, 3);
    assert.equal((await ok('GET', '/api/offers', null, 'CEO')).length, 3);
  });

  await t.test('permission switches change what the server allows', async () => {
    const id = cand.design3;
    const owner = (await rawPool.query('SELECT assigned_recruiter_id FROM applicants WHERE id=$1', [id])).rows[0].assigned_recruiter_id === ids.A ? 'A' : 'B';
    assert.equal((await request('PUT', '/api/ats/roles/rec_associate/permissions', { permissions: { workflow: { screen_candidates: false } } }, 'HEAD')).status, 403);
    await ok('PUT', '/api/ats/roles/rec_associate/permissions', { permissions: { workflow: { screen_candidates: false, made_up_switch: true } } }, 'CEO');
    assert.equal(Number((await rawPool.query("SELECT COUNT(*) FROM ats_role_permissions WHERE action='made_up_switch'")).rows[0].count), 0);
    assert.equal((await request('POST', `/api/applicants/${id}/interviews`, { type: 'screening' }, owner)).status, 403);
    assert.equal((await ok('GET', '/api/ats/roles/rec_associate/permissions', null, 'CEO')).permissions.workflow.screen_candidates, false);
    await ok('PUT', '/api/ats/roles/rec_associate/permissions', { permissions: { workflow: { screen_candidates: true } } }, 'CEO');
    await ok('POST', `/api/applicants/${id}/interviews`, { type: 'screening' }, owner, 201);
    // Every switch on the page is one the server knows.
    const modules = await ok('GET', '/api/ats/permissions/modules', null, 'CEO');
    const shown = (await ok('GET', '/api/ats/roles/ceo/permissions', null, 'CEO')).permissions;
    for (const module of modules) for (const action of module.actions) assert.equal(typeof shown[module.id][action.id], 'boolean', action.id);
    assert.equal(shown.workflow.final_approval, true);
    assert.equal(shown.offers.issue_offers, false);
  });

  await t.test('Scenario G: a deactivated assistant loses access and their candidates wait for reassignment', async () => {
    const updated = await ok('PUT', `/api/ats/resources/${ids.B}`, { status: 'Inactive', has_ats_access: false }, 'CEO');
    assert.ok(updated.candidates_to_reassign >= 1);
    // Their session ends at once.
    assert.ok([401, 403].includes((await request('GET', '/api/applicants', null, 'B')).status));
    assert.ok(!(await visibleTo('A')).includes(cand.finance1));
    // New candidates no longer go to the inactive person.
    await apply('finance2', jobs.finance);
    assert.equal((await rawPool.query('SELECT assigned_recruiter_id FROM applicants WHERE id=$1', [cand.finance2])).rows[0].assigned_recruiter_id, null);
    assert.equal((await request('POST', `/api/ats/resources/${ids.B}/reassign-all`, { target_recruiter_id: ids.A }, 'A')).status, 403);
    assert.equal((await request('POST', `/api/ats/resources/${ids.B}/reassign-all`, { target_recruiter_id: ids.B }, 'HEAD')).status, 400);
    const moved = await ok('POST', `/api/ats/resources/${ids.B}/reassign-all`, { target_recruiter_id: ids.A }, 'HEAD');
    assert.equal(moved.moved, updated.candidates_to_reassign);
    assert.ok((await visibleTo('A')).includes(cand.finance1));
    const events = (await ok('GET', `/api/applicants/${cand.finance1}/history`, null, 'HEAD')).events;
    assert.ok(events.some(event => event.kind === 'assignment' && event.from_value === 'Assistant B' && event.to_value === 'Assistant A'));
  });

  await t.test('the public form saves what was typed, refuses bad answers and repeat applications', async () => {
    const form = { name: ' Priya Public ', job: jobs.design.role, job_id: jobs.design.id, email: 'Priya@Example.test', phone: '+91 98220 12345' };
    for (const bad of [{ phone: '' }, { phone: '12345' }, { email: 'priya' }, { name: ' ' }, { portfolio_url: 'javascript:alert(1)' }, { qualification: 'x'.repeat(151) }]) {
      assert.equal((await request('POST', '/api/applicants', { ...form, ...bad }, null)).status, 400, JSON.stringify(bad).slice(0, 50));
    }
    assert.equal((await request('POST', '/api/applicants', { ...form, job_id: 999999 }, null)).status, 400);
    const created = await ok('POST', '/api/applicants', { ...form, qualification: 'B.Des', current_location: 'Pune', portfolio_url: 'https://example.test/priya', expected_ctc: '₹4.5 LPA', source: 'Spoofed', assigned_recruiter_id: ids.B, stage: 'Approved' }, null, 201);
    const row = (await rawPool.query('SELECT name, email, stage, source, qualification, current_location, portfolio_url, expected_ctc, current_ctc, notice_period, assigned_recruiter_id FROM applicants WHERE id=$1', [created.id])).rows[0];
    assert.deepEqual(row, { name: 'Priya Public', email: 'priya@example.test', stage: 'New', source: 'Career portal', qualification: 'B.Des', current_location: 'Pune', portfolio_url: 'https://example.test/priya', expected_ctc: '₹4.5 LPA', current_ctc: null, notice_period: null, assigned_recruiter_id: ids.A });
    // The same person cannot apply twice for the same job, whatever the letter case of the email.
    assert.equal((await request('POST', '/api/applicants', { ...form, email: 'PRIYA@example.test' }, null)).status, 409);
    await ok('POST', '/api/applicants', { ...form, job: jobs.ops.role, job_id: jobs.ops.id }, null, 201);
    // The public job list shows requirements and nothing about who handles the job.
    const listed = (await ok('GET', '/api/requisitions', null, null)).find(job => job.id === jobs.design.id);
    assert.equal(listed.requirements, 'Synthetic');
    assert.ok(!('assigned_recruiter_id' in listed) && !('assigned_recruiter_name' in listed) && !('backup_recruiter_id' in listed));
  });

  await t.test('notifications belong to one person and can be marked read', async () => {
    const before = await ok('GET', '/api/notifications', null, 'A');
    assert.ok(before.unread > 0);
    await ok('POST', '/api/notifications/read', { id: before.items[0].id }, 'A');
    assert.equal((await ok('GET', '/api/notifications', null, 'A')).unread, before.unread - 1);
    await ok('POST', '/api/notifications/read', { id: before.items[1].id }, 'HEAD');
    assert.equal((await ok('GET', '/api/notifications', null, 'A')).unread, before.unread - 1);
    await ok('POST', '/api/notifications/read', {}, 'A');
    assert.equal((await ok('GET', '/api/notifications', null, 'A')).unread, 0);
    assert.equal((await request('GET', '/api/notifications', null, null)).status, 401);
  });
});
