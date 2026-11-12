// Chooses the HR Assistant who owns a new candidate.
import { pool } from './db.js';

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Order: the job's own owner, then a job assignment, then a role assignment, then a department assignment.
// Within one level a primary owner wins, then whoever has the fewest active candidates.
// Returns null when nobody is eligible, which puts the candidate in the Unassigned queue.
export function pickOwner(job, recruiters, assignments) {
  const active = new Map(recruiters.map(recruiter => [recruiter.id, recruiter]));
  for (const id of [job.assigned_recruiter_id, job.backup_recruiter_id]) {
    if (id && active.has(id)) return active.get(id);
  }

  const levels = [
    a => a.kind === 'job' && job.id != null && a.job_id === job.id,
    a => a.kind === 'role' && sameText(a.target, job.role),
    a => a.kind === 'department' && sameText(a.target, job.department)
  ];
  for (const matches of levels) {
    const eligible = assignments
      .filter(a => matches(a) && active.get(a.recruiter_id)?.ats_role === 'rec_associate')
      .map(a => ({ recruiter: active.get(a.recruiter_id), isPrimary: a.is_primary === true }));
    if (eligible.length === 0) continue;
    eligible.sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary)
      || (x.recruiter.load || 0) - (y.recruiter.load || 0)
      || String(x.recruiter.id).localeCompare(String(y.recruiter.id)));
    return eligible[0].recruiter;
  }
  return null;
}

export async function loadOwnerResolver() {
  const team = await pool.query("SELECT id, name, ats_role FROM recruitment_team WHERE status = 'Active' AND has_ats_access IS NOT FALSE");
  if (team.rowCount === 0) return () => null;
  const [loads, assignments] = await Promise.all([
    pool.query("SELECT assigned_recruiter_id AS id, COUNT(*)::int AS n FROM applicants WHERE stage NOT IN ('Rejected', 'Approved') AND assigned_recruiter_id IS NOT NULL GROUP BY 1"),
    pool.query('SELECT recruiter_id, kind, job_id, target, is_primary FROM recruiter_assignments')
  ]);
  const loadOf = new Map(loads.rows.map(row => [row.id, row.n]));
  const recruiters = team.rows.map(row => ({ ...row, load: loadOf.get(row.id) || 0 }));
  return job => {
    const owner = pickOwner(job, recruiters, assignments.rows);
    if (owner) owner.load += 1;
    return owner;
  };
}

export async function resolveOwner(job) {
  const pick = await loadOwnerResolver();
  return pick(job);
}
