# Investigacao de status WABA — 18/09/2026

O pico informado e dominado por tentativas de atualizar status de mensagens cujo
`wamid` nao foi encontrado. A revisao e a reproducao offline encontraram um defeito
no encaminhamento WABA capaz de produzir exatamente essa condicao. A associacao
desse defeito ao incidente da `suprimaxxi` ainda depende dos resultados SQL.

## Escopo e evidencia

- Checkout local: `fix/reliable-outbound-send-20260908`, HEAD `f1f5dac`, com alteracoes
  preexistentes. Nenhum arquivo de runtime foi alterado nesta investigacao.
- Dados fornecidos: entre 13:07 e 13:10, 2.227 logs e 1.860 falhas; a amostra dos
  30 maiores grupos tem 30 wamids distintos com 60 ocorrencias cada, todos em
  `suprimaxxi`, processo `waba-webhook-entry/status`: 1.800 falhas (96,8%).
- Para um wamid, foram fornecidos dois itens da fila, ambos FAILED, retry_count=30
  e max_retries=30. Esses dois itens explicam as 60 ocorrencias desse ID. Os outros
  29 IDs ainda nao tiveram seus itens da fila examinados.
- Atualizacao fornecida pelo usuario: e8ffd95b-4396-41f0-9c67-6c6f3bbec10e contem
  sent, timestamp 1789736863; 1b78f135-a305-4f71-bfc3-ad042cbf8bfa contem delivered,
  timestamp 1789736864. Cada payload possui um status. Sao dois eventos distintos,
  nao evidencia de duplicacao do mesmo evento. A consulta por messages.waba_id
  nao encontrou registro correspondente.
- Os timestamps dos eventos correspondem a 18/09/2026 13:07:43 e 13:07:44 UTC
  (10:07:43 e 10:07:44 em UTC-03). O webhook reporta entrega desse ID; as falhas
  sao no processamento/associacao local do status. Isso nao comprova leitura e
  nao autoriza inferir que todos os outros IDs tiveram entrega confirmada.
- A ausencia atual de waba_id em messages nao distingue entre uma copia salva
  sem identificador, envio tecnico nao persistido ou registro removido.
- O usuario localizou o recibo do mesmo wamid: process_logs.id=4474580,
  process_name=waba-send-message, SUCCESS, created_at=2026-09-18 13:07:39.418,
  resposta_healthcheck=0. Esse resultado vincula o ID a um envio do adapter local
  registrado no banco consultado. O texto nao possui o prefixo HEALTHPROBE: usado
  pela resposta tecnica examinada; essa hipotese nao explica este recibo.
  Ainda falta identificar o chamador (encaminhamento, operador, bot ou outro fluxo)
  e eventual copia em messages sem waba_id.
- A unica conexao configurada no workspace aponta para MySQL local em porta 3307.
  A tentativa limitada de conexao retornou ECONNREFUSED. Nenhuma consulta foi
  executada com sucesso no banco local ou no banco de producao.

## 1. Defeito reproduzido: encaminhamento descarta o novo wamid

Fluxo ativo confirmado em `src/controllers/messages.controller.ts:381`:

1. `WhatsappService.forwardMessages` cria e notifica uma copia com status SENT,
   isForwarded=true e sem wabaId (`src/services/whatsapp.service.ts:991`).
2. Para origem interna, chama client.sendMessage e descarta seu DTO de retorno
   (`whatsapp.service.ts:1030`).
3. Para origem WhatsApp, chama client.forwardMessage (`whatsapp.service.ts:1043`).
   A implementacao WABA envia uma nova mensagem e descarta o DTO com o novo ID
   (`src/whatsapp-client/waba-whatsapp-client.ts:222`).
4. Nao existe uma atualizacao posterior que associe esse novo ID a copia salva.
5. O webhook busca `messages.waba_id` por igualdade, sem fallback por destinatario
   (`src/services/messages-distribution.service.ts:201`). Ausencia gera
   MessageStatusTargetNotFoundError e uma nova tentativa na fila.

