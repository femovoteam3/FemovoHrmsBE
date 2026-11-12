// Recruitment ATS API: candidates, jobs, recruiters, import/export and team access.
import { pool } from './db.js';
import crypto from 'node:crypto';
import { upload, authorizeResumeUpload, tokenHash, scheduleUploadCleanup } from './files.js';
import { APPROVED_STAGE, CEO_STAGE, FIRST_STAGE, INTERVIEW_STAGES, INTERVIEW_TYPE_FOR_STAGE, OPEN_INTERVIEW_STATUSES, REJECTED_STAGE, checkStageMove } from './stages.js';
import { csvCell, paise, rupees, invalid, parseDate, parsePagination, parseDateRange, validateApplication, validateRequisition, readAtsRole } from './domain.js';
import { actorIds, hashPin, getUserEffectivePermissions, buildCandidateScopeFilter, checkCandidateAccess, resolveAtsRole, redactApplicant as redact } from './auth.js';
import { loadOwnerResolver, resolveOwner } from './assignment.js';
import { roleRank } from './ats-permissions.js';
import { accountIds, activeRecruiter, afterStageChange, completeInterview, loadInterviews, notify, recommendToCeo, recordEvent, scheduleInterview } from './workflow.js';

// The older scorecard form sends its recommendation as a prefix on the notes.
const NOTE_RECOMMENDATION = { 'STRONG HIRE': 'Strong Hire', HIRE: 'Hire', HOLD: 'Another review', 'ANOTHER REVIEW': 'Another review', REJECT: 'Reject' };
function parseScorecard(notes) {
  const match = typeof notes === 'string' ? notes.match(/^\[(STRONG HIRE|HIRE|HOLD|ANOTHER REVIEW|REJECT)\]\s*([\s\S]*)$/i) : null;
  return match ? { recommendation: NOTE_RECOMMENDATION[match[1].toUpperCase()], notes: match[2].trim() || match[1] } : null;
}

