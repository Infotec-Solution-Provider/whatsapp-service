'use strict';
// Release observations only. An active status probe may initialize central operator state.
// Never imports app main/workers, queries CRM, logs in or dispatches media.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process'), http = require('node:http'), https = require('node:https'), assert = require('node:assert/strict');
const CONTROL = '/home/inpulse/operator-feature-pilot-534-20261116-production';
const RUNTIME_KEY = '/home/inpulse/operator-runtime-central-20261116-production/runtime-hmac.key';
const PM2 = '/home/inpulse/.nvm/versions/node/v22.14.0/bin/pm2', ORIGIN = 'https://inpulse.infotecrs.inf.br';
const APPS = ['instances', 'customers', 'users', 'frontend', 'whatsapp', 'odim-modern-frontend', 'odim-copy', 'files', 'socket', 'reports', 'marketing', 'ai', 'reports-frontend', 'landing-page'];
const TARGETS = {
  instances: { app: 'instances', live: '/home/inpulse/htdocs/inpulse.infotecrs.inf.br/instances-service' },
  whatsapp: { app: 'whatsapp', live: '/home/inpulse/htdocs/inpulse.infotecrs.inf.br/whatsapp' },
  customers: { app: 'customers', live: '/home/inpulse/htdocs/inpulse.infotecrs.inf.br/customers' },
  users: { app: 'users', live: '/home/inpulse/htdocs/inpulse.infotecrs.inf.br/users-service' },
  legacy: { app: 'frontend', live: '/home/inpulse/htdocs/inpulse.infotecrs.inf.br/frontend' },
  modern: { app: 'odim-modern-frontend', live: '/home/inpulse/odim-modern-20261110/frontend-new' },
};
const REFS = {
  backendStatic: 'backend-release.json', backendEffective: 'effective-manifest.json', backendInstallState: 'backend-install-state.json', backendVerification: 'backend-verification.json', cutover: 'cutover.json',
  frontendManifest: 'frontend-release.json', frontendInstallState: 'frontend-install-state.json', frontendTlsSmoke: 'frontend-normal-tls-smoke.json', frontendCriticalChunks: 'frontend-critical-chunks.json',
  crmReadOnly: 'crm-readonly-preflight.json', operatorIdentity: 'operator-identity.json',
};
const FEATURE = 'operator-feature-rollout.json', PROFILES = ['whatsapp', 'customers', 'users'];
const AUDIT_SCRIPT_SHA = 'b09e545c7c6f8c59d4a23544537621da9938a517d876a6fb8862f05bf5d582a4';
const RESTORATION_CONTROL = '/home/inpulse/odim-whatsapp-unblock-20261116';
const RESTORATION_SCRIPT_SHA = '8400f5b3f12be9f2d4c727cf93d35a6d1e54ce9f5b1fc6679e69793dc5549ff7';
const AMENDMENTS = [
  { control: 'connection-fix', manifest: 'backend-amendment.json', verification: 'backend-amendment-verification.json', scope: { instances: ['dist/services/tenant-database.service.js', 'dist/tenant-database/mysql-pool.js'] } },
  { control: 'connection-observability', manifest: 'backend-observability-amendment.json', verification: 'backend-observability-amendment-verification.json', scope: { instances: ['dist/tenant-database/mysql-pool.js'] } },
  { control: 'connection-compatibility', manifest: 'backend-compatibility-amendment.json', verification: 'backend-compatibility-amendment-verification.json', scope: { instances: ['dist/services/tenant-database.service.js', 'dist/tenant-database/mysql-pool.js', 'dist/tenant-database/tenant-database.js'], customers: ['dist/crm-registration/transport.js'] } },
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => sha(fs.readFileSync(file));
function regular(file) { const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink(), 'READINESS_REGULAR_FILE'); return stat; }
function safe(root, name) {
  assert(typeof name === 'string' && name && !name.includes('\\') && !name.split('/').some(p => !p || p === '.' || p === '..' || p === '.env' || p.startsWith('.env.')), 'READINESS_SAFE_PATH');
  const result = path.resolve(root, name); assert(result.startsWith(path.resolve(root) + path.sep), 'READINESS_PATH_BOUNDARY');
  for (let here = path.dirname(result); here !== path.resolve(root); here = path.dirname(here)) { const stat = fs.lstatSync(here); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'READINESS_SYMLINK_PARENT'); assert(path.dirname(here) !== here); }
  return result;
}
function json(file) { regular(file); return JSON.parse(fs.readFileSync(file)); }
function hashMap(root, map) { assert(map && typeof map === 'object' && !Array.isArray(map), 'READINESS_HASH_MAP'); for (const [name, expected] of Object.entries(map)) { assert(/^[a-f0-9]{64}$/.test(expected), 'READINESS_SHA256'); const file = safe(root, name); regular(file); assert.equal(fileHash(file), expected, 'READINESS_LIVE_HASH:' + name); } }
function envMetadata(root, includeDist) {
  const entries = []; for (const prefix of includeDist ? ['', 'dist'] : ['']) for (const name of fs.readdirSync(path.join(root, prefix))) if (name === '.env' || name.startsWith('.env.')) { const stat = regular(path.join(root, prefix, name)); entries.push([prefix ? prefix + '/' + name : name, [stat.dev, stat.ino, stat.size, stat.mtimeMs]]); }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
function tree(root, jsOnly = false, skipMutable = false) {
  const result = {}; const first = fs.lstatSync(root); assert(first.isDirectory() && !first.isSymbolicLink(), 'READINESS_REGULAR_TREE');
  function walk(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { if (skipMutable && dir === root && ['node_modules', '.wwebjs_auth', '.wwebjs_cache'].includes(item.name)) continue; assert(!item.isSymbolicLink(), 'READINESS_TREE_SYMLINK'); const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else { assert(item.isFile(), 'READINESS_TREE_FILE'); if (!jsOnly || item.name.endsWith('.js')) { const relative = path.relative(root, file).replaceAll('\\', '/'); safe(root, relative); result[relative] = fileHash(file); } } } }
  walk(root); return result;
}
function normalRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url), limit = options.maxBytes || 4194304;
    assert((parsed.protocol === 'https:' && parsed.origin === ORIGIN) || (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && ['8002', '8005'].includes(parsed.port)), 'READINESS_HTTP_ORIGIN');
    const req = (parsed.protocol === 'https:' ? https : http).request(parsed, { method: options.method || 'GET', headers: options.headers || {}, rejectUnauthorized: true, timeout: 15000 }, response => {
      const chunks = []; let size = 0; response.on('data', data => { size += data.length; if (size > limit) req.destroy(Error('READINESS_HTTP_SIZE')); else chunks.push(data); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })); response.on('error', reject);
    }); req.on('timeout', () => req.destroy(Error('READINESS_HTTP_TIMEOUT'))); req.on('error', () => reject(Error('READINESS_HTTP_FAILED'))); if (options.body) req.write(options.body); req.end();
  });
}
function readinessCode(error) {
  const found = /^READINESS_[A-Z0-9_]{1,72}(?=[:\r\n]|$)/.exec(typeof error?.message === 'string' ? error.message : '');
  return found ? found[0] : 'READINESS_UNCONFIRMED';
}
function createReadiness(options = {}) {
  const control = options.control || CONTROL, targets = options.targets || TARGETS, keyFile = options.keyFile || RUNTIME_KEY;
  const owner = options.owner || (() => { assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1003); assert.equal(control, CONTROL); const stat = fs.lstatSync(control); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 1003 && (stat.mode & 0o077) === 0, 'READINESS_PRIVATE_CONTROL'); assert.equal(fs.realpathSync(control), control); });
  const snapshot = options.snapshot || (() => Object.fromEntries(APPS.map(app => [app, cp.execFileSync(PM2, ['pid', app], { encoding: 'utf8', timeout: 10000 }).trim()])));
  const request = options.request || normalRequest, loadHelper = options.loadHelper || (file => require(file));
  function pinnedBytes(plan, reference, expectedName) {
    assert(reference && reference.file === expectedName && /^[a-f0-9]{64}$/.test(reference.sha256), 'READINESS_REFERENCE'); assert.equal(plan.evidence[expectedName], reference.sha256, 'READINESS_EVIDENCE_LINK');
    const file = safe(control, expectedName); regular(file); assert.equal(fileHash(file), reference.sha256, 'READINESS_EVIDENCE_HASH'); return fs.readFileSync(file);
  }
  function pinned(plan, reference, expectedName) { return JSON.parse(pinnedBytes(plan, reference, expectedName)); }
  function original(copyRef, name) { const file = safe(control, name); regular(file); assert.equal(fileHash(file), copyRef.sha256, 'READINESS_ORIGINAL_RECEIPT:' + name); }
  function fixed(c) { assert(targets[c.name], 'READINESS_COMPONENT'); assert.equal(c.app, targets[c.name].app); assert.equal(c.live, targets[c.name].live); assert.equal(fs.realpathSync(c.live), path.resolve(c.live), 'READINESS_LIVE_ROOT'); }
  function keyMetadata() { const stat = regular(keyFile); assert(stat.size >= 32 && stat.size <= 4096 && (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'READINESS_PRIVATE_KEY'); return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, uid: stat.uid, mode: stat.mode & 0o777 }; }
  function responseJson(response) { assert(response.body.length <= 262144, 'READINESS_JSON_SIZE'); return JSON.parse(response.body.toString()); }
  async function signed(key, port, pathname, body) {
    const timestamp = String(Date.now()), nonce = crypto.randomUUID(), bytes = body === undefined ? '' : JSON.stringify(body), method = body === undefined ? 'GET' : 'POST';
    const signature = crypto.createHmac('sha256', key).update(`${timestamp}\n${nonce}\n${pathname}\n${bytes}`).digest('hex');
    return request(`http://127.0.0.1:${port}${pathname}`, { method, maxBytes: 262144, headers: { 'content-type': 'application/json', 'x-operator-timestamp': timestamp, 'x-operator-nonce': nonce, 'x-operator-signature': signature }, body: bytes });
  }
  const run = async function verifyReadiness(plan) {
    owner(); assert.equal(plan.environment, 'production'); assert.equal(plan.control, control); assert.equal(plan.instance, 'odim'); assert.equal(plan.operatorId, 534);
    const r = plan.readiness; assert(r && r.version === 1 && r.root === control && plan.evidence, 'READINESS_CONTRACT');
    const docs = Object.fromEntries(Object.entries(REFS).map(([field, filename]) => [field, pinned(plan, r[field], filename)]));
    assert(!r.backendAmendment && !r.backendAmendmentVerification, 'READINESS_USE_AMENDMENT_CHAIN');
    const chain = r.backendAmendments || []; assert(Array.isArray(chain) && chain.length <= AMENDMENTS.length, 'READINESS_AMENDMENT_CHAIN');
    const amendments = chain.map((entry, index) => ({ manifest: pinned(plan, entry.manifest, AMENDMENTS[index].manifest), verification: pinned(plan, entry.verification, AMENDMENTS[index].verification), reference: entry, location: AMENDMENTS[index] }));
    const restart = r.backendObservedRestart ? pinned(plan, r.backendObservedRestart, 'backend-observed-restart.json') : null;
    assert(!restart || amendments.length === 3, 'READINESS_OBSERVED_RESTART_POSITION');
    const reviewFile = safe(control, plan.review.file); regular(reviewFile); assert.equal(fileHash(reviewFile), plan.review.sha256, 'READINESS_REVIEW_HASH'); const review = json(reviewFile);
    const { backendStatic: base, backendEffective: effective, backendInstallState: backend, backendVerification: verification, cutover, frontendManifest: fronts, frontendInstallState: frontState, frontendTlsSmoke: smoke, frontendCriticalChunks: critical, crmReadOnly: crm, operatorIdentity: actor } = docs;
    for (const doc of [base, effective, fronts]) { assert.equal(doc.version, 1); assert.equal(doc.environment, 'production'); }
    assert.deepEqual(base.components.map(c => c.name), ['instances', 'whatsapp', 'customers', 'users']); assert.deepEqual(fronts.components.map(c => c.name), ['legacy', 'modern']);
    assert.equal(cutover.version, 1); assert.equal(cutover.whatsappPid, '0', 'READINESS_CUTOVER_PID'); assert.equal(cutover.staticManifestHash, r.backendStatic.sha256); assert.equal(effective.staticManifestHash, r.backendStatic.sha256);
    assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cutover.effectiveAt) && new Date(cutover.effectiveAt).toISOString() === cutover.effectiveAt, 'READINESS_CUTOVER_UTC');
    const profile = { version: 1, instance: 'odim', allowedOperatorIds: [534], effectiveAt: cutover.effectiveAt, features: { operator: true, telephony: true, crm: true, whatsapp: true } };
    assert.equal(cutover.profile, JSON.stringify(profile, null, 2) + '\n'); assert.equal(sha(cutover.profile), cutover.profileSha256); assert.equal(review.commonProfileSha256, cutover.profileSha256, 'READINESS_REVIEW_PROFILE'); assert.deepEqual(review.allowedOperatorIds, [534]); assert.deepEqual(review.features, profile.features);
    const derived = JSON.parse(JSON.stringify(base)); derived.staticManifestHash = r.backendStatic.sha256; derived.featureCutover = { effectiveAt: cutover.effectiveAt, profileSha256: cutover.profileSha256 };
    for (const c of derived.components) if (PROFILES.includes(c.name)) { assert.equal(c.files[FEATURE], null); assert.equal(c.before[FEATURE], null); c.files[FEATURE] = cutover.profileSha256; }
    assert.deepEqual(effective, derived, 'READINESS_EFFECTIVE_LINKAGE');
    assert.equal(review.whatsappPilot, false, 'READINESS_WHATSAPP_EXISTING_PERMISSIONS');
    const liveEffective = JSON.parse(JSON.stringify(effective)); let previousAmendmentSha = null;
    const backendPids = Object.fromEntries(effective.components.map(c => [c.app, verification.afterPids[c.app]]));
    for (const entry of amendments) {
      const amendment = entry.manifest, amendmentVerification = entry.verification;
      assert(amendment.version === 1 && amendment.environment === 'production' && amendment.control === control + '/' + entry.location.control, 'READINESS_AMENDMENT_CONTROL');
      assert.equal(amendment.baseEffectiveManifestSha256, r.backendEffective.sha256, 'READINESS_AMENDMENT_BASE'); assert.deepEqual(amendment.components.map(c => c.name), Object.keys(entry.location.scope), 'READINESS_AMENDMENT_COMPONENTS');
      assert.equal(amendment.previousAmendmentSha256 ?? null, previousAmendmentSha, 'READINESS_AMENDMENT_PREVIOUS');
      if (entry.location.control === 'connection-compatibility' && restart) {
        assert.equal(amendment.observedRestartSha256, r.backendObservedRestart.sha256, 'READINESS_OBSERVED_RESTART_LINK');
        assert(restart.version === 1 && restart.environment === 'production' && restart.component === 'whatsapp' && restart.cause === 'ORDERLY_PM2_RESTART_INITIATOR_UNATTRIBUTED', 'READINESS_OBSERVED_RESTART_CONTRACT');
        assert.equal(restart.baseEffectiveManifestSha256, r.backendEffective.sha256); assert.equal(restart.previousAmendmentSha256, previousAmendmentSha, 'READINESS_OBSERVED_RESTART_PREVIOUS');
        assert.equal(String(restart.previousPid), String(backendPids.whatsapp), 'READINESS_OBSERVED_RESTART_OLD_PID'); assert(/^[1-9][0-9]*$/.test(String(restart.observedPid)) && String(restart.observedPid) !== String(restart.previousPid), 'READINESS_OBSERVED_RESTART_NEW_PID');
        const audit = pinned(plan, restart.audit, 'observed-restart-audit.json');
        pinnedBytes(plan, restart.auditScript, 'audit-backend-files.cjs'); assert.equal(restart.auditScript.sha256, options.auditScriptSha || AUDIT_SCRIPT_SHA, 'READINESS_OBSERVED_RESTART_SCRIPT');
        assert(audit.version === 1 && audit.ok === true && audit.environmentContentsRead === false, 'READINESS_OBSERVED_RESTART_AUDIT'); assert.equal(audit.baseEffectiveManifestSha256, r.backendEffective.sha256);
        assert.deepEqual(audit.amendments, amendments.slice(0, 2).map(a => ({ file: a.location.control + '/backend-amendment.json', sha256: a.reference.manifest.sha256 })), 'READINESS_OBSERVED_RESTART_AUDIT_CHAIN');
        assert.deepEqual(audit.components.map(c => c.component), effective.components.map(c => c.name), 'READINESS_OBSERVED_RESTART_AUDIT_SCOPE');
        for (const c of liveEffective.components) {
          const row = audit.components.find(a => a.component === c.name), expected = { ...Object.fromEntries(Object.entries(c.before).filter(([, h]) => h !== null)), ...c.files, ...c.config };
          assert(row.ok && row.inventoryMatches && row.environmentMatches && Array.isArray(row.differences) && row.differences.length === 0 && row.verifiedFiles === Object.keys(expected).length, 'READINESS_OBSERVED_RESTART_BYTE_PINS');
          assert.equal(String(row.pid), String(c.name === 'whatsapp' ? restart.observedPid : backendPids[c.app]), 'READINESS_OBSERVED_RESTART_AUDIT_PID');
        }
        const lines = pinnedBytes(plan, restart.pm2Evidence, 'observed-restart-pm2.txt').toString().trim().split(/\r?\n/), match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d): PM2 log: Stopping app:whatsapp id:(\d+)$/.exec(lines[0] || ''); assert(match, 'READINESS_OBSERVED_RESTART_PM2');
        const prefix = match[1] + ': PM2 log: ', id = match[2]; assert.deepEqual(lines, [prefix + 'Stopping app:whatsapp id:' + id, prefix + `App [whatsapp:${id}] exited with code [0] via signal [SIGINT]`, prefix + `App [whatsapp:${id}] starting in -fork mode-`, prefix + `App [whatsapp:${id}] online`], 'READINESS_OBSERVED_RESTART_PM2');
        backendPids.whatsapp = restart.observedPid;
      } else assert(!Object.hasOwn(amendment, 'observedRestartSha256'), 'READINESS_OBSERVED_RESTART_UNUSED');
      assert(amendmentVerification.ok && amendmentVerification.configUnchanged && amendmentVerification.environmentMetadataUnchanged && amendmentVerification.nonTargetPidsUnchanged, 'READINESS_AMENDMENT_VERIFY');
      assert.equal(amendmentVerification.amendmentSha256, entry.reference.manifest.sha256, 'READINESS_AMENDMENT_VERIFY_HASH'); assert.equal(amendmentVerification.baseEffectiveManifestSha256, r.backendEffective.sha256, 'READINESS_AMENDMENT_VERIFY_BASE');
      assert.deepEqual(Object.keys(amendment.baselinePids).sort(), [...APPS].sort(), 'READINESS_AMENDMENT_PID_SCOPE');
      for (const c of effective.components) {
        assert.equal(String(amendment.baselinePids[c.app]), String(backendPids[c.app]), 'READINESS_AMENDMENT_PREVIOUS_PID');
        const after = amendmentVerification.afterPids[c.app]; assert(/^[1-9][0-9]*$/.test(String(after)), 'READINESS_AMENDMENT_PID_RUNNING');
        if (!Object.hasOwn(entry.location.scope, c.name)) assert.equal(String(after), String(backendPids[c.app]), 'READINESS_AMENDMENT_OTHER_BACKEND_PID');
        else assert.notEqual(String(after), String(backendPids[c.app]), 'READINESS_AMENDMENT_RESTART_PID');
      }
      for (const patch of amendment.components) {
        const originalComponent = liveEffective.components.find(c => c.name === patch.name); fixed(patch);
        assert.deepEqual(Object.keys(patch.files).sort(), [...entry.location.scope[patch.name]].sort(), 'READINESS_AMENDMENT_SCOPE');
        const originalMap = { ...Object.fromEntries(Object.entries(originalComponent.before).filter(([, value]) => value !== null)), ...originalComponent.files };
        assert.deepEqual(patch.before, originalMap, 'READINESS_AMENDMENT_BEFORE'); assert.deepEqual(patch.config, originalComponent.config, 'READINESS_AMENDMENT_CONFIG'); assert.deepEqual(patch.environmentMetadata, originalComponent.environmentMetadata, 'READINESS_AMENDMENT_ENV');
        assert.deepEqual(patch.healthStatuses, originalComponent.healthStatuses, 'READINESS_AMENDMENT_HEALTH_CONTRACT'); assert(patch.healthStatuses.includes(amendmentVerification.health[patch.name]), 'READINESS_AMENDMENT_HEALTH');
        for (const name of Object.keys(patch.files)) assert(typeof originalMap[name] === 'string', 'READINESS_AMENDMENT_EXISTING_ONLY');
        Object.assign(originalComponent.files, patch.files); backendPids[patch.app] = amendmentVerification.afterPids[patch.app];
      }
      original(entry.reference.manifest, entry.location.control + '/backend-amendment.json'); original(entry.reference.verification, entry.location.control + '/receipts/verification.json');
      previousAmendmentSha = entry.reference.manifest.sha256;
    }
    if (r.whatsappRestoration) {
      assert.equal(amendments.length, 3, 'READINESS_RESTORATION_POSITION'); const refs = r.whatsappRestoration;
      const release = pinned(plan, refs.manifest, 'whatsapp-restoration-release.json'), receipt = pinned(plan, refs.receipt, 'whatsapp-restoration-receipt.json'), audit = pinned(plan, refs.audit, 'whatsapp-restoration-audit.json');
      pinnedBytes(plan, refs.auditScript, 'audit-whatsapp-restoration.cjs'); assert.equal(refs.auditScript.sha256, options.restorationScriptSha || RESTORATION_SCRIPT_SHA, 'READINESS_RESTORATION_SCRIPT');
      const external = options.restorationControl || RESTORATION_CONTROL;
      for (const [ref, name] of [[refs.manifest, 'release.json'], [refs.receipt, 'receipt.json']]) { const file = safe(external, name); regular(file); assert.equal(fileHash(file), ref.sha256, 'READINESS_RESTORATION_ORIGINAL'); }
      assert(Array.isArray(release)); assert.deepEqual(release.map(row => row.app), ['whatsapp', 'users', 'customers'], 'READINESS_RESTORATION_SCOPE');
      assert(receipt.status === 'installed' && receipt.livePolicyChecks === true, 'READINESS_RESTORATION_RECEIPT'); assert.deepEqual(receipt.components.map(row => row.app), release.map(row => row.app));
      for (const row of release) {
        const c = liveEffective.components.find(c => c.app === row.app), name = 'dist/operator-features/rollout.js';
        assert.equal(row.path, path.join(c.live, name), 'READINESS_RESTORATION_PATH'); assert.equal(row.file, row.app + '.js'); assert.equal(row.port, { whatsapp: 8005, users: 8001, customers: 8002 }[row.app]);
        assert.equal(row.before, c.files[name], 'READINESS_RESTORATION_BEFORE'); assert(/^[a-f0-9]{64}$/.test(row.after) && row.after !== row.before, 'READINESS_RESTORATION_AFTER'); assert.equal(receipt.components.find(item => item.app === row.app).sha256, row.after); c.files[name] = row.after;
      }
      assert(audit.version === 1 && audit.ok && audit.environmentContentsRead === false && audit.crmWrites === 0 && audit.providerCalls === 0 && audit.sipCalls === 0, 'READINESS_RESTORATION_AUDIT');
      assert.equal(audit.restorationManifestSha256, refs.manifest.sha256); assert.equal(audit.restorationReceiptSha256, refs.receipt.sha256); assert.equal(audit.baseEffectiveManifestSha256, r.backendEffective.sha256); assert(Date.parse(audit.at) >= Date.parse(receipt.at), 'READINESS_RESTORATION_TIME');
      assert.deepEqual(audit.amendments, amendments.map(a => ({ file: a.location.control + '/backend-amendment.json', sha256: a.reference.manifest.sha256 })), 'READINESS_RESTORATION_CHAIN'); assert.deepEqual(audit.components.map(c => c.component), effective.components.map(c => c.name));
      for (const c of liveEffective.components) {
        const row = audit.components.find(a => a.component === c.name), expected = { ...Object.fromEntries(Object.entries(c.before).filter(([, h]) => h !== null)), ...c.files, ...c.config };
        assert(row.ok && row.inventoryMatches && row.environmentMatches && Array.isArray(row.differences) && row.differences.length === 0 && row.verifiedFiles === Object.keys(expected).length, 'READINESS_RESTORATION_BYTE_PINS');
        assert(/^[1-9][0-9]*$/.test(String(row.pid)), 'READINESS_RESTORATION_PID');
        if (c.name === 'instances') { assert.equal(String(row.pid), String(backendPids[c.app])); assert.deepEqual(row.capabilities, []); }
        else { assert.notEqual(String(row.pid), String(backendPids[c.app]), 'READINESS_RESTORATION_RESTART_PID'); assert.deepEqual(row.capabilities, [1, 6, 32, 534, 535].map(id => ({ operatorId: id, features: { operator: id === 534, telephony: id === 534, crm: id === 534, whatsapp: true } })), 'READINESS_RESTORATION_CAPABILITIES'); backendPids[c.app] = row.pid; }
      }
    }
    original(r.cutover, 'receipts/cutover.json'); original(r.backendInstallState, 'receipts/install-state.json'); original(r.backendVerification, 'receipts/verification.json'); original(r.frontendManifest, 'frontend/release.json'); original(r.frontendInstallState, 'frontend/receipts/install-state.json');
    assert.equal(backend.phase, 'installed'); assert.equal(backend.staticManifestHash, r.backendStatic.sha256); assert.equal(backend.effectiveManifestHash, r.backendEffective.sha256); assert.deepEqual(backend.beforePids, base.baselinePids);
    assert(backend.cutover.stopRequested && backend.cutover.whatsappHealthy && backend.cutover.profilesReady, 'READINESS_CUTOVER_STATE'); assert.equal(backend.cutover.profileSha256, cutover.profileSha256); assert.equal(backend.cutover.effectiveAt, cutover.effectiveAt);
    assert(verification.ok && verification.configUnchanged && verification.environmentMetadataUnchanged && verification.nonTargetPidsUnchanged, 'READINESS_BACKEND_VERIFY'); assert.equal(verification.staticManifestHash, r.backendStatic.sha256); assert.equal(verification.effectiveManifestHash, r.backendEffective.sha256); assert.equal(verification.profileSha256, cutover.profileSha256);
    assert.equal(frontState.phase, 'installed'); assert.equal(frontState.manifestHash, sha(JSON.stringify(fronts)), 'READINESS_FRONTEND_STATE_LINK');
    const current = snapshot(), installedApps = new Set([...effective.components, ...fronts.components].map(c => c.app)); assert.deepEqual(Object.keys(base.baselinePids).sort(), [...APPS].sort());
    for (const app of APPS) { assert(/^[1-9][0-9]*$/.test(String(current[app])), 'READINESS_PID_RUNNING:' + app); if (!installedApps.has(app)) assert.equal(String(current[app]), String(base.baselinePids[app]), 'READINESS_STABLE_PID:' + app); }
    for (const c of liveEffective.components) {
      fixed(c); assert(backend.components[c.name]?.installed && backend.components[c.name]?.started, 'READINESS_BACKEND_INSTALLED'); assert(c.healthStatuses.includes(backend.components[c.name].health) && c.healthStatuses.includes(verification.health[c.name]), 'READINESS_BACKEND_HEALTH');
      assert.equal(String(verification.afterPids[c.app]), String(backend.afterPids[c.app]), 'READINESS_BACKEND_STATE_PID');
      assert.equal(String(current[c.app]), String(backendPids[c.app]), 'READINESS_BACKEND_PID');
      const expected = Object.fromEntries(Object.entries(c.before).filter(([n, h]) => n.startsWith('dist/') && n.endsWith('.js') && h !== null)); Object.assign(expected, Object.fromEntries(Object.entries(c.files).filter(([n]) => n.startsWith('dist/') && n.endsWith('.js'))));
      assert.deepEqual(tree(path.join(c.live, 'dist'), true, true), Object.fromEntries(Object.entries(expected).map(([n, h]) => [n.slice(5), h])), 'READINESS_BACKEND_INVENTORY');
      hashMap(c.live, c.files); hashMap(c.live, c.config); assert.deepEqual(envMetadata(c.live, true), c.environmentMetadata, 'READINESS_BACKEND_ENV_STAT');
    }
    for (const c of fronts.components) {
      fixed(c); assert(frontState.components[c.name]?.installed && frontState.components[c.name]?.started && c.healthStatuses.includes(frontState.components[c.name].health), 'READINESS_FRONTEND_INSTALLED'); assert.equal(String(current[c.app]), String(frontState.afterPids[c.app]), 'READINESS_FRONTEND_PID');
      hashMap(c.live, c.files); hashMap(c.live, c.preserveFiles); hashMap(c.live, c.config); assert.deepEqual(envMetadata(c.live, false), c.environmentMetadata, 'READINESS_FRONTEND_ENV_STAT');
      assert.equal(fs.readFileSync(safe(c.live, '.next/BUILD_ID'), 'utf8').trim(), c.newBuild, 'READINESS_BUILD_ID');
      const signature = ['BUILD_ID', 'routes-manifest.json', 'required-server-files.json'].map(name => name + ':' + fileHash(safe(c.live, '.next/' + name))).join('|'); assert.equal(signature, c.buildSignature, 'READINESS_BUILD_SIGNATURE'); assert.deepEqual(tree(path.join(c.live, '.next/server')), c.runtimeAfter, 'READINESS_FRONTEND_RUNTIME');
    }
    for (const name of PROFILES) { const file = safe(targets[name].live, FEATURE); regular(file); assert.equal(fs.readFileSync(file, 'utf8'), cutover.profile, 'READINESS_IDENTICAL_PROFILE');
      const helperFile = safe(targets[name].live, 'dist/operator-features/rollout.js'); assert(effective.components.find(c => c.name === name).files['dist/operator-features/rollout.js'], 'READINESS_PINNED_HELPER');
      const helper = loadHelper(helperFile); assert.equal(typeof helper.operatorFeatures, 'function');
      for (const userId of [1, 6, 32, 534, 535]) { const role = userId === 6 ? 'ADMIN' : 'ATIVO', value = helper.operatorFeatures({ instance: 'odim', userId, role }); assert(value.managed && value.operatorId === userId && value.revision === cutover.profileSha256, 'READINESS_HELPER_PRINCIPAL'); assert.deepEqual(value.features, { operator: userId === 534, telephony: userId === 534, crm: userId === 534, whatsapp: true }, 'READINESS_HELPER_FEATURES'); assert.doesNotThrow(() => helper.assertOperatorFeature({ instance: 'odim', userId }, 'whatsapp', () => { throw Error('READINESS_WHATSAPP_PILOT_DEPENDENCY'); }), 'READINESS_WHATSAPP_EXISTING_PERMISSIONS'); }
      if (name === 'whatsapp') assert.deepEqual(helper.whatsappEligibleIds('odim', [1, 6, 32, 534, 535], () => { throw Error('READINESS_WHATSAPP_PILOT_DEPENDENCY'); }), [1, 6, 32, 534, 535], 'READINESS_WHATSAPP_ELIGIBILITY');
      const other = helper.operatorFeatures({ instance: 'infotec', userId: 534, role: 'ADMIN' }); assert.equal(other.managed, false); assert.deepEqual(other.features, { operator: null, telephony: null, crm: null, whatsapp: null });
    }
    assert(crm.passed && crm.instance === 'odim' && crm.operatorId === 534 && crm.role === 'ATIVO' && crm.revision === cutover.profileSha256 && crm.transportLedgerReady === true && crm.reviewedTriggerCount === 5, 'READINESS_CRM_PREFLIGHT');
    assert.deepEqual(crm.features, profile.features); assert(crm.crmWrites === 0 && crm.providerCalls === 0 && crm.sipCalls === 0 && crm.blockedFinancialProjection === true && crm.financialReadOnlyFields === 5, 'READINESS_CRM_READONLY'); assert(Date.parse(crm.at) >= Date.parse(cutover.effectiveAt), 'READINESS_CRM_AFTER_CUTOVER');
    assert(actor.conexao === 'tenant-odim' && actor.linhas === 1 && actor.truncado === false && actor.timeout === false && Array.isArray(actor.rows) && actor.rows.length === 1, 'READINESS_OPERATOR_SQL'); const row = actor.rows[0]; assert(Number(row.CODIGO) === 534 && String(row.ATIVO).trim() === 'SIM' && String(row.NIVEL).trim() === 'ATIVO', 'READINESS_ACTIVE_OPERATOR');
    assert(smoke.passed === true && smoke.origin === ORIGIN && smoke.tls === 'normal verification; no insecure fallback', 'READINESS_NORMAL_TLS'); assert(Date.parse(smoke.atUtc) >= Date.parse(frontState.completedAt), 'READINESS_SMOKE_AFTER_INSTALL'); assert(Array.isArray(critical.chunks), 'READINESS_CRITICAL_CHUNKS');
    for (const c of fronts.components) {
      const value = smoke.variants.find(v => v.variant === c.name); assert(value?.passed && value.buildId === c.newBuild && value.pages.length && value.pages.every(p => p.status === 200 && p.renderedBuildId === c.newBuild), 'READINESS_NATIVE_FRONTEND_SMOKE');
      const page = value.pages.find(p => p.path === c.healthPath) || value.pages[0], asset = critical.chunks.find(a => a.variant === c.name); assert(asset && /^[a-f0-9]{64}$/.test(asset.sha256), 'READINESS_CRITICAL_ASSET');
      assert(value.assets.some(a => a.path === asset.path && a.status === 200 && a.matchesFrozen === true && a.sha256 === asset.sha256), 'READINESS_FROZEN_ASSET_SMOKE');
      for (const p of [page.path, asset.path]) assert(typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !/[\r\n]/.test(p), 'READINESS_PUBLIC_PATH');
      const html = await request(ORIGIN + page.path); assert.equal(html.status, 200, 'READINESS_FRESH_PUBLIC_PAGE'); assert(html.body.includes(Buffer.from(c.newBuild)), 'READINESS_FRESH_PUBLIC_BUILD');
      const prefix = c.name === 'modern' ? '/nova/_next/' : '/_next/'; assert(asset.path.startsWith(prefix + 'static/'), 'READINESS_ASSET_PATH'); const local = safe(c.live, '.next/' + decodeURIComponent(asset.path.slice(prefix.length))); regular(local); assert.equal(fileHash(local), asset.sha256, 'READINESS_LOCAL_CRITICAL_ASSET');
      const fetched = await request(ORIGIN + asset.path); assert.equal(fetched.status, 200); assert.equal(sha(fetched.body), asset.sha256, 'READINESS_FRESH_CRITICAL_ASSET');
    }
    assert.equal(keyFile, options.keyFile || RUNTIME_KEY); assert.deepEqual(keyMetadata(), r.runtimeKeyMetadata, 'READINESS_RUNTIME_KEY_METADATA');
    for (const name of ['whatsapp', 'customers']) { const p = json(safe(targets[name].live, 'operator-runtime.config.json')); assert.equal(p.authority, 'central-v1'); assert(p.instances.includes('odim')); assert.equal(p.signingKeyFile, keyFile, 'READINESS_ORIGINAL_RUNTIME_KEY'); }
    const key = fs.readFileSync(keyFile), privatePath = '/api/internal/operator-runtime/health';
    try {
      for (const [port, service] of [[8005, 'whatsapp'], [8002, 'customers']]) {
        const anonymous = await request(`http://127.0.0.1:${port}${privatePath}`, { maxBytes: 262144 }); assert.equal(anonymous.status, 401, 'READINESS_PRIVATE_ANONYMOUS');
        const signedResponse = await signed(key, port, privatePath); assert.equal(signedResponse.status, 200, 'READINESS_PRIVATE_HMAC'); const health = responseJson(signedResponse); assert(health.service === service && health.authority === 'central-v1' && health.protocolVersion === 1 && health.profile === 'valid' && health.instances.includes('odim'), 'READINESS_PRIVATE_HEALTH');
      }
      const pathname = '/api/internal/operator-runtime/odim/commands', command = (actorId, action) => signed(key, 8005, pathname, { operation: 'operator.runtime', actorId, action, input: {} });
      const policyResponse = await command(1, 'policy'); assert.equal(policyResponse.status, 200); const policy = responseJson(policyResponse).data; assert(policy.authority === 'central-v1' && typeof policy.enabled === 'boolean', 'READINESS_RAW_POLICY');
      for (const id of [535, 6]) { const denied = await command(id, 'status'); assert.equal(denied.status, 403); assert.equal(responseJson(denied).code, 'OPERATOR_FEATURE_PILOT_REQUIRED'); }
      const statusResponse = await command(534, 'status'), status = responseJson(statusResponse);
      if (!policy.enabled) { assert.equal(statusResponse.status, 503); assert.equal(status.code, 'OPERATOR_FEATURE_PILOT_PENDING'); }
      else { assert.equal(statusResponse.status, 200); assert(status.data?.enabled === true && status.data.authority === 'central-v1' && status.data.policyRevision === plan.review.sha256 && status.data.policyVersion === 4, 'READINESS_ACTIVE_REVIEW'); }
      return { ok: true, observationsMayInitializeOperatorState: true, whatsappExistingPermissionsPreserved: true, components: 6, profileSha256: cutover.profileSha256, policyEnabled: policy.enabled, privateHealth: true, normalTls: true, crmWrites: 0, providerCalls: 0, sipCalls: 0 };
    } finally { key.fill(0); }
  };
  return async function verifyReadiness(plan) {
    try { return await run(plan); }
    catch (error) {
      const code = readinessCode(error); let failure = error && typeof error === 'object' ? error : Error(code);
      try { failure.code = code; } catch { failure = Object.assign(Error(code), { code }); }
      throw failure;
    }
  };
}
const verifyReadiness = createReadiness();
module.exports = { verifyReadiness, createReadiness, readinessCode, CONTROL, TARGETS, APPS, REFS, AMENDMENTS, FEATURE, ORIGIN, AUDIT_SCRIPT_SHA, RESTORATION_SCRIPT_SHA };
