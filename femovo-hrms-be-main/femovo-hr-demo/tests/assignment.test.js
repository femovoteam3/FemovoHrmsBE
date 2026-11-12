import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-the-assignment-rules';
const { pickOwner } = await import('../server/assignment.js');
const { ATS_ACTIONS, ATS_MODULES, defaultPermissions, moduleOfAction, roleRank } = await import('../server/ats-permissions.js');

const assistant = (id, load = 0) => ({ id, name: `Assistant ${id}`, ats_role: 'rec_associate', load });
const TEAM = [assistant('A', 5), assistant('B', 1), assistant('C', 3), { id: 'HEAD', name: 'Head', ats_role: 'rec_lead', load: 0 }];
const job = (extra = {}) => ({ id: 10, role: 'Graphic Designer', department: 'Marketing', ...extra });
const rule = (recruiter_id, kind, value, is_primary = false) => ({ recruiter_id, kind, is_primary, job_id: kind === 'job' ? value : null, target: kind === 'job' ? null : value });
const owner = (...args) => pickOwner(...args)?.id ?? null;

test('the job owner wins, then job, role and department assignments in that order', () => {
  const rules = [rule('A', 'department', 'Marketing'), rule('B', 'role', 'Graphic Designer'), rule('C', 'job', 10)];
  assert.equal(owner(job({ assigned_recruiter_id: 'A' }), TEAM, rules), 'A');
  assert.equal(owner(job(), TEAM, rules), 'C');
  assert.equal(owner(job(), TEAM, rules.slice(0, 2)), 'B');
  assert.equal(owner(job(), TEAM, rules.slice(0, 1)), 'A');
});

test('role and department names match whatever the letter case or spacing', () => {
  assert.equal(owner(job({ role: ' graphic designer ' }), TEAM, [rule('B', 'role', 'Graphic Designer')]), 'B');
  assert.equal(owner(job({ department: 'MARKETING' }), TEAM, [rule('A', 'department', 'marketing')]), 'A');
  assert.equal(owner(job({ department: 'Marketing Operations' }), TEAM, [rule('A', 'department', 'Marketing')]), null);
});

test('with several eligible assistants the primary wins, then the lightest workload', () => {
  const two = [rule('A', 'department', 'Marketing'), rule('B', 'department', 'Marketing'), rule('C', 'department', 'Marketing')];
  assert.equal(owner(job(), TEAM, two), 'B');
  assert.equal(owner(job(), TEAM, [rule('A', 'department', 'Marketing', true), ...two.slice(1)]), 'A');
});

test('an inactive owner falls back to the backup, and nobody eligible means unassigned', () => {
  const active = TEAM.filter(person => person.id !== 'A');
  assert.equal(owner(job({ assigned_recruiter_id: 'A', backup_recruiter_id: 'B' }), active, []), 'B');
  assert.equal(owner(job({ assigned_recruiter_id: 'A' }), active, [rule('A', 'department', 'Marketing')]), null);
  assert.equal(owner(job(), TEAM, []), null);
  assert.equal(owner(job(), TEAM, [rule('B', 'department', 'Finance')]), null);
});

test('assignment rules route candidates only to HR Assistants', () => {
  assert.equal(owner(job(), TEAM, [rule('HEAD', 'department', 'Marketing')]), null);
  // A person named on the job itself may hold any role.
  assert.equal(owner(job({ assigned_recruiter_id: 'HEAD' }), TEAM, []), 'HEAD');
});

test('a candidate without a job record still follows role and department rules', () => {
  assert.equal(owner({ id: null, role: 'Trainer', department: 'Finance' }, TEAM, [rule('C', 'job', 10), rule('A', 'department', 'Finance')]), 'A');
});

