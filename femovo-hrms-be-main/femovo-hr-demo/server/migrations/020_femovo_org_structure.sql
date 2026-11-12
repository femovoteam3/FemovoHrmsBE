-- FEMOVO Department Structure, Designations & Reporting Hierarchy (no dummy employees)

ALTER TABLE departments ADD COLUMN IF NOT EXISTS head_employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS hierarchy_order INT DEFAULT 0;

ALTER TABLE company_masters ADD COLUMN IF NOT EXISTS department VARCHAR(100);
ALTER TABLE company_masters ADD COLUMN IF NOT EXISTS hierarchy_level VARCHAR(50);
ALTER TABLE company_masters ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0;

-- Reuse the 9 existing department rows by normalizing names, descriptions, and canonical ordering.
DO $$
DECLARE
  mapping RECORD;
BEGIN
  FOR mapping IN
    SELECT * FROM (VALUES
      ('Executive Leadership',           'Executive Leadership',                  'EXEC',     'CEO, Directors, and Executive Assistant leadership oversight', 1),
      ('Finance',                        'Finance & Accounts',                    'FIN',      'Financial planning, accounting, statutory compliance, and payroll operations', 2),
      ('Human Resources & People Ops',   'Human Resources & People Operations',   'HR',       'People operations, HR execution, talent recruitment, and compliance', 3),
      ('Growth & Digital Marketing',     'Growth & Digital Marketing',            'MKTG',     'Performance marketing, social media, creative design, video, and content growth', 4),
      ('Sales & Wellness Operations',    'Sales & Customer Support',              'SALES',    'Sales leadership, customer support leadership, team leaders, and CSA operations', 5),
      ('Wellness & Clinical Delivery',   'Wellness & Trainer Operations',         'WELLNESS', 'Wellness leadership, trainer coordination, Yoga/Zumba/Face Yoga, and nutrition', 6),
      ('Technology',                     'Technology & Product',                  'TECH',     'Engineering, mobile/web app development, UI/UX design, and technical support', 7),
      ('Medical & Diagnostic Ops',       'Medical & Diagnostics',                 'DIAG',     'Medical operations, diagnostics coordination, lab technicians, and healthcare support', 8),
      ('General Operations',             'General Operations & Administration',   'OPS',      'General operations, office administration, vendor coordination, and facilities', 9)
    ) AS t(old_name, new_name, code, descr, ord)
  LOOP
    -- Rename if old_name exists and new_name does not already exist separately
    IF EXISTS (SELECT 1 FROM departments WHERE name = mapping.old_name)
       AND NOT EXISTS (SELECT 1 FROM departments WHERE name = mapping.new_name AND name <> mapping.old_name) THEN
      UPDATE departments
      SET name = mapping.new_name,
          code = mapping.code,
          description = mapping.descr,
          hierarchy_order = mapping.ord
      WHERE name = mapping.old_name;
    ELSE
      INSERT INTO departments (name, code, description, hierarchy_order)
      VALUES (mapping.new_name, mapping.code, mapping.descr, mapping.ord)
      ON CONFLICT (name) DO UPDATE SET
        code = EXCLUDED.code,
        description = EXCLUDED.description,
        hierarchy_order = EXCLUDED.hierarchy_order;
    END IF;

    -- Keep text department references synchronized where an old canonical department name was renamed
    IF mapping.old_name <> mapping.new_name THEN
      UPDATE employees SET department = mapping.new_name WHERE department = mapping.old_name;
      UPDATE user_accounts SET department = mapping.new_name WHERE department = mapping.old_name;
      UPDATE recruitment_team SET department = mapping.new_name WHERE department = mapping.old_name;
      UPDATE job_requisitions SET department = mapping.new_name WHERE department = mapping.old_name;
      UPDATE applicants SET department = mapping.new_name WHERE department = mapping.old_name;
      DELETE FROM company_masters WHERE type = 'department' AND name = mapping.old_name;
    END IF;

    INSERT INTO company_masters (type, name, code, description, department, hierarchy_level, sort_order)
    VALUES ('department', mapping.new_name, mapping.code, mapping.descr, mapping.new_name, 'Department', mapping.ord)
    ON CONFLICT (type, name) DO UPDATE SET
      code = EXCLUDED.code,
      description = EXCLUDED.description,
      department = EXCLUDED.department,
      hierarchy_level = EXCLUDED.hierarchy_level,
      sort_order = EXCLUDED.sort_order;
  END LOOP;
