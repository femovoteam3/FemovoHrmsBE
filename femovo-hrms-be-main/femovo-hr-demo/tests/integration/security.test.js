import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const testUrl=process.env.TEST_DATABASE_URL;
test('isolated PostgreSQL and HTTP regression suite',{skip:!testUrl,timeout:120000},async t=>{
  const url=new URL(testUrl);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.port==='55439' && url.pathname==='/femovo_security_test','Refuse to run mutation tests outside the dedicated local test database.');
  process.env.DATABASE_URL=testUrl;
  process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');
  process.env.NODE_ENV='test';
  process.env.WORK_WEEK='1,2,3,4,5';
  process.env.HOLIDAYS_JSON='[]';
  process.env.UPLOAD_DIR=path.resolve('.test-uploads');
  const {rawPool}=await import('../../server/db.js');
  const {migrate}=await import('../../server/migrate.js');
  const {hashPin,generateToken,verifyPin}=await import('../../server/auth.js');
  let server;
  t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await rawPool.end();});
  // This disposable schema contains synthetic data only; the URL guard above is mandatory.
  await rawPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await rawPool.query(await fs.readFile('server/migrations/001_schema.sql','utf8'));
  await rawPool.query("INSERT INTO user_accounts(employee_id,email,pin,plain_pin,name,role,department,role_title,avatar,status) VALUES('LEGACY','legacy@example.test','legacy-test-secret','legacy-test-secret','Legacy fixture','employee','Test','Employee','LF','Inactive')");
  await migrate();
  await t.test('migration hashes legacy credentials without reactivating or renaming accounts',async()=>{
    const row=(await rawPool.query("SELECT * FROM user_accounts WHERE employee_id='LEGACY'")).rows[0];
    assert.equal(row.status,'Inactive');assert.equal(row.name,'Legacy fixture');assert.equal(row.plain_pin,null);
    assert.ok(await verifyPin('legacy-test-secret',row.pin));
    await migrate();
    assert.equal((await rawPool.query("SELECT pin FROM user_accounts WHERE employee_id='LEGACY'")).rows[0].pin,row.pin);
    assert.equal(Number((await rawPool.query("SELECT COUNT(*) FROM role_permissions WHERE module='payroll'")).rows[0].count),0);
    assert.equal(Number((await rawPool.query("SELECT COUNT(*) FROM roles WHERE id='payroll_specialist'")).rows[0].count),0);
  });
  const password=await hashPin('Synthetic-Only-Password');
  const users={};
  for(const [id,role] of [['TEST-ADMIN','super_admin'],['TEST-A','employee'],['TEST-B','employee'],['TEST-M','manager']]) {
    await rawPool.query("INSERT INTO employees(id,name,department,role,status,joining_date,manager_id) VALUES($1,$1,'Test',$2,'Confirmed','2026-10-01',$3)",[id,role,id==='TEST-A'?'TEST-M':null]);
    const row=(await rawPool.query("INSERT INTO user_accounts(employee_id,email,pin,name,role,department,role_title,avatar) VALUES($1,$2,$3,$1,$4,'Test',$4,'TT') RETURNING *",[id,id+'@example.test',password,role])).rows[0];
    users[id]={row};
  }
  const {app}=await import('../../server/index.js');
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const parseSetCookies = hdrs => {
    const raw = typeof hdrs.getSetCookie === 'function' ? hdrs.getSetCookie() : (hdrs.get('set-cookie') ? [hdrs.get('set-cookie')] : []);
    const map = {};
    for (const c of raw) {
      const [nv] = c.split(';');
      const eq = nv.indexOf('=');
      if (eq > 0) map[nv.slice(0, eq).trim()] = nv.slice(eq + 1).trim();
    }
    return { raw, map };
  };
  for (const id of Object.keys(users)) {
    const loginRes = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: id + '@example.test', pin: 'Synthetic-Only-Password' })
    });
    assert.equal(loginRes.status, 200);
    const loginJson = await loginRes.json();
    assert.equal(loginJson.token, undefined, 'login response must not expose JWT to client JS');
    const { raw, map } = parseSetCookies(loginRes.headers);
    const sessionCookieLine = raw.find(c => c.startsWith('femovo_session='));
    assert.ok(sessionCookieLine && /HttpOnly/i.test(sessionCookieLine) && /SameSite=Lax/i.test(sessionCookieLine));
    assert.ok(map.femovo_csrf);
    users[id].cookieHeader = `femovo_session=${map.femovo_session}; femovo_csrf=${map.femovo_csrf}`;
    users[id].csrfToken = map.femovo_csrf;
  }
  const request=async(method,endpoint,body,user='TEST-A',headers={})=>{
    const upper = method.toUpperCase();
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(upper);
    const authHeaders = user
      ? { Cookie: users[user].cookieHeader, ...(isWrite ? { 'X-CSRF-Token': users[user].csrfToken } : {}) }
      : {};
    const response=await fetch(base+endpoint,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...authHeaders,...headers},body:body?JSON.stringify(body):undefined});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    return {status:response.status,data,headers:response.headers};
  };
  await t.test('all registered API routes have a policy; anonymous and CSRF-missing requests fail',async()=>{
    assert.ok(app.locals.routePolicies.length>90);
    assert.equal((await request('GET','/api/auth/accounts',null,null)).status,401);
    assert.equal((await request('GET','/api/employees',null,null)).status,401);
    assert.equal((await request('GET','/uploads/sample_aadhaar.pdf',null,null)).status,401);
    assert.equal((await request('GET','/api/employees',null,'TEST-A',{Origin:'https://unapproved.example'})).status,403);
    assert.equal((await request('GET','/api/auth/me',null,'TEST-A')).status,200);
    assert.equal((await request('POST','/api/leaves',{employeeId:'TEST-A'},'TEST-A',{'X-CSRF-Token':''})).status,403);
  });
  await t.test('employee cannot escalate roles, alter another password, or edit permissions',async()=>{
    assert.equal((await request('PUT','/api/employees/TEST-A',{access_role:'super_admin'})).status,403);
    assert.equal((await request('PUT','/api/employees/TEST-B/credentials',{newPassword:'Another-Synthetic-Password'})).status,403);
    assert.equal((await request('PUT','/api/roles/employee/permissions',{permissions:{employees:{edit:true}}})).status,403);
    assert.equal((await request('POST','/api/attendance/regularize',{employeeId:'TEST-B'})).status,403);
    assert.equal((await request('GET','/api/onboarding/profile/TEST-B')).status,403);
  });
  await t.test('employee sees only their own records and managers only their direct reports',async()=>{
    assert.deepEqual((await request('GET','/api/employees')).data.map(row=>row.id),['TEST-A']);
    assert.deepEqual((await request('GET','/api/employees',null,'TEST-M')).data.map(row=>row.id).sort(),['TEST-A','TEST-M']);
    assert.equal((await request('GET','/api/employees/TEST-A/credentials')).data.savedPassword,undefined);
  });
  let application;
  await t.test('public applicant gets a one-time upload capability, not arbitrary record access',async()=>{
    await rawPool.query("INSERT INTO job_requisitions(code,department,role,status,ctc_band,experience,hiring_manager) VALUES('TEST-REQ','Test','Test Job','Active','Reviewed test band','Test experience','TEST-ADMIN')");
    const create=await request('POST','/api/applicants',{name:"O'Connor",job:'Test Job',email:'candidate@example.test',phone:'9822012345'},null);
    assert.equal(create.status,201,JSON.stringify(create.data));application=create.data;
    assert.ok(application.uploadToken);
    const form=new FormData();form.append('file',new Blob(['%PDF-1.7\nSynthetic fixture'],{type:'application/pdf'}),"O'Connor.pdf");
    assert.equal((await fetch(base+`/api/applicants/${application.id}/resume`,{method:'POST',body:form})).status,403);
    const upload=await fetch(base+`/api/applicants/${application.id}/resume`,{method:'POST',headers:{'X-Application-Token':application.uploadToken},body:form});
    assert.equal(upload.status,200,await upload.text());
    assert.equal((await fetch(base+`/api/applicants/${application.id}/resume`,{method:'POST',headers:{'X-Application-Token':application.uploadToken},body:form})).status,403);
    const applicant=(await rawPool.query('SELECT * FROM applicants WHERE id=$1',[application.id])).rows[0];
    assert.equal((await request('GET',applicant.resume_url,null,null)).status,401);
    assert.equal((await request('GET',applicant.resume_url)).status,404);
    assert.equal((await request('GET',applicant.resume_url,null,'TEST-ADMIN')).status,200);
  });
  await t.test('repeated and concurrent approvals deduct once; cancellation restores exactly',async()=>{
    await rawPool.query("INSERT INTO leave_balances(employee_id,cl_balance) VALUES('TEST-A',10)");
    const created=await request('POST','/api/leaves',{employeeId:'TEST-A',type:'Casual Leave',from:'2026-10-05',to:'2026-10-07',reason:'Synthetic test'});
    assert.equal(created.status,201,JSON.stringify(created.data));
    const endpoint=`/api/leaves/${created.data.id}/status`;
    const results=await Promise.all([request('PATCH',endpoint,{status:'Approved'},'TEST-ADMIN'),request('PATCH',endpoint,{status:'Approved'},'TEST-ADMIN')]);
    assert.ok(results.every(row=>row.status===200),JSON.stringify(results));
    assert.equal(Number((await rawPool.query("SELECT cl_balance FROM leave_balances WHERE employee_id='TEST-A'")).rows[0].cl_balance),7);
    assert.equal((await request('PATCH',endpoint,{status:'Cancelled'},'TEST-ADMIN')).status,200);
    assert.equal(Number((await rawPool.query("SELECT cl_balance FROM leave_balances WHERE employee_id='TEST-A'")).rows[0].cl_balance),10);
    const half=await request('POST','/api/leaves',{employeeId:'TEST-A',type:'Casual Leave',from:'2026-10-08',to:'2026-10-08',reason:'Half-day fixture',is_half_day:true,half_day_session:'Morning'});
    assert.equal((await request('PATCH',`/api/leaves/${half.data.id}/status`,{status:'Approved'},'TEST-ADMIN')).status,200);
    assert.equal(Number((await rawPool.query("SELECT cl_balance FROM leave_balances WHERE employee_id='TEST-A'")).rows[0].cl_balance),9.5);
  });
  await t.test('retired payroll APIs are unavailable',async()=>{
    for (const [method, endpoint, body] of [
      ['GET','/api/salaries',null],
      ['PUT','/api/salaries/TEST-A',{basic:22000,hra:0,allowances:0,deductions:0}],
      ['GET','/api/payroll/runs',null],
      ['POST','/api/payroll/run',{month:'October',year:2026}],
      ['POST','/api/payroll/batches/test/approve',{}],
      ['GET','/api/payroll/bank-neft?batchId=test',null],
      ['GET','/api/export/payroll',null],
      ['GET','/api/export/bank-payout?batchId=test',null]
    ]) assert.equal((await request(method,endpoint,body,'TEST-ADMIN')).status,404,`${method} ${endpoint}`);
  });
  await t.test('candidate promotion preserves joining date, provisions a protected account and cannot repeat',async()=>{
    const body={department:'Test',role:'Test Job',joining_date:'2026-11-02',ctc:264000,basic:22000,hra:0,allowances:0,deductions:0};
    assert.equal((await request('POST',`/api/applicants/${application.id}/promote`,body,'TEST-ADMIN')).status,409);
    await rawPool.query("UPDATE applicants SET stage='Approved' WHERE id=$1",[application.id]);
    assert.equal((await request('POST',`/api/applicants/${application.id}/promote`,body,'TEST-ADMIN')).status,409);
    await rawPool.query("INSERT INTO offers(applicant_id,designation,department,annual_ctc,basic,joining_date,status) VALUES($1,'Test Job','Test',264000,22000,'2026-11-02','Accepted')",[application.id]);
    const promoted=await request('POST',`/api/applicants/${application.id}/promote`,body,'TEST-ADMIN');
    assert.equal(promoted.status,201,JSON.stringify(promoted.data));
    assert.equal(promoted.data.passwordSetupRequired,true);
    const account=(await rawPool.query('SELECT * FROM user_accounts WHERE employee_id=$1',[promoted.data.empId])).rows[0];
    assert.match(account.pin,/^\$2[aby]\$/);assert.equal(account.plain_pin,null);assert.equal(account.role,'employee');
    const employee=(await rawPool.query("SELECT to_char(joining_date,'YYYY-MM-DD') AS day FROM employees WHERE id=$1",[promoted.data.empId])).rows[0];
    assert.equal(employee.day,'2026-11-02');
    assert.equal((await request('POST',`/api/applicants/${application.id}/promote`,body,'TEST-ADMIN')).status,409);
  });
  await t.test('revoked account token stays revoked after access is restored',async()=>{
    await rawPool.query("UPDATE employees SET has_dashboard_access=false WHERE id='TEST-B'");
    assert.equal((await request('GET','/api/employees',null,'TEST-B')).status,401);
    await rawPool.query("UPDATE employees SET has_dashboard_access=true WHERE id='TEST-B'");
    assert.equal((await request('GET','/api/employees',null,'TEST-B')).status,401);
  });
  await t.test('audit events use authenticated identity and cannot be updated',async()=>{
    const result=await request('POST','/api/announcements',{title:'Audit identity fixture',content:'Synthetic notice',posted_by:'Forged identity'},'TEST-ADMIN');
    assert.equal(result.status,201,JSON.stringify(result.data));
    const audit=(await rawPool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1')).rows[0];
    assert.equal(audit.actor_name,'TEST-ADMIN');assert.equal(audit.actor_id,users['TEST-ADMIN'].row.id);
    await assert.rejects(rawPool.query('UPDATE audit_logs SET actor_name=$1 WHERE id=$2',['Wrong',audit.id]));
  });
});
