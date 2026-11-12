import test from 'node:test';
import assert from 'node:assert/strict';
import { transactional } from '../server/transaction.js';

function response() { return {statusCode:200,body:null,json(body){this.body=body;return this;},send(body){this.body=body;return this;}}; }
test('successful mutations await an authenticated audit write before committing and responding',async()=>{
  const statements=[];
  const pool={connect:async()=>({query:async(sql,values)=>{statements.push({sql,values});return {rows:[]};},release(){statements.push({sql:'RELEASE'});}})};
  const res=response();
  await transactional(async(req,res)=>res.json({saved:true}),pool,'/api/example')({method:'PUT',user:{userId:5,name:'Verified actor'},params:{id:'42'}},res,error=>{throw error;});
  assert.equal(statements[0].sql,'BEGIN');
  assert.match(statements[1].sql,/INSERT INTO audit_logs/);
  assert.equal(statements[1].values[0],'Verified actor');
  assert.equal(statements[1].values[1],5);
  assert.equal(statements[2].sql,'COMMIT');
  assert.deepEqual(res.body,{saved:true});
});
test('failed audit writes roll back and never send a success response',async()=>{
  const statements=[];let error;
  const pool={connect:async()=>({query:async sql=>{statements.push(sql);if(sql.startsWith('INSERT'))throw Error('Simulated audit failure');return {rows:[]};},release(){}})};
  const res=response();
  await transactional(async(req,res)=>res.json({saved:true}),pool,'/api/example')({method:'PUT',params:{}},res,e=>{error=e;});
  assert.ok(error);assert.ok(statements.includes('ROLLBACK'));assert.ok(!statements.includes('COMMIT'));assert.equal(res.body,null);
});
test('handler validation failures roll back without creating a success audit',async()=>{
  const statements=[];
  const pool={connect:async()=>({query:async sql=>{statements.push(sql);return {rows:[]};},release(){}})};
  const res=response();
  await transactional(async(req,res)=>{res.statusCode=409;res.json({error:'Conflict'});},pool,'/api/example')({method:'PUT',params:{}},res,error=>{throw error;});
  assert.deepEqual(statements,['BEGIN','ROLLBACK']);assert.deepEqual(res.body,{error:'Conflict'});
});

test('post-commit upload cleanup runs only on commit, rejects path traversal, and keeps referenced files', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { resolveUploadPath, scheduleUploadCleanup } = await import('../server/files.js');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'femovo-upload-test-'));
  const fileA = path.join(tmpDir, 'resume-a.pdf');
  const fileB = path.join(tmpDir, 'shared-b.pdf');
  await fs.writeFile(fileA, '%PDF-1.4\n');
  await fs.writeFile(fileB, '%PDF-1.4\n');

  const mockTxPool = {
    connect: async () => ({
      query: async (sql, values = []) => {
        if (sql.includes('UNION ALL')) {
          return values[0] === '/uploads/shared-b.pdf' ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {}
    })
  };

  try {
    // 1. Traversal paths never resolve inside targetDir
    assert.equal(resolveUploadPath('/uploads/../../etc/passwd', tmpDir), null);
    assert.equal(resolveUploadPath('/uploads/nested/file.pdf', tmpDir), null);
    assert.equal(resolveUploadPath('https://example.com/resume.pdf', tmpDir), null);

    // 2. Rollback (status >= 400 or audit failure) must NOT unlink the file
    await transactional(async (req, res) => {
      await scheduleUploadCleanup(req, '/uploads/resume-a.pdf', tmpDir);
      res.statusCode = 409;
      res.json({ error: 'Rollback' });
    }, mockTxPool, '/api/onboarding/document/1')({ method: 'DELETE', params: { id: '1' } }, response(), e => { throw e; });
    assert.equal(await fs.access(fileA).then(() => true).catch(() => false), true);

    // 3. Commit unlinks unreferenced fileA, leaves shared referenced fileB untouched
    await transactional(async (req, res) => {
      await scheduleUploadCleanup(req, ['/uploads/resume-a.pdf', '/uploads/shared-b.pdf'], tmpDir);
      res.json({ success: true });
    }, mockTxPool, '/api/applicants/1')({ method: 'DELETE', params: { id: '1' } }, response(), e => { throw e; });

    assert.equal(await fs.access(fileA).then(() => true).catch(() => false), false);
    assert.equal(await fs.access(fileB).then(() => true).catch(() => false), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
