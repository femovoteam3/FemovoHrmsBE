import { pool } from './db.js';

export function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
const JOB_STATUSES = ['Active', 'Hidden', 'On Hold', 'Closed'];
const JOB_PRIORITIES = ['High', 'Urgent', 'Medium', 'Normal', 'Low'];
const JOB_TEXT_FIELDS = [['code', 'Job code', 50], ['role', 'Job title', 100], ['department', 'Department', 100], ['ctc_band', 'Salary band', 100], ['experience', 'Experience', 100], ['hiring_manager', 'Hiring manager', 100]];
const JOB_REQUIRED_FIELDS = ['role', 'department'];

function jobCount(value, label, min, max) {
  const number = value === '' ? NaN : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw invalid(`${label} must be a whole number from ${min} to ${max}.`);
  return number;
}

// Returns only the checked fields that were sent. Pass the saved job when updating.
export function validateRequisition(input, existing = null) {
  const clean = {};
  for (const [field, label, max] of JOB_TEXT_FIELDS) {
    const required = JOB_REQUIRED_FIELDS.includes(field);
    const value = input[field];
    const blank = value === undefined || value === null || (typeof value === 'string' && !value.trim());
    if (blank) {
      if (required && (!existing || value !== undefined)) throw invalid(`${label} is required.`);
      continue;
    }
    if (typeof value !== 'string') throw invalid(`${label} must be text.`);
    if (value.trim().length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
    clean[field] = value.trim();
  }
  if (input.status !== undefined) {
    if (!JOB_STATUSES.includes(input.status)) throw invalid(`Status must be one of: ${JOB_STATUSES.join(', ')}.`);
    clean.status = input.status;
  }
  if (input.priority !== undefined) {
    if (!JOB_PRIORITIES.includes(input.priority)) throw invalid(`Priority must be one of: ${JOB_PRIORITIES.join(', ')}.`);
    clean.priority = input.priority;
  }
  if (input.openings !== undefined) clean.openings = jobCount(input.openings, 'Openings', 1, 1000);
  if (input.filled !== undefined) clean.filled = jobCount(input.filled, 'Filled positions', 0, 1000);
  const openings = clean.openings ?? existing?.openings ?? 1;
  const filled = clean.filled ?? existing?.filled ?? 0;
  if (filled > openings) throw invalid('Filled positions cannot be more than openings.');
  return clean;
}

export const ATS_ROLE_IDS = ['ceo', 'rec_lead', 'rec_associate', 'hiring_manager'];

// A person who already has an older role can keep it, but nobody can be given one.
export function readAtsRole(value, current) {
  if (value === undefined || value === null || value === '') return current;
  if (value === current || ATS_ROLE_IDS.includes(value)) return value;
  throw invalid('Choose a valid role: CEO, Head HR, HR Assistant or Interviewer.');
}

const APPLICATION_TEXT = [['experience', 'Experience', 50], ['current_ctc', 'Current salary', 50], ['expected_ctc', 'Expected salary', 50], ['notice_period', 'Notice period', 50], ['qualification', 'Qualification', 150], ['current_location', 'Current city', 100], ['source', 'Source', 50]];

// Checks a candidate application and returns only the cleaned fields. Blank answers become null.
// The public form must give a mobile number; staff may add a candidate before they have one.
export function validateApplication(input, { isPublic = false } = {}) {
  const read = (field, label, max, required = false) => {
    const value = input[field];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      if (required) throw invalid(`${label} is required.`);
      return null;
    }
    if (typeof value !== 'string') throw invalid(`${label} must be text.`);
    if (value.trim().length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
    return value.trim();
  };
  const clean = { name: read('name', 'Full name', 100, true), job: read('job', 'Job', 100, true), email: read('email', 'Email address', 100, true) };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw invalid('Enter a valid email address.');
  clean.email = clean.email.toLowerCase();
  clean.phone = read('phone', 'Mobile number', 20, isPublic);
  if (isPublic && !/^\+?[0-9]{10,15}$/.test(clean.phone.replace(/[\s()-]/g, ''))) throw invalid('Enter a mobile number with 10 to 15 digits.');
  for (const [field, label, max] of APPLICATION_TEXT) clean[field] = read(field, label, max);
  clean.portfolio_url = read('portfolio_url', 'Profile link', 300);
  if (clean.portfolio_url && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(clean.portfolio_url)) throw invalid('The profile link must start with http:// or https://');
  return clean;
}

export function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid('Use dates in YYYY-MM-DD format.');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0,10) !== value) throw invalid('Invalid calendar date.');
  return date;
}
export function calendar(env = process.env) {
  if (!env.WORK_WEEK || !env.HOLIDAYS_JSON) throw invalid('Configure and approve WORK_WEEK and HOLIDAYS_JSON before processing leave.', 409);
  const week = env.WORK_WEEK.split(',').map(Number);
  const holidays = JSON.parse(env.HOLIDAYS_JSON);
  if (!week.length || week.some(day => !Number.isInteger(day) || day < 0 || day > 6) || !Array.isArray(holidays)) throw invalid('Invalid working calendar configuration.', 409);
  holidays.forEach(parseDate);
  return { week: new Set(week), holidays: new Set(holidays) };
}
export function workingDates(from, to, policy = calendar()) {
  const start = parseDate(from), end = parseDate(to);
  if (end < start || end - start > 366 * 86400000) throw invalid('Invalid date range (maximum 366 days).');
  const result = [];
  for (const date = start; date <= end; date.setUTCDate(date.getUTCDate()+1)) {
    const key = date.toISOString().slice(0,10);
    if (policy.week.has(date.getUTCDay()) && !policy.holidays.has(key)) result.push(key);
  }
  return result;
}
export function leaveDays(leave, policy = calendar()) {
  const from = String(leave.from_date).slice(0,10), to = String(leave.to_date).slice(0,10);
  const days = workingDates(from, to, policy).length;
  if (!days) throw invalid('The request contains no working days.');
  if (leave.is_half_day && (from !== to || !['Morning','Afternoon','First Half','Second Half','AM','PM'].includes(leave.half_day_session))) throw invalid('Select a single working day and a valid half-day session.');
  return leave.is_half_day ? 0.5 : days;
}
export function leaveColumn(type) {
  const key = String(type).toLowerCase();
  if (/casual|^cl$/.test(key)) return 'cl_balance';
  if (/sick|medical|^sl$/.test(key)) return 'sl_balance';
  if (/planned|earned|paid|privilege|^pl$/.test(key)) return 'pl_balance';
  if (/wellness|menstrual/.test(key)) return 'wellness_balance';
  throw invalid('Unsupported leave type.');
}
export async function createLeave(req, res) {
  const { employeeId, type, from, to, reason, is_half_day = false, half_day_session = null } = req.body;
  if (!employeeId || typeof reason !== 'string' || !reason.trim() || typeof is_half_day !== 'boolean') throw invalid('Employee, reason and valid half-day selection are required.');
  leaveColumn(type);
  leaveDays({ from_date: from, to_date: to, is_half_day, half_day_session });
  await pool.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`leave:${employeeId}`]);
  const overlap = await pool.query("SELECT id FROM leaves WHERE employee_id=$1 AND status IN ('Pending','Approved') AND from_date <= $3::date AND to_date >= $2::date", [employeeId, from, to]);
  if (overlap.rowCount) throw invalid('An overlapping leave request already exists.', 409);
  const result = await pool.query(`INSERT INTO leaves (employee_id,type,from_date,to_date,reason,is_half_day,half_day_session,status,balance_reconciled) VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending',true) RETURNING *`, [employeeId,type,from,to,reason.trim(),is_half_day,half_day_session]);
  res.status(201).json(result.rows[0]);
}
export async function decideLeave(req, res) {
  const status = req.body.status;
  if (!['Approved','Rejected','Cancelled'].includes(status)) throw invalid('Unsupported leave status.');
  const result = await pool.query("SELECT *, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date FROM leaves WHERE id=$1 FOR UPDATE", [req.params.id]);
  if (!result.rowCount) throw invalid('Leave not found.',404);
  const leave = result.rows[0];
  if (leave.status === status) return res.json(leave);
  if (!['Pending','Approved'].includes(leave.status)) throw invalid('This leave decision is final. Submit a new request.',409);
  if (leave.status === 'Approved' && !leave.balance_reconciled) throw invalid('Reconcile this legacy approved leave balance before reversing it.',409);
  const column = leave.balance_column || leaveColumn(leave.type);
  if (!['cl_balance','sl_balance','pl_balance','wellness_balance'].includes(column)) throw invalid('Invalid balance category.',409);
  let days = 0;
  if (status === 'Approved') {
    days = leaveDays(leave);
    const balance = await pool.query(`UPDATE leave_balances SET ${column}=${column}-$1 WHERE employee_id=$2 AND ${column}>=$1 RETURNING *`, [days,leave.employee_id]);
    if (!balance.rowCount) throw invalid('Insufficient or unconfigured leave balance.',409);
  } else if (leave.status === 'Approved') {
    const balance = await pool.query(`UPDATE leave_balances SET ${column}=${column}+$1 WHERE employee_id=$2 RETURNING *`, [leave.deducted_days,leave.employee_id]);
    if (!balance.rowCount) throw invalid('Leave balance is missing.',409);
  }
  const updated = await pool.query('UPDATE leaves SET status=$1,deducted_days=$2,balance_column=$3,balance_reconciled=true WHERE id=$4 RETURNING *', [status,days,column,leave.id]);
  res.json(updated.rows[0]);
}

