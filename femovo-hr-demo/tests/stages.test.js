import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-the-stage-rules';
const server = await import('../server/stages.js');
const client = await import('../client/src/utils/stages.js');
const { defaultPermissions } = await import('../server/ats-permissions.js');
const { checkStageMove } = server;

const NOTE = { remarks: 'Spoke with the candidate' };
const ALL = Object.fromEntries(Object.keys(defaultPermissions('ceo')).map(key => [key, true]));
const interview = (type, extra = {}) => ({ type, status: 'Completed', recommendation: 'Hire', required: true, completed_at: '2026-11-05T10:00:00Z', ...extra });
const READY = [interview('screening'), interview('hr_l1'), interview('head_hr')];
const statusOf = (row, body, context = { can: ALL, interviews: READY }) => {
  try { checkStageMove(row, body, context); return 'allowed'; } catch (err) { return err.status; }
};

test('the screens and the server use the same stages', () => {
  for (const name of ['STAGES', 'FIRST_STAGE', 'HEAD_HR_STAGE', 'CEO_STAGE', 'APPROVED_STAGE', 'REJECTED_STAGE', 'INTERVIEW_STAGES', 'INTERVIEW_TYPE_FOR_STAGE', 'OPEN_INTERVIEW_STATUSES']) {
    assert.deepEqual(client[name], server[name], name);
  }
  assert.deepEqual(server.STAGES, ['New', 'Screening', 'HR L1', 'Head HR Round', 'CEO Approval']);
});

test('every board stage except CEO Approval has one next step', () => {
  for (const stage of client.STAGES.slice(0, -1)) {
    assert.ok(client.nextStage(stage), stage);
    assert.ok(client.NEXT_ACTION[stage], stage);
  }
  assert.equal(client.nextStage('CEO Approval'), null);
  assert.equal(client.NEXT_ACTION['CEO Approval'], undefined);
  assert.equal(client.previousStage('New'), null);
  assert.equal(client.nextStage('Approved'), null);
});

test('a candidate moves one step forward or back, with remarks', () => {
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'HR L1', ...NOTE }), 'allowed');
  assert.equal(statusOf({ stage: 'HR L1' }, { stage: 'Screening', ...NOTE }), 'allowed');
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'HR L1', scorecard_notes: '[HIRE] solid' }), 'allowed');
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'HR L1' }), 400);
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'HR L1', remarks: '   ' }), 400);
});

test('stages cannot be skipped in either direction', () => {
  assert.equal(statusOf({ stage: 'New' }, { stage: 'HR L1', ...NOTE }), 409);
  assert.equal(statusOf({ stage: 'New' }, { stage: 'CEO Approval', ...NOTE }), 409);
  assert.equal(statusOf({ stage: 'Head HR Round' }, { stage: 'New', ...NOTE }), 409);
});

test('only booking the first interview can skip remarks', () => {
  const interview_date = '2026-11-20T10:00:00Z';
  assert.equal(statusOf({ stage: 'New' }, { stage: 'Screening', interview_date }), 'allowed');
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'HR L1', interview_date }), 400);
});

test('each forward move needs the interview for that stage', () => {
  const none = { can: ALL, interviews: [] };
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'HR L1', ...NOTE }, none), 409);
  assert.equal(statusOf({ stage: 'HR L1' }, { stage: 'Head HR Round', ...NOTE }, none), 409);
  assert.equal(statusOf({ stage: 'Head HR Round' }, { stage: 'CEO Approval', ...NOTE }, none), 409);
  assert.equal(statusOf({ stage: 'New' }, { stage: 'Screening', ...NOTE }, none), 'allowed');
  // A booked interview is not enough; it must be completed.
  const booked = { can: ALL, interviews: [interview('screening', { status: 'Scheduled' })] };
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'HR L1', ...NOTE }, booked), 409);
});

