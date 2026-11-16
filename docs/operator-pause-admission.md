# Pausa do operador em novos atendimentos WhatsApp

Fonte de autoridade: `telephony_runtime_policy` e `telephony_operator_state` no mesmo banco CRM do tenant. O novo campo `pause_all_channels` tem padrão 0. O estado mantém `unavailable_since` UTC, durável desde a primeira entrada em `pending`/`paused`, preservado nas mudanças de motivo e limpo ao retomar/cancelar. As migrations e a revisão/ativação pertencem ao instances-service. Este serviço não migra ou ativa políticas no startup.

Com `pause_all_channels=1`, exige `enabled=1`, `preflight_hash` válido e operador `ATIVO='SIM'`. Estados `pending` e `paused` negam uma nova atribuição. A pausa não encerra sessão, socket, Redis, canal ou conversa e não bloqueia responder/concluir atendimentos já abertos.

## Transação e modos

O modo suportado é `WHATSAPP_STORAGE=tenant-sql`: `wpp_runtime_chats` e a autoridade de pausa residem no mesmo CRM. A transação do adaptador nativo faz, nesta ordem:

1. Consulta a existência da coluna opt-in e lê a política com `LOCK IN SHARE MODE`.
2. Faz upsert e `SELECT ... FOR UPDATE` das linhas de estado dos operadores envolvidos, em ordem numérica; valida o cadastro ativo na mesma transação.
3. Em transferência, bloqueia o chat e lê `user_id,is_finished,is_schedule,started_at`.
4. Valida o destinatário e, na abertura manual, o iniciador; só então grava o chat e sua preferência de não lido.

Uma atribuição já admitida confirma antes que uma pausa concorrente adquira o lock; se a pausa adquirir primeiro, a atribuição reavalia o estado bloqueado e sofre rollback. Não há I/O HTTP/provedor dentro dessa transação. A isenção de mesmo proprietário exige conversa iniciada, não finalizada e não agendada; reabertura/ativação de agenda sofre nova admissão.

Destinos não humanos (`-1`, `0`, `null`, carteira compartilhada) continuam sendo filas para os demais operadores. Na abertura manual o iniciador humano é validado mesmo quando `start_chats_as_admin` usa `-1`. A ACL de leitura não muda. O envio humano em conversa compartilhada exige, durante a indisponibilidade, conversa aberta com `started_at < unavailable_since`. Conversa própria já aberta continua utilizável. Igualdade de timestamps é ambígua e nega o novo envio até Retomar; isso também cobre o MySQL 5.5 com precisão de segundos. Sem ID de conversa, tenta-se provar uma única conversa aberta do contato; ausência ou ambiguidade nega o envio enquanto pausado.

Texto, arquivo/áudio, template, encaminhamento e reação WhatsApp passam por essa admissão. A isenção exige o destino real (`to`) vinculado ao contato real da conversa dentro da transação, preservando telefone/JID, LID e grupo; apontar IDs antigos com um novo número não libera o envio. Todos os destinos externos de um encaminhamento são admitidos antes de qualquer gravação/envio do lote. O envio moderno repete a guarda na mesma transação que grava mensagem e job, respeitando replay idempotente já aceito. Rotas legadas concluem uma transação curta de admissão antes de acessar o provedor: uma operação admitida antes da pausa pode prosseguir, sem criar um mecanismo novo de repetição. Não há I/O do provedor sob lock SQL, nem rechecagem de pausa no worker de mensagens já admitidas. Bots/sistema e entrada de mensagens não passam pela guarda de envio humano.

O modo `central` mantém as regras anteriores e anuncia capability versão 0. Uma ativação global nesse modo é incompatível: um check HTTP separado não seria atômico com o banco central. `/health.operatorPauseAdmission` anuncia versão 1 somente no modo nativo e lista exclusivamente as instâncias dos clients já carregados, sem ler credenciais na chamada.

Schema ausente conserva o comportamento antigo apenas quando ainda não existe a coluna/ativação global conhecida. Após observar uma política global, perda da coluna/tabela não desativa a guarda silenciosamente. Falha de consulta, política global sem runtime/hash, schema de estado ausente e estado desconhecido negam admissão com `OPERATOR_AVAILABILITY_UNAVAILABLE` (503). Pausa conhecida retorna `OPERATOR_PAUSED` (409), ambos com `outcome=NOT_COMMITTED`.

