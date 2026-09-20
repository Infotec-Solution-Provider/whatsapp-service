# Status WABA do health check

A resposta `HEALTHPROBE:<correlationId>` é enviada diretamente pelo cliente WABA e não cria uma mensagem no CRM. Antes da correção, seus status procuravam um registro em `messages`, geravam `MessageStatusTargetNotFoundError` e eram reprocessados pela fila até o limite de tentativas.

O envio dessa resposta agora inclui `biz_opaque_callback_data` com `inpulse:health-probe:v1:<clientId>:<correlationId>`. O webhook reconhece o marcador completo, exige o mesmo client e um UUID de correlação válido, registra o status recebido e retorna `ignored: true`. A fila usa seu estado existente `IGNORED`, sem novas tentativas. Status `failed` identificados também preservam os detalhes recebidos no log, sem procurar mensagem/contato do CRM.

O marcador acompanha o payload persistido da fila; seu reconhecimento não depende do registro temporário da sondagem, de um cache de WAMIDs ou do processo que enviou a resposta. Mensagens comuns, marcadores inválidos e marcadores de outro client seguem o processamento anterior, inclusive erro/retry quando a mensagem não existe.

Referência do campo: [documentação Gupshup sobre biz_opaque_callback_data](https://docs.gupshup.io/changelog/whatsapp-self-serve-platform). Ela descreve o repasse do campo nos webhooks sent/delivered/read. A validação local simula esses callbacks; a confirmação do retorno pela Meta no ambiente instalado deve ser feita após o deploy.

## Validação e entrada em produção

- `npm run test:waba-health-status`: fluxo real do health check com dependências externas simuladas, callback antes da resposta HTTP e após remoção da sondagem, status repetidos, isolamento por client, mensagens comuns e transições da fila.
- `npx tsc --noEmit`: verificação de tipos do serviço.
- Após publicar, executar um health check e verificar se seus novos status contêm o marcador e terminam como `IGNORED` na fila.
- Nenhuma migração de banco é necessária para esta correção.

## Eventos anteriores

Payloads anteriores não possuem o marcador e não podem ser classificados com segurança apenas pelo destinatário ou pela ausência de `messages.waba_id`. Para tratar a fila antiga, primeiro cruzar cada WAMID com o log de envio `waba-send-message`, confirmando corpo `HEALTHPROBE:<correlationId>` e client/instance. Só os itens comprovadamente pertencentes ao health check podem ser encerrados como ignorados. Esta alteração não modifica a fila nem os logs históricos.
