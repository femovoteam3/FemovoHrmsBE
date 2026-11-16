import { pool, rawPool } from './db.js';
import { transactional } from './transaction.js';
import { getRolePermissionsMap, getUserEffectivePermissions, isPublicEndpoint } from './auth.js';

const administrators = ['super_admin', 'admin'];
const peopleManagers = [...administrators, 'hr'];
const selfLists = {
  '/api/employees': ['employees', 'id'], '/api/leaves': ['leaves', 'employee_id'],
  '/api/leaves/balances': ['leaves', 'employee_id'],
  '/api/exits': ['exits', 'employee_id'], '/api/attendance/roster': ['attendance', 'id'],
};

const accountRole = async employeeId => (await pool.query('SELECT role FROM user_accounts WHERE employee_id=$1', [employeeId])).rows[0]?.role ?? null;

export async function hasPermission(user, module, action) {
  if (user.role === 'super_admin') return true;
  const overrides = await pool.query('SELECT allowed FROM user_specific_permissions WHERE employee_id=$1 AND permission_key=$2', [user.employeeId, `${module}:${action}`]);
  if (overrides.rowCount) return overrides.rows[0].allowed === true;
  const permissions = await getRolePermissionsMap(user.role);
  return permissions[module]?.[action] === true;
}

export async function employeeScope(user, module, action = 'view') {
  if (await hasPermission(user, 'employees', 'view_sensitive') || (peopleManagers.includes(user.role) && await hasPermission(user, module, action))) return null;
  const ids = user.employeeId ? [user.employeeId] : [];
  if (['manager', 'head'].includes(user.role) && ['employees', 'attendance', 'leaves', 'training'].includes(module) && await hasPermission(user, module, action)) {
    const reports = await pool.query('SELECT id FROM employees WHERE manager_id=$1', [user.employeeId]);
    ids.push(...reports.rows.map(row => row.id));
  }
  return ids;
}

