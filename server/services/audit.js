import { db, now } from '../db.js';

/** سجل نشاط لكل قرار إداري: من، ماذا، متى، ولماذا */
export function audit(actorId, action, entity, entityId, details = {}) {
  db.prepare('INSERT INTO audit_logs(actor_id,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)')
    .run(actorId ?? null, action, entity, entityId ?? null, JSON.stringify(details), now());
}
