import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function turnIdFor(threadId, sourceId) {
  const h = crypto.createHash('sha256').update(`${threadId}:${sourceId}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}

// Caller must archive/unload the destination first. These UI events do not add
// ResponseItems: the model history already inserted by inject_items is retained.
export async function materializeVisibleHistory({ threadId, rolloutPath, turns, codexHome }) {
  const original = fs.readFileSync(rolloutPath, 'utf8');
  const records = original.split('\n').filter(Boolean).map(JSON.parse);
  if (records[0]?.type !== 'session_meta' || records[0].payload.id !== threadId) {
    throw new Error('Refusing history repair: destination session ID mismatch');
  }
  const existing = new Set(records.filter(r => r.type === 'event_msg' && r.payload.type === 'task_started').map(r => r.payload.turn_id));
  const events = [];
  let copiedTurns = 0;
  let copiedItems = 0;
  for (const turn of turns) {
    if (!turn.messages.length) continue;
    const turnId = turnIdFor(threadId, turn.id);
    if (existing.has(turnId)) continue;
    const started = turn.startedAt || 0;
    const completed = turn.completedAt || started;
    const stamp = new Date(started * 1000).toISOString();
    const add = payload => events.push({ timestamp: stamp, type: 'event_msg', payload });
    add({ type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: started });
    let lastAgent = null;
    for (const [index, message] of turn.messages.entries()) {
      const text = message.content.filter(c => typeof c.text === 'string').map(c => c.text).join('\n');
      if (!text) continue;
      const id = turnIdFor(threadId, `${turn.id}:${index}`);
      const item = message.role === 'user'
        ? { type: 'UserMessage', id, content: [{ type: 'text', text, text_elements: [] }] }
        : { type: 'AgentMessage', id, content: [{ type: 'Text', text }], phase: message.phase || 'final_answer' };
      if (message.role === 'assistant') lastAgent = text;
      add({ type: 'item_completed', thread_id: threadId, turn_id: turnId, item, started_at_ms: started * 1000, completed_at_ms: completed * 1000 });
      copiedItems++;
    }
    add({ type: 'task_complete', turn_id: turnId, last_agent_message: lastAgent, started_at: started, completed_at: completed, duration_ms: Math.max(0, (completed - started) * 1000) });
    copiedTurns++;
  }
  // Rebuilding the projection is also safe on a repeated repair.
  const rebuilt = [records[0], ...events, ...records.slice(1)].map((r, ordinal) => ({ ...r, ordinal }));
  const backupDir = path.join(codexHome, 'safe-switch-proxy', 'state', 'history-backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDir, `${threadId}-${Date.now()}.jsonl`);
  fs.writeFileSync(backup, original, { mode: 0o600 });
  const temporary = `${rolloutPath}.repair-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, rebuilt.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  // This database is a disposable UI index. Reset only the repaired thread so
  // the app rebuilds it from the now-complete, durable rollout on its next read.
  let db;
  try {
    const dbPath = path.join(codexHome, 'thread_history_1.sqlite');
    if (fs.existsSync(dbPath)) {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      for (const table of ['thread_turns', 'thread_items', 'thread_realtime_items', 'thread_history_projection_state']) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
          db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId);
        }
      }
    }
    if (db) projectVisibleHistory(db, threadId, rebuilt);
    fs.renameSync(temporary, rolloutPath);
    db?.exec('COMMIT');
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch {}
    fs.copyFileSync(backup, rolloutPath);
    throw error;
  } finally {
    db?.close();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { copiedTurns, copiedItems, backup };
}

function projectVisibleHistory(db, threadId, records) {
  const turns = new Map();
  const items = [];
  let offset = 0;
  for (const record of records) {
    const startOffset = offset;
    offset += Buffer.byteLength(JSON.stringify(record) + '\n');
    const p = record.payload;
    if (record.type !== 'event_msg') continue;
    if (p.type === 'task_started') {
      turns.set(p.turn_id, { id: p.turn_id, ordinal: record.ordinal, startOffset, status: 'inProgress', started: p.started_at || 0 });
    } else if (p.type === 'task_complete') {
      const t = turns.get(p.turn_id);
      if (t) Object.assign(t, { status: 'completed', completed: p.completed_at, duration: p.duration_ms, endOrdinal: record.ordinal + 1, endOffset: offset });
    } else if (p.type === 'item_completed') {
      const t = turns.get(p.turn_id);
      if (!t) throw new Error('UI item has no owning turn');
      const item = p.item;
      let projected;
      if (item.type === 'UserMessage') {
        projected = {type:'userMessage',id:item.id,clientId:item.client_id || null,content:item.content};
        t.firstUser ||= item.id;
      } else if (item.type === 'AgentMessage') {
        projected = {type:'agentMessage',id:item.id,text:item.content.filter(c=>c.type==='Text').map(c=>c.text).join(''),phase:item.phase || null,memoryCitation:null,delivery:null};
        t.finalAgent = item.id;
      } else {
        throw new Error(`Unsupported existing UI item ${item.type}; original rollout retained`);
      }
      items.push({turnId:p.turn_id,item:projected,ordinal:record.ordinal,created:p.started_at_ms || 0});
    }
  }
  for (const t of turns.values()) {
    db.prepare('INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status,started_at,completed_at,duration_ms,first_user_item_id,final_agent_item_id,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(threadId,t.id,t.ordinal,t.status,t.started,t.completed ?? null,t.duration ?? null,t.firstUser || null,t.finalAgent || null,t.startOffset,t.endOrdinal ?? null,t.endOffset ?? null);
  }
  for (const i of items) {
    db.prepare('INSERT INTO thread_items (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type,updated_at_ordinal) VALUES (?,?,?,?,?,?,?,?)')
      .run(threadId,i.turnId,i.item.id,i.ordinal,i.created,JSON.stringify(i.item),i.item.type,i.ordinal);
  }
  db.prepare('INSERT INTO thread_history_projection_state (thread_id,next_rollout_byte_offset,next_rollout_ordinal) VALUES (?,?,?)')
    .run(threadId,offset,records.length);
}
