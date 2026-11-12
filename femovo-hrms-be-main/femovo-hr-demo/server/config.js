import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)), quiet: true });

export function validateConfig(env = process.env) {
  if (!env.JWT_SECRET || Buffer.byteLength(env.JWT_SECRET) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes of randomly generated secret material.');
  }
  if (!env.DATABASE_URL && (!env.PGUSER || !env.PGPASSWORD || !env.PGDATABASE)) {
    throw new Error('Configure DATABASE_URL or PGUSER, PGPASSWORD and PGDATABASE.');
  }
  if (env.NODE_ENV === 'production' && (!env.CORS_ORIGIN || env.CORS_ORIGIN.includes('*'))) {
    throw new Error('Production requires an explicit CORS_ORIGIN allowlist.');
  }
  if (env.NODE_ENV === 'production' && env.PGSSL !== 'true') throw new Error('Production requires PGSSL=true and a trusted database certificate.');
  if (env.TRUST_PROXY_HOPS && (!/^\d+$/.test(env.TRUST_PROXY_HOPS) || Number(env.TRUST_PROXY_HOPS)>3)) throw new Error('TRUST_PROXY_HOPS must be the verified proxy count (0–3).');
  new Intl.DateTimeFormat('en', { timeZone: env.BUSINESS_TIMEZONE || 'Asia/Kolkata' });
}

export const businessTimezone = process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';
export function businessDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: businessTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
