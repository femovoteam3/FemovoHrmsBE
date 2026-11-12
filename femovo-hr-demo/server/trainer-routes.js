import { pool } from './db.js';
import { businessDate } from './config.js';
import { invalid, parseDate } from './domain.js';

const SESSION_TYPES = ['Yoga', 'Zumba', 'Face Yoga', 'Meditation', 'Pilates', 'Pranayama', 'Wellness'];
const PAYMENT_MODELS = ['fixed_monthly', 'per_session'];
const SESSION_KINDS = ['scheduled', 'extra', 'replacement'];
const SESSION_STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'Missed', 'Leave'];
const APPROVAL_STATUSES = ['Pending', 'Approved', 'Paid'];

function cleanText(value, label, max, required = true) {
  const str = value === undefined || value === null ? '' : String(value).trim();
  if (!str) {
    if (required) throw invalid(`${label} is required.`);
    return null;
  }
  if (str.length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
  return str;
}

function cleanMoney(value, label, defaultVal = 0) {
  if (value === undefined || value === null || value === '') return defaultVal;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 10_000_000) {
    throw invalid(`${label} must be a valid amount between 0 and 10,000,000.`);
  }
  return Math.round(num * 100) / 100;
}

function cleanDaysOfWeek(days) {
  if (!Array.isArray(days) || days.length === 0) {
    throw invalid('Select at least one day of the week.');
  }
  const unique = [...new Set(days.map(Number))];
  if (unique.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw invalid('Days of week must be integers between 0 (Sun) and 6 (Sat).');
  }
  return unique.sort((a, b) => a - b);
}

function cleanTime(value) {
  const str = cleanText(value, 'Start time', 10, true);
  if (!/^\d{2}:\d{2}$/.test(str)) throw invalid('Start time must use HH:MM format.');
  const [h, m] = str.split(':').map(Number);
  if (h > 23 || m > 59) throw invalid('Enter a valid time of day.');
  return str;
}

function cleanMonth(value) {
  const raw = value ? String(value).trim() : businessDate().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw invalid('Month must use YYYY-MM format.');
  return raw;
}

