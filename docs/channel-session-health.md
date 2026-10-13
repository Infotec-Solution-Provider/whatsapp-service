# Saúde dos canais remotos

A classificação de `/api/whatsapp/session-monitor/clients` e do detalhe de um canal combina observação atual da sessão, último healthcheck funcional e sinais de mensagens reais. As desconexões de 24 horas continuam disponíveis como histórico, mas não rebaixam a saúde atual.

## Regras

- `LOGGED_OUT`: nova autenticação necessária. Sem snapshot: `NO_DATA`.
- `UNSTABLE`: observação sem resposta há mais de 90 segundos, três falhas consecutivas de consulta, sessão desconectada/com erro há mais de cinco minutos, healthcheck válido com falha no percurso de envio/recebimento, três mensagens distintas com falha técnica de envio ou processamento de entrada em 15 minutos, ou pendência ativa há mais de cinco minutos.
- `ATTENTION`: healthcheck ausente, vencido ou incompleto; falha do WABA de teste ao responder; sessão ainda não conectada; observação atrasada mais de 45 segundos; falha técnica isolada, erro de envio sem causa identificada, envio `UNKNOWN`, entrada em processamento com erro, pendência há mais de um minuto, ou consulta de mensagens indisponível/parcial.
- `STABLE`: sessão conectada com observação recente, teste válido aprovado e consulta completa sem esses sinais de degradação. Falhas identificadas como específicas de destinatário/conteúdo/mídia ficam visíveis nos contadores, mas isoladamente não provam defeito do canal. Um canal sem movimento pode estar saudável; ausência de mensagens não é considerada falha.

Falhas reais recentes continuam na janela mesmo após um teste aprovado. `UNKNOWN` permanece incerto; essa classificação não dispara reenvios, resets ou reconexões. O tempo de cinco minutos indica atraso persistente, não prova que o worker morreu.

## Fontes e limites

O leitor usa a interface de banco do whatsapp-service (`prisma.service.ts`). No modo `WHATSAPP_STORAGE=tenant-sql`, essa interface executa SQL parametrizado com mysql2 nas tabelas `wpp_runtime_*` do banco CRM do tenant; consultas raw têm seus nomes de tabela reescritos pelo adaptador. No modo central, usa o cliente Prisma existente. A correspondência de nomes físicos foi conferida no `prisma/schema.prisma` local; não houve consulta ao schema ou aos dados de produção.

- `messages`: saídas `me:`, `bot:` e `user:` com `ERROR`, `UNKNOWN` ou `PENDING` atrasado; relação com `operator_outbound_send` fornece horário de conclusão e categoria da falha. Estados com confirmação posterior deixam de ser considerados erros, mesmo se a tentativa durável ainda guardar resultado antigo.
- `operator_outbound_send`: o resultado persistido (`provider_outcome`) de novos envios de operador conserva `failureCategory` (`CHANNEL`, `MESSAGE`, `UNCLASSIFIED`). Erros reconhecíveis de transporte/sessão identificam falha técnica; recusas genéricas permanecem sem causa identificada. Os textos do provedor não são adicionados à resposta do monitor.
- `remote_inbound_event_inbox`: entradas `message-received` com falha ou ainda pendentes/processando, inclusive retries ilimitados. Cada evento canônico é uma mensagem afetada, independentemente de `retry_count`.
- `wpp_message_processing_queue`: processamento posterior de entradas, com deduplicação por `message_id` quando o inbox e a fila referem a mesma mensagem. Uma entrada pode aparecer em dois sinais (falha e atraso), mas uma vez em cada contador.
- `internal_message_processing_queue`: envios a grupos internos da mesma instância e dos canais visíveis. SQL parametrizado extrai apenas `clientId` e `lastRetryAt` do JSON; não transporta o LONGTEXT de mensagem/arquivo para o monitor. Reenvio manual reinicia o relógio de atraso.

Falhas concluídas são consideradas nos últimos 15 minutos. Pendências ativas anteriores à janela também entram no cálculo. Para saídas legadas sem tentativa durável, o único horário disponível é `messages.sent_at`; a janela usa esse horário e a causa fica sem classificação. Falhas anteriores à persistência de uma mensagem e eventos que nunca chegaram ao serviço não estão nessas tabelas: o healthcheck oferece uma verificação complementar do percurso. Não se presume confirmação de entrega ao destinatário a partir de `SENT`.

Há limite de 1.000 registros por fonte e cache compartilhado por instância + conjunto de canais visíveis por 15 segundos, limitado a 100 escopos por processo. Se alguma fonte exceder o limite, todas as contagens do escopo são apresentadas como parciais (mínimos) e o canal não recebe `STABLE`. Falha de consulta retorna `UNAVAILABLE`, não zeros como evidência de saúde. Leituras são independentes e podem refletir transições concorrentes; a classificação recupera no próximo ciclo.

O healthcheck continua com o agendamento configurado por `WWEBJS_HEALTH_CHECK_ENABLED` e `WWEBJS_HEALTH_CHECK_CRON`; o padrão é 30 minutos e a validade padrão é 45 minutos. O resultado permanece em memória: após reinício, fica ausente até a próxima sondagem. Sem configuração/execução, canais conectados permanecem em atenção.

## Validação e publicação

- `npm run test:channel-health`: regras, deduplicação, janelas, backlog antigo, retries, scoping/cache e limites/indisponibilidade com dependências simuladas; projeção SQL executada em SQLite em memória com adaptação das funções escalares de MySQL (requer Node com `node:sqlite`).
- `npm run test:functional-health`: teste do percurso WABA existente e testes de classificação.
- `npm run test:operator-send`: regressões do envio durável, rejeição confirmada, categoria de falha e resultado incerto sem reenvio.
- `npx tsc --noEmit`: tipos do backend e do frontend.
- No frontend, `npm run test:channels:e2e`: componente real com API simulada, lista e detalhe em desktop/mobile e dados indisponíveis.

Publicar backend antes do frontend. Não há migração de schema. Depois do deploy, verificar consulta autenticada em escopos distintos, execução do healthcheck e contadores de uma ocorrência conhecida. Validar latência e `EXPLAIN` das leituras no MySQL de destino: limites de linhas retornadas e cache não garantem limite de trabalho examinado pelo banco. As fontes e a projeção JSON foram conferidas no código local; o comportamento e o custo no MySQL de produção continuam pendentes.
