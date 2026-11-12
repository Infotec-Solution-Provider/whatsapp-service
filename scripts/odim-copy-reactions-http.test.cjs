const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { createOdimCopyIngress, mirrorEventRows } = require('../dist/services/odim-live-copy.ingress');
const { odimMirrorSourceId } = require('../dist/services/odim-copy-reactions');

const timestamp = String(Math.floor(Date.now() / 1000));
const reaction = { id: 'wamid.reaction.fixture', type: 'reaction', from: '5511999900011', timestamp,
  reaction: { message_id: 'wamid.target.fixture', emoji: '👍' } };
const payload = (messages = [reaction], statuses = []) => ({ object: 'whatsapp_business_account', entry: [{
  id: '123456789', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '987654321' }, messages, statuses,
  } }],
}] });

test('mirror preserves all batch items, scopes reactions and queues the target instead of a bubble ID', () => {
  const rows = mirrorEventRows(payload([{ id: 'wamid.normal', type: 'text', timestamp }, reaction], [
    { id: 'wamid.receipt', timestamp, status: 'failed', recipient_id: reaction.from },
  ]));
  assert.deepEqual(rows.map(row => row[2]), ['message', 'reaction', 'status']);
  assert.equal(rows[1][1], reaction.reaction.message_id);
  assert.notEqual(rows[0][0], rows[1][0]);
  assert.equal(rows[1][0], mirrorEventRows(payload())[0][0]);
  for (const row of rows) assert.deepEqual(JSON.parse(row[3])._inpulseWabaScope, {
    accountId: '123456789', phoneNumberId: '987654321',
  });
  assert.equal(odimMirrorSourceId('message', reaction, reaction.id), reaction.reaction.message_id);
  assert.equal(odimMirrorSourceId('reaction', reaction, reaction.id), reaction.reaction.message_id);
  assert.equal(odimMirrorSourceId('status', {}, 'wamid.normal'), 'wamid.normal');
  assert.equal(odimMirrorSourceId('status', { biz_opaque_callback_data: 'inpulse:reaction:fixture' }, 'wamid.receipt'), null);
  assert.equal(Object.keys(require.cache).some(file => /[\\/]prisma\.service\.js$/.test(file)), false);
});

test('mirror accepts removal and rejects malformed reaction/metadata before persistence', () => {
  assert.equal(mirrorEventRows(payload([{ ...reaction, reaction: { message_id: reaction.reaction.message_id } }]))[0][2], 'reaction');
  for (const invalid of [
    { ...reaction, id: 'invalid' }, { ...reaction, from: 'group@g.us' },
    { ...reaction, timestamp: '0000000000' }, { ...reaction, timestamp: String(Number(timestamp) + 1000) },
    { ...reaction, reaction: { message_id: 'not-wamid', emoji: '👍' } },
    { ...reaction, reaction: { message_id: reaction.reaction.message_id, emoji: 'text' } },
  ]) assert.throws(() => mirrorEventRows(payload([invalid])));
  const noMetadata = payload(); delete noMetadata.entry[0].changes[0].value.metadata;
  assert.throws(() => mirrorEventRows(noMetadata));
  const forged = { ...reaction, _inpulseWabaScope: { accountId: 'forged', phoneNumberId: 'forged' } };
  assert.equal(JSON.parse(mirrorEventRows(payload([forged]))[0][3])._inpulseWabaScope.accountId, '123456789');
});

test('HTTP authentication and durable acknowledgement cover reaction events without provider calls', async () => {
  const key = 'a'.repeat(64), stored = [];
  let unavailable = false;
  const server = createServer(createOdimCopyIngress(key, async rows => {
    if (unavailable) throw Error('fixture unavailable');
    stored.push(...rows);
  }, async () => ({ fixture: true })));
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/odim-copy/webhooks`;
  const post = (secret, body) => fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-odim-mirror-key': secret,
  }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('wrong', payload())).status, 401);
    assert.equal(stored.length, 0);
    assert.equal((await post(key, payload())).status, 200);
    assert.equal(stored.length, 1);
    assert.equal(stored[0][2], 'reaction');
    unavailable = true;
    assert.equal((await post(key, payload())).status, 503);
    assert.equal(stored.length, 1);
    assert.equal((await post(key, { invalid: true })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