function formatDateYmd(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

async function ensureEmployeeExists(employeeId, label = 'Trainer') {
  const id = cleanText(employeeId, label, 50, true);
  const res = await pool.query('SELECT id, name, department, role FROM employees WHERE id = $1', [id]);
  if (!res.rowCount) throw invalid(`${label} not found.`, 404);
  return res.rows[0];
}

async function loadTrainerOverviewData({ month, scope }) {
  const [y, m] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;

  const [staffRes, schedRes, sessRes, appRes] = await Promise.all([
    pool.query(`
      SELECT id, name, department, role, designation, access_role, status
      FROM employees
      WHERE status NOT IN ('Inactive', 'Exited', 'Terminated')
      ORDER BY
        CASE WHEN LOWER(COALESCE(role, '') || ' ' || COALESCE(department, '')) ~ '(trainer|yoga|zumba|wellness|fitness|training)' THEN 0 ELSE 1 END,
        name ASC
    `),
    pool.query(`
      SELECT ts.*, e.name AS trainer_name, e.department AS trainer_department, e.role AS trainer_role
      FROM trainer_schedules ts
      JOIN employees e ON e.id = ts.trainer_id
      WHERE ($1::text IS NULL OR ts.trainer_id = $1)
      ORDER BY ts.active DESC, ts.start_time ASC, ts.id ASC
    `, [scope]),
    pool.query(`
      SELECT s.*,
        sch.payment_model AS schedule_payment_model,
        ea.name AS assigned_trainer_name,
        ec.name AS conducted_by_name,
        er.name AS replacement_trainer_name
      FROM trainer_sessions s
      LEFT JOIN trainer_schedules sch ON sch.id = s.schedule_id
      JOIN employees ea ON ea.id = s.assigned_trainer_id
      LEFT JOIN employees ec ON ec.id = s.conducted_by_trainer_id
      LEFT JOIN employees er ON er.id = s.replacement_trainer_id
      WHERE s.session_date BETWEEN $1 AND $2
        AND ($3::text IS NULL OR s.assigned_trainer_id = $3 OR s.replacement_trainer_id = $3 OR s.conducted_by_trainer_id = $3)
      ORDER BY s.session_date DESC, s.start_time ASC, s.id DESC
    `, [monthStart, monthEnd, scope]),
    pool.query(`
      SELECT * FROM trainer_monthly_approvals
      WHERE month = $1 AND ($2::text IS NULL OR trainer_id = $2)
    `, [month, scope])
  ]);

  return {
    staff: staffRes.rows,
    schedules: schedRes.rows,
    sessions: sessRes.rows,
    approvals: appRes.rows
  };
}

function computePayoutSummaries({ month, scope, staff, schedules, sessions, approvals }) {
  const scheduleById = new Map(schedules.map(s => [s.id, s]));
  const trainerIds = new Set();

  for (const s of schedules) {
    if (s.active) trainerIds.add(s.trainer_id);
  }
  for (const sess of sessions) {
    trainerIds.add(sess.assigned_trainer_id);
    if (sess.replacement_trainer_id) trainerIds.add(sess.replacement_trainer_id);
  }

  const summaries = [];
  for (const trainerId of trainerIds) {
    if (scope && trainerId !== scope) continue;
    const person = staff.find(e => e.id === trainerId);
    if (!person) continue;

    const trainerSchedules = schedules.filter(s => s.trainer_id === trainerId && s.active);
    const fixedMonthly = trainerSchedules
      .filter(s => s.payment_model === 'fixed_monthly')
      .reduce((sum, s) => sum + Number(s.rate_amount || 0), 0);

    let perSessionPay = 0;
    let extraPay = 0;
    let replacementPay = 0;
    let adjustments = 0;

    let scheduledCount = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let missedCount = 0;
    let leaveCount = 0;
    let extraCount = 0;
    let replacementCount = 0;

    const breakdown = [];

    for (const sess of sessions) {
      const isPrimary = sess.assigned_trainer_id === trainerId;
      const isReplacement = sess.replacement_trainer_id === trainerId;
      if (!isPrimary && !isReplacement) continue;

      const dateStr = formatDateYmd(sess.session_date);

      if (isPrimary) {
        if (sess.session_kind === 'extra') extraCount += 1;
        else scheduledCount += 1;

        if (sess.status === 'Completed') completedCount += 1;
        else if (sess.status === 'Cancelled') cancelledCount += 1;
        else if (sess.status === 'Missed') missedCount += 1;
        else if (sess.status === 'Leave') leaveCount += 1;

        const sched = sess.schedule_id ? scheduleById.get(sess.schedule_id) : null;
        const pay = Number(sess.payment_amount || 0);
        const deduction = Number(sess.deduction_amount || 0);
        let netLine = 0;

        if (sess.session_kind === 'extra' && sess.status === 'Completed') {
          extraPay += pay;
          netLine += pay;
        } else if (sess.session_kind === 'replacement' && sess.status === 'Completed') {
          replacementPay += pay;
          netLine += pay;
        } else if (sess.session_kind === 'scheduled' && sess.status === 'Completed') {
          // Fixed-monthly scheduled sessions pay ₹0 per-session because base monthly pay covers them.
          const isPerSession = sched ? sched.payment_model === 'per_session' : pay > 0;
          if (isPerSession && (!sess.conducted_by_trainer_id || sess.conducted_by_trainer_id === trainerId)) {
            perSessionPay += pay;
            netLine += pay;
          }
        }

        if (deduction > 0 && ['Leave', 'Missed', 'Cancelled'].includes(sess.status)) {
          adjustments += deduction;
          netLine -= deduction;
        }

        breakdown.push({
          id: sess.id,
          date: dateStr,
          start_time: sess.start_time,
          batch_name: sess.batch_name,
          session_type: sess.session_type,
          kind: sess.session_kind,
          role_in_session: 'Assigned',
          status: sess.status,
          conducted_by: sess.conducted_by_name || (sess.status === 'Completed' ? person.name : '—'),
          amount: Math.round(netLine * 100) / 100
        });
      }

      if (isReplacement && !isPrimary) {
        const isCovered = ['Completed', 'Leave'].includes(sess.status);
        if (isCovered) replacementCount += 1;
        const repPay = isCovered ? Number(sess.replacement_pay || 0) : 0;
        if (repPay > 0) replacementPay += repPay;

        breakdown.push({
          id: `${sess.id}-rep`,
          date: dateStr,
          start_time: sess.start_time,
          batch_name: sess.batch_name,
          session_type: sess.session_type,
          kind: 'replacement',
          role_in_session: `Replacement (for ${sess.assigned_trainer_name})`,
          status: sess.status === 'Leave' ? 'Covered' : sess.status,
          conducted_by: person.name,
          amount: Math.round(repPay * 100) / 100
        });
      }
    }

    const netPayable = Math.max(0, Math.round((fixedMonthly + perSessionPay + extraPay + replacementPay - adjustments) * 100) / 100);
    const approval = approvals.find(a => a.trainer_id === trainerId && a.month === month) || null;

    summaries.push({
      trainer_id: trainerId,
      trainer_name: person.name,
      department: person.department,
      role: person.role,
      fixed_monthly: Math.round(fixedMonthly * 100) / 100,
      per_session_pay: Math.round(perSessionPay * 100) / 100,
      extra_pay: Math.round(extraPay * 100) / 100,
      replacement_pay: Math.round(replacementPay * 100) / 100,
      adjustments: Math.round(adjustments * 100) / 100,
      net_payable: netPayable,
      counts: {
        scheduled: scheduledCount,
        completed: completedCount,
        cancelled: cancelledCount,
        missed: missedCount,
        leave: leaveCount,
        extra: extraCount,
        replacement: replacementCount
      },
      approval,
      breakdown: breakdown.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time))
    });
  }

  return summaries.sort((a, b) => a.trainer_name.localeCompare(b.trainer_name));
}

