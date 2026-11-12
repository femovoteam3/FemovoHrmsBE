// Recruitment workflow API: interviews, Head HR recommendation, CEO decision, offers,
// notifications, work queues and HR Assistant assignments.
import { pool } from './db.js';
import { invalid, paise, parseDate, rupees } from './domain.js';
import { actorIds, buildCandidateScopeFilter, checkCandidateAccess, getUserEffectivePermissions, redactApplicant } from './auth.js';
import { APPROVED_STAGE, CEO_STAGE, HEAD_HR_STAGE, OPEN_INTERVIEW_STATUSES, REJECTED_STAGE, STAGES, checkStageMove } from './stages.js';
import { INTERVIEW_LABEL, accountIds, activeRecruiter, afterStageChange, completeInterview, loadInterviews, notify, recommendToCeo, recordEvent, returnToCeoIfReady, scheduleInterview, syncInterviewMirror } from './workflow.js';

const OFFER_MOVES = { Draft: ['Issued', 'Withdrawn'], Issued: ['Accepted', 'Declined', 'Withdrawn'], Accepted: ['Withdrawn'], Declined: [], Withdrawn: [] };
const CEO_DECISIONS = ['approved', 'rejected', 'sent_back', 'interview_requested'];

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });
const forbidden = message => invalid(message, 403);
const hasText = value => typeof value === 'string' && value.trim() !== '';
const cleanList = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))];

async function lockedApplicant(id) {
  if (!/^\d+$/.test(String(id))) throw invalid('Candidate not found.', 404);
  const found = await pool.query('SELECT * FROM applicants WHERE id = $1 FOR UPDATE', [id]);
  if (found.rowCount === 0) throw invalid('Candidate not found.', 404);
  return found.rows[0];
}
const freshApplicant = async id => (await pool.query('SELECT * FROM applicants WHERE id = $1', [id])).rows[0];

async function requireAccess(user, row, action) {
  const access = await checkCandidateAccess(user, row, action);
  if (!access.authorized) throw forbidden(access.error);
}