END $$;

-- Replace legacy placeholder/role-mixed designations with clean FEMOVO job designations
-- mapped to departments and hierarchy tiers (Leadership -> Department Head -> Team Lead -> Employee/Trainer).
DELETE FROM company_masters
WHERE type = 'designation'
  AND name IN (
    'Super Admin',
    'Head HR & Talent Acquisition Lead',
    'Senior Talent Partner',
    'Lead Wellness Consultant',
    'Therapeutic Yoga Specialist',
    'Diagnostic Operations Coordinator',
    'Full Stack Software Engineer',
    'Finance & Compliance Manager',
    'Customer Support Associate',
    'Medical Officer',
    'Growth & Digital Marketing Lead',
    'Wellness Trainer'
  );

INSERT INTO company_masters (type, name, code, description, department, hierarchy_level, sort_order)
VALUES
  -- 1. Executive Leadership
  ('designation', 'CEO',                              'EXEC-CEO',    'Chief Executive Officer',                                   'Executive Leadership',                 'Leadership',      1),
  ('designation', 'Directors',                        'EXEC-DIR',    'Company Director / Executive Board Leadership',             'Executive Leadership',                 'Leadership',      2),
  ('designation', 'Executive Assistant',              'EXEC-EA',     'Executive Assistant to Leadership',                         'Executive Leadership',                 'Employee',        3),

  -- 2. Finance & Accounts
  ('designation', 'Finance Head',                     'FIN-HEAD',    'Head of Finance & Accounts',                                'Finance & Accounts',                   'Department Head', 10),
  ('designation', 'Accountant',                       'FIN-ACC',     'Chartered Accountant / Accounting Specialist',              'Finance & Accounts',                   'Employee',        11),
  ('designation', 'Payroll Executive',                'FIN-PAY',     'Payroll processing and statutory deductions specialist',    'Finance & Accounts',                   'Employee',        12),

  -- 3. Human Resources & People Operations
  ('designation', 'HR Head',                          'HR-HEAD',     'Head of Human Resources & People Operations',               'Human Resources & People Operations',  'Department Head', 20),
  ('designation', 'HR Executive',                     'HR-EXEC',     'Human Resources operations and employee relations executive', 'Human Resources & People Operations',  'Employee',        21),
  ('designation', 'Recruitment Executive',            'HR-REC',      'Talent acquisition and hiring executive',                   'Human Resources & People Operations',  'Employee',        22),
  ('designation', 'HR Assistant',                     'HR-ASST',     'People operations coordinator and HR assistant',            'Human Resources & People Operations',  'Employee',        23),

  -- 4. Growth & Digital Marketing
  ('designation', 'Marketing Head',                   'MKTG-HEAD',   'Head of Growth & Digital Marketing',                        'Growth & Digital Marketing',           'Department Head', 30),
  ('designation', 'Performance Marketer',             'MKTG-PM',     'Paid acquisition and campaign performance marketer',        'Growth & Digital Marketing',           'Employee',        31),
  ('designation', 'Social Media Manager',             'MKTG-SMM',    'Social media strategy and channel manager',                 'Growth & Digital Marketing',           'Employee',        32),
  ('designation', 'Graphic Designer',                 'MKTG-GD',     'Brand and campaign graphic designer',                       'Growth & Digital Marketing',           'Employee',        33),
  ('designation', 'Video Editor',                     'MKTG-VE',     'Video production and post-editing specialist',              'Growth & Digital Marketing',           'Employee',        34),
  ('designation', 'Content Creator',                  'MKTG-CC',     'Digital content and copy creator',                          'Growth & Digital Marketing',           'Employee',        35),

  -- 5. Sales & Customer Support
  ('designation', 'Sales Head',                       'SALES-HEAD',  'Head of Sales Operations',                                  'Sales & Customer Support',             'Department Head', 40),
  ('designation', 'Customer Support Head',            'CS-HEAD',     'Head of Customer Support Operations',                       'Sales & Customer Support',             'Department Head', 41),
  ('designation', 'Team Leader',                      'SALES-TL',    'Sales and Customer Support Team Leader',                    'Sales & Customer Support',             'Team Lead',       42),
  ('designation', 'Customer Support Executive (CSA)', 'CSA-EXEC',    'Customer Support & Sales Associate',                        'Sales & Customer Support',             'Employee',        43),

  -- 6. Wellness & Trainer Operations
  ('designation', 'Wellness Head',                    'WELL-HEAD',   'Head of Wellness & Trainer Operations',                     'Wellness & Trainer Operations',        'Department Head', 50),
  ('designation', 'Trainer Coordinator',              'WELL-COORD',  'Batch scheduling and trainer operations coordinator',       'Wellness & Trainer Operations',        'Team Lead',       51),
  ('designation', 'Yoga Trainer',                     'TR-YOGA',     'Session-based or scheduled Yoga Instructor',                'Wellness & Trainer Operations',        'Trainer',         52),
  ('designation', 'Zumba Trainer',                    'TR-ZUMBA',    'Session-based or scheduled Zumba Instructor',               'Wellness & Trainer Operations',        'Trainer',         53),
  ('designation', 'Face Yoga Trainer',                'TR-FACE',     'Session-based or scheduled Face Yoga Instructor',           'Wellness & Trainer Operations',        'Trainer',         54),
  ('designation', 'Dietitian / Nutritionist',         'WELL-DIET',   'Clinical nutrition and dietary consultation specialist',    'Wellness & Trainer Operations',        'Trainer',         55),

  -- 7. Technology & Product
  ('designation', 'Technology Head',                  'TECH-HEAD',   'Head of Technology & Product Engineering',                  'Technology & Product',                 'Department Head', 60),
  ('designation', 'Frontend Developer',               'TECH-FE',     'Web frontend application developer',                        'Technology & Product',                 'Employee',        61),
  ('designation', 'Backend Developer',                'TECH-BE',     'API, services, and database backend developer',             'Technology & Product',                 'Employee',        62),
  ('designation', 'App Developer',                    'TECH-APP',    'Mobile application developer',                              'Technology & Product',                 'Employee',        63),
  ('designation', 'UI/UX Designer',                   'TECH-UIUX',   'Product interface and experience designer',                 'Technology & Product',                 'Employee',        64),
  ('designation', 'Technical Support',                'TECH-SUP',    'Application and technical systems support specialist',      'Technology & Product',                 'Employee',        65),

  -- 8. Medical & Diagnostics
  ('designation', 'Medical Operations Head',          'DIAG-HEAD',   'Head of Medical & Diagnostic Operations',                   'Medical & Diagnostics',                'Department Head', 70),
  ('designation', 'Diagnostics Coordinator',          'DIAG-COORD',  'Diagnostics workflow and sample logistics coordinator',     'Medical & Diagnostics',                'Team Lead',       71),
  ('designation', 'Lab Technician',                   'DIAG-LAB',    'Pathology and diagnostic laboratory technician',            'Medical & Diagnostics',                'Employee',        72),
  ('designation', 'Healthcare Support Executive',     'DIAG-CARE',   'Patient and healthcare operations support executive',       'Medical & Diagnostics',                'Employee',        73),

  -- 9. General Operations & Administration
  ('designation', 'Operations Head',                  'OPS-HEAD',    'Head of General Operations & Administration',               'General Operations & Administration',  'Department Head', 80),
  ('designation', 'Operations Executive',             'OPS-EXEC',    'General operations and logistics executive',                'General Operations & Administration',  'Employee',        81),
  ('designation', 'Admin Executive',                  'OPS-ADMIN',   'Office administration and facility executive',              'General Operations & Administration',  'Employee',        82)
ON CONFLICT (type, name) DO UPDATE SET
  code = EXCLUDED.code,
  description = EXCLUDED.description,
  department = EXCLUDED.department,
  hierarchy_level = EXCLUDED.hierarchy_level,
  sort_order = EXCLUDED.sort_order;

