# Reconciliação posterior do envio REMOTE

O worker tem um percurso separado, somente de consulta, para envios de operador
`UNKNOWN/REMOTE` cujo `remote_job_id` já foi persistido. Nunca muda UNKNOWN para
PENDING/PROCESSING, nunca chama preflight, deliver, submit, fallback ou envio
direto e não incrementa `attempt_count`. Os limites de envio existentes continuam
independentes desta observação posterior. SENT confirma aceite do provedor,
sem presumir entrega ao destinatário.

O ciclo de 30 segundos seleciona até quatro IDs, ordenados por `next_attempt_at,id`,
com uma operação remota em andamento. Cada item é reagendado por cinco minutos
**antes** do HTTP, de forma durável. O acompanhamento cessa 24 horas após
`completed_at` do UNKNOWN original; respostas incertas/falhas de consulta não
renovam essa idade. Há até oito operações de consulta por minuto/processo; cada
operação usa os retries GET já existentes do RemoteWhatsappClient (três por
padrão). Não há nova variável de ambiente nem migration.

A seleção usa a faixa `status=UNKNOWN` e `next_attempt_at` entre agora menos
24 horas e agora, usando o índice existente `(status,next_attempt_at)`, com
filtros adicionais de modo, ID remoto e idade de conclusão. O orçamento limita
linhas devolvidas e chamadas, não garante trabalho SQL constante: verificar
EXPLAIN/latência no MySQL de destino antes da publicação. Não é feita limpeza,
alteração de retenção ou reabertura de registros antigos.

Notificação pendente tem prioridade: só se reconcilia após ela terminar. O lease
compartilhado em `locked_by/locked_until` impede finalizadores/notificadores
concorrentes de tomar a mesma posse. O estado e o próximo horário sobrevivem a
restart. Desligamento aguarda os percursos ativos por até 30 segundos; após uma
interrupção, outro processo só retoma consulta após lease e horário persistido.

A consulta valida tenant e canal do cliente local e da mensagem, contrato v1,
job remoto exato e a chave `operator-outbound:v1:<id local>`. Tenant/clientId do
resultado remoto são conferidos quando presentes: recibos v1 podem retornar
somente identificadores/status. IDs já persistidos não podem ser substituídos
por IDs divergentes. O caminho não depende de `sendSessionId`: a execução pode
ter usado uma sessão secundária do mesmo canal.

Só um resultado final SENT/FAILED validado é aplicado. Finalização, identidade,
estado e uma nova notificação são gravados juntos em transação, com comparação
de lease. Um recibo RECEIVED/READ/DOWNLOADED/REVOKED concorrente é preservado;
não é rebaixado para SENT/ERROR. O callback de finalização é executado uma vez
para a transição para SENT e rollback preserva a possibilidade de consultar
novamente, sem enviar. Indisponibilidade, 404, resultado incompleto ou divergente
mantêm UNKNOWN e sua causa original. O termo de 24 horas não permite reenvio.

`npm run test:operator-send` inclui cenários offline com o repositório/worker
reais sobre adaptador transacional isolado: resultado tardio, resposta mínima de
recibo, escopo/ID divergente, cadência e expiração, reinício, corrida com READ,
posse/notificação, rollback e ausência de qualquer novo despacho. O adaptador
não comprova locks, custo SQL ou entrega real no MySQL/provedor.
