// Shared recruitment workflow steps: history, notifications, interviews and stage changes.
import { pool } from './db.js';
import { invalid } from './domain.js';
import { actorIds } from './auth.js';
import { APPROVED_STAGE, CEO_STAGE, HEAD_HR_STAGE, OPEN_INTERVIEW_STATUSES, REJECTED_STAGE, STAGES, extraRoundPending } from './stages.js';

export const INTERVIEW_LABEL = { screening: 'Screening call', hr_l1: 'HR L1 interview', additional: 'Additional interview', head_hr: 'Head HR interview', ceo: 'CEO interview' };
export const RECOMMENDATIONS = ['Strong Hire', 'Hire', 'Another review', 'Reject'];
// The permission needed to arrange each kind of interview, and to record it without being the named interviewer.
const SCHEDULE_PERMISSION = { screening: 'screen_candidates', hr_l1: 'run_hr_l1', additional: 'request_additional_interview', head_hr: 'run_head_hr_round', ceo: 'final_approval' };
const TYPE_STAGES = { screening: ['New', 'Screening'], hr_l1: ['HR L1'], additional: ['HR L1', HEAD_HR_STAGE], head_hr: [HEAD_HR_STAGE], ceo: [CEO_STAGE] };

const forbidden = message => invalid(message, 403);
const isMine = (interview, user) => Boolean(interview.interviewer_id) && actorIds(user).includes(interview.interviewer_id);
const whenText = value => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export async function recordEvent(applicantId, kind, { from = null, to = null, remarks = null } = {}, user = null) {
  await pool.query(
    'INSERT INTO candidate_events (applicant_id, kind, from_value, to_value, actor_id, actor_name, remarks) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [applicantId, kind, from, to, actorIds(user)[0] || null, user?.name || 'Public applicant', remarks]
  );
}

// In-app notifications. The person who did the action is not told about their own action.
export async function notify(employeeIds, { type, title, body = null, route = null, applicantId = null }, actor = null) {
  const skip = new Set(actorIds(actor));
  const targets = [...new Set(employeeIds.filter(Boolean))].filter(id => !skip.has(id));
  for (const id of targets) {
    await pool.query('INSERT INTO notifications (employee_id, type, title, body, route, applicant_id) VALUES ($1, $2, $3, $4, $5, $6)', [id, type, title.slice(0, 200), body, route, applicantId]);
  }
}

// The accounts that act as Head HR or CEO. With no CEO login yet, Super Admin stands in.
export async function accountIds(group) {
  if (group === 'head_hr') {
    const found = await pool.query("SELECT employee_id FROM user_accounts WHERE status = 'Active' AND (ats_role = 'rec_lead' OR is_head_hr IS TRUE OR (role = 'hr' AND ats_role IS NULL))");
    return found.rows.map(row => row.employee_id);
  }
  const ceo = await pool.query("SELECT employee_id FROM user_accounts WHERE status = 'Active' AND ats_role = 'ceo'");
  if (ceo.rowCount > 0) return ceo.rows.map(row => row.employee_id);
  const admins = await pool.query("SELECT employee_id FROM user_accounts WHERE status = 'Active' AND role = 'super_admin'");
  return admins.rows.map(row => row.employee_id);
}

export async function activeRecruiter(id) {
  if (!id) return null;
  const found = await pool.query("SELECT id, name, department, role_title, ats_role FROM recruitment_team WHERE id = $1 AND status = 'Active' AND has_ats_access IS NOT FALSE", [id]);
  return found.rows[0] || null;
}

async function activeAccount(id) {
  const found = await pool.query("SELECT employee_id, recruiter_id, name FROM user_accounts WHERE status = 'Active' AND (employee_id = $1 OR recruiter_id = $1) LIMIT 1", [id]);
  return found.rows[0] || null;
}

export async function loadInterviews(applicantId) {
  return (await pool.query('SELECT * FROM interviews WHERE applicant_id = $1 ORDER BY created_at, id', [applicantId])).rows;
}

