import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWork, summarize, daysInStage } from '../client/src/utils/atsHome.js';

const { defaultPermissions } = await import('../server/ats-permissions.js');

const NOW = new Date('2026-11-09T12:00:00');
const hoursAgo = hours => new Date(NOW.getTime() - hours * 3600000).toISOString();
const inHours = hours => new Date(NOW.getTime() + hours * 3600000).toISOString();
const person = (id, stage, extra = {}) => ({ id, name: `C${id}`, stage, stage_changed_at: hoursAgo(24), assigned_recruiter_id: 'A', assigned_recruiter_name: 'Asha', ...extra });
const interview = (id, applicant_id, type, status, extra = {}) => ({ id, applicant_id, type, status, required: true, recommendation: status === 'Completed' ? 'Hire' : null, completed_at: status === 'Completed' ? hoursAgo(5) : null, ...extra });
const work = (role, people, interviews = [], mine = []) => buildWork(people, interviews, defaultPermissions(role), mine, NOW);
const labels = list => list.map(item => [item.candidate?.id ?? `i${item.interview.id}`, item.label || item.reason]);

const PEOPLE = [person(1, 'New'), person(2, 'Screening'), person(3, 'HR L1'), person(4, 'Head HR Round'), person(5, 'CEO Approval'), person(6, 'Approved')];
const DONE = [interview(1, 3, 'screening', 'Completed'), interview(2, 3, 'hr_l1', 'Completed'), interview(3, 4, 'head_hr', 'Completed')];

test('an HR Assistant sees their own stages as next steps and the rest as waiting', () => {
  const { todo, waiting } = work('rec_associate', PEOPLE, DONE, ['A']);
  assert.deepEqual(labels(todo).sort(), [[1, 'Start screening'], [2, 'Log screening call'], [3, 'Forward to Head HR']]);
  assert.deepEqual(labels(waiting).sort(), [[4, 'With Head HR'], [5, 'Waiting for the CEO'], [6, 'Approved by the CEO, no offer yet']]);
});

test('Head HR sees the Head HR round, offers and unassigned candidates, not the steps of the assistants', () => {
  const { todo, waiting } = work('rec_lead', [...PEOPLE, person(7, 'New', { assigned_recruiter_id: null, assigned_recruiter_name: null })], DONE, ['HEAD']);
  assert.deepEqual(labels(todo).sort(), [[4, 'Recommend to CEO'], [6, 'Open offers'], [7, 'Assign']]);
  assert.deepEqual(labels(waiting).sort(), [[1, 'With Asha'], [2, 'With Asha'], [3, 'With Asha'], [5, 'Waiting for the CEO']]);
  // A candidate Head HR owns personally is their step.
  assert.deepEqual(labels(work('rec_lead', [person(1, 'New', { assigned_recruiter_id: 'HEAD' })], [], ['HEAD']).todo), [[1, 'Start screening']]);
});

test('the CEO is asked to decide, and never to issue an offer', () => {
  const { todo, waiting } = work('ceo', PEOPLE, DONE, ['CEO']);
  assert.deepEqual(labels(todo), [[5, 'Decide']]);
  assert.equal(todo[0].page, 'ceo-approvals');
  assert.deepEqual(labels(waiting).map(([id]) => id).sort(), [1, 2, 3, 4, 6]);
  assert.equal(Object.fromEntries(labels(waiting))[4], 'With Head HR');
});

test('an interviewer sees only the interviews assigned to them', () => {
  const rounds = [interview(7, 3, 'additional', 'Scheduled', { interviewer_id: 'INT', scheduled_at: inHours(3), stage: 'HR L1' }), interview(8, 4, 'additional', 'Scheduled', { interviewer_id: 'OTHER', stage: 'Head HR Round' })];
  const { todo, waiting } = work('hiring_manager', [person(3, 'HR L1')], rounds, ['INT']);
  assert.deepEqual(labels(todo), [['i7', 'Submit feedback']]);
  assert.deepEqual(labels(waiting), [[3, 'With the HR Assistant']]);
});

test("an HR Assistant's own round is one step, not also a separate interview task", () => {
  const own = [interview(9, 3, 'screening', 'Completed'), interview(10, 3, 'hr_l1', 'Scheduled', { interviewer_id: 'A', stage: 'HR L1' })];
  assert.deepEqual(labels(work('rec_associate', [person(3, 'HR L1')], own, ['A']).todo), [[3, 'Fill HR L1 scorecard']]);
  // An extra round given to an assistant is their task even though they do not own the candidate.
  const lent = [interview(11, 4, 'additional', 'Scheduled', { interviewer_id: 'A', stage: 'Head HR Round' })];
  assert.deepEqual(labels(work('rec_associate', [], lent, ['A']).todo), [['i11', 'Submit feedback']]);
});

