# Alertas operacionais (ops alerts)

Módulo `src/services/ops-alerts/`. Avisa a equipe da Infotec sobre falhas de envio, envios lentos, sessões fora do ar, desconexões frequentes e filas paradas. Não cria tabela nem migração. Liga sozinho no `main.ts` (`startOpsAlerts()` após o `listen`, `stopOpsAlerts()` no shutdown) e roda num único processo `whatsapp`.

## Eventos

| Tipo | Severidade | Origem | Quando dispara |
|---|---|---|---|
| `SEND_FAILED` | high (`[CRÍTICO]`) | fila interna de grupos (`processQueuedWppGroupMessage`) | mensagem interna termina em ERROR (`NOT_SENT`, `FAILED` ou `UNKNOWN`) |
| `SEND_FAILED` | high (`[CRÍTICO]`) | varredura periódica de `operator_outbound_send` | envio de operador `REMOTE` termina `UNKNOWN` ou `FAILED` (só linhas concluídas depois da subida do processo) |
| `SEND_SLOW` | warn (`[AVISO]`) | fila interna de grupos | mais de 20 s entre a criação (ou o último "Reenviar") e o término, ou ainda em andamento depois de 20 s. Um aviso por mensagem |
| `SESSION_DOWN` | critical (`[CRÍTICO]`) | snapshot da sessão (`client_session_snapshots`) | sessão PRIMARY fora de `CONNECTED` há mais de 180 s, ou `QR_PENDING`/`LOGGED_OUT` há mais de 60 s, ou API do wwebjs sem responder ao poll (≥ 3 falhas e último snapshot com mais de 180 s). Envia `[RESOLVIDO]` uma vez quando volta |
| `DISCONNECT_STORM` | warn | `client_session_events` (a cada 5 min) | mais de 10 eventos `DISCONNECTED` na última hora para o mesmo cliente |
| `QUEUE_BACKLOG` | warn | fila interna e `operator_outbound_send` (a cada 60 s) | itens `PENDING`/`PROCESSING` com mais de 2 min. Na fila interna o relógio recomeça no último "Reenviar" |

Os envios diretos do health check (`HEALTHPROBE_REQUEST`) não são jobs e não são observados.

O snapshot da sessão depende da correção do monitor de sessões: para um `clientId` com PRIMARY e SHADOW no mesmo wwebjs-api, o poll usa a sessão PRIMARY (depois a default, depois a primeira). Antes da correção, o poll lia a SHADOW listada primeiro (`ORDER BY session_id`).

## Escopo

- Só clientes `REMOTE` ativos que estiveram `CONNECTED` nas últimas 24 h (`OPS_ALERTS_SCOPE_WINDOW_MS`). O conjunto é recarregado a cada verificação periódica.
- `OPS_ALERTS_EXCLUDED_CLIENT_IDS` (padrão `1,9,10`: cliente de testes e clientes suprimaxxi inativos) nunca alerta.
- Os alertas trazem apenas identificadores: instância, cliente, sessão, id da mensagem, id do job, duração e horários. Nunca texto de mensagem, telefone ou erro bruto do provedor.

## Deduplicação e limites

- Chave: `${instance}:${type}:${clientId || sessionId || "-"}`.
- A primeira ocorrência sai na hora. Repetições dentro de `OPS_ALERTS_DEDUP_WINDOW_MS` (10 min) são contadas e saem num resumo "+N ocorrências em 10 min" ao fim da janela.
- Um crítico aberto (`SESSION_DOWN`) não repete. Recebe lembretes a cada 30 min (no máximo 3) e um `[RESOLVIDO]` quando a sessão volta. Uma nova queda depois do resolvido alerta de novo na hora.
- Limite global `OPS_ALERTS_MAX_PER_HOUR` (20 mensagens por hora). O excedente vira um único `[RESUMO]` quando houver vaga. `[RESOLVIDO]` sai mesmo com o limite atingido.
- Estado (janelas, críticos abertos, contador por hora, cursor da varredura de operador) fica em `OPS_ALERTS_STATE_FILE`. Padrão: `data/ops-alerts-state.json` relativo ao diretório de trabalho do processo. Em produção o PM2 roda em `dist/`, então o arquivo fica em `dist/data/`. A escrita é atômica (arquivo temporário + rename). Arquivo ausente ou corrompido é ignorado.
- `opsAlerts.emit(...)` é síncrono, nunca lança exceção e não é aguardado. Um buffer em memória guarda os últimos 1000 eventos. Falha de canal só gera log, nunca outro alerta.

## Canais