// The single interview shown on a candidate follows their open interview, or the latest one when none is open.
export async function syncInterviewMirror(applicantId) {
  await pool.query(`
    UPDATE applicants SET interview_date = latest.scheduled_at, interviewer = latest.interviewer_name, interviewer_id = latest.interviewer_id, meet_link = latest.meeting_url
    FROM (SELECT $1::int AS applicant_id) target
    LEFT JOIN LATERAL (
      SELECT scheduled_at, interviewer_name, interviewer_id, meeting_url FROM interviews
      WHERE applicant_id = $1 AND status <> 'Cancelled'
      ORDER BY (status IN ('Scheduled', 'Rescheduled', 'Feedback Pending')) DESC, scheduled_at DESC NULLS LAST, id DESC LIMIT 1
    ) latest ON TRUE
    WHERE applicants.id = target.applicant_id`, [applicantId]);
}

// History and notifications after a candidate changed stage.
export async function afterStageChange(before, toStage, user, remarks) {
  await recordEvent(before.id, 'stage', { from: before.stage, to: toStage, remarks }, user);
  const who = user?.name || 'Someone';
  const owner = [before.assigned_recruiter_id];
  const wentBack = STAGES.indexOf(toStage) !== -1 && STAGES.indexOf(toStage) < STAGES.indexOf(before.stage);
  const base = { applicantId: before.id, body: remarks || null };

  if (toStage === HEAD_HR_STAGE && !wentBack) {
    await notify(await accountIds('head_hr'), { ...base, type: 'forwarded_head_hr', title: `${before.name} was forwarded for the Head HR round by ${who}`, route: 'hr-approval' }, user);
  } else if (toStage === CEO_STAGE) {
    await notify(await accountIds('ceo'), { ...base, type: 'ceo_approval', title: `${before.name} is waiting for your approval (recommended by ${who})`, route: 'ceo-approvals' }, user);
  } else if (toStage === APPROVED_STAGE) {
    await notify([...await accountIds('head_hr'), ...owner], { ...base, type: 'ceo_approved', title: `${before.name} was approved by ${who} and is ready for an offer`, route: 'ats-offers' }, user);
  } else if (toStage === REJECTED_STAGE) {
    await notify([...owner, ...(before.stage === CEO_STAGE ? await accountIds('head_hr') : [])], { ...base, type: 'rejected', title: `${before.name} was rejected by ${who}`, route: 'ats-pool' }, user);
  } else if (wentBack) {
    await notify([...owner, ...(toStage === HEAD_HR_STAGE ? await accountIds('head_hr') : [])], { ...base, type: 'sent_back', title: `${before.name} was sent back to ${toStage} by ${who}`, route: toStage === HEAD_HR_STAGE ? 'hr-approval' : 'hiring' }, user);
  }
}