O arquivo `message-forwarding.service.ts` tambem tem fluxo semelhante, mas sua
chamada esta comentada no controller. A reproducao usa o servico realmente chamado.

Reproducao: `node docs/investigations/2026-09-18-waba-status/reproduce-forwarding.cjs`.
Ela transpila o codigo atual e executa os metodos reais do servico e do cliente
WABA com dependencias de rede e persistencia em memoria. Imports nao previstos
sao rejeitados. Resultado:

```text
PASS control: WABA adapter returns the generated wamid
REPRODUCED whatsapp -> WABA: one simulated send, CRM row SENT, generated wamid not persisted
REPRODUCED internal -> WABA: one simulated send, CRM row SENT, generated wamid not persisted
```

Isso prova o defeito no checkout atual, nao que esses encaminhamentos ocorreram
em producao no horario investigado. Para estabelecer o vinculo, cruzar o recibo
`waba-send-message` com o wamid exato, os candidatos is_forwarded sem waba_id e os
logs `forward-messages-service`. Proximidade de horario/destinatario nao basta
para fazer backfill automatico.

## 2. Outro caminho que gera status sem mensagem CRM: health-check

`src/services/wwebjs-health-check.service.ts:226` envia `HEALTHPROBE:<id>` pelo
cliente oficial diretamente, sem persistir o DTO retornado em messages. A
interceptacao em `waba.service.ts` trata a mensagem de entrada do teste, mas o ramo
de status nao possui uma classificacao equivalente pelo wamid da resposta.

Se os status dessa resposta chegarem ao mesmo webhook, poderao atingir o mesmo
erro e limite de tentativas. O padrao de 120 falhas nos horarios de quarto de hora
e compativel com eventos repetitivos, mas nao confirma health-check: o cron padrao
atual e `*/30 * * * *`, configuravel em WWEBJS_HEALTH_CHECK_CRON. A configuracao de
producao e os logs desse outro intervalo ainda nao foram fornecidos.

## 3. A fila amplifica o problema e pode atrasar outros eventos

Em `src/services/waba-webhook-queue.service.ts`:

- Enqueue gera UUID novo; nao ha deduplicacao por evento de status.
- O limite padrao inserido pelo servico e 30. O default do schema e 3, mas o
  INSERT informa explicitamente o valor 30/configurado; o schema nao o substitui.
- Ao falhar, o item volta a PENDING e incrementa retry_count ate o limite.
- A selecao sempre prioriza created_at mais antigo. Nao existe next_attempt_at
  ou espera crescente por item. Existe uma pausa global de polling (padrao 1s).
- Um evento antigo sem alvo pode ser escolhido repetidamente antes dos novos.
- Cada tentativa repete consultas, atualizacoes da fila e gravacao de log com
  input/output/erro; numero de linhas de log nao representa todo o custo no banco.
- O claim usa UPDATE condicional por id/status, o que protege contra dois claims
  simultaneos do mesmo item. Dois UUIDs diferentes continuam independentes.
- retryFailed existe, mas nao foi encontrada chamada no src atual. Nao ha
  evidencia aqui de reabertura automatica desses itens terminais.

Os 30+30 sao tentativas de processar webhooks, nao novos envios ao destinatario.
Nao reduzir a questao a armazenamento de logs: status e andamento da fila tambem
podem ser afetados. Nao ha metricas de banco suficientes para afirmar saturacao.

## 4. Horarios e limites da contagem

O exemplo fornecido tem updated_at=10:08:52.786 e processed_at=13:08:52.786.
O codigo mistura NOW(3) do MySQL em created_at/updated_at com new Date() enviado
pelo Prisma na finalizacao de falha. Em sucesso/ignored, processed_at usa NOW(3).
Essa assimetria pode produzir convencoes diferentes ate na mesma coluna segundo
o caminho de finalizacao. A diferenca observada e compativel com local/UTC;
confirmar fusos do servidor, sessao da aplicacao e configuracao de runtime.

O filtro inicial de created_at entre 13:00 e 13:12 excluia os itens que existem
na fila com created_at as 10h. Por isso as consultas seguintes usam IDs exatos.
Nao interpretar a diferenca de 3h como tempo gasto na fila.

