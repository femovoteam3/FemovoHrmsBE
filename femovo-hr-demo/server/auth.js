import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import './config.js';
import { pool } from './db.js';
import { defaultPermissions, moduleOfAction } from './ats-permissions.js';

export const AUTH_COOKIE_NAME = 'femovo_session';
export const CSRF_COOKIE_NAME = 'femovo_csrf';

export function parseCookies(header) {
  const cookies = Object.create(null);
  if (typeof header !== 'string' || !header.trim()) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

export function isSecureCookie(req) {
  if (process.env.NODE_ENV === 'production') return true;
  if (req?.secure) return true;
  const proto = req?.get?.('x-forwarded-proto') || req?.headers?.['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

function cookieTtlMs(expiresIn) {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) return expiresIn * 1000;
  const match = typeof expiresIn === 'string' && expiresIn.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) return 3600_000;
  const mult = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }[match[2].toLowerCase()];
  return Number(match[1]) * mult;
}

export function setAuthCookies(req, res, token, csrfToken = crypto.randomBytes(24).toString('hex')) {
  const secure = isSecureCookie(req);
  const maxAge = cookieTtlMs(JWT_EXPIRES_IN);
  res.cookie(AUTH_COOKIE_NAME, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge });
  res.cookie(CSRF_COOKIE_NAME, csrfToken, { httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge });
  return csrfToken;
}

export function clearAuthCookies(req, res) {
  const secure = isSecureCookie(req);
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
  res.clearCookie(CSRF_COOKIE_NAME, { httpOnly: false, secure, sameSite: 'lax', path: '/' });
}

export function verifyCsrf(req, cookies = parseCookies(req?.headers?.cookie)) {
  const headerToken = req?.get?.('x-csrf-token') || req?.headers?.['x-csrf-token'];
  const cookieToken = cookies?.[CSRF_COOKIE_NAME];
  if (typeof headerToken !== 'string' || typeof cookieToken !== 'string' || !headerToken || !cookieToken) {
    return false;
  }
  const a = Buffer.from(headerToken, 'utf8');
  const b = Buffer.from(cookieToken, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}



export const JWT_SECRET = process.env.JWT_SECRET;
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

/**
 * Generate a signed JWT token containing user identity and access context
 */
export function generateToken(user) {
  const payload = {
    userId: user.id || user.userId || null,
    sessionVersion: user.session_version ?? user.sessionVersion ?? 0,
    employeeId: user.employee_id || user.selfId || null,
    email: user.email,
    role: user.role,
    atsRole: user.ats_role || user.atsRole || null,
    department: user.department,
    name: user.name,
    roleTitle: user.role_title || user.roleTitle || user.role,
    isHeadHR: Boolean(user.is_head_hr || user.isHeadHR),
    recruiterId: user.recruiter_id || user.recruiterId || null,
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256', audience: 'femovo', issuer: 'femovo-api' });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'femovo', issuer: 'femovo-api' });
}

/**
 * Hash a plain text PIN / password using bcryptjs
 */
export async function hashPin(plainPin) {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(String(plainPin).trim(), salt);
}

/**
 * Verify a password against its stored bcrypt hash.
 */
export async function verifyPin(plainPin, storedPinOrHash) {
  if (!plainPin || !storedPinOrHash) return false;
  const cleanPin = String(plainPin).trim();
  const cleanStored = String(storedPinOrHash).trim();

  // If stored as bcrypt hash ($2a$, $2b$, $2y$)
  if (cleanStored.startsWith('$2a$') || cleanStored.startsWith('$2b$') || cleanStored.startsWith('$2y$')) {
    return bcrypt.compare(cleanPin, cleanStored);
  }

  // Legacy plaintext credentials must be migrated before use.
  return false;
}

/**
 * Express Authentication Middleware:
 * Inspects HttpOnly session cookie first (with CSRF check on mutations), or Authorization Bearer token.
 */
export async function authenticateToken(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[AUTH_COOKIE_NAME] || null;
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const token = cookieToken || bearerToken;

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required. Please sign in.',
      code: 'AUTH_TOKEN_REQUIRED'
    });
  }

  try {
    const decoded = verifyToken(token);
    const result = await pool.query(
      `SELECT u.*, e.has_dashboard_access, e.status AS employment_status,
              r.has_ats_access, r.status AS recruiter_status
       FROM user_accounts u LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN recruitment_team r ON r.id = u.recruiter_id
       WHERE u.id = $1`, [decoded.userId]);
    const account = result.rows[0];
    if (!account || account.status !== 'Active' || account.has_dashboard_access === false ||
        ['Inactive', 'Exited', 'Terminated'].includes(account.employment_status) ||
        account.session_version !== decoded.sessionVersion) {
      return res.status(401).json({ error: 'Session no longer valid. Please sign in again.', code: 'SESSION_REVOKED' });
    }
    if (cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !verifyCsrf(req, cookies)) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token.', code: 'CSRF_INVALID' });
    }
    req.user = { ...decoded, role: account.role, atsRole: account.ats_role,
      employeeId: account.employee_id, department: account.department, name: account.name,
      recruiterId: account.recruiter_id, isHeadHR: account.is_head_hr, isIccMember: account.is_icc_member === true,
      atsAccess: account.role === 'super_admin' || (account.has_ats_access !== false && account.recruiter_status !== 'Inactive') };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Your session has expired. Please sign in again.',
        code: 'TOKEN_EXPIRED'
      });
    }
    if (!['JsonWebTokenError','NotBeforeError'].includes(err.name)) return res.status(503).json({ error: 'Authentication temporarily unavailable.' });
    return res.status(401).json({
      error: 'Invalid or malformed authentication token.',
      code: 'INVALID_TOKEN'
    });
  }
}

