import './config.js';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { rawPool } from './db.js';
import { ATS_ACTIONS, defaultPermissions, moduleOfAction } from './ats-permissions.js';

const migrationDirectory = fileURLToPath(new URL('migrations', import.meta.url));
const migrationFiles = async () => (await fs.readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort();

export async function pendingMigrations(database) {
  const applied = await database.query('SELECT version FROM schema_migrations');
  const versions = new Set(applied.rows.map(row => row.version));
  return (await migrationFiles()).filter(name => !versions.has(name));
}

export async function migrate(database = rawPool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('femovo-schema-migration'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const directory = migrationDirectory;
    for (const name of await migrationFiles()) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1',[name]);
      if (applied.rowCount) continue;
      // Hash existing legacy credentials before enforcing the security migration.
      if (name === '003_integrity.sql') {
        const accounts = await client.query('SELECT id,pin FROM user_accounts FOR UPDATE');
        for (const row of accounts.rows) if (!/^\$2[aby]\$/.test(row.pin)) {
          await client.query('UPDATE user_accounts SET pin=$1,plain_pin=NULL,session_version=session_version+1 WHERE id=$2',[await bcrypt.hash(row.pin.trim(),12),row.id]);
        }
      }
      await client.query(await fs.readFile(path.join(directory,name),'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[name]);
    }
    const roles = ['super_admin','admin','hr','employee','manager','head','recruiter','hr_assistant','interviewer'];
    const roleMeta = {
      super_admin: ['Super Admin', 'Full access to all system features, settings, and security controls'],
      admin: ['Administrator', 'Full access to workspace operations, staff records, and settings'],
      hr: ['HR Admin', 'Manage employees, onboarding KYC, attendance, leaves, and exits'],
      head: ['Department Head', 'Lead department staff, review attendance, and approve team leaves'],
      manager: ['Department Manager', 'Manage reporting team members, approve leaves, and regularize punches'],
      recruiter: ['Talent Recruiter', 'Manage job requisitions, candidate pipeline, interviews, and offers'],
      hr_assistant: ['HR Assistant', 'Screen candidates, schedule interviews, and manage hiring queues'],
      interviewer: ['Panel Interviewer', 'Review assigned candidate interviews and submit evaluation scorecards'],
      employee: ['Staff Employee', 'Self-service portal: personal records, attendance, leaves, and helpdesk'],
    };
    const modules = { dashboard:['view','view_analytics'], profile:['view','edit'], employees:['view','add','edit','delete','view_sensitive'], departments:['view','manage'], attendance:['view','regularize'], leaves:['view','apply','approve_reject'], onboarding:['view','upload_docs','verify_kyc'], ats:['view'], exits:['view','submit_resignation','clearance_settlement'], training:['view','edit'], notices:['view','post_notice','send_kudos'], helpdesk:['view','submit_ticket','resolve_ticket'], audit:['view'], permissions:['view','create_role','edit_permissions','delete_role','manage_resources','view_trash','restore_trash'] };
    for (const role of roles) {
      const [roleName, roleDesc] = roleMeta[role] || [role, 'System role'];
      await client.query('INSERT INTO roles(id,name,description,is_system) VALUES($1,$2,$3,true) ON CONFLICT(id) DO NOTHING',[role,roleName,roleDesc]);
      for (const [module,actions] of Object.entries(modules)) for (const action of actions) {
        const basic = (module==='profile' && ['view','edit'].includes(action)) || (['view','apply','upload_docs','submit_resignation','submit_ticket','send_kudos'].includes(action) && !['audit','permissions','departments'].includes(module));
        const allowed = ['super_admin','admin'].includes(role) || (role==='hr' && module!=='permissions') || (['manager','head'].includes(role) && (['attendance','leaves'].includes(module) || (module==='departments' && action==='view'))) || basic;
        await client.query('INSERT INTO role_permissions(role_id,module,action,allowed) VALUES($1,$2,$3,$4) ON CONFLICT(role_id,module,action) DO NOTHING',[role,module,action,allowed]);
      }
    }
    const atsRoles = ['ceo','exec_sponsor','rec_lead','rec_associate','hiring_manager','external_agency','employee'];
    const atsRoleNames = { exec_sponsor: 'Admin (older role)', external_agency: 'Agency (older role)', employee: 'Employee' };
    for (const role of atsRoles) {
      await client.query('INSERT INTO ats_roles(id,name,description,is_system) VALUES($1,$2,$3,true) ON CONFLICT(id) DO NOTHING',[role,atsRoleNames[role] || role,'System recruitment role']);
      const defaults = defaultPermissions(role);
      for (const action of ATS_ACTIONS) {
        await client.query('INSERT INTO ats_role_permissions(role_id,module,action,allowed) VALUES($1,$2,$3,$4) ON CONFLICT(role_id,module,action) DO NOTHING',[role,moduleOfAction(action),action,defaults[action]]);
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  migrate().then(()=>console.log('Migrations complete. No demo records inserted.')).catch(error=>{console.error('Migration failed:',error.message);process.exitCode=1;}).finally(()=>rawPool.end());
}