export function paise(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value))) throw invalid('Money must be a nonnegative amount with at most two decimal places.');
  const [whole, decimal = ''] = String(value).split('.');
  const result = Number(whole)*100 + Number(decimal.padEnd(2,'0'));
  if (!Number.isSafeInteger(result) || result > 9999999999) throw invalid('Money value is out of range.');
  return result;
}
export const rupees = value => (value/100).toFixed(2);
export function csvCell(value) {
  let text=String(value??'');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}

export function parsePagination(query = {}, { defaultLimit = 500, maxLimit = 1000 } = {}) {
  let limit = defaultLimit;
  if (query.limit !== undefined && query.limit !== '') {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) throw invalid('Limit must be a positive whole number.');
    limit = Math.min(parsed, maxLimit);
  }
  let offset = 0;
  if (query.offset !== undefined && query.offset !== '') {
    const parsed = Number(query.offset);
    if (!Number.isInteger(parsed) || parsed < 0) throw invalid('Offset must be zero or a positive whole number.');
    offset = parsed;
  }
  return { limit, offset };
}

export function parseDateRange(query = {}, { defaultDays = 90, maxDays = 366, anchorDate } = {}) {
  const endDate = parseDate(query.to || anchorDate);
  const startDate = query.from
    ? parseDate(query.from)
    : new Date(endDate.getTime() - (defaultDays - 1) * 86400000);
  if (endDate < startDate || endDate - startDate > maxDays * 86400000) {
    throw invalid(`Invalid date range (maximum ${maxDays} days).`);
  }
  return {
    from: startDate.toISOString().slice(0, 10),
    to: endDate.toISOString().slice(0, 10)
  };
}
