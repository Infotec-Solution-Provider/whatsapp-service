'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const express = require('express');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const source = file => path.join(root, 'src', file);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'odim-access-only-test-'));
const silent = new Proxy(function () {}, { get: (_t, key) => key === 'then' ? undefined : silent, apply: () => silent, construct: () => silent });
let checks = 0;
async function check(name, task) { await task(); checks++; console.log(`PASS ${name}`); }

function harness(profile, options = {}) {
  const folder = fs.mkdtempSync(path.join(temporary, 'case-'));
  fs.mkdirSync(path.join(folder, 'config'));
  if (profile !== undefined) fs.writeFileSync(path.join(folder, 'config/odim-access-only.json'), typeof profile === 'string' ? profile : JSON.stringify(profile), { mode: 0o600 });
  const calls = [];
  const db = options.db || new Proxy({}, { get: (_t, key) => {
    if (key === '$queryRawUnsafe') return async (...args) => { calls.push(args); return []; };
    return new Proxy({}, { get: (_a, operation) => async args => { calls.push([key, operation, args]); return operation === 'updateMany' ? { count: 0 } : []; } });
  } });
  const cache = new Map();
  const selected = new Set([
    'utils/odim-access-only.ts', 'middlewares/is-authenticated.middleware.ts', 'middlewares/odim-access-only.middleware.ts',
    'services/whatsapp.service.ts', 'services/parameters.service.ts', 'services/operator-send.service.ts',
    'services/operator-outbound.repository.ts', 'services/messages.service.ts', 'services/messages-distribution.service.ts',
    'services/chats.service.ts', 'services/internal-chats.service.ts', 'services/waba-webhook-queue.service.ts',
    'services/gupshup-webhook-queue.service.ts', 'services/message-queue.service.ts', 'services/internal-whatsapp-message-queue.service.ts',
    'controllers/whatsapp.controller.ts', 'controllers/contacts.controller.ts', 'controllers/waba.controller.ts', 'controllers/gupshup.controller.ts',
  ]);
  const sessions = {
    odim: { instance: 'odim', userId: 6, sectorId: 1, role: 'ADMIN', name: 'Fixture' },
    upper: { instance: ' ODIM ', userId: 6, sectorId: 1, role: 'ADMIN', name: 'Fixture' },
    accented: { instance: 'odím', userId: 6, sectorId: 1, role: 'ADMIN', name: 'Fixture' },
    width: { instance: 'ｏｄｉｍ', userId: 6, sectorId: 1, role: 'ADMIN', name: 'Fixture' },
    ignorable: { instance: 'o\u200ddim', userId: 6, sectorId: 1, role: 'ADMIN', name: 'Fixture' },
    other: { instance: 'tenant-b', userId: 6, sectorId: 1, role: 'ADMIN', name: 'Fixture' },
    otherUpper: { instance: 'INFOTEC ', userId: 6, sectorId: 1, role: 'ADMIN', name: 'Fixture' },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const filename = source(file);
    const localRequire = request => {
      if (request === 'dotenv/config') return {};
      if (request.startsWith('node:') || request === 'express' || request === '@prisma/client' || request === '@rgranatodutra/http-errors') return require(request);
      if (request === '@in.pulse-crm/utils') return { Logger: silent, sanitizeErrorMessage: () => 'Fixture error' };
      const relative = path.relative(path.join(root, 'src'), path.resolve(path.dirname(filename), request + '.ts')).replaceAll('\\', '/');
      if (options.mocks?.[relative]) return { __esModule: true, ...options.mocks[relative] };
      if (relative === 'services/prisma.service.ts') return { __esModule: true, default: db };
      if (relative === 'services/auth.service.ts') return { __esModule: true, default: { fetchSessionData: async token => {
        const session = sessions[token.replace('Bearer ', '')]; if (!session) throw new Error('Invalid fixture authentication'); return session;
      } } };
      if (relative === 'middlewares/protected-read.ts') return { __esModule: true, default: (_name, handler) => async (req, res, next) => {
        try { const result = await handler(req, res); if (result && !res.headersSent) res.json(result); } catch (error) { next(error); }
      } };
      if (relative.startsWith('whatsapp-client/')) return { __esModule: true, default: class FixtureClient { constructor(id, instance) { this.id = id; this.instance = instance; } } };
      if (selected.has(relative)) return load(relative);
      return new Proxy({ __esModule: true, default: silent }, { get: (target, key) => key in target ? target[key] : silent });
    };
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const run = vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${js}\n})`, { filename });
    run(localRequire, module, module.exports, file === 'utils/odim-access-only.ts' ? path.join(folder, 'dist/utils') : path.dirname(filename), filename);
    return module.exports;
  }
  return { load, calls, db, folder, sessions };
}

async function http(h, task) {
  const app = express(); app.use(express.json());
  const authenticate = h.load('middlewares/is-authenticated.middleware.ts').default;
  const service = h.load('services/whatsapp.service.ts').default;
  app.use(h.load('controllers/whatsapp.controller.ts').default.router);
  let mutations = 0;
  for (const route of ['/api/whatsapp/chats', '/api/whatsapp/chats/:id/transfer', '/api/whatsapp/:clientId/messages', '/api/whatsapp/schedules', '/api/internal/messages/:id/whatsapp-retry', '/api/whatsapp/flow-execution/execute']) {
    app.post(route, authenticate, (_req, res) => { mutations++; res.status(201).json({ fixture: true }); });
  }
  app.post('/api/internal/chats/:id/messages', authenticate, (_req, res) => { mutations++; res.status(201).json({ fixture: true }); });
  app.get('/api/whatsapp/session/parameters', authenticate, (_req, res) => res.json({ fixture: true }));
  app.use(h.load('controllers/contacts.controller.ts').default.router);
  app.use(h.load('controllers/waba.controller.ts').default.router);
  app.use(h.load('controllers/gupshup.controller.ts').default.router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: 'Fixture error' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await task({ base, service, mutations: () => mutations }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

(async () => {
  const on = { version: 1, instance: 'odim', enabled: true };
  const off = harness();
  const disabled = off.load('utils/odim-access-only.ts');
  await check('missing profile preserves all tenants', () => {
    assert.equal(disabled.odimAccessOnlyProfile.state, 'missing'); assert.equal(disabled.isOdimAccessOnly('odim'), false); assert.deepEqual(disabled.odimQueueWhere(), {});
  });
  await check('invalid profile blocks only Odim', () => {
    const invalid = harness('{invalid').load('utils/odim-access-only.ts');
    assert.deepEqual(invalid.odimAccessOnlyProfile, { state: 'invalid', enabled: true }); assert.equal(invalid.isOdimAccessOnly('other'), false); assert.equal(invalid.isOdimAccessOnly('ODIM'), true);
  });
  await check('profile schema rejects extra fields and oversized input', () => {
    for (const input of [{ ...on, channel: 'x' }, ' '.repeat(4097), { ...on, instance: 'other' }, { ...on, enabled: 'true' }]) assert.equal(harness(input).load('utils/odim-access-only.ts').odimAccessOnlyProfile.state, 'invalid');
    assert.equal(harness({ ...on, enabled: false }).load('utils/odim-access-only.ts').isOdimAccessOnly('odim'), false);
  });
  const active = harness(on); const policy = active.load('utils/odim-access-only.ts');
  await check('exact profile and case variants', () => {
    assert.equal(policy.odimAccessOnlyProfile.state, 'valid');
    for (const instance of ['odim', 'ODIM', ' ODIM ', 'odím', 'ｏｄｉｍ', 'ødim', 'ođim', 'o\u200ddim']) assert.throws(() => policy.assertOdimChannelAllowed(instance), error => error.code === 'ODIM_ACCESS_ONLY');
    for (const instance of ['tenant-b', 'infotec', 'odim2', 'another-odim']) assert.equal(policy.isOdimAccessOnly(instance), false);
    policy.assertOdimChannelAllowed('tenant-b');
  });
  await check('profile links and writable files fail closed', () => {
    const linked = path.join(temporary, 'linked.json');
    try { fs.symlinkSync(path.join(active.folder, 'config/odim-access-only.json'), linked); assert.equal(policy.readOdimAccessOnlyProfile(linked).state, 'invalid'); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
    if (process.platform !== 'win32') { const writable = path.join(temporary, 'writable.json'); fs.writeFileSync(writable, JSON.stringify(on), { mode: 0o666 }); fs.chmodSync(writable, 0o666); assert.equal(policy.readOdimAccessOnlyProfile(writable).state, 'invalid'); }
  });
  const sectorCalls = [];
  let internalState = { wppGroupId: null };
  const db = {
    wppSector: { findFirstOrThrow: async args => { sectorCalls.push(args); const owner = args.where.instance.trim().toLowerCase(); if (!['tenant-b', 'infotec'].includes(owner)) throw Object.assign(new Error('Not found'), { statusCode: 404 }); return { clients: [{ id: 21, instance: owner, name: 'Fixture', type: 'WABA' }, { id: 22, instance: 'other', name: 'Foreign fixture', type: 'WABA' }] }; } },
    internalChat: { findFirst: async args => { assert.equal(args.where.instance, 'odim'); return internalState; } },
  };
  let centralSearch = 0; let localSearch = 0;
  const h = harness(on, { db, mocks: {
    'services/contact-search.service.ts': { default: class { async search(instance) { assert.equal(instance, 'odim'); centralSearch++; return { data: [], pagination: { total: 0 } }; } } },
    'services/contacts.service.ts': { default: { getContactsWithCustomerLocally: async () => { localSearch++; throw new Error('Local wpp tables must not be used'); } } },
    'services/parameters.service.ts': { default: { getSessionParams: async () => ({ use_local_contacts_sync: 'true' }) } },
  } });
  await http(h, async ({ base, mutations }) => {
    const request = (url, method = 'GET', token = 'odim') => fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    await check('Odim and casing variants cannot create or send, before handlers', async () => {
      for (const token of ['odim', 'upper', 'accented', 'width', 'ignorable']) for (const route of ['/api/whatsapp/chats', '/api/whatsapp/chats/1/transfer', '/api/whatsapp/1/messages', '/api/whatsapp/schedules', '/api/internal/messages/1/whatsapp-retry', '/api/whatsapp/flow-execution/execute']) assert.equal((await request(route, 'POST', token)).status, 423);
      assert.equal(mutations(), 0);
    });
    await check('other tenants keep existing mutations; missing auth stays denied', async () => {
      assert.equal((await request('/api/whatsapp/chats', 'POST', 'other')).status, 201);
      assert.equal((await request('/api/whatsapp/chats', 'POST', 'invalid')).status, 401);
      assert.equal(mutations(), 1);
    });
    await check('Odim channels empty even forged foreign sector; other tenants scoped', async () => {
      for (const url of ['/api/whatsapp/sector/1/clients', '/api/whatsapp/sector/%31/clients']) assert.deepEqual((await (await request(url)).json()).data, []);
      assert.equal(sectorCalls.length, 0);
      assert.deepEqual((await (await request('/api/whatsapp/sector/1/clients', 'GET', 'other')).json()).data.map(client => client.id), [21]);
      assert.deepEqual(sectorCalls[0].where, { id: 1, instance: 'tenant-b' });
      assert.deepEqual(sectorCalls[0].include, { clients: { where: { instance: 'tenant-b' } } });
    });
    await check('legitimate uppercase and trailing-space tenant retains its channels without foreign links', async () => {
      assert.deepEqual((await (await request('/api/whatsapp/sector/1/clients', 'GET', 'otherUpper')).json()).data.map(client => client.id), [21]);
      assert.deepEqual(sectorCalls[1].where, { id: 1, instance: 'INFOTEC ' });
      assert.deepEqual(sectorCalls[1].include, { clients: { where: { instance: 'INFOTEC ' } } });
    });
    await check('authenticated central contacts override old local-sync without DDL', async () => {
      assert.equal((await request('/api/whatsapp/contacts/customer')).status, 200); assert.equal(centralSearch, 1); assert.equal(localSearch, 0);
      assert.equal((await request('/api/whatsapp/session/parameters')).status, 200);
    });
    await check('local internal CRUD allowed, foreign and WhatsApp-linked resources denied', async () => {
      assert.equal((await request('/api/internal/chats/3/messages', 'POST')).status, 201);
      internalState = null; assert.equal((await request('/api/internal/chats/3/messages', 'POST')).status, 404);
      internalState = { wppGroupId: 'fixture@g.us' }; assert.equal((await request('/api/internal/chats/3/messages', 'POST')).status, 423);
      assert.equal(mutations(), 2);
    });
    await check('Odim provider ingress is rejected rather than acknowledged', async () => {
      for (const provider of ['waba', 'meta', 'gupshup']) {
        assert.equal((await fetch(`${base}/api/whatsapp/${provider}/ODIM/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 423);
        assert.equal((await fetch(`${base}/api/whatsapp/${provider}/odim/webhooks`)).status, 423);
      }
    });
  });
  await check('domain calls reject Odim before persistence, providers, queues or flow execution', async () => {
    const f = harness(on); const session = { instance: 'odim' };
    const wa = f.load('services/whatsapp.service.ts').default;
    const rejected = [
      () => wa.sendMessage(session), () => wa.sendTemplate(session), () => wa.sendBotMessage('fixture', 1, { chat: { instance: 'odim' } }),
      () => wa.forwardMessages(session), () => wa.sendAutoReplyMessage('odim'),
      () => f.load('services/operator-send.service.ts').default.submit(session),
      () => f.load('services/messages.service.ts').default.insertMessage({ instance: 'odim' }),
      () => f.load('services/messages-distribution.service.ts').default.getFlow('odim', 1),
      () => f.load('services/messages-distribution.service.ts').default.processMessage('odim'),
      () => f.load('services/chats.service.ts').default.startChatByContactId(session),
      () => f.load('services/chats.service.ts').default.transferAttendance('', session),
      () => f.load('services/internal-chats.service.ts').default.createInternalChat(session, [], true, 'Fixture', 'fixture@g.us'),
      () => f.load('services/internal-chats.service.ts').default.processQueuedWppGroupMessage({ instance: 'odim', clientId: 1 }),
      () => f.load('services/waba-webhook-queue.service.ts').default.enqueue('odim', {}),
      () => f.load('services/gupshup-webhook-queue.service.ts').default.enqueue('odim', {}),
      () => f.load('services/message-queue.service.ts').default.enqueue({ instance: 'odim' }),
      () => f.load('services/internal-whatsapp-message-queue.service.ts').default.enqueue({ instance: 'odim' }),
    ];
    for (const operation of rejected) await assert.rejects(operation, error => error.code === 'ODIM_ACCESS_ONLY');
    assert.equal(f.calls.length, 0);
  });
  await check('build excludes Odim, including current active client; loaded Odim cannot be used', async () => {
    const queried = [];
    const f = harness(on, { db: { wppClient: { findMany: async args => { queried.push(args); return [{ id: 21, instance: 'tenant-b', type: 'WABA' }]; } } } });
    const wa = f.load('services/whatsapp.service.ts').default; await wa.buildClients();
    assert.deepEqual(queried[0].where, { instance: { not: 'odim' }, isActive: true });
    assert.equal(wa.getClient(12), undefined); assert.equal(wa.getClient(21).instance, 'tenant-b');
    wa.clients.set(12, { id: 12, instance: 'odim' }); assert.throws(() => wa.getClient(12), error => error.code === 'ODIM_ACCESS_ONLY');
  });
  await check('workers select only non-Odim without consuming or failing queued Odim work', async () => {
    const f = harness(on);
    await f.load('services/waba-webhook-queue.service.ts').default.getNextPendingItem();
    assert.match(f.calls[0][0], /AND instance <> 'odim'/);
    await f.load('services/gupshup-webhook-queue.service.ts').default.getNextPendingItem();
    assert.deepEqual(f.calls[1][2].where.instance, { not: 'odim' });
    const Repository = f.load('services/operator-outbound.repository.ts').default;
    await new Repository(f.db).candidates(new Date(), 5);
    assert.deepEqual(f.calls[2][2].where.instance, { not: 'odim' });
  });
  await check('session overlays avoid foreign sector flags and external autoload without persisted changes', async () => {
    const queries = [];
    const f = harness(on, { db: { parameter: { findMany: async args => { queries.push(args); return args.where.scope === 'INSTANCE' ? [{ key: 'use_local_contacts_sync', value: 'true' }, { key: 'feature_ai_enabled', value: 'true' }] : []; } } } });
    const service = f.load('services/parameters.service.ts').default;
    const parameters = await service.getSessionParams({ instance: 'odim', sectorId: 1, userId: 6 });
    assert.equal(queries.some(q => q.where.scope === 'SECTOR'), false); assert.equal(parameters.feature_ai_enabled, 'false');
    assert.equal(parameters.use_local_contacts_sync, 'true'); assert.equal(parameters.feature_chat_export_enabled, 'true');
    assert.equal(await service.isInternalGroupWhatsappSyncEnabled('odim', true), false);
  });
  console.log(JSON.stringify({ passed: checks, providerRequests: 0, productionReads: 0, productionWrites: 0, configFixturesOnly: true }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