export function registerTrainerRoutes(app) {
  app.get('/api/trainers/overview', async (req, res) => {
    try {
      const month = cleanMonth(req.query.month);
      const { canManage, scope } = req.trainerAccess;
      const { staff, schedules, sessions, approvals } = await loadTrainerOverviewData({ month, scope });

      const payoutSummary = computePayoutSummaries({
        month,
        scope,
        staff,
        schedules,
        sessions,
        approvals
      });

      res.json({
        month,
        canManage,
        sessionTypes: SESSION_TYPES,
        staff,
        schedules,
        sessions,
        payoutSummary
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/trainers/schedules', async (req, res) => {
    try {
      const trainer = await ensureEmployeeExists(req.body.trainer_id, 'Trainer');
      const batchName = cleanText(req.body.batch_name, 'Batch name', 150, true);
      const sessionType = cleanText(req.body.session_type, 'Session type', 60, true);
      const days = cleanDaysOfWeek(req.body.days_of_week);
      const startTime = cleanTime(req.body.start_time);
      const durationMinutes = req.body.duration_minutes === undefined ? 60 : Number(req.body.duration_minutes);
      if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
        throw invalid('Duration must be between 15 and 480 minutes.');
      }
      const paymentModel = req.body.payment_model;
      if (!PAYMENT_MODELS.includes(paymentModel)) {
        throw invalid('Select a valid payment model (fixed_monthly or per_session).');
      }
      const rateAmount = cleanMoney(req.body.rate_amount, 'Payment amount', 0);
      const notes = cleanText(req.body.notes, 'Notes', 1000, false);

      const created = await pool.query(`
        INSERT INTO trainer_schedules (
          trainer_id, batch_name, session_type, days_of_week, start_time, duration_minutes,
          payment_model, rate_amount, active, notes, created_by
        ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, TRUE, $9, $10)
        RETURNING *
      `, [trainer.id, batchName, sessionType, JSON.stringify(days), startTime, durationMinutes, paymentModel, rateAmount, notes, req.user.name]);

      res.status(201).json(created.rows[0]);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.put('/api/trainers/schedules/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw invalid('Invalid schedule id.');
      const cur = await pool.query('SELECT * FROM trainer_schedules WHERE id = $1', [id]);
      if (!cur.rowCount) throw invalid('Schedule not found.', 404);
      const row = cur.rows[0];

      const trainer = req.body.trainer_id ? await ensureEmployeeExists(req.body.trainer_id, 'Trainer') : { id: row.trainer_id };
      const batchName = req.body.batch_name !== undefined ? cleanText(req.body.batch_name, 'Batch name', 150, true) : row.batch_name;
      const sessionType = req.body.session_type !== undefined ? cleanText(req.body.session_type, 'Session type', 60, true) : row.session_type;
      const days = req.body.days_of_week !== undefined ? cleanDaysOfWeek(req.body.days_of_week) : row.days_of_week;
      const startTime = req.body.start_time !== undefined ? cleanTime(req.body.start_time) : row.start_time;
      const durationMinutes = req.body.duration_minutes !== undefined ? Number(req.body.duration_minutes) : row.duration_minutes;
      if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
        throw invalid('Duration must be between 15 and 480 minutes.');
      }
      const paymentModel = req.body.payment_model !== undefined ? req.body.payment_model : row.payment_model;
      if (!PAYMENT_MODELS.includes(paymentModel)) throw invalid('Invalid payment model.');
      const rateAmount = req.body.rate_amount !== undefined ? cleanMoney(req.body.rate_amount, 'Payment amount', 0) : row.rate_amount;
      const active = req.body.active !== undefined ? Boolean(req.body.active) : row.active;
      const notes = req.body.notes !== undefined ? cleanText(req.body.notes, 'Notes', 1000, false) : row.notes;

      const updated = await pool.query(`
        UPDATE trainer_schedules SET
          trainer_id = $1, batch_name = $2, session_type = $3, days_of_week = $4::jsonb,
          start_time = $5, duration_minutes = $6, payment_model = $7, rate_amount = $8,
          active = $9, notes = $10, updated_at = NOW()
        WHERE id = $11 RETURNING *
      `, [trainer.id, batchName, sessionType, JSON.stringify(days), startTime, durationMinutes, paymentModel, rateAmount, active, notes, id]);

      res.json(updated.rows[0]);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete('/api/trainers/schedules/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw invalid('Invalid schedule id.');
      const del = await pool.query('DELETE FROM trainer_schedules WHERE id = $1 RETURNING id', [id]);
      if (!del.rowCount) throw invalid('Schedule not found.', 404);
      res.json({ deleted: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/trainers/sessions/generate', async (req, res) => {
    try {
      const month = cleanMonth(req.body.month);
      const trainerId = req.body.trainer_id ? cleanText(req.body.trainer_id, 'Trainer', 50, true) : null;
      const [y, m] = month.split('-').map(Number);
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;

      if (trainerId) {
        const paidCheck = await pool.query(
          "SELECT trainer_id FROM trainer_monthly_approvals WHERE month = $1 AND trainer_id = $2 AND status = 'Paid' LIMIT 1",
          [month, trainerId]
        );
        if (paidCheck.rowCount > 0) {
          throw invalid(`Sessions in ${month} cannot be generated after payout is marked Paid.`, 409);
        }
      }

      const ins = await pool.query(`
        INSERT INTO trainer_sessions (
          schedule_id, session_date, start_time, batch_name, session_type,
          assigned_trainer_id, conducted_by_trainer_id, session_kind, status, payment_amount, created_by
        )
        SELECT
          ts.id,
          d.dt::date,
          ts.start_time,
          ts.batch_name,
          ts.session_type,
          ts.trainer_id,
          ts.trainer_id,
          'scheduled',
          'Scheduled',
          CASE WHEN ts.payment_model = 'per_session' THEN COALESCE(ts.rate_amount, 0) ELSE 0 END,
          $4
        FROM trainer_schedules ts
        CROSS JOIN LATERAL generate_series($1::date, $2::date, interval '1 day') AS d(dt)
        WHERE ts.active = TRUE
          AND ($3::text IS NULL OR ts.trainer_id = $3)
          AND NOT EXISTS (
            SELECT 1 FROM trainer_monthly_approvals tma
            WHERE tma.month = $5 AND tma.trainer_id = ts.trainer_id AND tma.status = 'Paid'
          )
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(ts.days_of_week) AS dow_elem
            WHERE dow_elem::int = EXTRACT(DOW FROM d.dt)::int
          )
        ON CONFLICT (schedule_id, session_date, start_time) WHERE schedule_id IS NOT NULL AND session_kind = 'scheduled'
        DO NOTHING
      `, [monthStart, monthEnd, trainerId, req.user.name, month]);

      res.status(201).json({ month, created: ins.rowCount || 0 });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/trainers/sessions', async (req, res) => {
    try {
      const sessionDate = parseDate(req.body.session_date);
      if (!sessionDate) throw invalid('Session date is required.');
      const startTime = cleanTime(req.body.start_time);
      const batchName = cleanText(req.body.batch_name, 'Batch name', 150, true);
      const sessionType = cleanText(req.body.session_type, 'Session type', 60, true);
      const trainer = await ensureEmployeeExists(req.body.assigned_trainer_id, 'Trainer');
      const kind = req.body.session_kind || 'extra';
      if (!SESSION_KINDS.includes(kind)) throw invalid('Invalid session kind.');
      const status = req.body.status || 'Completed';
      if (!SESSION_STATUSES.includes(status)) throw invalid('Invalid session status.');
      const paymentAmount = cleanMoney(req.body.payment_amount, 'Payment amount', 0);
      const notes = cleanText(req.body.notes, 'Notes', 1000, false);

      const sessionMonth = formatDateYmd(sessionDate).slice(0, 7);
      const paidLock = await pool.query(
        `SELECT trainer_id
         FROM trainer_monthly_approvals
         WHERE month = $1 AND trainer_id = ANY($2::text[]) AND status = 'Paid'
         LIMIT 1`,
        [sessionMonth, [trainer.id]]
      );
      if (paidLock.rows.length > 0) {
        throw invalid(`Sessions in ${sessionMonth} cannot be added after payout is marked Paid.`, 409);
      }

      const conductedBy = status === 'Completed' ? trainer.id : null;
      const inserted = await pool.query(`
        INSERT INTO trainer_sessions (
          session_date, start_time, batch_name, session_type,
          assigned_trainer_id, conducted_by_trainer_id, session_kind, status,
          payment_amount, notes, approved, approved_by, approved_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
      `, [
        sessionDate, startTime, batchName, sessionType,
        trainer.id, conductedBy, kind, status,
        paymentAmount, notes,
        status === 'Completed', status === 'Completed' ? req.user.name : null, status === 'Completed' ? new Date() : null,
        req.user.name
      ]);

      res.status(201).json(inserted.rows[0]);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.patch('/api/trainers/sessions/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw invalid('Invalid session id.');
      const cur = await pool.query('SELECT * FROM trainer_sessions WHERE id = $1 FOR UPDATE', [id]);
      if (!cur.rowCount) throw invalid('Session not found.', 404);
      const row = cur.rows[0];

      const sessionMonth = formatDateYmd(row.session_date).slice(0, 7);
      const affectedTrainers = [...new Set([
        row.assigned_trainer_id,
        row.conducted_by_trainer_id,
        row.replacement_trainer_id,
        req.body.replacement_trainer_id,
        req.body.conducted_by_trainer_id
      ].filter(Boolean))];
      if (affectedTrainers.length > 0) {
        const paidCheck = await pool.query(
          "SELECT trainer_id FROM trainer_monthly_approvals WHERE month = $1 AND trainer_id = ANY($2::text[]) AND status = 'Paid' LIMIT 1",
          [sessionMonth, affectedTrainers]
        );
        if (paidCheck.rowCount > 0) {
          throw invalid(`Sessions in ${sessionMonth} cannot be modified after payout is marked Paid.`, 409);
        }
      }

      const status = req.body.status !== undefined ? req.body.status : row.status;
      if (!SESSION_STATUSES.includes(status)) throw invalid('Invalid session status.');

      let replacementId = row.replacement_trainer_id;
      if (Object.prototype.hasOwnProperty.call(req.body, 'replacement_trainer_id')) {
        if (!req.body.replacement_trainer_id) {
          replacementId = null;
        } else {
          const rep = await ensureEmployeeExists(req.body.replacement_trainer_id, 'Replacement trainer');
          if (rep.id === row.assigned_trainer_id) throw invalid('Replacement trainer must be different from the assigned trainer.');
          replacementId = rep.id;
        }
      }

      let conductedBy = row.conducted_by_trainer_id;
      if (Object.prototype.hasOwnProperty.call(req.body, 'conducted_by_trainer_id')) {
        conductedBy = req.body.conducted_by_trainer_id
          ? (await ensureEmployeeExists(req.body.conducted_by_trainer_id, 'Conducting trainer')).id
          : null;
      } else if (status === 'Leave') {
        conductedBy = replacementId || null;
      } else if (status === 'Completed') {
        conductedBy = row.assigned_trainer_id;
      } else if (['Cancelled', 'Missed'].includes(status)) {
        conductedBy = null;
      }

      const paymentAmount = req.body.payment_amount !== undefined ? cleanMoney(req.body.payment_amount, 'Payment amount', 0) : row.payment_amount;
      const replacementPay = replacementId
        ? (req.body.replacement_pay !== undefined ? cleanMoney(req.body.replacement_pay, 'Replacement pay', 0) : row.replacement_pay)
        : 0;
      const deductionAmount = req.body.deduction_amount !== undefined ? cleanMoney(req.body.deduction_amount, 'Adjustment deduction', 0) : row.deduction_amount;
      const notes = req.body.notes !== undefined ? cleanText(req.body.notes, 'Notes', 1000, false) : row.notes;
      const approved = req.body.approved !== undefined ? Boolean(req.body.approved) : row.approved;

      const updated = await pool.query(`
        UPDATE trainer_sessions SET
          status = $1,
          conducted_by_trainer_id = $2,
          replacement_trainer_id = $3,
          payment_amount = $4,
          replacement_pay = $5,
          deduction_amount = $6,
          notes = $7,
          approved = $8,
          approved_by = CASE WHEN $8 THEN COALESCE(approved_by, $9) ELSE NULL END,
          approved_at = CASE WHEN $8 THEN COALESCE(approved_at, NOW()) ELSE NULL END,
          updated_at = NOW()
        WHERE id = $10 RETURNING *
      `, [status, conductedBy, replacementId, paymentAmount, replacementPay, deductionAmount, notes, approved, req.user.name, id]);

      res.json(updated.rows[0]);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/trainers/payouts/approve', async (req, res) => {
    try {
      const month = cleanMonth(req.body.month);
      const trainer = await ensureEmployeeExists(req.body.trainer_id, 'Trainer');
      const status = req.body.status || 'Approved';
      if (!APPROVAL_STATUSES.includes(status)) throw invalid('Invalid payout status.');
      const notes = cleanText(req.body.notes, 'Notes', 500, false);

      const existingRes = await pool.query(
        'SELECT * FROM trainer_monthly_approvals WHERE month = $1 AND trainer_id = $2 FOR UPDATE',
        [month, trainer.id]
      );
      if (existingRes.rowCount > 0 && existingRes.rows[0].status === 'Paid') {
        throw invalid(`Payout for ${trainer.name} (${month}) is already marked Paid and cannot be modified.`, 409);
      }

      const overviewData = await loadTrainerOverviewData({ month, scope: trainer.id });
      const staff = overviewData.staff.some(e => e.id === trainer.id)
        ? overviewData.staff
        : [...overviewData.staff, trainer];
      const payoutSummary = computePayoutSummaries({
        month,
        scope: trainer.id,
        staff,
        schedules: overviewData.schedules,
        sessions: overviewData.sessions,
        approvals: overviewData.approvals
      });
      const summaryRow = payoutSummary.find(p => p.trainer_id === trainer.id);
      const totalPayable = summaryRow ? summaryRow.net_payable : 0;

      const saved = await pool.query(`
        INSERT INTO trainer_monthly_approvals (month, trainer_id, total_payable, status, notes, approved_by, approved_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (month, trainer_id) DO UPDATE SET
          total_payable = EXCLUDED.total_payable,
          status = EXCLUDED.status,
          notes = EXCLUDED.notes,
          approved_by = EXCLUDED.approved_by,
          approved_at = NOW()
        RETURNING *
      `, [month, trainer.id, totalPayable, status, notes, req.user.name]);

      res.json(saved.rows[0]);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
