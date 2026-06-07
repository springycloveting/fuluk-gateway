import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ECC_ROLE_PRESETS } from "./role_presets.mjs";
import { newId, nowIso, sanitizeTmuxName } from "./utils.mjs";
import { DEFAULT_WORKFLOW_TEMPLATE, normalizeWorkflowTemplate } from "./workflow_templates.mjs";

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
    this.db.prepare("delete from room_message_deliveries where session_id = ?").run(id);
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

  deleteRoom(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return false;
    this.db.prepare("delete from room_message_deliveries where message_id in (select id from room_messages where room_id = ?)").run(room.id);
    this.db.prepare("delete from room_messages where room_id = ?").run(room.id);
    this.db.prepare("delete from room_sessions where room_id = ?").run(room.id);
    this.db.prepare("delete from rooms where id = ?").run(room.id);
    return true;
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
    const previousRooms = this.listSessionRooms(session.id)
      .filter((membership) => membership.roomId !== room.id)
      .map((membership) => membership.roomId);
    this.db.prepare("delete from room_sessions where session_id = ? and room_id != ?").run(session.id, room.id);
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
    for (const previousRoomId of previousRooms) this.touchRoom(previousRoomId);
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

  createRoomMessage(input = {}) {
    const room = this.getRoom(input.roomId);
    if (!room) throw new Error(`Room not found: ${input.roomId}`);
    if (input.fromSessionId && !this.findByIdOrName(input.fromSessionId)) {
      throw new Error(`Session not found: ${input.fromSessionId}`);
    }
    const text = normalizeMessageText(input.text);
    const timestamp = nowIso();
    const message = {
      id: newId(),
      roomId: room.id,
      fromSessionId: input.fromSessionId ?? null,
      targetMode: input.targetMode ?? "all",
      targetRole: input.targetRole ?? null,
      targetSessionIds: Array.isArray(input.targetSessionIds) ? input.targetSessionIds : [],
      text,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      createdAt: timestamp
    };
    this.db
      .prepare(
        `insert into room_messages (
          id, room_id, from_session_id, target_mode, target_role, target_session_ids_json, text, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.roomId,
        message.fromSessionId,
        message.targetMode,
        message.targetRole,
        JSON.stringify(message.targetSessionIds),
        message.text,
        JSON.stringify(message.metadata),
        message.createdAt
      );
    this.touchRoom(room.id);
    return this.getRoomMessage(message.id);
  }

  addRoomMessageDelivery(messageId, sessionId, status = "pending", error = null) {
    const timestamp = nowIso();
    const result = this.db
      .prepare(
        `insert into room_message_deliveries (message_id, session_id, status, error, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(messageId, sessionId, status, error, timestamp, timestamp);
    return this.getRoomMessageDelivery(Number(result.lastInsertRowid));
  }

  updateRoomMessageDelivery(id, status, error = null) {
    this.db
      .prepare("update room_message_deliveries set status = ?, error = ?, updated_at = ? where id = ?")
      .run(status, error, nowIso(), id);
    return this.getRoomMessageDelivery(id);
  }

  getRoomMessageDelivery(id) {
    const row = this.db
      .prepare(
        `select d.*, s.name as session_name, s.kind as session_kind, s.status as session_status
         from room_message_deliveries d
         join sessions s on s.id = d.session_id
         where d.id = ?`
      )
      .get(id);
    return row ? mapRoomMessageDeliveryRow(row) : null;
  }

  getRoomMessage(id) {
    const row = this.db
      .prepare(
        `select m.*, s.name as from_session_name
         from room_messages m
         left join sessions s on s.id = m.from_session_id
         where m.id = ?`
      )
      .get(id);
    return row ? this.withRoomMessageDeliveries(mapRoomMessageRow(row)) : null;
  }

  listRoomMessages(roomId, limit = 100) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    const rows = this.db
      .prepare(
        `select m.*, s.name as from_session_name
         from room_messages m
         left join sessions s on s.id = m.from_session_id
         where m.room_id = ?
         order by m.created_at desc, m.id desc
         limit ?`
      )
      .all(room.id, Math.min(Math.max(Number(limit) || 100, 1), 500));
    return rows.map((row) => this.withRoomMessageDeliveries(mapRoomMessageRow(row))).reverse();
  }

  withRoomMessageDeliveries(message) {
    if (!message) return null;
    const deliveries = this.db
      .prepare(
        `select d.*, s.name as session_name, s.kind as session_kind, s.status as session_status
         from room_message_deliveries d
         join sessions s on s.id = d.session_id
         where d.message_id = ?
         order by d.created_at asc, d.id asc`
      )
      .all(message.id)
      .map(mapRoomMessageDeliveryRow);
    return { ...message, deliveries };
  }

  withSessionRooms(session) {
    if (!session) return null;
    return { ...session, rooms: this.listSessionRooms(session.id) };
  }

  withRoomSessions(room) {
    if (!room) return null;
    return { ...room, sessions: this.listRoomSessions(room.id) };
  }

  createWorkflowRun(input = {}) {
    const room = this.getRoom(input.roomId);
    if (!room) throw new Error(`Room not found: ${input.roomId}`);
    if (typeof input.objective !== "string" || !input.objective.trim()) throw new Error("workflow objective is required");
    const template = input.templateId ? this.getWorkflowTemplate(input.templateId) : DEFAULT_WORKFLOW_TEMPLATE;
    if (!template) throw new Error(`Workflow template not found: ${input.templateId}`);
    const definition = template.definition ?? template;
    const timestamp = nowIso();
    const run = {
      id: newId(),
      roomId: room.id,
      objective: input.objective.trim(),
      status: "draft",
      currentStage: definition.kind === "classic" ? "planning" : definition.stages[0].id,
      templateId: template.id,
      templateName: template.name,
      templateDefinition: definition,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null
    };
    this.db.prepare(
      `insert into workflow_runs (
        id, room_id, objective, status, current_stage, version, template_id, template_name, template_json,
        created_at, updated_at, started_at, completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id, run.roomId, run.objective, run.status, run.currentStage, run.version,
      run.templateId, run.templateName, JSON.stringify(run.templateDefinition),
      run.createdAt, run.updatedAt, run.startedAt, run.completedAt
    );
    return this.getWorkflowRun(run.id);
  }

  listWorkflowRuns(roomId) {
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    return this.db.prepare("select * from workflow_runs where room_id = ? order by created_at desc")
      .all(room.id)
      .map((row) => this.withWorkflowDetails(mapWorkflowRunRow(row)));
  }

  getWorkflowRun(runId) {
    const row = this.db.prepare("select * from workflow_runs where id = ?").get(runId);
    return row ? this.withWorkflowDetails(mapWorkflowRunRow(row)) : null;
  }

  startWorkflowRun(runId, input = {}) {
    const run = this.getWorkflowRun(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    if (run.status !== "draft") return run;
    const definition = run.templateDefinition ?? DEFAULT_WORKFLOW_TEMPLATE;
    const firstStage = definition.kind === "classic" ? { id: "planning", role: "planner", mode: "one" } : definition.stages[0];
    const members = this.listRoomSessions(run.roomId).filter((session) =>
      [session.role, session.rolePresetName, session.rolePresetLabel]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === firstStage.role.toLowerCase())
    );
    const targets = firstStage.mode === "all" ? members : members.slice(0, 1);
    if (!targets.length) throw new Error(`Workflow requires at least one ${firstStage.role} session`);
    const timestamp = nowIso();
    this.db.exec("begin immediate");
    try {
      const statement = this.db.prepare(
        `insert into workflow_assignments (
          id, run_id, work_item_id, gate_kind, role, session_id, attempt_no,
          status, dispatched_message_id, created_at, updated_at, finished_at
        ) values (?, ?, null, ?, ?, ?, 1, 'pending', null, ?, ?, null)`
      );
      for (const target of targets) statement.run(newId(), run.id, firstStage.id, firstStage.role, target.sessionId, timestamp, timestamp);
      this.db.prepare(
        "update workflow_runs set status = ?, version = version + 1, updated_at = ?, started_at = ? where id = ?"
      ).run(definition.kind === "classic" ? "planning" : "executing", timestamp, timestamp, run.id);
      this.db.prepare(
        "insert into workflow_events (id, run_id, event_key, event_type, created_at) values (?, ?, ?, 'workflow_started', ?)"
      ).run(newId(), run.id, input.eventKey || `start:${run.id}`, timestamp);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return this.getWorkflowRun(run.id);
  }

  markWorkflowAssignmentDispatched(assignmentId, messageId) {
    this.db.prepare(
      "update workflow_assignments set dispatched_message_id = ?, updated_at = ? where id = ?"
    ).run(messageId, nowIso(), assignmentId);
    const row = this.db.prepare("select * from workflow_assignments where id = ?").get(assignmentId);
    return row ? mapWorkflowAssignmentRow(row) : null;
  }

  getWorkflowAssignment(assignmentId) {
    const row = this.db.prepare("select * from workflow_assignments where id = ?").get(assignmentId);
    return row ? mapWorkflowAssignmentRow(row) : null;
  }

  createWorkflowAssignment(input = {}) {
    const timestamp = nowIso();
    const assignment = {
      id: newId(),
      runId: input.runId,
      workItemId: input.workItemId ?? null,
      gateKind: input.gateKind,
      role: input.role,
      sessionId: input.sessionId,
      attemptNo: Number(input.attemptNo) || 1,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.prepare(
      `insert into workflow_assignments (
        id, run_id, work_item_id, gate_kind, role, session_id, attempt_no,
        status, dispatched_message_id, result_message_id, created_at, updated_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, 'pending', null, null, ?, ?, null)`
    ).run(
      assignment.id, assignment.runId, assignment.workItemId, assignment.gateKind,
      assignment.role, assignment.sessionId, assignment.attemptNo, timestamp, timestamp
    );
    return this.getWorkflowAssignment(assignment.id);
  }

  finishWorkflowAssignment(assignmentId, status, resultMessageId) {
    const result = this.db.prepare(
      `update workflow_assignments
       set status = ?, result_message_id = ?, updated_at = ?, finished_at = ?
       where id = ? and result_message_id is null`
    ).run(status, resultMessageId, nowIso(), nowIso(), assignmentId);
    return { changed: Number(result.changes) > 0, assignment: this.getWorkflowAssignment(assignmentId) };
  }

  updateWorkflowRunState(runId, status, currentStage, options = {}) {
    const timestamp = nowIso();
    this.db.prepare(
      `update workflow_runs
       set status = ?, current_stage = ?, version = version + 1, updated_at = ?, completed_at = ?
       where id = ?`
    ).run(status, currentStage, timestamp, options.completed ? timestamp : null, runId);
    return this.getWorkflowRun(runId);
  }

  listWorkflowTemplates() {
    const custom = this.db.prepare("select * from workflow_templates order by updated_at desc").all().map(mapWorkflowTemplateRow);
    return [DEFAULT_WORKFLOW_TEMPLATE, ...custom];
  }

  getWorkflowTemplate(id) {
    if (!id || id === DEFAULT_WORKFLOW_TEMPLATE.id) return DEFAULT_WORKFLOW_TEMPLATE;
    const row = this.db.prepare("select * from workflow_templates where id = ?").get(id);
    return row ? mapWorkflowTemplateRow(row) : null;
  }

  createWorkflowTemplate(input = {}) {
    const definition = normalizeWorkflowTemplate(input);
    const timestamp = nowIso();
    const id = newId();
    this.db.prepare(
      "insert into workflow_templates (id, name, description, definition_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?)"
    ).run(id, definition.name, definition.description, JSON.stringify(definition), timestamp, timestamp);
    return this.getWorkflowTemplate(id);
  }

  updateWorkflowTemplate(id, input = {}) {
    if (id === DEFAULT_WORKFLOW_TEMPLATE.id) throw new Error("Built-in workflow template cannot be edited");
    const definition = normalizeWorkflowTemplate(input);
    const result = this.db.prepare(
      "update workflow_templates set name = ?, description = ?, definition_json = ?, updated_at = ? where id = ?"
    ).run(definition.name, definition.description, JSON.stringify(definition), nowIso(), id);
    if (!Number(result.changes)) throw new Error(`Workflow template not found: ${id}`);
    return this.getWorkflowTemplate(id);
  }

  deleteWorkflowTemplate(id) {
    if (id === DEFAULT_WORKFLOW_TEMPLATE.id) throw new Error("Built-in workflow template cannot be deleted");
    return Number(this.db.prepare("delete from workflow_templates where id = ?").run(id).changes) > 0;
  }

  withWorkflowDetails(run) {
    const runAssignments = this.db.prepare("select * from workflow_assignments where run_id = ? order by created_at")
      .all(run.id)
      .map(mapWorkflowAssignmentRow);
    return { ...run, workItems: [], runAssignments, artifacts: [] };
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

      create table if not exists room_messages (
        id text primary key,
        room_id text not null references rooms(id) on delete cascade,
        from_session_id text references sessions(id) on delete set null,
        target_mode text not null,
        target_role text,
        target_session_ids_json text not null,
        text text not null,
        metadata_json text not null,
        created_at text not null
      );

      create table if not exists room_message_deliveries (
        id integer primary key autoincrement,
        message_id text not null references room_messages(id) on delete cascade,
        session_id text not null references sessions(id) on delete cascade,
        status text not null,
        error text,
        created_at text not null,
        updated_at text not null
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

      create table if not exists workflow_runs (
        id text primary key,
        room_id text not null references rooms(id) on delete cascade,
        objective text not null,
        status text not null,
        current_stage text not null,
        version integer not null,
        template_id text,
        template_name text,
        template_json text,
        created_at text not null,
        updated_at text not null,
        started_at text,
        completed_at text
      );

      create table if not exists workflow_templates (
        id text primary key,
        name text not null,
        description text,
        definition_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists workflow_assignments (
        id text primary key,
        run_id text not null references workflow_runs(id) on delete cascade,
        work_item_id text,
        gate_kind text not null,
        role text not null,
        session_id text not null references sessions(id),
        attempt_no integer not null,
        status text not null,
        dispatched_message_id text,
        created_at text not null,
        updated_at text not null,
        finished_at text
      );

      create table if not exists workflow_events (
        id text primary key,
        run_id text not null references workflow_runs(id) on delete cascade,
        event_key text not null,
        event_type text not null,
        created_at text not null,
        unique (run_id, event_key)
      );

      create index if not exists idx_output_snapshots_session_id_id
        on output_snapshots(session_id, id desc);

      create index if not exists idx_input_history_session_id_created_at
        on input_history(session_id, created_at desc);

      create index if not exists idx_input_history_created_at
        on input_history(created_at desc);

      create index if not exists idx_room_sessions_session_id
        on room_sessions(session_id);

      create index if not exists idx_room_messages_room_created
        on room_messages(room_id, created_at desc);

      create index if not exists idx_room_message_deliveries_message_id
        on room_message_deliveries(message_id);
    `);
    this.ensureColumn("room_sessions", "role_preset_id", "text references role_presets(id) on delete set null");
    this.ensureColumn("room_sessions", "role_prompt", "text");
    this.ensureColumn("workflow_assignments", "dispatched_message_id", "text");
    this.ensureColumn("workflow_assignments", "result_message_id", "text");
    this.ensureColumn("workflow_runs", "template_id", "text");
    this.ensureColumn("workflow_runs", "template_name", "text");
    this.ensureColumn("workflow_runs", "template_json", "text");
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

function normalizeMessageText(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("message text is required");
  return text.trim();
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

function mapRoomMessageRow(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    fromSessionId: row.from_session_id,
    fromSessionName: row.from_session_name,
    targetMode: row.target_mode,
    targetRole: row.target_role,
    targetSessionIds: JSON.parse(row.target_session_ids_json || "[]"),
    text: row.text,
    metadata: JSON.parse(row.metadata_json || "{}"),
    createdAt: row.created_at
  };
}

function mapRoomMessageDeliveryRow(row) {
  return {
    id: Number(row.id),
    messageId: row.message_id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    sessionKind: row.session_kind,
    sessionStatus: row.session_status,
    status: row.status,
    error: row.error,
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

function mapWorkflowRunRow(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    objective: row.objective,
    status: row.status,
    currentStage: row.current_stage,
    version: Number(row.version),
    templateId: row.template_id || DEFAULT_WORKFLOW_TEMPLATE.id,
    templateName: row.template_name || DEFAULT_WORKFLOW_TEMPLATE.name,
    templateDefinition: row.template_json ? JSON.parse(row.template_json) : DEFAULT_WORKFLOW_TEMPLATE,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

function mapWorkflowTemplateRow(row) {
  const definition = JSON.parse(row.definition_json);
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    kind: definition.kind,
    stages: definition.stages,
    definition,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapWorkflowAssignmentRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    workItemId: row.work_item_id,
    role: row.role,
    sessionId: row.session_id,
    gateKind: row.gate_kind,
    attemptNo: Number(row.attempt_no),
    status: row.status,
    dispatchedMessageId: row.dispatched_message_id,
    resultMessageId: row.result_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
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
