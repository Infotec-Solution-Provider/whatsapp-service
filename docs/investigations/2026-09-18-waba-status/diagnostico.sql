-- Investigacao de leitura: executar no MESMO banco dos resultados do incidente.
-- Nao reenvia mensagens, nao reprocessa fila e nao altera registros.
-- Intervalos abaixo pertencem a process_logs/messages; nao converter a fila
-- por uma constante de 3h sem verificar a convencao de cada coluna.
-- Execute um bloco por vez. Os IDs exatos evitam varrer payloads da fila.

-- 1. Identificar sent/delivered/read/failed e procurar a mensagem por indice.
SELECT
    q.id, q.instance, q.status AS status_fila, q.retry_count, q.max_retries,
    JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.entry[0].changes[0].value.statuses[0].id')) AS wamid,
    JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.entry[0].changes[0].value.statuses[0].status')) AS status_meta,
    JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.entry[0].changes[0].value.statuses[0].timestamp')) AS timestamp_meta,
    JSON_EXTRACT(q.payload, '$.entry[0].changes[0].value.statuses[0].errors[0].code') AS codigo_erro_meta,
    JSON_LENGTH(q.payload, '$.entry[0].changes[0].value.statuses') AS quantidade_status,
    q.created_at, q.updated_at, q.processed_at,
    m.id AS message_id, m.instance AS message_instance,
    m.client_id, m.status AS status_crm, m.sent_at, m.is_forwarded
FROM waba_webhook_queue q
LEFT JOIN messages m
    ON m.waba_id = JSON_UNQUOTE(JSON_EXTRACT(q.payload, '$.entry[0].changes[0].value.statuses[0].id'))
WHERE q.instance = 'suprimaxxi'
  AND q.id IN ('e8ffd95b-4396-41f0-9c67-6c6f3bbec10e', '1b78f135-a305-4f71-bfc3-ad042cbf8bfa')
ORDER BY q.created_at;

-- 2. Localizar o recibo do envio pelo MESMO wamid nos logs do adapter.
-- Nao retorna conteudo, destinatario, payload completo ou configuracao HTTP.
-- HEALTHPROBE: identifica respostas tecnicas; nao prova sozinho a origem de outros IDs.
SELECT /*+ MAX_EXECUTION_TIME(10000) */
    id, process_name, process_id, status, start_time, end_time, created_at, duration,
    CASE WHEN JSON_VALID(input)
        THEN LEFT(JSON_UNQUOTE(JSON_EXTRACT(input, '$.text')), 12) = 'HEALTHPROBE:'
        ELSE NULL END AS resposta_healthcheck,
    CASE WHEN JSON_VALID(output)
        THEN JSON_EXTRACT(output, '$[*].wabaId')
        ELSE NULL END AS ids_retornados,
    OCTET_LENGTH(COALESCE(input, '')) + OCTET_LENGTH(COALESCE(output, ''))
      + OCTET_LENGTH(COALESCE(error, '')) + OCTET_LENGTH(COALESCE(log_entries, '')) AS bytes_payloads
FROM process_logs
WHERE instance = 'suprimaxxi'
  AND process_name IN ('waba-send-message', 'waba-send-template-message')
  AND created_at >= '2026-09-18 12:55:00'
  AND created_at <  '2026-09-18 13:12:00'
  AND LOCATE('wamid.HBgMNTU1MTg5MjQ4NDg3FQIAERgSQjJCNDlFMkFCRjY0NzZDQzg3AA==', COALESCE(output, '')) > 0
ORDER BY created_at
LIMIT 20;

-- 3. Candidatos de encaminhamento SEM wamid para o destinatario do evento.
-- Proximidade temporal/destinatario indica candidato; NAO autoriza associar IDs
-- automaticamente. Cruzar o recibo do bloco 2 e o log forward-messages-service.
SELECT /*+ MAX_EXECUTION_TIME(10000) */
    m.id, m.client_id, m.chat_id, m.contact_id,
    m.sent_at, m.status, m.is_forwarded, m.waba_id
