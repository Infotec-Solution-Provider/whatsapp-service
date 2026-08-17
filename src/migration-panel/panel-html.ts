export const migrationPanelHtml = (): string => `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Migração de instância WhatsApp</title>
<style>
:root { color-scheme: light; font-family: Inter, system-ui, sans-serif; background: #f4f6f8; color: #1f2937; }
body { margin: 0; padding: 24px; }
main { max-width: 1280px; margin: auto; }
h1 { margin: 0 0 6px; } p { color: #5b6472; }
section { background: white; border: 1px solid #dfe4ea; border-radius: 10px; padding: 18px; margin: 16px 0; box-shadow: 0 2px 8px #16202a0d; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 600; }
input, select, textarea { font: inherit; padding: 9px; border: 1px solid #cbd5e1; border-radius: 6px; font-weight: 400; }
textarea { min-height: 88px; resize: vertical; }
.checks { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.checks label { flex-direction: row; align-items: center; font-weight: 500; }
button { background: #175cd3; border: 0; border-radius: 6px; color: white; cursor: pointer; padding: 10px 14px; font-weight: 700; }
button.secondary { background: #475467; } button.danger { background: #b42318; }
button:disabled { opacity: .5; cursor: not-allowed; }
#message { min-height: 22px; } .error { color: #b42318; } .success { color: #027a48; }
.run { border-top: 1px solid #e5e7eb; padding: 12px 0; } .run:first-child { border-top: 0; }
.run-head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.badge { border-radius: 999px; padding: 3px 8px; background: #eaecf0; font-size: 12px; }
.logs { background: #101828; color: #d0d5dd; padding: 12px; border-radius: 6px; max-height: 360px; overflow: auto; white-space: pre-wrap; font: 12px ui-monospace, monospace; }
.phase-buttons { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
small { color: #667085; font-weight: 400; }
</style>
</head>
<body>
<main>
<h1>Migração de instância legada</h1>
<p>O painel cria a instância no <code>instances-service</code>, provisiona o cliente atual, importa os dados e só ativa o cliente no cutover. Senhas não são persistidas nos logs.</p>

<section>
<h2>Nova execução</h2>
<div class="grid">
<label>Token do painel (se configurado)<input id="panelToken" type="password" placeholder="MIGRATION_PANEL_TOKEN" /></label>
<label>Instância legada<input id="sourceInstance" required placeholder="cliente_legado" /></label>
<label>Instância alvo<input id="targetInstance" required placeholder="cliente_atual" /></label>
<label>Nome do cliente<input id="clientName" required placeholder="Cliente WhatsApp" /></label>
<label>Provider<select id="provider"><option>REMOTE</option><option>WWEBJS</option><option>WABA</option><option>GUPSHUP</option></select></label>
<label>Telefone próprio<input id="phone" placeholder="5511999999999" /></label>
<label>URL do cliente remoto<input id="remoteClientUrl" placeholder="http://localhost:727" /></label>
<label>WABA Phone ID<input id="wabaPhoneId" /></label>
<label>WABA Account ID<input id="wabaAccountId" /></label>
<label>WABA Token<input id="wabaToken" type="password" /></label>
<label>Gupshup Token<input id="gupshupToken" type="password" /></label>
<label>Gupshup App Name<input id="gupshupAppName" /></label>
<label>Gupshup App ID<input id="gupshupAppId" /></label>
</div>

<h3>Banco legado</h3>
<div class="grid">
<label>Host<input id="sourceHost" placeholder="127.0.0.1" /></label>
<label>Porta<input id="sourcePort" type="number" value="3306" /></label>
<label>Usuário<input id="sourceUser" /></label>
<label>Senha<input id="sourcePassword" type="password" /></label>
<label>Database<input id="sourceDatabase" /></label>
<label>SSL<select id="sourceSsl"><option value="false">Não</option><option value="true">Sim</option></select></label>
</div>

<h3>Criação/configuração da instância</h3>
<div class="grid">
<label>instances-service URL<input id="instancesApiUrl" value="http://localhost:8000" /></label>
<label>Token Bearer (opcional)<input id="instancesToken" type="password" /></label>
<label>Login root (opcional)<input id="instancesLogin" /></label>
<label>Senha root (opcional)<input id="instancesPassword" type="password" /></label>
<label>Lote de importação<input id="batchSize" type="number" value="500" min="1" max="5000" /></label>
<label>Parâmetros JSON da instância<textarea id="instanceParameters">{}</textarea></label>
</div>
<h3>Banco do runtime remoto (wwebjs-api/Baileys)</h3>
<div class="grid">
<label>Host<input id="runtimeHost" placeholder="127.0.0.1" /></label>
<label>Porta<input id="runtimePort" type="number" value="3306" /></label>
<label>Usuário<input id="runtimeUser" /></label>
<label>Senha<input id="runtimePassword" type="password" /></label>
<label>Database<input id="runtimeDatabase" value="wwebjs-api" /></label>
</div>
<div class="checks">
<label><input id="importSectors" type="checkbox" checked /> Setores</label>
<label><input id="importContacts" type="checkbox" checked /> Contatos</label>
<label><input id="importChats" type="checkbox" checked /> Atendimentos</label>
<label><input id="importMessages" type="checkbox" checked /> Mensagens</label>
<label><input id="importReadyMessages" type="checkbox" checked /> Mensagens prontas</label>
<label><input id="importParameters" type="checkbox" checked /> Parâmetros</label>
<label><input id="generateRuntimeConfig" type="checkbox" checked /> Gerar env do runtime</label>
<label><input id="allowExistingTargetData" type="checkbox" /> Permitir dados existentes</label>
</div>
<p><small>O modo REMOTE é o caminho recomendado quando a sessão Baileys já existe. O painel não envia eventos simultaneamente para o legado e o atual.</small></p>
<button id="create">Criar e executar pré-verificação</button>
<span id="message"></span>
</section>

<section>
<h2>Execuções</h2>
<div id="runs">Carregando...</div>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const phaseNames = ['preflight','provision','load','validate','cutover','rollback'];
let selectedRun = null;
let pollTimer = null;
const token = () => window.localStorage.getItem('migration-panel-token') || '';
const api = async (url, options = {}) => {
  const headers = Object.assign({'Content-Type':'application/json'}, options.headers || {});
  if (token()) headers.Authorization = 'Bearer ' + token();
  const response = await fetch(url, Object.assign({}, options, {headers}));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || 'HTTP ' + response.status);
  return body;
};
const checked = (id) => $(id).checked;
const value = (id) => $(id).value.trim();
const formConfig = () => ({
  sourceInstance: value('sourceInstance'), targetInstance: value('targetInstance'), clientName: value('clientName'),
  provider: value('provider'), phone: value('phone'), remoteClientUrl: value('remoteClientUrl'),
  wabaPhoneId: value('wabaPhoneId'), wabaAccountId: value('wabaAccountId'), wabaToken:$('wabaToken').value,
  gupshupToken:$('gupshupToken').value, gupshupAppName:value('gupshupAppName'), gupshupAppId:value('gupshupAppId'),
  source: {host:value('sourceHost'), port:Number(value('sourcePort') || 3306), user:value('sourceUser'), password: $('sourcePassword').value, database:value('sourceDatabase'), ssl:value('sourceSsl') === 'true'},
  instancesApi: {baseUrl:value('instancesApiUrl'), token:$('instancesToken').value, login:value('instancesLogin'), password:$('instancesPassword').value},
  runtimeDatabase: {host:value('runtimeHost'), port:Number(value('runtimePort') || 3306), user:value('runtimeUser'), password:$('runtimePassword').value, database:value('runtimeDatabase')},
  instanceParameters: value('instanceParameters'),
  options: {importSectors:checked('importSectors'), importContacts:checked('importContacts'), importChats:checked('importChats'), importMessages:checked('importMessages'), importReadyMessages:checked('importReadyMessages'), importParameters:checked('importParameters'), generateRuntimeConfig:checked('generateRuntimeConfig'), allowExistingTargetData:checked('allowExistingTargetData'), batchSize:Number(value('batchSize') || 500)}
});
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const renderRun = (run) => {
  const logs = (run.logs || []).map((entry) => '[' + entry.at + '] ' + entry.level.toUpperCase() + ' [' + entry.phase + '] ' + entry.message + (entry.meta ? ' ' + JSON.stringify(entry.meta) : '')).join('\n');
  const buttons = phaseNames.map((phase) => '<button class="' + (phase === 'rollback' ? 'danger' : 'secondary') + ' phase" data-phase="' + phase + '" data-run="' + run.id + '">' + phase + '</button>').join('');
  return '<div class="run"><div class="run-head"><strong>' + escapeHtml(run.instance) + '</strong><span class="badge">' + escapeHtml(run.status) + '</span><span class="badge">fase: ' + escapeHtml(run.currentPhase) + '</span><small>' + escapeHtml(run.id) + '</small></div><div class="phase-buttons">' + buttons + '</div><pre class="logs">' + escapeHtml(logs || 'Sem logs ainda.') + '</pre></div>';
};
const refresh = async () => {
  const body = selectedRun ? await api('/api/migration-panel/runs/' + selectedRun) : await api('/api/migration-panel/runs');
  const runs = selectedRun ? [body.run] : body.runs;
  $('runs').innerHTML = runs.length ? runs.map(renderRun).join('') : '<p>Nenhuma execução.</p>';
  document.querySelectorAll('.phase').forEach((button) => button.addEventListener('click', async () => {
    try { selectedRun = button.dataset.run; await api('/api/migration-panel/runs/' + selectedRun + '/phases', {method:'POST', body:JSON.stringify({phase:button.dataset.phase})}); await refresh(); }
    catch (error) { showMessage(error.message, true); }
  }));
};
const showMessage = (message, isError = false) => { $('message').textContent = message; $('message').className = isError ? 'error' : 'success'; };
$('panelToken').value = token();
$('panelToken').addEventListener('change', () => window.localStorage.setItem('migration-panel-token', $('panelToken').value));
$('create').addEventListener('click', async () => {
  $('create').disabled = true;
  try { const body = await api('/api/migration-panel/runs', {method:'POST', body:JSON.stringify(formConfig())}); selectedRun = body.run.id; showMessage('Execução criada: ' + selectedRun); await refresh(); }
  catch (error) { showMessage(error.message, true); }
  finally { $('create').disabled = false; }
});
refresh().catch((error) => showMessage(error.message, true));
pollTimer = window.setInterval(() => refresh().catch(() => {}), 3000);
</script>
</body>
</html>`;

export default migrationPanelHtml;
