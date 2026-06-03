import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ECC_ROLE_PRESETS } from "./role_presets.mjs";
import { newId, nowIso, sanitizeTmuxName } from "./utils.mjs";

export class SessionStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.migrate();
  }

  create(input, command, baseCommandArgs = []) {
    const id = newId();
    const record = buildSessionRecord(id, input, command, baseCommandArgs);

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

  replace(id, input, command, baseCommandArgs = []) {
    const existing = this.findByIdOrName(id);
    if (!existing) throw new Error(`Session not found: ${id}`);

    const record = buildSessionRecord(id, { ...input, name: existing.name }, command, baseCommandArgs, {
      createdAt: existing.createdAt
    });

    this.db
      .prepare("delete from output_snapshots where session_id = ?")
      .run(id);
    this.db
      .prepare(
        `update sessions
         set kind = ?,
             cwd = ?,
             project = ?,
             tmux_session_name = ?,
             command = ?,
             command_args = ?,
             status = ?,
             updated_at = ?,
             stopped_at = ?
         where id = ?`
      )
      .run(
        record.kind,
        record.cwd,
        record.project,
        record.tmuxSessionName,
        record.command,
        JSON.stringify(record.commandArgs),
        record.status,
        record.updatedAt,
        record.stoppedAt,
        record.id
      );

    return record;
  }

  list() {
    return this.db
      .prepare("select * from sessions order by updated_at desc, created_at desc")
      .all()
      .map((row) => this.withSessionRooms(mapSessionRow(row)));
  }

  findByIdOrName(idOrName) {
    const row = this.db
      .prepare("select * from sessions where id = ? or name = ? limit 1")
      .get(idOrName, idOrName);
    return row ? this.withSessionRooms(mapSessionRow(row)) : null;
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

  saveOutput(sessionId, lines, text, options = {}) {
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

    if (options.touch !== false) this.touch(sessionId);

    return {
      id: Number(result.lastInsertRowid),
      sessionId,
      capturedAt,
      lines,
      text
    };
  }

  latestOutputSnapshot(sessionId) {
    const row = this.db
      .prepare("select * from output_snapshots where session_id = ? order by id desc limit 1")
      .get(sessionId);
    return row ? mapOutputSnapshotRow(row) : null;
  }

  delete(id) {
    this.db.prepare("delete from room_sessions where session_id = ?").run(id);
    this.db.prepare("delete from input_history where session_id = ?").run(id);
    this.db.prepare("delete from output_snapshots where session_id = ?").run(id);
    const result = this.db.prepare("delete from sessions where id = ?").run(id);
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }

  saveInput(sessionId, text) {
    const timestamp = nowIso();
    this.db
      .prepare("insert into input_history (session_id, text, created_at) values (?, ?, ?)")
      .run(sessionId, text, timestamp);
    return { sessionId, text, createdAt: timestamp };
  }

  listInputHistory(sessionId, limit = 100) {
    return this.db
      .prepare("select * from input_history where session_id = ? order by created_at desc limit ?")
      .all(sessionId, limit)
      .map(mapInputHistoryRow);
  }

  listAllInputHistory(limit = 200) {
    return this.db
      .prepare(`
        select h.*, s.name as session_name, s.kind as session_kind
        from input_history h
        left join sessions s on h.session_id = s.id
        order by h.created_at desc
        limit ?
      `)
      .all(limit)
      .map(mapInputHistoryRow);
  }

  createRoom(input = {}) {
    const timestamp = nowIso();
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : `room-${timestamp}`;
    const room = {
      id: newId(),
      name,
      objective: typeof input.objective === "string" && input.objective.trim() ? input.objective.trim() : null,
      project: typeof input.project === "string" && input.project.trim() ? input.project.trim() : null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db
      .prepare(
        `insert into rooms (id, name, objective, project, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(room.id, room.name, room.objective, room.project, room.createdAt, room.updatedAt);
    return this.getRoom(room.id);
  }

  listRooms() {
    return this.db
      .prepare("select * from rooms order by updated_at desc, created_at desc")
      .all()
      .map((row) => this.withRoomSessions(mapRoomRow(row)));
  }

  getRoom(idOrName) {
    const row = this.db
      .prepare("select * from rooms where id = ? or name = ? limit 1")
      .get(idOrName, idOrName);
    return row ? this.withRoomSessions(mapRoomRow(row)) : null;
  }

  assignSessionToRoom(roomId, sessionId, role = null, options = {}) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    const session = this.findByIdOrName(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const timestamp = nowIso();
    const preset = options.rolePresetId ? this.getRolePreset(options.rolePresetId) : null;
    if (options.rolePresetId && !preset) throw new Error(`Role preset not found: ${options.rolePresetId}`);
    const normalizedRole = normalizeRole(role) ?? preset?.label ?? preset?.name ?? null;
    const rolePrompt = normalizeRolePrompt(options.rolePrompt ?? preset?.prompt);
    this.db
      .prepare(
        `insert into room_sessions (room_id, session_id, role, role_preset_id, role_prompt, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(room_id, session_id) do update set
           role = excluded.role,
           role_preset_id = excluded.role_preset_id,
           role_prompt = excluded.role_prompt,
           updated_at = excluded.updated_at`
      )
      .run(room.id, session.id, normalizedRole, preset?.id ?? null, rolePrompt, timestamp, timestamp);
    this.touchRoom(room.id);
    return this.getRoomSession(room.id, session.id);
  }

  listRolePresets() {
    return this.db
      .prepare("select * from role_presets order by name asc")
      .all()
      .map(mapRolePresetRow);
  }

  getRolePreset(idOrName) {
    const row = this.db
      .prepare("select * from role_presets where id = ? or name = ? limit 1")
      .get(idOrName, idOrName);
    return row ? mapRolePresetRow(row) : null;
  }

  getRoomSession(roomId, sessionId) {
    const row = this.db
      .prepare(
        `select rs.*, r.name as room_name, r.objective as room_objective, r.project as room_project,
                s.name as session_name, s.kind as session_kind, s.status as session_status, s.cwd as session_cwd,
                rp.name as role_preset_name, rp.label as role_preset_label, rp.description as role_preset_description
         from room_sessions rs
         join rooms r on r.id = rs.room_id
         join sessions s on s.id = rs.session_id
         left join role_presets rp on rp.id = rs.role_preset_id
         where rs.room_id = ? and rs.session_id = ?`
      )
      .get(roomId, sessionId);
    return row ? mapRoomSessionRow(row) : null;
  }

  listRoomSessions(roomId) {
    return this.db
      .prepare(
        `select rs.*, r.name as room_name, r.objective as room_objective, r.project as room_project,
                s.name as session_name, s.kind as session_kind, s.status as session_status, s.cwd as session_cwd,
                rp.name as role_preset_name, rp.label as role_preset_label, rp.description as role_preset_description
         from room_sessions rs
         join rooms r on r.id = rs.room_id
         join sessions s on s.id = rs.session_id
         left join role_presets rp on rp.id = rs.role_preset_id
         where rs.room_id = ?
         order by rs.updated_at desc, rs.created_at desc`
      )
      .all(roomId)
      .map(mapRoomSessionRow);
  }

  listSessionRooms(sessionId) {
    return this.db
      .prepare(
        `select rs.*, r.name as room_name, r.objective as room_objective, r.project as room_project,
                s.name as session_name, s.kind as session_kind, s.status as session_status, s.cwd as session_cwd,
                rp.name as role_preset_name, rp.label as role_preset_label, rp.description as role_preset_description
         from room_sessions rs
         join rooms r on r.id = rs.room_id
         join sessions s on s.id = rs.session_id
         left join role_presets rp on rp.id = rs.role_preset_id
         where rs.session_id = ?
         order by rs.updated_at desc, rs.created_at desc`
      )
      .all(sessionId)
      .map(mapRoomSessionRow);
  }

  touchRoom(roomId) {
    this.db.prepare("update rooms set updated_at = ? where id = ?").run(nowIso(), roomId);
  }

  withSessionRooms(session) {
    if (!session) return null;
    return { ...session, rooms: this.listSessionRooms(session.id) };
  }

  withRoomSessions(room) {
    if (!room) return null;
    return { ...room, sessions: this.listRoomSessions(room.id) };
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

      create table if not exists input_history (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        text text not null,
        created_at text not null
      );

      create table if not exists rooms (
        id text primary key,
        name text not null unique,
        objective text,
        project text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists room_sessions (
        room_id text not null references rooms(id) on delete cascade,
        session_id text not null references sessions(id) on delete cascade,
        role text,
        role_preset_id text references role_presets(id) on delete set null,
        role_prompt text,
        created_at text not null,
        updated_at text not null,
        primary key (room_id, session_id)
      );

      create table if not exists role_presets (
        id text primary key,
        name text not null unique,
        label text not null,
        description text,
        default_kind text,
        model_hint text,
        tools_json text not null,
        skills_json text not null,
        prompt text not null,
        source_url text,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_output_snapshots_session_id_id
        on output_snapshots(session_id, id desc);

      create index if not exists idx_input_history_session_id_created_at
        on input_history(session_id, created_at desc);

      create index if not exists idx_input_history_created_at
        on input_history(created_at desc);

      create index if not exists idx_room_sessions_session_id
        on room_sessions(session_id);
    `);
    this.ensureColumn("room_sessions", "role_preset_id", "text references role_presets(id) on delete set null");
    this.ensureColumn("room_sessions", "role_prompt", "text");
    this.seedRolePresets();
  }

  ensureColumn(table, column, definition) {
    const exists = this.db.prepare(`pragma table_info(${table})`).all().some((row) => row.name === column);
    if (!exists) this.db.exec(`alter table ${table} add column ${column} ${definition}`);
  }

  seedRolePresets() {
    const timestamp = nowIso();
    const statement = this.db.prepare(
      `insert into role_presets (
        id, name, label, description, default_kind, model_hint, tools_json, skills_json, prompt, source_url, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        label = excluded.label,
        description = excluded.description,
        default_kind = excluded.default_kind,
        model_hint = excluded.model_hint,
        tools_json = excluded.tools_json,
        skills_json = excluded.skills_json,
        prompt = excluded.prompt,
        source_url = excluded.source_url,
        updated_at = excluded.updated_at`
    );
    for (const preset of ECC_ROLE_PRESETS) {
      statement.run(
        preset.id,
        preset.name,
        preset.label,
        preset.description ?? null,
        preset.defaultKind ?? null,
        preset.modelHint ?? null,
        JSON.stringify(preset.tools ?? []),
        JSON.stringify(preset.skills ?? []),
        preset.prompt,
        preset.sourceUrl ?? null,
        timestamp,
        timestamp
      );
    }
  }
}

function buildSessionRecord(id, input, command, baseCommandArgs, options = {}) {
  const name = input.name?.trim() || `${input.kind}-${id.slice(0, 8)}`;
  const timestamp = nowIso();
  return {
    id,
    name,
    kind: input.kind,
    cwd: input.cwd,
    project: input.project ?? null,
    tmuxSessionName: sanitizeTmuxName(name),
    command,
    commandArgs: [...baseCommandArgs, ...(input.commandArgs ?? [])],
    status: "running",
    createdAt: options.createdAt ?? timestamp,
    updatedAt: timestamp,
    stoppedAt: null
  };
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

function normalizeRole(role) {
  if (role == null) return null;
  if (typeof role !== "string") throw new Error("role must be a string");
  const normalized = role.trim();
  return normalized || null;
}

function normalizeRolePrompt(prompt) {
  if (prompt == null) return null;
  if (typeof prompt !== "string") throw new Error("rolePrompt must be a string");
  const normalized = prompt.trim();
  return normalized || null;
}

function mapRoomRow(row) {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    project: row.project,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRoomSessionRow(row) {
  return {
    roomId: row.room_id,
    roomName: row.room_name,
    roomObjective: row.room_objective,
    roomProject: row.room_project,
    sessionId: row.session_id,
    sessionName: row.session_name,
    sessionKind: row.session_kind,
    sessionStatus: row.session_status,
    sessionCwd: row.session_cwd,
    role: row.role,
    rolePresetId: row.role_preset_id,
    rolePresetName: row.role_preset_name,
    rolePresetLabel: row.role_preset_label,
    rolePresetDescription: row.role_preset_description,
    rolePrompt: row.role_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRolePresetRow(row) {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description,
    defaultKind: row.default_kind,
    modelHint: row.model_hint,
    tools: JSON.parse(row.tools_json),
    skills: JSON.parse(row.skills_json),
    prompt: row.prompt,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapInputHistoryRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionName: row.session_name ?? null,
    sessionKind: row.session_kind ?? null,
    text: row.text,
    createdAt: row.created_at
  };
}

function mapOutputSnapshotRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    capturedAt: row.captured_at,
    lines: row.lines,
    text: row.text
  };
}
