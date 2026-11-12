'use strict';
// Explicit isolated-fixture QA. Never accepts an application database name.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function runWabaReactionReceiptSuite({ db, createSecondAdapter, compiledRoot, migrationSql, log = console.log }) {
  const [database] = await db.$queryRawUnsafe('SELECT DATABASE() AS databaseName');
  assert.match(database?.databaseName || '', /^homolog-reaction-qa-\d{8}$/);
  const { WabaReactionReceiptsService: Store } = require(path.join(compiledRoot, 'services/waba-reaction-receipts.service.js'));
  const { WABA_REACTION_SCHEMA_SQL, assertWabaReactionOperationsSchema } = require(path.join(compiledRoot, 'services/waba-reaction-schema.js'));
  // These three deliberately minimal fixture tables exist only in the scratch DB.
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS clients(id INT NOT NULL PRIMARY KEY,instance VARCHAR(191) NOT NULL,type VARCHAR(16) NOT NULL,waba_account_id VARCHAR(191),waba_phone_id VARCHAR(191)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    'CREATE TABLE IF NOT EXISTS messages(id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,instance VARCHAR(191) NOT NULL,client_id INT NOT NULL,waba_id VARCHAR(191) NOT NULL,UNIQUE KEY fixture_target(instance,client_id,waba_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
    'CREATE TABLE IF NOT EXISTS message_reactions(id VARCHAR(191) NOT NULL PRIMARY KEY,instance VARCHAR(191) NOT NULL,client_id INT NOT NULL,target_message_id VARCHAR(255) NOT NULL,actor_id VARCHAR(191) NOT NULL,from_me BOOLEAN NOT NULL,emoji VARCHAR(64) NOT NULL,reacted_at DATETIME(3) NOT NULL,received_at DATETIME(3) NOT NULL,source_event_id VARCHAR(191),internal_user_id INT,internal_user_name VARCHAR(191),created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,UNIQUE KEY fixture_actor(instance,client_id,target_message_id,actor_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
  ]) await db.$executeRawUnsafe(sql);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS `waba_reaction_operations`/);
  await db.$executeRawUnsafe(migrationSql);
  await db.$executeRawUnsafe(migrationSql); // Migration is idempotent and the validator rejects drift.
  const schema = await db.$queryRawUnsafe(WABA_REACTION_SCHEMA_SQL);
  assertWabaReactionOperationsSchema(schema);
  assert.throws(() => assertWabaReactionOperationsSchema(schema.filter(row => row.name !== 'sequence')));
  log('PASS schema + repeated migration + drift detection');

  let tick = Date.parse('2026-11-12T20:00:00Z');
  const now = () => new Date(tick++);
  const store = new Store(db, now);
  const tx = callback => db.$transaction(connection => callback(new Store(connection, now)));
  const seed = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  let counter = 0;
  async function fixture() {
    const clientId = seed + counter++, targetMessageId = 'wamid.fixture.' + randomUUID();
    const input = { instance: 'reaction-fixture', clientId, targetMessageId, to: '5511999990000', emoji: '👍', internalUserId: 7, internalUserName: 'Fixture' };
    await db.$executeRawUnsafe("INSERT INTO clients(id,instance,type,waba_account_id,waba_phone_id) VALUES(?,?,'WABA','account-fixture','phone-fixture')", clientId, input.instance);
    await db.$executeRawUnsafe('INSERT INTO messages(instance,client_id,waba_id) VALUES(?,?,?)', input.instance, clientId, targetMessageId);
    return input;
  }
  const prepare = (input, emoji = input.emoji) => store.prepare({ ...input, emoji });
  const accept = (operation, provider = 'wamid.reaction.' + randomUUID()) => tx(service => service.accept(operation.id, provider));
  const scope = input => ({ clientId: input.clientId, wabaAccountId: 'account-fixture', phoneNumberId: 'phone-fixture' });
  const status = (input, operation, provider, value = 'failed', withCallback = true, extra = {}, overrideScope = scope(input)) => tx(service => service.applyStatus(input.instance, {
    id: provider, status: value, recipient_id: input.to, timestamp: String(Math.floor(tick / 1000)), errors: [{ code: 131000 }],
    ...(withCallback ? { biz_opaque_callback_data: operation.callbackData } : {}), ...extra,
  }, overrideScope));
  async function current(input) {
    const [row] = await db.$queryRawUnsafe("SELECT emoji,source_event_id,reacted_at FROM message_reactions WHERE instance=? AND client_id=? AND target_message_id=? AND actor_id='self'", input.instance, input.clientId, input.targetMessageId);
    return row;
  }
  async function operation(id) { return (await db.$queryRawUnsafe('SELECT status,provider_message_id FROM waba_reaction_operations WHERE id=?', id))[0]; }
  async function baseline(input) {
    await db.$executeRawUnsafe("INSERT INTO message_reactions(id,instance,client_id,target_message_id,actor_id,from_me,emoji,reacted_at,received_at,source_event_id,created_at,updated_at) VALUES(?,?,?,?,'self',1,'😂','2026-11-12 19:00:00.000','2026-11-12 19:00:00.000','wamid.device.baseline','2026-11-12 19:00:00.000','2026-11-12 19:00:00.000')", randomUUID(), input.instance, input.clientId, input.targetMessageId);
  }

  {
    const input = await fixture(), a = await prepare(input), b = await prepare(input, '❤️');
    assert.ok(b.sequence > a.sequence);
    const acceptedB = await accept(b), acceptedA = await accept(a);
    assert.equal((await current(input)).source_event_id, acceptedB.providerMessageId);
    assert.equal(acceptedA.reactionChanged, false);
    log('PASS durable request order survives reversed HTTP completion');
  }
  for (const order of ['AB', 'BA']) {
    const input = await fixture(); await baseline(input);
    const a = await prepare(input), aa = await accept(a), b = await prepare(input, '❤️'), bb = await accept(b);
    const operations = { A: [a, aa.providerMessageId], B: [b, bb.providerMessageId] };
    for (const key of order) await status(input, ...operations[key]);
    assert.equal((await current(input)).emoji, '😂');
    assert.equal((await current(input)).source_event_id, 'wamid.device.baseline');
    log('PASS failed predecessor chain ' + order + ' restores only pre-ledger baseline');
  }
  {
    const input = await fixture(), a = await prepare(input), aa = await accept(a), b = await prepare(input, ''), bb = await accept(b);
    await status(input, a, aa.providerMessageId);
    assert.equal((await current(input)).emoji, '');
    assert.equal((await current(input)).source_event_id, bb.providerMessageId);
    log('PASS older failure cannot undo a newer accepted removal');
  }
  {
    const input = await fixture(), a = await prepare(input), provider = 'wamid.reaction.' + randomUUID();
    await status(input, a, provider);
    const result = await accept(a, provider);
    assert.equal(result.status, 'FAILED'); assert.equal((await current(input)).emoji, '');
    log('PASS callback failure before HTTP acceptance stays failed');
  }
  {
    const input = await fixture(), a = await prepare(input), aa = await accept(a);
    const first = await status(input, a, aa.providerMessageId, 'sent', false);
    const duplicate = await status(input, a, aa.providerMessageId, 'sent', false);
    assert.equal(first.changed, true); assert.equal(duplicate.changed, false); assert.equal(duplicate.reactionChanged, false);
    await status(input, a, aa.providerMessageId, 'delivered', false);
    await status(input, a, aa.providerMessageId, 'sent', false);
    assert.equal((await operation(a.id)).status, 'DELIVERED');
    log('PASS real wamid correlation without callback; duplicate/out-of-order receipts do not regress');
  }
  {
    const input = await fixture(), a = await prepare(input), aa = await accept(a);
    for (const [extra, overrideScope] of [
      [{ recipient_id: '5511888880000' }, scope(input)], [{}, { ...scope(input), clientId: input.clientId + 50_000 }],
      [{}, { ...scope(input), wabaAccountId: 'wrong' }], [{}, { ...scope(input), phoneNumberId: 'wrong' }],
      [{ id: 'wamid.normal.message' }, scope(input)], [{ timestamp: String(Math.floor(tick / 1000) + 1000) }, scope(input)],
    ]) assert.equal(await status(input, a, aa.providerMessageId, 'failed', false, extra, overrideScope), null);
    assert.equal(await tx(service => service.applyStatus('other-tenant', { id: aa.providerMessageId, status: 'failed', recipient_id: input.to, timestamp: String(Math.floor(tick / 1000)) }, scope(input))), null);
    assert.equal((await operation(a.id)).status, 'ACCEPTED');
    log('PASS unrelated messages, wrong tenant/recipient/account/channel/client and future receipt are ignored');
  }
  {
    const input = await fixture(), a = await prepare(input), aa = await accept(a);
    await assert.rejects(db.$transaction(async connection => {
      const failing = Object.create(connection);
      failing.$executeRawUnsafe = (sql, ...values) => {
        if (sql.startsWith('UPDATE message_reactions')) throw Error('FIXTURE_MATERIALIZATION_FAILURE');
        return connection.$executeRawUnsafe(sql, ...values);
      };
      return new Store(failing, now).applyStatus(input.instance, { id: aa.providerMessageId, status: 'failed', recipient_id: input.to, timestamp: String(Math.floor(tick / 1000)) }, scope(input));
    }), /FIXTURE_MATERIALIZATION_FAILURE/);
    assert.equal((await operation(a.id)).status, 'ACCEPTED');
    await status(input, a, aa.providerMessageId, 'failed', false);
    assert.equal((await operation(a.id)).status, 'FAILED'); assert.equal((await current(input)).emoji, '');
    log('PASS materialization failure rolls back receipt and retry completes');
  }
  for (const withBaseline of [false, true]) {
    const input = await fixture(); if (withBaseline) await baseline(input);
    const a = await prepare(input), aa = await accept(a), b = await prepare(input, '❤️');
    await status(input, a, aa.providerMessageId);
    await prepare(input, '😂'); // Captures restored baseline/tombstone after B was prepared.
    const bb = await accept(b);
    assert.equal((await current(input)).source_event_id, bb.providerMessageId);
    log('PASS restored ' + (withBaseline ? 'external baseline' : 'synthetic tombstone') + ' does not supersede an in-flight operation');
  }
  {
    const input = await fixture(), a = await prepare(input);
    await db.$executeRawUnsafe('DELETE FROM messages WHERE instance=? AND client_id=? AND waba_id=?', input.instance, input.clientId, input.targetMessageId);
    await assert.rejects(accept(a), /WABA_REACTION_TARGET_LOCK_REQUIRED/);
    assert.equal((await operation(a.id)).status, 'PREPARED');
    log('PASS missing target cannot mutate ledger without serialization');
  }
  if (createSecondAdapter) {
    const second = await createSecondAdapter(database.databaseName);
    try {
      const input = await fixture(), a = await prepare(input), b = await prepare(input, '❤️');
      let release, hintReached;
      const released = new Promise(resolve => { release = resolve; });
      const hinted = new Promise(resolve => { hintReached = resolve; });
      const holding = db.$transaction(async connection => {
        await connection.$queryRawUnsafe('SELECT id FROM messages WHERE instance=? AND client_id=? AND waba_id=? FOR UPDATE', input.instance, input.clientId, input.targetMessageId);
        const acceptingA = second.$transaction(async other => {
          const intercept = Object.create(other);
          intercept.$queryRawUnsafe = async (sql, ...values) => {
            const rows = await other.$queryRawUnsafe(sql, ...values);
            if (sql.includes('WHERE o.id=? LIMIT 1') && !sql.includes('FOR UPDATE')) { hintReached(); await released; }
            return rows;
          };
          return new Store(intercept, now).accept(a.id, 'wamid.rr.A.' + randomUUID());
        });
        await hinted; // A has established its RR snapshot before B commits.
        const acceptedB = await new Store(connection, now).accept(b.id, 'wamid.rr.B.' + randomUUID());
        return { acceptingA, acceptedB };
      });
      const { acceptingA, acceptedB } = await holding;
      release(); await acceptingA;
      assert.equal((await current(input)).source_event_id, acceptedB.providerMessageId);
      log('PASS two-connection REPEATABLE READ snapshot cannot overwrite a newer committed operation');
    } finally { await second.close(); }
  }
  return { passed: true, cases: createSecondAdapter ? 14 : 13 };
}

module.exports = { runWabaReactionReceiptSuite };
if (require.main === module) {
  const [adapterPath, compiledRoot, databaseName, migrationPath] = process.argv.slice(2);
  if (!adapterPath || !compiledRoot || !/^homolog-reaction-qa-\d{8}$/.test(databaseName || '') || !migrationPath) throw Error('Usage: node test-waba-reaction-receipts-mysql.cjs <adapter.cjs> <compiled-root> <homolog-reaction-qa-YYYYMMDD> <migration.sql>');
  const { createAdapter } = require(path.resolve(adapterPath));
  (async () => {
    const db = await createAdapter(databaseName);
    try { console.log(await runWabaReactionReceiptSuite({ db, createSecondAdapter: createAdapter, compiledRoot: path.resolve(compiledRoot), migrationSql: fs.readFileSync(migrationPath, 'utf8') })); }
    finally { await db.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
