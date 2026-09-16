# Diagnóstico de mensagens sem confirmação

O frontend mantém uma cópia local do texto até receber o registro da mensagem. Essa cópia não tem o prefixo do operador. Sua presença não prova que o backend deixou de receber ou persistir o envio.

Foi reproduzido localmente um defeito no ciclo de vida da fila do frontend: sair da página de chat ou fechar o modal do monitor desmontava o `ChatProvider`, cujo cleanup convertia mensagens ainda `queued` em `failed` antes de chamar o serviço. A fila agora pertence ao layout da instância e continua ativa durante a navegação. Isso explica um cenário compatível com a ausência de prefixo e de logs, mas não comprova a causa das ocorrências históricas sem os dados delas.

## Coletar uma ocorrência

1. Na mensagem com falha ou sem confirmação, usar **Copiar diagnóstico do envio** antes de recuperar ou descartar a mensagem. O diagnóstico inclui `attemptId`, canal, conversa, registro conhecido e, quando disponível, horário UTC da falha, etapa, status HTTP e código de transporte. Não inclui texto, telefone, arquivo ou credenciais.
2. Procurar o `attemptId` nos logs stdout/stderr do processo correto do whatsapp-service, pelo marcador `[message-send]`. A entrada `received` ocorre antes da autenticação e do parser multipart. `response` registra o status HTTP e a última etapa; `connection.closed` indica encerramento antes de concluir a resposta, não uma falha definitiva de entrega.
3. Em `process_logs`, procurar `processId = attemptId` e `processName = operator-send-request`. O log contém as etapas até a persistência. `SUCCESS` neste processo significa que a tentativa foi registrada, não entregue ao WhatsApp. Na Gupshup, `gs-send-message` usa o mesmo `processId` para novos envios identificados.
4. Conferir a tentativa pela consulta autenticada existente `GET /api/whatsapp/:clientId/message-attempts/:attemptId`. Um 404 ou timeout isolado não autoriza reenviar uma mensagem de resultado incerto.

Após um reload, a mensagem pode existir apenas no armazenamento do navegador. Para mensagens sem recibo cuja consulta retornou 404, o frontend oferece **Retomar envio** quando dispõe do conteúdo completo: repete o POST com a mesma chave e conteúdo, sem criar uma intenção nova. O backend devolve o registro existente ou cria a tentativa sob a restrição única `(instance, userId, idempotencyKey)`; conteúdo divergente recebe 409. A ação é manual, não é acionada pelo polling e não refaz a chamada ao provedor de uma tentativa já registrada. Não apagar registros de idempotência para destravar envios.

## Interpretar as etapas

- Navegador: `hash`, `file-lookup` e `upload` acontecem antes do POST de mensagem. `authentication` identifica uma falha de renovação anterior ao despacho HTTP ou após rejeição explícita com 401. `request` significa entrada na chamada HTTP; não garante recebimento pelo servidor. `unknown` indica que não foi possível determinar a etapa.
- Backend: `authentication` com HTTP 401 indica rejeição antes do controller; `multipart` aponta o parser; `validation`, `destination.lookup`, `quoted.validation`, `ready-message.validation` e `file.prepare` ficam antes da persistência; `persisted` inclui o ID registrado.
- Ausência de `received` só ajuda depois de confirmar deploy, processo, horário e retenção dos logs. Proxy, conexão e navegador ainda precisam ser distinguidos.

Falhas anteriores à autenticação ficam no stdout, sem atribuição de tenant em `process_logs`. Os logs de processo são gravados ao terminar a operação; uma operação travada ou falha no banco pode não gerar essa linha. Nesses casos, usar os eventos stdout já emitidos.

O diagnóstico do navegador acompanha a tentativa no `sessionStorage` da aba, sobrevive ao reload e não exige acesso ao console. Não é enviado automaticamente ao servidor. Tentativas antigas podem ter apenas os identificadores, sem etapa e horário.

## Validação e publicação

Publicar o frontend e o whatsapp-service, reiniciando o processo correto após conferir `pm2 list`/`pm2 describe`. Não há migração nova. Validar com um envio controlado via Gupshup e conferir a correlação dos registros.

Testes locais: `npm run test:message-send-trace`, `npm run test:operator-send` e `npx tsc --noEmit` no backend; testes unitários de diagnóstico/envio/autenticação e Playwright `tests/chat-send.config.ts` no frontend. Os testes usam servidor local, fixtures e mocks; não confirmam entrega real nem a causa de ocorrências históricas.
