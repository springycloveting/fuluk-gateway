import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId, nowIso, sanitizeTmuxName } from "./utils.mjs";

export class SessionStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.migrate();
  }

  create(input, command, baseCommandArgs = []) {
    const id = newId();
    const name = input.name?.trim() || `${input.kind}-${id.slice(0, 8)}`;
    const timestamp = nowIso();
    const record = {
      id,
      name,
      kind: input.kind,
      cwd: input.cwd,
      project: input.project ?? null,
      tmuxSessionName: sanitizeTmuxName(name),
      command,
      commandArgs: [...baseCommandArgs, ...(input.commandArgs ?? [])],
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      stoppedAt: null
    };

    this.db
      .prepare(
        `insert into sessions (
          id, name, kind, cwd, project, tmux_session_name, command, command_args,
          status, created_at, updated_at, stopped_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.name,
        record.kind,
        record.cwd,
        record.project,
        record.tmuxSessionName,
        record.command,
        JSON.stringify(record.commandArgs),
        record.status,
        record.createdAt,
        record.updatedAt,
        record.stoppedAt
      );

    return record;
  }

  list() {
    return this.db
      .prepare("select * from sessions order by updated_at desc, created_at desc")
      .all()
      .map(mapSessionRow);
  }

  findByIdOrName(idOrName) {
    const row = this.db
      .prepare("select * from sessions where id = ? or name = ? limit 1")
      .get(idOrName, idOrName);
    return row ? mapSessionRow(row) : null;
  }

  updateStatus(id, status) {
    const timestamp = nowIso();
    this.db
      .prepare("update sessions set status = ?, updated_at = ?, stopped_at = ? where id = ?")
      .run(status, timestamp, status === "running" ? null : timestamp, id);
  }

  markRunning(id) {
    this.db
      .prepare("update sessions set status = 'running', updated_at = ?, stopped_at = null where id = ?")
      .run(nowIso(), id);
  }

  touch(id) {
    this.db.prepare("update sessions set updated_at = ? where id = ?").run(nowIso(), id);
  }

  saveOutput(sessionId, lines, text) {
    const capturedAt = nowIso();
    const result = this.db
      .prepare("insert into output_snapshots (session_id, captured_at, lines, text) values (?, ?, ?, ?)")
      .run(sessionId, capturedAt, lines, text);

    this.db
      .prepare(
        `delete from output_snapshots
         where session_id = ?
         and id not in (
           select id from output_snapshots where session_id = ? order by id desc limit 50
         )`
      )
      .run(sessionId, sessionId);

    this.touch(sessionId);

    return {
      id: Number(result.lastInsertRowid),
      sessionId,
      capturedAt,
      lines,
      text
    };
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        name text not null unique,
        kind text not null,
        cwd text not null,
        project text,
        tmux_session_name text not null unique,
        command text not null,
        command_args text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        stopped_at text
      );

      create table if not exists output_snapshots (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        captured_at text not null,
        lines integer not null,
        text text not null
      );

      create index if not exists idx_output_snapshots_session_id_id
        on output_snapshots(session_id, id desc);
    `);
  }
}

function mapSessionRow(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    cwd: row.cwd,
    project: row.project,
    tmuxSessionName: row.tmux_session_name,
    command: row.command,
    commandArgs: JSON.parse(row.command_args),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at
  };
}
