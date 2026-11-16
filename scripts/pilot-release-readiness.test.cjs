'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createReadiness, APPS, REFS, ORIGIN, FEATURE } = require('./pilot-release-readiness.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); };
const hash = file => sha(fs.readFileSync(file));
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-readiness-')); t.after(() => { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('pilot-readiness-')); fs.rmSync(root, { recursive: true, force: true }); });
  const control = path.join(root, 'control'), targets = {}, current = Object.fromEntries(APPS.map((app, i) => [app, String(i + 100)])), baseline = { ...current };
  const profile = { version: 1, instance: 'odim', allowedOperatorIds: [534], effectiveAt: '2026-11-16T10:00:00.123Z', features: { operator: true, telephony: true, crm: true, whatsapp: true } }, profileRaw = JSON.stringify(profile, null, 2) + '\n', profileSha = sha(profileRaw);
  const keyFile = path.join(root, 'runtime-hmac.key'), key = Buffer.alloc(32, 17); write(keyFile, key); fs.chmodSync(keyFile, 0o600);
  const makeEnv = (live, dist) => { write(path.join(live, '.env'), 'synthetic fixture never read'); if (dist) write(path.join(live, 'dist/.env'), 'synthetic fixture never read'); const names = dist ? ['.env', 'dist/.env'] : ['.env']; return Object.fromEntries(names.map(name => { const s = fs.lstatSync(path.join(live, name)); return [name, [s.dev, s.ino, s.size, s.mtimeMs]]; })); };
  const backends = [], frontend = [];
  for (const name of ['instances', 'whatsapp', 'customers', 'users', 'legacy', 'modern']) {
    const app = name === 'legacy' ? 'frontend' : name === 'modern' ? 'odim-modern-frontend' : name, live = path.join(root, name); targets[name] = { app, live }; fs.mkdirSync(live); current[app] = String(Number(current[app]) + 200);
    write(path.join(live, 'package.json'), '{}'); const config = { 'package.json': hash(path.join(live, 'package.json')) };
    if (!['legacy', 'modern'].includes(name)) {
      write(path.join(live, 'dist/main.js'), 'approved main ' + name); const files = { 'dist/main.js': hash(path.join(live, 'dist/main.js')) }, before = { 'dist/main.js': sha('old main ' + name) };
      if (name !== 'instances') { write(path.join(live, FEATURE), profileRaw); write(path.join(live, 'dist/operator-features/rollout.js'), 'approved pure helper ' + name); files['dist/operator-features/rollout.js'] = hash(path.join(live, 'dist/operator-features/rollout.js')); before['dist/operator-features/rollout.js'] = null; files[FEATURE] = null; before[FEATURE] = null; }
      if (['whatsapp', 'customers'].includes(name)) { write(path.join(live, 'operator-runtime.config.json'), { authority: 'central-v1', instances: ['odim'], signingKeyFile: keyFile }); config['operator-runtime.config.json'] = hash(path.join(live, 'operator-runtime.config.json')); }
      if (name === 'instances') for (const file of ['dist/services/tenant-database.service.js', 'dist/tenant-database/mysql-pool.js']) { write(path.join(live, file), 'original connection ' + file); before[file] = hash(path.join(live, file)); }
      backends.push({ name, app, live, files, before, config, environmentMetadata: makeEnv(live, true), healthStatuses: [200] });
    } else {
      write(path.join(live, 'source.ts'), 'reviewed source ' + name); write(path.join(live, 'preserved.ts'), 'old source');
      const newBuild = 'build-' + name; for (const [file, bytes] of Object.entries({ BUILD_ID: newBuild, 'routes-manifest.json': '{}', 'required-server-files.json': '{}', 'server/main.js': 'approved runtime', 'static/chunk.js': 'critical-' + name })) write(path.join(live, '.next', file), bytes);
      const buildSignature = ['BUILD_ID', 'routes-manifest.json', 'required-server-files.json'].map(n => n + ':' + hash(path.join(live, '.next', n))).join('|');
      frontend.push({ name, app, live, newBuild, buildSignature, files: { 'source.ts': hash(path.join(live, 'source.ts')) }, preserveFiles: { 'preserved.ts': hash(path.join(live, 'preserved.ts')) }, config, environmentMetadata: makeEnv(live, false), runtimeAfter: { 'main.js': hash(path.join(live, '.next/server/main.js')) }, healthStatuses: [200], healthPath: name === 'modern' ? '/nova/odim/login' : '/karsten/login' });
    }
  }
  const base = { version: 1, environment: 'production', components: backends, baselinePids: baseline };
  const effective = JSON.parse(JSON.stringify(base)), staticBytes = JSON.stringify(base, null, 2), staticSha = sha(staticBytes);
  effective.staticManifestHash = staticSha; effective.featureCutover = { effectiveAt: profile.effectiveAt, profileSha256: profileSha }; for (const c of effective.components) if (c.name !== 'instances') c.files[FEATURE] = profileSha;
  const cutover = { version: 1, whatsappPid: '0', staticManifestHash: staticSha, effectiveAt: profile.effectiveAt, profile: profileRaw, profileSha256: profileSha };
  const effectiveSha = sha(JSON.stringify(effective, null, 2)), health = Object.fromEntries(backends.map(c => [c.name, 200]));
  const backend = { phase: 'installed', staticManifestHash: staticSha, effectiveManifestHash: effectiveSha, beforePids: baseline, afterPids: { ...current }, components: Object.fromEntries(backends.map(c => [c.name, { started: true, installed: true, health: 200 }])), cutover: { stopRequested: true, whatsappHealthy: true, profilesReady: true, profileSha256: profileSha, effectiveAt: profile.effectiveAt } };
  const verification = { ok: true, configUnchanged: true, environmentMetadataUnchanged: true, nonTargetPidsUnchanged: true, staticManifestHash: staticSha, effectiveManifestHash: effectiveSha, profileSha256: profileSha, afterPids: { ...current }, health };
  const fronts = { version: 1, environment: 'production', components: frontend }, frontState = { phase: 'installed', manifestHash: sha(JSON.stringify(fronts)), completedAt: '2026-11-16T10:01:00Z', afterPids: { ...current }, components: Object.fromEntries(frontend.map(c => [c.name, { started: true, installed: true, health: 200 }])) };
  const critical = { chunks: frontend.map(c => ({ variant: c.name, path: (c.name === 'modern' ? '/nova' : '') + '/_next/static/chunk.js', sha256: hash(path.join(c.live, '.next/static/chunk.js')) })) };
  const smoke = { passed: true, atUtc: '2026-11-16T10:02:00Z', origin: ORIGIN, tls: 'normal verification; no insecure fallback', variants: frontend.map(c => ({ variant: c.name, buildId: c.newBuild, passed: true, pages: [{ path: c.healthPath, status: 200, renderedBuildId: c.newBuild }], assets: critical.chunks.filter(a => a.variant === c.name).map(a => ({ path: a.path, sha256: a.sha256, status: 200, matchesFrozen: true })), images: [] })) };
  const crm = { passed: true, at: '2026-11-16T10:02:00Z', instance: 'odim', operatorId: 534, role: 'ATIVO', revision: profileSha, features: profile.features, transportLedgerReady: true, reviewedTriggerCount: 5, crmWrites: 0, providerCalls: 0, sipCalls: 0, financialReadOnlyFields: 5, blockedFinancialProjection: true };
  const actor = { conexao: 'tenant-odim', linhas: 1, truncado: false, timeout: false, rows: [{ CODIGO: 534, NIVEL: 'ATIVO', ATIVO: 'SIM' }] };
  const docs = { backendStatic: base, backendEffective: effective, backendInstallState: backend, backendVerification: verification, cutover, frontendManifest: fronts, frontendInstallState: frontState, frontendTlsSmoke: smoke, frontendCriticalChunks: critical, crmReadOnly: crm, operatorIdentity: actor };
  const originals = { cutover: 'receipts/cutover.json', backendInstallState: 'receipts/install-state.json', backendVerification: 'receipts/verification.json', frontendManifest: 'frontend/release.json', frontendInstallState: 'frontend/receipts/install-state.json' };
  const plan = { version: 1, environment: 'production', control, instance: 'odim', operatorId: 534, evidence: {}, readiness: { version: 1, root: control } };
  const pin = (field, doc) => { const file = REFS[field] || (field === 'backendAmendment' ? 'backend-amendment.json' : 'backend-amendment-verification.json'); docs[field] = doc; write(path.join(control, file), doc); const ref = { file, sha256: hash(path.join(control, file)) }; plan.readiness[field] = ref; plan.evidence[file] = ref.sha256; if (originals[field]) write(path.join(control, originals[field]), fs.readFileSync(path.join(control, file))); };
  for (const [field, doc] of Object.entries(docs)) pin(field, doc);
  const review = { instance: 'odim', allowedOperatorIds: [534], commonProfileSha256: profileSha, features: profile.features }; write(path.join(control, 'review.json'), review); plan.review = { file: 'review.json', sha256: hash(path.join(control, 'review.json')) };
  const stat = fs.lstatSync(keyFile); plan.readiness.runtimeKeyMetadata = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, uid: stat.uid, mode: stat.mode & 0o777 };
  const requests = [], helpers = [];
  const request = async (url, options = {}) => {
    const parsed = new URL(url); requests.push({ url, options }); const body = options.body || '';
    const answer = (status, data) => ({ status, body: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)), headers: {} });
    if (parsed.origin === ORIGIN) { assert(!options.headers?.authorization); assert.equal(options.method || 'GET', 'GET'); const c = frontend.find(c => c.healthPath === parsed.pathname); if (c) return answer(200, 'HTML ' + c.newBuild); const asset = critical.chunks.find(c => c.path === parsed.pathname); assert(asset, 'only one approved critical asset per frontend'); return answer(200, 'critical-' + asset.variant); }
    assert.equal(parsed.hostname, '127.0.0.1'); assert(['8002', '8005'].includes(parsed.port));
    if (!options.headers?.['x-operator-signature']) return answer(401, { code: 'OPERATOR_RUNTIME_UNAUTHORIZED' });
    const headers = options.headers; assert.equal(headers['x-operator-signature'], crypto.createHmac('sha256', key).update(`${headers['x-operator-timestamp']}\n${headers['x-operator-nonce']}\n${parsed.pathname}\n${body}`).digest('hex'));
    if (parsed.pathname.endsWith('/health')) return answer(200, { service: parsed.port === '8002' ? 'customers' : 'whatsapp', authority: 'central-v1', protocolVersion: 1, instances: ['odim'], profile: 'valid' });
    const command = JSON.parse(body); assert(['policy', 'status'].includes(command.action)); assert.equal(command.operation, 'operator.runtime');
    if (command.action === 'policy') { assert.equal(command.actorId, 1); return answer(200, { data: { authority: 'central-v1', enabled: Boolean(overrides.active) } }); }
    if ([535, 6].includes(command.actorId)) return answer(403, { code: 'OPERATOR_FEATURE_PILOT_REQUIRED' });
    assert.equal(command.actorId, 534); return overrides.active ? answer(200, { data: { enabled: true, authority: 'central-v1', policyRevision: overrides.wrongReview ? 'f'.repeat(64) : plan.review.sha256, policyVersion: 4, settings: 0, sipReady: false } }) : answer(503, { code: 'OPERATOR_FEATURE_PILOT_PENDING' });
  };
  const loadHelper = file => { helpers.push(file); return { operatorFeatures: p => { const managed = p.instance === 'odim'; return { managed, operatorId: p.userId, revision: managed ? profileSha : null, features: Object.fromEntries(Object.keys(profile.features).map(f => [f, managed ? p.userId === 534 || Boolean(overrides.adminBypass && p.role === 'ADMIN') : null])) }; } }; };
  const options = { control, targets, keyFile, owner: () => {}, snapshot: () => ({ ...current }), request, loadHelper, ...overrides };
  function amend() {
    const c = effective.components[0], before = { ...Object.fromEntries(Object.entries(c.before).filter(([, h]) => h !== null)), ...c.files }, files = {};
    for (const name of ['dist/services/tenant-database.service.js', 'dist/tenant-database/mysql-pool.js']) { write(path.join(c.live, name), 'reviewed latin1 only odim ' + name); files[name] = hash(path.join(c.live, name)); }
    const amendment = { version: 1, environment: 'production', control: control + '/connection-fix', baseEffectiveManifestSha256: plan.readiness.backendEffective.sha256, components: [{ name: 'instances', app: 'instances', live: c.live, files, before, config: c.config, environmentMetadata: c.environmentMetadata, healthStatuses: [200] }] };
    pin('backendAmendment', amendment); current.instances = '999'; pin('backendAmendmentVerification', { ok: true, configUnchanged: true, environmentMetadataUnchanged: true, nonTargetPidsUnchanged: true, amendmentSha256: plan.readiness.backendAmendment.sha256, baseEffectiveManifestSha256: plan.readiness.backendEffective.sha256, afterPids: { ...verification.afterPids, instances: current.instances }, health: { instances: 200 } });
  }
  return { root, control, targets, current, plan, docs, profileRaw, profileSha, requests, helpers, pin, amend, options, run: () => createReadiness(options)(plan) };
}

