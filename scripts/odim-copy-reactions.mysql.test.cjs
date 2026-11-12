'use strict';
// Exported for the isolated QA CLI adapter; never imports the live worker or app main.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');

async function runOdimCopyReactionSuite({ db, compiledRoot, migrationSql, log = console.log }) {
  const [database] = await db.$queryRawUnsafe('SELECT DATABASE() AS databaseName');
  assert.match(database?.databaseName || '', /^homolog-reaction-qa-\d{8}$/);
  const { processOdimMirrorWebhook, odimReactionSnapshot, odimMirrorSourceId } = require(path.join(compiledRoot, 'services/odim-copy-reactions.js'));
  const { WabaReactionReceiptsService: Ledger } = require(path.join(compiledRoot, 'services/waba-reaction-receipts.service.js'));
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS clients(id INT NOT NULL PRIMARY KEY,instance VARCHAR(191) NOT NULL,type VARCHAR(16) NOT NULL,waba_account_id VARCHAR(191),waba_phone_id VARCHAR(191),is_active BOOLEAN,phone VARCHAR(32)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    'CREATE TABLE IF NOT EXISTS messages(id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,instance VARCHAR(191) NOT NULL,client_id INT NOT NULL,waba_id VARCHAR(191) NOT NULL,`from` VARCHAR(191),`to` VARCHAR(191),chat_id INT,status VARCHAR(32),status_timestamp VARCHAR(191),body TEXT,UNIQUE KEY fixture_target(instance,client_id,waba_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    'CREATE TABLE IF NOT EXISTS message_reactions(id VARCHAR(191) NOT NULL PRIMARY KEY,instance VARCHAR(191) NOT NULL,client_id INT NOT NULL,target_message_id VARCHAR(255) NOT NULL,actor_id VARCHAR(191) NOT NULL,from_me BOOLEAN NOT NULL,emoji VARCHAR(64) NOT NULL,reacted_at DATETIME(3) NOT NULL,received_at DATETIME(3) NOT NULL,source_event_id VARCHAR(191),internal_user_id INT,internal_user_name VARCHAR(191),created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,UNIQUE KEY fixture_actor(instance,client_id,target_message_id,actor_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    'CREATE TABLE IF NOT EXISTS odim_operational_copy_webhooks(id CHAR(64) NOT NULL PRIMARY KEY,provider_id VARCHAR(191),kind VARCHAR(16),payload LONGTEXT,state VARCHAR(16) DEFAULT \'PENDING\',attempts INT DEFAULT 0,received_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
  ]) await db.$executeRawUnsafe(sql);
  // The ledger suite deliberately uses smaller tables. Add only fixture columns in this guarded scratch DB.
  for (const [table, definitions] of Object.entries({
    clients: { is_active: 'BOOLEAN', phone: 'VARCHAR(32)' },
    messages: { from: 'VARCHAR(191)', to: 'VARCHAR(191)', chat_id: 'INT', status: 'VARCHAR(32)', status_timestamp: 'VARCHAR(191)', body: 'TEXT' },
  })) {
    const columns = await db.$queryRawUnsafe('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', table);
    for (const [column, definition] of Object.entries(definitions)) if (!columns.some(row => row.name === column)) {
      await db.$executeRawUnsafe(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
  }
  if (migrationSql) await db.$executeRawUnsafe(migrationSql);

  const clientId = 1_500_000_000 + Math.floor(Math.random() * 100_000_000);
  const peer = '5511999900011', own = '5511888800011';
  const metadata = { accountId: '123456789', phoneNumberId: '987654321' };
  const now = new Date(), timestamp = Math.floor(now.getTime() / 1000);
  await db.$executeRawUnsafe("INSERT INTO clients(id,instance,type,waba_account_id,waba_phone_id,is_active,phone) VALUES(?,'odim','WABA',?,?,1,?)", clientId, metadata.accountId, metadata.phoneNumberId, own);
  let inTransaction = false, failQueue = false;
  const runtimeSql = [], notifications = [];
  const mysql = {
    async execute(sql, values = []) {
      runtimeSql.push(sql);
      if (failQueue && sql.startsWith('UPDATE odim_operational_copy_webhooks')) throw Error('FIXTURE_QUEUE_FAILURE');
      return /^SELECT\b/i.test(sql) ? [await db.$queryRawUnsafe(sql, ...values), []]
        : [{ affectedRows: await db.$executeRawUnsafe(sql, ...values) }, []];
    },
    async beginTransaction() { await db.$executeRawUnsafe('START TRANSACTION'); inTransaction = true; },
    async commit() { await db.$executeRawUnsafe('COMMIT'); inTransaction = false; },
    async rollback() { await db.$executeRawUnsafe('ROLLBACK'); inTransaction = false; },
  };
  const publish = {
    async message(change) { assert.equal(inTransaction, false); notifications.push({ kind: 'message', change }); },
    async reaction(change) {
      assert.equal(inTransaction, false);
      const snapshot = await odimReactionSnapshot(mysql, change.clientId, change.targetMessageId);
      if (snapshot) notifications.push({ kind: 'reaction', snapshot });
    },
  };
  async function target(wamid = 'wamid.bridge.' + randomUUID(), from = peer, to = 'me:odim-legacy-copy', owner = clientId, instance = 'odim') {
    await db.$executeRawUnsafe("INSERT INTO messages(instance,client_id,waba_id,`from`,`to`,chat_id,status,body) VALUES(?,?,?,?,?,8,'SENT','preserve normal bubble')", instance, owner, wamid, from, to);
    return wamid;
  }
  const inbound = (targetMessageId, emoji = '👍', time = timestamp) => ({ id: 'wamid.event.' + randomUUID(),
    type: 'reaction', from: peer, timestamp: String(time), reaction: { message_id: targetMessageId, emoji }, _inpulseWabaScope: metadata });
  async function queued(payload, kind = 'reaction') {
    const id = createHash('sha256').update(randomUUID()).digest('hex');
    await db.$executeRawUnsafe('INSERT INTO odim_operational_copy_webhooks(id,provider_id,kind,payload) VALUES(?,?,?,?)', id,
      kind === 'reaction' ? payload.reaction.message_id : payload.id, kind, JSON.stringify(payload));
    return { id, kind, payload };
  }
  const process = (event, observed = false) => processOdimMirrorWebhook(mysql, event, clientId, observed, publish, now);
  const row = async (wamid, actor = `${peer}@s.whatsapp.net`) => (await db.$queryRawUnsafe('SELECT emoji,reacted_at,updated_at,source_event_id FROM message_reactions WHERE instance=\'odim\' AND client_id=? AND target_message_id=? AND actor_id=?', clientId, wamid, actor))[0];
  const queue = async event => (await db.$queryRawUnsafe('SELECT state,attempts FROM odim_operational_copy_webhooks WHERE id=?', event.id))[0];
  const assertNoMessageWrites = () => assert.equal(runtimeSql.some(sql => /^(?:INSERT INTO|UPDATE|DELETE FROM)\s+`?(?:messages|chats)\b/i.test(sql)), false);

  const wamid = await target(), normalBefore = await db.$queryRawUnsafe('SELECT * FROM messages WHERE client_id=? ORDER BY id', clientId);
  const event = await queued(inbound(wamid));
  runtimeSql.length = 0;
  assert.equal(await process(event), true);
  assert.equal((await queue(event)).state, 'APPLIED');
  assert.equal(notifications.at(-1).snapshot.reactions[0].emoji, '👍');
  assert.equal(notifications.at(-1).snapshot.reactions[0].fromMe, false);
  const first = await row(wamid);
  assert.equal(await process(event), true);
  assert.deepEqual(await row(wamid), first);
  const removal = await queued(inbound(wamid, '', timestamp + 1));
  assert.equal(await process(removal), true);
  assert.equal((await row(wamid)).emoji, '');
  assert.equal(await process(event), true);
  assert.equal((await row(wamid)).emoji, '');
  assert.equal(notifications.at(-1).snapshot.reactions.length, 0);
  assertNoMessageWrites();
  assert.deepEqual(await db.$queryRawUnsafe('SELECT * FROM messages WHERE client_id=? ORDER BY id', clientId), normalBefore);
  log('PASS scoped inbound/duplicate/removal/out-of-order; queue atomic, publish after commit, no normal message writes');

  for (const patch of [
    { from: own }, { from: '5511777700011' }, { _inpulseWabaScope: { ...metadata, accountId: 'wrong' } },
    { _inpulseWabaScope: { ...metadata, phoneNumberId: 'wrong' } }, { _inpulseWabaScope: undefined },
  ]) {
    const invalid = await queued({ ...inbound(wamid), ...patch });
    assert.equal(await process(invalid), false);
    assert.equal((await queue(invalid)).state, 'PENDING');
  }
  await db.$executeRawUnsafe('UPDATE clients SET is_active=0 WHERE id=?', clientId);
  assert.equal(await process(await queued(inbound(wamid))), false);
  await db.$executeRawUnsafe('UPDATE clients SET is_active=1 WHERE id=?', clientId);
  const foreign = await target('wamid.foreign.' + randomUUID(), peer, 'me:odim-legacy-copy', clientId + 1, 'foreign');
  assert.equal(await process(await queued(inbound(foreign))), false);
  assert.equal(await row(foreign), undefined);
  log('PASS actor/account/phone/active/foreign target scopes reject unrelated reactions');

  const delayed = 'wamid.delayed.' + randomUUID();
  assert.equal(await process(await queued(inbound(delayed))), true);
  assert.equal(await process(await queued({ ...inbound(delayed), from: '5511777700011' })), true);
  assert.equal(await odimReactionSnapshot(mysql, clientId, delayed), null);
  await target(delayed);
  const delayedSnapshot = await odimReactionSnapshot(mysql, clientId, delayed);
  assert.equal(delayedSnapshot.reactions.length, 1);
  assert.equal(delayedSnapshot.reactions[0].actorId, `${peer}@s.whatsapp.net`);
  const legacyTarget = 'wamid.legacy.' + randomUUID(), legacyPayload = inbound(legacyTarget);
  delete legacyPayload._inpulseWabaScope;
  const legacy = await queued(legacyPayload, 'message');
  assert.equal(odimMirrorSourceId(legacy.kind, legacy.payload, legacy.payload.id), legacyTarget);
  assert.equal(await process(legacy), false);
  await target(legacyTarget);
  assert.equal(await process(legacy), true);
  assert.equal((await queue(legacy)).state, 'APPLIED');
  log('PASS target-late catchup filters actor; old kind=message reaction resolves through proven target');

  const beforeRollback = await row(wamid), beforeNotifications = notifications.length;
  const rollback = await queued(inbound(wamid, '❤️', timestamp + 2));
  failQueue = true;
  await assert.rejects(process(rollback), /FIXTURE_QUEUE_FAILURE/);
  failQueue = false;
  assert.deepEqual(await row(wamid), beforeRollback);
  assert.equal((await queue(rollback)).state, 'PENDING');
  assert.equal(notifications.length, beforeNotifications);
  log('PASS queue failure rolls back projection and emits nothing');

  const ownTarget = await target(undefined, 'me:odim-legacy-copy', peer);
  const ledger = new Ledger(db, () => now);
  const operation = await ledger.prepare({ instance: 'odim', clientId, targetMessageId: ownTarget, to: peer, emoji: '👍', internalUserId: 7, internalUserName: 'Fixture' });
  const receiptId = 'wamid.receipt.' + randomUUID();
  await db.$transaction(connection => new Ledger(connection, () => now).accept(operation.id, receiptId));
  const beforeReceipt = await db.$queryRawUnsafe('SELECT * FROM messages WHERE client_id=? ORDER BY id', clientId);
  const receipt = await queued({ id: receiptId, status: 'failed', recipient_id: peer, timestamp: String(timestamp),
    biz_opaque_callback_data: operation.callbackData, _inpulseWabaScope: metadata }, 'status');
  runtimeSql.length = 0;
  assert.equal(await process(receipt, true), true); // Ledger precedes even an observed legacy row.
  assert.equal((await queue(receipt)).state, 'APPLIED');
  assert.equal((await row(ownTarget, 'self')).emoji, '');
  assertNoMessageWrites();
  assert.deepEqual(await db.$queryRawUnsafe('SELECT * FROM messages WHERE client_id=? ORDER BY id', clientId), beforeReceipt);
  assert.equal(notifications.at(-1).kind, 'reaction');
  const beforeInvalidCallback = notifications.length;
  const invalidCallback = await queued({ id: ownTarget, status: 'read', recipient_id: peer, timestamp: String(timestamp),
    biz_opaque_callback_data: 'inpulse:reaction:not-uuid', _inpulseWabaScope: metadata }, 'status');
  assert.equal(await process(invalidCallback, true), false);
  assert.equal((await queue(invalidCallback)).state, 'PENDING');
  const [preservedNormal] = await db.$queryRawUnsafe('SELECT status FROM messages WHERE instance=\'odim\' AND client_id=? AND waba_id=?', clientId, ownTarget);
  assert.equal(preservedNormal.status, 'SENT');
  assert.equal(notifications.length, beforeInvalidCallback);
  assertNoMessageWrites();
  log('PASS invalid inpulse:reaction:not-uuid callback stays PENDING and cannot update a known normal message');
  const status = await queued({ id: ownTarget, status: 'read', recipient_id: peer, timestamp: String(timestamp), _inpulseWabaScope: metadata }, 'status');
  assert.equal(await process(status), true);
  assert.equal(notifications.at(-1).kind, 'message');
  const [normal] = await db.$queryRawUnsafe('SELECT status FROM messages WHERE instance=\'odim\' AND client_id=? AND waba_id=?', clientId, ownTarget);
  assert.equal(normal.status, 'READ');
  log('PASS outgoing receipt ledger precedes normal status; ordinary status path remains functional');
  return { passed: true, actualMysql: true, clientId, assertions: 7, providerCalls: 0 };
}
module.exports = { runOdimCopyReactionSuite };