// Books an interview, or moves the open one of the same kind to a new time. Earlier times stay in the history.
export async function scheduleInterview(row, { type, interviewerId, scheduledAt, meetingUrl, platform, required = true, target = null }, user, perms) {
  if (!INTERVIEW_LABEL[type]) throw invalid('Choose a valid interview type.');
  if (row.promoted_employee_id || [APPROVED_STAGE, REJECTED_STAGE].includes(row.stage)) throw invalid('Interviews cannot be booked for this candidate any more.', 409);
  const when = scheduledAt ? new Date(scheduledAt) : null;
  if (when && Number.isNaN(when.valueOf())) throw invalid('Use a valid interview date and time.');
  if (meetingUrl != null && meetingUrl !== '' && !/^https:\/\/\S+$/i.test(meetingUrl)) throw invalid('The meeting link must start with https://');

  const existing = (await loadInterviews(row.id)).filter(i => i.type === type && OPEN_INTERVIEW_STATUSES.includes(i.status));
  const mine = target ? (isMine(target, user) ? target : null) : existing.find(i => isMine(i, user));
  const canArrange = perms[SCHEDULE_PERMISSION[type]] === true;
  // The named interviewer may move their own slot; anything else needs the permission for that round.
  if (!canArrange && !(mine && !interviewerId)) throw forbidden(`You are not allowed to schedule a ${INTERVIEW_LABEL[type].toLowerCase()}.`);

  let interviewer = null;
  if (interviewerId) {
    interviewer = await activeAccount(interviewerId);
    if (!interviewer) throw invalid('Choose an active person as the interviewer.');
  }
  const current = target || (canArrange ? (type === 'additional' ? existing.find(i => i.interviewer_id === interviewer?.employee_id) : existing[0]) : mine);

  if (current) {
    const timeChanged = when && (!current.scheduled_at || new Date(current.scheduled_at).getTime() !== when.getTime());
    const updated = await pool.query(`
      UPDATE interviews SET scheduled_at = COALESCE($1, scheduled_at), meeting_url = $2, platform = COALESCE($3, platform),
        interviewer_id = COALESCE($4, interviewer_id), interviewer_name = COALESCE($5, interviewer_name), status = $6, updated_at = NOW()
      WHERE id = $7 RETURNING *`,
      [when, meetingUrl === undefined ? current.meeting_url : (meetingUrl || null), platform || null, interviewer?.employee_id || null, interviewer?.name || null, timeChanged && current.scheduled_at ? 'Rescheduled' : current.status, current.id]);
    if (timeChanged) {
      await recordEvent(row.id, 'interview', { from: current.scheduled_at ? whenText(current.scheduled_at) : null, to: whenText(when), remarks: `${INTERVIEW_LABEL[type]} ${current.scheduled_at ? 'rescheduled' : 'scheduled'}` }, user);
      await notify([current.interviewer_id, interviewer?.employee_id, row.assigned_recruiter_id], { type: 'interview_rescheduled', title: `${INTERVIEW_LABEL[type]} with ${row.name} is now on ${whenText(when)}`, route: 'ats-interviews', applicantId: row.id }, user);
    }
    await syncInterviewMirror(row.id);
    return updated.rows[0] || { ...current, scheduled_at: when || current.scheduled_at };
  }

  if (!TYPE_STAGES[type].includes(row.stage)) throw invalid(`A ${INTERVIEW_LABEL[type].toLowerCase()} cannot be booked while the candidate is in ${row.stage}.`, 409);
  // Screening and HR L1 belong to the candidate's HR Assistant unless someone else is named.
  if (!interviewer && type === 'additional') throw invalid('Choose who will take the additional interview.');
  if (!interviewer) {
    const ownerAccount = ['screening', 'hr_l1'].includes(type) && row.assigned_recruiter_id ? await activeAccount(row.assigned_recruiter_id) : null;
    interviewer = ownerAccount || { employee_id: actorIds(user)[0] || null, name: user.name };
  }
  const values = [row.id, type, interviewer.employee_id, interviewer.name, when, meetingUrl || null, platform || (type === 'screening' ? 'Phone' : 'Google Meet'), required !== false, user.name];
  const inserted = await pool.query(`
    INSERT INTO interviews (applicant_id, type, interviewer_id, interviewer_name, scheduled_at, meeting_url, platform, required, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, values);
  if (type === 'additional' && required !== false) await pool.query('UPDATE applicants SET extra_round_required = TRUE WHERE id = $1', [row.id]);
  await recordEvent(row.id, 'interview', { to: when ? whenText(when) : null, remarks: `${INTERVIEW_LABEL[type]} assigned to ${interviewer.name}` }, user);
  await notify([interviewer.employee_id], { type: 'interview_assigned', title: `${INTERVIEW_LABEL[type]} assigned to you: ${row.name}${when ? ` on ${whenText(when)}` : ''}`, body: `${row.job}${row.department ? ` · ${row.department}` : ''}`, route: 'ats-interviews', applicantId: row.id }, user);
  await syncInterviewMirror(row.id);
  return inserted.rows[0] || { applicant_id: row.id, type, interviewer_id: interviewer.employee_id, interviewer_name: interviewer.name, scheduled_at: when, status: 'Scheduled', required: required !== false };
}

// Records the outcome of an interview. Only the named interviewer may fill their own scorecard.
// With no interview given, the open one for `type` is used, or a finished record is created for the person acting.
export async function completeInterview(row, { interview = null, type, rating, notes, recommendation, scorecard = {} }, user, perms) {
  if (!RECOMMENDATIONS.includes(recommendation)) throw invalid('Choose a recommendation for this interview.');
  if (typeof notes !== 'string' || !notes.trim()) throw invalid('Feedback notes are required.');
  const stars = rating == null || rating === '' ? null : Number(rating);
  if (stars !== null && (!Number.isInteger(stars) || stars < 1 || stars > 5)) throw invalid('Rating must be from 1 to 5.');
  if (!perms.submit_feedback) throw forbidden('You do not have permission to submit interview feedback.');

  let target = interview;
  if (!target) {
    const open = (await loadInterviews(row.id)).filter(i => OPEN_INTERVIEW_STATUSES.includes(i.status));
    target = open.find(i => isMine(i, user) && i.type === type) || open.find(i => isMine(i, user)) || open.find(i => i.type === type) || null;
  }
  const kind = target?.type || type;
  const mayRunRound = kind !== 'additional' && perms[SCHEDULE_PERMISSION[kind]] === true;
  if (target) {
    if (target.status === 'Completed' || target.status === 'Cancelled') throw invalid('This interview is already closed.', 409);
    const unassigned = !target.interviewer_id;
    if (!isMine(target, user) && user.role !== 'super_admin' && !(unassigned && mayRunRound)) throw forbidden('Only the assigned interviewer can submit this feedback.');
  } else if (!mayRunRound) {
    throw forbidden('No interview is assigned to you for this candidate.');
  }

  const me = { id: actorIds(user)[0] || null, name: user.name };
  const fields = [stars, JSON.stringify(scorecard || {}), notes.trim(), recommendation];
  const saved = target
    ? await pool.query(`UPDATE interviews SET status = 'Completed', rating = $1, scorecard = $2::jsonb, notes = $3, recommendation = $4, completed_at = NOW(), updated_at = NOW(),
        interviewer_id = COALESCE(interviewer_id, $5), interviewer_name = COALESCE(interviewer_name, $6) WHERE id = $7 RETURNING *`, [...fields, me.id, me.name, target.id])
    : await pool.query(`INSERT INTO interviews (applicant_id, type, interviewer_id, interviewer_name, scheduled_at, platform, status, rating, scorecard, notes, recommendation, created_by, completed_at)
        VALUES ($1, $2, $3, $4, NOW(), $5, 'Completed', $6, $7::jsonb, $8, $9, $10, NOW()) RETURNING *`, [row.id, kind, me.id, me.name, kind === 'screening' ? 'Phone' : 'Google Meet', ...fields, me.name]);
  const done = saved.rows[0] || { ...(target || { applicant_id: row.id, type: kind, interviewer_id: me.id, interviewer_name: me.name }), status: 'Completed', rating: stars, notes: notes.trim(), recommendation, completed_at: new Date().toISOString() };

  await pool.query('UPDATE applicants SET rating = COALESCE($1, rating), scorecard_notes = $2 WHERE id = $3', [stars, `[${recommendation.toUpperCase()}] ${notes.trim()}`, row.id]);
  await recordEvent(row.id, 'interview', { to: recommendation, remarks: `${INTERVIEW_LABEL[kind]} completed by ${done.interviewer_name || me.name}` }, user);
  const interested = [row.assigned_recruiter_id, ...(['additional', 'head_hr'].includes(kind) || row.stage === HEAD_HR_STAGE ? await accountIds('head_hr') : [])];
  await notify(interested, { type: 'interview_feedback', title: `${INTERVIEW_LABEL[kind]} feedback for ${row.name}: ${recommendation}`, route: kind === 'additional' ? 'hr-approval' : 'hiring', applicantId: row.id }, user);
  await syncInterviewMirror(row.id);
  return done;
}

// After the interview the CEO asked for is done, the candidate returns to the CEO queue by itself.
export async function returnToCeoIfReady(row, user) {
  if (row.stage !== HEAD_HR_STAGE || row.ceo_decision !== 'interview_requested') return false;
  if (extraRoundPending(row, await loadInterviews(row.id))) return false;
  await pool.query("UPDATE applicants SET stage = $1, ceo_decision = NULL WHERE id = $2", [CEO_STAGE, row.id]);
  await afterStageChange(row, CEO_STAGE, user, 'Returned to the CEO after the requested interview');
  return true;
}

// Head HR's recommendation sends the candidate to the CEO queue.
export async function recommendToCeo(row, { recommendation, monthlySalary }, user) {
  const text = String(recommendation || '').trim();
  const dated = `[${new Date().toISOString().slice(0, 10)}] ${text}`;
  const updated = await pool.query(`
    UPDATE applicants SET stage = $1, head_hr_recommendation = $2, head_hr_recommended_by = $3, head_hr_recommended_at = NOW(), ceo_decision = NULL,
      monthly_salary = COALESCE($4, monthly_salary), remarks = CASE WHEN COALESCE(remarks, '') = '' THEN $5 ELSE remarks || E'\n' || $5 END
    WHERE id = $6 RETURNING *`, [CEO_STAGE, text, user.name, monthlySalary || null, dated, row.id]);
  await recordEvent(row.id, 'recommendation', { to: 'Recommended to CEO', remarks: text }, user);
  await afterStageChange(row, CEO_STAGE, user, text);
  return updated.rows[0] || { ...row, stage: CEO_STAGE, head_hr_recommendation: text };
}