## Auditoria dos escritores da aplicação

| Entrada | Escritor protegido |
| --- | --- |
| Inbound, fluxo configurável, fidelização, bot Vollo com operador fixo | `messages-distribution.createNewChat` → `withUnreadAssignment` |
| Transferência automática de setor ou operador, bots | `transferChatSector` / `transferChatOperator` → `withUnreadAssignment` |
| Abertura manual `POST /api/whatsapp/chats` | `chats.startChatByContactId`: iniciador e destinatário na mesma transação |
| Transferência manual | `chats.transferAttendance`: destinatário e chat na mesma transação |
| Rotina de agendas, criação por sistema/IA | `chats.systemStartNewChat` → `withUnreadAssignment`; agenda que encontra chat aberto apenas o reutiliza |
| IA ensure | `ensureActiveChatForAgent`: retorno de chat existente não cria atribuição; criação passa por `systemStartNewChat` |
| Transferência por IA | `transferChatByAgent`: update e preferência de não lido dentro da transação protegida |
| Retorno do bot choose-sector ao operador anterior | `withUnreadAssignment`, sem remover o estado do bot antes do sucesso |
| Importação administrativa de atendimento ativo | `migration-panel/instance-data-migrator`: guarda e write na mesma transação; histórico finalizado não cria atendimento |
| Envio humano moderno | `operator-send.submit` e `operator-outbound.repository.enqueue`: guarda e nested message/job na mesma transação |
| Envio humano legado, template, encaminhamento e reação | `admitHumanSend` antes de qualquer efeito de saída |

Filtros de elegibilidade são auxiliares nos passos `CHECK_AVAILABLE_USERS`, `CHECK_USER_ONLINE`, `CHECK_LOALTY`, `SEND_TO_SECTOR_USER`, `ASSIGN` validado e no menu choose-sector. Eles não substituem a guarda de confirmação: uma pausa entre seleção e gravação continua bloqueada.

As demais gravações diretas de `wppChat` nos caminhos de runtime atualizam avatar, bot, resultado ou finalização e não criam um destinatário. Os importadores continuam sujeitos ao cutover com gravadores parados. `odim-live-copy.core` escreve somente no tenant Odim, que não está no catálogo nativo de homolog suportado por esta ativação. SQL administrativo arbitrário não faz parte deste contrato.

## Filas e recuperação

`message-queue`, WABA e Gupshup preservam o registro pendente em caso dos dois erros de admissão, sem incrementar a contagem de tentativas nem declarar entrega. A nova tentativa aguarda 30 segundos. Eventos REMOTE continuam com a persistência/idempotência anteriores. Nenhuma retentativa da admissão envia de novo uma mensagem de saída.

WABA já reaproveitava a mensagem salva ainda sem chat. Gupshup passa a reaproveitar o ID persistido, validando tenant, canal e remetente, para que o retry não esbarre na chave única do provedor. Mensagens já vinculadas não são distribuídas de novo.

## Verificações locais

```powershell
npx tsc --noEmit --pretty false
npx ts-node src/services/operator-pause-admission.test.ts
npx ts-node src/services/operator-pause-queues.test.ts
npx ts-node src/services/operator-pause-outbound.test.ts
npx ts-node src/services/operator-pause-admission.mysql.test.ts
npm run test:assigned-chat-unread
npm run test:resource-pressure
npm run test:message-flow-config
npm run test:inbound-recovery
npm run test:operator-send
npm run test:reactions
git diff --check
```

O teste MySQL aceita somente `127.0.0.1:13555` e `127.0.0.1:13480`, usa schemas descartáveis `operator_pause_assignment_*` e o adaptador nativo real. Cobre rollback, ambas as ordens da corrida pausa/atribuição, entrada manual compartilhada, transferência para/de operador pausado, reabertura, agenda não iniciada, corte temporal de mensagens compartilhadas e falha fechada por schema ausente. Não envia mensagens, não chama PBX e não acessa ambiente remoto.
