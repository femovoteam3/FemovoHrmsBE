import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { pendingMigrations } from './migrate.js';
import crypto from 'node:crypto';
import { validateConfig, businessDate, businessTimezone } from './config.js';
import { installRouteSecurity, rateLimit } from './security.js';
import { registerAtsRoutes } from './ats-routes.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import { registerTrainerRoutes } from './trainer-routes.js';
import { ATS_ACTIONS, ATS_MODULES, defaultPermissions, moduleOfAction } from './ats-permissions.js';
import { upload, uploadDir, downloadFile, scheduleUploadCleanup } from './files.js';
import { createLeave, decideLeave, csvCell, invalid, parseDate, parsePagination, parseDateRange } from './domain.js';
import {
  generateToken,
  verifyToken,
  hashPin,
  verifyPin,
  authenticateToken,
  requireRole,
  requirePermission,
  getRolePermissionsMap,
  getUserModulePermissions,
  isPublicEndpoint,
  getUserEffectivePermissions,
  buildEffectivePermissions,
  resolveAtsRole,
  AUTH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  parseCookies,
  isSecureCookie,
  setAuthCookies,
  clearAuthCookies,
  verifyCsrf,
} from './auth.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS));
const PORT = process.env.PORT || 5000;

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : null;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins?.includes(origin) || (!allowedOrigins && ['http://localhost:5000','http://localhost:5173','http://127.0.0.1:5000','http://127.0.0.1:5173'].includes(origin))) {
      return callback(null, true);
    }
    return callback(Object.assign(new Error('Origin not allowed.'), { status: 403 }));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Application-Token', 'X-CSRF-Token']
}));
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  const json = res.json;
  res.json = function (body) {
    if (this.statusCode >= 500) body = { error: 'The request could not be completed. Please try again or contact support.' };
    const redact=value=>{
      if(Array.isArray(value)) return value.map(redact);
      if(value && typeof value==='object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).filter(([key])=>!['pin','plain_pin','resume_upload_token_hash','resume_upload_expires_at'].includes(key)).map(([key,item])=>[key,redact(item)]));
      return value;
    };
    return json.call(this, redact(body));
  };
  next();
});
// Only failed sign-ins count: per account per address, with a wider cap per address.
const loginIdentifier = req => String(req.body?.identifier || req.body?.email || req.body?.employeeId || '').trim().toLowerCase().slice(0, 200);
app.use('/api/auth/login', rateLimit({ max: 100, countSuccess: false }));
app.use('/api/auth/login', rateLimit({ max: 10, countSuccess: false, key: req => `${req.ip}:${loginIdentifier(req)}` }));
// Public applications only; a request presenting a token is authenticated or rejected below.
const hasAuthCredential = req => Boolean(req.headers.authorization || parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME]);
app.use('/api/applicants', rateLimit({ max: 120, skip: hasAuthCredential }));

// Public requests with an invalid/revoked token never silently downgrade to anonymous.
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' && req.method === 'POST') return next();
  if (req.path === '/auth/logout' && req.method === 'POST' && !parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME]) return next();
  if (isPublicEndpoint(req) && !hasAuthCredential(req)) return next();
  return authenticateToken(req, res, next);
});
installRouteSecurity(app);
app.get('/api/files/:filename', downloadFile);
app.get('/uploads/:filename', authenticateToken, downloadFile);
app.get('/api/ready', async (req, res) => {
  if((await pendingMigrations(pool)).length) return res.status(503).json({error:'Database migration required.'});
  res.json({ status: 'ready' });
});

// Helper to derive permission matrix for authenticated user
function getPermissionsForUser(role, atsRole, isHeadHR) {
  if (role === 'hr' || role === 'super_admin' || role === 'admin' || isHeadHR) {
    return {
      canGenerateOffer: true,
      canPromoteToEmployee: true,
      canViewAllDepartments: true,
      canApproveRequisitions: true,
      canReassignCandidates: true,
      canScheduleInterviews: true,
      canSubmitScorecard: true,
      canRejectCandidates: true,
      canUploadResume: true,
      canExportPipeline: true,
      canImportCandidates: true,
      canShareApplyLink: true,
      canManageEmployees: true,
      canApproveLeaves: true,
      canManagePermissions: role === 'super_admin' || role === 'admin'
    };
  }
  if (role === 'hr_assistant') {
    return {
      canGenerateOffer: false,
      canPromoteToEmployee: false,
      canViewAllDepartments: false,
      canApproveRequisitions: false,
      canReassignCandidates: false,
      canScheduleInterviews: true,
      canSubmitScorecard: true,
      canRejectCandidates: true,
      canUploadResume: true,
      canExportPipeline: true,
      canImportCandidates: true,
      canShareApplyLink: true,
      canManageEmployees: false,
      canApproveLeaves: false,
      canManagePermissions: false
    };
  }
  if (role === 'head' || role === 'manager') {
    return {
      canGenerateOffer: false,
      canPromoteToEmployee: false,
      canViewAllDepartments: false,
      canApproveRequisitions: false,
      canReassignCandidates: false,
      canScheduleInterviews: true,
      canSubmitScorecard: true,
      canRejectCandidates: false,
      canUploadResume: false,
      canExportPipeline: false,
      canImportCandidates: false,
      canShareApplyLink: false,
      canManageEmployees: false,
      canApproveLeaves: true,
      canManagePermissions: false
    };
  }
  // Default staff employee
  return {
    canGenerateOffer: false,
    canPromoteToEmployee: false,
    canViewAllDepartments: false,
    canApproveRequisitions: false,
    canReassignCandidates: false,
    canScheduleInterviews: false,
    canSubmitScorecard: false,
    canRejectCandidates: false,
    canUploadResume: false,
    canExportPipeline: false,
    canImportCandidates: false,
    canShareApplyLink: false,
    canManageEmployees: false,
    canApproveLeaves: false,
    canManagePermissions: false
  };
}

async function buildSessionUser(row) {
  const dynamicPermissions = await getUserModulePermissions(row);
  const candidateCapabilities = await getUserEffectivePermissions(row);
  return {
    id: row.id,
    session_version: row.session_version,
    name: row.name,
    email: row.email,
    roleTitle: row.role_title,
    avatar: row.avatar,
    selfId: row.employee_id,
    department: row.department,
    recruiterId: row.recruiter_id,
    isHeadHR: row.is_head_hr,
    role: row.role,
    atsRole: row.ats_role,
    permissions: dynamicPermissions,
    capabilities: getPermissionsForUser(row.role, row.ats_role, row.is_head_hr),
    candidateCapabilities
  };
}