test('HR L1 must recommend the candidate before they are forwarded', () => {
  for (const recommendation of ['Reject', 'Another review', null]) {
    const context = { can: ALL, interviews: [interview('hr_l1', { recommendation })] };
    assert.equal(statusOf({ stage: 'HR L1' }, { stage: 'Head HR Round', ...NOTE }, context), 409, String(recommendation));
  }
  // The latest scorecard decides.
  const improved = { can: ALL, interviews: [interview('hr_l1', { recommendation: 'Reject', completed_at: '2026-11-01T10:00:00Z' }), interview('hr_l1', { recommendation: 'Strong Hire', completed_at: '2026-11-03T10:00:00Z' })] };
  assert.equal(statusOf({ stage: 'HR L1' }, { stage: 'Head HR Round', ...NOTE }, improved), 'allowed');
});

test('a required additional interview blocks the next round until it is completed', () => {
  const row = { stage: 'HR L1', extra_round_required: true };
  const withExtra = status => ({ can: ALL, interviews: [interview('hr_l1'), interview('additional', { status })] });
  assert.equal(statusOf(row, { stage: 'Head HR Round', ...NOTE }, { can: ALL, interviews: [interview('hr_l1')] }), 409);
  assert.equal(statusOf(row, { stage: 'Head HR Round', ...NOTE }, withExtra('Scheduled')), 409);
  assert.equal(statusOf(row, { stage: 'Head HR Round', ...NOTE }, withExtra('Completed')), 'allowed');
  // An optional extra round does not block.
  const optional = { can: ALL, interviews: [interview('hr_l1'), interview('additional', { status: 'Scheduled', required: false })] };
  assert.equal(statusOf({ stage: 'HR L1' }, { stage: 'Head HR Round', ...NOTE }, optional), 'allowed');
});

test('an interview the CEO asked for must be completed after the request', () => {
  const row = { stage: 'Head HR Round', ceo_decision: 'interview_requested', ceo_decided_at: '2026-11-10T10:00:00Z' };
  const older = { can: ALL, interviews: [interview('head_hr'), interview('additional', { completed_at: '2026-11-08T10:00:00Z' })] };
  const newer = { can: ALL, interviews: [interview('head_hr'), interview('additional', { completed_at: '2026-11-12T10:00:00Z' })] };
  assert.equal(statusOf(row, { stage: 'CEO Approval', ...NOTE }, older), 409);
  assert.equal(statusOf(row, { stage: 'CEO Approval', ...NOTE }, newer), 'allowed');
});

test('approval is not a board move, and approved candidates do not return to the board', () => {
  assert.equal(statusOf({ stage: 'CEO Approval' }, { stage: 'Approved', ...NOTE }), 409);
  assert.equal(statusOf({ stage: 'Approved' }, { stage: 'CEO Approval', ...NOTE }), 409);
  assert.equal(statusOf({ stage: 'Head HR Round' }, { stage: 'Selected', ...NOTE }), 400);
});

test('each role can move candidates only where it works', () => {
  const as = role => ({ can: defaultPermissions(role), interviews: READY });
  // HR Assistant: up to forwarding for the Head HR round.
  assert.equal(statusOf({ stage: 'New' }, { stage: 'Screening', ...NOTE }, as('rec_associate')), 'allowed');
  assert.equal(statusOf({ stage: 'HR L1' }, { stage: 'Head HR Round', ...NOTE }, as('rec_associate')), 'allowed');
  assert.equal(statusOf({ stage: 'Head HR Round' }, { stage: 'CEO Approval', ...NOTE }, as('rec_associate')), 403);
  assert.equal(statusOf({ stage: 'Head HR Round' }, { stage: 'Rejected', rejection_reason: 'No' }, as('rec_associate')), 403);
  // Head HR: recommends, but does not decide at the CEO step.
  assert.equal(statusOf({ stage: 'Head HR Round' }, { stage: 'CEO Approval', ...NOTE }, as('rec_lead')), 'allowed');
  assert.equal(statusOf({ stage: 'CEO Approval' }, { stage: 'Rejected', rejection_reason: 'No' }, as('rec_lead')), 403);
  assert.equal(statusOf({ stage: 'CEO Approval' }, { stage: 'Rejected', rejection_reason: 'No' }, as('ceo')), 'allowed');
  // Interviewer: no moves at all.
  assert.equal(statusOf({ stage: 'New' }, { stage: 'Screening', ...NOTE }, as('hiring_manager')), 403);
  assert.equal(statusOf({ stage: 'HR L1' }, { stage: 'Rejected', rejection_reason: 'No' }, as('hiring_manager')), 403);
});

