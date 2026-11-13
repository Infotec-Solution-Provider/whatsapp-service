const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Explicit disposable target created for this delivery. Never consume DATABASE_URL or a service .env.
function createFixture(label) {
  assert.match(label, /^[a-z]{1,12}$/);
  const schema = 'odim_monitor_homolog_qa_20261113_' + label + '_' + crypto.randomBytes(4).toString('hex');
  const url = new URL('mysql://root@127.0.0.1:13418/' + schema);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '13418');
  assert.match(url.pathname, /^\/odim_monitor_homolog_qa_20261113_[a-z]+_[0-9a-f]{8}$/);
  const sql = statement => {
    const result = spawnSync('docker', ['exec', '-i', 'odim-flow-qa-mysql8-20261113', 'mysql', '-uroot', '--batch'],
      { input: statement, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  return { schema, url: url.href, sql };
}
module.exports = { createFixture };
