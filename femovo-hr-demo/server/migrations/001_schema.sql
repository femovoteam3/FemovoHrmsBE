-- Existing schema only; no demo data or account rewrites.
CREATE TABLE IF NOT EXISTS company_masters (
        id SERIAL PRIMARY KEY,
        type VARCHAR(50) NOT NULL, -- 'department', 'role', 'designation'
        name VARCHAR(100) NOT NULL,
        code VARCHAR(50),
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(type, name)
      );

CREATE TABLE IF NOT EXISTS departments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        code VARCHAR(50),
        description TEXT,
        head_of_department VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS employees (
        id VARCHAR(20) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        department VARCHAR(100) NOT NULL,
        role VARCHAR(100) NOT NULL,
        manager VARCHAR(100),
        status VARCHAR(30) DEFAULT 'Confirmed',
        attendance VARCHAR(30) DEFAULT 'Present',
        email VARCHAR(100),
        phone VARCHAR(20),
        access_role VARCHAR(50) DEFAULT 'employee',
        promo_code VARCHAR(100),
        has_dashboard_access BOOLEAN DEFAULT TRUE,
        user_type VARCHAR(50) DEFAULT 'Staff',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

ALTER TABLE employees ADD COLUMN IF NOT EXISTS email VARCHAR(100);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS access_role VARCHAR(50) DEFAULT 'employee';

ALTER TABLE employees ADD COLUMN IF NOT EXISTS promo_code VARCHAR(100);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS has_dashboard_access BOOLEAN DEFAULT TRUE;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_type VARCHAR(50) DEFAULT 'Staff';

ALTER TABLE employees ADD COLUMN IF NOT EXISTS manager_id VARCHAR(50);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS designation VARCHAR(100);

ALTER TABLE employees ADD COLUMN IF NOT EXISTS joining_date DATE DEFAULT CURRENT_DATE;

ALTER TABLE employees ALTER COLUMN manager DROP NOT NULL;

CREATE TABLE IF NOT EXISTS leaves (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'Pending',
        is_half_day BOOLEAN DEFAULT FALSE,
        half_day_session VARCHAR(20),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

ALTER TABLE leaves ADD COLUMN IF NOT EXISTS is_half_day BOOLEAN DEFAULT FALSE;

ALTER TABLE leaves ADD COLUMN IF NOT EXISTS half_day_session VARCHAR(20);

CREATE TABLE IF NOT EXISTS applicants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        job VARCHAR(100) NOT NULL,
        stage VARCHAR(50) DEFAULT 'Application',
        interview_date TIMESTAMP WITH TIME ZONE,
        interviewer VARCHAR(100),
        meet_link TEXT,
        rating INT DEFAULT 0,
        scorecard_notes TEXT,
        email VARCHAR(100),
        phone VARCHAR(20),
        experience VARCHAR(50),
        expected_ctc VARCHAR(50),
        notice_period VARCHAR(50),
        rejection_reason TEXT,
        resume_name VARCHAR(100),
        resume_url TEXT,
        current_ctc VARCHAR(50),
        source VARCHAR(50) DEFAULT 'Direct Application',
        department VARCHAR(100),
        assigned_recruiter_id VARCHAR(50),
        assigned_recruiter_name VARCHAR(100),
        submitted_by_user_id VARCHAR(50),
        interviewer_id VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS submitted_by_user_id VARCHAR(50);

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS interviewer_id VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_applicants_assigned_recruiter ON applicants(assigned_recruiter_id);

CREATE INDEX IF NOT EXISTS idx_applicants_submitted_by ON applicants(submitted_by_user_id);

CREATE INDEX IF NOT EXISTS idx_applicants_interviewer_id ON applicants(interviewer_id);

CREATE INDEX IF NOT EXISTS idx_applicants_stage ON applicants(stage);

CREATE INDEX IF NOT EXISTS idx_applicants_dept ON applicants(department);

CREATE TABLE IF NOT EXISTS onboarding (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20) UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
        items BOOLEAN[] DEFAULT '{false,false,false,false,false}'
      );

CREATE TABLE IF NOT EXISTS training (
        id SERIAL PRIMARY KEY,
        title VARCHAR(150) NOT NULL,
        department VARCHAR(100) NOT NULL,
        description TEXT,
        lessons TEXT[],
        complete BOOLEAN DEFAULT FALSE
      );

CREATE TABLE IF NOT EXISTS metrics (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        target VARCHAR(50) NOT NULL,
        current VARCHAR(50) NOT NULL,
        progress INTEGER NOT NULL,
        note TEXT
      );

CREATE TABLE IF NOT EXISTS performance_reviews (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20),
        reviewer_name VARCHAR(100) DEFAULT 'rushikesh (Super Admin)',
        rating INT DEFAULT 5,
        empathy_score INT DEFAULT 5,
        conversion_score INT DEFAULT 5,
        punctuality_score INT DEFAULT 5,
        recommendation VARCHAR(50) DEFAULT 'Exceeds Expectations',
        okr_goal TEXT DEFAULT 'Deliver core departmental targets and key objectives',
        okr_progress INT DEFAULT 100,
        notes TEXT NOT NULL,
        reviewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS csa_metrics (
        id SERIAL PRIMARY KEY,
        date DATE DEFAULT CURRENT_DATE,
        employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE CASCADE,
        leads INT DEFAULT 0,
        followups INT DEFAULT 0,
        payments INT DEFAULT 0,
        sales INT DEFAULT 0,
        app_queries INT DEFAULT 0,
        client_issues INT DEFAULT 0
      );

CREATE TABLE IF NOT EXISTS employee_documents (
        employee_id VARCHAR(20) PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        aadhaar VARCHAR(30) DEFAULT 'Pending',
        pan VARCHAR(30) DEFAULT 'Pending',
        bank_details VARCHAR(30) DEFAULT 'Pending',
        offer_letter VARCHAR(30) DEFAULT 'Verified'
      );

CREATE TABLE IF NOT EXISTS exits (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20),
        employee_name TEXT NOT NULL,
        department TEXT NOT NULL,
        designation VARCHAR(100) DEFAULT 'Executive',
        joining_date DATE,
        resignation_date DATE NOT NULL,
        last_working_date DATE NOT NULL,
        reason TEXT,
        handover BOOLEAN DEFAULT FALSE,
        assets BOOLEAN DEFAULT FALSE,
        access_removal BOOLEAN DEFAULT FALSE,
        settlement BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'In Progress',
        exit_interview_feedback TEXT,
        rating INT DEFAULT 5,
        eligible_for_rehire BOOLEAN DEFAULT TRUE,
        relieving_letter_issued BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS salaries (
        employee_id VARCHAR(20) PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        basic NUMERIC(10,2) NOT NULL DEFAULT 25000,
        hra NUMERIC(10,2) NOT NULL DEFAULT 10000,
        allowances NUMERIC(10,2) NOT NULL DEFAULT 10000,
        deductions NUMERIC(10,2) NOT NULL DEFAULT 5000,
        net_salary NUMERIC(10,2) NOT NULL DEFAULT 40000,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS payroll_runs (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE CASCADE,
        month VARCHAR(20) NOT NULL,
        year INT NOT NULL,
        basic NUMERIC(10,2) NOT NULL,
        hra NUMERIC(10,2) NOT NULL,
        allowances NUMERIC(10,2) NOT NULL,
        gross_pay NUMERIC(10,2) NOT NULL,
        deductions NUMERIC(10,2) NOT NULL,
        net_pay NUMERIC(10,2) NOT NULL,
        days_present INT DEFAULT 26,
        status VARCHAR(20) DEFAULT 'Paid',
        processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'General',
        posted_by VARCHAR(100) DEFAULT 'Super Admin',
        reactions JSONB DEFAULT '{"thumbs": 0, "heart": 0, "celebrate": 0}',
        acknowledgements JSONB DEFAULT '[]',
        pinned BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS leave_balances (
        employee_id VARCHAR(20) PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        cl_balance INT DEFAULT 8,
        sl_balance INT DEFAULT 6,
        pl_balance INT DEFAULT 12,
        wellness_balance INT DEFAULT 6
      );

CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        actor_name VARCHAR(100) NOT NULL,
        action VARCHAR(100) NOT NULL,
        details TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS employee_personal_details (
        employee_id VARCHAR(20) PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        dob DATE,
        gender VARCHAR(20),
        blood_group VARCHAR(10),
        marital_status VARCHAR(20),
        personal_email VARCHAR(100),
        phone VARCHAR(20),
        emergency_contact_name VARCHAR(100),
        emergency_contact_phone VARCHAR(20),
        emergency_contact_relation VARCHAR(50),
        current_address TEXT,
        permanent_address TEXT,
        pan_number VARCHAR(20),
        aadhaar_number VARCHAR(20),
        bank_name VARCHAR(100),
        bank_account_no VARCHAR(50),
        bank_ifsc VARCHAR(30),
        bank_account_holder VARCHAR(100),
        uan_number VARCHAR(30),
        onboarding_submitted BOOLEAN DEFAULT FALSE,
        submitted_at TIMESTAMP WITH TIME ZONE,
        hr_verified BOOLEAN DEFAULT FALSE,
        hr_verified_at TIMESTAMP WITH TIME ZONE,
        hr_verified_by VARCHAR(100),
        hr_notes TEXT
      );

CREATE TABLE IF NOT EXISTS employee_uploaded_documents (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE CASCADE,
        doc_type VARCHAR(50) NOT NULL,
        file_name TEXT NOT NULL,
        file_url TEXT NOT NULL,
        file_size INT,
        file_mime TEXT,
        status VARCHAR(30) DEFAULT 'Under Review',
        rejection_reason TEXT,
        verified_by VARCHAR(100),
        verified_at TIMESTAMP WITH TIME ZONE,
        verification_badge VARCHAR(50),
        verification_notes TEXT,
        uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS attendance_records (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        status VARCHAR(30) DEFAULT 'Present',
        clock_in VARCHAR(20),
        clock_out VARCHAR(20),
        work_duration_minutes INT DEFAULT 540,
        work_location VARCHAR(50) DEFAULT 'Office',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(employee_id, date)
      );

CREATE TABLE IF NOT EXISTS clock_in_sessions (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        clock_in TIMESTAMP WITH TIME ZONE NOT NULL,
        clock_out TIMESTAMP WITH TIME ZONE,
        break_start TIMESTAMP WITH TIME ZONE,
        total_break_minutes INT DEFAULT 0,
        status VARCHAR(30) DEFAULT 'Working',
        work_location VARCHAR(50) DEFAULT 'Office',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(employee_id, date)
      );

CREATE TABLE IF NOT EXISTS attendance_punches (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        punch_type VARCHAR(20) NOT NULL,
        punch_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        work_location VARCHAR(50) DEFAULT 'Office',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE INDEX IF NOT EXISTS idx_attendance_punches_emp_date ON attendance_punches(employee_id, date DESC, punch_time DESC);

CREATE TABLE IF NOT EXISTS kudos (
        id SERIAL PRIMARY KEY,
        from_name VARCHAR(100) NOT NULL,
        from_role VARCHAR(100),
        to_name VARCHAR(100) NOT NULL,
        to_employee_id VARCHAR(20),
        category VARCHAR(50) DEFAULT 'Teamwork',
        message TEXT NOT NULL,
        badge_emoji VARCHAR(10) DEFAULT '🌟',
        likes_count INT DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS job_requisitions (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        role VARCHAR(100) NOT NULL,
        department VARCHAR(100) NOT NULL,
        openings INT NOT NULL DEFAULT 1,
        filled INT DEFAULT 0,
        ctc_band VARCHAR(100) NOT NULL,
        experience VARCHAR(100) NOT NULL,
        hiring_manager VARCHAR(100) NOT NULL,
        assigned_recruiter_id VARCHAR(50),
        assigned_recruiter_name VARCHAR(100),
        assigned_recruiter_role VARCHAR(100),
        status VARCHAR(50) DEFAULT 'Active',
        priority VARCHAR(50) DEFAULT 'High',
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE INDEX IF NOT EXISTS idx_requisitions_recruiter ON job_requisitions(assigned_recruiter_id);

CREATE INDEX IF NOT EXISTS idx_requisitions_status ON job_requisitions(status);

CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        ticket_number VARCHAR(50) UNIQUE NOT NULL,
        employee_id VARCHAR(20) REFERENCES employees(id) ON DELETE CASCADE,
        employee_name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        subject VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        is_confidential BOOLEAN DEFAULT FALSE,
        status VARCHAR(50) DEFAULT 'Open',
        priority VARCHAR(50) DEFAULT 'Medium',
        assigned_to VARCHAR(100) DEFAULT 'Super Admin',
        resolution_notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP WITH TIME ZONE
      );

CREATE TABLE IF NOT EXISTS recruitment_team (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        role_title VARCHAR(100) NOT NULL,
        department VARCHAR(100) NOT NULL,
        reports_to VARCHAR(100) DEFAULT 'Board of Directors',
        is_head BOOLEAN DEFAULT FALSE,
        email VARCHAR(100),
        phone VARCHAR(20),
        avatar_initials VARCHAR(5),
        specialization VARCHAR(250),
        active_vacancies INT DEFAULT 0,
        has_ats_access BOOLEAN DEFAULT TRUE,
        ats_role VARCHAR(50) DEFAULT 'rec_associate',
        sourcing_tag VARCHAR(50),
        max_candidate_capacity INT DEFAULT 20,
        status VARCHAR(20) DEFAULT 'Active'
      );

CREATE TABLE IF NOT EXISTS roles (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        is_system BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS role_permissions (
        id SERIAL PRIMARY KEY,
        role_id VARCHAR(50) REFERENCES roles(id) ON DELETE CASCADE,
        module VARCHAR(50) NOT NULL,
        action VARCHAR(50) NOT NULL,
        allowed BOOLEAN DEFAULT false,
        UNIQUE(role_id, module, action)
      );

CREATE TABLE IF NOT EXISTS ats_roles (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT NOT NULL,
        badge_color VARCHAR(50) DEFAULT '#2563eb',
        is_system BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE IF NOT EXISTS ats_role_permissions (
        id SERIAL PRIMARY KEY,
        role_id VARCHAR(50) REFERENCES ats_roles(id) ON DELETE CASCADE,
        module VARCHAR(50) NOT NULL,
        action VARCHAR(50) NOT NULL,
        allowed BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE(role_id, module, action)
      );

CREATE TABLE IF NOT EXISTS user_accounts (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) UNIQUE,
        email VARCHAR(100) UNIQUE NOT NULL,
        pin VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(50) NOT NULL,
        ats_role VARCHAR(50),
        department VARCHAR(100) NOT NULL,
        role_title VARCHAR(150) NOT NULL,
        avatar VARCHAR(10) NOT NULL,
        is_head_hr BOOLEAN DEFAULT FALSE,
        recruiter_id VARCHAR(50),
        status VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

ALTER TABLE user_accounts ALTER COLUMN pin TYPE VARCHAR(255);

ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS plain_pin VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_user_accounts_email ON user_accounts(email);

CREATE INDEX IF NOT EXISTS idx_user_accounts_emp_id ON user_accounts(employee_id);

CREATE TABLE IF NOT EXISTS user_specific_permissions (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) NOT NULL REFERENCES user_accounts(employee_id) ON DELETE CASCADE,
        permission_key VARCHAR(100) NOT NULL,
        allowed BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(employee_id, permission_key)
      );

CREATE INDEX IF NOT EXISTS idx_user_specific_permissions_emp ON user_specific_permissions(employee_id);