export function registerWorkflowRoutes(app) {
  // ----- Interviews -----
  app.get('/api/interviews', async (req, res) => {
    try {
      const { clause, params } = await buildCandidateScopeFilter(req.user, 'a');
      const where = [`(${clause})`];
      const values = [...params];
      if (req.query.scope === 'mine') { values.push(actorIds(req.user)); where.push(`i.interviewer_id = ANY($${values.length})`); }
      if (req.query.applicant_id) { values.push(Number(req.query.applicant_id) || 0); where.push(`i.applicant_id = $${values.length}`); }
      const result = await pool.query(`
        SELECT i.*, a.name AS candidate_name, a.job, a.department, a.stage, a.phone AS candidate_phone, a.email AS candidate_email,
               a.assigned_recruiter_id, a.assigned_recruiter_name, a.resume_url, a.resume_name
        FROM interviews i JOIN applicants a ON a.id = i.applicant_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.scheduled_at NULLS LAST, i.id`, values);
      res.json(result.rows);
    } catch (err) { fail(res, err); }
  });

  // People who can be chosen as an interviewer.
  app.get('/api/ats/interviewers', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT employee_id AS id, name, department, role_title, COALESCE(ats_role, CASE WHEN role IN ('super_admin', 'admin') THEN 'exec_sponsor' WHEN role = 'hr' THEN 'rec_lead' END) AS ats_role
        FROM user_accounts
        WHERE status = 'Active' AND (ats_role IS NOT NULL OR role IN ('super_admin', 'admin', 'hr', 'manager', 'head', 'interviewer', 'recruiter', 'hr_assistant'))
        ORDER BY name`);
      res.json(result.rows);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/applicants/:id/interviews', async (req, res) => {
    try {
      const row = await lockedApplicant(req.params.id);
      const { type, interviewer_id, scheduled_at, meeting_url, platform, required, feedback } = req.body;
      await requireAccess(req.user, row, ['screening', 'hr_l1'].includes(type) ? 'edit' : 'view');
      const perms = await getUserEffectivePermissions(req.user);
      const interview = await scheduleInterview(row, { type, interviewerId: interviewer_id, scheduledAt: scheduled_at, meetingUrl: meeting_url, platform, required }, req.user, perms);
      // Booking or logging the screening call is what starts screening.
      if (row.stage === 'New' && type === 'screening') {
        await pool.query("UPDATE applicants SET stage = 'Screening' WHERE id = $1", [row.id]);
        await afterStageChange(row, 'Screening', req.user, 'Screening started');
      }
      const done = feedback ? await completeInterview(row, { interview, type, ...feedback }, req.user, perms) : interview;
      res.status(201).json({ interview: done, applicant: redactApplicant(await freshApplicant(row.id), perms, req.user) });
    } catch (err) { fail(res, err); }
  });

  app.patch('/api/interviews/:id', async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM interviews WHERE id = $1', [Number(req.params.id) || 0]);
      if (found.rowCount === 0) throw invalid('Interview not found.', 404);
      const interview = found.rows[0];
      const row = await lockedApplicant(interview.applicant_id);
      await requireAccess(req.user, row, 'view');
      const perms = await getUserEffectivePermissions(req.user);
      const { status, scheduled_at, meeting_url, platform, interviewer_id } = req.body;

      if (status === 'Cancelled' || status === 'No Show') {
        if (!OPEN_INTERVIEW_STATUSES.includes(interview.status)) throw invalid('This interview is already closed.', 409);
        const isInterviewer = actorIds(req.user).includes(interview.interviewer_id);
        const arrangePermission = { screening: 'screen_candidates', hr_l1: 'run_hr_l1', additional: 'request_additional_interview', head_hr: 'run_head_hr_round', ceo: 'final_approval' }[interview.type];
        if (!perms[arrangePermission] && !(status === 'No Show' && isInterviewer)) throw forbidden('You are not allowed to change this interview.');
        const updated = await pool.query('UPDATE interviews SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, interview.id]);
        if (interview.type === 'additional' && status === 'Cancelled') {
          await pool.query("UPDATE applicants SET extra_round_required = EXISTS (SELECT 1 FROM interviews WHERE applicant_id = $1 AND type = 'additional' AND required AND status <> 'Cancelled') WHERE id = $1", [row.id]);
        }
        await recordEvent(row.id, 'interview', { to: status, remarks: `${INTERVIEW_LABEL[interview.type]} marked ${status.toLowerCase()}` }, req.user);
        await notify([interview.interviewer_id, row.assigned_recruiter_id], { type: 'interview_updated', title: `${INTERVIEW_LABEL[interview.type]} with ${row.name} was marked ${status.toLowerCase()}`, route: 'ats-interviews', applicantId: row.id }, req.user);
        await syncInterviewMirror(row.id);
        return res.json(updated.rows[0] || { ...interview, status });
      }
      if (status !== undefined) throw invalid('An interview can only be cancelled or marked as no show here.');
      const updated = await scheduleInterview(row, { type: interview.type, interviewerId: interviewer_id, scheduledAt: scheduled_at, meetingUrl: meeting_url, platform, target: interview }, req.user, perms);
      res.json(updated);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/interviews/:id/feedback', async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM interviews WHERE id = $1', [Number(req.params.id) || 0]);
      if (found.rowCount === 0) throw invalid('Interview not found.', 404);
      const row = await lockedApplicant(found.rows[0].applicant_id);
      await requireAccess(req.user, row, 'feedback');
      const perms = await getUserEffectivePermissions(req.user);
      const { rating, notes, recommendation, scorecard } = req.body;
      const interview = await completeInterview(row, { interview: found.rows[0], type: found.rows[0].type, rating, notes, recommendation, scorecard }, req.user, perms);
      await returnToCeoIfReady(await freshApplicant(row.id) || row, req.user);
      res.json({ interview, applicant: redactApplicant(await freshApplicant(row.id), perms, req.user) });
    } catch (err) { fail(res, err); }
  });

  // ----- Head HR recommendation and CEO decision -----
  app.post('/api/applicants/:id/recommend', async (req, res) => {
    try {
      const row = await lockedApplicant(req.params.id);
      await requireAccess(req.user, row, 'view');
      const perms = await getUserEffectivePermissions(req.user);
      if (row.stage !== HEAD_HR_STAGE) throw invalid('Only a candidate in the Head HR round can be recommended to the CEO.', 409);
      checkStageMove(row, { stage: CEO_STAGE, remarks: req.body.recommendation }, { can: perms, interviews: await loadInterviews(row.id) });
      res.json(redactApplicant(await recommendToCeo(row, { recommendation: req.body.recommendation, monthlySalary: perms.view_salary ? req.body.monthly_salary : undefined }, req.user), perms, req.user));
    } catch (err) { fail(res, err); }
  });

  app.post('/api/applicants/:id/ceo-decision', async (req, res) => {
    try {
      const row = await lockedApplicant(req.params.id);
      const perms = await getUserEffectivePermissions(req.user);
      if (!perms.final_approval) throw forbidden('Only the CEO can give the final decision.');
      const { decision, remarks } = req.body;
      if (!CEO_DECISIONS.includes(decision)) throw invalid('Choose approve, reject, send back or request an interview.');
      if (row.stage !== CEO_STAGE) throw invalid('This candidate is not waiting for CEO approval.', 409);
      if (row.promoted_employee_id) throw invalid('This candidate is already onboarded.', 409);
      if (decision !== 'approved' && !hasText(remarks)) throw invalid('A reason is required for this decision.');

      const toStage = decision === 'approved' ? APPROVED_STAGE : decision === 'rejected' ? REJECTED_STAGE : HEAD_HR_STAGE;
      const note = hasText(remarks) ? remarks.trim() : null;
      const updated = await pool.query(`
        UPDATE applicants SET stage = $1, ceo_decision = $2, ceo_remarks = $3, ceo_decided_by = $4, ceo_decided_at = NOW(),
          rejection_reason = CASE WHEN $2::varchar = 'rejected' THEN $3 ELSE rejection_reason END,
          extra_round_required = CASE WHEN $2::varchar = 'interview_requested' THEN TRUE ELSE extra_round_required END
        WHERE id = $5 RETURNING *`, [toStage, decision, note, req.user.name, row.id]);
      await recordEvent(row.id, 'ceo_decision', { to: decision, remarks: note }, req.user);
      await afterStageChange(row, toStage, req.user, note);
      if (decision === 'interview_requested') {
        await notify(await accountIds('head_hr'), { type: 'interview_requested', title: `The CEO asked for another interview for ${row.name}`, body: note, route: 'hr-approval', applicantId: row.id }, req.user);
      }
      res.json(redactApplicant(updated.rows[0] || { ...row, stage: toStage, ceo_decision: decision }, perms, req.user));
    } catch (err) { fail(res, err); }
  });

  app.get('/api/applicants/:id/history', async (req, res) => {
    try {
      const found = await pool.query('SELECT * FROM applicants WHERE id = $1', [Number(req.params.id) || 0]);
      if (found.rowCount === 0) throw invalid('Candidate not found.', 404);
      await requireAccess(req.user, found.rows[0], 'view');
      const perms = await getUserEffectivePermissions(req.user);
      const events = await pool.query('SELECT id, kind, from_value, to_value, actor_name, remarks, created_at FROM candidate_events WHERE applicant_id = $1 ORDER BY created_at, id', [found.rows[0].id]);
      const offers = perms.view_salary || perms.issue_offers
        ? (await pool.query('SELECT * FROM offers WHERE applicant_id = $1 ORDER BY id', [found.rows[0].id])).rows : [];
      res.json({ events: events.rows, interviews: await loadInterviews(found.rows[0].id), offers });
    } catch (err) { fail(res, err); }
  });

  // ----- Offers -----
  app.get('/api/offers', async (req, res) => {
    try {
      const perms = await getUserEffectivePermissions(req.user);
      if (!perms.issue_offers && !perms.view_salary) throw forbidden('You do not have permission to see offers.');
      const result = await pool.query(`
        SELECT o.*, a.name AS candidate_name, a.job, a.email AS candidate_email, a.stage, a.promoted_employee_id, a.assigned_recruiter_name
        FROM offers o JOIN applicants a ON a.id = o.applicant_id ORDER BY o.created_at DESC, o.id DESC`);
      res.json(result.rows);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/offers', async (req, res) => {
    try {
      const perms = await getUserEffectivePermissions(req.user);
      if (!perms.issue_offers) throw forbidden('You do not have permission to issue offers.');
      const row = await lockedApplicant(req.body.applicant_id);
      if (row.stage !== APPROVED_STAGE) throw invalid('An offer can be made only after CEO approval.', 409);
      if (row.promoted_employee_id) throw invalid('This candidate is already onboarded.', 409);
      const { designation, department, annual_ctc, basic, hra = 0, allowances = 0, deductions = 0, joining_date, notes } = req.body;
      const title = hasText(designation) ? designation.trim() : row.job;
      const dept = hasText(department) ? department.trim() : row.department;
      if (!hasText(title) || !hasText(dept)) throw invalid('Designation and department are required.');
      parseDate(joining_date);
      const [basicP, hraP, allowanceP, deductionP] = [paise(basic), paise(hra), paise(allowances), paise(deductions)];
      const gross = basicP + hraP + allowanceP;
      if (paise(annual_ctc) <= 0) throw invalid('Annual CTC is required.');
      if (deductionP > gross) throw invalid('Deductions cannot exceed gross salary.');
      if (Math.abs(gross - Math.round(paise(annual_ctc) / 12)) > 100) throw invalid('Monthly salary components must match the annual CTC divided by 12.');
      const open = await pool.query("SELECT 1 FROM offers WHERE applicant_id = $1 AND status IN ('Draft', 'Issued', 'Accepted')", [row.id]);
      if (open.rowCount > 0) throw invalid('This candidate already has an open offer.', 409);

      const status = req.body.status === 'Draft' ? 'Draft' : 'Issued';
      const inserted = await pool.query(`
        INSERT INTO offers (applicant_id, designation, department, annual_ctc, basic, hra, allowances, deductions, joining_date, status, notes, created_by, issued_by, issued_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [row.id, title, dept, rupees(paise(annual_ctc)), rupees(basicP), rupees(hraP), rupees(allowanceP), rupees(deductionP), joining_date, status, hasText(notes) ? notes.trim() : null,
          req.user.name, status === 'Issued' ? req.user.name : null, status === 'Issued' ? new Date() : null]);
      await pool.query('UPDATE applicants SET offer_status = $1 WHERE id = $2', [status, row.id]);
      await recordEvent(row.id, 'offer', { to: status, remarks: `Offer for ${title}, joining ${joining_date}` }, req.user);
      await notify([row.assigned_recruiter_id], { type: 'offer_updated', title: `An offer was ${status === 'Issued' ? 'issued' : 'drafted'} for ${row.name}`, route: 'ats-offers', applicantId: row.id }, req.user);
      res.status(201).json(inserted.rows[0] || { applicant_id: row.id, status });
    } catch (err) { fail(res, err); }
  });

  app.patch('/api/offers/:id/status', async (req, res) => {
    try {
      const perms = await getUserEffectivePermissions(req.user);
      if (!perms.issue_offers) throw forbidden('You do not have permission to update offers.');
      const found = await pool.query('SELECT * FROM offers WHERE id = $1 FOR UPDATE', [Number(req.params.id) || 0]);
      if (found.rowCount === 0) throw invalid('Offer not found.', 404);
      const offer = found.rows[0];
      const row = await lockedApplicant(offer.applicant_id);
      const { status, notes } = req.body;
      if (!(OFFER_MOVES[offer.status] || []).includes(status)) throw invalid(`An offer that is ${offer.status} cannot become ${status || 'that'}.`, 409);
      if (row.promoted_employee_id) throw invalid('This candidate is already onboarded, so the offer cannot change.', 409);
      if (['Declined', 'Withdrawn'].includes(status) && !hasText(notes)) throw invalid('A reason is required.');
      const updated = await pool.query(`
        UPDATE offers SET status = $1::varchar, notes = COALESCE($2, notes), updated_at = NOW(),
          issued_by = CASE WHEN $1::varchar = 'Issued' THEN $3 ELSE issued_by END, issued_at = CASE WHEN $1::varchar = 'Issued' THEN NOW() ELSE issued_at END,
          decided_at = CASE WHEN $1::varchar IN ('Accepted', 'Declined', 'Withdrawn') THEN NOW() ELSE decided_at END
        WHERE id = $4 RETURNING *`, [status, hasText(notes) ? notes.trim() : null, req.user.name, offer.id]);
      await pool.query('UPDATE applicants SET offer_status = $1 WHERE id = $2', [status, row.id]);
      await recordEvent(row.id, 'offer', { from: offer.status, to: status, remarks: hasText(notes) ? notes.trim() : null }, req.user);
      await notify([row.assigned_recruiter_id, ...await accountIds('head_hr')], { type: 'offer_updated', title: `Offer for ${row.name} is now ${status}`, route: 'ats-offers', applicantId: row.id }, req.user);
      res.json(updated.rows[0] || { ...offer, status });
    } catch (err) { fail(res, err); }
  });

  // ----- Notifications and work queues -----
  app.get('/api/notifications', async (req, res) => {
    try {
      const ids = actorIds(req.user);
      const items = await pool.query('SELECT id, type, title, body, route, applicant_id, read_at, created_at FROM notifications WHERE employee_id = ANY($1) ORDER BY created_at DESC, id DESC LIMIT 50', [ids]);
      const unread = await pool.query('SELECT COUNT(*)::int AS n FROM notifications WHERE employee_id = ANY($1) AND read_at IS NULL', [ids]);
      res.json({ unread: unread.rows[0]?.n || 0, items: items.rows });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/notifications/read', async (req, res) => {
    try {
      const ids = actorIds(req.user);
      const one = Number(req.body.id) || null;
      await pool.query('UPDATE notifications SET read_at = NOW() WHERE employee_id = ANY($1) AND read_at IS NULL AND ($2::bigint IS NULL OR id = $2)', [ids, one]);
      res.json({ success: true });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/ats/queues', async (req, res) => {
    try {
      const perms = await getUserEffectivePermissions(req.user);
      const ids = actorIds(req.user);
      const counts = (await pool.query(`
        SELECT COUNT(*) FILTER (WHERE assigned_recruiter_id IS NULL AND stage = ANY($1))::int AS unassigned,
               COUNT(*) FILTER (WHERE stage = $2)::int AS head_hr,
               COUNT(*) FILTER (WHERE stage = $3)::int AS ceo,
               COUNT(*) FILTER (WHERE stage = $4 AND COALESCE(offer_status, '') NOT IN ('Accepted'))::int AS offers,
               COUNT(*) FILTER (WHERE stage = $4 AND offer_status = 'Accepted')::int AS onboarding,
               COUNT(*) FILTER (WHERE stage = 'New' AND assigned_recruiter_id = ANY($5))::int AS my_new
        FROM applicants WHERE promoted_employee_id IS NULL`, [STAGES, HEAD_HR_STAGE, CEO_STAGE, APPROVED_STAGE, ids])).rows[0] || {};
      const mine = (await pool.query('SELECT COUNT(*)::int AS n FROM interviews WHERE interviewer_id = ANY($1) AND status = ANY($2)', [ids, OPEN_INTERVIEW_STATUSES])).rows[0]?.n || 0;
      res.json({
        unassigned: perms.view_all_candidates ? counts.unassigned || 0 : 0,
        head_hr: perms.run_head_hr_round ? counts.head_hr || 0 : 0,
        ceo: perms.final_approval ? counts.ceo || 0 : 0,
        offers: perms.issue_offers ? (counts.offers || 0) + (counts.onboarding || 0) : 0,
        my_new: counts.my_new || 0,
        my_interviews: mine
      });
    } catch (err) { fail(res, err); }
  });

  // ----- HR Assistant assignments -----
  app.get('/api/ats/assignments', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT ra.id, ra.recruiter_id, r.name AS recruiter_name, ra.kind, ra.job_id, ra.target, ra.is_primary, j.code AS job_code, j.role AS job_role
        FROM recruiter_assignments ra JOIN recruitment_team r ON r.id = ra.recruiter_id LEFT JOIN job_requisitions j ON j.id = ra.job_id
        ORDER BY r.name, ra.kind, ra.target, j.role`);
      res.json(result.rows);
    } catch (err) { fail(res, err); }
  });

  // Replaces what one HR Assistant handles. Candidates already in the pipeline keep their owner.
  app.put('/api/ats/resources/:id/assignments', async (req, res) => {
    try {
      const recruiter = await pool.query('SELECT id, name FROM recruitment_team WHERE id = $1', [req.params.id]);
      if (recruiter.rowCount === 0) throw invalid('Team member not found.', 404);
      const departments = cleanList(req.body.departments);
      const roles = cleanList(req.body.roles);
      const jobIds = cleanList(req.body.job_ids).map(Number);
      if (jobIds.some(id => !Number.isInteger(id))) throw invalid('Choose valid jobs.');
      if (jobIds.length) {
        const jobs = await pool.query('SELECT id FROM job_requisitions WHERE id = ANY($1)', [jobIds]);
        if (jobs.rowCount !== jobIds.length) throw invalid('One of the chosen jobs no longer exists.');
      }
      const primary = { department: cleanList(req.body.primary?.departments).map(v => v.toLowerCase()), role: cleanList(req.body.primary?.roles).map(v => v.toLowerCase()), job: cleanList(req.body.primary?.job_ids).map(Number) };
      await pool.query('DELETE FROM recruiter_assignments WHERE recruiter_id = $1', [req.params.id]);
      const add = (kind, jobId, target, isPrimary) => pool.query(
        'INSERT INTO recruiter_assignments (recruiter_id, kind, job_id, target, is_primary, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.params.id, kind, jobId, target, isPrimary, req.user.name]);
      for (const name of departments) await add('department', null, name, primary.department.includes(name.toLowerCase()));
      for (const name of roles) await add('role', null, name, primary.role.includes(name.toLowerCase()));
      for (const id of jobIds) await add('job', id, null, primary.job.includes(id));
      res.json({ success: true, departments, roles, job_ids: jobIds });
    } catch (err) { fail(res, err); }
  });

  // Hands every active candidate of one HR Assistant to another, or to the Unassigned queue.
  app.post('/api/ats/resources/:id/reassign-all', async (req, res) => {
    try {
      const from = await pool.query('SELECT id, name FROM recruitment_team WHERE id = $1', [req.params.id]);
      if (from.rowCount === 0) throw invalid('Team member not found.', 404);
      const targetId = req.body.target_recruiter_id || null;
      const target = targetId ? await activeRecruiter(targetId) : null;
      if (targetId && !target) throw invalid('Choose an active HR Assistant to receive the candidates.');
      if (targetId === req.params.id) throw invalid('Choose a different person.');
      const moved = await pool.query(`
        UPDATE applicants SET assigned_recruiter_id = $1, assigned_recruiter_name = $2
        WHERE assigned_recruiter_id = $3 AND promoted_employee_id IS NULL AND stage <> $4 RETURNING id, name`,
        [target?.id || null, target?.name || null, req.params.id, REJECTED_STAGE]);
      for (const candidate of moved.rows) {
        await recordEvent(candidate.id, 'assignment', { from: from.rows[0].name, to: target?.name || 'Unassigned', remarks: 'All candidates reassigned' }, req.user);
      }
      if (target && moved.rowCount > 0) {
        await notify([target.id], { type: 'candidates_assigned', title: `${moved.rowCount} candidate${moved.rowCount === 1 ? '' : 's'} from ${from.rows[0].name} were assigned to you`, route: 'hiring' }, req.user);
      }
      res.json({ success: true, moved: moved.rowCount });
    } catch (err) { fail(res, err); }
  });
}