test('each stage shows the step that is really next', () => {
  const step = (stage, interviews) => { const { todo, waiting } = work('rec_lead', [person(3, stage, { assigned_recruiter_id: 'HEAD' })], interviews, ['HEAD']); return labels([...todo, ...waiting])[0][1]; };
  assert.equal(step('Screening', []), 'Log screening call');
  assert.equal(step('Screening', [interview(1, 3, 'screening', 'Completed')]), 'Move to HR L1');
  assert.equal(step('HR L1', []), 'Schedule HR L1 interview');
  assert.equal(step('HR L1', [interview(1, 3, 'hr_l1', 'Scheduled')]), 'Fill HR L1 scorecard');
  assert.equal(step('HR L1', [interview(1, 3, 'hr_l1', 'Completed', { recommendation: 'Reject' })]), 'The HR L1 scorecard does not recommend this candidate');
  assert.equal(step('HR L1', [interview(1, 3, 'hr_l1', 'Completed'), interview(2, 3, 'additional', 'Scheduled')]), 'Waiting for the additional interview');
  assert.equal(step('Head HR Round', []), 'Schedule Head HR interview');
  assert.equal(step('Head HR Round', [interview(1, 3, 'head_hr', 'Completed')]), 'Recommend to CEO');
});

test('rejected and onboarded people need no action; interviews come first, then the longest wait', () => {
  assert.deepEqual(work('rec_lead', [person(1, 'Rejected'), person(2, 'Approved', { promoted_employee_id: 'FEM-1' })]).todo, []);
  const people = [person(1, 'New', { stage_changed_at: hoursAgo(10), assigned_recruiter_id: 'H' }), person(2, 'New', { stage_changed_at: hoursAgo(24 * 9), assigned_recruiter_id: 'H' })];
  const mine = [interview(5, 9, 'additional', 'Scheduled', { interviewer_id: 'H', scheduled_at: inHours(30), stage: 'HR L1' }), interview(6, 9, 'additional', 'Scheduled', { interviewer_id: 'H', scheduled_at: inHours(2), stage: 'HR L1' })];
  assert.deepEqual(work('rec_lead', people, mine, ['H']).todo.map(item => item.key), ['i6', 'i5', 'c2', 'c1']);
  assert.equal(daysInStage({ stage_changed_at: hoursAgo(24 * 8) }, NOW), 8);
});

test('headline numbers count active candidates, upcoming interviews and open positions', () => {
  const people = [person(1, 'New'), person(2, 'New', { stage_changed_at: hoursAgo(24 * 8) }), person(3, 'Approved'), person(4, 'Approved', { promoted_employee_id: 'FEM-1' }), person(5, 'Rejected'), person(6, 'Screening', { assigned_recruiter_id: null })];
  const jobs = [{ status: 'Active', openings: 3, filled: 1, assigned_recruiter_id: 'A' }, { status: 'Hidden', openings: 5, filled: 0 }, { status: 'Active', openings: 2, filled: 2 }];
  const rounds = [interview(1, 1, 'screening', 'Scheduled', { scheduled_at: inHours(24) }), interview(2, 2, 'screening', 'Scheduled', { scheduled_at: inHours(24 * 9) }), interview(3, 5, 'hr_l1', 'Scheduled', { scheduled_at: inHours(5) }), interview(4, 6, 'screening', 'Cancelled', { scheduled_at: inHours(5) })];
  const summary = summarize(people, jobs, [{ id: 'A', name: 'Asha', department: 'Sales' }], NOW, rounds);
  assert.equal(summary.newApplications, 2);
  assert.equal(summary.readyForOffer, 1);
  assert.equal(summary.interviewsThisWeek, 1);
  assert.equal(summary.openPositions, 2);
  assert.equal(summary.openJobs, 1);
  assert.equal(summary.stuck, 1);
  assert.equal(summary.unassigned, 1);
  assert.deepEqual(summary.team, [{ id: 'A', name: 'Asha', department: 'Sales', openings: 2, candidates: 3, interviews: 1 }]);
  assert.deepEqual(summary.pipeline.map(stage => [stage.label, stage.count]), [['New', 2], ['Screening', 1], ['HR L1', 0], ['Head HR Round', 0], ['CEO Approval', 0], ['Ready for offer', 1]]);
});