// 0. Individual Enterprise Auth Endpoint (PostgreSQL-backed)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, email, employeeId, role, pin } = req.body;
    const loginId = (identifier || email || employeeId || role || '').trim();
    const loginPin = (pin || '').toString().trim();

    if (!loginId || !loginPin) {
      return res.status(400).json({ error: 'Please enter your Work Email or Employee ID and secret PIN.' });
    }

    // Lookup account in PostgreSQL user_accounts
    const result = await pool.query(`
      SELECT * FROM user_accounts 
      WHERE (
        LOWER(email) = LOWER($1) 
        OR UPPER(employee_id) = UPPER($1)
        OR LOWER(email) = LOWER($1 || '@femovo.com')
        OR LOWER(email) = LOWER($1 || '@femovo.demo')
      )
      AND status = 'Active'
      LIMIT 1
    `, [loginId]);

    if (result.rows.length === 0) {
      return res.status(401).json({ 
        error: 'Invalid credentials.' 
      });
    }

    const row = result.rows[0];
    const access = await pool.query('SELECT has_dashboard_access, status FROM employees WHERE id=$1', [row.employee_id]);
    if (access.rows[0]?.has_dashboard_access === false || ['Inactive','Exited','Terminated'].includes(access.rows[0]?.status)) return res.status(401).json({ error: 'Invalid credentials.' });

    // Verify the stored bcrypt hash.
    const isValidPin = await verifyPin(loginPin, row.pin);
    if (!isValidPin) {
      return res.status(401).json({ 
        error: 'Invalid credentials.' 
      });
    }

    const user = await buildSessionUser(row);
    const token = generateToken(user);
    setAuthCookies(req, res, token);

    res.json({
      success: true,
      role: row.role,
      user,
      roleKey: row.role
    });
  } catch (err) {
    console.error('Authentication operation failed', { code: err.code || 'AUTH_SERVICE_ERROR' });
    res.status(500).json({ error: 'Authentication service error: ' + err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[AUTH_COOKIE_NAME] && !verifyCsrf(req, cookies)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token.', code: 'CSRF_INVALID' });
  }
  clearAuthCookies(req, res);
  res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM user_accounts WHERE id = $1', [req.user.userId]);
    const row = result.rows[0];
    if (!row) return res.status(401).json({ error: 'Account not found.' });
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[CSRF_COOKIE_NAME]) {
      res.cookie(CSRF_COOKIE_NAME, crypto.randomBytes(24).toString('hex'), {
        httpOnly: false,
        secure: isSecureCookie(req),
        sameSite: 'lax',
        path: '/',
        maxAge: 3600_000
      });
    }
    const user = await buildSessionUser(row);
    res.json({ authenticated: true, role: row.role, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Update personal PIN
app.post('/api/auth/change-pin', async (req,res) => {
  const {oldPin,newPin}=req.body;
  if (typeof newPin!=='string'||newPin.trim().length<12||Buffer.byteLength(newPin.trim())>72) throw invalid('Use a password of 12–72 bytes.');
  const account=await pool.query('SELECT pin FROM user_accounts WHERE id=$1 FOR UPDATE',[req.user.userId]);
  if (!await verifyPin(oldPin,account.rows[0]?.pin)) return res.status(400).json({error:'Current password is incorrect.'});
  await pool.query('UPDATE user_accounts SET pin=$1,updated_at=NOW() WHERE id=$2',[await hashPin(newPin),req.user.userId]);
  clearAuthCookies(req, res);
  res.json({success:true,message:'Password changed. Please sign in again.'});
});

// Get active dynamic permissions matrix for the authenticated user
app.get('/api/auth/me/permissions', async (req, res) => {
  try {
    const roleId = req.user?.role || 'employee';
    const permissions = await getUserModulePermissions(req.user);
    const candidateCapabilities = await getUserEffectivePermissions(req.user);
    res.json({
      role: roleId,
      isSuperAdmin: roleId === 'super_admin',
      permissions,
      candidateCapabilities
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Accounts Directory for Administrative overview
app.get('/api/auth/accounts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT employee_id, email, name, role, ats_role, department, role_title, avatar, is_head_hr, status 
      FROM user_accounts 
      ORDER BY employee_id
    `);
    res.json({ accounts: result.rows });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 1. Health check
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'healthy', timestamp: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// 2. Stats summary (Dashboard)
app.get('/api/stats', async (req, res) => {
  try {
    const empCount = await pool.query("SELECT COUNT(*) FROM employees WHERE status NOT IN ('Inactive', 'Exited', 'Terminated')");
    const presentCount = await pool.query(`
      SELECT COUNT(*) FROM attendance_records ar JOIN employees e ON e.id = ar.employee_id
      WHERE ar.date = CURRENT_DATE AND ar.status IN ('Present', 'WFH', 'Half Day') AND e.status NOT IN ('Inactive', 'Exited', 'Terminated')
    `);
    const probationCount = await pool.query("SELECT COUNT(*) FROM employees WHERE status = 'Probation'");
    const pendingLeaves = await pool.query("SELECT COUNT(*) FROM leaves WHERE status = 'Pending'");
    const deptDistribution = await pool.query(`
      SELECT department, COUNT(*) as count 
      FROM employees
      WHERE status NOT IN ('Inactive', 'Exited', 'Terminated')
      GROUP BY department
      ORDER BY count DESC
    `);

    const attendanceTrendRes = await pool.query(`
      SELECT 
        TO_CHAR(date, 'Dy, DD Mon') as label, 
        COUNT(*)::int as total, 
        SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END)::int as present,
        SUM(CASE WHEN status = 'On leave' THEN 1 ELSE 0 END)::int as on_leave
      FROM attendance_records 
      GROUP BY date 
      ORDER BY date DESC 
      LIMIT 7
    `);
    const attendanceTrend = attendanceTrendRes.rows.reverse();

    const today = businessDate();
    let configuredHolidays = [];
    if (process.env.HOLIDAYS_JSON) {
      try {
        const parsed = JSON.parse(process.env.HOLIDAYS_JSON);
        if (Array.isArray(parsed)) configuredHolidays = parsed;
      } catch {
        configuredHolidays = [];
      }
    }
    const upcomingHolidays = configuredHolidays
      .map(entry => {
        const dateStr = typeof entry === 'string' ? entry.trim() : String(entry?.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
        const dt = new Date(`${dateStr}T00:00:00Z`);
        if (Number.isNaN(dt.valueOf())) return null;
        const dayName = typeof entry === 'object' && entry?.day
          ? entry.day
          : dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
        return {
          date: dateStr,
          name: (typeof entry === 'object' && entry?.name) ? entry.name : 'Company Holiday',
          day: dayName,
          type: (typeof entry === 'object' && entry?.type) ? entry.type : 'Mandatory'
        };
      })
      .filter(holiday => holiday && holiday.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      totalEmployees: parseInt(empCount.rows[0].count, 10),
      presentToday: parseInt(presentCount.rows[0].count, 10),
      onProbation: parseInt(probationCount.rows[0].count, 10),
      pendingLeaves: parseInt(pendingLeaves.rows[0].count, 10),
      departments: deptDistribution.rows.map(r => ({ department: r.department, count: parseInt(r.count, 10) })),
      attendanceTrend,
      upcomingHolidays
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 2.5 Departments API
app.get('/api/departments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        d.*,
        (SELECT COUNT(*)::int FROM employees e WHERE e.department = d.name AND COALESCE(e.status, 'Active') NOT IN ('Inactive', 'Exited', 'Terminated')) as employee_count
      FROM departments d 
      ORDER BY d.hierarchy_order ASC NULLS LAST, d.name ASC
    `);
    res.json(req.user ? result.rows : result.rows.map(({id,name,code,description})=>({id,name,code,description}))); 
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/departments', async (req, res) => {
  try {
    const { name, code, description, head_of_department, head_employee_id } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Department name is required' });
    }
    const cleanName = name.trim();
    const cleanCode = (code || cleanName.slice(0, 4)).trim().toUpperCase();
    let finalHeadName = head_of_department ? head_of_department.trim() : null;
    const finalHeadId = head_employee_id ? String(head_employee_id).trim() : null;
    if (finalHeadId) {
      const headEmp = await pool.query('SELECT name FROM employees WHERE id = $1', [finalHeadId]);
      if (!headEmp.rowCount) return res.status(404).json({ error: 'Department head employee not found' });
      if (!finalHeadName) finalHeadName = headEmp.rows[0].name;
    }

    const result = await pool.query(`
      INSERT INTO departments (name, code, description, head_of_department, head_employee_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (name) DO UPDATE SET
        code = EXCLUDED.code,
        description = EXCLUDED.description,
        head_of_department = EXCLUDED.head_of_department,
        head_employee_id = COALESCE(EXCLUDED.head_employee_id, departments.head_employee_id)
      RETURNING *
    `, [cleanName, cleanCode, description ? description.trim() : null, finalHeadName, finalHeadId]);

    // Also sync to company_masters
    await pool.query(`
      INSERT INTO company_masters (type, code, name, description, department, hierarchy_level)
      VALUES ('department', $1, $2, $3, $2, 'Department')
      ON CONFLICT (type, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description
    `, [cleanCode, cleanName, description ? description.trim() : null]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put('/api/departments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, description, head_of_department, head_employee_id } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Department name is required' });
    }

    const currentDeptRes = await pool.query('SELECT * FROM departments WHERE id = $1', [id]);
    if (currentDeptRes.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }
    const oldName = currentDeptRes.rows[0].name;
    const newName = name.trim();
    const newCode = (code || newName.slice(0, 4)).trim().toUpperCase();
    const newDesc = description ? description.trim() : null;

    const hasHeadId = Object.prototype.hasOwnProperty.call(req.body, 'head_employee_id');
    let finalHeadId = hasHeadId ? (head_employee_id ? String(head_employee_id).trim() : null) : currentDeptRes.rows[0].head_employee_id;
    let finalHeadName = head_of_department !== undefined ? (head_of_department ? head_of_department.trim() : null) : currentDeptRes.rows[0].head_of_department;
    if (hasHeadId && finalHeadId) {
      const headEmp = await pool.query('SELECT name FROM employees WHERE id = $1', [finalHeadId]);
      if (!headEmp.rowCount) return res.status(404).json({ error: 'Department head employee not found' });
      if (!finalHeadName) finalHeadName = headEmp.rows[0].name;
    }

    const updateRes = await pool.query(`
      UPDATE departments 
      SET name = $1, code = $2, description = $3, head_of_department = $4, head_employee_id = $5
      WHERE id = $6 
      RETURNING *
    `, [newName, newCode, newDesc, finalHeadName, finalHeadId, id]);

    // If department name changed, sync references across tables
    if (oldName !== newName) {
      await pool.query('UPDATE employees SET department = $1 WHERE department = $2', [newName, oldName]);
      await pool.query('UPDATE user_accounts SET department = $1 WHERE department = $2', [newName, oldName]);
      await pool.query('UPDATE recruitment_team SET department = $1 WHERE department = $2', [newName, oldName]);
      await pool.query('UPDATE job_requisitions SET department = $1 WHERE department = $2', [newName, oldName]);
      await pool.query('UPDATE applicants SET department = $1 WHERE department = $2', [newName, oldName]);
      await pool.query('UPDATE training SET department = $1 WHERE department = $2', [newName, oldName]);
      await pool.query("UPDATE training_assignments SET target = $1 WHERE scope = 'department' AND target = $2", [newName, oldName]);
      await pool.query(`
        DELETE FROM recruiter_assignments ra
        WHERE ra.kind = 'department' AND LOWER(ra.target) = LOWER($2)
          AND LOWER($1) <> LOWER($2)
          AND EXISTS (
            SELECT 1 FROM recruiter_assignments dup
            WHERE dup.recruiter_id = ra.recruiter_id AND dup.kind = 'department' AND LOWER(dup.target) = LOWER($1)
          )
      `, [newName, oldName]);
      await pool.query("UPDATE recruiter_assignments SET target = $1 WHERE kind = 'department' AND LOWER(target) = LOWER($2)", [newName, oldName]);
      await pool.query('UPDATE exits SET department = $1 WHERE department = $2', [newName, oldName]);
      await pool.query("UPDATE company_masters SET name = $1, code = $2, description = $3, department = $1 WHERE type = 'department' AND name = $4", [newName, newCode, newDesc, oldName]);
      await pool.query("UPDATE company_masters SET department = $1 WHERE type = 'designation' AND department = $2", [newName, oldName]);
    }

    res.json(updateRes.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/departments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deptRes = await pool.query('SELECT * FROM departments WHERE id = $1', [id]);
    if (deptRes.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }
    const deptName = deptRes.rows[0].name;

    // Check if any active employees belong to this department (Inactive/Exited/Terminated do not block)
    const empCheck = await pool.query(
      "SELECT COUNT(*)::int AS count FROM employees WHERE department = $1 AND COALESCE(status, 'Active') NOT IN ('Inactive', 'Exited', 'Terminated')",
      [deptName]
    );
    const empCount = parseInt(empCheck.rows[0].count, 10);
    if (empCount > 0) {
      return res.status(400).json({ 
        error: `Cannot delete department "${deptName}" because ${empCount} active employee(s) are currently assigned to it. Please reassign the employees first.` 
      });
    }

    await pool.query('DELETE FROM departments WHERE id = $1', [id]);
    res.json({ success: true, message: `Department "${deptName}" deleted successfully.` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Today's status comes from attendance and approved leave, never from a stored flag.
const TODAY_ATTENDANCE = `COALESCE(
  (SELECT ar.status FROM attendance_records ar WHERE ar.employee_id = employees.id AND ar.date = CURRENT_DATE),
  CASE WHEN EXISTS (SELECT 1 FROM leaves l WHERE l.employee_id = employees.id AND l.status = 'Approved' AND CURRENT_DATE BETWEEN l.from_date AND l.to_date)
       THEN 'On leave' ELSE 'Not marked' END
) AS attendance`;
const ATTENDANCE_STATUSES = ['Present', 'WFH', 'Half Day', 'On leave', 'Weekly off', 'Holiday', 'Absent', 'Not marked'];

// 3. Employees endpoints
app.get('/api/employees', async (req, res) => {
  try {
    const { department, search } = req.query;
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
    let query = `SELECT *, ${TODAY_ATTENDANCE} FROM employees WHERE ($1::text[] IS NULL OR id=ANY($1))`;
    const params = [req.employeeScope];

    if (department && department !== 'All') {
      params.push(department);
      query += ` AND department = $${params.length}`;
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      query += ` AND (LOWER(name) LIKE $${params.length} OR LOWER(role) LIKE $${params.length} OR LOWER(id) LIKE $${params.length})`;
    }

    params.push(limit, offset);
    query += ` ORDER BY id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ==========================================
// Company Masters API (Department, Role, Designation)
// ==========================================
app.get('/api/masters', async (req, res) => {
  try {
    const { type, department } = req.query;
    const conds = [];
    const params = [];
    if (type) {
      params.push(type.toLowerCase());
      conds.push(`type = $${params.length}`);
    }
    if (department) {
      params.push(department);
      conds.push(`department = $${params.length}`);
    }
    const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
    const query = `SELECT * FROM company_masters${where} ORDER BY type ASC, sort_order ASC NULLS LAST, name ASC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/masters', async (req, res) => {
  try {
    const { type, name, code, description, department, hierarchy_level, sort_order } = req.body;
    if (!type || !name) {
      return res.status(400).json({ error: 'Type and Name are required.' });
    }
    const cleanType = type.trim().toLowerCase();
    const cleanName = name.trim();
    const cleanCode = (code || cleanName.slice(0, 4)).trim().toUpperCase();
    const cleanDept = department ? String(department).trim() : null;
    const cleanTier = hierarchy_level ? String(hierarchy_level).trim() : null;
    const cleanOrder = Number.isInteger(Number(sort_order)) ? Number(sort_order) : 0;

    const result = await pool.query(`
      INSERT INTO company_masters (type, name, code, description, department, hierarchy_level, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (type, name) DO UPDATE SET
        code = EXCLUDED.code,
        description = EXCLUDED.description,
        department = COALESCE(EXCLUDED.department, company_masters.department),
        hierarchy_level = COALESCE(EXCLUDED.hierarchy_level, company_masters.hierarchy_level),
        sort_order = EXCLUDED.sort_order
      RETURNING *
    `, [cleanType, cleanName, cleanCode, description || null, cleanDept, cleanTier, cleanOrder]);

    // Keep departments table synchronized if department type
    if (cleanType === 'department') {
      await pool.query(`
        INSERT INTO departments (name, code, description, hierarchy_order)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description
      `, [cleanName, cleanCode, description || null, cleanOrder]);
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/masters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM company_masters WHERE id = $1', [id]);
    res.json({ success: true, message: 'Master record deleted successfully' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ==========================================
// Employee Management Endpoints
// ==========================================
function parseProbation(duration, unit, required = false) {
  const hasDuration = duration !== undefined && duration !== null && duration !== '';
  const hasUnit = unit !== undefined && unit !== null && unit !== '';
  if (!hasDuration && !hasUnit) {
    return required ? { probationDuration: 90, probationUnit: 'days' } : { probationDuration: null, probationUnit: null };
  }
  const normalizedUnit = hasUnit ? String(unit).trim().toLowerCase() : 'days';
  if (!['days', 'months'].includes(normalizedUnit)) {
    throw invalid('Probation unit must be days or months.');
  }
  const parsedDuration = Number(duration);
  const max = normalizedUnit === 'months' ? 120 : 3650;
  if (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > max) {
    throw invalid(`Probation duration must be a whole number from 1 to ${max} ${normalizedUnit}.`);
  }
  return { probationDuration: parsedDuration, probationUnit: normalizedUnit };
}

app.post('/api/employees', async (req, res) => {
  try {
    const {
      name,
      department,
      role,
      access_role,
      designation,
      manager,
      manager_id,
      status,
      joining_date,
      email,
      phone,
      password,
      probation_duration,
      probation_unit
    } = req.body;

    const { probationDuration, probationUnit } = parseProbation(probation_duration, probation_unit, true);

    if (!name || !department) {
      return res.status(400).json({ error: 'Employee Name and Department are required.' });
    }

    // Resolve Manager info (mapping based on ID)
    let finalManagerName = (manager || '').trim();
    let finalManagerId = manager_id || null;

    if (finalManagerId && !finalManagerName) {
      const mgrRes = await pool.query('SELECT name FROM employees WHERE id = $1', [finalManagerId]);
      if (mgrRes.rows.length > 0) finalManagerName = mgrRes.rows[0].name;
    } else if (finalManagerName && !finalManagerId) {
      const mgrRes = await pool.query('SELECT id FROM employees WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1', [finalManagerName]);
      if (mgrRes.rows.length > 0) finalManagerId = mgrRes.rows[0].id;
    }

    // Leave reporting manager unassigned when neither manager nor manager_id is provided so it can be assigned later.
    finalManagerName = finalManagerName || null;

    const finalDesignation = (designation || role || 'Operations Executive').trim();
    const finalAccessRole = (access_role || 'employee').trim();

    if (typeof password !== 'string' || password.trim().length < 12 || Buffer.byteLength(password.trim()) > 72) throw invalid('A password of 12–72 bytes is required.');
    const trimmedEmail = (email || '').trim().toLowerCase();
    if (trimmedEmail) {
      const existingUser = await pool.query(
        'SELECT employee_id, name FROM user_accounts WHERE LOWER(email) = $1',
        [trimmedEmail]
      );
      if (existingUser.rows.length > 0) {
        return res.status(400).json({
          error: `Email "${email}" is already registered to ${existingUser.rows[0].name} (${existingUser.rows[0].employee_id}). Please use a unique email.`
        });
      }
    }

    await pool.query("SELECT pg_advisory_xact_lock(hashtext('employee-id-allocation'))");
    const maxRes = await pool.query("SELECT id FROM employees WHERE id ~ '^FEM-[0-9]+$' ORDER BY substring(id from 5)::bigint DESC LIMIT 1");
    let nextNum = 15;
    if (maxRes.rows.length > 0) {
      const currentNum = parseInt(maxRes.rows[0].id.replace('FEM-', ''), 10);
      if (!isNaN(currentNum)) nextNum = currentNum + 1;
    }
    const id = `FEM-${String(nextNum).padStart(3, '0')}`;

    const newEmp = await pool.query(
      `INSERT INTO employees (
        id, name, department, role, designation, manager, manager_id, status, attendance, email, phone, access_role, joining_date, probation_duration, probation_unit
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Not marked', $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        id,
        name.trim(),
        department,
        finalDesignation,
        finalDesignation,
        finalManagerName,
        finalManagerId,
        status || 'Probation',
        trimmedEmail || null,
        phone || null,
        finalAccessRole,
        joining_date || businessDate(),
        probationDuration,
        probationUnit
      ]
    );

    // Initialize employee documents
    await pool.query(
      `INSERT INTO employee_documents (employee_id, aadhaar, pan, bank_details, offer_letter)
       VALUES ($1, 'Pending', 'Pending', 'Pending', 'Verified')
       ON CONFLICT (employee_id) DO NOTHING`,
      [id]
    );

    // Initialize encrypted user account with bcrypt
    if (typeof password !== 'string' || password.trim().length < 12 || Buffer.byteLength(password.trim()) > 72) throw invalid('A password of 12–72 bytes is required.');
    const encryptedPin = await hashPin(password);

    const parts = name.trim().split(/\s+/);
    const avatar = parts.length > 1
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : (name ? name.slice(0, 2).toUpperCase() : 'EM');

    const accountEmail = trimmedEmail || `${id.toLowerCase()}@femovo.com`;

    await pool.query(`
      INSERT INTO user_accounts (
        employee_id, email, pin, plain_pin, name, role, ats_role, department, role_title, avatar, is_head_hr, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, 'Active')
      ON CONFLICT (employee_id) DO UPDATE SET
        pin = EXCLUDED.pin,
        plain_pin = EXCLUDED.plain_pin,
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        department = EXCLUDED.department,
        role_title = EXCLUDED.role_title;
    `, [
      id,
      accountEmail,
      encryptedPin,
      null,
      name.trim(),
      finalAccessRole,
      null,
      department,
      finalDesignation,
      avatar
    ]);

    res.status(201).json(newEmp.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Update employee record
app.put('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      department,
      role,
      designation,
      manager,
      manager_id,
      status,
      email,
      phone,
      access_role,
      joining_date,
      password,
      probation_duration,
      probation_unit
    } = req.body;

    const { probationDuration, probationUnit } = parseProbation(probation_duration, probation_unit, false);

    if (password !== undefined && password !== '' && (typeof password !== 'string' || password.trim().length < 12 || Buffer.byteLength(password.trim()) > 72)) throw invalid('Use a password of 12–72 bytes.');
    const trimmedEmail = email ? email.trim().toLowerCase() : null;
    if (trimmedEmail) {
      const existingUser = await pool.query(
        'SELECT employee_id, name FROM user_accounts WHERE LOWER(email) = $1 AND employee_id != $2',
        [trimmedEmail, id]
      );
      if (existingUser.rows.length > 0) {
        return res.status(400).json({
          error: `Email "${email}" is already registered to ${existingUser.rows[0].name} (${existingUser.rows[0].employee_id}). Please use a unique email.`
        });
      }
    }

    // Manager fields support an explicit null so an existing reporting line can be cleared.
    const managerUpdateRequested = Object.prototype.hasOwnProperty.call(req.body, 'manager_id')
      || Object.prototype.hasOwnProperty.call(req.body, 'manager');
    let finalManagerName = manager === undefined ? undefined : (manager == null ? null : String(manager).trim() || null);
    let finalManagerId = manager_id === undefined ? undefined : (manager_id || null);

    if (Object.prototype.hasOwnProperty.call(req.body, 'manager_id') && finalManagerId === null) {
      finalManagerName = null;
    } else if (finalManagerId) {
      if (finalManagerId === id) throw invalid('An employee cannot be their own manager.');
      const mgrRes = await pool.query('SELECT name FROM employees WHERE id = $1', [finalManagerId]);
      if (!mgrRes.rowCount) throw invalid('Manager not found.', 404);
      finalManagerName = mgrRes.rows[0].name;
    } else if (finalManagerName && !finalManagerId) {
      const mgrRes = await pool.query('SELECT id FROM employees WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1', [finalManagerName]);
      if (mgrRes.rows.length > 0) finalManagerId = mgrRes.rows[0].id;
    }

    const finalDesignation = designation || role;

    const empRes = await pool.query(`
      UPDATE employees SET
        name = COALESCE($1, name),
        department = COALESCE($2, department),
        role = COALESCE($3, role),
        designation = COALESCE($4, designation),
        manager = CASE WHEN $12::boolean THEN $5 ELSE manager END,
        manager_id = CASE WHEN $12::boolean THEN $6 ELSE manager_id END,
        status = COALESCE($7, status),
        email = COALESCE($8, email),
        phone = COALESCE($9, phone),
        access_role = COALESCE($10, access_role),
        joining_date = COALESCE($11, joining_date),
        probation_duration = COALESCE($14, probation_duration),
        probation_unit = COALESCE($15, probation_unit)
      WHERE id = $13
      RETURNING *
    `, [
      name?.trim(),
      department,
      finalDesignation?.trim(),
      finalDesignation?.trim(),
      finalManagerName,
      finalManagerId,
      status,
      trimmedEmail,
      phone?.trim(),
      access_role,
      joining_date,
      managerUpdateRequested,
      id,
      probationDuration,
      probationUnit
    ]);

    if (empRes.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // Sync user_accounts
    await pool.query(`
      UPDATE user_accounts SET
        name = COALESCE($1, name),
        department = COALESCE($2, department),
        role = COALESCE($3, role),
        role_title = COALESCE($4, role_title),
        email = COALESCE($5, email)
      WHERE employee_id = $6
    `, [
      name?.trim(),
      department,
      access_role,
      finalDesignation?.trim(),
      trimmedEmail,
      id
    ]);

    // Sync linked recruitment_team profile fields
    await pool.query(`
      UPDATE recruitment_team SET
        name = COALESCE($1, name),
        email = COALESCE($2, email),
        department = COALESCE($3, department)
      WHERE employee_id = $4 OR id = $4
    `, [
      name?.trim(),
      trimmedEmail,
      department,
      id
    ]);

    // If a valid password is provided, encrypt it with bcrypt and update credentials.
    if (password && typeof password === 'string' && password.trim().length >= 12) {
      const trimmedPass = password.trim();
      const encryptedPin = await hashPin(trimmedPass);
      await pool.query(
        'UPDATE user_accounts SET pin = $1, updated_at = NOW() WHERE employee_id = $2',
        [encryptedPin, id]
      );
    }

    if (status === 'Inactive') {
      const moved = await moveEmployeeToTrash(id, req.user?.name || 'Administrator', 'MOVE_TO_TRASH');
      return res.json(moved.resource);
    }

    res.json(empRes.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

async function moveEmployeeToTrash(id, actorName = 'Administrator', actionLabel = 'MOVE_TO_TRASH') {
  const checkRes = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
  if (checkRes.rowCount === 0) return { notFound: true };

  const target = checkRes.rows[0];
  if (target.access_role === 'super_admin') {
    throw invalid('Cannot move Super Admin accounts to Trash.', 400);
  }

  // Keep full employee identity & personal/KYC/history details intact, while removing ALL active access & assignments
  const updateRes = await pool.query(
    `UPDATE employees
     SET status = 'Inactive',
         has_dashboard_access = FALSE,
         access_role = 'employee',
         department = '',
         role = '',
         designation = '',
         manager = NULL,
         manager_id = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  await pool.query(
    `UPDATE user_accounts
     SET status = 'Inactive',
         role = 'employee',
         role_title = '',
         department = '',
         ats_role = NULL,
         recruiter_id = NULL,
         is_head_hr = FALSE,
         is_icc_member = FALSE,
         session_version = session_version + 1,
         updated_at = NOW()
     WHERE employee_id = $1`,
    [id]
  );

  await pool.query(
    "UPDATE recruitment_team SET status = 'Inactive', has_ats_access = FALSE, ats_role = NULL WHERE id = $1 OR employee_id = $1",
    [id]
  );
  await pool.query('DELETE FROM recruiter_assignments WHERE recruiter_id = $1', [id]);

  await pool.query(
    'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
    [
      actorName || 'Administrator',
      actionLabel,
      `Moved ${target.name} (${id}) to Trash and removed all access (previous dept: ${target.department || '—'}, previous role: ${target.access_role || '—'})`
    ]
  );

  return { resource: updateRes.rows[0], previous: target };
}

// Fast Employment Status update (e.g. Confirm 90-day probation or move to Trash)
app.patch('/api/employees/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required.' });

    if (status === 'Inactive') {
      const moved = await moveEmployeeToTrash(id, req.user?.name || 'Administrator', 'MOVE_TO_TRASH');
      if (moved.notFound) return res.status(404).json({ error: 'Employee not found.' });
      return res.json(moved.resource);
    }

    const result = await pool.query(
      'UPDATE employees SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Employee not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Soft-delete / move employee profile to Trash (preserves all details, strips all access)
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const moved = await moveEmployeeToTrash(id, req.user?.name || 'Administrator', 'MOVE_TO_TRASH');
    if (moved.notFound) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ success: true, message: `${moved.previous.name} moved to Trash and all access removed.`, employee: moved.resource });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Password & Credentials Management (Bcrypt Encrypted)
app.get('/api/employees/:id/credentials', async (req,res) => {
  const result=await pool.query('SELECT employee_id,email,role,status,updated_at FROM user_accounts WHERE employee_id=$1',[req.params.id]);
  if (!result.rowCount) throw invalid('Account not found.',404);
  res.json({...result.rows[0],employeeId:req.params.id,hasPassword:true,isBcrypt:true,canViewRaw:false,canEdit:true});
});
app.put('/api/employees/:id/credentials', async (req,res) => {
  const {newPassword,currentPassword}=req.body;
  if(typeof newPassword!=='string'||newPassword.trim().length<12||Buffer.byteLength(newPassword.trim())>72) throw invalid('Use a password of 12–72 bytes.');
  const target=await pool.query('SELECT * FROM user_accounts WHERE employee_id=$1 FOR UPDATE',[req.params.id]);
  if(!target.rowCount) throw invalid('Account not found.',404);
  if(!['super_admin','admin'].includes(req.user.role)) {
    if(req.params.id!==req.user.employeeId || !await verifyPin(currentPassword,target.rows[0].pin)) return res.status(403).json({error:'Current password required to change your own password.'});
  }
  await pool.query('UPDATE user_accounts SET pin=$1,updated_at=NOW() WHERE employee_id=$2',[await hashPin(newPassword),req.params.id]);
  res.json({success:true,message:'Password reset. Previous sessions have been revoked.'});
});

app.patch('/api/employees/:id/attendance', async (req, res) => {
  const { id } = req.params;
  const { attendance, date = businessDate() } = req.body;
  if (!ATTENDANCE_STATUSES.includes(attendance)) throw invalid('Select a valid attendance status.');
  parseDate(date);
  if (!(await pool.query('SELECT id FROM employees WHERE id = $1', [id])).rowCount) throw invalid('Employee not found.', 404);
  if (attendance === 'Not marked') {
    await pool.query('DELETE FROM attendance_records WHERE employee_id = $1 AND date = $2::date', [id, date]);
  } else {
    await pool.query(`
      INSERT INTO attendance_records (employee_id, date, status, notes) VALUES ($1, $2::date, $3, 'Set by HR from the roster')
      ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status
    `, [id, date, attendance]);
  }
  const result = await pool.query(`SELECT *, ${TODAY_ATTENDANCE} FROM employees WHERE id = $1`, [id]);
  res.json(result.rows[0]);
});

// 3.5 Monthly Attendance Timesheet and Calendar
app.get('/api/attendance/monthly', async (req, res) => {
  try {
    const { employeeId = req.user.employeeId, month = businessDate().slice(5,7), year = businessDate().slice(0,4) } = req.query;
    const m = Number(month);
    const y = Number(year);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw invalid('Month must be a whole number between 1 and 12.');
    }
    if (!Number.isInteger(y) || y < 1900 || y > 2100) {
      throw invalid('Year must be a valid 4-digit year.');
    }

    const recordsRes = await pool.query(
      `SELECT *, TO_CHAR(date, 'YYYY-MM-DD') AS date_str FROM attendance_records 
       WHERE employee_id = $1 
         AND EXTRACT(MONTH FROM date) = $2 
         AND EXTRACT(YEAR FROM date) = $3
       ORDER BY date ASC`,
      [employeeId, m, y]
    );

    const records = recordsRes.rows;

    // Calculate monthly summary statistics
    let presentCount = 0;
    let wfhCount = 0;
    let halfDayCount = 0;
    let leaveCount = 0;
    let weeklyOffCount = 0;
    let holidayCount = 0;
    let totalMinutes = 0;

    for (const r of records) {
      if (r.status === 'Present') {
        presentCount++;
        totalMinutes += Number(r.work_duration_minutes || 0);
      } else if (r.status === 'WFH') {
        wfhCount++;
        totalMinutes += Number(r.work_duration_minutes || 0);
      } else if (r.status === 'Half Day') {
        halfDayCount++;
        totalMinutes += Number(r.work_duration_minutes || 0);
      } else if (r.status === 'On leave') {
        leaveCount++;
      } else if (r.status === 'Weekly off') {
        weeklyOffCount++;
      } else if (r.status === 'Holiday') {
        holidayCount++;
      }
    }

    const workingDaysCount = presentCount + wfhCount + halfDayCount + leaveCount;
    const totalWorkingPresent = presentCount + wfhCount + (halfDayCount * 0.5);
    const attendanceRate = workingDaysCount > 0 
      ? ((totalWorkingPresent / workingDaysCount) * 100).toFixed(1) + '%' 
      : '100%';

    const totalHours = (totalMinutes / 60).toFixed(1);
    const avgDailyHours = (presentCount + wfhCount) > 0 
      ? (totalMinutes / (presentCount + wfhCount) / 60).toFixed(1) 
      : '0.0';

    res.json({
      employeeId,
      month: m,
      year: y,
      records,
      stats: {
        presentDays: presentCount,
        wfhDays: wfhCount,
        halfDays: halfDayCount,
        leaveDays: leaveCount,
        weeklyOffs: weeklyOffCount,
        holidays: holidayCount,
        totalWorkingDays: workingDaysCount,
        totalHoursWorked: totalHours,
        avgDailyHours,
        attendanceRate
      }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 3.6 Regularize / Manual Attendance Correction
app.post('/api/attendance/regularize', async (req, res) => {
  try {
    const { 
      employeeId, 
      date, 
      status = 'Present', 
      clockIn = '09:30 AM', 
      clockOut = '06:30 PM', 
      workDurationMinutes = 540, 
      workLocation = 'Office', 
      notes = '', 
      actor = 'Administrator' 
    } = req.body;

    if (typeof employeeId !== 'string' || !employeeId.trim() || !date) {
      return res.status(400).json({ error: 'employeeId and date are required' });
    }
    const cleanEmployeeId = employeeId.trim();
    parseDate(date);
    if (!ATTENDANCE_STATUSES.includes(status)) {
      throw invalid(`Invalid attendance status. Choose one of: ${ATTENDANCE_STATUSES.join(', ')}.`);
    }
    const duration = Number(workDurationMinutes);
    if (!Number.isInteger(duration) || duration < 0 || duration > 1440) {
      throw invalid('Work duration minutes must be a whole number between 0 and 1440.');
    }
    const empCheck = await pool.query('SELECT id FROM employees WHERE id = $1', [cleanEmployeeId]);
    if (empCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const result = await pool.query(
      `INSERT INTO attendance_records 
       (employee_id, date, status, clock_in, clock_out, work_duration_minutes, work_location, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         status = EXCLUDED.status,
         clock_in = EXCLUDED.clock_in,
         clock_out = EXCLUDED.clock_out,
         work_duration_minutes = EXCLUDED.work_duration_minutes,
         work_location = EXCLUDED.work_location,
         notes = EXCLUDED.notes
       RETURNING *`,
      [cleanEmployeeId, date, status, clockIn, clockOut, duration, workLocation, notes]
    );

    // Audit log
    await pool.query(
      `INSERT INTO audit_logs (actor_name, action, details)
       VALUES ($1, 'ATTENDANCE_REGULARIZE', $2)`,
      [actor, `Regularized attendance for ${cleanEmployeeId} on ${date}: ${status} (${clockIn} - ${clockOut})`]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 3.7 Detailed Daily Attendance Roster with Clock-In Details
app.get('/api/attendance/roster', async (req, res) => {
  try {
    const { date = businessDate() } = req.query;
    parseDate(date);
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
    const result = await pool.query(
      `SELECT e.id, e.name, e.department, e.role,
              COALESCE(ar.status, 'Not marked') as status,
              ar.clock_in, ar.clock_out, ar.work_duration_minutes,
              COALESCE(ar.work_location, 'Office') as work_location,
              ar.notes
       FROM employees e
       LEFT JOIN attendance_records ar ON e.id = ar.employee_id AND ar.date = $1::date
       WHERE ($2::text[] IS NULL OR e.id = ANY($2))
       ORDER BY e.id ASC
       LIMIT $3 OFFSET $4`,
      [date, req.employeeScope || null, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 4. Employee Documents endpoints (v3 feature)
app.get('/api/documents/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const result = await pool.query('SELECT * FROM employee_documents WHERE employee_id = $1', [employeeId]);
    if (result.rowCount === 0) {
      return res.json({ employee_id: employeeId, aadhaar: 'Pending', pan: 'Pending', bank_details: 'Pending', offer_letter: 'Pending' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch('/api/documents/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { aadhaar, pan, bank_details, offer_letter } = req.body;
    const result = await pool.query(
      `INSERT INTO employee_documents (employee_id, aadhaar, pan, bank_details, offer_letter)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (employee_id) DO UPDATE SET
         aadhaar = COALESCE($2, employee_documents.aadhaar),
         pan = COALESCE($3, employee_documents.pan),
         bank_details = COALESCE($4, employee_documents.bank_details),
         offer_letter = COALESCE($5, employee_documents.offer_letter)
       RETURNING *`,
      [employeeId, aadhaar, pan, bank_details, offer_letter]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 5. Exit / Offboarding Checklist endpoints (v3 feature)
app.get('/api/exits', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM exits WHERE ($1::text[] IS NULL OR employee_id=ANY($1)) ORDER BY id ASC', [req.employeeScope]);
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/exits', async (req, res) => {
  const { employee_id, resignation_date, last_working_date, reason } = req.body;
  const employee = (await pool.query("SELECT id, name, department, role, status, to_char(joining_date, 'YYYY-MM-DD') AS joining_date FROM employees WHERE id = $1", [employee_id])).rows[0];
  if (!employee) throw invalid('Select an employee.');
  if (['Inactive', 'Exited', 'Terminated'].includes(employee.status)) throw invalid('This person has already left.', 409);
  parseDate(resignation_date);
  parseDate(last_working_date);
  if (last_working_date < resignation_date) throw invalid('The last working date cannot be before the resignation date.');
  const open = await pool.query("SELECT id FROM exits WHERE employee_id = $1 AND status <> 'Completed' FOR UPDATE", [employee.id]);
  if (open.rowCount) throw invalid('This employee already has an exit in progress.', 409);
  const result = await pool.query(`
    INSERT INTO exits (employee_name, department, resignation_date, last_working_date, reason, employee_id, designation, joining_date, handover, assets, access_removal, settlement, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, false, false, false, 'In Progress')
    RETURNING *
  `, [employee.name, employee.department, resignation_date, last_working_date, ticketText(reason, 'Reason', 500, false), employee.id, employee.role, employee.joining_date]);
  res.status(201).json(result.rows[0]);
});

app.patch('/api/exits/:id', async (req, res) => {
  const { id } = req.params;
  const { handover, assets, access_removal, settlement, exit_interview_feedback, rating, eligible_for_rehire, relieving_letter_issued, designation, joining_date, actor } = req.body;

  const cur = await pool.query('SELECT * FROM exits WHERE id = $1 FOR UPDATE', [id]);
  if (cur.rowCount === 0) throw invalid('Exit record not found.', 404);
  const row = cur.rows[0];
  if (row.status === 'Completed' && [handover, assets, access_removal, settlement].includes(false)) throw invalid('A completed exit cannot be reopened.', 409);

  const pick = (value, current) => (value !== undefined ? value : current);
  const newHandover = pick(handover, row.handover);
  const newAssets = pick(assets, row.assets);
  const newAccess = pick(access_removal, row.access_removal);
  const newSettlement = pick(settlement, row.settlement);
  const newIssued = pick(relieving_letter_issued, row.relieving_letter_issued);
  const allDone = newHandover && newAssets && newAccess && newSettlement;

  const result = await pool.query(`
    UPDATE exits SET handover = $1, assets = $2, access_removal = $3, settlement = $4, exit_interview_feedback = $5, rating = $6,
      eligible_for_rehire = $7, relieving_letter_issued = $8, designation = $9, joining_date = $10, status = $11
    WHERE id = $12 RETURNING *
  `, [
    newHandover, newAssets, newAccess, newSettlement, pick(exit_interview_feedback, row.exit_interview_feedback), pick(rating, row.rating),
    pick(eligible_for_rehire, row.eligible_for_rehire), newIssued, pick(designation, row.designation), pick(joining_date, row.joining_date),
    allDone ? 'Completed' : 'In Progress', id
  ]);

  // Ticking "access revoked" removes login straight away; finishing the checklist ends employment.
  if (row.employee_id) {
    if (Boolean(newAccess) !== Boolean(row.access_removal)) {
      await pool.query('UPDATE employees SET has_dashboard_access = $1 WHERE id = $2', [!newAccess, row.employee_id]);
    }
    if ((newAccess && !row.access_removal) || (allDone && row.status !== 'Completed')) {
      await pool.query("UPDATE recruitment_team SET has_ats_access = false, status = 'Inactive' WHERE employee_id = $1 OR id = $1", [row.employee_id]);
    }
    if (allDone && row.status !== 'Completed') {
      await pool.query("UPDATE employees SET status = 'Exited', has_dashboard_access = false WHERE id = $1", [row.employee_id]);
      await pool.query(`INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, 'EMPLOYEE_EXITED', $2)`, [req.user.name, `Exit completed and access ended for ${row.employee_name} (${row.employee_id})`]);
    }
  }

  if (relieving_letter_issued && !row.relieving_letter_issued) {
    await pool.query(
      `INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, 'OFFBOARDING_RELIEVING_LETTER', $2)`,
      [actor || 'Administrator', `Issued formal Relieving & Experience Letter for ${row.employee_name} (${row.department})`]
    );
  }
  res.json(result.rows[0]);
});

// 7. Leave requests endpoints
app.get('/api/leaves', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.*, e.name as employee_name, e.department, e.role, e.designation, e.access_role,
        (
          EXISTS (SELECT 1 FROM trainer_schedules ts WHERE ts.trainer_id = e.id AND ts.active = TRUE)
          OR LOWER(COALESCE(e.role, '') || ' ' || COALESCE(e.designation, '')) ~ '(trainer|yoga|zumba|face yoga)'
          OR e.access_role = 'trainers'
        ) AS is_trainer
      FROM leaves l 
      JOIN employees e ON l.employee_id = e.id 
      WHERE ($1::text[] IS NULL OR l.employee_id=ANY($1))
      ORDER BY l.created_at DESC
    `, [req.employeeScope]);
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/leaves', createLeave);
app.patch('/api/leaves/:id/status', decideLeave);

// Recruitment ATS: candidates, jobs, recruiters, import/export and team access.
registerAtsRoutes(app);
registerWorkflowRoutes(app);
registerTrainerRoutes(app);

// 9b. Employee Full Personal Details & Joining Onboarding Form
app.get('/api/onboarding/profile/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const empRes = await pool.query('SELECT * FROM employees WHERE id = $1', [employeeId]);
    if (empRes.rowCount === 0) return res.status(404).json({ error: 'Employee not found' });
    const emp = empRes.rows[0];

    const pdRes = await pool.query('SELECT * FROM employee_personal_details WHERE employee_id = $1', [employeeId]);
    const personalDetails = pdRes.rows[0] || {
      employee_id: employeeId,
      onboarding_submitted: false,
      personal_email: emp.email || '',
      phone: emp.phone || ''
    };

    const docsRes = await pool.query(
      'SELECT * FROM employee_uploaded_documents WHERE employee_id = $1 ORDER BY uploaded_at DESC',
      [employeeId]
    );

    res.json({
      employee: emp,
      personalDetails,
      documents: docsRes.rows
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/onboarding/profile/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const {
      dob, gender, blood_group, marital_status,
      personal_email, phone,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
      current_address, permanent_address,
      pan_number, aadhaar_number,
      bank_name, bank_account_no, bank_ifsc, bank_account_holder, uan_number
    } = req.body;

    if (req.body.declaration !== true) throw invalid('Confirm the accuracy declaration before submitting.');
    if (dob) parseDate(dob);
    if (bank_account_no && !/^\d{9,18}$/.test(bank_account_no)) throw invalid('Enter a valid bank account number.');
    if (bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bank_ifsc)) throw invalid('Enter a valid uppercase IFSC.');

    const result = await pool.query(`
      INSERT INTO employee_personal_details (
        employee_id, dob, gender, blood_group, marital_status,
        personal_email, phone,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
        current_address, permanent_address,
        pan_number, aadhaar_number,
        bank_name, bank_account_no, bank_ifsc, bank_account_holder, uan_number,
        onboarding_submitted, submitted_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7,
        $8, $9, $10,
        $11, $12,
        $13, $14,
        $15, $16, $17, $18, $19,
        true, NOW()
      )
      ON CONFLICT (employee_id) DO UPDATE SET
        dob = EXCLUDED.dob,
        gender = EXCLUDED.gender,
        blood_group = EXCLUDED.blood_group,
        marital_status = EXCLUDED.marital_status,
        personal_email = EXCLUDED.personal_email,
        phone = EXCLUDED.phone,
        emergency_contact_name = EXCLUDED.emergency_contact_name,
        emergency_contact_phone = EXCLUDED.emergency_contact_phone,
        emergency_contact_relation = EXCLUDED.emergency_contact_relation,
        current_address = EXCLUDED.current_address,
        permanent_address = EXCLUDED.permanent_address,
        pan_number = EXCLUDED.pan_number,
        aadhaar_number = EXCLUDED.aadhaar_number,
        bank_name = EXCLUDED.bank_name,
        bank_account_no = EXCLUDED.bank_account_no,
        bank_ifsc = EXCLUDED.bank_ifsc,
        bank_account_holder = EXCLUDED.bank_account_holder,
        uan_number = EXCLUDED.uan_number,
        onboarding_submitted = true,
        hr_verified = false,
        hr_verified_at = NULL,
        hr_verified_by = NULL,
        submitted_at = NOW()
      RETURNING *
    `, [
      employeeId, dob || null, gender || null, blood_group || null, marital_status || null,
      personal_email || null, phone || null,
      emergency_contact_name || null, emergency_contact_phone || null, emergency_contact_relation || null,
      current_address || null, permanent_address || null,
      pan_number || null, aadhaar_number || null,
      bank_name || null, bank_account_no || null, bank_ifsc || null, bank_account_holder || null, uan_number || null
    ]);

    // Keep personal contact details separate from the administrative work email.
    if (phone) await pool.query('UPDATE employees SET phone=$1 WHERE id=$2', [phone,employeeId]);

    // Add audit log
    await pool.query(`
      INSERT INTO audit_logs (actor_name, action, details)
      VALUES ($1, 'ONBOARDING_SUBMIT', $2)
    `, [`Employee (${employeeId})`, 'Submitted full personal & statutory details and joining formalities']);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 9c. Document Upload Endpoint
app.post('/api/onboarding/upload/:employeeId', upload.single('file'), async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { docType } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!docType) return res.status(400).json({ error: 'Document type is required' });

    const fileUrl = `/uploads/${req.file.filename}`;
    const fileName = req.file.originalname;
    const fileSize = req.file.size;
    const fileMime = req.file.mimetype;

    const docRes = await pool.query(`
      INSERT INTO employee_uploaded_documents (employee_id, doc_type, file_name, file_url, file_size, file_mime, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'Under Review')
      RETURNING *
    `, [employeeId, docType, fileName, fileUrl, fileSize, fileMime]);
    await pool.query('UPDATE employee_personal_details SET hr_verified=false,hr_verified_at=NULL,hr_verified_by=NULL WHERE employee_id=$1',[employeeId]);

    // Sync legacy employee_documents table
    const docMap = {
      aadhaar: 'aadhaar',
      pan: 'pan',
      bank_proof: 'bank_details'
    };
    if (docMap[docType]) {
      await pool.query(`
        INSERT INTO employee_documents (employee_id, ${docMap[docType]})
        VALUES ($1, 'Pending')
        ON CONFLICT (employee_id) DO UPDATE SET ${docMap[docType]} = 'Pending'
      `, [employeeId]);
    }

    // Audit log
    await pool.query(`
      INSERT INTO audit_logs (actor_name, action, details)
      VALUES ($1, 'DOCUMENT_UPLOAD', $2)
    `, [`Employee (${employeeId})`, `Uploaded ${docType.toUpperCase()}: ${fileName}`]);

    res.status(201).json(docRes.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 9d. Delete Uploaded Document
app.delete('/api/onboarding/document/:id', async (req, res) => {
  try {
    const docId = Number(req.params.id);
    if (!Number.isInteger(docId) || docId < 1) {
      return res.status(400).json({ error: 'Invalid document ID' });
    }
    const cur = await pool.query('SELECT * FROM employee_uploaded_documents WHERE id = $1 FOR UPDATE', [docId]);
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    const doc = cur.rows[0];

    await pool.query('DELETE FROM employee_uploaded_documents WHERE id = $1', [docId]);
    await pool.query('UPDATE employee_personal_details SET hr_verified=false,hr_verified_at=NULL,hr_verified_by=NULL WHERE employee_id=$1', [doc.employee_id]);
    await scheduleUploadCleanup(req, doc.file_url);
    res.json({ message: 'Document deleted successfully', id: docId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

const DOCUMENT_REVIEW_STATUSES = ['Verified', 'Rejected', 'Under Review'];

// 9e. HR Document Review / Verification
app.patch('/api/onboarding/document/:id/status', async (req, res) => {
  try {
    const docId = Number(req.params.id);
    if (!Number.isInteger(docId) || docId < 1) {
      throw invalid('Invalid document ID.');
    }
    const { status, rejection_reason, actor, verification_notes } = req.body;
    if (!DOCUMENT_REVIEW_STATUSES.includes(status)) {
      throw invalid('Status must be Verified, Rejected, or Under Review.');
    }
    const isVerified = status === 'Verified';
    const verifierName = actor || 'Administrator';
    
    const result = await pool.query(`
      UPDATE employee_uploaded_documents 
      SET status = $1, 
          rejection_reason = $2,
          verified_by = $3,
          verified_at = $4,
          verification_badge = $5,
          verification_notes = $6
      WHERE id = $7
      RETURNING *
    `, [
      status, 
      rejection_reason || null,
      isVerified ? verifierName : null,
      isVerified ? new Date() : null,
      isVerified ? 'Reviewed by HR' : null,
      verification_notes || null,
      docId
    ]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    const updated = result.rows[0];

    // Audit log
    await pool.query(`
      INSERT INTO audit_logs (actor_name, action, details)
      VALUES ($1, 'DOCUMENT_REVIEW', $2)
    `, [verifierName, `${isVerified ? 'Issued "Reviewed by HR" badge' : 'Set status to "' + status + '"'} for ${updated.doc_type.toUpperCase()} of employee ${updated.employee_id}`]);

    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 9f. Get All Onboarding Submissions (for HR review dashboard)
app.get('/api/onboarding/submissions', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 1000 });
    const result = await pool.query(`
      SELECT 
        e.id as employee_id,
        e.name,
        e.department,
        e.role,
        e.status as emp_status,
        pd.onboarding_submitted,
        pd.submitted_at,
        pd.hr_verified,
        pd.hr_verified_at,
        pd.hr_verified_by,
        pd.pan_number,
        pd.aadhaar_number,
        pd.bank_name,
        pd.bank_account_no,
        pd.phone,
        pd.personal_email,
        COUNT(eud.id) as doc_count,
        COUNT(CASE WHEN eud.status = 'Verified' THEN 1 END) as verified_doc_count,
        COUNT(CASE WHEN eud.status = 'Under Review' THEN 1 END) as pending_doc_count
      FROM employees e
      LEFT JOIN employee_personal_details pd ON e.id = pd.employee_id
      LEFT JOIN employee_uploaded_documents eud ON e.id = eud.employee_id
      GROUP BY e.id, e.name, e.department, e.role, e.status, pd.onboarding_submitted, pd.submitted_at, pd.hr_verified, pd.hr_verified_at, pd.hr_verified_by, pd.pan_number, pd.aadhaar_number, pd.bank_name, pd.bank_account_no, pd.phone, pd.personal_email
      ORDER BY 
        CASE WHEN pd.onboarding_submitted = true AND (pd.hr_verified IS NULL OR pd.hr_verified = false) THEN 0
             WHEN pd.onboarding_submitted IS NULL OR pd.onboarding_submitted = false THEN 1
             ELSE 2 END,
        e.id ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

const requiredOnboardingDocuments = [
  ['aadhaar', 'Aadhaar Card'],
  ['pan', 'PAN Card'],
  ['bank_proof', 'Bank Proof'],
  ['degree', 'Highest Degree Certificate'],
  ['photo', 'Passport Photograph']
];

// 9g. HR Mark Entire Onboarding Profile Verified
app.patch('/api/onboarding/profile/:employeeId/verify', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { verified, notes, actor } = req.body;
    if (typeof verified !== 'boolean') throw invalid('Choose whether the profile is verified.');
    const verifierName = actor || 'Administrator';

    const profile = await pool.query(
      'SELECT onboarding_submitted FROM employee_personal_details WHERE employee_id = $1 FOR UPDATE',
      [employeeId]
    );
    if (!profile.rowCount) throw invalid('Onboarding profile not found.', 404);

    if (verified) {
      if (profile.rows[0].onboarding_submitted !== true) {
        throw invalid('The employee must submit the onboarding form before verification.', 409);
      }

      const requiredTypes = requiredOnboardingDocuments.map(([type]) => type);
      const documents = await pool.query(
        'SELECT doc_type FROM employee_uploaded_documents WHERE employee_id = $1 AND doc_type = ANY($2::text[]) FOR UPDATE',
        [employeeId, requiredTypes]
      );
      const uploadedTypes = new Set(documents.rows.map(document => document.doc_type));
      const missingDocuments = requiredOnboardingDocuments
        .filter(([type]) => !uploadedTypes.has(type))
        .map(([, label]) => label);
      if (missingDocuments.length) {
        throw invalid(`Upload all required documents before verification. Missing: ${missingDocuments.join(', ')}.`, 409);
      }
    }

    const result = await pool.query(`
      UPDATE employee_personal_details
      SET hr_verified = $1, 
          hr_verified_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
          hr_verified_by = CASE WHEN $1 THEN $2 ELSE NULL END,
          hr_notes = $3
      WHERE employee_id = $4
      RETURNING *
    `, [Boolean(verified), verifierName, notes || null, employeeId]);

    if (verified) {
      await pool.query(`
        UPDATE employee_uploaded_documents
        SET status = 'Verified',
            verified_by = $1,
            verified_at = NOW(),
            verification_badge = 'Reviewed by HR'
        WHERE employee_id = $2
      `, [verifierName, employeeId]);
    }

    await pool.query(`
      INSERT INTO audit_logs (actor_name, action, details)
      VALUES ($1, 'ONBOARDING_VERIFY', $2)
    `, [verifierName, `${verified ? 'Approved & Issued Corporate KYC Compliance Seal' : 'Updated'} onboarding profile for employee ${employeeId}`]);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 10. Training endpoints
const TRAINING_STATUSES = ['Draft', 'Published', 'Archived'];
const isAssignedTo = (assignment, person) => assignment.scope === 'all'
  || (assignment.scope === 'department' && assignment.target === person.department)
  || (assignment.scope === 'employee' && assignment.target === person.id);
const earliestDue = assignments => assignments.map(a => a.due_date).filter(Boolean).sort()[0] || null;

function readYoutubeVideo(value) {
  const raw = ticketText(value, 'YouTube video link', 500, false);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw invalid('Enter a valid YouTube video link.'); }
  if (url.protocol !== 'https:') throw invalid('YouTube video links must use https://.');

  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  let videoId = null;
  if (host === 'youtu.be') videoId = path[0];
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (path[0] === 'watch') videoId = url.searchParams.get('v');
    if (['embed', 'shorts', 'live'].includes(path[0])) videoId = path[1];
  }
  if (['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host) && path[0] === 'embed') videoId = path[1];
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw invalid('Enter a YouTube watch, share, Shorts, live, or embed link for one video.');
  return { video_url: `https://www.youtube.com/watch?v=${videoId}`, video_id: videoId };
}

function readCourse(body) {
  const status = body.status;
  if (!TRAINING_STATUSES.includes(status)) throw invalid('Select a valid status.');
  const published = status === 'Published';
  const passPercent = body.pass_percent;
  if (!Number.isInteger(passPercent) || passPercent < 1 || passPercent > 100) throw invalid('Pass mark must be a whole number from 1 to 100.');
  if (!Array.isArray(body.lessons) || body.lessons.length > 50) throw invalid('Add up to 50 lessons.');
  if (!Array.isArray(body.quiz) || body.quiz.length > 50) throw invalid('Add up to 50 quiz questions.');
  if (published && (!body.lessons.length || !body.quiz.length)) throw invalid('A published course needs at least one lesson and one quiz question.');

  const lessons = body.lessons.map(lesson => {
    const video = readYoutubeVideo(lesson?.video_url);
    const link = ticketText(lesson?.link, 'Lesson link', 500, false);
    if (link && !/^https?:\/\/\S+$/i.test(link)) throw invalid('Lesson links must start with http:// or https://.');
    const body = ticketText(lesson?.body, 'Lesson content', 20000, false) || '';
    if (published && !body && !video) throw invalid('Each published lesson needs written content or a YouTube video.');
    return { title: ticketText(lesson?.title, 'Lesson title', 200), body, ...(video || {}), ...(link ? { link } : {}) };
  });
  const quiz = body.quiz.map(item => {
    if (!Array.isArray(item?.options) || item.options.length < 2 || item.options.length > 6) throw invalid('Each question needs 2 to 6 answers.');
    const options = item.options.map(option => ticketText(option, 'Answer', 500));
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer >= options.length) throw invalid('Mark the correct answer for each question.');
    return { question: ticketText(item.question, 'Question', 500), options, answer: item.answer };
  });
  return {
    title: ticketText(body.title, 'Title', 150),
    department: ticketText(body.department, 'Department', 100),
    description: ticketText(body.description, 'Description', 2000, false),
    duration: ticketText(body.duration, 'Duration', 30, false),
    passPercent, status, lessons, quiz
  };
}

async function publishedCourse(id) {
  const course = (await pool.query("SELECT * FROM training WHERE id = $1 AND status = 'Published'", [id])).rows[0];
  if (!course) throw invalid('This course is not available.', 404);
  return course;
}

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

app.get('/api/training', async (req, res) => {
  const { canManage, scope } = req.training;
  const me = { id: req.user.employeeId, department: req.user.department };
  const [courses, assignments, progress, people] = await Promise.all([
    pool.query(`
      SELECT id, title, department, description, duration, pass_percent, status,
        COALESCE(
          (SELECT jsonb_agg(jsonb_build_object('title', elem->>'title'))
           FROM jsonb_array_elements(COALESCE(lesson_items, '[]'::jsonb)) AS elem),
          '[]'::jsonb
        ) AS lesson_items,
        jsonb_array_length(COALESCE(lesson_items, '[]'::jsonb))::int AS lesson_count,
        jsonb_array_length(COALESCE(quiz_items, '[]'::jsonb))::int AS question_count
      FROM training ${canManage ? '' : "WHERE status = 'Published'"}
      ORDER BY title ASC
    `),
    pool.query("SELECT id, training_id, scope, target, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM training_assignments ORDER BY id ASC"),
    pool.query('SELECT training_id, opened_at, attempts, best_percent, passed_at, certificate_no FROM training_progress WHERE employee_id = $1', [req.user.employeeId]),
    canManage ? pool.query("SELECT id, name, department FROM employees WHERE status NOT IN ('Inactive', 'Exited', 'Terminated') ORDER BY name ASC") : { rows: [] }
  ]);
  const today = businessDate();
  res.json({
    courses: courses.rows.map(course => {
      const mine = assignments.rows.filter(a => a.training_id === course.id && isAssignedTo(a, me));
      const record = progress.rows.find(row => row.training_id === course.id) || null;
      const dueDate = earliestDue(mine);
      return { ...course, assigned: mine.length > 0, due_date: dueDate, overdue: Boolean(dueDate && dueDate < today && !record?.passed_at), progress: record };
    }),
    canManage,
    hasTeam: scope === null || scope.length > 1,
    people: people.rows,
    assignments: canManage ? assignments.rows : []
  });
});

app.get('/api/training/tracking', async (req, res) => {
  const scope = req.training.scope;
  const [people, courses, assignments] = await Promise.all([
    pool.query("SELECT id, name, department FROM employees WHERE status NOT IN ('Inactive', 'Exited', 'Terminated') AND ($1::text[] IS NULL OR id = ANY($1)) ORDER BY name ASC", [scope]),
    pool.query("SELECT id, title FROM training WHERE status = 'Published' ORDER BY title ASC"),
    pool.query("SELECT training_id, scope, target, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM training_assignments")
  ]);
  const ids = people.rows.map(person => person.id);
  const progress = await pool.query('SELECT employee_id, training_id, best_percent, passed_at FROM training_progress WHERE employee_id = ANY($1::text[])', [ids]);
  const today = businessDate();
  const rows = [];
  for (const person of people.rows) {
    for (const course of courses.rows) {
      const mine = assignments.rows.filter(a => a.training_id === course.id && isAssignedTo(a, person));
      if (!mine.length) continue;
      const record = progress.rows.find(row => row.employee_id === person.id && row.training_id === course.id);
      const dueDate = earliestDue(mine);
      rows.push({
        employee_id: person.id, name: person.name, department: person.department,
        training_id: course.id, title: course.title, due_date: dueDate,
        best_percent: record?.best_percent ?? null, passed_at: record?.passed_at ?? null,
        status: record?.passed_at ? 'Completed' : (dueDate && dueDate < today ? 'Overdue' : 'Pending')
      });
    }
  }
  res.json(rows);
});

app.get('/api/training/:id', async (req, res) => {
  const { canManage } = req.training;
  const result = await pool.query(
    `SELECT id, title, department, description, duration, pass_percent, status, lesson_items,
            jsonb_array_length(COALESCE(quiz_items, '[]'::jsonb))::int AS question_count
     FROM training
     WHERE id = $1 ${canManage ? '' : "AND status = 'Published'"}`,
    [req.params.id]
  );
  if (!result.rowCount) throw invalid('Training course not found.', 404);
  res.json(result.rows[0]);
});

app.post('/api/training/:id/open', async (req, res) => {
  await publishedCourse(req.params.id);
  await pool.query(`
    INSERT INTO training_progress (employee_id, training_id, opened_at) VALUES ($1, $2, NOW())
    ON CONFLICT (employee_id, training_id) DO UPDATE SET opened_at = COALESCE(training_progress.opened_at, NOW())
  `, [req.user.employeeId, req.params.id]);
  res.json({ opened: true });
});

async function requireOpened(employeeId, courseId) {
  const progress = await pool.query('SELECT opened_at FROM training_progress WHERE employee_id = $1 AND training_id = $2', [employeeId, courseId]);
  if (!progress.rows[0]?.opened_at) throw invalid('Open the lessons before taking the quiz.', 409);
}

// Questions go out without answers, and answer order changes on every attempt.
app.get('/api/training/:id/quiz', async (req, res) => {
  const course = await publishedCourse(req.params.id);
  await requireOpened(req.user.employeeId, course.id);
  res.json({
    pass_percent: course.pass_percent,
    questions: course.quiz_items.map((item, index) => ({
      index, question: item.question,
      options: shuffled(item.options.map((text, id) => ({ id, text })))
    }))
  });
});

app.post('/api/training/:id/attempts', async (req, res) => {
  const course = await publishedCourse(req.params.id);
  await requireOpened(req.user.employeeId, course.id);
  const answers = req.body.answers;
  const questions = course.quiz_items;
  if (!answers || typeof answers !== 'object' || !questions.every((_, index) => Number.isInteger(answers[index]))) throw invalid('Answer every question before submitting.');
  const score = questions.filter((item, index) => answers[index] === item.answer).length;
  const percent = Math.round((score / questions.length) * 100);
  const passed = (score / questions.length) * 100 >= course.pass_percent;
  const certificate = `FEM-CERT-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const result = await pool.query(`
    UPDATE training_progress SET
      attempts = attempts + 1, last_attempt_at = NOW(), best_percent = GREATEST(best_percent, $1::int),
      passed_at = CASE WHEN $2::boolean THEN COALESCE(passed_at, NOW()) ELSE passed_at END,
      certificate_no = CASE WHEN $2::boolean THEN COALESCE(certificate_no, $3::text) ELSE certificate_no END
    WHERE employee_id = $4 AND training_id = $5
    RETURNING attempts, best_percent, passed_at, certificate_no
  `, [percent, passed, certificate, req.user.employeeId, course.id]);
  res.status(201).json({ score, total: questions.length, percent, passed, progress: result.rows[0] });
});

// Course management below includes the answer key and is limited to HR and administrators.
app.get('/api/training/:id/admin', async (req, res) => {
  const course = (await pool.query('SELECT id, title, department, description, duration, pass_percent, status, lesson_items, quiz_items FROM training WHERE id = $1', [req.params.id])).rows[0];
  if (!course) throw invalid('Course not found.', 404);
  res.json(course);
});

app.post('/api/training', async (req, res) => {
  const course = readCourse(req.body);
  const result = await pool.query(`
    INSERT INTO training (title, department, description, duration, pass_percent, status, lesson_items, quiz_items)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) RETURNING id
  `, [course.title, course.department, course.description, course.duration, course.passPercent, course.status, JSON.stringify(course.lessons), JSON.stringify(course.quiz)]);
  res.status(201).json(result.rows[0]);
});

app.put('/api/training/:id', async (req, res) => {
  const course = readCourse(req.body);
  const result = await pool.query(`
    UPDATE training SET title = $1, department = $2, description = $3, duration = $4, pass_percent = $5, status = $6,
      lesson_items = $7::jsonb, quiz_items = $8::jsonb, updated_at = NOW()
    WHERE id = $9 RETURNING id
  `, [course.title, course.department, course.description, course.duration, course.passPercent, course.status, JSON.stringify(course.lessons), JSON.stringify(course.quiz), req.params.id]);
  if (!result.rowCount) throw invalid('Course not found.', 404);
  res.json(result.rows[0]);
});

app.post('/api/training/:id/assignments', async (req, res) => {
  const { scope, target, due_date } = req.body;
  if (!['all', 'department', 'employee'].includes(scope)) throw invalid('Choose who this is for.');
  const assignedTo = scope === 'all' ? null : ticketText(target, scope === 'department' ? 'Department' : 'Person', 100);
  if (scope === 'employee' && !(await pool.query('SELECT id FROM employees WHERE id = $1', [assignedTo])).rowCount) throw invalid('Employee not found.', 404);
  if (scope === 'department' && !(await pool.query('SELECT id FROM departments WHERE name = $1', [assignedTo])).rowCount) throw invalid('Department not found.', 404);
  if (due_date) parseDate(due_date);
  if (!(await pool.query('SELECT id FROM training WHERE id = $1', [req.params.id])).rowCount) throw invalid('Course not found.', 404);
  const result = await pool.query(`
    INSERT INTO training_assignments (training_id, scope, target, due_date, assigned_by_name) VALUES ($1, $2, $3, $4, $5)
    RETURNING id, training_id, scope, target, to_char(due_date, 'YYYY-MM-DD') AS due_date
  `, [req.params.id, scope, assignedTo, due_date || null, req.user.name]);
  res.status(201).json(result.rows[0]);
});

app.delete('/api/training/assignments/:id', async (req, res) => {
  const result = await pool.query('DELETE FROM training_assignments WHERE id = $1', [req.params.id]);
  if (!result.rowCount) throw invalid('Assignment not found.', 404);
  res.json({ removed: true });
});

// 12. Company Announcements (Notice Board)
app.get('/api/announcements', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/announcements', async (req, res) => {
  try {
    const { title, content, category, posted_by } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and content required' });

    const result = await pool.query(`
      INSERT INTO announcements (title, content, category, posted_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [title.trim(), content.trim(), category || 'General', posted_by || 'HR Admin']);

    await pool.query(`
      INSERT INTO audit_logs (actor_name, action, details)
      VALUES ($1, 'ANNOUNCEMENT_POST', $2)
    `, [posted_by || 'HR Admin', `Posted announcement: "${title}"`]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// React to announcement (thumbs, heart, celebrate)
app.patch('/api/announcements/:id/react', async (req, res) => {
  try {
    const { id } = req.params;
    const { type } = req.body;
    if (!['thumbs', 'heart', 'celebrate'].includes(type)) {
      return res.status(400).json({ error: 'Invalid reaction type' });
    }

    const result = await pool.query(
      `UPDATE announcements
       SET reactions = jsonb_set(
         COALESCE(reactions, '{}'::jsonb),
         ARRAY[$2]::text[],
         to_jsonb(COALESCE((reactions ->> $2)::integer, 0) + 1),
         true
       )
       WHERE id = $1
       RETURNING *`,
      [id, type]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Announcement not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Acknowledge announcement
app.patch('/api/announcements/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeName } = req.body;
    if (!employeeName) return res.status(400).json({ error: 'employeeName required' });

    const result = await pool.query(
      `UPDATE announcements
       SET acknowledgements = CASE
         WHEN (CASE WHEN jsonb_typeof(acknowledgements) = 'array' THEN acknowledgements ELSE '[]'::jsonb END)
              @> jsonb_build_array($2::text)
           THEN CASE WHEN jsonb_typeof(acknowledgements) = 'array' THEN acknowledgements ELSE '[]'::jsonb END
         ELSE (CASE WHEN jsonb_typeof(acknowledgements) = 'array' THEN acknowledgements ELSE '[]'::jsonb END)
              || jsonb_build_array($2::text)
       END
       WHERE id = $1
       RETURNING *`,
      [id, employeeName]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Announcement not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 13B. Peer-to-Peer Kudos & Appreciation
app.get('/api/kudos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kudos ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/kudos', async (req, res) => {
  try {
    const { from_name, from_role, to_name, to_employee_id, category, message, badge_emoji } = req.body;
    if (!from_name || !to_name || !message) {
      return res.status(400).json({ error: 'from_name, to_name and message required' });
    }

    const result = await pool.query(`
      INSERT INTO kudos (from_name, from_role, to_name, to_employee_id, category, message, badge_emoji, likes_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
      RETURNING *
    `, [
      from_name.trim(),
      from_role || 'Team Member',
      to_name.trim(),
      to_employee_id || null,
      category || 'Teamwork',
      message.trim(),
      badge_emoji || '🌟'
    ]);

    await pool.query(`
      INSERT INTO audit_logs (actor_name, action, details)
      VALUES ($1, 'KUDOS_GIVEN', $2)
    `, [from_name, `Applauded ${to_name}: "${message.slice(0, 50)}..."`]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch('/api/kudos/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE kudos SET likes_count = COALESCE(likes_count, 0) + 1 WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Kudos not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 14. Leave Balances
app.get('/api/leaves/balances', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT lb.*, e.name, e.department, e.role 
      FROM leave_balances lb
      JOIN employees e ON lb.employee_id = e.id
      WHERE ($1::text[] IS NULL OR lb.employee_id=ANY($1))
      ORDER BY e.id ASC
    `, [req.employeeScope]);
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 15. Audit Logs
app.get('/api/audit-logs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 16. Universal CSV Export Endpoints
app.get('/api/export/employees', async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 5000, maxLimit: 10000 });
    const result = await pool.query(
      `SELECT id, name, department, role, manager, status, ${TODAY_ATTENDANCE}, email, phone FROM employees ORDER BY id ASC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    let csv = 'ID,Name,Department,Role,Reporting Manager,Status,Attendance,Email,Phone\n';
    result.rows.forEach(r => {
      csv += [r.id,r.name,r.department,r.role,r.manager,r.status,r.attendance,r.email || '',r.phone || ''].map(csvCell).join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="femovo_employees.csv"');
    res.send(csv);
  } catch (err) {
    res.status(err.status || 500).send(err.status ? err.message : 'The export could not be completed.');
  }
});

app.get('/api/export/attendance', async (req, res) => {
  try {
    const { from, to } = parseDateRange(req.query, { defaultDays: 90, maxDays: 366, anchorDate: businessDate() });
    const { limit, offset } = parsePagination(req.query, { defaultLimit: 5000, maxLimit: 10000 });
    const result = await pool.query(`
      SELECT 
        ar.id, 
        ar.employee_id, 
        e.name, 
        e.department, 
        TO_CHAR(ar.date, 'YYYY-MM-DD') as date_str, 
        ar.status, 
        ar.clock_in, 
        ar.clock_out, 
        ar.work_duration_minutes, 
        ar.work_location, 
        ar.notes
      FROM attendance_records ar
      JOIN employees e ON ar.employee_id = e.id
      WHERE ar.date BETWEEN $1::date AND $2::date
      ORDER BY ar.date DESC, ar.employee_id ASC
      LIMIT $3 OFFSET $4
    `, [from, to, limit, offset]);
    let csv = 'Record ID,Employee ID,Employee Name,Department,Date,Status,Clock In,Clock Out,Duration (Mins),Work Location,Regularization Notes\n';
    result.rows.forEach(r => {
      const cleanNotes = (r.notes || '');
      csv += [r.id,r.employee_id,r.name,r.department,r.date_str,r.status,r.clock_in || '',r.clock_out || '',r.work_duration_minutes || 0,r.work_location || 'Office',cleanNotes].map(csvCell).join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="femovo_attendance_records.csv"');
    res.send(csv);
  } catch (err) {
    res.status(err.status || 500).send(err.status ? err.message : 'The export could not be completed.');
  }
});

// ESS Helpdesk & POSH Grievances API
const POSH_CATEGORY = 'POSH / Harassment';
const REQUEST_TYPES = ['Problem', 'Suggestion', 'New Idea'];
const REQUEST_RECIPIENTS = ['CEO', 'HR', 'Team Head'];
const CONVERSATION_STATUSES = ['Open', 'In Progress', 'Resolved'];
const POSH_STATUSES = ['Received', 'Under Inquiry', 'Report Submitted', 'Closed'];
const TICKET_PRIORITIES = ['Normal', 'Medium', 'High'];
const ICC_NAME = 'Internal Complaints Committee (ICC)';
// to_char keeps node-postgres from shifting a DATE across the UTC boundary when it is serialized.
const TICKET_SELECT = `
  SELECT t.*, to_char(t.incident_date, 'YYYY-MM-DD') AS incident_date,
         COALESCE(m.message_count, 0) AS message_count, m.last_author_id,
         COALESCE(m.last_at, t.created_at) AS last_activity
  FROM support_tickets t
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS message_count, MAX(created_at) AS last_at,
           (SELECT author_id FROM ticket_messages latest WHERE latest.ticket_id = t.id ORDER BY latest.id DESC LIMIT 1) AS last_author_id
    FROM ticket_messages WHERE ticket_id = t.id
  ) m ON TRUE`;
const ticketById = async id => (await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [id])).rows[0];

function ticketText(value, label, max, required = true) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw invalid(`${label} is required.`);
  if (text.length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
  return text || null;
}

async function activeIccMemberCount() {
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM user_accounts WHERE is_icc_member = TRUE AND status = 'Active'");
  return result.rows[0]?.count || 0;
}

// The CEO is the active account whose job title says so, otherwise the first super admin.
async function findCeo() {
  const titled = await pool.query(`
    SELECT e.id, e.name FROM employees e
    JOIN user_accounts u ON u.employee_id = e.id AND u.status = 'Active'
    WHERE e.role ~* '\\mCEO\\M|chief executive'
    ORDER BY e.id LIMIT 1
  `);
  if (titled.rowCount) return titled.rows[0];
  const admin = await pool.query("SELECT employee_id AS id, name FROM user_accounts WHERE role = 'super_admin' AND status = 'Active' AND employee_id IS NOT NULL ORDER BY id LIMIT 1");
  return admin.rows[0] || null;
}

// A team head is the assigned manager, otherwise the named manager or department head.
async function findTeamHead(employeeId) {
  const result = await pool.query(`
    SELECT h.id, h.name
    FROM employees me
    JOIN employees h ON h.id = me.manager_id OR (
      me.manager_id IS NULL AND LOWER(h.name) = LOWER(COALESCE(NULLIF(me.manager, ''),
        (SELECT head_of_department FROM departments d WHERE d.name = me.department)))
    )
    JOIN user_accounts u ON u.employee_id = h.id AND u.status = 'Active'
    WHERE me.id = $1 AND h.id <> me.id
    ORDER BY h.id LIMIT 1
  `, [employeeId]);
  return result.rows[0] || null;
}

app.get('/api/tickets/access', async (req, res) => {
  const [ceo, teamHead, iccMembers] = await Promise.all([findCeo(), findTeamHead(req.user.employeeId), activeIccMemberCount()]);
  const named = person => (person && person.id !== req.user.employeeId ? { name: person.name } : null);
  res.json({
    canHandle: req.helpdesk.canHandle,
    isIccMember: req.helpdesk.isIccMember,
    canManageIcc: req.user.role === 'super_admin',
    iccConfigured: iccMembers > 0,
    recipients: { ceo: named(ceo), teamHead: named(teamHead) }
  });
});

app.get('/api/tickets', async (req, res) => {
  const visible = ['t.employee_id = $1', 't.recipient_id = $1'];
  if (req.helpdesk.canHandle) visible.push("(t.recipient_type = 'HR' AND t.is_confidential IS NOT TRUE)");
  if (req.helpdesk.isIccMember) visible.push('t.is_confidential = TRUE');
  const result = await pool.query(`${TICKET_SELECT} WHERE ${visible.join(' OR ')} ORDER BY last_activity DESC`, [req.user.employeeId]);
  res.json(result.rows);
});

app.post('/api/tickets', async (req, res) => {
  const { category, recipient, subject, description, respondent_name, incident_date, incident_place, witnesses } = req.body;
  const isPosh = category === POSH_CATEGORY;
  if (!isPosh && !REQUEST_TYPES.includes(category)) throw invalid('Choose a problem, suggestion or new idea.');
  if (!req.user.employeeId) throw invalid('Your account is not linked to an employee record.');

  let ticketSubject = 'POSH complaint';
  let posh = { respondent: null, date: null, place: null, witnesses: null };
  let target = { type: 'ICC', id: null, name: ICC_NAME };
  if (isPosh) {
    if (await activeIccMemberCount() === 0) throw invalid('The Internal Complaints Committee has not been set up yet.', 409);
    parseDate(incident_date);
    if (incident_date > businessDate()) throw invalid('The incident date cannot be in the future.');
    posh = {
      respondent: ticketText(respondent_name, 'The name of the person complained about', 200),
      date: incident_date,
      place: ticketText(incident_place, 'Place', 200, false),
      witnesses: ticketText(witnesses, 'Witnesses', 2000, false)
    };
    req.auditConfidential = true;
  } else {
    ticketSubject = ticketText(subject, 'Subject', 200);
    if (!REQUEST_RECIPIENTS.includes(recipient)) throw invalid('Choose who this is for.');
    if (recipient === 'HR') {
      target = { type: 'HR', id: null, name: 'HR Team' };
    } else {
      const person = recipient === 'CEO' ? await findCeo() : await findTeamHead(req.user.employeeId);
      if (!person) throw invalid(recipient === 'CEO' ? 'No CEO account has been set up yet.' : 'No team head is set for you yet. Please ask HR to assign one.', 409);
      if (person.id === req.user.employeeId) throw invalid('You cannot send this to yourself.');
      target = { type: recipient, id: person.id, name: person.name };
    }
  }

  const statement = ticketText(description, isPosh ? 'Statement' : 'Message', 10000);
  const sequence = await pool.query("SELECT nextval('support_ticket_number_seq') AS value");
  const ticketNumber = `TKT-${businessDate().slice(0, 4)}-${String(sequence.rows[0].value).padStart(3, '0')}`;

  const inserted = await pool.query(`
    INSERT INTO support_tickets
    (ticket_number, employee_id, employee_name, category, subject, description, is_confidential, status, priority, assigned_to,
     respondent_name, incident_date, incident_place, witnesses, recipient_type, recipient_id, recipient_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING id
  `, [
    ticketNumber, req.user.employeeId, req.user.name, category, ticketSubject, statement, isPosh,
    isPosh ? 'Received' : 'Open', isPosh ? 'High' : 'Medium', target.name,
    posh.respondent, posh.date, posh.place, posh.witnesses, target.type, target.id, target.name
  ]);
  res.status(201).json(await ticketById(inserted.rows[0].id));
});

app.patch('/api/tickets/:id', async (req, res) => {
  const current = (await pool.query('SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
  if (!current) throw invalid('Conversation not found.', 404);
  const isPosh = current.is_confidential === true;
  if (isPosh) req.auditConfidential = true;

  const status = req.body.status ?? current.status;
  if (!(isPosh ? POSH_STATUSES : CONVERSATION_STATUSES).includes(status)) throw invalid('Select a valid status.');
  const notes = req.body.resolution_notes === undefined ? current.resolution_notes : ticketText(req.body.resolution_notes, 'Notes', 10000, false);
  const finished = status === (isPosh ? 'Closed' : 'Resolved');
  if (isPosh && finished && !notes) throw invalid('Add notes describing the outcome before closing this case.');
  if (!isPosh && req.body.priority !== undefined && !TICKET_PRIORITIES.includes(req.body.priority)) throw invalid('Select a valid priority.');
  const priority = isPosh ? current.priority : (req.body.priority ?? current.priority);

  await pool.query(`
    UPDATE support_tickets
    SET status = $1, resolution_notes = $2, priority = $3,
        resolved_at = CASE WHEN $4::boolean THEN COALESCE(resolved_at, NOW()) ELSE NULL END
    WHERE id = $5
  `, [status, notes, priority, finished, req.params.id]);
  res.json(await ticketById(req.params.id));
});

app.get('/api/tickets/:id/messages', async (req, res) => {
  const result = await pool.query('SELECT id, author_id, author_name, body, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id ASC', [req.params.id]);
  res.json(result.rows);
});

app.post('/api/tickets/:id/messages', async (req, res) => {
  const current = (await pool.query('SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
  if (!current) throw invalid('Conversation not found.', 404);
  if (current.is_confidential === true) req.auditConfidential = true;
  const body = ticketText(req.body.body, 'Message', 5000);

  const message = await pool.query(
    'INSERT INTO ticket_messages (ticket_id, author_id, author_name, body) VALUES ($1, $2, $3, $4) RETURNING id, author_id, author_name, body, created_at',
    [current.id, req.user.employeeId, req.user.name, body]
  );
  // A first reply picks the conversation up; any reply to a resolved one reopens it.
  const repliedByOther = req.user.employeeId !== current.employee_id;
  if (current.is_confidential !== true && (current.status === 'Resolved' || (current.status === 'Open' && repliedByOther))) {
    await pool.query("UPDATE support_tickets SET status = 'In Progress', resolved_at = NULL WHERE id = $1", [current.id]);
  }
  res.status(201).json({ message: message.rows[0], ticket: await ticketById(current.id) });
});

// ICC membership is managed by a super admin only and is not reachable through role or permission editing.
app.get('/api/tickets/icc-members', async (req, res) => {
  const result = await pool.query(`
    SELECT employee_id, name, department, role_title, is_icc_member
    FROM user_accounts
    WHERE status = 'Active' AND employee_id IS NOT NULL
    ORDER BY name ASC
  `);
  res.json(result.rows);
});

app.put('/api/tickets/icc-members/:employeeId', async (req, res) => {
  if (typeof req.body.member !== 'boolean') throw invalid('Membership must be true or false.');
  const result = await pool.query(
    'UPDATE user_accounts SET is_icc_member = $1, updated_at = NOW() WHERE employee_id = $2 RETURNING employee_id, name, department, role_title, is_icc_member',
    [req.body.member, req.params.employeeId]
  );
  if (!result.rowCount) throw invalid('Account not found.', 404);
  await pool.query(
    `INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, 'ICC_MEMBERSHIP_UPDATED', $2)`,
    [req.user.name, `${req.body.member ? 'Added' : 'Removed'} ${result.rows[0].name} (${result.rows[0].employee_id}) ${req.body.member ? 'to' : 'from'} the Internal Complaints Committee`]
  );
  res.json(result.rows[0]);
});

// ==========================================
// 23.5 PERSON-SPECIFIC PERMISSIONS APIS
// ==========================================

// Get all user accounts with their person-specific permission overrides and effective candidate capabilities
app.get('/api/users/permissions', async (req, res) => {
  try {
    const [accounts, specificPerms, atsRolePerms] = await Promise.all([
      pool.query(`
        SELECT employee_id, email, name, role, ats_role, department, role_title, avatar, is_head_hr, recruiter_id, status 
        FROM user_accounts 
        ORDER BY employee_id
      `),
      pool.query('SELECT employee_id, permission_key, allowed FROM user_specific_permissions'),
      pool.query('SELECT role_id, module, action, allowed FROM ats_role_permissions')
    ]);

    const permMapByEmp = {};
    const overrideRowsByEmp = new Map();
    for (const sp of specificPerms.rows) {
      if (!permMapByEmp[sp.employee_id]) permMapByEmp[sp.employee_id] = {};
      permMapByEmp[sp.employee_id][sp.permission_key] = Boolean(sp.allowed);
      const list = overrideRowsByEmp.get(sp.employee_id) || [];
      list.push({ permission_key: sp.permission_key, allowed: Boolean(sp.allowed) });
      overrideRowsByEmp.set(sp.employee_id, list);
    }

    const atsRoleRowsByRole = new Map();
    for (const rp of atsRolePerms.rows) {
      const list = atsRoleRowsByRole.get(rp.role_id) || [];
      list.push(rp);
      atsRoleRowsByRole.set(rp.role_id, list);
    }

    const enriched = accounts.rows.map(acc => {
      const atsRole = resolveAtsRole(acc);
      return {
        ...acc,
        specificOverrides: permMapByEmp[acc.employee_id] || {},
        effectivePermissions: buildEffectivePermissions(
          acc,
          atsRoleRowsByRole.get(atsRole) || [],
          overrideRowsByEmp.get(acc.employee_id) || []
        )
      };
    });

    res.json(enriched);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Update person-specific permissions for an individual user
app.put('/api/users/:employeeId/permissions', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { permissions: newPerms } = req.body;

    if (!newPerms || typeof newPerms !== 'object' || Array.isArray(newPerms)) {
      return res.status(400).json({ error: 'Invalid permissions payload' });
    }

    const allowedKeys = new Set([
      ...ATS_ACTIONS,
      ...SYSTEM_MODULES.flatMap(m => m.actions.map(a => `${m.id}:${a.id}`))
    ]);
    const permEntries = Object.entries(newPerms);
    for (const [key, val] of permEntries) {
      if (!allowedKeys.has(key)) {
        return res.status(400).json({ error: `Unknown permission key: ${key}` });
      }
      if (typeof val !== 'boolean') {
        return res.status(400).json({ error: `Permission value for ${key} must be boolean.` });
      }
    }

    const userCheck = await pool.query('SELECT * FROM user_accounts WHERE employee_id = $1', [employeeId]);
    if (userCheck.rowCount === 0) {
      return res.status(404).json({ error: 'User account not found' });
    }

    for (const [key, val] of permEntries) {
      await pool.query(`
        INSERT INTO user_specific_permissions (employee_id, permission_key, allowed, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (employee_id, permission_key) DO UPDATE SET
          allowed = EXCLUDED.allowed,
          updated_at = NOW()
      `, [employeeId, key, val]);
    }

    const updatedEffective = await getUserEffectivePermissions(userCheck.rows[0]);

    await pool.query(
      `INSERT INTO audit_logs (actor_name, action, details)
       VALUES ($1, 'PERMISSIONS_UPDATED', $2)`,
      [req.user?.name || 'Super Admin', `Updated person-specific permissions for ${userCheck.rows[0].name} (${employeeId})`]
    );

    res.json({ success: true, effectivePermissions: updatedEffective });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Current user profile + effective candidate capabilities endpoint
app.get('/api/auth/me/candidate-capabilities', async (req, res) => {
  try {
    const effective = await getUserEffectivePermissions(req.user);
    res.json({
      employeeId: req.user.employeeId,
      role: req.user.role,
      atsRole: req.user.atsRole,
      capabilities: effective
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ==========================================
// 24. ROLES & PERMISSIONS MATRIX ENDPOINTS
// ==========================================

const SYSTEM_MODULES = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: '📊',
    actions: [
      { id: 'view', label: 'View Overview Dashboard' },
      { id: 'view_analytics', label: 'View Workforce Analytics' }
    ]
  },
  {
    id: 'profile',
    label: 'My Profile & Self-Service',
    icon: '🪪',
    actions: [
      { id: 'view', label: 'View My Profile Page' },
      { id: 'edit', label: 'Edit Personal, Banking & KYC Details' }
    ]
  },
  {
    id: 'employees',
    label: 'Employees & Trainers',
    icon: '👥',
    actions: [
      { id: 'view', label: 'View Employees Directory & Trainer Schedule' },
      { id: 'add', label: 'Add Employees' },
      { id: 'edit', label: 'Edit Employees & Trainer Schedules/Pay' },
      { id: 'delete', label: 'Move Employees to Trash / Deactivate' },
      { id: 'view_sensitive', label: 'Export Employee Directory' }
    ]
  },
  {
    id: 'departments',
    label: 'Company Departments',
    icon: '🏢',
    actions: [
      { id: 'view', label: 'View Company Departments Page' },
      { id: 'manage', label: 'Create, Rename & Delete Departments' }
    ]
  },
  {
    id: 'attendance',
    label: 'Attendance & Timesheets',
    icon: '▦',
    actions: [
      { id: 'view', label: 'View Attendance Records & Export CSV' },
      { id: 'regularize', label: 'Regularize Timesheets & Records' }
    ]
  },
  {
    id: 'leaves',
    label: 'Leave Management',
    icon: '◷',
    actions: [
      { id: 'view', label: 'View Leaves & Balances' },
      { id: 'apply', label: 'Apply Leave Requests' },
      { id: 'approve_reject', label: 'Approve or Reject Leaves' }
    ]
  },
  {
    id: 'onboarding',
    label: 'Onboarding & KYC',
    icon: '✓',
    actions: [
      { id: 'view', label: 'View Onboarding Submissions' },
      { id: 'upload_docs', label: 'Upload KYC Documents' },
      { id: 'verify_kyc', label: 'Verify, Approve or Reject KYC Documents' }
    ]
  },
  {
    id: 'ats',
    label: 'Recruitment ATS Suite',
    icon: '🎯',
    actions: [
      { id: 'view', label: 'Access Recruitment ATS Suite (fine-grained rights in ATS Roles)' }
    ]
  },
  {
    id: 'exits',
    label: 'Exit Management',
    icon: '📤',
    actions: [
      { id: 'view', label: 'View Resignations & Exits' },
      { id: 'submit_resignation', label: 'Submit Resignation' },
      { id: 'clearance_settlement', label: 'Process Clearance & Settlement' }
    ]
  },
  {
    id: 'training',
    label: 'Training Modules & SOPs',
    icon: '▤',
    actions: [
      { id: 'view', label: 'View Training Modules & Take Assessments' },
      { id: 'edit', label: 'Create, Edit & Assign Training Modules' }
    ]
  },
  {
    id: 'notices',
    label: 'Notice Board & Culture',
    icon: '📢',
    actions: [
      { id: 'view', label: 'View Announcements' },
      { id: 'post_notice', label: 'Post Announcements' },
      { id: 'send_kudos', label: 'Send Employee Kudos' }
    ]
  },
  {
    id: 'helpdesk',
    label: 'Helpdesk & Support',
    icon: '🛡️',
    actions: [
      { id: 'view', label: 'View Tickets' },
      { id: 'submit_ticket', label: 'Submit Support Ticket' },
      { id: 'resolve_ticket', label: 'Resolve & Close HR Tickets' }
    ]
  },
  {
    id: 'audit',
    label: 'Compliance & Audit',
    icon: '⚖️',
    actions: [
      { id: 'view', label: 'View Audit Logs' }
    ]
  },
  {
    id: 'permissions',
    label: 'Roles, Resources & Trash',
    icon: '🔐',
    actions: [
      { id: 'view', label: 'View Roles & Permissions and Resource Management' },
      { id: 'create_role', label: 'Create New Roles' },
      { id: 'edit_permissions', label: 'Edit Permissions Matrix & Rename Roles' },
      { id: 'delete_role', label: 'Delete Non-Core Roles' },
      { id: 'manage_resources', label: 'Manage Resource Users, Revoke Access & Move to Trash' },
      { id: 'view_trash', label: 'View Trash & Deactivated Profiles Page' },
      { id: 'restore_trash', label: 'Activate & Restore Trashed Profiles with Dept & Role' }
    ]
  }
];

// Get modules definition
app.get('/api/permissions/modules', (req, res) => {
  res.json(SYSTEM_MODULES);
});

const SYSTEM_ROLE_DISPLAY = {
  super_admin: { name: 'Super Admin', description: 'Full access to all system features, settings, and security controls' },
  admin: { name: 'Administrator', description: 'Full access to workspace operations, staff records, and settings' },
  hr: { name: 'HR Admin', description: 'Manage employees, onboarding KYC, attendance, leaves, and exits' },
  head: { name: 'Department Head', description: 'Lead department staff, review attendance, and approve team leaves' },
  manager: { name: 'Department Manager', description: 'Manage reporting team members, approve leaves, and regularize punches' },
  hr_assistant: { name: 'HR Assistant', description: 'Screen candidates, schedule interviews, and manage hiring queues' },
  recruiter: { name: 'Talent Recruiter', description: 'Manage job requisitions, candidate pipeline, interviews, and offers' },
  interviewer: { name: 'Panel Interviewer', description: 'Review assigned candidate interviews and submit evaluation scorecards' },
  trainers: { name: 'Trainer', description: 'Manage training sessions, trainer schedules, and learning operations' },
  employee: { name: 'Staff Employee', description: 'Self-service portal: personal records, attendance, leaves, and helpdesk' },
};

const ROLE_ORDER = ['super_admin', 'admin', 'hr', 'head', 'manager', 'recruiter', 'hr_assistant', 'interviewer', 'trainers', 'employee'];

// Get all roles with member count
app.get('/api/roles', async (req, res) => {
  try {
    const rolesRes = await pool.query(`
      SELECT r.*, 
        COALESCE(e.user_count, 0)::int as user_count
      FROM roles r
      LEFT JOIN (
        SELECT access_role, COUNT(*)::int as user_count
        FROM employees
        WHERE COALESCE(status, 'Active') NOT IN ('Inactive', 'Exited', 'Terminated')
        GROUP BY access_role
      ) e ON e.access_role = r.id
      ORDER BY r.is_system DESC, r.created_at ASC
    `);
    const formatted = rolesRes.rows
      .map(r => {
        const meta = SYSTEM_ROLE_DISPLAY[r.id];
        if (!meta) return { ...r, user_count: Number(r.user_count) || 0 };
        const hasPlaceholderName = !r.name || r.name === r.id;
        const hasPlaceholderDesc = !r.description || r.description === 'System role';
        return {
          ...r,
          name: hasPlaceholderName ? meta.name : r.name,
          description: hasPlaceholderDesc ? meta.description : r.description,
          user_count: Number(r.user_count) || 0,
        };
      })
      .sort((a, b) => {
        const idxA = ROLE_ORDER.indexOf(a.id);
        const idxB = ROLE_ORDER.indexOf(b.id);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
    res.json(formatted);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Get permissions for a specific role
app.get('/api/roles/:id/permissions', async (req, res) => {
  try {
    const { id } = req.params;
    const roleRes = await pool.query('SELECT * FROM roles WHERE id = $1', [id]);
    if (roleRes.rowCount === 0) return res.status(404).json({ error: 'Role not found' });

    const permsRes = await pool.query(
      'SELECT module, action, allowed FROM role_permissions WHERE role_id = $1',
      [id]
    );

    // Build hierarchical map: { [module]: { [action]: boolean } } seeded across all active modules
    const permMap = {};
    SYSTEM_MODULES.forEach(m => {
      permMap[m.id] = {};
      m.actions.forEach(act => {
        permMap[m.id][act.id] = id === 'super_admin';
      });
    });
    permsRes.rows.forEach(p => {
      if (!permMap[p.module]) permMap[p.module] = {};
      permMap[p.module][p.action] = id === 'super_admin' || Boolean(p.allowed);
    });

    res.json({
      role: roleRes.rows[0],
      permissions: permMap
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Update permissions for a role
app.put('/api/roles/:id/permissions', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { permissions, editorName } = req.body;

    const roleRes = await client.query('SELECT * FROM roles WHERE id = $1', [id]);
    if (roleRes.rowCount === 0) {
      client.release();
      return res.status(404).json({ error: 'Role not found' });
    }
    if (id === 'super_admin') {
      client.release();
      return res.status(400).json({ error: 'Super Admin always retains full unrestricted system access.' });
    }

    const validActions = new Map(SYSTEM_MODULES.map(m => [m.id, new Set(m.actions.map(a => a.id))]));
    await client.query('BEGIN');

    // Upsert valid module permissions
    for (const [moduleName, actionsObj] of Object.entries(permissions || {})) {
      const allowedSet = validActions.get(moduleName);
      if (!allowedSet) continue;
      for (const [actionName, allowedVal] of Object.entries(actionsObj || {})) {
        if (!allowedSet.has(actionName)) continue;
        await client.query(`
          INSERT INTO role_permissions (role_id, module, action, allowed)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (role_id, module, action)
          DO UPDATE SET allowed = $4
        `, [id, moduleName, actionName, Boolean(allowedVal)]);
      }
    }

    await client.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || editorName || 'Super Admin', 'UPDATE_ROLE_PERMISSIONS', `Updated permissions matrix for role: ${roleRes.rows[0].name} (${id})`]
    );

    await client.query('COMMIT');

    res.json({ success: true, message: `Permissions for ${roleRes.rows[0].name} saved successfully!` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Create a new custom role
app.post('/api/roles', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, cloneFromRoleId, creatorName } = req.body;
    if (!name || !name.trim()) {
      client.release();
      return res.status(400).json({ error: 'Role name is required' });
    }

    const roleId = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Math.floor(100 + Math.random() * 900);

    await client.query('BEGIN');

    await client.query(
      'INSERT INTO roles (id, name, description, is_system) VALUES ($1, $2, $3, false)',
      [roleId, name.trim(), description || 'Custom configured access role']
    );

    // Also sync to company_masters
    await client.query(
      `INSERT INTO company_masters (type, code, name, description)
       VALUES ('role', $1, $2, $3)
       ON CONFLICT (type, name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description`,
      [roleId, name.trim(), description || 'Custom configured access role']
    ).catch(() => {});

    // If cloning from an existing role, copy permissions
    if (cloneFromRoleId) {
      await client.query(`
        INSERT INTO role_permissions (role_id, module, action, allowed)
        SELECT $1, module, action, allowed
        FROM role_permissions
        WHERE role_id = $2
        ON CONFLICT (role_id, module, action) DO NOTHING
      `, [roleId, cloneFromRoleId]);
    } else {
      // Default basic employee permissions
      for (const m of SYSTEM_MODULES) {
        for (const act of m.actions) {
          const isBasic =
            (m.id === 'profile' && ['view', 'edit'].includes(act.id)) ||
            (['view', 'apply', 'upload_docs', 'submit_resignation', 'submit_ticket', 'send_kudos'].includes(act.id) &&
            !['audit', 'permissions', 'departments'].includes(m.id));
          await client.query(
            'INSERT INTO role_permissions (role_id, module, action, allowed) VALUES ($1, $2, $3, $4)',
            [roleId, m.id, act.id, isBasic]
          );
        }
      }
    }

    await client.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || creatorName || 'Super Admin', 'CREATE_ROLE', `Created new custom role: ${name.trim()} (ID: ${roleId})`]
    );

    await client.query('COMMIT');

    const newRole = await pool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
    res.status(201).json(newRole.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Rename / update role title & subtitle (description)
app.put('/api/roles/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const rawDesc = typeof req.body?.description === 'string' ? req.body.description.trim() : '';

    if (!rawName) {
      client.release();
      return res.status(400).json({ error: 'Role title is required' });
    }
    if (rawName.length > 80) {
      client.release();
      return res.status(400).json({ error: 'Role title must be 80 characters or fewer' });
    }
    if (rawDesc.length > 240) {
      client.release();
      return res.status(400).json({ error: 'Role subtitle must be 240 characters or fewer' });
    }

    const existing = await client.query('SELECT * FROM roles WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      client.release();
      return res.status(404).json({ error: 'Role not found' });
    }

    const duplicate = await client.query(
      'SELECT id FROM roles WHERE LOWER(TRIM(name)) = LOWER($1) AND id <> $2 LIMIT 1',
      [rawName, id]
    );
    if (duplicate.rowCount > 0) {
      client.release();
      return res.status(409).json({ error: `Another role already uses the title "${rawName}".` });
    }

    const nextDesc = rawDesc || existing.rows[0].description || 'Custom configured access role';
    await client.query('BEGIN');

    const updatedRes = await client.query(
      'UPDATE roles SET name = $1, description = $2 WHERE id = $3 RETURNING *',
      [rawName, nextDesc, id]
    );

    await client.query(
      'UPDATE user_accounts SET role_title = $1, updated_at = NOW() WHERE role = $2',
      [rawName, id]
    );

    await client.query(
      `UPDATE company_masters SET name = $1, description = $2 WHERE type = 'role' AND code = $3`,
      [rawName, nextDesc, id]
    ).catch(() => {});

    await client.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || req.body?.editorName || 'Super Admin', 'RENAME_ROLE', `Updated role "${existing.rows[0].name}" (${id}) title/subtitle to "${rawName}"`]
    );

    await client.query('COMMIT');

    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS user_count FROM employees WHERE access_role = $1 AND COALESCE(status, 'Active') NOT IN ('Inactive', 'Exited', 'Terminated')",
      [id]
    );
    res.json({
      ...updatedRes.rows[0],
      user_count: Number(countRes.rows[0]?.user_count) || 0
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete a role (all roles except core protected fallbacks: super_admin & employee)
app.delete('/api/roles/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const roleRes = await client.query('SELECT * FROM roles WHERE id = $1', [id]);
    if (roleRes.rowCount === 0) {
      client.release();
      return res.status(404).json({ error: 'Role not found' });
    }

    const CORE_PROTECTED_ROLES = ['super_admin', 'employee'];
    if (CORE_PROTECTED_ROLES.includes(id)) {
      client.release();
      return res.status(400).json({ error: 'Super Admin and Staff Employee are core system roles and cannot be deleted.' });
    }
    if (req.user?.role === id) {
      client.release();
      return res.status(400).json({ error: 'You cannot delete the role currently assigned to your own account.' });
    }

    const roleName = roleRes.rows[0].name || id;
    await client.query('BEGIN');

    // Safely reassign any remaining employee or account references to the core 'employee' role
    await client.query("UPDATE employees SET access_role = 'employee' WHERE access_role = $1", [id]);
    await client.query(
      "UPDATE user_accounts SET role = 'employee', role_title = 'Employee', session_version = session_version + 1, updated_at = NOW() WHERE role = $1",
      [id]
    );
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
    await client.query(
      "DELETE FROM company_masters WHERE type = 'role' AND (code = $1 OR LOWER(name) = LOWER($2))",
      [id, roleName]
    ).catch(() => {});
    await client.query('DELETE FROM roles WHERE id = $1', [id]);

    await client.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || 'Super Admin', 'DELETE_ROLE', `Deleted role: ${roleName} (${id})`]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `Role ${roleName} deleted.` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 25. RESOURCE MANAGEMENT & PLATFORM USERS
// ==========================================

app.get('/api/resources', async (req, res) => {
  try {
    const { search = '', status = 'All', role = 'All', ats_only = 'false' } = req.query;

    // Fetch unified users with both EMS role and Recruitment ATS membership/workload
    const query = `
      SELECT 
        e.*,
        r.name AS system_role_name,
        COALESCE(NULLIF(btrim(rt.ats_role), ''), NULLIF(btrim(u.ats_role), '')) AS ats_role,
        ar.name AS ats_role_name,
        COALESCE(rt.id, u.recruiter_id) AS recruiter_id,
        CASE
          WHEN COALESCE(NULLIF(btrim(rt.ats_role), ''), NULLIF(btrim(u.ats_role), '')) IS NOT NULL
          THEN COALESCE(rt.has_ats_access, TRUE)
          ELSE FALSE
        END AS has_ats_access,
        rt.sourcing_tag,
        COALESCE(rt.max_candidate_capacity, 20) AS max_candidate_capacity,
        rt.specialization,
        COALESCE(cand.active_candidates, 0)::int AS active_candidates
      FROM employees e
      LEFT JOIN roles r ON r.id = e.access_role
      LEFT JOIN LATERAL (
        SELECT employee_id, recruiter_id, ats_role
        FROM user_accounts
        WHERE employee_id = e.id
        ORDER BY id ASC LIMIT 1
      ) u ON TRUE
      LEFT JOIN recruitment_team rt ON rt.id = COALESCE(u.recruiter_id, e.id)
      LEFT JOIN ats_roles ar ON ar.id = COALESCE(NULLIF(btrim(rt.ats_role), ''), NULLIF(btrim(u.ats_role), ''))
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS active_candidates
        FROM applicants a
        WHERE a.assigned_recruiter_id = COALESCE(rt.id, u.recruiter_id, e.id)
          AND a.stage <> 'Rejected'
          AND a.promoted_employee_id IS NULL
      ) cand ON TRUE
      ORDER BY 
        CASE 
          WHEN e.access_role = 'super_admin' THEN 1
          WHEN e.access_role = 'admin' THEN 2
          WHEN e.access_role = 'hr' THEN 3
          WHEN e.access_role = 'manager' THEN 4
          ELSE 5
        END,
        e.id ASC
    `;
    const result = await pool.query(query);
    const allUsers = result.rows;

    const activeDirectoryUsers = allUsers.filter(u => u.status !== 'Inactive');
    const trashedUsers = allUsers.filter(u => u.status === 'Inactive');

    // Calculate live summary breakdown dynamically from active non-trashed roles
    const totalUsers = activeDirectoryUsers.length;
    const activeUsers = activeDirectoryUsers.length;
    const inactiveUsers = trashedUsers.length;
    const atsUsersCount = activeDirectoryUsers.filter(u => Boolean(u.ats_role) && u.has_ats_access !== false).length;

    const countsByRole = new Map();
    for (const u of activeDirectoryUsers) {
      const key = u.access_role || 'employee';
      const entry = countsByRole.get(key) || { id: key, name: u.system_role_name || key, count: 0 };
      entry.count += 1;
      countsByRole.set(key, entry);
    }
    const roleBreakdown = Array.from(countsByRole.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    // Inactive / deleted profiles are managed in Trash unless explicitly queried with status=Inactive
    let filtered = status === 'Inactive' ? trashedUsers : activeDirectoryUsers;

    if (ats_only === 'true') {
      filtered = filtered.filter(u => Boolean(u.ats_role));
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(u => 
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.phone && u.phone.toLowerCase().includes(q)) ||
        (u.department && u.department.toLowerCase().includes(q)) ||
        (u.sourcing_tag && u.sourcing_tag.toLowerCase().includes(q)) ||
        (u.ats_role_name && u.ats_role_name.toLowerCase().includes(q))
      );
    }

    if (role && role !== 'All') {
      filtered = filtered.filter(u => u.access_role === role || u.system_role_name === role);
    }

    res.json({
      totalUsers,
      activeUsers,
      inactiveUsers,
      atsUsersCount,
      roleBreakdown,
      resources: filtered
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/resources', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      access_role,
      department,
      manager_id,
      manager,
      ats_role,
      has_ats_access = true,
      sourcing_tag,
      max_candidate_capacity,
      specialization,
      has_dashboard_access = true,
      user_type = 'Staff',
      editorName
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('A valid email is required for a resource account.');

    const finalDepartment = typeof department === 'string' ? department.trim() : '';
    if (!finalDepartment) return res.status(400).json({ error: 'Department is required' });

    const finalAccessRole = typeof access_role === 'string' ? access_role.trim() : '';
    if (!finalAccessRole) return res.status(400).json({ error: 'System Access Role is required' });

    const finalAtsRole = typeof ats_role === 'string' && ats_role.trim() ? ats_role.trim() : null;
    if (finalAtsRole) {
      const validAtsRole = await pool.query('SELECT id FROM ats_roles WHERE id = $1 LIMIT 1', [finalAtsRole]);
      if (!validAtsRole.rowCount) return res.status(400).json({ error: 'Select a valid ATS Role.' });
      if (['ceo', 'exec_sponsor'].includes(finalAtsRole) && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Only Super Admin can assign CEO recruitment access.' });
      }
    }

    const cleanEmail = email.trim().toLowerCase();
    const existingEmail = await pool.query(
      'SELECT employee_id, name FROM user_accounts WHERE LOWER(email) = $1 LIMIT 1',
      [cleanEmail]
    );
    if (existingEmail.rowCount > 0) {
      return res.status(400).json({
        error: `Email "${email.trim()}" is already registered to ${existingEmail.rows[0].name} (${existingEmail.rows[0].employee_id}).`
      });
    }

    let finalManagerId = typeof manager_id === 'string' && manager_id.trim() ? manager_id.trim() : null;
    let finalManagerName = typeof manager === 'string' && manager.trim() ? manager.trim() : null;
    if (finalManagerId) {
      const mgrRes = await pool.query('SELECT id, name FROM employees WHERE id = $1 LIMIT 1', [finalManagerId]);
      if (!mgrRes.rowCount) return res.status(400).json({ error: 'Selected Reporting Manager was not found.' });
      finalManagerName = mgrRes.rows[0].name;
    } else if (finalManagerName) {
      const mgrRes = await pool.query('SELECT id, name FROM employees WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1', [finalManagerName]);
      if (mgrRes.rowCount) {
        finalManagerId = mgrRes.rows[0].id;
        finalManagerName = mgrRes.rows[0].name;
      }
    }

    const hasStaff = (await pool.query('SELECT 1 FROM employees LIMIT 1')).rowCount > 0;
    if (hasStaff && !finalManagerId) {
      return res.status(400).json({ error: 'Reporting Manager is required' });
    }

    const roleMeta = await pool.query('SELECT name FROM roles WHERE id = $1 LIMIT 1', [finalAccessRole]);
    const finalRoleTitle = roleMeta.rowCount ? roleMeta.rows[0].name : finalAccessRole;

    // Allocate monotonically even after deletion and under concurrent requests.
    await pool.query("SELECT pg_advisory_xact_lock(hashtext('employee-id-allocation'))");
    const countRes = await pool.query("SELECT COALESCE(MAX(substring(id from 5)::bigint),0) AS max_id FROM employees WHERE id ~ '^FEM-[0-9]+$'");
    const nextNum = Number(countRes.rows[0].max_id) + 1;
    const newId = `FEM-${String(nextNum).padStart(3, '0')}`;
    const initials = name.trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase() || 'ST';

    const insertRes = await pool.query(`
      INSERT INTO employees (id, name, email, phone, access_role, has_dashboard_access, user_type, status, department, role, designation, manager_id, manager)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Active', $8, $9, $10, $11, $12)
      RETURNING *
    `, [newId, name.trim(), cleanEmail, phone || '', finalAccessRole, Boolean(has_dashboard_access), user_type, finalDepartment, finalRoleTitle, finalRoleTitle, finalManagerId, finalManagerName]);

    await pool.query(`INSERT INTO user_accounts(employee_id,recruiter_id,email,pin,name,role,ats_role,department,role_title,avatar,is_head_hr)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId, finalAtsRole ? newId : null, cleanEmail, await hashPin(crypto.randomBytes(32).toString('hex')), name.trim(), finalAccessRole, finalAtsRole, finalDepartment, finalRoleTitle, initials, finalAtsRole === 'rec_lead']);

    if (finalAtsRole) {
      const cleanTag = (typeof sourcing_tag === 'string' && sourcing_tag.trim()) ||
        `${name.trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'REC'}-TAG`;
      const cap = Math.max(1, parseInt(max_candidate_capacity, 10) || 20);
      await pool.query(`
        INSERT INTO recruitment_team (
          id, name, role_title, department, reports_to, reports_to_id, is_head, email, phone,
          avatar_initials, specialization, active_vacancies, has_ats_access, ats_role,
          sourcing_tag, max_candidate_capacity, status, employee_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, $15, 'Active', $1)
        ON CONFLICT (id) DO UPDATE SET
          ats_role = EXCLUDED.ats_role,
          has_ats_access = EXCLUDED.has_ats_access,
          is_head = EXCLUDED.is_head,
          department = EXCLUDED.department,
          status = 'Active'
      `, [
        newId, name.trim(), finalRoleTitle, finalDepartment, finalManagerName || '', finalManagerId,
        finalAtsRole === 'rec_lead', cleanEmail, phone || '', initials,
        (typeof specialization === 'string' && specialization.trim()) || finalDepartment,
        Boolean(has_ats_access), finalAtsRole, cleanTag, cap
      ]);
    }

    await pool.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || editorName || 'Administrator', 'CREATE_RESOURCE', `Added new platform resource: ${name.trim()} (${newId}) in ${finalDepartment} with role ${finalAccessRole}${finalAtsRole ? ` & ATS role ${finalAtsRole}` : ''}`]
    );

    res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put('/api/resources/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      phone,
      access_role,
      department,
      manager_id,
      manager,
      ats_role,
      has_ats_access,
      sourcing_tag,
      max_candidate_capacity,
      specialization,
      has_dashboard_access,
      user_type,
      editorName
    } = req.body;

    const checkRes = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Resource not found' });
    const current = checkRes.rows[0];
    if (current.access_role === 'super_admin' && has_dashboard_access === false) {
      return res.status(400).json({ error: 'Cannot revoke dashboard access for Super Admin accounts' });
    }

    const hasMgrField = Object.prototype.hasOwnProperty.call(req.body, 'manager_id') || Object.prototype.hasOwnProperty.call(req.body, 'manager');
    let nextManagerId = current.manager_id;
    let nextManagerName = current.manager;
    if (hasMgrField) {
      const rawMgrId = typeof manager_id === 'string' ? manager_id.trim() : '';
      const rawMgrName = typeof manager === 'string' ? manager.trim() : '';
      if (!rawMgrId && !rawMgrName) {
        nextManagerId = null;
        nextManagerName = null;
      } else if (rawMgrId) {
        if (rawMgrId === id) return res.status(400).json({ error: 'Employee cannot report to themselves.' });
        const mgrRes = await pool.query('SELECT id, name FROM employees WHERE id = $1 LIMIT 1', [rawMgrId]);
        if (!mgrRes.rowCount) return res.status(400).json({ error: 'Selected Reporting Manager was not found.' });
        nextManagerId = mgrRes.rows[0].id;
        nextManagerName = mgrRes.rows[0].name;
      } else {
        const mgrRes = await pool.query('SELECT id, name FROM employees WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1', [rawMgrName]);
        nextManagerId = mgrRes.rowCount ? mgrRes.rows[0].id : null;
        nextManagerName = mgrRes.rowCount ? mgrRes.rows[0].name : rawMgrName;
      }
    }

    const nextEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
    if (nextEmail) {
      const dupEmail = await pool.query(
        'SELECT employee_id, name FROM user_accounts WHERE LOWER(email) = $1 AND employee_id <> $2 LIMIT 1',
        [nextEmail, id]
      );
      if (dupEmail.rowCount > 0) {
        return res.status(400).json({
          error: `Email "${email.trim()}" is already registered to ${dupEmail.rows[0].name} (${dupEmail.rows[0].employee_id}).`
        });
      }
    }

    const nextDepartment = typeof department === 'string' && department.trim() ? department.trim() : current.department;
    const nextAccessRole = typeof access_role === 'string' && access_role.trim() ? access_role.trim() : current.access_role;
    let nextRoleTitle = current.role;
    if (nextAccessRole !== current.access_role) {
      const roleMeta = await pool.query('SELECT name FROM roles WHERE id = $1 LIMIT 1', [nextAccessRole]);
      nextRoleTitle = roleMeta.rowCount ? roleMeta.rows[0].name : nextAccessRole;
    }
    const nextDesignation = (typeof nextRoleTitle === 'string' && nextRoleTitle.trim()) ? nextRoleTitle.trim() : current.designation;

    const hasAtsRoleField = Object.prototype.hasOwnProperty.call(req.body, 'ats_role');
    let nextAtsRole;
    if (hasAtsRoleField) {
      nextAtsRole = typeof ats_role === 'string' && ats_role.trim() ? ats_role.trim() : null;
      if (nextAtsRole) {
        const validAtsRole = await pool.query('SELECT id FROM ats_roles WHERE id = $1 LIMIT 1', [nextAtsRole]);
        if (!validAtsRole.rowCount) return res.status(400).json({ error: 'Select a valid ATS Role.' });
        if (['ceo', 'exec_sponsor'].includes(nextAtsRole) && req.user.role !== 'super_admin') {
          return res.status(403).json({ error: 'Only Super Admin can assign CEO recruitment access.' });
        }
      }
    }

    const updateRes = await pool.query(`
      UPDATE employees SET
        name = COALESCE($1, name),
        email = COALESCE($2, email),
        phone = COALESCE($3, phone),
        access_role = $4,
        department = $5,
        role = $6,
        designation = $7,
        manager_id = $8,
        manager = $9,
        has_dashboard_access = COALESCE($10, has_dashboard_access),
        user_type = COALESCE($11, user_type)
      WHERE id = $12
      RETURNING *
    `, [typeof name === 'string' && name.trim() ? name.trim() : null, nextEmail, phone, nextAccessRole, nextDepartment, nextRoleTitle, nextDesignation, nextManagerId, nextManagerName, has_dashboard_access, user_type, id]);

    const resource = updateRes.rows[0];
    const cleanEmail = (resource.email || '').trim().toLowerCase();
    const uaRes = await pool.query('SELECT recruiter_id, ats_role FROM user_accounts WHERE employee_id = $1 LIMIT 1', [id]);
    const existingRecId = uaRes.rows[0]?.recruiter_id || id;

    if (hasAtsRoleField && nextAtsRole) {
      const initials = resource.name.trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase() || 'ST';
      const defaultTag = `${resource.name.trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'REC'}-TAG`;
      const explicitTag = typeof sourcing_tag === 'string' && sourcing_tag.trim() ? sourcing_tag.trim() : null;
      const explicitSpec = typeof specialization === 'string' && specialization.trim() ? specialization.trim() : null;
      const explicitCap = max_candidate_capacity !== undefined && max_candidate_capacity !== null && max_candidate_capacity !== ''
        ? Math.max(1, parseInt(max_candidate_capacity, 10) || 20)
        : null;
      const atsAccessVal = has_ats_access !== undefined ? Boolean(has_ats_access) : true;
      await pool.query(`
        INSERT INTO recruitment_team (
          id, name, role_title, department, reports_to, reports_to_id, is_head, email, phone,
          avatar_initials, specialization, active_vacancies, has_ats_access, ats_role,
          sourcing_tag, max_candidate_capacity, status, employee_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          role_title = EXCLUDED.role_title,
          department = EXCLUDED.department,
          reports_to = EXCLUDED.reports_to,
          reports_to_id = EXCLUDED.reports_to_id,
          is_head = EXCLUDED.is_head,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          specialization = COALESCE($18, recruitment_team.specialization, EXCLUDED.specialization),
          has_ats_access = EXCLUDED.has_ats_access,
          ats_role = EXCLUDED.ats_role,
          sourcing_tag = COALESCE($19, recruitment_team.sourcing_tag, EXCLUDED.sourcing_tag),
          max_candidate_capacity = COALESCE($20, recruitment_team.max_candidate_capacity, EXCLUDED.max_candidate_capacity),
          status = EXCLUDED.status,
          employee_id = EXCLUDED.employee_id
      `, [
        existingRecId, resource.name, resource.role, resource.department, resource.manager || '', resource.manager_id,
        nextAtsRole === 'rec_lead', cleanEmail, resource.phone || '', initials,
        explicitSpec || resource.department,
        atsAccessVal, nextAtsRole, explicitTag || defaultTag, explicitCap || 20,
        resource.status === 'Inactive' ? 'Inactive' : 'Active', id,
        explicitSpec, explicitTag, explicitCap
      ]);
      await pool.query(
        'UPDATE user_accounts SET name=$1,email=$2,role=$3,department=$4,role_title=$5,ats_role=$6,recruiter_id=$7,is_head_hr=$8,updated_at=NOW() WHERE employee_id=$9',
        [resource.name, cleanEmail, resource.access_role, resource.department, resource.role, nextAtsRole, existingRecId, nextAtsRole === 'rec_lead', id]
      );
    } else if (hasAtsRoleField && !nextAtsRole) {
      await pool.query(
        'UPDATE user_accounts SET name=$1,email=$2,role=$3,department=$4,role_title=$5,ats_role=NULL,recruiter_id=NULL,is_head_hr=false,updated_at=NOW() WHERE employee_id=$6',
        [resource.name, cleanEmail, resource.access_role, resource.department, resource.role, id]
      );
      await pool.query("UPDATE recruitment_team SET has_ats_access=false, ats_role=NULL, status='Inactive' WHERE id=$1 OR employee_id=$2", [existingRecId, id]);
    } else {
      await pool.query('UPDATE user_accounts SET name=$1,email=$2,role=$3,department=$4,role_title=$5,updated_at=NOW() WHERE employee_id=$6',
        [resource.name, cleanEmail, resource.access_role, resource.department, resource.role, id]);
      await pool.query(
        'UPDATE recruitment_team SET name=$1,email=$2,phone=$3,department=$4,role_title=$5,reports_to=$6,reports_to_id=$7 WHERE employee_id=$8 OR id=$9',
        [resource.name, cleanEmail, resource.phone || '', resource.department, resource.role, resource.manager || '', resource.manager_id, id, existingRecId]
      );
    }

    await pool.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || editorName || 'Administrator', 'UPDATE_RESOURCE', `Updated resource details for: ${name || current.name} (${id})`]
    );

    res.json(updateRes.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch('/api/resources/:id/revoke-access', async (req, res) => {
  try {
    const { id } = req.params;
    const { has_dashboard_access, editorName } = req.body;

    const checkRes = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Resource not found' });
    if (checkRes.rows[0].access_role === 'super_admin' && !has_dashboard_access) {
      return res.status(400).json({ error: 'Cannot revoke dashboard access for Super Admin accounts' });
    }

    const updateRes = await pool.query(
      'UPDATE employees SET has_dashboard_access = $1 WHERE id = $2 RETURNING *',
      [Boolean(has_dashboard_access), id]
    );

    const actionType = has_dashboard_access ? 'GRANT_DASHBOARD_ACCESS' : 'REVOKE_DASHBOARD_ACCESS';
    const actionDesc = has_dashboard_access 
      ? `Granted dashboard access to "${checkRes.rows[0].name}"` 
      : `Revoked dashboard access for "${checkRes.rows[0].name}"`;

    await pool.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || editorName || 'Administrator', actionType, actionDesc]
    );

    res.json({
      success: true,
      message: actionDesc,
      resource: updateRes.rows[0]
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/resources/trash', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.*,
        r.name AS system_role_name,
        epd.personal_email,
        epd.dob,
        epd.gender,
        epd.blood_group,
        epd.current_address,
        epd.emergency_contact_name,
        epd.emergency_contact_phone,
        epd.bank_name,
        epd.pan_number,
        epd.aadhaar_number,
        epd.onboarding_submitted,
        epd.hr_verified AS kyc_verified,
        COALESCE(docs.doc_count, 0)::int AS uploaded_docs_count
      FROM employees e
      LEFT JOIN roles r ON r.id = e.access_role
      LEFT JOIN employee_personal_details epd ON epd.employee_id = e.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS doc_count
        FROM employee_uploaded_documents d
        WHERE d.employee_id = e.id
      ) docs ON TRUE
      WHERE e.status = 'Inactive'
      ORDER BY e.created_at DESC, e.id ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/resources/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      department,
      access_role,
      role: jobTitle,
      status = 'Confirmed',
      manager_id,
      ats_role,
      editorName
    } = req.body || {};

    const empRes = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (empRes.rowCount === 0) return res.status(404).json({ error: 'Profile not found' });
    const existing = empRes.rows[0];
    if (existing.status !== 'Inactive') {
      return res.status(400).json({ error: 'Only inactive or trashed profiles can be restored from Trash.' });
    }

    const cleanDept = typeof department === 'string' ? department.trim() : '';
    const cleanAccessRole = typeof access_role === 'string' ? access_role.trim() : '';
    if (!cleanDept) {
      return res.status(400).json({ error: 'Department is required to activate this profile.' });
    }
    if (!cleanAccessRole) {
      return res.status(400).json({ error: 'System Access Role is required to activate this profile.' });
    }
    if (cleanAccessRole === 'super_admin' && req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only Super Admin can assign the Super Admin role.' });
    }

    const roleRowRes = await pool.query('SELECT id, name FROM roles WHERE id = $1 LIMIT 1', [cleanAccessRole]);
    if (roleRowRes.rowCount === 0) {
      return res.status(400).json({ error: 'Selected System Access Role does not exist.' });
    }
    const resolvedRoleName = (typeof jobTitle === 'string' && jobTitle.trim()) ? jobTitle.trim() : roleRowRes.rows[0].name;
    const nextStatus = ['Confirmed', 'Probation', 'Active'].includes(status) ? status : 'Confirmed';

    let finalMgrId = manager_id || null;
    let finalMgrName = null;
    if (finalMgrId) {
      if (finalMgrId === id) throw invalid('An employee cannot be their own manager.');
      const mgrRes = await pool.query(
        "SELECT id, name FROM employees WHERE id = $1 AND COALESCE(status, 'Active') NOT IN ('Inactive', 'Exited', 'Terminated') LIMIT 1",
        [finalMgrId]
      );
      if (mgrRes.rowCount === 0) {
        return res.status(400).json({ error: 'Selected reporting manager was not found or is inactive.' });
      }
      finalMgrId = mgrRes.rows[0].id;
      finalMgrName = mgrRes.rows[0].name;
    }

    const cleanAtsRole = typeof ats_role === 'string' && ats_role.trim() ? ats_role.trim() : null;
    if (cleanAtsRole) {
      const atsCheck = await pool.query('SELECT id FROM ats_roles WHERE id = $1 LIMIT 1', [cleanAtsRole]);
      if (atsCheck.rowCount === 0) {
        return res.status(400).json({ error: 'Selected Recruitment ATS role does not exist.' });
      }
    }

    const restoredRes = await pool.query(
      `UPDATE employees
       SET status = $1,
           department = $2,
           access_role = $3,
           role = $4,
           designation = $4,
           manager = $5,
           manager_id = $6,
           has_dashboard_access = TRUE
       WHERE id = $7
       RETURNING *`,
      [nextStatus, cleanDept, cleanAccessRole, resolvedRoleName, finalMgrName, finalMgrId, id]
    );

    const cleanEmail = (existing.email || `${id.toLowerCase()}@femovo.demo`).trim().toLowerCase();
    const uaRes = await pool.query(
      `UPDATE user_accounts
       SET status = 'Active',
           department = $1,
           role = $2,
           role_title = $3,
           ats_role = $4,
           recruiter_id = $5,
           is_head_hr = $6,
           session_version = session_version + 1,
           updated_at = NOW()
       WHERE employee_id = $7`,
      [cleanDept, cleanAccessRole, resolvedRoleName, cleanAtsRole, cleanAtsRole ? id : null, cleanAtsRole === 'rec_lead', id]
    );

    if (uaRes.rowCount === 0) {
      const defaultPinHash = await hashPin(`${id}@Femovo#2026`);
      await pool.query(
        `INSERT INTO user_accounts (employee_id, email, name, pin, role, role_title, department, avatar, status, ats_role, recruiter_id, is_head_hr)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Active', $9, $10, $11)`,
        [id, cleanEmail, existing.name, defaultPinHash, cleanAccessRole, resolvedRoleName, cleanDept, (existing.name || 'U').slice(0, 2).toUpperCase(), cleanAtsRole, cleanAtsRole ? id : null, cleanAtsRole === 'rec_lead']
      );
    }

    if (cleanAtsRole) {
      await pool.query(
        `INSERT INTO recruitment_team (id, employee_id, name, email, phone, department, role_title, ats_role, reports_to, reports_to_id, status, has_ats_access)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'Active', TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           department = EXCLUDED.department,
           role_title = EXCLUDED.role_title,
           ats_role = EXCLUDED.ats_role,
           reports_to = EXCLUDED.reports_to,
           reports_to_id = EXCLUDED.reports_to_id,
           status = 'Active',
           has_ats_access = TRUE`,
        [id, existing.name, cleanEmail, existing.phone || '', cleanDept, resolvedRoleName, cleanAtsRole, finalMgrName || '', finalMgrId]
      );
    } else {
      await pool.query(
        "UPDATE recruitment_team SET status = 'Inactive', has_ats_access = FALSE, ats_role = NULL WHERE id = $1 OR employee_id = $1",
        [id]
      );
    }

    await pool.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [
        req.user?.name || editorName || 'Administrator',
        'RESTORE_FROM_TRASH',
        `Activated & restored ${existing.name} (${id}) — Dept: ${cleanDept}, Role: ${roleRowRes.rows[0].name}${cleanAtsRole ? `, ATS: ${cleanAtsRole}` : ''}`
      ]
    );

    res.json({
      success: true,
      message: `${existing.name} restored and activated successfully.`,
      resource: restoredRes.rows[0]
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/resources/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { editorName } = req.body || {};
    const moved = await moveEmployeeToTrash(id, req.user?.name || editorName || 'Administrator', 'DEACTIVATE_RESOURCE');
    if (moved.notFound) return res.status(404).json({ error: 'Resource not found' });

    res.json({
      success: true,
      message: `${moved.previous.name} moved to Trash with all access removed.`,
      resource: moved.resource
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ==========================================
// 26. RECRUITMENT ATS ROLES & PERMISSIONS
// ==========================================

// 1. Get all ATS roles with assigned user accounts
app.get('/api/ats/roles', async (req, res) => {
  try {
    const rolesRes = await pool.query("SELECT * FROM ats_roles WHERE id NOT IN ('employee', 'external_agency') ORDER BY CASE id WHEN 'ceo' THEN 1 WHEN 'rec_lead' THEN 2 WHEN 'rec_associate' THEN 3 WHEN 'hiring_manager' THEN 4 WHEN 'exec_sponsor' THEN 6 ELSE 5 END, created_at");
    const usersRes = await pool.query(`
      SELECT employee_id, name, email, avatar, role_title, department, role, ats_role
      FROM user_accounts
      WHERE status = 'Active' OR status IS NULL
      ORDER BY employee_id ASC
    `);

    // Map users to roles
    const usersByAtsRole = {};
    for (const u of usersRes.rows) {
      let rId = u.ats_role;
      if (!rId) {
        if (u.role === 'super_admin') rId = 'exec_sponsor';
        else if (u.role === 'hr') rId = 'rec_lead';
        else if (u.role === 'recruiter') rId = 'rec_associate';
        else if (u.role === 'manager' || u.role === 'interviewer') rId = 'hiring_manager';
        else rId = 'employee';
      }
      if (!usersByAtsRole[rId]) usersByAtsRole[rId] = [];
      usersByAtsRole[rId].push(u);
    }

    const roles = rolesRes.rows.map(r => ({
      ...r,
      resourceCount: (usersByAtsRole[r.id] || []).length,
      assignedUsers: usersByAtsRole[r.id] || []
    }));

    res.json(roles);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 2. Get ATS Modules and Action definitions
app.get('/api/ats/permissions/modules', (req, res) => {
  res.json(ATS_MODULES);
});

// 3. Get permissions for a specific ATS role
app.get('/api/ats/roles/:roleId/permissions', async (req, res) => {
  try {
    const { roleId } = req.params;
    const result = await pool.query('SELECT module, action, allowed FROM ats_role_permissions WHERE role_id = $1', [roleId]);
    // Start from the role's defaults so every switch shows what really applies.
    const effective = defaultPermissions(roleId);
    for (const r of result.rows) if (r.module === moduleOfAction(r.action)) effective[r.action] = r.allowed === true;
    const permissions = {};
    for (const action of ATS_ACTIONS) (permissions[moduleOfAction(action)] ||= {})[action] = effective[action];
    res.json({ roleId, permissions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 4. Update permissions for an ATS role
app.put('/api/ats/roles/:roleId/permissions', async (req, res) => {
  const client = await pool.connect();
  try {
    const { roleId } = req.params;
    const { permissions, editorName } = req.body;

    const roleCheck = await client.query('SELECT * FROM ats_roles WHERE id = $1', [roleId]);
    if (roleCheck.rowCount === 0) return res.status(404).json({ error: 'ATS Role not found' });

    if (!permissions || typeof permissions !== 'object') return res.status(400).json({ error: 'No permissions were sent.' });
    await client.query('BEGIN');
    for (const group of Object.values(permissions)) {
      for (const [action, value] of Object.entries(group || {})) {
        // Only switches the server enforces can be saved.
        if (!ATS_ACTIONS.includes(action)) continue;
        await client.query(`
          INSERT INTO ats_role_permissions (role_id, module, action, allowed)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (role_id, module, action)
          DO UPDATE SET allowed = EXCLUDED.allowed
        `, [roleId, moduleOfAction(action), action, Boolean(value)]);
      }
    }
    await client.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || editorName || 'Administrator', 'UPDATE_ATS_PERMISSIONS', `Updated ATS permissions matrix for role: ${roleCheck.rows[0].name} (${roleId})`]
    );

    await client.query('COMMIT');

    res.json({ success: true, message: `Updated ATS permissions for ${roleCheck.rows[0].name}` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5. Create or clone custom ATS role
app.post('/api/ats/roles', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, cloneFromRoleId, creatorName } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Role name is required' });

    const roleId = 'ats_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
    const checkExists = await client.query('SELECT id FROM ats_roles WHERE id = $1', [roleId]);
    if (checkExists.rowCount > 0) return res.status(400).json({ error: `An ATS role with ID "${roleId}" already exists` });

    await client.query('BEGIN');
    await client.query(
      'INSERT INTO ats_roles (id, name, description, badge_color, is_system) VALUES ($1, $2, $3, $4, false)',
      [roleId, name.trim(), description || 'Custom recruitment role', '#0891b2']
    );

    if (cloneFromRoleId) {
      await client.query(`
        INSERT INTO ats_role_permissions (role_id, module, action, allowed)
        SELECT $1, module, action, allowed
        FROM ats_role_permissions
        WHERE role_id = $2
        ON CONFLICT (role_id, module, action) DO NOTHING
      `, [roleId, cloneFromRoleId]);
    }

    await client.query(
      'INSERT INTO audit_logs (actor_name, action, details) VALUES ($1, $2, $3)',
      [req.user?.name || creatorName || 'Administrator', 'CREATE_ATS_ROLE', `Created new ATS role: ${name.trim()} (${roleId})`]
    );

    await client.query('COMMIT');

    const newRole = await pool.query('SELECT * FROM ats_roles WHERE id = $1', [roleId]);
    res.status(201).json(newRole.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Serve static React client build in production if available
const clientDist = path.join(__dirname, '../client/dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(200).send('FEMOVO HR API Server running.');
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : error.code === '23505' ? 409 : 500);
  res.status(status).json({ error: status < 500 ? error.message : 'The request could not be completed.' });
});

async function start() {
  try {
    validateConfig();
    const pending = await pendingMigrations(pool);
    if (pending.length) throw new Error(`Run reviewed database migrations before startup. Pending: ${pending.join(', ')}`);
    const server = app.listen(PORT, () => {
      console.log(`FEMOVO HR Backend Server listening on http://localhost:${PORT}`);
    });
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{ server.close(async()=>{await pool.end();process.exit(0);}); setTimeout(()=>process.exit(1),10000).unref(); });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
