import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import crypto from 'node:crypto';

process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'test';

const { pool, rawPool } = await import('../server/db.js');
const { app } = await import('../server/index.js');
const { generateToken } = await import('../server/auth.js');

const account = {
  id: 1,
  employee_id: 'HR-1',
  name: 'Synthetic HR',
  email: 'hr@example.test',
  role: 'hr',
  status: 'Active',
  session_version: 0,
  has_dashboard_access: true
};
const permissions = [
  { module: 'onboarding', action: 'view', allowed: true },
  { module: 'onboarding', action: 'verify_kyc', allowed: true }
];
const requiredTypes = ['aadhaar', 'pan', 'bank_proof', 'degree', 'photo'];
let submitted = true;
let uploadedTypes = [...requiredTypes];
let calls = [];

pool.query = async (sql, values) => {
  calls.push({ sql, values });
  if (sql.includes('FROM user_accounts u')) return { rows: [account], rowCount: 1 };
  if (sql.includes('FROM user_specific_permissions')) return { rows: [], rowCount: 0 };
  if (sql.includes('FROM role_permissions')) return { rows: permissions, rowCount: permissions.length };
  if (sql.includes('SELECT onboarding_submitted')) return { rows: [{ onboarding_submitted: submitted }], rowCount: 1 };
  if (sql.includes('SELECT doc_type FROM employee_uploaded_documents')) {
    return { rows: uploadedTypes.map(doc_type => ({ doc_type })), rowCount: uploadedTypes.length };
  }
  if (sql.includes('UPDATE employee_personal_details')) {
    return { rows: [{ employee_id: values[3], hr_verified: values[0] }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
};

rawPool.connect = async () => ({ query: (sql, values) => pool.query(sql, values), release() {} });

function request(body) {
  calls = [];
  return new Promise((resolve, reject) => {
    let output = '';
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, callback) { output += chunk.toString(); callback(); }
    });
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = 'PATCH';
    req.url = '/api/onboarding/profile/EMP-1/verify';
    req.headers = { authorization: `Bearer ${generateToken(account)}` };
    req.body = body;
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = output.slice(output.indexOf('\r\n\r\n') + 4);
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      resolve({ status: res.statusCode, data, calls: [...calls] });
    });
    res.on('error', reject);
    app.handle(req, res, reject);
  });
}

const persistedVerification = result => result.calls.some(call => call.sql.includes('UPDATE employee_personal_details'));

test('onboarding verification requires a submitted profile', async () => {
  submitted = false;
  uploadedTypes = [...requiredTypes];
  const result = await request({ verified: true });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /submit the onboarding form/i);
  assert.equal(persistedVerification(result), false);
});

test('onboarding verification requires every required document type', async () => {
  submitted = true;
  uploadedTypes = ['aadhaar', 'pan'];
  const result = await request({ verified: true });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /Bank Proof/);
  assert.match(result.data.error, /Highest Degree Certificate/);
  assert.match(result.data.error, /Passport Photograph/);
  assert.equal(persistedVerification(result), false);
});

test('a complete onboarding submission can be verified', async () => {
  submitted = true;
  uploadedTypes = [...requiredTypes];
  const result = await request({ verified: true });
  assert.equal(result.status, 200);
  assert.equal(result.data.hr_verified, true);
  assert.equal(persistedVerification(result), true);
  assert.ok(result.calls.some(call => call.sql.includes('UPDATE employee_uploaded_documents')));
});