test('native read-only receipts and six live components pass with OFF/PILOT_PENDING; only four fresh public GETs', async t => {
  const f = fixture(t); const result = await f.run(); assert(result.ok && result.readOnly && result.components === 6 && result.policyEnabled === false); assert.equal(f.helpers.length, 3); assert.equal(f.requests.filter(r => r.url.startsWith(ORIGIN)).length, 4);
  assert(f.requests.filter(r => r.options.method === 'POST').every(r => ['status', 'policy'].includes(JSON.parse(r.options.body).action)));
});
test('active review passes with settings0/SIP unavailable and never sends call/CRM/pause commands', async t => { const f = fixture(t, { active: true }); assert((await f.run()).policyEnabled); assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 4); });
test('only the two explicit instances amendment files and PID override can pass', async t => { const f = fixture(t); f.amend(); assert((await f.run()).ok); assert.equal(f.current.instances, '999'); });
test('live code drift fails before requiring helpers or issuing HTTP', async t => { const f = fixture(t); fs.appendFileSync(path.join(f.targets.whatsapp.live, 'dist/main.js'), 'foreign'); await assert.rejects(f.run(), /READINESS_BACKEND_INVENTORY/); assert.equal(f.helpers.length, 0); assert.equal(f.requests.length, 0); });
test('live common profile drift and review/profile mismatch fail closed', async t => {
  const f = fixture(t); write(path.join(f.targets.users.live, FEATURE), '{}'); await assert.rejects(f.run(), /READINESS_LIVE_HASH/);
  const g = fixture(t); const reviewFile = path.join(g.control, g.plan.review.file), review = JSON.parse(fs.readFileSync(reviewFile)); review.commonProfileSha256 = 'f'.repeat(64); write(reviewFile, review); g.plan.review.sha256 = hash(reviewFile); await assert.rejects(g.run(), /READINESS_REVIEW_PROFILE/);
});
test('PID drift in backend, frontend or stable production services is rejected', async t => {
  for (const app of ['customers', 'frontend', 'odim-copy']) { const f = fixture(t); f.current[app] = '7777'; await assert.rejects(f.run(), /READINESS_.*PID/); assert.equal(f.requests.length, 0); }
});
test('copied native receipt cannot diverge from its actual installed original', async t => { const f = fixture(t); f.pin('backendVerification', { ...f.docs.backendVerification, at: 'changed' }); write(path.join(f.control, 'receipts/verification.json'), '{}'); await assert.rejects(f.run(), /READINESS_ORIGINAL_RECEIPT/); });
test('readonly CRM preflight must prove no writes and the profile revision', async t => {
  for (const change of [{ crmWrites: 1 }, { providerCalls: 1 }, { sipCalls: 1 }, { revision: 'f'.repeat(64) }, { reviewedTriggerCount: 4 }]) { const f = fixture(t); f.pin('crmReadOnly', { ...f.docs.crmReadOnly, ...change }); await assert.rejects(f.run(), /READINESS_CRM_/); }
});
test('native SQL identity must prove the actual534 is active ATIVO, without ADMIN substitution', async t => { const f = fixture(t); f.pin('operatorIdentity', { ...f.docs.operatorIdentity, rows: [{ CODIGO: 534, NIVEL: 'ADMIN', ATIVO: 'SIM' }] }); await assert.rejects(f.run(), /READINESS_ACTIVE_OPERATOR/); });
test('helper ADMIN bypass is detected before HTTP', async t => { const f = fixture(t, { adminBypass: true }); await assert.rejects(f.run(), /READINESS_HELPER_FEATURES/); assert.equal(f.requests.length, 0); });
test('normal TLS evidence, build IDs and critical asset bytes are required', async t => {
  const f = fixture(t); f.pin('frontendTlsSmoke', { ...f.docs.frontendTlsSmoke, tls: 'insecure fallback' }); await assert.rejects(f.run(), /READINESS_NORMAL_TLS/);
  const g = fixture(t); write(path.join(g.targets.modern.live, '.next/BUILD_ID'), 'wrong'); await assert.rejects(g.run(), /READINESS_BUILD_ID/);
  const h = fixture(t), original = h.options.request; h.options.request = async (url, o) => url.includes('/_next/') ? { status: 200, body: Buffer.from('wrong asset') } : original(url, o); await assert.rejects(h.run(), /READINESS_FRESH_CRITICAL_ASSET/);
});
test('private health must reject no-key and accept the preserved original HMAC key', async t => {
  const f = fixture(t), request = f.options.request; f.options.request = async (url, o = {}) => url.includes('/health') && !o.headers?.['x-operator-signature'] ? { status: 200, body: Buffer.from('{}') } : request(url, o); await assert.rejects(f.run(), /READINESS_PRIVATE_ANONYMOUS/);
  const g = fixture(t); if (process.platform === 'win32') fs.writeFileSync(g.options.keyFile, 'short'); else fs.chmodSync(g.options.keyFile, 0o644); await assert.rejects(g.run(), /READINESS_PRIVATE_KEY/);
});
test('active status must match the reviewed release hash', async t => { const f = fixture(t, { active: true, wrongReview: true }); await assert.rejects(f.run(), /READINESS_ACTIVE_REVIEW/); });
test('amendment cannot alter unrelated code, cutoff, config or other backend PIDs', async t => {
  const f = fixture(t); f.amend(); const bad = structuredClone(f.docs.backendAmendment); bad.components[0].files['dist/main.js'] = 'a'.repeat(64); f.pin('backendAmendment', bad); await assert.rejects(f.run(), /READINESS_AMENDMENT_SCOPE/);
  const g = fixture(t); g.amend(); g.pin('backendAmendment', { ...g.docs.backendAmendment, baseEffectiveManifestSha256: 'f'.repeat(64) }); await assert.rejects(g.run(), /READINESS_AMENDMENT_BASE/);
  const h = fixture(t); h.amend(); h.pin('backendAmendmentVerification', { ...h.docs.backendAmendmentVerification, afterPids: { ...h.docs.backendAmendmentVerification.afterPids, customers: '888' } }); await assert.rejects(h.run(), /READINESS_AMENDMENT_OTHER_BACKEND_PID/);
});
test('evidence is restricted to pinned TOP filenames and env contents are never read', async t => {
  const f = fixture(t); f.plan.readiness.cutover.file = '../cutover.json'; await assert.rejects(f.run(), /READINESS_REFERENCE/);
  const g = fixture(t), read = fs.readFileSync; fs.readFileSync = function(file, ...args) { assert(!path.basename(String(file)).startsWith('.env')); return read.call(this, file, ...args); }; try { assert((await g.run()).ok); } finally { fs.readFileSync = read; }
});
