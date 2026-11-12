import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { pool } from './db.js';
import { checkCandidateAccess } from './auth.js';
import { employeeScope, hasPermission } from './security.js';

export const uploadDir = process.env.UPLOAD_DIR || fileURLToPath(new URL('uploads', import.meta.url));
export const tokenHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export function detectFile(buffer) {
  if (buffer.subarray(0, 5).toString() === '%PDF-') return { extension: '.pdf', mime: 'application/pdf' };
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { extension: '.png', mime: 'image/png' };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { extension: '.jpg', mime: 'image/jpeg' };
  return null;
}

const parse = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, parts: 6 } }).single('file');
export const upload = {
  single() {
    return (req, res, next) => parse(req, res, async error => {
      if (error) return next(error);
      try {
        if (!req.file) return res.status(400).json({ error: 'A file is required.' });
        const type = detectFile(req.file.buffer);
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (!type || type.mime !== req.file.mimetype || ![type.extension, ...(type.extension === '.jpg' ? ['.jpeg'] : [])].includes(ext)) {
          return res.status(400).json({ error: 'Upload a valid PDF, PNG or JPEG file (maximum 10 MB).' });
        }
        if (req.params.employeeId && !['aadhaar', 'pan', 'bank_proof', 'resume', 'photo', 'degree', 'education', 'experience', 'other'].includes(req.body.docType)) {
          return res.status(400).json({ error: 'Unsupported document type.' });
        }
        const filename = crypto.randomUUID() + type.extension;
        await fs.mkdir(uploadDir, { recursive: true });
        const filePath = path.join(uploadDir, filename);
        await fs.writeFile(filePath, req.file.buffer, { flag: 'wx', mode: 0o600 });
        req.file = { ...req.file, filename, path: filePath, buffer: undefined };
        next();
      } catch (err) { next(err); }
    });
  }
};

export async function authorizeResumeUpload(req, res, next) {
  try {
    const result = await pool.query('SELECT * FROM applicants WHERE id=$1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Application not found.' });
    if (req.user) {
      const access = await checkCandidateAccess(req.user, result.rows[0], 'edit');
      if (!access.authorized) return res.status(403).json({ error: 'Upload not permitted.' });
    } else {
      const token = req.get('X-Application-Token');
      if (!token || token.length > 200) return res.status(403).json({ error: 'Application upload token required.' });
      const row = result.rows[0];
      if (row.resume_upload_token_hash !== tokenHash(token) || new Date(row.resume_upload_expires_at).getTime() <= Date.now()) {
        return res.status(403).json({ error: 'Upload token expired or invalid.' });
      }
      req.applicationTokenHash = tokenHash(token);
    }
    next();
  } catch (error) { next(error); }
}

export async function downloadFile(req, res, next) {
  try {
    const filename = req.params.filename;
    if (filename !== path.basename(filename) || /[\\/\x00]/.test(filename)) return res.sendStatus(400);
    const url = `/uploads/${filename}`;
    const documents = await pool.query('SELECT * FROM employee_uploaded_documents WHERE file_url=$1', [url]);
    let allowed = false;
    let originalName = filename;
    for (const row of documents.rows) {
      if (!await hasPermission(req.user, 'onboarding', 'view')) continue;
      const scope = await employeeScope(req.user, 'onboarding');
      if (scope === null || scope.includes(row.employee_id)) { allowed = true; originalName = row.file_name; }
    }
    const applicants = await pool.query('SELECT * FROM applicants WHERE resume_url=$1', [url]);
    for (const row of applicants.rows) {
      if ((await checkCandidateAccess(req.user, row, 'view')).authorized) { allowed = true; originalName = row.resume_name; }
    }
    if (!allowed) return res.status(404).json({ error: 'Document unavailable.' });
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.download(path.join(uploadDir, filename), path.basename(originalName || filename), error => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Document unavailable.' });
    });
  } catch (error) { next(error); }
}

export function resolveUploadPath(fileUrl, targetDir = uploadDir) {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
  const filename = fileUrl.slice('/uploads/'.length);
  if (!filename || filename === '.' || filename === '..' || filename !== path.basename(filename) || /[\\/\x00]/.test(filename)) {
    return null;
  }
  const base = path.resolve(targetDir);
  const fullPath = path.resolve(base, filename);
  if (!fullPath.startsWith(base + path.sep)) return null;
  return fullPath;
}

export async function safeUnlinkUpload(fileUrl, targetDir = uploadDir) {
  const fullPath = resolveUploadPath(fileUrl, targetDir);
  if (!fullPath) return false;
  try {
    await fs.unlink(fullPath);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

export async function scheduleUploadCleanup(req, fileUrls, targetDir = uploadDir) {
  const uniqueUrls = [...new Set((Array.isArray(fileUrls) ? fileUrls : [fileUrls]).filter(Boolean))];
  for (const url of uniqueUrls) {
    if (!resolveUploadPath(url, targetDir)) continue;
    const refs = await pool.query(
      `SELECT 1 FROM employee_uploaded_documents WHERE file_url = $1
       UNION ALL
       SELECT 1 FROM applicants WHERE resume_url = $1
       LIMIT 1`,
      [url]
    );
    if (refs.rowCount > 0) continue;
    if (typeof req?.afterCommit === 'function') {
      req.afterCommit(() => safeUnlinkUpload(url, targetDir));
    } else {
      await safeUnlinkUpload(url, targetDir);
    }
  }
}
