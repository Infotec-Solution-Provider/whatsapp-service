'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const compiled = process.argv.includes('--compiled');
const ts = compiled ? null : require('typescript');
function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, compiled ? `dist/${file}.js` : `src/${file}.ts`), 'utf8');
  const code = compiled ? source : ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const unexpected = new Proxy(function () {}, { get: (_t, key) => {
    if (key === '__esModule') return false;
    throw new Error(`Unexpected dependency access: ${file}:${String(key)}`);
  }, apply: () => { throw new Error(`Unexpected dependency call: ${file}`); } });
  vm.runInNewContext(code, { module, exports: module.exports, console, process, Date, Map,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : unexpected,
  }, { filename: file });
  return module.exports;
}
const { WabaSystemEventsService } = load('services/waba-system-events.service');
const peer = '15550000101';
const event = { id: 'wamid.system-test', from: peer, type: 'system', timestamp: '1793971556',
  system: { type: 'user_changed_number', wa_id: '15550000202', body: 'Test number-change notification' } };
let checks = 0;
async function check(name, task) { await task(); checks++; console.log(`PASS ${name}`); }
function harness() {
  const state = { rows: [], contacts: [{ id: 7 }], channels: [{ id: 12 }], inserted: [], contactQueries: [], race: false };
  const db = {
    wppClient: { findMany: async args => { state.channelQuery = args; return state.channels; } },
    wppContact: { findMany: async args => { state.contactQueries.push(args); return state.contacts; } },
    wppMessage: { findUnique: async ({ where }) => state.rows.find(row => row.wabaId === where.wabaId) || null },
  };
  const insert = async data => {
    state.inserted.push(data);
    const row = { ...data, id: 99 };
    if (state.race) { state.rows.push(row); throw Object.assign(new Error('Unique key'), { code: 'P2002' }); }
    state.rows.push(row); return row;
  };
  return { state, db, insert, service: new WabaSystemEventsService(db, insert) };
}
const silentLogger = class { processName = ''; log() {} success() {} failed() {} };
async function run() {
  await check('known contact: technical audit only, original date, read, no chat or number mutation', async () => {
    const h = harness();
    const result = await h.service.record('odim', event, 'phone-id', 'account-id');
    assert.equal(result.contactResolution, 'exact');
    const row = h.state.rows[0];
    assert.equal(row.from, 'thirdparty:meta'); assert.equal(row.to, peer);
    assert.equal(row.chatId, null); assert.equal(row.contactId, 7); assert.equal(row.status, 'READ');
    assert.equal(row.timestamp, '1793971556000'); assert.equal(row.sentAt.toISOString(), '2026-11-06T13:25:56.000Z');
    assert.equal(h.state.channelQuery.where.instance, 'odim');
    assert.equal(h.state.channelQuery.where.isActive, true);
    assert.equal(h.state.channelQuery.where.WABAPhoneId, 'phone-id');
    assert.equal(h.state.channelQuery.where.WABAAccountId, 'account-id');
    assert.equal(h.state.contactQueries[0].where.instance, 'odim');
    assert.equal(h.state.contactQueries[0].where.OR[0].phone, peer);
  });
  await check('replay and concurrent unique conflict are idempotent', async () => {
    const h = harness(); await h.service.record('odim', event, 'phone-id', 'account-id');
    assert.equal((await h.service.record('odim', event, 'phone-id', 'account-id')).duplicate, true);
    assert.equal(h.state.inserted.length, 1);
    const concurrent = harness(); concurrent.state.race = true;
    assert.equal((await concurrent.service.record('odim', event, 'phone-id', 'account-id')).duplicate, true);
    assert.equal(concurrent.state.rows.length, 1);
  });
  await check('old parser records are preserved and never redistributed', async () => {
    const h = harness();
    h.state.rows.push({ id: 1, wabaId: event.id, instance: 'odim', clientId: 12,
      type: 'thirdparty:meta', from: peer, timestamp: '1793971556000', chatId: 352833 });
    assert.equal((await h.service.record('odim', event, 'phone-id', 'account-id')).duplicate, true);
    assert.equal(h.state.inserted.length, 0); assert.equal(h.state.rows[0].chatId, 352833);
  });
  await check('unknown, deleted or ambiguous contacts cannot create or merge contacts', async () => {
    for (const contacts of [[], [{ id: 7 }, { id: 8 }]]) {
      const h = harness(); h.state.contacts = contacts;
      await h.service.record('odim', event, 'phone-id', 'account-id');
      assert.equal(h.state.rows[0].contactId, null); assert.equal(h.state.rows[0].chatId, null);
      assert.equal(h.state.contactQueries[0].where.isDeleted, false);
    }
  });
  await check('unknown system subtype, missing body and sender remain technical', async () => {
    const h = harness();
    await h.service.record('odim', { ...event, from: undefined, system: { type: 'future-event' } }, 'phone-id', 'account-id');
    assert.equal(h.state.rows[0].to, 'system'); assert.equal(h.state.rows[0].contactId, null);
    assert.equal(h.state.rows[0].body, 'Notificação técnica do WhatsApp.');
    assert.equal(h.state.contactQueries.length, 0);
  });
  await check('invalid identity, date and channel fail closed before inserting', async () => {
    for (const patch of [{ id: '' }, { timestamp: 'NaN' }, { timestamp: '-1' }, { timestamp: '0' }, { timestamp: '1e12' }]) {
      const h = harness(); await assert.rejects(h.service.record('odim', { ...event, ...patch }, 'phone-id', 'account-id'));
      assert.equal(h.state.inserted.length, 0);
    }
    for (const channels of [[], [{ id: 12 }, { id: 13 }]]) {
      const h = harness(); h.state.channels = channels;
      await assert.rejects(h.service.record('odim', event, 'phone-id', 'account-id'), /CHANNEL_MISMATCH/);
    }
    await assert.rejects(harness().service.record('odim', event), /CHANNEL_REQUIRED/);
  });
  await check('provider ID collision cannot cross tenant, channel, sender, date or type', async () => {
    for (const patch of [{ instance: 'other' }, { clientId: 13 }, { to: 'other' }, { timestamp: '1' }, { type: 'text' }]) {
      const h = harness(); await h.service.record('odim', event, 'phone-id', 'account-id');
      Object.assign(h.state.rows[0], patch);
      await assert.rejects(h.service.record('odim', event, 'phone-id', 'account-id'), /IDENTITY_MISMATCH/);
      assert.equal(h.state.inserted.length, 1);
    }
  });
  await check('real WABA entry bypasses parser, distribution, health, media and expiration; text/media/status/reaction preserved', async () => {
    const h = harness(); let parsed = 0, distributed = 0, expiration = 0, probes = 0, statuses = 0, reactions = 0;
    h.db.wppClient.findFirstOrThrow = async () => ({ id: 12 });
    h.db.wppMessage.findFirst = async () => null;
    h.db.$transaction = async work => work({});
    const waba = load('services/waba.service', {
      '../parsers/waba-message.parser': { parse: async (_id, _recipient, _tenant, data) => {
        parsed++; return { ...data, timestamp: '1793971556000', contactId: 7 };
      }, parseStatus: () => 'RECEIVED' },
      '../utils/processing-logger': silentLogger,
      './messages-distribution.service': { processMessage: async (_tenant, _id, row) => { distributed++; return row; },
        processMessageStatus: async () => { statuses++; } },
      './messages.service': { insertMessage: h.insert }, './prisma.service': h.db,
      '@in.pulse-crm/utils': { sanitizeErrorMessage: String },
      './functional-health-probe-registry.service': { handleOfficialInbound: async () => { probes++; return { handled: false }; } },
      '../utils/functional-health-status': { isFunctionalHealthStatus: () => false },
      './message-reactions.service': { receiveWaba: async () => { reactions++; } },
      '../utils/waba-reaction': load('utils/waba-reaction'),
      './waba-reaction-receipts.service': { WabaReactionReceiptsService: class { async applyStatus() { return null; } } },
      '../utils/incoming-contact-name': { wabaContactName: () => null },
      '../triage/waba-channel': { resolveTriageWabaChannel: async client => client },
      './waba-system-events.service': { WabaSystemEventsService },
    }).default;
    waba.checkAndUpdateContactConversationExpiration = async () => { expiration++; };
    const payload = (message, status) => ({ entry: [{ id: 'account-id', changes: [{ value: {
      metadata: { phone_number_id: 'phone-id', display_phone_number: '15550000303' },
      ...(message ? { messages: [message] } : { statuses: [status] }),
    } }] }] });
    await waba.handleWebhookEntry('odim', payload(event));
    await waba.handleWebhookEntry('odim', payload(event));
    assert.equal(parsed + distributed + expiration + probes, 0); assert.equal(h.state.rows.length, 1);
    await waba.handleWebhookEntry('odim', payload({ ...event, id: 'text', type: 'text', text: { body: 'hello' } }));
    await waba.handleWebhookEntry('odim', payload({ ...event, id: 'audio', type: 'audio', audio: { id: 'media' } }));
    assert.equal(parsed, 2); assert.equal(distributed, 2); assert.equal(expiration, 2); assert.equal(probes, 1);
    await waba.handleWebhookEntry('odim', payload(null, { id: 'text', status: 'delivered', timestamp: event.timestamp }));
    await waba.handleWebhookEntry('odim', payload({ ...event, id: 'reaction', type: 'reaction', reaction: { message_id: 'text', emoji: '👍' } }));
    assert.equal(statuses, 1); assert.equal(reactions, 1); assert.equal(parsed, 2);
    const mixed = payload({ ...event, id: 'batch-system' });
    mixed.entry[0].changes[0].value.messages.push({ ...event, id: 'batch-text', type: 'text', text: { body: 'hello' } });
    mixed.entry[0].changes[0].value.statuses = [{ id: 'text', status: 'delivered', timestamp: event.timestamp }];
    assert.equal((await waba.handleWebhookEntry('odim', mixed)).ignored, false);
    assert.equal(parsed, 3); assert.equal(distributed, 3); assert.equal(expiration, 3); assert.equal(statuses, 2);
  });
  await check('real parser rejects system fallback and still parses text', async () => {
    const parser = load('parsers/waba-message.parser', { '@prisma/client': { WppMessageStatus: { RECEIVED: 'RECEIVED' } } }).default;
    await assert.rejects(parser.parse(12, 'recipient', 'odim', event), /SYSTEM_REQUIRES_EVENT_HANDLER/);
    const row = await parser.parse(12, 'recipient', 'odim', { ...event, type: 'text', text: { body: 'hello' } });
    assert.equal(row.body, 'hello'); assert.equal(row.from, peer);
  });
  await check('real distribution guard blocks already saved technical notices before contact, chat or automation', async () => {
    const distribution = load('services/messages-distribution.service', {
      '../utils/odim-access-only': { assertOdimChannelAllowed() {} },
      '../utils/processing-logger': silentLogger,
      './message-queue.service': { setProcessHandler() {} },
    }).default;
    for (const type of ['system', 'thirdparty:meta']) {
      const row = { id: 99, type, from: peer, wabaId: event.id };
      assert.equal(await distribution.processMessage('odim', 12, row), row);
    }
  });
  console.log(`waba-system-events: ${checks} groups passed (${compiled ? 'compiled runtime' : 'TypeScript source'}); no production access`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
