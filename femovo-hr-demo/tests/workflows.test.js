import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../server/db.js';
import { decideLeave } from '../server/domain.js';

function response() { return { statusCode:200, status(code){ this.statusCode=code; return this; }, json(body){ this.body=body; return this; } }; }
const policy = () => { process.env.WORK_WEEK='1,2,3,4,5'; process.env.HOLIDAYS_JSON='[]'; };

test('repeat approval does not debit a balance and reversing approved half-day restores exactly half a day',async()=>{
  policy();
  const original=pool.query;
  const leave={id:1,employee_id:'SELF',status:'Approved',type:'Casual Leave',balance_reconciled:true,balance_column:'cl_balance',deducted_days:'0.50'};
  const writes=[];
  pool.query=async(sql,values)=>{
    if(sql.startsWith('SELECT')) return {rows:[leave],rowCount:1};
    writes.push({sql,values});
    return {rows:[{...leave,status:'Cancelled'}],rowCount:1};
  };
  try {
    await decideLeave({params:{id:1},body:{status:'Approved'}},response());
    assert.equal(writes.length,0);
    await decideLeave({params:{id:1},body:{status:'Cancelled'}},response());
    assert.match(writes[0].sql,/cl_balance=cl_balance\+\$1/);
    assert.equal(Number(writes[0].values[0]),0.5);
    assert.equal(writes[1].values[1],0);
  } finally { pool.query=original; }
});
test('unreconciled legacy leave and insufficient balances cannot become a successful decision',async()=>{
  policy(); const original=pool.query; let debitAttempts=0;
  const leave={id:1,employee_id:'SELF',status:'Approved',balance_reconciled:false,type:'Casual Leave',from_date:'2026-10-05',to_date:'2026-10-07'};
  pool.query=async sql=>{
    if(sql.startsWith('SELECT')) return {rows:[leave],rowCount:1};
    if(sql.startsWith('UPDATE leave_balances')) { debitAttempts++; return {rows:[],rowCount:0}; }
    throw new Error('An invalid decision attempted to persist');
  };
  try {
    await assert.rejects(decideLeave({params:{id:1},body:{status:'Cancelled'}},response()),{status:409});
    assert.equal(debitAttempts,0);
    leave.status='Pending';
    await assert.rejects(decideLeave({params:{id:1},body:{status:'Approved'}},response()),{status:409});
    assert.equal(debitAttempts,1);
  } finally { pool.query=original; }
});
