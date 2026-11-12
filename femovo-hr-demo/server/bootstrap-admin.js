import './config.js';
import bcrypt from 'bcryptjs';
import { rawPool } from './db.js';
const { BOOTSTRAP_EMAIL:email, BOOTSTRAP_PASSWORD:password }=process.env;
try {
 if (!email || !password || password.length<12 || Buffer.byteLength(password)>72) throw new Error('Set BOOTSTRAP_EMAIL and a 12–72 byte BOOTSTRAP_PASSWORD.');
 const existing=await rawPool.query("SELECT 1 FROM user_accounts WHERE role='super_admin' LIMIT 1");
 if(existing.rowCount) throw new Error('An administrator already exists. Bootstrap does not reset accounts.');
 await rawPool.query("INSERT INTO user_accounts(employee_id,email,pin,name,role,department,role_title,avatar) VALUES('ADMIN-INITIAL',$1,$2,'Administrator','super_admin','Administration','Administrator','AD')",[email,await bcrypt.hash(password,12)]);
 console.log('Administrator created. Remove bootstrap credentials from your environment.');
} catch(error) { console.error(error.message);process.exitCode=1; }
finally { await rawPool.end(); }