export function registerAtsRoutes(app) {
  // 8. Hiring / Applicants endpoints
  app.get('/api/applicants', async (req, res) => {
    try {
      const { limit, offset } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
      const { clause, params } = await buildCandidateScopeFilter(req.user);
      const queryParams = [...params, limit, offset];
      const result = await pool.query(
        `SELECT * FROM applicants WHERE ${clause} ORDER BY id ASC LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
        queryParams
      );
      const perms = await getUserEffectivePermissions(req.user);
      res.json(result.rows.map(row => redact(row, perms, req.user)));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Single candidate endpoint with strict ownership check
  app.get('/api/applicants/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const cur = await pool.query('SELECT * FROM applicants WHERE id = $1', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Candidate not found' });
      const cand = cur.rows[0];

      const access = await checkCandidateAccess(req.user, cand, 'view');
      if (!access.authorized) {
        return res.status(403).json({ error: access.error, code: access.code });
      }

      res.json(redact(cand, await getUserEffectivePermissions(req.user), req.user));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/applicants', async (req, res) => {
    try {
      // If authenticated user is creating a candidate, check create permission
      if (req.user) {
        const access = await checkCandidateAccess(req.user, null, 'create');
        if (!access.authorized) {
          return res.status(403).json({ error: access.error, code: access.code });
        }
      }

      const { department, assigned_recruiter_id } = req.body;
      const { name, job, email, phone, experience, current_ctc, expected_ctc, notice_period, qualification, current_location, portfolio_url, source } = validateApplication(req.body, { isPublic: !req.user });

      if (!req.user) {
        const publicJobId=Number(req.body.job_id);
        const jobResult=Number.isInteger(publicJobId)&&publicJobId>0
          ? await pool.query("SELECT * FROM job_requisitions WHERE id=$1 AND status='Active'",[publicJobId])
          : await pool.query("SELECT * FROM job_requisitions WHERE role=$1 AND status='Active' ORDER BY id LIMIT 1",[job]);
        if (!jobResult.rowCount) throw invalid('This position is not accepting applications.');
        req.publicJob=jobResult.rows[0];
        // One open application per person and job.
        const already = await pool.query("SELECT 1 FROM applicants WHERE LOWER(email) = $1 AND job_id = $2 AND stage <> 'Rejected' AND promoted_employee_id IS NULL LIMIT 1", [email, req.publicJob.id]);
        if (already.rowCount) throw invalid('An application with this email address is already with us for this job. Our HR team will contact you.', 409);
      }
      const jobRow = req.publicJob || await jobForTitle(job);
      const finalDept = jobRow?.department || department || req.user?.department || null;
      // An HR Assistant keeps the candidate they add, an authorized person may name the owner,
      // and everyone else's candidates follow the assignment rules.
      let owner = null;
      let perms = null;
      if (req.user) {
        perms = await getUserEffectivePermissions(req.user);
        if (assigned_recruiter_id && perms.assign_candidates) {
          owner = await activeRecruiter(assigned_recruiter_id);
          if (!owner) throw invalid('Choose an active HR Assistant.');
        } else if (resolveAtsRole(req.user) === 'rec_associate') {
          owner = await activeRecruiter(req.user.recruiterId || req.user.employeeId);
        }
      }
      if (!owner) owner = await resolveOwner({ id: jobRow?.id ?? null, role: jobRow?.role || job, department: finalDept, assigned_recruiter_id: jobRow?.assigned_recruiter_id, backup_recruiter_id: jobRow?.backup_recruiter_id });
      const finalRecId = owner?.id || null;
      const finalRecName = owner?.name || null;
      const submittedBy = req.user ? (req.user.employeeId || req.user.recruiterId) : 'public_careers_portal';

      const result = await pool.query(
        `INSERT INTO applicants (name, job, job_id, stage, email, phone, experience, current_ctc, expected_ctc, notice_period, source, department, assigned_recruiter_id, assigned_recruiter_name, submitted_by_user_id, qualification, current_location, portfolio_url)
         VALUES ($1, $2, $3, '${FIRST_STAGE}', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
        [
          name,
          req.publicJob?.role || job,
          jobRow?.id ?? null,
          email,
          phone,
          experience,
          current_ctc,
          expected_ctc,
          notice_period,
          req.user ? source || 'Direct Application' : 'Career portal',
          finalDept,
          finalRecId,
          finalRecName,
          submittedBy,
          qualification,
          current_location,
          portfolio_url
        ]
      );
      const candidate=result.rows[0];
      await recordEvent(candidate.id, 'stage', { to: FIRST_STAGE, remarks: req.user ? 'Candidate added' : 'Applied on the career portal' }, req.user);
      await announceOwner(candidate, owner, req.user);
      if (!req.user) {
        const uploadToken=crypto.randomBytes(32).toString('base64url');
        await pool.query("UPDATE applicants SET resume_upload_token_hash=$1,resume_upload_expires_at=NOW()+interval '30 minutes' WHERE id=$2",[tokenHash(uploadToken),candidate.id]);
        return res.status(201).json({id:candidate.id,name:candidate.name,job:candidate.job,department:candidate.department,uploadToken});
      }
      res.status(201).json(redact(candidate, perms, req.user));
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'An application with this email address is already with us for this job. Our HR team will contact you.'
        });
      }
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Candidates are linked to the job with this title. Live jobs are preferred.
  async function jobForTitle(title) {
    const found = await pool.query("SELECT id, role, department, assigned_recruiter_id, backup_recruiter_id FROM job_requisitions WHERE LOWER(role) = LOWER($1) ORDER BY (status = 'Active') DESC, id LIMIT 1", [String(title).trim()]);
    return found.rows[0] || null;
  }
  const jobIdForTitle = async title => (await jobForTitle(title))?.id ?? null;

  // Tells the new owner, or Head HR and the CEO when nobody could be assigned.
  async function announceOwner(candidate, owner, actor) {
    if (owner) {
      await recordEvent(candidate.id, 'assignment', { to: owner.name, remarks: 'Assigned by the assignment rules' }, actor);
      await notify([owner.id], { type: 'candidate_assigned', title: `New candidate assigned to you: ${candidate.name}`, body: `${candidate.job}${candidate.department ? ` · ${candidate.department}` : ''}`, route: 'hiring', applicantId: candidate.id }, actor);
    } else {
      await notify([...await accountIds('head_hr'), ...await accountIds('ceo')], { type: 'candidate_unassigned', title: `${candidate.name} has no HR Assistant`, body: `${candidate.job}: nobody is assigned to this job, role or department.`, route: 'ats-team', applicantId: candidate.id }, actor);
    }
  }

  // Update full candidate credentials & profile
  app.put('/api/applicants/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const cur = await pool.query('SELECT * FROM applicants WHERE id = $1', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Candidate not found' });
      const row = cur.rows[0];

      const isInterviewer = req.user && (req.user.atsRole === 'hiring_manager' || ['employee','manager','interviewer'].includes(req.user.role));
      if (isInterviewer && Object.keys(req.body).some(key=>!['rating','scorecard_notes','actor','editorName','reviewerName','posted_by'].includes(key))) return res.status(403).json({error:'Interviewers may update only feedback and rating.'});
      const action = isInterviewer ? 'feedback' : 'edit';
      const access = await checkCandidateAccess(req.user, row, action);
      if (!access.authorized) {
        return res.status(403).json({ error: access.error, code: access.code });
      }

      const {
        name,
        job,
        email,
        phone,
        experience,
        current_ctc,
        expected_ctc,
        notice_period,
        source,
        stage,
        rating,
        scorecard_notes,
        department,
        assigned_recruiter_id,
        assigned_recruiter_name,
        interviewer,
        interviewer_id,
        rejection_reason
      } = req.body;

      if (stage !== undefined && stage !== row.stage) return res.status(400).json({ error: 'Use the pipeline board to change a stage.' });

      // If assigned recruiter is being changed, verify assign permission
      let newOwner = null;
      if (assigned_recruiter_id && assigned_recruiter_id !== row.assigned_recruiter_id) {
        const assignCheck = await checkCandidateAccess(req.user, row, 'assign');
        if (!assignCheck.authorized) {
          return res.status(403).json({ error: assignCheck.error, code: assignCheck.code });
        }
        newOwner = await activeRecruiter(assigned_recruiter_id);
        if (!newOwner) return res.status(400).json({ error: 'Choose an active HR Assistant.' });
      }

      const newJobId = job && job !== row.job ? await jobIdForTitle(job) : row.job_id ?? null;

      const result = await pool.query(`
        UPDATE applicants SET
          name = COALESCE($1, name),
          job = COALESCE($2, job),
          email = COALESCE($3, email),
          phone = COALESCE($4, phone),
          experience = COALESCE($5, experience),
          current_ctc = COALESCE($6, current_ctc),
          expected_ctc = COALESCE($7, expected_ctc),
          notice_period = COALESCE($8, notice_period),
          source = COALESCE($9, source),
          job_id = $10,
          rating = COALESCE($11, rating),
          scorecard_notes = COALESCE($12, scorecard_notes),
          department = COALESCE($13, department),
          assigned_recruiter_id = COALESCE($14, assigned_recruiter_id),
          assigned_recruiter_name = COALESCE($15, assigned_recruiter_name),
          interviewer = COALESCE($16, interviewer),
          interviewer_id = COALESCE($17, interviewer_id),
          rejection_reason = COALESCE($18, rejection_reason)
        WHERE id = $19
        RETURNING *
      `, [
        name || row.name,
        job || row.job,
        email || row.email,
        phone || row.phone,
        experience || row.experience,
        current_ctc || row.current_ctc,
        expected_ctc || row.expected_ctc,
        notice_period || row.notice_period,
        source || row.source,
        newJobId,
        rating !== undefined ? rating : row.rating,
        scorecard_notes !== undefined ? scorecard_notes : row.scorecard_notes,
        department || row.department,
        newOwner?.id || row.assigned_recruiter_id,
        newOwner?.name || row.assigned_recruiter_name,
        interviewer !== undefined ? interviewer : row.interviewer,
        interviewer_id !== undefined ? interviewer_id : row.interviewer_id,
        rejection_reason !== undefined ? rejection_reason : row.rejection_reason,
        id
      ]);

      await pool.query(
        `INSERT INTO audit_logs (actor_name, action, details)
         VALUES ($1, 'CANDIDATE_UPDATED', $2)`,
        [req.user?.name || 'HR Admin', `Updated credentials & profile for candidate ${result.rows[0].name} (${result.rows[0].job})`]
      );
      if (newOwner) await recordReassignment(row, newOwner, req.user);

      res.json(redact(result.rows[0], await getUserEffectivePermissions(req.user), req.user));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  async function recordReassignment(candidate, target, actor) {
    await recordEvent(candidate.id, 'assignment', { from: candidate.assigned_recruiter_name || 'Unassigned', to: target?.name || 'Unassigned', remarks: 'Reassigned' }, actor);
    if (target) await notify([target.id], { type: 'candidate_assigned', title: `${candidate.name} was assigned to you by ${actor?.name || 'an administrator'}`, body: candidate.job, route: 'hiring', applicantId: candidate.id }, actor);
    if (candidate.assigned_recruiter_id) await notify([candidate.assigned_recruiter_id], { type: 'candidate_moved', title: `${candidate.name} was reassigned to ${target?.name || 'the Unassigned queue'}`, route: 'hiring' }, actor);
  }

  // Give a candidate to another HR Assistant, or back to the Unassigned queue.
  app.patch('/api/applicants/:id/assign', async (req, res) => {
    try {
      const { id } = req.params;
      const cur = await pool.query('SELECT * FROM applicants WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Candidate not found' });
      const cand = cur.rows[0];

      const access = await checkCandidateAccess(req.user, cand, 'assign');
      if (!access.authorized) {
        return res.status(403).json({ error: access.error, code: access.code });
      }

      const targetId = req.body.assigned_recruiter_id || null;
      const target = targetId ? await activeRecruiter(targetId) : null;
      if (targetId && !target) return res.status(400).json({ error: 'Choose an active HR Assistant.' });
      const result = await pool.query('UPDATE applicants SET assigned_recruiter_id = $1, assigned_recruiter_name = $2 WHERE id = $3 RETURNING *', [target?.id || null, target?.name || null, id]);
      if (targetId !== cand.assigned_recruiter_id) await recordReassignment(cand, target, req.user);
      res.json(redact(result.rows[0], await getUserEffectivePermissions(req.user), req.user));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Atomically promote candidate from Recruitment ATS to Employee Management System (EMS)
  app.post('/api/applicants/:id/promote', async (req, res) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      const candRes = await client.query('SELECT * FROM applicants WHERE id = $1 FOR UPDATE', [id]);
      if (candRes.rowCount === 0) {
        return res.status(404).json({ error: 'Candidate not found' });
      }
      const cand = candRes.rows[0];
      if(cand.promoted_employee_id) return res.status(409).json({error:'Candidate has already been promoted.'});
      if(cand.stage!==APPROVED_STAGE) return res.status(409).json({error:'Only a candidate approved by the CEO can be onboarded.'});

      const access = await checkCandidateAccess(req.user, cand, 'promote');
      if (!access.authorized) {
        return res.status(403).json({ error: access.error, code: access.code });
      }

      const offerRes = await client.query("SELECT *, to_char(joining_date, 'YYYY-MM-DD') AS joining_day FROM offers WHERE applicant_id = $1 AND status = 'Accepted' ORDER BY id DESC LIMIT 1", [id]);
      if (offerRes.rowCount === 0) return res.status(409).json({ error: 'The candidate must accept the offer before onboarding.' });
      const offer = offerRes.rows[0];
      if (!cand.email) return res.status(400).json({ error: 'The candidate needs an email address before onboarding.' });
      const duplicate = await client.query('SELECT id FROM employees WHERE LOWER(email) = LOWER($1) LIMIT 1', [cand.email]);
      if (duplicate.rowCount > 0) return res.status(409).json({ error: `An employee with this email already exists (${duplicate.rows[0].id}).` });

      await client.query('BEGIN');

      // 2. Generate new FEM-xxx employee ID
      await pool.query("SELECT pg_advisory_xact_lock(hashtext('employee-id-allocation'))");
      const maxRes = await client.query("SELECT id FROM employees WHERE id ~ '^FEM-[0-9]+$' ORDER BY substring(id from 5)::bigint DESC LIMIT 1");
      let nextNum = 15;
      if (maxRes.rows.length > 0) {
        const currentNum = parseInt(maxRes.rows[0].id.replace('FEM-', ''), 10);
        if (!isNaN(currentNum)) nextNum = currentNum + 1;
      }
      const empId = `FEM-${String(nextNum).padStart(3, '0')}`;

      // The accepted offer is the record of what was agreed.
      const empDept = offer.department;
      const empRole = offer.designation;
      const empManager = typeof req.body.manager === 'string' && req.body.manager.trim() ? req.body.manager.trim() : null;
      const joining_date = offer.joining_day;
      parseDate(joining_date);
      const basicCents = paise(offer.basic), hraCents = paise(offer.hra), allowanceCents = paise(offer.allowances), deductionCents = paise(offer.deductions);
      const grossCents = basicCents + hraCents + allowanceCents;

      // 3. Insert into employees
      const empRes = await client.query(`
        INSERT INTO employees (id, name, department, role, manager, status, attendance, email, phone, joining_date)
        VALUES ($1, $2, $3, $4, $5, 'Probation', 'Not marked', $6, $7, $8)
        RETURNING *
      `, [empId, cand.name, empDept, empRole, empManager, cand.email, cand.phone, joining_date]);
      const newEmp = empRes.rows[0];

      // Provision the account without a shared/default password. An administrator
      // sets the initial password through the existing credential-reset workflow.
      await client.query(`INSERT INTO user_accounts(employee_id,email,pin,name,role,department,role_title,avatar)
        VALUES($1,$2,$3,$4,'employee',$5,$6,$7)`,
        [empId, cand.email.trim().toLowerCase(), await hashPin(crypto.randomBytes(32).toString('hex')), cand.name, empDept, empRole, cand.name.slice(0,2).toUpperCase()]);

      // 4. Insert into salaries table
      const basicVal = rupees(basicCents);
      const hraVal = rupees(hraCents);
      const allowVal = rupees(allowanceCents);
      const dedVal = rupees(deductionCents);
      const netVal = rupees(grossCents - deductionCents);

      await client.query(`
        INSERT INTO salaries (employee_id, basic, hra, allowances, deductions, net_salary)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (employee_id) DO UPDATE SET
          basic = EXCLUDED.basic,
          hra = EXCLUDED.hra,
          allowances = EXCLUDED.allowances,
          deductions = EXCLUDED.deductions,
          net_salary = EXCLUDED.net_salary
      `, [empId, basicVal, hraVal, allowVal, dedVal, netVal]);

      // 5. Insert employee documents
      await client.query(`
        INSERT INTO employee_documents (employee_id, aadhaar, pan, bank_details, offer_letter)
        VALUES ($1, 'Pending', 'Pending', 'Pending', 'Verified')
        ON CONFLICT (employee_id) DO NOTHING
      `, [empId]);

      // 7. Insert leave balances
      await client.query(`
        INSERT INTO leave_balances (employee_id, cl_balance, sl_balance, wellness_balance, pl_balance)
        VALUES ($1, 0, 0, 0, 0)
        ON CONFLICT (employee_id) DO NOTHING
      `, [empId]);

      // 8. Mark the candidate as onboarded
      await client.query(`
        UPDATE applicants SET
          promoted_employee_id = $1::text, onboarded_at = NOW()
        WHERE id = $2
      `, [empId, id]);
      await recordEvent(cand.id, 'onboarding', { to: empId, remarks: `Onboarded to EMS as ${empRole}` }, req.user);

      // 9. Auto-increment matching job requisition filled count
      await client.query(`
        UPDATE job_requisitions
        SET 
          filled = LEAST(openings, filled + 1),
          status = CASE WHEN filled + 1 >= openings THEN 'Closed' ELSE status END
        WHERE id = COALESCE($3::int, (SELECT id FROM job_requisitions WHERE role=$1 AND department=$2 AND status='Active' AND filled<openings ORDER BY id LIMIT 1))
          AND status = 'Active'
          AND filled < openings
      `, [cand.job, cand.department, cand.job_id ?? null]);

      // 10. Write audit log
      await client.query(`
        INSERT INTO audit_logs (actor_name, action, details)
        VALUES ($1, 'CANDIDATE_ONBOARDED', 'Candidate ' || $2 || ' successfully promoted and bridged to EMS as Employee ' || $3 || ' (' || $4 || ')')
      `, [req.user?.name || 'Administrator', cand.name, empId, empRole]);

      await client.query('COMMIT');

      res.status(201).json({
        message: `🎉 Candidate "${cand.name}" successfully promoted to Employee ${empId}!`,
        employee: newEmp,
        empId,
        passwordSetupRequired: true
      });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Upload or replace candidate resume CV
  app.post('/api/applicants/:id/resume', authorizeResumeUpload, upload.single('file'), async (req, res) => {
    try {
      const { id } = req.params;
      if (!req.file) return res.status(400).json({ error: 'No resume file uploaded' });

      const cur = await pool.query('SELECT * FROM applicants WHERE id = $1', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Candidate not found' });
      const cand = cur.rows[0];

      if (req.user) {
        const access = await checkCandidateAccess(req.user, cand, 'edit');
        if (!access.authorized) {
          return res.status(403).json({ error: access.error, code: access.code });
        }
      }

      const fileUrl = `/uploads/${req.file.filename}`;
      const fileName = req.file.originalname.slice(0, 100);

      const result = await pool.query(`
        UPDATE applicants SET
          resume_name = $1,
          resume_url = $2, resume_upload_token_hash = NULL, resume_upload_expires_at = NULL
        WHERE id = $3 AND ($4::text IS NULL OR (resume_upload_token_hash=$4 AND resume_upload_expires_at>NOW()))
        RETURNING *
      `, [fileName, fileUrl, id, req.applicationTokenHash || null]);

      if (!result.rowCount) throw invalid('Upload token has already been used or expired.',409);
      await pool.query(
        `INSERT INTO audit_logs (actor_name, action, details)
         VALUES ($1, 'RESUME_UPLOADED', $2)`,
        [req.user?.name || 'Public applicant', `Uploaded résumé for candidate ${id}`]
      );

      res.json({ message: 'Resume uploaded successfully', ...(req.user ? { applicant: redact(result.rows[0], await getUserEffectivePermissions(req.user), req.user) } : { id: result.rows[0].id }) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.patch('/api/applicants/:id/stage', async (req, res) => {
    try {
      const { id } = req.params;
      const { stage, interview_date, interviewer_id, meet_link, rating, scorecard_notes, rejection_reason, actor, monthly_salary, remarks } = req.body;

      const cur = await pool.query('SELECT * FROM applicants WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Applicant not found' });
      const row = cur.rows[0];

      // Without edit rights, an assigned interviewer may record feedback and manage the interview slot only.
      const perms = await getUserEffectivePermissions(req.user);
      const canEdit = perms.edit_candidates === true;
      const stageChanges = stage !== undefined && stage !== row.stage;
      const serverFields = ['actor', 'editorName', 'reviewerName', 'posted_by'];
      const feedbackFields = ['stage', 'rating', 'scorecard_notes', ...serverFields];
      const interviewerFields = [...feedbackFields, 'interview_date', 'meet_link'];
      const bodyKeys = Object.keys(req.body);
      if (!canEdit && (stageChanges || bodyKeys.some(key => !interviewerFields.includes(key)))) {
        return res.status(403).json({ error: 'Interviewers may update only feedback and interview details.', code: 'FORBIDDEN_INTERVIEWER_ACTION' });
      }
      const isFeedbackOnly = !canEdit || (!stageChanges && (rating !== undefined || scorecard_notes !== undefined) && bodyKeys.every(key => feedbackFields.includes(key)));
      const requiredAction = isFeedbackOnly ? 'feedback' : 'edit';

      const access = await checkCandidateAccess(req.user, row, requiredAction);
      if (!access.authorized) {
        return res.status(403).json({ error: access.error, code: access.code });
      }

      // The schedule and scorecard forms write interview records, so every round keeps its own history.
      let interviews = await loadInterviews(row.id);
      const keep = interview => { interviews = [...interviews.filter(i => i.id == null || i.id !== interview.id), interview]; };
      const ownOpen = interviews.find(i => OPEN_INTERVIEW_STATUSES.includes(i.status) && actorIds(req.user).includes(i.interviewer_id));
      const type = (!canEdit && ownOpen?.type) || INTERVIEW_TYPE_FOR_STAGE[row.stage];
      const slotChanged = interview_date && (!row.interview_date || new Date(row.interview_date).getTime() !== new Date(interview_date).getTime());
      if (type && interview_date && (slotChanged || meet_link !== undefined || interviewer_id !== undefined)) {
        keep(await scheduleInterview(row, { type, interviewerId: canEdit ? interviewer_id || undefined : undefined, scheduledAt: interview_date, meetingUrl: meet_link }, req.user, perms));
      }
      const scorecard = scorecard_notes !== row.scorecard_notes ? parseScorecard(scorecard_notes) : null;
      if (scorecard && type) {
        keep(await completeInterview(row, { type, rating, notes: scorecard.notes, recommendation: scorecard.recommendation }, req.user, perms));
      }

      const note = [remarks, scorecard?.notes].find(value => typeof value === 'string' && value.trim());
      checkStageMove(row, { stage, remarks, scorecard_notes, rejection_reason, interview_date }, { can: perms, interviews });
      if (stageChanges && stage === CEO_STAGE) {
        await recommendToCeo(row, { recommendation: note, monthlySalary: perms.view_salary ? monthly_salary : undefined }, req.user);
        return res.json(redact((await pool.query('SELECT * FROM applicants WHERE id = $1', [id])).rows[0], perms, req.user));
      }

      const newStage = stage !== undefined ? stage : row.stage;
      // Restoring a candidate clears the old rejection, so it is not shown against them any more.
      const isRestore = row.stage === REJECTED_STAGE && newStage !== REJECTED_STAGE;
      const newRejectionReason = rejection_reason !== undefined ? rejection_reason : isRestore ? null : row.rejection_reason;
      const newMonthlySalary = monthly_salary !== undefined && perms.view_salary ? monthly_salary : row.monthly_salary;
      const newRemarks = remarks !== undefined && String(remarks).trim() ? (row.remarks ? `${row.remarks}\n[${new Date().toISOString().slice(0, 10)}] ${remarks}` : remarks) : row.remarks;
      // A plain star rating or note, without a recommendation, is kept on the candidate as before.
      const plainRating = !scorecard && rating !== undefined ? rating : null;
      const plainNotes = !scorecard && scorecard_notes !== undefined ? scorecard_notes : null;

      await pool.query(`
        UPDATE applicants SET stage = $1, rejection_reason = $2, monthly_salary = $3, remarks = $4,
          rating = COALESCE($5, rating), scorecard_notes = COALESCE($6, scorecard_notes)
        WHERE id = $7`, [newStage, newRejectionReason, newMonthlySalary, newRemarks, plainRating, plainNotes, id]);

      if (stageChanges) await afterStageChange(row, newStage, req.user, newStage === REJECTED_STAGE ? newRejectionReason : note || null);
      if (newStage === REJECTED_STAGE && row.stage !== REJECTED_STAGE) {
        await pool.query(
          `INSERT INTO audit_logs (actor_name, action, details)
           VALUES ($1, 'CANDIDATE_REJECTED', $2)`,
          [actor || req.user?.name || 'HR Team', `Archived candidate ${row.name} (${row.job}) - Reason: ${newRejectionReason || 'Evaluation outcome'}`]
        );
      }

      const fresh = await pool.query('SELECT * FROM applicants WHERE id = $1', [id]);
      res.json(redact(fresh.rows[0] || { ...row, stage: newStage }, perms, req.user));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Delete candidate permanently (e.g. spam or purged from Archived Pool)
  app.delete('/api/applicants/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const cur = await pool.query('SELECT * FROM applicants WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Candidate not found' });
      const cand = cur.rows[0];

      const access = await checkCandidateAccess(req.user, cand, 'delete');
      if (!access.authorized) {
        return res.status(403).json({ error: access.error, code: access.code });
      }

      await pool.query('DELETE FROM applicants WHERE id = $1', [id]);
      await scheduleUploadCleanup(req, cand.resume_url);
      await pool.query(
        `INSERT INTO audit_logs (actor_name, action, details)
         VALUES ($1, 'CANDIDATE_DELETED', 'Permanently removed candidate record for ' || $2 || ' (' || $3 || ')')`,
        [req.user?.name || 'HR Admin', cand.name, cand.job]
      );

      res.json({ success: true, message: `Candidate "${cand.name}" permanently removed.` });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Job Requisitions API
  app.get('/api/requisitions', async (req, res) => {
    try {
      const result = await pool.query(req.user ? 'SELECT * FROM job_requisitions ORDER BY id ASC' : "SELECT id,code,department,role,description,requirements,openings,ctc_band,experience,status FROM job_requisitions WHERE status='Active' ORDER BY id ASC");
      res.json(result.rows);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // The people named on a job must be active team members, and their names come from the team record.
  async function jobPeople(body) {
    const people = {};
    if (body.assigned_recruiter_id !== undefined) {
      const owner = body.assigned_recruiter_id ? await activeRecruiter(body.assigned_recruiter_id) : null;
      if (body.assigned_recruiter_id && !owner) throw invalid('Choose an active HR Assistant for this job.');
      Object.assign(people, { assigned_recruiter_id: owner?.id || null, assigned_recruiter_name: owner?.name || null, assigned_recruiter_role: owner?.role_title || null });
    }
    if (body.backup_recruiter_id !== undefined) {
      const backup = body.backup_recruiter_id ? await activeRecruiter(body.backup_recruiter_id) : null;
      if (body.backup_recruiter_id && !backup) throw invalid('Choose an active backup HR Assistant.');
      if (backup && backup.id === (people.assigned_recruiter_id ?? body.assigned_recruiter_id)) throw invalid('The backup must be a different person.');
      people.backup_recruiter_id = backup?.id || null;
    }
    if (body.hiring_manager_id !== undefined) people.hiring_manager_id = body.hiring_manager_id || null;
    return people;
  }

  app.post('/api/requisitions', async (req, res) => {
    try {
      const perms = await getUserEffectivePermissions(req.user);
      if (!perms.create_jobs) return res.status(403).json({ error: 'You do not have permission to create jobs.' });
      const { description, requirements } = req.body;
      const job = validateRequisition(req.body);
      if (job.status && job.status !== 'Hidden' && !perms.publish_jobs) job.status = 'Hidden';

      // The sequence never repeats, so a deleted job's code is not given to a new job.
      let finalCode = job.code;
      const deptShort = job.department.substring(0, 3).toUpperCase();
      for (let tries = 0; !finalCode && tries < 50; tries++) {
        const next = await pool.query("SELECT nextval(pg_get_serial_sequence('job_requisitions','id')) AS n");
        const candidateCode = `REQ-${deptShort}-${String(next.rows[0].n).padStart(2, '0')}`;
        const taken = await pool.query('SELECT 1 FROM job_requisitions WHERE code = $1', [candidateCode]);
        if (taken.rowCount === 0) finalCode = candidateCode;
      }
      if (!finalCode) throw invalid('A job code could not be created. Please try again.', 409);

      const people = await jobPeople(req.body);
      const insertRes = await pool.query(`
        INSERT INTO job_requisitions
        (code, role, department, openings, filled, ctc_band, experience, hiring_manager, assigned_recruiter_id, assigned_recruiter_name, assigned_recruiter_role, status, priority, description, backup_recruiter_id, hiring_manager_id, requirements)
        VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING *
      `, [
        finalCode,
        job.role,
        job.department,
        job.openings ?? 1,
        job.ctc_band || 'As per approved budget',
        job.experience || 'Not specified',
        job.hiring_manager || req.user.name,
        people.assigned_recruiter_id || null,
        people.assigned_recruiter_name || null,
        people.assigned_recruiter_role || null,
        job.status || (perms.publish_jobs ? 'Active' : 'Hidden'),
        job.priority || 'Normal',
        description || '',
        people.backup_recruiter_id || null,
        people.hiring_manager_id || null,
        typeof requirements === 'string' ? requirements.trim() : null
      ]);

      res.status(201).json(insertRes.rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'That job code is already used.' });
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  const updateRequisitionHandler = async (req, res) => {
    try {
      const { id } = req.params;
      const found = await pool.query('SELECT * FROM job_requisitions WHERE id::text = $1 OR code = $1', [id]);
      if (found.rowCount === 0) return res.status(404).json({ error: 'Requisition not found' });
      const perms = await getUserEffectivePermissions(req.user);
      const sent = Object.keys(req.body).filter(key => !['actor', 'editorName', 'reviewerName', 'posted_by'].includes(key));
      const statusChanges = req.body.status !== undefined && req.body.status !== found.rows[0].status;
      // Showing or hiding a job is its own permission; everything else on a job needs edit rights.
      if (statusChanges && !perms.publish_jobs) return res.status(403).json({ error: 'You do not have permission to publish or hide jobs.' });
      if (!perms.edit_jobs && !sent.every(key => key === 'status')) return res.status(403).json({ error: 'You do not have permission to edit jobs.' });
      const job = validateRequisition(req.body, found.rows[0]);
      const { description, requirements } = req.body;

      const updates = [];
      const values = [];
      let idx = 1;

      for (const [field, value] of Object.entries({ ...job, ...await jobPeople(req.body) })) { updates.push(`${field} = $${idx++}`); values.push(value); }
      if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
      if (requirements !== undefined) { updates.push(`requirements = $${idx++}`); values.push(requirements); }

      if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

      values.push(id);
      const result = await pool.query(
        `UPDATE job_requisitions SET ${updates.join(', ')} WHERE (id::text = $${idx} OR code = $${idx}) RETURNING *`,
        values
      );
      if (result.rowCount === 0) return res.status(404).json({ error: 'Requisition not found' });
      if (job.role && job.role !== found.rows[0].role) await pool.query('UPDATE applicants SET job = $1 WHERE job_id = $2', [job.role, result.rows[0].id]);
      res.json(result.rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'That job code is already used.' });
      res.status(err.status || 500).json({ error: err.message });
    }
  };

  app.put('/api/requisitions/:id', updateRequisitionHandler);
  app.patch('/api/requisitions/:id', updateRequisitionHandler);

  app.delete('/api/requisitions/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!(await getUserEffectivePermissions(req.user)).edit_jobs) return res.status(403).json({ error: 'You do not have permission to delete jobs.' });
      const found = await pool.query('SELECT id, role FROM job_requisitions WHERE id::text = $1 OR code = $1', [id]);
      if (found.rowCount === 0) return res.status(404).json({ error: 'Requisition not found' });
      const linked = await pool.query('SELECT COUNT(*)::int AS n FROM applicants WHERE job_id = $1 OR (job_id IS NULL AND job = $2)', [found.rows[0].id, found.rows[0].role]);
      if (linked.rows[0].n > 0) return res.status(409).json({ error: `This job has ${linked.rows[0].n} candidate(s), so it cannot be deleted. Hide it or set its status to Closed.` });
      const result = await pool.query('DELETE FROM job_requisitions WHERE (id::text = $1 OR code = $1) RETURNING *', [id]);
      res.json({ success: true, message: `Requisition ${result.rows[0].code || id} deleted.` });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Recruitment Team & Recruiter Statistics API
  app.get('/api/recruiters', async (req, res) => {
    try {
      const perms = await getUserEffectivePermissions(req.user);
      const canSeeContact = Boolean(perms.manage_ats_users);
      const stripPrivateFields = row => {
        if (canSeeContact) return row;
        const { email, phone, ...safe } = row;
        return safe;
      };

      const teamRes = await pool.query(`
        SELECT rt.*
        FROM recruitment_team rt
        WHERE COALESCE(rt.has_ats_access, TRUE) IS TRUE
           OR EXISTS (
             SELECT 1 FROM applicants a
             WHERE a.assigned_recruiter_id = rt.id
               AND a.stage <> 'Rejected'
               AND a.promoted_employee_id IS NULL
           )
        ORDER BY rt.is_head DESC, rt.id ASC
      `);
      const appRes = await pool.query("SELECT * FROM applicants WHERE stage != 'Rejected'");
      const reqRes = await pool.query("SELECT * FROM job_requisitions WHERE status = 'Active'");

      const allApplicants = appRes.rows;
      const allRequisitions = reqRes.rows;

      const isInterview = a => INTERVIEW_STAGES.includes(a.stage);
      const isOffer = a => a.stage === APPROVED_STAGE;

      const enriched = teamRes.rows.map(rec => {
        const base = stripPrivateFields(rec);
        if (rec.is_head) {
          return {
            ...base,
            activeOpenings: allRequisitions.reduce((sum, r) => sum + (Number(r.openings) - Number(r.filled)), 0),
            totalHeadcountTarget: allRequisitions.reduce((sum, r) => sum + Number(r.openings), 0),
            totalHired: allRequisitions.reduce((sum, r) => sum + Number(r.filled), 0),
            pipelineCandidates: allApplicants.length,
            interviewsCount: allApplicants.filter(isInterview).length,
            offersCount: allApplicants.filter(isOffer).length,
            assignedRequisitions: allRequisitions
          };
        } else {
          const deptApps = allApplicants.filter(a => a.assigned_recruiter_id === rec.id);
          const deptReqs = allRequisitions.filter(r => r.assigned_recruiter_id === rec.id || r.backup_recruiter_id === rec.id);

          return {
            ...base,
            activeOpenings: deptReqs.reduce((sum, r) => sum + (Number(r.openings) - Number(r.filled)), 0),
            totalHeadcountTarget: deptReqs.reduce((sum, r) => sum + Number(r.openings), 0),
            totalHired: deptReqs.reduce((sum, r) => sum + Number(r.filled), 0),
            pipelineCandidates: deptApps.length,
            interviewsCount: deptApps.filter(isInterview).length,
            offersCount: deptApps.filter(isOffer).length,
            assignedRequisitions: deptReqs
          };
        }
      });

      res.json(enriched);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // 1-Click Export Candidate Pipeline to CSV
  app.get('/api/export/applicants', async (req, res) => {
    try {
      const access = await checkCandidateAccess(req.user, null, 'export');
      if (!access.authorized) {
        return res.status(403).json({ error: `Access Denied: ${access.error}` });
      }

      const { limit, offset } = parsePagination(req.query, { defaultLimit: 5000, maxLimit: 10000 });
      const { clause, params } = await buildCandidateScopeFilter(req.user);
      const queryParams = [...params];
      let dateFilter = '';
      if (req.query.from || req.query.to) {
        const { from, to } = parseDateRange(req.query, {
          defaultDays: 366,
          maxDays: 366,
          anchorDate: new Date().toISOString().slice(0, 10)
        });
        queryParams.push(from, to);
        dateFilter = ` AND created_at::date BETWEEN $${queryParams.length - 1}::date AND $${queryParams.length}::date`;
      }
      queryParams.push(limit, offset);
      const result = await pool.query(
        `SELECT * FROM applicants WHERE ${clause}${dateFilter} ORDER BY id ASC LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
        queryParams
      );

      let csv = '\uFEFF'; // UTF-8 BOM
      csv += 'Candidate ID,Full Name,Applied Role,Department,Assigned HR Assistant,Stage,Email,Phone,Experience,Notice Period,Source,Rating (out of 5),Scorecard Notes,Applied Date\n';

      result.rows.forEach(r => {
        const cleanName = (r.name || '');
        const cleanJob = (r.job || '');
        const cleanDept = (r.department || '');
        const cleanHR = (r.assigned_recruiter_name || '');
        const cleanEmail = (r.email || '');
        const cleanPhone = (r.phone || '');
        const cleanNotes = (r.scorecard_notes || '');
        const cleanDate = r.created_at ? new Date(r.created_at).toLocaleDateString() : '';

        csv += [String(r.id).padStart(3, '0'),cleanName,cleanJob,cleanDept,cleanHR,r.stage,cleanEmail,cleanPhone,r.experience || '',r.notice_period || '',r.source || 'Direct',r.rating || 0,cleanNotes,cleanDate].map(csvCell).join(',') + '\n';
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="femovo_candidate_pipeline.csv"');
      res.send(csv);
    } catch (err) {
      res.status(500).json({ error: 'The export could not be completed.' });
    }
  });

  // 1-Click Bulk Import Candidates from CSV/JSON
  app.post('/api/import/applicants', async (req, res) => {
    try {
      const access = await checkCandidateAccess(req.user, null, 'create');
      if (!access.authorized) {
        return res.status(403).json({ error: access.error, code: access.code });
      }

      const { candidates } = req.body;
      if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 200) {
        return res.status(400).json({ error: 'Provide between 1 and 200 candidate records.' });
      }

      const perms = await getUserEffectivePermissions(req.user);
      if (!perms.view_all_candidates) {
        return res.status(403).json({ error: 'Access denied. Bulk CSV Import is restricted to people who can see all candidates.', code: 'FORBIDDEN_ACTION' });
      }
      const submittedBy = req.user.employeeId || req.user.recruiterId;
      const resolveBatchOwner = await loadOwnerResolver();
      const jobCache = new Map();
      const recruiterCache = new Map();

      const inserted = [];
      for (const c of candidates) {
        const jobTitle = c.job || c.role;
        if (typeof c.name !== 'string' || !c.name.trim() || typeof jobTitle !== 'string' || !jobTitle.trim() || typeof c.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw invalid('Each imported candidate needs a name, job and valid email. No records were imported.');

        const jobKey = jobTitle.trim().toLowerCase();
        let jobRow = jobCache.get(jobKey);
        if (jobRow === undefined) {
          jobRow = await jobForTitle(jobTitle);
          jobCache.set(jobKey, jobRow);
        }
        const finalDept = jobRow?.department || c.department || null;
        let owner = null;
        if (c.assigned_recruiter_id && perms.assign_candidates) {
          if (!recruiterCache.has(c.assigned_recruiter_id)) {
            recruiterCache.set(c.assigned_recruiter_id, await activeRecruiter(c.assigned_recruiter_id));
          }
          owner = recruiterCache.get(c.assigned_recruiter_id);
        }
        if (!owner) owner = resolveBatchOwner({ id: jobRow?.id ?? null, role: jobRow?.role || jobTitle, department: finalDept, assigned_recruiter_id: jobRow?.assigned_recruiter_id, backup_recruiter_id: jobRow?.backup_recruiter_id });

        const r = await pool.query(`
          INSERT INTO applicants
          (name, job, stage, email, phone, experience, current_ctc, expected_ctc, notice_period, source, department, assigned_recruiter_id, assigned_recruiter_name, submitted_by_user_id, job_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING *
        `, [
          c.name.trim(),
          jobTitle.trim(),
          FIRST_STAGE,
          c.email.trim().toLowerCase(),
          c.phone || null,
          c.experience || null,
          c.current_ctc || null,
          c.expected_ctc || null,
          c.notice_period || null,
          c.source || 'Bulk CSV Import',
          finalDept,
          owner?.id || null,
          owner?.name || null,
          submittedBy,
          jobRow?.id ?? null
        ]);
        inserted.push(r.rows[0]);
        await recordEvent(r.rows[0].id, 'stage', { to: FIRST_STAGE, remarks: 'Imported from CSV' }, req.user);
        await announceOwner(r.rows[0], owner, req.user);
      }

      await pool.query(
        'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
        [req.user?.name || 'Head HR', 'BULK_IMPORT_APPLICANTS', `Bulk imported ${inserted.length} candidates`]
      );

      res.status(201).json({
        message: `Successfully imported ${inserted.length} candidates`,
        count: inserted.length,
        candidates: inserted.map(row => redact(row, perms, req.user))
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ==========================================
  // 27. RECRUITMENT ATS TALENT RESOURCE MANAGEMENT
  // ==========================================

  // Get all recruitment resources
  app.get('/api/recruitment/team', async (req, res) => {
    try {
      const perms = await getUserEffectivePermissions(req.user);
      if (!perms.manage_ats_users) {
        return res.status(403).json({ error: 'Access denied. Only administrators can view the full recruitment team directory.', code: 'FORBIDDEN' });
      }
      const result = await pool.query('SELECT * FROM recruitment_team ORDER BY id');
      res.json(result.rows);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/ats/resources', async (req, res) => {
    try {
      const { search = '', department = 'All', role = 'All', status = 'All' } = req.query;

      const teamQuery = `
        SELECT 
          rt.*,
          ar.name as ats_role_name,
          ar.badge_color,
          (SELECT COUNT(*) FROM applicants a WHERE a.assigned_recruiter_id = rt.id AND a.stage != 'Rejected') as active_candidates,
          (SELECT COUNT(*) FROM applicants a WHERE a.assigned_recruiter_id = rt.id AND a.stage IN ('Screening', 'HR L1', 'Head HR Round')) as active_interviews
        FROM recruitment_team rt
        LEFT JOIN ats_roles ar ON ar.id = rt.ats_role
        ORDER BY 
          CASE 
            WHEN rt.ats_role IN ('ceo', 'exec_sponsor') THEN 1
            WHEN rt.ats_role = 'rec_lead' THEN 2
            WHEN rt.ats_role = 'rec_associate' THEN 3
            WHEN rt.ats_role = 'hiring_manager' THEN 4
            WHEN rt.ats_role = 'external_agency' THEN 5
            ELSE 6
          END,
          rt.id ASC
      `;
      const result = await pool.query(teamQuery);
      const allResources = result.rows;

      // Filter in-memory
      let filtered = allResources;
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        filtered = filtered.filter(r => 
          (r.name && r.name.toLowerCase().includes(q)) ||
          (r.role_title && r.role_title.toLowerCase().includes(q)) ||
          (r.department && r.department.toLowerCase().includes(q)) ||
          (r.sourcing_tag && r.sourcing_tag.toLowerCase().includes(q)) ||
          (r.email && r.email.toLowerCase().includes(q))
        );
      }

      if (department && department !== 'All') {
        filtered = filtered.filter(r => r.department === department);
      }

      if (role && role !== 'All') {
        filtered = filtered.filter(r => r.ats_role === role || r.ats_role_name === role);
      }

      if (status && status !== 'All') {
        if (status === 'Active') filtered = filtered.filter(r => r.has_ats_access !== false && r.status !== 'Inactive');
        else if (status === 'Revoked') filtered = filtered.filter(r => r.has_ats_access === false || r.status === 'Inactive');
      }

      // High level metrics
      const totalResources = allResources.length;
      const activeLeadRecruiters = allResources.filter(r => r.ats_role === 'rec_lead' || r.ats_role === 'rec_associate' || r.ats_role === 'exec_sponsor').length;
      const certifiedInterviewers = allResources.filter(r => r.ats_role === 'hiring_manager').length;
      const agencyPartners = allResources.filter(r => r.ats_role === 'external_agency').length;
      const totalActiveVacancies = allResources.reduce((acc, curr) => acc + (parseInt(curr.active_vacancies, 10) || 0), 0);

      res.json({
        totalResources,
        activeLeadRecruiters,
        certifiedInterviewers,
        agencyPartners,
        totalActiveVacancies,
        resources: filtered
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Add new recruitment resource
  const loginRoleForAtsRole = atsRole => atsRole === 'hiring_manager' ? 'interviewer' : 'recruiter';
  function assertCanManage(user, ...roles) {
    if (user.role === 'super_admin') return;
    const mine = roleRank(resolveAtsRole(user));
    if (roles.some(role => roleRank(role) >= mine)) throw invalid('You cannot add or change a person at your own level or above.', 403);
  }

  app.post('/api/ats/resources', async (req, res) => {
    try {
      const { name, role_title, department, email, phone, sourcing_tag, max_candidate_capacity, specialization, editorName } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
      const ats_role = readAtsRole(req.body.ats_role, 'rec_associate');
      assertCanManage(req.user, ats_role);

      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('A valid email is required for a recruitment account.');
      const existing = await pool.query('SELECT 1 FROM user_accounts WHERE LOWER(email) = LOWER($1)', [email.trim()]);
      if (existing.rowCount > 0) throw invalid('An account with this email already exists.', 409);
      await pool.query("SELECT pg_advisory_xact_lock(hashtext('recruiter-id-allocation'))");
      const countRes = await pool.query("SELECT COALESCE(MAX(substring(id from 5)::bigint),0) AS max_id FROM recruitment_team WHERE id ~ '^(REC|INT|AGY)-[0-9]+$'");
      const nextNum = Number(countRes.rows[0].max_id) + 1;
      const prefix = (ats_role === 'hiring_manager') ? 'INT' : (ats_role === 'external_agency') ? 'AGY' : 'REC';
      const newId = `${prefix}-${String(nextNum).padStart(3, '0')}`;

      const initials = name.trim().split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();

      const insertRes = await pool.query(`
        INSERT INTO recruitment_team (id, name, role_title, department, reports_to, is_head, email, phone, avatar_initials, specialization, active_vacancies, has_ats_access, ats_role, sourcing_tag, max_candidate_capacity, status, employee_id, reports_to_id)
        VALUES ($1, $2, $3, $4, '', $9::varchar = 'rec_lead', $5, $6, $7, $8, 0, true, $9, $10, $11, 'Active', $12, $13)
        RETURNING *
      `, [
        newId,
        name.trim(),
        role_title || 'Recruitment Associate',
        department || 'General Operations & Administration',
        email.trim().toLowerCase(),
        phone || '',
        initials,
        specialization || 'Department Talent Acquisition',
        ats_role || 'rec_associate',
        sourcing_tag || `${name.trim().split(' ')[0].toUpperCase()}-TAG`,
        parseInt(max_candidate_capacity, 10) || 20,
        req.body.employee_id || null,
        req.body.reports_to_id || null
      ]);

      const empRole = loginRoleForAtsRole(ats_role);
      await pool.query(`
        INSERT INTO employees (id, name, department, role, designation, manager_id, status, attendance, email, phone, access_role, has_dashboard_access, user_type)
        VALUES ($1, $2, $3, $4, $4, $5, 'Active', 'Present', $6, $7, $8, true, 'Staff')
        ON CONFLICT (id) DO NOTHING
      `, [newId, name.trim(), department || 'General Operations & Administration', role_title || 'Recruitment Associate', req.body.reports_to_id || null, email.trim().toLowerCase(), phone || '', empRole]);

      await pool.query(`UPDATE recruitment_team SET employee_id = COALESCE(employee_id, $1) WHERE id = $1`, [newId]);

      await pool.query(`INSERT INTO user_accounts(employee_id,recruiter_id,email,pin,name,role,ats_role,department,role_title,avatar,is_head_hr)
        VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$6::varchar = 'rec_lead')`,
        [newId,email.trim().toLowerCase(),await hashPin(crypto.randomBytes(32).toString('hex')),name.trim(),empRole,ats_role||'rec_associate',department||'General Operations & Administration',role_title||'Recruitment Associate',initials]);

      await pool.query(
        'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
        [req.user?.name || editorName || 'Administrator', 'CREATE_ATS_RESOURCE', `Added new ATS recruitment resource: ${name.trim()} (${newId}) with role ${ats_role}`]
      );

      res.status(201).json(insertRes.rows[0]);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Update recruitment resource
  app.put('/api/ats/resources/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name, role_title, department, email, phone, sourcing_tag, max_candidate_capacity, specialization, has_ats_access, status, editorName } = req.body;

      const checkRes = await pool.query('SELECT * FROM recruitment_team WHERE id = $1', [id]);
      if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Recruitment resource not found' });
      const ats_role = readAtsRole(req.body.ats_role, checkRes.rows[0].ats_role);
      assertCanManage(req.user, checkRes.rows[0].ats_role, ats_role);

      const updateRes = await pool.query(`
        UPDATE recruitment_team SET
          name = COALESCE($1, name),
          role_title = COALESCE($2, role_title),
          department = COALESCE($3, department),
          email = COALESCE($4, email),
          phone = COALESCE($5, phone),
          ats_role = COALESCE($6, ats_role),
          sourcing_tag = COALESCE($7, sourcing_tag),
          max_candidate_capacity = COALESCE($8, max_candidate_capacity),
          specialization = COALESCE($9, specialization),
          has_ats_access = COALESCE($10, has_ats_access),
          status = COALESCE($11, status),
          is_head = CASE WHEN $6::varchar = 'rec_lead' THEN TRUE WHEN ats_role = 'rec_lead' THEN FALSE ELSE is_head END,
          employee_id = COALESCE($13, employee_id),
          reports_to_id = COALESCE($14, reports_to_id)
        WHERE id = $12
        RETURNING *
      `, [name, role_title, department, email, phone, ats_role, sourcing_tag, max_candidate_capacity, specialization, has_ats_access, status, id, req.body.employee_id ?? null, req.body.reports_to_id ?? null]);

      const resource = updateRes.rows[0];
      // Only recruiter-type logins follow the ATS role, so an HR or admin account is never downgraded here.
      await pool.query("UPDATE user_accounts SET name=$1,email=$2,ats_role=$3,department=$4,role_title=$5,role=CASE WHEN role IN ('recruiter','interviewer') THEN $7 ELSE role END,is_head_hr=CASE WHEN role IN ('recruiter','interviewer') THEN $3::varchar = 'rec_lead' ELSE is_head_hr END,updated_at=NOW() WHERE recruiter_id=$6",
        [resource.name,resource.email.trim().toLowerCase(),resource.ats_role,resource.department,resource.role_title,id,loginRoleForAtsRole(resource.ats_role)]);
      if (resource.employee_id) {
        await pool.query("UPDATE employees SET name=$1,email=$2,phone=$3,department=$4,status=$5 WHERE id=$6",
          [resource.name, resource.email.trim().toLowerCase(), resource.phone || '', resource.department, resource.status === 'Inactive' ? 'Inactive' : 'Active', resource.employee_id]);
      }

      await pool.query(
        'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
        [req.user?.name || editorName || 'Administrator', 'UPDATE_ATS_RESOURCE', `Updated talent resource details for: ${name || checkRes.rows[0].name} (${id})`]
      );

      // A person who can no longer work still owns candidates until someone reassigns them.
      const left = resource.status === 'Inactive' || resource.has_ats_access === false
        ? (await pool.query("SELECT COUNT(*)::int AS n FROM applicants WHERE assigned_recruiter_id = $1 AND promoted_employee_id IS NULL AND stage <> 'Rejected'", [id])).rows[0]?.n || 0 : 0;
      res.json({ ...updateRes.rows[0], candidates_to_reassign: left });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Toggle ATS portal access
  app.patch('/api/ats/resources/:id/revoke-access', async (req, res) => {
    try {
      const { id } = req.params;
      const { has_ats_access, editorName } = req.body;

      const checkRes = await pool.query('SELECT * FROM recruitment_team WHERE id = $1', [id]);
      if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Resource not found' });
      assertCanManage(req.user, checkRes.rows[0].ats_role);

      const updateRes = await pool.query(
        'UPDATE recruitment_team SET has_ats_access = $1 WHERE id = $2 RETURNING *',
        [Boolean(has_ats_access), id]
      );

      const actionType = has_ats_access ? 'GRANT_ATS_ACCESS' : 'REVOKE_ATS_ACCESS';
      const actionDesc = has_ats_access 
        ? `Restored ATS portal access for "${checkRes.rows[0].name}"` 
        : `Revoked ATS portal access for "${checkRes.rows[0].name}"`;

      await pool.query(
        'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
        [req.user?.name || editorName || 'Administrator', actionType, actionDesc]
      );

      res.json({ success: true, message: actionDesc, resource: updateRes.rows[0] });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Deactivate ATS resource
  app.delete('/api/ats/resources/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { editorName } = req.body || {};
      const checkRes = await pool.query('SELECT * FROM recruitment_team WHERE id = $1', [id]);
      if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Resource not found' });

      assertCanManage(req.user, checkRes.rows[0].ats_role);

      const updateRes = await pool.query(
        "UPDATE recruitment_team SET status = 'Inactive', has_ats_access = false WHERE id = $1 RETURNING *",
        [id]
      );

      await pool.query(
        'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
        [req.user?.name || editorName || 'Administrator', 'DEACTIVATE_ATS_RESOURCE', `Deactivated ATS recruitment resource: ${checkRes.rows[0].name} (${id})`]
      );

      res.json({ success: true, message: `Resource ${checkRes.rows[0].name} deactivated.`, resource: updateRes.rows[0] });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
