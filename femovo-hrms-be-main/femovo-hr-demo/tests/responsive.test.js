import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = path.resolve(__dirname, '../client/src');

function readClientFile(relPath) {
  return fs.readFileSync(path.join(clientSrc, relPath), 'utf8');
}

test('index.css defines responsive layout grids, toolbars, breakpoints, and touch targets', () => {
  const css = readClientFile('index.css');

  for (const selector of [
    '.form-grid-2',
    '.form-grid-3',
    '.form-grid-split',
    '.filter-toolbar',
    '.filter-control',
    '.stepper-scroll',
    '.kanban-scroll-strip',
    '.kanban-stage-jumps',
    '.table-scroll-hint',
  ]) {
    assert.ok(css.includes(selector), `Expected ${selector} in client/src/index.css`);
  }

  for (const bp of [
    '@media (max-width: 1024px)',
    '@media (max-width: 960px)',
    '@media (max-width: 900px)',
    '@media (max-width: 768px)',
    '@media (max-width: 540px)',
  ]) {
    assert.ok(css.includes(bp), `Expected breakpoint ${bp} in client/src/index.css`);
  }

  assert.match(css, /min-height:\s*44px/, 'Mobile interactive buttons and nav items should meet 44px touch height');
  assert.match(css, /font-size:\s*16px/, 'Mobile inputs should enforce 16px to avoid iOS zoom');
  assert.match(css, /\.suite-indicator-pill\s*\{[^}]*white-space:\s*nowrap/s, 'Suite indicator pill must not wrap vertically on narrow topbars');
  assert.match(css, /@media\s*\(max-width:\s*640px\)/, 'Compact mobile breakpoint wraps topbar actions into clean row without overlapping breadcrumbs');
  assert.ok(css.includes('.notification-popover'), 'Expected .notification-popover responsive dropdown class in index.css');
});

test('forms and modals avoid hardcoded non-wrapping 1fr 1fr grids', () => {
  const checkedComponents = [
    'components/AddEmployeePage.jsx',
    'components/EditEmployeePage.jsx',
    'components/AttendanceView.jsx',
    'components/CandidateDossierModal.jsx',
    'components/CareersApplyModal.jsx',
    'components/CreateRequisitionModal.jsx',
    'components/DepartmentManagementModal.jsx',
    'components/RoleManagementModal.jsx',
    'components/InterviewModal.jsx',
    'components/LeaveView.jsx',
    'components/Modals.jsx',
    'components/OnboardingWizardModal.jsx',
    'components/ResourceManagerView.jsx',
  ];

  for (const comp of checkedComponents) {
    const src = readClientFile(comp);
    assert.equal(
      src.includes("gridTemplateColumns: '1fr 1fr'"),
      false,
      `${comp} should use responsive .form-grid-2 instead of hardcoded 1fr 1fr`,
    );
    assert.equal(
      src.includes("gridColumn: 'span 2'"),
      false,
      `${comp} should use gridColumn: '1 / -1' rather than 'span 2'`,
    );
  }
});

