import type { MigrationInterface, QueryRunner } from "typeorm";
export class AdminAudit1793836801000 implements MigrationInterface {
  name = "AdminAudit1793836801000";
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE admin_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL,
      actor text NOT NULL, action text NOT NULL, target_id uuid NOT NULL,
      details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
    ); CREATE INDEX admin_audit_target_idx ON admin_audit_events(target_id,created_at);`);
  }
  async down(q: QueryRunner) { await q.query("DROP TABLE admin_audit_events"); }
}
