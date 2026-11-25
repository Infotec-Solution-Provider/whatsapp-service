# API interna de bots de atendimento

O CRM usa `/api/whatsapp/triage` com `Authorization: Bearer <token da sessão>`. A empresa vem da sessão. Um administrador pode gerir os canais ativos da empresa. Para um supervisor, cada operação exige uma delegação vigente para o canal. A API retorna o resultado sob `data`.

## Criar e publicar

1. `GET /context` lista os canais autorizados. `GET /channels/:id/bots` lista os bots do canal e o identificador do principal em `defaultBotId`. `POST /channels/:id/bots` com `{"name":"Pós-atendimento"}` cria um rascunho e retorna HTTP 201 com `data.botId`, definição e revisão.
2. Use `GET /channels/:id/bots/:botId` para abrir esse bot e `PUT /channels/:id/bots/:botId/draft` com `{revision,name,definition}` para salvar uma edição. Um rascunho pode conter etapas sem destino. Use a revisão da resposta na próxima escrita. HTTP 409 indica uma edição concorrente. Os nomes devem ser distintos no canal.
3. `POST /channels/:id/validate` recebe `{definition}` e retorna `{issues}`. Cada problema identifica a etapa ou configuração, o campo e uma mensagem em português.
4. `POST /channels/:id/simulate` recebe `{definition,startTime,events}`. Use um instante ISO com fuso e eventos `{"type":"reply","text":"Vendas"}` ou `{"type":"timeout"}`. O simulador devolve o turno inicial e os turnos seguintes em `turns`, com mensagens, respostas, etapas visitadas e destino. Um evento de inatividade sem data avança o relógio até o prazo. A simulação usa valores fictícios e não envia mensagens.
5. `POST /channels/:id/bots/:botId/publish` com `{revision}` disponibiliza uma versão imutável para as regras do gestor. No mesmo endereço do bot, `POST /pause` recebe `{revision}` e `POST /rollback` recebe `{revision,versionId}` de uma versão daquele bot. As três operações devolvem o detalhe atualizado. Sessões em andamento continuam na sua versão original.

Os endereços anteriores de edição, publicação, pausa e reversão diretamente em `/channels/:id` continuam operando sobre o bot principal do canal.

## Definição do fluxo

```json
{
  "entry": "boas-vindas",
  "nodes": [
    {"id":"boas-vindas","type":"message","title":"Boas-vindas","text":"Olá! Vamos iniciar seu atendimento.","next":"assunto"},
    {"id":"assunto","type":"question","title":"Assunto","text":"Como podemos ajudar?","next":"encaminhar"},
    {"id":"encaminhar","type":"handoff","title":"Encaminhar para Vendas","sectorId":7}
  ],
  "fallbackSectorId":7,
  "timeoutMinutes":30,
  "maxInvalid":2,
  "schedule":{"timezone":"America/Sao_Paulo","days":[{"day":1,"start":"08:00","end":"18:00"}]}
}
```

Neste exemplo, substitua 7 por um setor autorizado a receber conversas no canal. A interface deve conservar os IDs estáveis durante renomeações. Cada nó tem `id`, `title` e `type`. Entre os conteúdos das mensagens, `{{horario}}` é substituído pela agenda da versão.

| Tipo | Campos e resultado |
|---|---|
| `message` | Envia `text` e segue para `next`. |
| `menu` | Mostra `text` e `options`, cada uma com `label` e `next`. Aceita o número ou o nome e grava o rótulo escolhido. |
| `question` | Mostra `text`, aguarda texto e segue para `next`. O resumo usa o título da pergunta. |
| `condition` | Compara a resposta de `answerKey` com `equals` e segue para `yes` ou `no`. A chave de uma resposta é `answerKey` do menu/pergunta ou seu `id`. |
| `hours` | Segue para `yes` durante as faixas de expediente, ou `no` fora delas. Na agenda, domingo é zero. |
| `handoff` | Encaminha ao `sectorId` com o resumo. Aceita mensagem final opcional em `text`. |

## Acessos e acompanhamento

- `GET /operators?search=nome` pesquisa usuários internos. `GET /channels/:id/grants` lista delegações. O administrador concede ou revoga com `PUT /channels/:id/grants/:userId` e `{"enabled":true}` ou `false`.
- `GET /channels/:id/activity` mostra sessões iniciadas, transferências, tempo médio e falhas nas últimas 24 horas, além das conversas que ainda permitem intervenção. O número de pendências contempla atendimentos antigos.
- `POST /channels/:id/chats/:chatId/takeover` transfere a conversa em triagem ao usuário da sessão. O backend verifica novamente o canal, a atribuição e os efeitos pendentes.
- A ativação do recurso por ambiente e as migrações do armazenamento estão em [Homologação com SQL por tenant](tenant-sql-homolog.md).

## Acionamentos do setor

No gestor de fluxo, o administrador configura as regras sob `/api/whatsapp/message-flow-studio/sectors/:sectorId`. O editor de fluxos e a triagem precisam estar habilitados para a empresa. Cada setor mantém sua própria revisão.

| Operação | Resultado |
|---|---|
| `GET /bots` | Catálogo em `data.bots`, com bot, canal, nome e versão publicada. A lista contempla os canais ativos e associados ao setor. |
| `GET /bot-triggers` | Retorna `data.revision`, `data.rules` e `data.bots`. Um setor sem regras tem revisão zero. |
| `PUT /bot-triggers` | Recebe `{revision,rules}` e substitui a lista do setor. HTTP 409 exige recarregar as regras atuais. Para desabilitar um acionamento, remova-o da lista. |
| `POST /bot-triggers/simulate` | Recebe `{rules,channelId,type,text?,botId?}` com a lista em edição. A prévia manual exige o `botId` escolhido. Retorna `data.matched` e `data.bot`. A operação só consulta o catálogo. |

Para acionar um bot dentro de um caminho de entrada, adicione uma etapa `START_BOT` com `config.botId` e `fallbackStepId`. A contingência aponta para o caminho de atendimento humano caso o bot esteja indisponível naquele número. O simulador do fluxo aceita `channelId` e apresenta o nome e a versão previstos. Ao terminar, o bot entrega a conversa ao setor escolhido e encerra aquele caminho.

Os tipos são `manual`, `transfer`, `closed` e `keyword`. Cada regra indica seu `botId`. A regra de palavra-chave também recebe `keywords`, uma lista de expressões comparadas à mensagem inteira, ignorando caixa, acentuação e espaços repetidos. Quando uma conversa ainda está sem setor definido, uma palavra só aciona o bot se apontar para um único setor elegível no canal. A transferência considera o setor de destino e o encerramento considera o setor do atendimento finalizado.

No mesmo setor e número, vários bots publicados podem aceitar início manual e cada bot pode ter expressões distintas. A API rejeita expressões que iniciariam dois bots naquele setor e exige um único destino para cada evento de transferência ou de encerramento. O catálogo identifica canal e bot separadamente.

Na API de triagem, `GET /channels/:id/chats/:chatId/start` retorna ao administrador ou delegado do canal os bots elegíveis em `data.bots`, com `botId`, `channelId`, `name` e `version`, além de `data.available`. Envie `POST` para o mesmo caminho com `{botId,requestId}`. Gere um UUID por ação e reutilize-o ao repetir uma solicitação após uma falha de rede. A resposta tem `data.started` e `data.chatId`. HTTP 409 indica que a conversa ou a publicação já não atende às condições de início.