test('every permission belongs to one module and has a default for every role', () => {
  assert.equal(new Set(ATS_ACTIONS).size, ATS_ACTIONS.length);
  assert.equal(ATS_ACTIONS.length, ATS_MODULES.reduce((sum, module) => sum + module.actions.length, 0));
  for (const action of ATS_ACTIONS) assert.ok(moduleOfAction(action), action);
  for (const role of ['ceo', 'rec_lead', 'rec_associate', 'hiring_manager', 'employee', null]) {
    assert.deepEqual(Object.keys(defaultPermissions(role)).sort(), [...ATS_ACTIONS].sort(), String(role));
  }
});

test('default permissions follow the access matrix', () => {
  const ceo = defaultPermissions('ceo');
  const head = defaultPermissions('rec_lead');
  const assistant = defaultPermissions('rec_associate');
  const interviewer = defaultPermissions('hiring_manager');

  assert.ok(ceo.final_approval && ceo.view_all_candidates && ceo.manage_ats_users && ceo.configure_permissions);
  assert.ok(!ceo.issue_offers && !ceo.onboard_to_ems);
  assert.ok(head.recommend_to_ceo && head.issue_offers && head.onboard_to_ems && head.create_jobs && head.assign_recruiters && head.view_all_candidates);
  assert.ok(!head.final_approval && !head.configure_permissions);
  assert.ok(assistant.screen_candidates && assistant.run_hr_l1 && assistant.edit_candidates);
  for (const action of ['view_all_candidates', 'assign_candidates', 'run_head_hr_round', 'recommend_to_ceo', 'final_approval', 'issue_offers', 'create_jobs', 'manage_ats_users', 'export_candidates', 'delete_candidates']) {
    assert.equal(assistant[action], false, action);
  }
  assert.deepEqual(Object.keys(interviewer).filter(action => interviewer[action]).sort(), ['run_additional_interview', 'submit_feedback', 'view_candidates']);
  assert.ok(Object.values(defaultPermissions('employee')).every(value => value === false));
});

test('roles rank so nobody manages a person at their own level or above', () => {
  assert.ok(roleRank('ceo') > roleRank('rec_lead'));
  assert.ok(roleRank('rec_lead') > roleRank('rec_associate'));
  assert.equal(roleRank('rec_associate'), roleRank('hiring_manager'));
  assert.equal(roleRank('exec_sponsor'), roleRank('ceo'));
  assert.equal(roleRank('employee'), 0);
});

const { validateApplication } = await import('../server/domain.js');
const FORM = { name: ' Asha Rao ', job: 'Accountant', email: 'Asha@Example.test', phone: '+91 98220 12345' };
const refuses = (input, options) => { try { validateApplication(input, options); return false; } catch (err) { return err.status === 400; } };

test('a public application is cleaned and blank answers stay blank', () => {
  const clean = validateApplication({ ...FORM, expected_ctc: '', notice_period: '  ', qualification: 'B.Com', portfolio_url: 'https://example.test/asha' }, { isPublic: true });
  assert.deepEqual([clean.name, clean.email, clean.phone, clean.qualification, clean.portfolio_url], ['Asha Rao', 'asha@example.test', '+91 98220 12345', 'B.Com', 'https://example.test/asha']);
  for (const field of ['expected_ctc', 'current_ctc', 'notice_period', 'experience', 'current_location']) assert.equal(clean[field], null, field);
});

test('a public application needs a real email and mobile number', () => {
  for (const bad of [{ name: '' }, { job: ' ' }, { email: 'asha' }, { phone: '' }, { phone: '12345' }, { phone: 'call me' }, { portfolio_url: 'javascript:alert(1)' }, { name: 'x'.repeat(101) }, { qualification: 'x'.repeat(151) }, { experience: 5 }]) {
    assert.ok(refuses({ ...FORM, ...bad }, { isPublic: true }), JSON.stringify(bad).slice(0, 60));
  }
  // Staff may add a candidate before they have a phone number.
  assert.equal(validateApplication({ ...FORM, phone: undefined }).phone, null);
  assert.ok(refuses({ ...FORM, email: 'nope' }));
});