export function routePolicy(route, method) {
  return async (req, res, next) => {
    try {
      if (isPublicEndpoint({ baseUrl: '', path: req.path, method: req.method }) && !req.user) return next();
      const user = req.user;
      if (!user) return res.status(401).json({ error: 'Please sign in.' });
      const deny = () => res.status(403).json({ error: 'You do not have access to this operation.', code: 'FORBIDDEN' });
      const allow = async (module, action, roles) => (!roles || roles.includes(user.role)) && await hasPermission(user, module, action);
      const own = async (id, module, action = 'view') => {
        if (!await hasPermission(user, module, action)) return false;
        const ids = await employeeScope(user, module, action);
        return ids === null || ids.includes(id);
      };
      // Actor identity must never come from the browser.
      if (req.body && typeof req.body === 'object') {
        for (const key of ['actor', 'editorName', 'reviewerName', 'posted_by']) req.body[key] = user.name;
        if (route === '/api/kudos') { req.body.from_name = user.name; req.body.from_role = user.role; }
        if (route.endsWith('/acknowledge')) req.body.employeeName = user.name;
      }
      if (route.startsWith('/api/auth/me') || ['/api/auth/change-pin', '/api/auth/logout'].includes(route)) return next();
      if (route === '/api/auth/accounts') return (administrators.includes(user.role) || await hasPermission(user, 'permissions', 'view') || await hasPermission(user, 'employees', 'view')) ? next() : deny();
      if (route.startsWith('/api/files/')) return next(); // Record checks happen in the file service.
      if (method === 'get' && ['/api/health', '/api/ready', '/api/requisitions', '/api/departments', '/api/masters', '/api/roles'].includes(route)) return next();
      if (method === 'get' && route === '/api/roles/:id/permissions' && req.params.id === user.role) return next();
      if (route.startsWith('/api/resources') && method !== 'get' && user.role !== 'super_admin') {
        const requestedRole = typeof req.body?.access_role === 'string' ? req.body.access_role.trim() : req.body?.access_role;
        if (requestedRole === 'super_admin' || (req.params.id && await accountRole(req.params.id) === 'super_admin')) return deny();
      }
      // Recruitment team and permission pages follow the recruitment permissions, not the login role.
      if (/^\/api\/ats\/(roles|permissions|resources|assignments)(\/|$)/.test(route)) {
        if (user.role !== 'super_admin' && user.atsAccess === false) return deny();
        const can = await getUserEffectivePermissions(user);
        if (route === '/api/ats/permissions/modules' || (method === 'get' && route === '/api/ats/roles')) return can.configure_permissions || can.manage_ats_users ? next() : deny();
        if (/^\/api\/ats\/(roles|permissions)/.test(route)) return can.configure_permissions ? next() : deny();
        if (method === 'get') return can.manage_ats_users || can.assign_recruiters ? next() : deny();
        if (route.endsWith('/assignments') || route.endsWith('/reassign-all')) return can.assign_recruiters ? next() : deny();
        return can.manage_ats_users ? next() : deny();
      }
      if (/^\/api\/(roles|permissions|users|resources)(\/|$)/.test(route)) {
        const canViewPerms = await hasPermission(user, 'permissions', 'view');
        const canEditPerms = await hasPermission(user, 'permissions', 'edit_permissions');
        if (!administrators.includes(user.role) && !canViewPerms && !canEditPerms) return deny();
        const checkPermWithFallback = async (primaryAction, fallbackAction) => {
          const perms = await getRolePermissionsMap(user.role);
          const overrides = await pool.query('SELECT permission_key, allowed FROM user_specific_permissions WHERE employee_id=$1', [user.employeeId]);
          const ovMap = Object.fromEntries(overrides.rows.map(r => [r.permission_key, Boolean(r.allowed)]));
          const key = `permissions:${primaryAction}`;
          if (key in ovMap) return ovMap[key];
          if (perms.permissions && primaryAction in perms.permissions) return perms.permissions[primaryAction] === true;
          return fallbackAction ? await hasPermission(user, 'permissions', fallbackAction) : false;
        };
        if (route === '/api/resources/trash' && method === 'get') {
          return await checkPermWithFallback('view_trash', 'view') ? next() : deny();
        }
        if (route === '/api/resources/:id/restore' && method === 'post') {
          return await checkPermWithFallback('restore_trash', 'edit_permissions') ? next() : deny();
        }
        if (route.startsWith('/api/resources') && method !== 'get') {
          return await checkPermWithFallback('manage_resources', 'edit_permissions') ? next() : deny();
        }
        const permAction = method === 'get'
          ? 'view'
          : route === '/api/roles' && method === 'post'
            ? 'create_role'
            : route === '/api/roles/:id' && method === 'delete'
              ? 'delete_role'
              : 'edit_permissions';
        return await hasPermission(user, 'permissions', permAction) ? next() : deny();
      }
      if (method === 'get' && selfLists[route]) {
        const [module, key] = selfLists[route];
        if (!await hasPermission(user, module, 'view')) return deny();
        req.employeeScope = await employeeScope(user, module);
        const json = res.json;
        res.json = function (data) {
          if (Array.isArray(data) && req.employeeScope !== null) data = data.filter(row => req.employeeScope.includes(row[key]));
          return json.call(this, data);
        };
        return next();
      }
      if (route === '/api/stats') return (await hasPermission(user, 'dashboard', 'view') || await hasPermission(user, 'dashboard', 'view_analytics')) ? next() : deny();
      if (route.startsWith('/api/employees')) {
        // Only a super admin may change a super admin's account or grant that role.
        const targetRole = req.params.id && method !== 'get' && !route.endsWith('/attendance') ? await accountRole(req.params.id) : null;
        if (targetRole === 'super_admin' && user.role !== 'super_admin') return deny();
        if (route.endsWith('/credentials')) return req.params.id === user.employeeId || await hasPermission(user, 'employees', method === 'get' ? 'view' : 'edit') ? next() : deny();
        const requestedRole = typeof req.body?.access_role === 'string' ? req.body.access_role.trim() : req.body?.access_role;
        if (requestedRole === 'super_admin' && user.role !== 'super_admin') return deny();
        if (method !== 'post' && ((requestedRole != null && requestedRole !== targetRole) || req.body?.password)) {
          if (!administrators.includes(user.role)) return deny();
        }
        const action = method === 'post' ? 'add' : (method === 'delete' || route.endsWith('/status')) ? 'delete' : 'edit';
        return await hasPermission(user, 'employees', action) ? next() : deny();
      }
      if (route.startsWith('/api/attendance')) {
        if (method === 'get') {
          if (!await hasPermission(user, 'attendance', 'view')) return deny();
          const id = req.params.employeeId || req.query.employeeId;
          const ids = await employeeScope(user, 'attendance');
          if (id && id !== 'all' && ids !== null && !ids.includes(id)) return deny();
          if (ids !== null && (!id || id === 'all')) req.query.employeeId = user.employeeId;
          return next();
        }
        if (route.endsWith('/regularize')) return await allow('attendance', 'regularize', peopleManagers) ? next() : deny();
        return deny();
      }
      if (route.startsWith('/api/onboarding') || route.startsWith('/api/documents')) {
        if (route.endsWith('/submissions') || route.endsWith('/verify') || route.endsWith('/status') || (method === 'patch')) {
          return await allow('onboarding', 'verify_kyc', peopleManagers) ? next() : deny();
        }
        let id = req.params.employeeId;
        if (route.includes('/document/')) {
          const result = await pool.query('SELECT employee_id FROM employee_uploaded_documents WHERE id=$1', [req.params.id]);
          if (!result.rowCount) return res.status(404).json({ error: 'Document not found.' });
          id = result.rows[0].employee_id;
        }
        return await own(id, 'onboarding', method === 'get' ? 'view' : 'upload_docs') ? next() : deny();
      }
      if (route === '/api/leaves' && method === 'post') return req.body.employeeId === user.employeeId && await hasPermission(user, 'leaves', 'apply') ? next() : deny();
      if (route === '/api/leaves/:id/status') {
        if (!await hasPermission(user, 'leaves', 'approve_reject')) return deny();
        const result = await pool.query('SELECT employee_id FROM leaves WHERE id=$1', [req.params.id]);
        if (!result.rowCount) return res.status(404).json({ error: 'Leave not found.' });
        if (result.rows[0].employee_id === user.employeeId && !administrators.includes(user.role)) return deny();
        return await own(result.rows[0].employee_id, 'leaves', 'approve_reject') ? next() : deny();
      }
      // The recruitment services check each action and each candidate themselves.
      if (route.startsWith('/api/applicants') || route === '/api/import/applicants' || route === '/api/export/applicants'
        || /^\/api\/(interviews|offers|ats\/queues|ats\/interviewers)(\/|$)/.test(route) || (route.startsWith('/api/requisitions') && method !== 'get')) {
        return user.role !== 'super_admin' && user.atsAccess === false ? deny() : next();
      }
      if (route.startsWith('/api/notifications')) return next(); // A person reads only their own.
      if (route.startsWith('/api/tickets/icc-members')) return user.role === 'super_admin' ? next() : deny();
      if (route === '/api/tickets' && method === 'post') return await hasPermission(user, 'helpdesk', 'submit_ticket') ? next() : deny();
      if (route.startsWith('/api/tickets')) {
        // POSH complaints follow named ICC membership only; no role, including super admin, implies it.
        req.helpdesk = { canHandle: await allow('helpdesk', 'resolve_ticket', peopleManagers), isIccMember: user.isIccMember === true };
        if (!await hasPermission(user, 'helpdesk', 'view')) return deny();
        if (!req.params.id) return next();
        if (!/^\d+$/.test(req.params.id)) return deny();
        const found = await pool.query('SELECT employee_id, recipient_type, recipient_id, is_confidential FROM support_tickets WHERE id=$1', [req.params.id]);
        if (!found.rowCount) return deny();
        const ticket = found.rows[0];
        // A conversation addressed to a person is theirs alone; only the HR inbox is shared.
        const isHandler = ticket.is_confidential === true ? req.helpdesk.isIccMember
          : ticket.recipient_type === 'HR' ? req.helpdesk.canHandle
          : Boolean(user.employeeId) && ticket.recipient_id === user.employeeId;
        const isFiler = Boolean(user.employeeId) && ticket.employee_id === user.employeeId;
        return (route.endsWith('/messages') ? isHandler || isFiler : isHandler) ? next() : deny();
      }
      if (route.startsWith('/api/training')) {
        if (!await hasPermission(user, 'training', 'view')) return deny();
        const canManage = await allow('training', 'edit', peopleManagers);
        req.training = { canManage, scope: await employeeScope(user, 'training') };
        if (req.params.id !== undefined && !/^\d+$/.test(req.params.id)) return deny();
        if ((['/api/training', '/api/training/:id'].includes(route) && method === 'get') || route === '/api/training/tracking') return next();
        // Taking a course records a result against the signed-in person only.
        if (['/api/training/:id/open', '/api/training/:id/quiz', '/api/training/:id/attempts'].includes(route)) return user.employeeId ? next() : deny();
        return canManage ? next() : deny();
      }
      if (route === '/api/exits' && method === 'post') {
        if (user.employeeId && req.body.employee_id === user.employeeId) return await hasPermission(user, 'exits', 'submit_resignation') ? next() : deny();
        if (await accountRole(req.body.employee_id) === 'super_admin' && user.role !== 'super_admin') return deny();
        return await allow('exits', 'clearance_settlement', peopleManagers) ? next() : deny();
      }
      if (route === '/api/exits/:id' && method === 'patch') {
        if (!/^\d+$/.test(req.params.id)) return deny();
        const record = await pool.query('SELECT employee_id FROM exits WHERE id=$1', [req.params.id]);
        const subject = record.rows[0]?.employee_id;
        // Nobody clears their own exit, and only a super admin can end a super admin's access.
        if (subject && (subject === user.employeeId || (await accountRole(subject) === 'super_admin' && user.role !== 'super_admin'))) return deny();
        return await allow('exits', 'clearance_settlement', peopleManagers) ? next() : deny();
      }
      if (route.startsWith('/api/trainers')) {
        if (!await hasPermission(user, 'employees', 'view')) return deny();
        const canManage = await allow('employees', 'edit', peopleManagers);
        req.trainerAccess = { canManage, scope: canManage ? null : user.employeeId };
        if (method === 'get') return next();
        return canManage ? next() : deny();
      }
      if (route === '/api/recruitment/team') {
        if (user.role !== 'super_admin' && user.atsAccess === false) return deny();
        const can = await getUserEffectivePermissions(user);
        return can.manage_ats_users ? next() : deny();
      }
      if (route.startsWith('/api/departments') && method !== 'get') {
        const canManageDept = await hasPermission(user, 'departments', 'manage');
        const canEditEmp = await hasPermission(user, 'employees', 'edit');
        return canManageDept || canEditEmp ? next() : deny();
      }
      const rules = [
        [/^\/api\/departments/, 'departments', method === 'get' ? 'view' : 'manage'],
        [/^\/api\/masters/, 'employees', 'view'],
        [/^\/api\/exits/, 'exits', 'clearance_settlement'],
        [/^\/api\/(announcements|kudos)/, 'notices', method === 'get' ? 'view' : /react|acknowledge|like/.test(route) ? 'view' : route.includes('kudos') ? 'send_kudos' : 'post_notice'],
        [/^\/api\/audit-logs/, 'audit', 'view'],
        [/^\/api\/export\/employees/, 'employees', 'view_sensitive'],
        [/^\/api\/export\/attendance/, 'attendance', 'view'],
        [/^\/api\/(recruiters|recruitment)/, 'ats', 'view'],
      ];
      const rule = rules.find(([pattern]) => pattern.test(route));
      return rule && await hasPermission(user, rule[1], rule[2]) ? next() : deny();
    } catch (error) { next(error); }
  };
}

