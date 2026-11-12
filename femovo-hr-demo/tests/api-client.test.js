import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiTarget, readCookie } from '../client/src/utils/apiClient.js';

test('API routing attaches trust only to the configured origin and API prefix',()=>{
  assert.equal(resolveApiTarget('/api/employees','https://api.example.test','https://hr.example.test').url,'https://api.example.test/api/employees');
  assert.equal(resolveApiTarget('https://evil.example/api/employees','https://api.example.test','https://hr.example.test').trusted,false);
  assert.equal(resolveApiTarget('https://api.example.test.evil.example/api/employees','https://api.example.test','https://hr.example.test').trusted,false);
  assert.equal(resolveApiTarget('https://api.example.test/files/api/employees','https://api.example.test','https://hr.example.test').trusted,false);
  assert.equal(resolveApiTarget('/api/employees','','https://hr.example.test').trusted,true);
  assert.equal(resolveApiTarget('/api/employees','https://api.example.test/hr','https://hr.example.test').url,'https://api.example.test/hr/api/employees');
});

test('readCookie extracts CSRF token values cleanly', () => {
  assert.equal(readCookie('femovo_csrf', 'other=1; femovo_csrf=abc%3D123; z=2'), 'abc=123');
  assert.equal(readCookie('missing', 'femovo_csrf=abc'), null);
});