ProcessingLogger grava de forma assincrona e a contagem original usa created_at,
nao inicio da execucao. O pico mede insercoes registradas naquele minuto; nao
prova por si so a distribuicao das tentativas/chegadas ao webhook. A lista tambem
e limitada aos 100 maiores minutos, nao uma serie temporal completa.

## Proximos passos concretos

### Correlacao com o relato de pool enviado no mesmo dia

O historico da conversa 01a0b59c-daa0-7df3-87c4-3ec7df235874 aponta para os
anexos f3381e36-e450-4a66-be59-5042e4719dfd (captura de P2028),
7d3d3938-134f-4ca7-8c8b-00231db980b7 (stderr PM2) e
f5f548b5-a7fe-4368-a954-cecc0ed66fc3 (stderr com P2024).
Esses anexos foram relidos, sem depender apenas da memoria da conversa.

- Entrega do wamid investigado: 13:07:44 UTC / 10:07:44 UTC-03.
- P2028 em operatorOutboundSend.create: 14:00:15.347 UTC / 11:00:15.347 UTC-03.
- Server has closed the connection em queryRaw: 14:00:17.703 UTC.
- P2024 em requisicoes/consultas: a partir de 14:06:58.458 UTC / 11:06:58.458 UTC-03;
  mensagens informam timeout 10s e limite 64.
- O historico de recursos mais antigo dessas capturas comeca em 13:55:18.378 UTC,
  depois da entrega; nao cobre a janela de 13:07.

Os erros documentados ocorreram cerca de 53 a 59 minutos DEPOIS deste envio.
Nao ha coincidencia temporal demonstrada. A evidencia nao descarta falhas de pool
anteriores nao capturadas, mas tambem nao permite atribuir o wamid ausente a esses
incidentes posteriores. P2028 e P2024 devem continuar identificados separadamente.

Um lookup vazio por waba_id nao prova que nenhuma linha foi criada: nos fluxos
de operador/bot, uma mensagem PENDING e inserida antes do envio e o identificador
do provedor e persistido depois. Uma falha nessa atualizacao pode deixar a linha
existente sem wamid. Outros fluxos fazem persistencia depois do envio. Para a
hipotese de pool, procurar a falha de create/update na janela de 13:07-13:10 UTC,
com correlacao ao mesmo envio; nao concluir a causa apenas pela coincidencia do dia.

Executar os blocos de `diagnostico.sql` um por vez no banco do incidente:

1. Eventos dos dois UUIDs e lookup exato da mensagem, independente de horario.
2. Recibo do mesmo wamid no adapter, com indicador de resposta de health-check.
3. Candidatos encaminhados sem ID para o destinatario desse evento.
4. Operacoes de encaminhamento proximas do pico.
5. Origem das 120 falhas no minuto 05:45, separada do pico principal.
6. Fusos atuais do banco (nao comprovam a configuracao historica).
7. Estado atual da fila (nao substitui a evidencia historica).

Se o recibo do bloco 2 nao existir, o envio pode ser anterior ao intervalo,
originado por outro integrador, ou o log pode nao estar disponivel. Nao concluir
que nao houve envio. Se a mensagem exata existir agora, investigar persistencia
tardia/versao diferente: isso nao prova que existia durante as tentativas.

Direcao das correcoes, apos delimitar o caso: persistir o DTO do encaminhamento
no registro criado; manter PENDING ate conhecer o resultado e preservar UNKNOWN
quando houver ambiguidade; registrar/classificar recibos de health-check pelo ID
exato; espacamento de tentativas com prazo limitado para alvos ainda ausentes;
padronizar timestamps com cuidado para o historico. Nao ignorar indistintamente
todo status sem mensagem, nem reenviar mensagens para resolver status ausente.

As consultas foram revisadas contra o schema/codigo local; nao foram executadas
em MySQL por falta de conexao. Nenhum deploy, reenvio, reprocessamento, DELETE,
UPDATE de dados ou mudanca de configuracao foi realizado.