export function installRouteSecurity(app) {
  app.locals.routePolicies = [];
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const register = app[method].bind(app);
    app[method] = (route, ...handlers) => {
      if (!handlers.length || typeof route !== 'string' || !route.startsWith('/api/')) return register(route, ...handlers);
      app.locals.routePolicies.push({ method: method.toUpperCase(), route });
      const last = handlers.pop();
      const handler = method !== 'get' && route !== '/api/auth/login'
        ? transactional(last, rawPool, route)
        : (req, res, next) => Promise.resolve(last(req, res, next)).catch(next);
      return register(route, routePolicy(route, method), ...handlers, handler);
    };
  }
}

export function rateLimit({ windowMs = 15 * 60_000, max = 20, maxBuckets = 10000, key: keyOf = req => req.ip, skip = () => false, countSuccess = true } = {}) {
  const buckets = new Map();
  const capacity = Math.max(1, Number(maxBuckets) || 10000);
  return (req, res, next) => {
    if (skip(req)) return next();
    const now = Date.now();
    // Bound memory without retaining addresses beyond the window.
    for (const [k, value] of buckets) if (value.reset <= now) buckets.delete(k);
    const key = keyOf(req);
    let bucket;
    if (buckets.has(key)) {
      bucket = buckets.get(key);
      buckets.delete(key);
    } else {
      while (buckets.size >= capacity) {
        const oldestKey = buckets.keys().next().value;
        buckets.delete(oldestKey);
      }
      bucket = { count: 0, reset: now + windowMs };
    }
    bucket.count++;
    buckets.set(key, bucket);
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    if (!countSuccess) res.on('finish', () => { if (res.statusCode < 400 && bucket.count > 0) bucket.count--; });
    next();
  };
}
