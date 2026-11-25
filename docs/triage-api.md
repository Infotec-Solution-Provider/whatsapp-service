# API interna de bots de atendimento

O CRM usa `/api/whatsapp/triage` com `Authorization: Bearer <token da sessão>`. A empresa vem da sessão. Um administrador pode gerir os canais ativos da empresa. Para um supervisor, cada operação exige uma delegação vigente para o canal. A API retorna o resultado sob `data`.

## Criar e publicar

1. `GET /context` lista canais autorizados, situação da publicação e setores. `GET /channels/:id` retorna o nome, o rascunho, a revisão, o modelo Vendas/Suporte, os setores do canal e as versões. Um canal novo retorna uma definição inicial e revisão zero.
2. `PUT /channels/:id/draft` recebe `{revision,name,definition}`. Salve o rascunho antes da primeira publicação. Ele pode conter etapas sem destino. Use a revisão da resposta para a próxima escrita. HTTP 409 significa que outra edição foi gravada. Recarregue o canal para comparar o trabalho.
3. `POST /channels/:id/validate` recebe `{definition}` e retorna `{issues}`. Cada problema identifica a etapa ou configuração, o campo e uma mensagem em português.
4. `POST /channels/:id/simulate` recebe `{definition,startTime,events}`. Use um instante ISO com fuso e eventos `{"type":"reply","text":"Vendas"}` ou `{"type":"timeout"}`. O simulador devolve o turno inicial e os turnos seguintes em `turns`, com mensagens, respostas, etapas visitadas e destino. Um evento de inatividade sem data avança o relógio até o prazo. A simulação usa valores fictícios e não envia mensagens.
5. `POST /channels/:id/publish` com `{revision}` grava uma versão imutável, vinculada às próximas entradas do canal. `POST /channels/:id/pause` recebe a mesma estrutura. `POST /channels/:id/rollback` recebe `{revision,versionId}` e reativa uma versão daquele canal. As três operações retornam o detalhe atualizado com a revisão e o histórico. Uma sessão aberta continua executando sua versão original.

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
