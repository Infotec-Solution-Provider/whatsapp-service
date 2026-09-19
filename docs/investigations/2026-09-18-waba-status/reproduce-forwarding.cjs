// Offline investigation: runs current source with in-memory dependencies.
// No dotenv, database, HTTP, sockets, application startup, or real messages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');

function load(relative, dependencies) {
  const filename = path.join(root, relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console, structuredClone,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `Unmocked dependency forbidden: ${id}`);
      return dependencies[id];
    },
  }, { filename, timeout: 5000 });
  return module.exports;
}

class SilentLogger { log() {} debug() {} success() {} failed() {} }
const utils = { Logger: { info() {}, error() {} }, sanitizeErrorMessage: String };
const original = { id: 10, wabaId: 'wamid.original', type: 'text', body: 'Synthetic fixture', fileId: null };
let generatedId;
let dispatches;
let saved;
let updates;

const WabaClient = load('src/whatsapp-client/waba-whatsapp-client.ts', {
  '@in.pulse-crm/utils': utils,
  axios: { post: async () => { dispatches++; return { data: { messages: [{ id: generatedId }] } }; } },
  '../adapters/template.adapter': {},
  '../services/files.service': {},
  '../services/prisma.service': { wppMessage: { findFirst: async () => original } },
  '../utils/generate-uid': () => 'synthetic-process',
  '../utils/processing-logger': SilentLogger,
  '../utils/waba-send': {
    sendWabaRequest: async (request) => {
      const data = await request();
      return { id: data.messages[0].id, data };
    },
    classifyWabaSendError: (error) => error,
    wabaPreparationError: (error) => error,
  },
}).default;

const service = load('src/services/whatsapp.service.ts', {
  '@in.pulse-crm/utils': utils,
  '@prisma/client': {},
  '@rgranatodutra/http-errors': { BadRequestError: Error, InternalServerError: Error },
  'dotenv/config': {},
  '../utils/processing-logger': SilentLogger,
  '../utils/resolve-edit-message-id': {},
  '../utils/message-mention-metadata': { normalizeMentionEntities: () => [] },
  '../whatsapp-client/gupshup-whatsapp-client': class {},
  '../whatsapp-client/remote-whatsapp-client': class {},
  '../whatsapp-client/waba-whatsapp-client': WabaClient,
  '../whatsapp-client/wwebjs-whatsapp-client': class {},
  './files.service': {},
  './instances.service': {},
  './internal-chats.service': {},
  './messages-distribution.service': { notifyMessage() {} },
  './messages.service': {
    insertMessage: async (data) => { const row = { id: 20, ...data }; saved.push(row); return row; },
    updateMessage: async (...args) => { updates.push(args); },
  },
  './prisma.service': {
    wppMessage: { findMany: async () => [original] },
    internalMessage: { findMany: async () => [original] },
  },
  './contacts.service': { findContactByAddress: async () => null },
  '../utils/file-upload-trace': {},
  './ready-messages.service': {},
  '../utils/waba-send': { WabaDeliveryError: class extends Error {} },
}).default;

async function main() {
  const client = new WabaClient(1, 'synthetic-tenant', 'Synthetic', '0000', 'synthetic-phone', 'synthetic-account', 'fake-token');
  service.getClient = () => client;
  // Control: the adapter returns the new provider ID correctly.
  generatedId = 'wamid.control'; dispatches = 0;
  const direct = await client.sendMessage({ to: '0001', text: 'Synthetic' });
  assert.equal(direct.wabaId, generatedId);
  assert.equal(dispatches, 1);
  console.log('PASS control: WABA adapter returns the generated wamid');

  for (const sourceType of ['whatsapp', 'internal']) {
    generatedId = `wamid.forwarded.${sourceType}`;
    dispatches = 0; saved = []; updates = [];
    await service.forwardMessages({ instance: 'synthetic-tenant', userId: 1 }, 1, [10], sourceType,
      [{ id: '0001', isGroup: false }], []);
    assert.equal(dispatches, 1, 'Exactly one simulated send must occur');
    assert.equal(saved.length, 1, 'The forwarded CRM row must exist');
    assert.equal(saved[0].status, 'SENT');
    assert.equal(saved[0].isForwarded, true);
    assert.equal(saved[0].wabaId, undefined, 'Reproduces missing provider ID in the saved row');
    assert.equal(updates.length, 0, 'No later update attaches the generated provider ID');
    console.log(`REPRODUCED ${sourceType} -> WABA: one simulated send, CRM row SENT, generated wamid not persisted`);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
