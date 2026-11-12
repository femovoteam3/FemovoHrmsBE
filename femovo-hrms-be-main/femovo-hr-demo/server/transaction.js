import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';

export const databaseContext = new AsyncLocalStorage();

// All legacy route writes share one connection, including their audit writes.
// Nested transaction commands are owned by the outer request transaction.
export function transactionConnection(client) {
  return {
    query(sql, values) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
      return client.query(sql, values);
    },
    release() {},
  };
}

export function transactional(handler, rawPool, route) {
  return async (req, res, next) => {
    let client;
    let response;
    let committed = false;
    const afterCommitHooks = [];
    req.afterCommit = hook => {
      if (typeof hook === 'function') afterCommitHooks.push(hook);
    };
    const json = res.json;
    const send = res.send;
    try {
      client = await rawPool.connect();
      await client.query('BEGIN');
      res.json = function (body) { response = { kind: 'json', body }; return this; };
      res.send = function (body) { response = { kind: 'send', body }; return this; };
      await databaseContext.run({ client: transactionConnection(client) }, () => handler(req, res, next));
      if (!response) throw new Error('Mutation did not produce a response');
      if (res.statusCode < 400) {
        await client.query(
          'INSERT INTO audit_logs (actor_name, actor_id, action, details) VALUES ($1, $2, $3, $4)',
          [req.auditConfidential ? 'Confidential' : (req.user?.name || 'Public applicant'), req.auditConfidential ? null : (req.user?.userId || null), `${req.method} ${route}`, JSON.stringify({ params: req.params })]
        );
        await client.query('COMMIT');
        committed = true;
        for (const hook of afterCommitHooks) {
          await Promise.resolve(hook()).catch(() => {});
        }
      } else await client.query('ROLLBACK');
      res.json = json;
      res.send = send;
      res[response.kind](response.body);
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      res.json = json;
      res.send = send;
      next(error);
    } finally {
      client?.release();
      if (!committed && req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    }
  };
}