1. **Log**: sempre. Linhas `[ops-alert] {json}` no stdout do PM2 com `event` = `dispatch`, `suppressed`, `overflow` ou `open`.
2. **Notificação no app**: `Notification` tipo `ALERT` para cada alvo de `OPS_ALERTS_NOTIFY_TARGETS` (padrão `exatron:38`, formato `instancia:userId[,…]`). O título é a primeira linha e a descrição é o texto completo. Não há evento de socket para notificações neste serviço; o frontend lista pela API existente.
3. **WhatsApp**: pelo remetente dedicado da Infotec, um processo wwebjs-api próprio em `127.0.0.1:7290` (ver `wwebjs-api/docs/alert-sender-setup.md`). Nunca usa clientes de tenants.
   - `OPS_ALERTS_WHATSAPP=auto` (padrão): a cada 60 s consulta `GET {url}/api/sessions`, escolhe a sessão disponível (PRIMARY/default) e exige `state === "CONNECTED"` em `GET {url}/api/sessions/:id/session/info`. Se não estiver pronto, pula o WhatsApp e registra `[ops-alert] sender unavailable` no máximo a cada 30 min. Liga sozinho quando o chip é pareado.
   - `on`: envia sem a verificação. `off`: nunca envia.
   - Envio: `POST {url}/api/send-message/jobs`, cabeçalho `Idempotency-Key: ops-alert:<uuid>`, corpo `{ to, text }`, timeout 5 s, sem aguardar o resultado (o `jobId` vai para o log).
   - Disjuntor: 5 falhas seguidas suspendem o canal por 15 min.

Formato (texto simples, PT-BR, até 600 caracteres, horário de America/Sao_Paulo):

```
[AVISO] nunes · Envio lento (>20 s)
Sessão nunes_zapo (ZAPO, principal) · cliente 2
Mensagem interna 76897 · job 356
Duração 66 s · 1ª tentativa 14:35:08
+3 ocorrências em 10 min
in.pulse monitor · 06/10 14:36
```

Rótulos: `[CRÍTICO]` (critical e high), `[AVISO]` (warn), `[RESOLVIDO]`, `[RESUMO]`. "principal" ou "reserva" indica se o envio saiu pela sessão primária ou pela SHADOW (campo `fallback` do job do wwebjs-api).

## Variáveis de ambiente

Todas têm padrão no código. O deploy não exige editar o `.env`.

| Variável | Padrão |
|---|---|
| `OPS_ALERTS_ENABLED` | `true` (`false` desliga tudo) |
| `OPS_ALERTS_WHATSAPP` | `auto` (`on` / `off`) |
| `OPS_ALERTS_SENDER_URL` | `http://127.0.0.1:7290` |
| `OPS_ALERTS_WHATSAPP_TO` | `555184449218` |
| `OPS_ALERTS_NOTIFY_TARGETS` | `exatron:38` |
| `OPS_ALERTS_EXCLUDED_CLIENT_IDS` | `1,9,10` |
| `OPS_ALERTS_STATE_FILE` | `<cwd>/data/ops-alerts-state.json` |
| `OPS_ALERTS_DEDUP_WINDOW_MS` | `600000` |
| `OPS_ALERTS_MAX_PER_HOUR` | `20` |
| `OPS_ALERTS_REMINDER_MS` / `OPS_ALERTS_MAX_REMINDERS` | `1800000` / `3` |
| `OPS_ALERTS_SLOW_SEND_MS` | `20000` |
| `OPS_ALERTS_SESSION_DOWN_MS` / `OPS_ALERTS_SESSION_AUTH_DOWN_MS` | `180000` / `60000` |
| `OPS_ALERTS_DISCONNECT_STORM_THRESHOLD` / `OPS_ALERTS_STORM_CHECK_MS` | `10` / `300000` |
| `OPS_ALERTS_BACKLOG_MS` | `120000` |
| `OPS_ALERTS_CHECK_INTERVAL_MS` / `OPS_ALERTS_TICK_MS` | `60000` / `30000` |
| `OPS_ALERTS_SCOPE_WINDOW_MS` | `86400000` |
| `OPS_ALERTS_SENDER_TIMEOUT_MS` / `OPS_ALERTS_SENDER_HEALTH_TTL_MS` | `5000` / `60000` |
| `OPS_ALERTS_SENDER_FAILURE_THRESHOLD` / `OPS_ALERTS_SENDER_BACKOFF_MS` / `OPS_ALERTS_SENDER_UNAVAILABLE_LOG_MS` | `5` / `900000` / `1800000` |

## Como ligar o WhatsApp

1. Subir e parear o processo `wwebjs-alerts` conforme `wwebjs-api/docs/alert-sender-setup.md` (porta 7290, só em 127.0.0.1).
2. Conferir no servidor: `curl -s http://127.0.0.1:7290/api/sessions` mostra a sessão com `available: true`, e `curl -s http://127.0.0.1:7290/api/sessions/<id>/session/info` mostra `"state":"CONNECTED"`.
3. Com o padrão `auto`, o canal liga em até 60 s sem reiniciar o `whatsapp`. O log passa a mostrar `[ops-alert] whatsapp job <id>` a cada alerta enviado.
4. Para silenciar só o WhatsApp: `OPS_ALERTS_WHATSAPP=off` no `.env` e reiniciar o processo.

## Testes

`npm run test:ops-alerts` (dedup, janela, limite, formato, gating do remetente, disjuntor, arquivo de estado e verificações periódicas com banco simulado). `npm run test:send-reliability` roda também os testes da fila interna e do monitor de sessões.
