# Processamento de recibos REMOTE

O worker da inbox ordena eventos vencidos por `nextAttemptAt,id`, usando o índice existente `(status,next_attempt_at)`. Ordenar por criação permite que recibos antigos novamente elegíveis ultrapassem indefinidamente eventos novos durante sobrecarga.

Recibos `message-status-received:*` com erro exato `REMOTE_RECEIPT_MESSAGE_NOT_FOUND` mantêm tentativas curtas durante a vinculação do envio ao ID do provedor. A partir da oitava falha, são reagendados para uma hora. Permanecem `PENDING`, duráveis e recuperáveis. Não há descarte, reenvio ao provedor nem alteração de `UNKNOWN`. Erros de banco, ambiguidade e eventos de mensagem recebida preservam o backoff anterior.

A busca mantém isolamento por instância/cliente e `take:2` para detectar ambiguidade, selecionando somente ID e estado. O índice não único de `messages.wwebjs_id_stanza` continua recomendado onde ausente; aplicar exclusivamente por acesso DBA autorizado. O hotfix não exige alteração de schema.

Validação: `npm run test:remote-inbound`, `npx ts-node src/services/durable-worker-concurrency.test.ts`, `npx ts-node src/whatsapp-client/remote-receipts.test.ts`, `npx ts-node src/controllers/remote-receipts-http.test.ts`, `npx ts-node src/utils/remote-message-status.test.ts` e `npx tsc --noEmit`. O cenário simulado cobre 1.200 recibos antigos, progresso de eventos novos, concorrência limitada e recuperação tardia.

Evidência operacional e rollback: `planejamento/whatsapp-service/INF-20261016-001-exatron-recibos/` no workspace.
