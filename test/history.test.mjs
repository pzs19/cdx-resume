import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { materializeVisibleHistory } from '../history.mjs';
const home = fs.mkdtempSync(path.join(os.tmpdir(),'cdx-ui-history-'));
const rolloutPath = path.join(home,'rollout.jsonl');
const db = new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
db.exec("CREATE TABLE thread_turns (\n    thread_id TEXT NOT NULL,\n    turn_id TEXT NOT NULL,\n    rollout_ordinal INTEGER NOT NULL,\n    status TEXT NOT NULL,\n    error_json TEXT,\n    started_at INTEGER,\n    completed_at INTEGER,\n    duration_ms INTEGER,\n    first_user_item_id TEXT,\n    final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER,\n    PRIMARY KEY (thread_id, turn_id)\n);\nCREATE TABLE thread_items (\n    thread_id TEXT NOT NULL,\n    turn_id TEXT NOT NULL,\n    item_id TEXT NOT NULL,\n    rollout_ordinal INTEGER NOT NULL,\n    created_at_ms INTEGER NOT NULL,\n    item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0,\n    PRIMARY KEY (thread_id, turn_id, item_id)\n);\nCREATE TABLE thread_history_projection_state (\n    thread_id TEXT PRIMARY KEY,\n    next_rollout_byte_offset INTEGER NOT NULL,\n    next_rollout_ordinal INTEGER NOT NULL\n);\nCREATE TABLE thread_realtime_items (\n    thread_id TEXT NOT NULL,\n    item_id TEXT NOT NULL,\n    rollout_ordinal INTEGER NOT NULL,\n    created_at_ms INTEGER NOT NULL,\n    item_type TEXT NOT NULL,\n    item_json TEXT NOT NULL,\n    PRIMARY KEY (thread_id, item_id)\n);");
db.prepare('INSERT INTO thread_history_projection_state VALUES (?,?,?)').run('unrelated',100,2);
const response = {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'model context'}]}};
const original = [{type:'session_meta',payload:{id:'destination'}},response];
fs.writeFileSync(rolloutPath,original.map(r=>JSON.stringify(r)).join('\n')+'\n');
const options = {threadId:'destination',rolloutPath,codexHome:home,turns:[
 {id:'old-1',startedAt:100,completedAt:105,messages:[{role:'user',content:[{text:'question'}]},{role:'assistant',content:[{text:'answer\u2028line\u2029paragraph'}]}]},
 {id:'old-2',startedAt:110,completedAt:112,messages:[{role:'user',content:[{text:'follow up'}]}]},
]};
try {
 const result = await materializeVisibleHistory(options);
 assert.equal(result.copiedTurns,2);assert.equal(result.copiedItems,3);
 const persisted = fs.readFileSync(rolloutPath,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(persisted.filter(r=>r.type==='response_item').map(({ordinal,...r})=>r),[response]);
 assert.equal(db.prepare('SELECT count(*) n FROM thread_turns WHERE thread_id=?').get('destination').n,2);
 assert.equal(db.prepare('SELECT count(*) n FROM thread_items WHERE thread_id=?').get('destination').n,3);
 assert.equal(db.prepare('SELECT next_rollout_byte_offset n FROM thread_history_projection_state WHERE thread_id=?').get('destination').n,fs.statSync(rolloutPath).size);
 assert.equal(db.prepare('SELECT next_rollout_byte_offset n FROM thread_history_projection_state WHERE thread_id=?').get('unrelated').n,100);
 const before=fs.readFileSync(rolloutPath,'utf8');
 assert.equal((await materializeVisibleHistory(options)).copiedItems,0);
 assert.equal(fs.readFileSync(rolloutPath,'utf8'),before);
 await assert.rejects(materializeVisibleHistory({...options,threadId:'wrong'}),/ID mismatch/);
 assert.equal(fs.readFileSync(rolloutPath,'utf8'),before);
 console.log('visible history persistence, projection, idempotence and isolation tests passed');
} finally {db.close();fs.rmSync(home,{recursive:true,force:true});}