test('navigation, header, and access fallback provide mobile & clear-access UX', () => {
  const sidebar = readClientFile('components/Sidebar.jsx');
  assert.ok(sidebar.includes('mobile-sidebar-close'));
  assert.ok(sidebar.includes('sidebar-footer'));
  assert.ok(sidebar.includes('aria-current='));

  const header = readClientFile('components/Header.jsx');
  assert.ok(header.includes('mobile-menu-btn'));
  assert.ok(header.includes('Open navigation menu'));

  const app = readClientFile('App.jsx');
  assert.ok(app.includes('Go to My Home'));

  const board = readClientFile('components/CandidateBoard.jsx');
  assert.ok(board.includes('kanban-stage-jumps'));
  assert.ok(board.includes('All Stages'));

  const permissions = readClientFile('components/PermissionsView.jsx');
  assert.ok(permissions.includes('SYSTEM_ROLE_DISPLAY'));
  assert.ok(permissions.includes("memberCount === 1 ? 'user' : 'users'"));
  assert.ok(permissions.includes('Rename Role Title'));
  assert.ok(permissions.includes('Confirm Delete'));
  assert.ok(permissions.includes('canCreateRole'));
  assert.ok(permissions.includes('canDeleteRole'));
  assert.equal(permissions.includes("padding: '1.25rem 2rem'"), false);

  const routes = readClientFile('utils/routes.js');
  assert.ok(routes.includes("profile: '/my-profile'"));
  assert.ok(routes.includes("'profile-edit': '/my-profile/edit'"));
  assert.ok(routes.includes("departments: '/departments'"));
  assert.ok(sidebar.includes("label: 'My Profile'"));
  assert.ok(sidebar.includes("label: 'Departments'"));
  assert.ok(app.includes("onOpenProfile={() => navigateRoute('profile')}"));
  const empView = readClientFile('components/EmployeesView.jsx');
  assert.equal(empView.includes('Manage Departments'), false);
  const myProfile = readClientFile('components/MyProfilePage.jsx');
  assert.ok(myProfile.includes('Security & Password'));
  assert.equal(myProfile.includes('My Role & Access'), false);
  assert.equal(myProfile.includes('onOpenOnboardingWizard'), false);
  const editMyProfile = readClientFile('components/EditMyProfilePage.jsx');
  assert.ok(editMyProfile.includes('Edit Personal, Banking &amp; KYC'));
  assert.ok(editMyProfile.includes('form-grid-2'));
  const depts = readClientFile('components/DepartmentsView.jsx');
  assert.ok(depts.includes('Company Departments'));
  assert.ok(depts.includes('split-master-detail'));
  const serverIndex = fs.readFileSync(path.resolve(__dirname, '../server/index.js'), 'utf8');
  assert.ok(serverIndex.includes("COALESCE(status, 'Active') NOT IN ('Inactive', 'Exited', 'Terminated')"));
  assert.ok(serverIndex.includes("COALESCE(e.status, 'Active') NOT IN ('Inactive', 'Exited', 'Terminated')"));
  assert.ok(serverIndex.includes("session_version = session_version + 1"));
  assert.ok(serverIndex.includes("const CORE_PROTECTED_ROLES = ['super_admin', 'employee']"));
  const permsView = readClientFile('components/PermissionsView.jsx');
  assert.ok(permsView.includes("const CORE_PROTECTED_ROLE_IDS = ['super_admin', 'employee']"));
  assert.ok(permsView.includes('isRoleDeletable(r)'));
  for (const roleForm of ['components/AddEmployeePage.jsx', 'components/EditEmployeePage.jsx', 'components/Modals.jsx']) {
    const src = readClientFile(roleForm);
    assert.equal(src.includes('{r.name} ({r.code})'), false);
  }
  assert.ok(routes.includes("trash: '/trash'"));
  assert.equal(sidebar.includes("label: 'Trash'"), false);
  assert.ok(sidebar.includes("trash: 'resources'"));
  const trashView = readClientFile('components/TrashView.jsx');
  assert.ok(trashView.includes('Trash &amp; Deactivated Profiles'));
  assert.ok(trashView.includes('Activate Profile:'));
  assert.ok(serverIndex.includes('async function moveEmployeeToTrash'));
  assert.ok(serverIndex.includes("app.get('/api/resources/trash'"));
  assert.ok(serverIndex.includes("app.post('/api/resources/:id/restore'"));
  assert.ok(serverIndex.includes("id: 'profile'"));
  assert.ok(serverIndex.includes("id: 'departments'"));
  assert.ok(serverIndex.includes("id: 'view_trash'"));
  assert.ok(serverIndex.includes("id: 'restore_trash'"));
  assert.ok(serverIndex.includes("id: 'manage_resources'"));
});

