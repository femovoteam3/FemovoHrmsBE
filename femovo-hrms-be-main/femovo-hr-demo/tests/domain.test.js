import test from 'node:test';
import assert from 'node:assert/strict';
import { leaveDays, workingDates, leaveColumn, paise, csvCell } from '../server/domain.js';
import { detectFile } from '../server/files.js';
import { validateConfig } from '../server/config.js';

const policy={week:new Set([1,2,3,4,5]),holidays:new Set(['2026-10-02'])};
test('leave duration excludes weekends and configured holidays',()=>{
  assert.equal(leaveDays({from_date:'2026-10-01',to_date:'2026-10-07'},policy),4);
  assert.equal(leaveDays({from_date:'2026-10-01',to_date:'2026-10-01',is_half_day:true,half_day_session:'Morning'},policy),0.5);
  assert.throws(()=>workingDates('2026-10-10','2026-10-01',policy));
  assert.throws(()=>workingDates('2026-02-30','2026-03-01',policy));
  assert.throws(()=>leaveDays({from_date:'2026-10-01',to_date:'2026-10-07',is_half_day:true},policy));
  assert.equal(leaveColumn('Paid Leave'),'pl_balance');
  assert.throws(()=>leaveColumn('unknown'));
});
test('money inputs cannot silently coerce invalid data',()=>{
  assert.equal(paise('123.45'),12345);
  for(const value of [-1,'abc','1.234',Infinity,NaN]) assert.throws(()=>paise(value));
});
test('exports escape embedded quotes and spreadsheet formulas',()=>{
  assert.equal(csvCell('a"b'),'"a""b"');
  assert.equal(csvCell('=1+1'),'"\'=1+1"');
});
test('uploads reject executable content with a forged extension',()=>{
  assert.equal(detectFile(Buffer.from('<html>malicious</html>')),null);
  assert.equal(detectFile(Buffer.from('%PDF-1.7\n')).mime,'application/pdf');
});
test('production configuration fails closed without a secret and explicit origins',()=>{
  assert.throws(()=>validateConfig({}));
  assert.throws(()=>validateConfig({JWT_SECRET:'x'.repeat(32),DATABASE_URL:'postgres://example',NODE_ENV:'production',CORS_ORIGIN:'*'}));
  assert.doesNotThrow(()=>validateConfig({JWT_SECRET:'x'.repeat(32),DATABASE_URL:'postgres://example',NODE_ENV:'production',CORS_ORIGIN:'https://hr.example.com',PGSSL:'true'}));
});
