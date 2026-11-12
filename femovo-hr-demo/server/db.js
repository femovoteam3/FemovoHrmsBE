import './config.js';
import pg from 'pg';
import fs from 'node:fs';
import { databaseContext } from './transaction.js';
import { businessTimezone } from './config.js';

// node-postgres URL SSL options can override the explicit TLS object. Keep TLS policy here.
const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (databaseUrl) for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) databaseUrl.searchParams.delete(key);
const connection = databaseUrl
  ? { connectionString: databaseUrl.toString() }
  : { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE };
const ssl = process.env.PGSSL === 'true'
  ? { rejectUnauthorized: true, ...(process.env.PGSSLROOTCERT ? { ca: fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8') } : {}) }
  : undefined;
export const rawPool = new pg.Pool({ ...connection, ...(ssl ? { ssl } : {}), max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 15000, options: '-c timezone=' + businessTimezone });
rawPool.on('error', () => console.error('Unexpected idle database connection error'));
export const pool = {
  query: (...args) => (databaseContext.getStore()?.client || rawPool).query(...args),
  connect: async () => databaseContext.getStore()?.client || rawPool.connect(),
  end: () => rawPool.end(),
};