/**
 * Role-Based Access Control (RBAC) Authorization Middleware
 */
export function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }

    const userRole = req.user.role;

    // Super admin always has unrestricted administrative access
    if (userRole === 'super_admin') {
      return next();
    }

    if (allowedRoles.includes(userRole)) {
      return next();
    }

    return res.status(403).json({
      error: `Access denied. Role "${userRole}" is not authorized for this operation.`,
      code: 'FORBIDDEN',
      allowedRoles
    });
  };
}

/**
 * Retrieve dynamic module permissions matrix from PostgreSQL for a role
 */
const SUPER_ADMIN_FULL_PERMISSIONS = {
  dashboard: { view: true, view_analytics: true },
  profile: { view: true, edit: true },
  employees: { view: true, add: true, edit: true, delete: true, view_sensitive: true },
  departments: { view: true, manage: true },
  attendance: { view: true, regularize: true },
  leaves: { view: true, apply: true, approve_reject: true },
  onboarding: { view: true, upload_docs: true, verify_kyc: true },
  ats: { view: true },
  exits: { view: true, submit_resignation: true, clearance_settlement: true },
  training: { view: true, edit: true },
  notices: { view: true, post_notice: true, send_kudos: true },
  helpdesk: { view: true, submit_ticket: true, resolve_ticket: true },
  audit: { view: true },
  permissions: {
    view: true,
    create_role: true,
    edit_permissions: true,
    delete_role: true,
    manage_resources: true,
    view_trash: true,
    restore_trash: true
  }
};

export async function getRolePermissionsMap(roleId) {
  const permMap = roleId === 'super_admin'
    ? Object.fromEntries(Object.entries(SUPER_ADMIN_FULL_PERMISSIONS).map(([mod, acts]) => [mod, { ...acts }]))
    : {};
  try {
    const res = await pool.query(
      'SELECT module, action, allowed FROM role_permissions WHERE role_id = $1',
      [roleId]
    );
    if (res.rows.length > 0) {
      res.rows.forEach(p => {
        if (!permMap[p.module]) permMap[p.module] = {};
        permMap[p.module][p.action] = roleId === 'super_admin' || Boolean(p.allowed);
      });
      return permMap;
    }
  } catch (err) {
    console.error(`Error loading permissions for role "${roleId}":`, err.message);
  }

  if (roleId === 'super_admin') {
    return permMap;
  }

  return {};
}

/**
 * Middleware: Enforces dynamic granular action permission from PostgreSQL role_permissions matrix
 */
export function requirePermission(moduleName, actionName) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    }

    const userRole = req.user.role;

    // Super Admin always has unrestricted access — bypass DB check entirely
    if (userRole === 'super_admin') {
      return next();
    }

    try {
      const result = await pool.query(
        'SELECT allowed FROM role_permissions WHERE role_id = $1 AND module = $2 AND action = $3',
        [userRole, moduleName, actionName]
      );

      if (result.rowCount > 0) {
        if (result.rows[0].allowed === true) {
          return next();
        } else {
          return res.status(403).json({
            error: `Access denied. Role "${userRole}" lacks permission "${moduleName}:${actionName}".`,
            code: 'FORBIDDEN_PERMISSION',
            module: moduleName,
            action: actionName
          });
        }
      }

      // No explicit row — default deny for all non-super_admin roles
      return res.status(403).json({
        error: `Access denied. Role "${userRole}" lacks permission "${moduleName}:${actionName}".`,
        code: 'FORBIDDEN_PERMISSION',
        module: moduleName,
        action: actionName
      });
    } catch (err) {
      console.error(`Error checking permission "${moduleName}:${actionName}":`, err);
      return res.status(500).json({ error: 'Permission verification failed: ' + err.message });
    }
  };
}

