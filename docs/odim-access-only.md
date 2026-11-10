# Acesso paralelo da Odim, canal no legado

Mudança limitada sobre a base de produção `49d1868`. Não incorpora a release de homolog, persistência tenant-sql, simulador, regras de migração ou funcionalidades novas.

O arquivo físico `config/odim-access-only.json`, relativo à raiz deste serviço (ao lado de `dist`), controla o modo. Não contém segredo e é lido uma vez no startup. O processo não grava nem modifica esse arquivo. A configuração exata é:

```json
{"version":1,"enabled":true,"instance":"odim"}
```

Arquivo ausente equivale a `false`; arquivo malformado, maior que 4096 bytes, com campos adicionais, link simbólico, diretório resolvido diferente do esperado ou gravável por grupo/outros no Linux bloqueia a Odim e informa `invalid` no health, sem parar outros tenants. Não há nova variável de ambiente. O operador mantém o arquivo no diretório de configuração do serviço, com dono do runtime, modo 0600 e diretório sem escrita pública, antes do startup coordenado. O health acrescenta `odimAccessOnly:true` e `odimAccessOnlyProfile:valid|invalid` apenas quando o modo está bloqueando o canal.

No modo ativo, `odim`, `ODIM` e variantes com espaços são tratados como o mesmo tenant para a guarda. A autenticação continua no users-service e as permissões existentes continuam obrigatórias. A guarda não cria usuário nem redefine senha.

- Operações HTTP autenticadas da Odim usam uma lista de leituras locais e operações de chat interno. Envios, criação/transferência de atendimento externo, agendas de WhatsApp, edição/reações externas, templates, operações REMOTE, execução de fluxos e operações desconhecidas retornam 423 antes do handler/multipart.
- O bootstrap de canais retorna uma lista vazia para a Odim. Nos outros tenants, a consulta de setor exige simultaneamente ID e tenant autenticado e filtra os vínculos por tenant. O setor CRM 1 não passa a representar o setor WhatsApp global 1.
- Providers Odim não são instanciados, e o acesso a um provider Odim já carregado também falha. Os guardas de domínio usam a instância da sessão, do atendimento ou do item da fila; um item Odim não pode contornar o bloqueio usando o cliente/default de outro tenant.
- As filas WABA, Gupshup, distribuição, envio do operador, grupo interno e inbox REMOTE excluem trabalho Odim antes de selecionar/claim. Novas entradas Odim falham antes de persistir; webhooks não recebem ACK de sucesso do bloqueio. Trabalho pendente não é marcado como enviado, descartado ou concluído pelo modo.
- Chats internos sem vínculo WhatsApp continuam locais. Vínculos externos, edição de mensagem vinculada, reenvios e notificações externas de menções são bloqueados/suprimidos antes de submissão ao provedor. Recursos internos mutáveis são conferidos no tenant antes do handler. As permissões de autor/perfil do domínio continuam aplicáveis.
- A leitura pública de contatos com CRM usa a busca central já existente, ignorando efetivamente `use_local_contacts_sync=true` apenas para a Odim neste modo. O valor persistido permanece intacto; não cria nem sincroniza tabelas `wpp_*`. Isso disponibiliza os contatos existentes do sistema atual, não o histórico integral do legado.
- A resolução de parâmetros Odim ignora overrides de setor WhatsApp global. Mantém os valores INSTANCE/USER, mas força somente na resposta os controles existentes de IA, SIP/discador, funis, disparos, monitoria de sessão e sincronização de grupo interno para `false`. `feature_chat_export_enabled` permanece com seu default existente. Esses controles de interface complementam as guardas do servidor.

Nenhum cadastro de cliente/canal, token, phone/account ID, parâmetro persistido, setor, catálogo ou tabela de dados é alterado por esta implementação. O serviço não transfere a posse do canal legado. Os demais serviços ainda precisam respeitar os limites próprios de telefonia, e-mail e IA; este componente protege o WhatsApp.

Para ativar, o coordenador primeiro confere o perfil/hash, código e processos envolvidos; publica somente os JS revisados, preserva configurações e realiza o startup combinado. O processo compartilhado possui entregas de outros tenants: o procedimento de drain/restart é separado desta mudança. Não iniciar outro worker concorrente sobre as mesmas filas.

Para reverter, primeiro interromper o acesso paralelo da Odim/restaurar o apontamento anterior conforme backup e validar ausência de novas operações em andamento. Só então restaurar os JS/configuração anteriores no startup combinado. Remover o perfil ou instalar uma versão antiga mantendo acesso aberto reabilitaria caminhos de canal; isso não constitui uma reversão segura. Ativar o canal atual exige uma autorização de virada futura e seus próprios gates.

Validação local: `npm run test:odim-access-only` exercita HTTP Express real, variantes de tenant, setor estrangeiro, ordem do bloqueio, domínio, seleção de filas, perfil inválido e contatos centrais com fixtures. Não usa credenciais, banco ou provedor real. Typecheck/compilação e regressões existentes são registrados no pacote central.