FROM messages m
JOIN (
    SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,
        '$.entry[0].changes[0].value.statuses[0].recipient_id')) AS recipient
    FROM waba_webhook_queue
    WHERE id = 'e8ffd95b-4396-41f0-9c67-6c6f3bbec10e'
      AND instance = 'suprimaxxi'
) event_recipient
    ON m.`to` IN (event_recipient.recipient,
                  CONCAT(event_recipient.recipient, '@c.us'),
                  CONCAT(event_recipient.recipient, '@s.whatsapp.net'))
WHERE m.instance = 'suprimaxxi'
  AND m.sent_at >= '2026-09-18 12:55:00'
  AND m.sent_at <  '2026-09-18 13:12:00'
  AND m.is_forwarded = 1
  AND m.waba_id IS NULL
ORDER BY m.sent_at
LIMIT 100;

-- 3b. Evidencia adicional: recibo de envio exato localizado pelo usuario.
-- Nao restringir is_forwarded/waba_id antes de conhecer o resultado.
-- Mesmo texto/destinatario/horario indica candidato, nao vinculo unico garantido.
SELECT /*+ MAX_EXECUTION_TIME(10000) */
    m.id, m.client_id, m.chat_id, m.sent_at,
    m.status, m.is_forwarded, m.waba_id,
    m.body = JSON_UNQUOTE(JSON_EXTRACT(p.input, '$.text')) AS mesmo_texto
FROM process_logs p
JOIN messages m
    ON m.instance = p.instance
   AND m.`to` = JSON_UNQUOTE(JSON_EXTRACT(p.input, '$.to'))
WHERE p.id = 4474580
  AND p.instance = 'suprimaxxi'
  AND m.instance = 'suprimaxxi'
  AND m.sent_at >= '2026-09-18 12:55:00'
  AND m.sent_at <  '2026-09-18 13:12:00'
ORDER BY m.sent_at
LIMIT 100;

-- 4. Resumo dos encaminhamentos no periodo, sem retornar mensagens.
SELECT /*+ MAX_EXECUTION_TIME(10000) */
    id, process_name, process_id, status, start_time, end_time, created_at,
    CASE WHEN JSON_VALID(input) THEN JSON_EXTRACT(input, '$.messageCount') ELSE NULL END AS message_count,
    CASE WHEN JSON_VALID(input) THEN JSON_EXTRACT(input, '$.whatsappTargetCount') ELSE NULL END AS target_count
FROM process_logs
WHERE instance = 'suprimaxxi'
  AND process_name IN ('forward-messages-service', 'forward-messages', 'waba-forward-message')
  AND created_at >= '2026-09-18 12:55:00'
  AND created_at <  '2026-09-18 13:12:00'
ORDER BY created_at
LIMIT 30;

-- 5. Separar o padrao periodico de 120 falhas da causa do pico principal.
SELECT /*+ MAX_EXECUTION_TIME(10000) */
    instance, process_name, COUNT(*) AS falhas,
    COUNT(DISTINCT error_message) AS erros_distintos,
    SUM(error_message LIKE '%Mensagem%encontrada%status%') AS alvo_status_ausente
FROM process_logs
WHERE status = 'FAILED'
  AND created_at >= '2026-09-18 05:45:00'
  AND created_at <  '2026-09-18 05:46:00'
GROUP BY instance, process_name
ORDER BY falhas DESC;

-- 6. Clock do banco atual (nao prova a configuracao historica da aplicacao).
SELECT DATABASE() AS banco, VERSION() AS versao,
       @@session.time_zone AS fuso_sessao,
       @@global.time_zone AS fuso_global,
       @@system_time_zone AS fuso_sistema,
       NOW(3) AS agora_banco, UTC_TIMESTAMP(3) AS agora_utc;

-- 7. Estado ATUAL da fila, distinto do incidente historico.
SELECT status, COUNT(*) AS total,
       MIN(created_at) AS criado_mais_antigo,
       MAX(updated_at) AS ultima_atualizacao,
       MAX(retry_count) AS maior_contagem_tentativas
FROM waba_webhook_queue
WHERE instance = 'suprimaxxi'
GROUP BY status;
