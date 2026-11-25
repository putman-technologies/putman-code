import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN approved_by TEXT`;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN approved_at TEXT`;
  yield* sql`CREATE TABLE coordinator_people(project_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, submit INTEGER NOT NULL DEFAULT 1, approve INTEGER NOT NULL DEFAULT 0, ship INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,key))`;
  yield* sql`CREATE TABLE coordinator_holds(project_id TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(project_id,id))`;
  yield* sql`CREATE TABLE coordinator_team_settings(project_id TEXT PRIMARY KEY, agents INTEGER NOT NULL, browsers INTEGER NOT NULL, turns INTEGER NOT NULL, dollars REAL NOT NULL, preview_origin TEXT NOT NULL)`;
  yield* sql`CREATE TABLE coordinator_plan(project_id TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,owner TEXT NOT NULL,criteria TEXT NOT NULL,thread_id TEXT NOT NULL,deps TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,extra_turns INTEGER NOT NULL DEFAULT 0,budget_turns INTEGER NOT NULL,budget_dollars REAL NOT NULL,extra_dollars REAL NOT NULL DEFAULT 0,PRIMARY KEY(project_id,id))`;
  yield* sql`CREATE TABLE coordinator_jobs(project_id TEXT NOT NULL,id TEXT NOT NULL,task TEXT NOT NULL,version INTEGER NOT NULL,base_ref TEXT NOT NULL,base_sha TEXT,kind TEXT NOT NULL,state TEXT NOT NULL,prompt TEXT NOT NULL,turns INTEGER NOT NULL,dollars REAL NOT NULL,result TEXT NOT NULL DEFAULT '',branch TEXT,used_turns INTEGER,used_dollars REAL,created INTEGER NOT NULL DEFAULT(unixepoch()),PRIMARY KEY(project_id,id))`;
  yield* sql`CREATE UNIQUE INDEX coordinator_job_active ON coordinator_jobs(project_id,task) WHERE state IN ('queued','running','cancelling')`;
  yield* sql`CREATE TABLE coordinator_budget_grants(project_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(project_id,id))`;
  yield* sql`CREATE TABLE coordinator_audit(project_id TEXT NOT NULL,action TEXT NOT NULL,actor_key TEXT NOT NULL,actor TEXT NOT NULL,revision TEXT NOT NULL,at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
  yield* sql`CREATE INDEX coordinator_project_audit ON coordinator_audit(project_id,at)`;
});