/**
 * Predicate to determine if an API route is public
 */
export async function getUserModulePermissions(user) {
  const permissions = await getRolePermissionsMap(user.role);
  if (user.role === 'super_admin') return permissions;
  const result = await pool.query('SELECT permission_key, allowed FROM user_specific_permissions WHERE employee_id=$1', [user.employeeId || user.employee_id]);
  for (const row of result.rows) {
    const parts = row.permission_key.split(':');
    if (parts.length !== 2 || parts.some(key => !/^[a-z][a-z0-9_]*$/.test(key) || ['constructor','prototype','__proto__'].includes(key))) continue;
    const [module, action] = parts;
    permissions[module] = { ...permissions[module], [action]: row.allowed === true };
  }
  return permissions;
}

export function isPublicEndpoint(req) {
  const fullPath = ((req.baseUrl || '') + req.path).split('?')[0].replace(/\/+$/, '') || '/';
  const method = req.method;

  // 1. Health check
  if (['/api/health', '/api/ready'].includes(fullPath) && method === 'GET') return true;

  // 2. Authentication endpoints
  if (fullPath === '/api/auth/login' && method === 'POST') return true;
  if (fullPath === '/api/auth/logout' && method === 'POST') return true;

  // 3. Public Careers / Candidate Self-Service Application & Company Masters
  if (fullPath === '/api/requisitions' && method === 'GET') return true;
  if (fullPath === '/api/departments' && method === 'GET') return true;
  if (fullPath === '/api/masters' && method === 'GET') return true;
  if (fullPath === '/api/applicants' && method === 'POST') return true;
  if (/^\/api\/applicants\/[^/]+\/resume$/.test(fullPath) && method === 'POST') return true;

  return false;
}

/**
 * The recruitment role a person acts in. An explicit ATS role wins; otherwise it follows the login role.
 */
export function resolveAtsRole(user) {
  const explicit = user.ats_role || user.atsRole;
  if (explicit) return explicit;
  const role = user.role;
  if (role === 'super_admin' || role === 'admin') return 'exec_sponsor';
  if (role === 'hr' || user.is_head_hr || user.isHeadHR) return 'rec_lead';
  if (role === 'recruiter' || role === 'hr_assistant') return 'rec_associate';
  if (role === 'manager' || role === 'interviewer') return 'hiring_manager';
  return 'employee';
}

// Every id a signed-in person can appear under on a candidate or an interview.
export const actorIds = user => [...new Set([user?.recruiterId, user?.employeeId, user?.employee_id, user?.selfId].filter(Boolean))];

const isAssistant = user => user.role === 'recruiter' || user.role === 'hr_assistant' || resolveAtsRole(user) === 'rec_associate';
const isInterviewer = user => resolveAtsRole(user) === 'hiring_manager' || ['employee', 'manager', 'interviewer'].includes(user.role);

/**
 * Merge ATS role defaults, saved role switches, and person-specific overrides in memory.
 */
export function buildEffectivePermissions(user, atsRoleRows = [], overrideRows = []) {
  if (!user) return defaultPermissions(null);

  const atsRole = resolveAtsRole(user);
  const perms = defaultPermissions(atsRole);
  for (const row of atsRoleRows) {
    if ((row.role_id == null || row.role_id === atsRole) && row.module === moduleOfAction(row.action)) {
      perms[row.action] = Boolean(row.allowed);
    }
  }

  if (user.role === 'super_admin') {
    Object.keys(perms).forEach(key => { perms[key] = true; });
  } else {
    for (const row of overrideRows) {
      if (Object.hasOwn(perms, row.permission_key)) perms[row.permission_key] = row.allowed;
    }
  }
  if (user.role !== 'super_admin' && user.atsAccess === false) Object.keys(perms).forEach(key => { perms[key] = false; });
  return perms;
}

/**
 * What a person may do in recruitment: the defaults of their role, then the switches saved for
 * that role, then any switches saved for the person. Super Admin can do everything.
 */
export async function getUserEffectivePermissions(user) {
  if (!user) return defaultPermissions(null);

  const atsRole = resolveAtsRole(user);
  const saved = await pool.query('SELECT module, action, allowed FROM ats_role_permissions WHERE role_id = $1', [atsRole]);
  let overrideRows = [];
  if (user.role !== 'super_admin') {
    const empId = user.employee_id || user.employeeId || user.selfId;
    const overrides = await pool.query('SELECT permission_key, allowed FROM user_specific_permissions WHERE employee_id = $1', [empId]);
    overrideRows = overrides.rows;
  }
  return buildEffectivePermissions(user, saved.rows, overrideRows);
}

/**
 * Builds the SQL WHERE clause and parameter list for scoping applicant queries.
 * An HR Assistant sees the candidates they own; anyone sees a candidate they are interviewing.
 */
