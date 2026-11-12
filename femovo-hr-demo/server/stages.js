// The recruitment stages and the rules for moving between them.
// client/src/utils/stages.js holds the same list for the screens; tests/stages.test.js keeps them equal.
import { invalid } from './domain.js';

// The five columns of the board, in order.
export const STAGES = ['New', 'Screening', 'HR L1', 'Head HR Round', 'CEO Approval'];
export const FIRST_STAGE = 'New';
export const HEAD_HR_STAGE = 'Head HR Round';
export const CEO_STAGE = 'CEO Approval';
// Off the board: approved candidates wait for an offer, rejected ones are archived.
export const APPROVED_STAGE = 'Approved';
export const REJECTED_STAGE = 'Rejected';
export const ALL_STAGES = [...STAGES, APPROVED_STAGE, REJECTED_STAGE];
export const INTERVIEW_STAGES = ['Screening', 'HR L1', 'Head HR Round'];

export const INTERVIEW_TYPES = ['screening', 'hr_l1', 'additional', 'head_hr', 'ceo'];
export const INTERVIEW_TYPE_FOR_STAGE = { New: 'screening', Screening: 'screening', 'HR L1': 'hr_l1', 'Head HR Round': 'head_hr', 'CEO Approval': 'ceo' };
export const OPEN_INTERVIEW_STATUSES = ['Scheduled', 'Rescheduled', 'Feedback Pending'];
export const POSITIVE_RECOMMENDATIONS = ['Hire', 'Strong Hire'];

// The permission a person needs to move a candidate out of each stage, forward or back, or to reject them there.
const FORWARD_PERMISSION = { New: 'screen_candidates', Screening: 'screen_candidates', 'HR L1': 'run_hr_l1', 'Head HR Round': 'recommend_to_ceo' };
const BACK_PERMISSION = { Screening: 'screen_candidates', 'HR L1': 'run_hr_l1', 'Head HR Round': 'run_head_hr_round', 'CEO Approval': 'recommend_to_ceo' };
const REJECT_PERMISSION = { New: 'screen_candidates', Screening: 'screen_candidates', 'HR L1': 'run_hr_l1', 'Head HR Round': 'run_head_hr_round', 'CEO Approval': 'final_approval', Approved: 'issue_offers' };

const hasText = value => typeof value === 'string' && value.trim() !== '';
const completed = (interviews, type) => interviews.filter(i => i.type === type && i.status === 'Completed');
const latest = list => [...list].sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0))[0];

// Required extra rounds must all be finished, and one must have been finished since the CEO asked for it.
export function extraRoundPending(row, interviews) {
  const extra = interviews.filter(i => i.type === 'additional' && i.status !== 'Cancelled');
  if (extra.some(i => i.required !== false && i.status !== 'Completed')) return true;
  if (row.extra_round_required && !extra.some(i => i.status === 'Completed')) return true;
  if (row.ceo_decision === 'interview_requested') {
    const since = new Date(row.ceo_decided_at || 0);
    return !extra.some(i => i.status === 'Completed' && new Date(i.completed_at || 0) >= since);
  }
  return false;
}

function requireEvidence(row, interviews) {
  if (row.stage === 'Screening' && completed(interviews, 'screening').length === 0) {
    throw invalid('Log the screening call before moving this candidate to HR L1.', 409);
  }
  if (row.stage === 'HR L1') {
    const scorecard = latest(completed(interviews, 'hr_l1'));
    if (!scorecard) throw invalid('Complete the HR L1 scorecard before forwarding this candidate.', 409);
    if (!POSITIVE_RECOMMENDATIONS.includes(scorecard.recommendation)) throw invalid('The HR L1 scorecard does not recommend this candidate, so they cannot be forwarded.', 409);
    if (extraRoundPending(row, interviews)) throw invalid('The additional interview must be completed before the Head HR round.', 409);
  }
  if (row.stage === HEAD_HR_STAGE) {
    if (completed(interviews, 'head_hr').length === 0) throw invalid('Complete the Head HR interview scorecard before recommending this candidate.', 409);
    if (extraRoundPending(row, interviews)) throw invalid('The additional interview must be completed before CEO approval.', 409);
  }
}

// Throws a 4xx error when this move is not allowed. A request that keeps the same stage is always fine.
// `can` holds the person's permissions and `interviews` the candidate's interview records.
export function checkStageMove(row, { stage, remarks, scorecard_notes, rejection_reason, interview_date }, { can = {}, interviews = [] } = {}) {
  if (stage === undefined || stage === row.stage) return;
  if (row.promoted_employee_id) throw invalid('This candidate is already onboarded, so the stage cannot change.', 409);
  const need = permission => { if (!can[permission]) throw invalid('You are not allowed to make this move.', 403); };

  if (stage === REJECTED_STAGE) {
    if (!hasText(rejection_reason)) throw invalid('A reason is required to reject a candidate.');
    need(REJECT_PERMISSION[row.stage]);
    return;
  }
  if (stage === APPROVED_STAGE) throw invalid('Only the CEO decision can approve a candidate.', 409);
  if (!STAGES.includes(stage)) throw invalid('That is not a valid stage.');

  const hasRemarks = hasText(remarks) || hasText(scorecard_notes);
  if (row.stage === REJECTED_STAGE) {
    if (stage !== FIRST_STAGE) throw invalid(`A rejected candidate can only be restored to ${FIRST_STAGE}.`, 409);
    if (!hasRemarks) throw invalid('Remarks are required to restore a candidate.');
    need('edit_candidates');
    return;
  }
  if (row.stage === APPROVED_STAGE) throw invalid('An approved candidate cannot be moved back to the board.', 409);

  const from = STAGES.indexOf(row.stage);
  const to = STAGES.indexOf(stage);
  if (Math.abs(to - from) !== 1) throw invalid('A candidate can move only one stage at a time.', 409);

  if (to > from) {
    need(FORWARD_PERMISSION[row.stage]);
    requireEvidence(row, interviews);
  } else {
    need(BACK_PERMISSION[row.stage]);
  }

  // Booking the first interview moves a new candidate to Screening, and the date is the record of why.
  const isFirstBooking = row.stage === FIRST_STAGE && Boolean(interview_date);
  if (!hasRemarks && !isFirstBooking) throw invalid('Remarks are required to move a candidate to another stage.');
}
