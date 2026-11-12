// Every recruitment permission. Each one is checked on the server, so a switch on the
// ATS Roles page always changes what a person can really do.
export const ATS_MODULES = [
  {
    id: 'candidate_lifecycle',
    name: 'Candidates',
    description: 'Who can see, add, change and remove candidate records.',
    icon: '🛡️',
    actions: [
      { id: 'view_candidates', name: 'See candidates', desc: 'Open candidate records they are allowed to see' },
      { id: 'create_candidates', name: 'Add candidates', desc: 'Add a candidate by form or CSV import' },
      { id: 'edit_candidates', name: 'Edit candidates', desc: 'Change candidate details and move them between stages' },
      { id: 'delete_candidates', name: 'Delete candidates', desc: 'Permanently remove a candidate record' },
      { id: 'assign_candidates', name: 'Reassign candidates', desc: 'Give a candidate to another HR Assistant' },
      { id: 'submit_feedback', name: 'Give interview feedback', desc: 'Fill a scorecard for an interview assigned to them' },
      { id: 'view_all_candidates', name: 'See all candidates', desc: 'See every candidate, not only their own' },
      { id: 'export_candidates', name: 'Export candidates', desc: 'Download the candidate list as CSV' }
    ]
  },
  {
    id: 'workflow',
    name: 'Interview rounds and approvals',
    description: 'Who runs each round and who gives the final decision.',
    icon: '🗓️',
    actions: [
      { id: 'screen_candidates', name: 'Telephone screening', desc: 'Log the screening call and move candidates from New to HR L1' },
      { id: 'run_hr_l1', name: 'HR L1 interview', desc: 'Schedule and score the HR L1 interview and forward the candidate' },
      { id: 'run_additional_interview', name: 'Additional interview', desc: 'Take an extra interview round when assigned' },
      { id: 'run_head_hr_round', name: 'Head HR round', desc: 'Schedule and score the Head HR interview' },
      { id: 'request_additional_interview', name: 'Assign additional interviewer', desc: 'Add an extra interview round for a candidate' },
      { id: 'recommend_to_ceo', name: 'Recommend to CEO', desc: 'Send a candidate for CEO approval' },
      { id: 'final_approval', name: 'Final approval', desc: 'Approve, reject or send back a candidate as CEO' }
    ]
  },
  {
    id: 'jobs',
    name: 'Jobs',
    description: 'Who can open, change and publish job openings.',
    icon: '💼',
    actions: [
      { id: 'create_jobs', name: 'Create jobs', desc: 'Open a new job' },
      { id: 'edit_jobs', name: 'Edit jobs', desc: 'Change or delete a job' },
      { id: 'publish_jobs', name: 'Publish jobs', desc: 'Show or hide a job on the public career portal' }
    ]
  },
  {
    id: 'offers',
    name: 'Offers',
    description: 'Who can see salaries and issue offer letters.',
    icon: '📜',
    actions: [
      { id: 'view_salary', name: 'See salary details', desc: 'See proposed salary and offer amounts' },
      { id: 'issue_offers', name: 'Issue offers', desc: 'Create an offer and record whether it was accepted' },
      { id: 'onboard_to_ems', name: 'Onboard to EMS', desc: 'Turn a candidate with an accepted offer into an employee' }
    ]
  },
  {
    id: 'team',
    name: 'Team and access',
    description: 'Who can manage recruitment users and these permissions.',
    icon: '👥',
    actions: [
      { id: 'manage_ats_users', name: 'Manage recruitment users', desc: 'Add, edit and deactivate HR Assistants and Interviewers' },
      { id: 'assign_recruiters', name: 'Set HR Assistant assignments', desc: 'Choose which departments, roles and jobs each HR Assistant handles' },
      { id: 'configure_permissions', name: 'Change permissions', desc: 'Change the switches on this page' }
    ]
  }
];

export const ATS_ACTIONS = ATS_MODULES.flatMap(module => module.actions.map(action => action.id));
export const moduleOfAction = action => ATS_MODULES.find(module => module.actions.some(a => a.id === action))?.id ?? null;

// The business roles, highest first. `exec_sponsor` is the older "Admin" role some accounts still have.
export const ATS_ROLES = [
  { id: 'ceo', name: 'CEO', rank: 3, description: 'Sees all recruitment and gives the final approval.' },
  { id: 'rec_lead', name: 'Head HR', rank: 2, description: 'Runs recruitment, takes the Head HR round and issues offers.' },
  { id: 'rec_associate', name: 'HR Assistant', rank: 1, description: 'Screens and interviews the candidates assigned to them.' },
  { id: 'hiring_manager', name: 'Interviewer', rank: 1, description: 'Takes interviews assigned to them and gives feedback.' }
];
export const roleRank = role => (role === 'exec_sponsor' ? 3 : ATS_ROLES.find(r => r.id === role)?.rank ?? 0);

const except = excluded => ATS_ACTIONS.filter(action => !excluded.includes(action));
const ROLE_DEFAULTS = {
  ceo: except(['issue_offers', 'onboard_to_ems']),
  exec_sponsor: ATS_ACTIONS,
  rec_lead: except(['final_approval', 'configure_permissions', 'manage_ats_users']),
  rec_associate: ['view_candidates', 'create_candidates', 'edit_candidates', 'submit_feedback', 'screen_candidates', 'run_hr_l1', 'run_additional_interview'],
  hiring_manager: ['view_candidates', 'submit_feedback', 'run_additional_interview']
};

// What a role may do before any switch is changed.
export function defaultPermissions(atsRole) {
  const allowed = ROLE_DEFAULTS[atsRole] || [];
  return Object.fromEntries(ATS_ACTIONS.map(action => [action, allowed.includes(action)]));
}