export async function buildCandidateScopeFilter(user, tablePrefix = '') {
  if (!user) return { clause: '1=0', params: [] };

  const perms = await getUserEffectivePermissions(user);
  if (perms.view_candidates === false) return { clause: '1=0', params: [] };
  if (user.role === 'super_admin' || perms.view_all_candidates === true) return { clause: '1=1', params: [] };

  const ids = actorIds(user);
  if (ids.length === 0) return { clause: '1=0', params: [] };
  const p = tablePrefix ? `${tablePrefix}.` : 'applicants.';
  const interviewing = `(${p}interviewer_id = ANY($1) OR EXISTS (SELECT 1 FROM interviews scope_i WHERE scope_i.applicant_id = ${p}id AND scope_i.interviewer_id = ANY($1) AND scope_i.status <> 'Cancelled'))`;

  if (isAssistant(user)) {
    return { clause: `(${p}assigned_recruiter_id = ANY($1) OR ${p}backup_recruiter_id = ANY($1) OR ${interviewing})`, params: [ids] };
  }
  if (isInterviewer(user)) return { clause: interviewing, params: [ids] };
  return { clause: '1=0', params: [] };
}

const ACTION_PERMISSION = {
  view: ['view_candidates', 'You do not have permission to view candidate records.'],
  create: ['create_candidates', 'You do not have permission to add or import candidates.'],
  delete: ['delete_candidates', 'You do not have permission to delete candidate records.'],
  assign: ['assign_candidates', 'You do not have permission to assign or reallocate candidates.'],
  feedback: ['submit_feedback', 'You do not have permission to submit interview feedback.'],
  edit: ['edit_candidates', 'You do not have permission to modify candidate records.'],
  promote: ['onboard_to_ems', 'You do not have permission to onboard candidates.'],
  export: ['export_candidates', 'You do not have permission to export candidate reports.']
};

/**
 * Validates whether a user is authorized to perform an action on a specific candidate.
 * Returns { authorized: boolean, error?: string, code?: string }
 */
export async function checkCandidateAccess(user, candidate, action = 'view') {
  if (!user) return { authorized: false, error: 'Authentication required', code: 'AUTH_REQUIRED' };

  const perms = await getUserEffectivePermissions(user);
  const [permission, message] = ACTION_PERMISSION[action] || ACTION_PERMISSION.view;
  if (!perms[permission]) return { authorized: false, error: message, code: 'FORBIDDEN_ACTION' };

  if (user.role === 'super_admin' || perms.view_all_candidates === true) return { authorized: true };
  // Create and export are not about one candidate.
  if (!candidate) return { authorized: true };

  const ids = actorIds(user);
  const isInterviewing = async () => {
    if (candidate.interviewer_id && ids.includes(candidate.interviewer_id)) return true;
    if (candidate.id == null) return false;
    const found = await pool.query("SELECT 1 FROM interviews WHERE applicant_id = $1 AND interviewer_id = ANY($2) AND status <> 'Cancelled' LIMIT 1", [candidate.id, ids]);
    return found.rowCount > 0;
  };

  if (isAssistant(user)) {
    if (ids.includes(candidate.assigned_recruiter_id) || ids.includes(candidate.backup_recruiter_id)) return { authorized: true };
    // Someone chosen to interview a candidate may read and score that candidate only.
    if (['view', 'feedback'].includes(action) && await isInterviewing()) return { authorized: true };
    return { authorized: false, error: 'Access denied. You can only view and manage candidates assigned to you.', code: 'FORBIDDEN_UNASSIGNED_CANDIDATE' };
  }

  if (isInterviewer(user)) {
    if (!await isInterviewing()) {
      return { authorized: false, error: 'Access denied. You can only access candidate interviews specifically assigned to you.', code: 'FORBIDDEN_UNASSIGNED_INTERVIEW' };
    }
    if (!['view', 'feedback'].includes(action)) {
      return { authorized: false, error: `Access denied. Interviewers are not authorized to perform "${action}" on candidate records.`, code: 'FORBIDDEN_INTERVIEWER_ACTION' };
    }
    return { authorized: true };
  }

  return { authorized: false, error: 'Access denied for your role.', code: 'FORBIDDEN_ROLE' };
}

/**
 * Strip salary fields from applicant records unless the caller has view_salary.
 * Interviewers (hiring_manager) also never receive current_ctc or expected_ctc.
 */
export function redactApplicant(row, perms, user) {
  if (!row || perms?.view_salary) return row;
  const { monthly_salary, ...rest } = row;
  if (resolveAtsRole(user) !== 'hiring_manager') return rest;
  const { current_ctc, expected_ctc, ...safe } = rest;
  return safe;
}
