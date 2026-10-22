import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';

export function submissionDetail(id) {
  const s = db.prepare(
    `SELECT s.id, s.occ_date, s.count, s.note, s.submitted_at, s.updated_at, s.user_id, u.name AS user_name, t.title AS task_title, t.count_unit
     FROM submissions s JOIN users u ON u.id=s.user_id JOIN tasks t ON t.id=s.task_id WHERE s.id=?`,
  ).get(id);
  return s || null;
}

export function removeStoredFile(storedName) {
  fs.rm(path.join(config.uploadDir, path.basename(storedName)), { force: true }, () => {});
}