test('rejecting works from any stage but needs a reason', () => {
  for (const stage of [...server.STAGES, 'Approved']) {
    assert.equal(statusOf({ stage }, { stage: 'Rejected', rejection_reason: 'Skill gap' }), 'allowed', stage);
    assert.equal(statusOf({ stage }, { stage: 'Rejected' }), 400, stage);
  }
});

test('a rejected candidate can only be restored to New, with remarks', () => {
  assert.equal(statusOf({ stage: 'Rejected' }, { stage: 'New', ...NOTE }), 'allowed');
  assert.equal(statusOf({ stage: 'Rejected' }, { stage: 'New' }), 400);
  assert.equal(statusOf({ stage: 'Rejected' }, { stage: 'Head HR Round', ...NOTE }), 409);
});

test('removed stage names and onboarded candidates are refused', () => {
  assert.equal(statusOf({ stage: 'Head HR Round' }, { stage: 'Confirm to Select but Final status pending', ...NOTE }), 400);
  assert.equal(statusOf({ stage: 'Approved', promoted_employee_id: 'FEM-9' }, { stage: 'Rejected', rejection_reason: 'x' }), 409);
});

test('saving other details without moving the candidate is always allowed', () => {
  assert.equal(statusOf({ stage: 'Screening' }, {}, { can: {}, interviews: [] }), 'allowed');
  assert.equal(statusOf({ stage: 'Screening' }, { stage: 'Screening' }, { can: {}, interviews: [] }), 'allowed');
});

test('the screens explain a blocked move the same way the server decides it', () => {
  for (const [row, interviews] of [
    [{ stage: 'Screening' }, []],
    [{ stage: 'HR L1' }, [interview('hr_l1', { recommendation: 'Reject' })]],
    [{ stage: 'HR L1', extra_round_required: true }, [interview('hr_l1')]],
    [{ stage: 'Head HR Round' }, []],
    [{ stage: 'HR L1' }, [interview('hr_l1')]],
    [{ stage: 'Head HR Round' }, [interview('head_hr')]]
  ]) {
    const blocked = statusOf(row, { stage: client.nextStage(row.stage), ...NOTE }, { can: ALL, interviews }) !== 'allowed';
    assert.equal(Boolean(client.blockedReason(row, interviews)), blocked, JSON.stringify(row));
  }
});

test('migrations rename every old stage and keep the waiting time', () => {
  const read = name => fs.readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8');
  const first = read('015_simple_stages.sql');
  for (const old of ['Application', 'Screening round (Telephonic call)', 'HR Round', 'HR L1 Round (taken by HR assistance)', 'Department Round', 'Selected to HR Round', 'Selected from HR L1', 'Confirm to Select but Final status pending', 'Final decision/result']) {
    assert.ok(first.includes(`WHEN '${old}' THEN`), old);
  }
  const second = read('016_recruitment_workflow.sql');
  assert.ok(second.includes("WHEN 'HR Round' THEN 'Head HR Round'") && second.includes("WHEN 'Selected' THEN 'Approved'"));
  for (const sql of [first, second]) {
    assert.match(sql, /DISABLE TRIGGER applicant_stage_time[\s\S]*UPDATE applicants SET stage[\s\S]*ENABLE TRIGGER applicant_stage_time/);
  }
});
