# API WhatsApp para BI

Base de produção: `https://inpulse.infotecrs.inf.br`  
Autenticação nas rotas abaixo: `Authorization: Bearer <token>`.

## Token

```http
POST /api/auth/login
Content-Type: application/json
```

```json
{"instance":"TENANT","LOGIN":"USUARIO_SERVICO","SENHA":"SENHA"}
```

O token de usuário está em `data.token`, vale por 7 dias e é renovado repetindo o login. Não há refresh token nesse fluxo. A versão com as correções INF-20261019-004 também oferece uma credencial de serviço opcional, exclusiva de leitura BI, descrita abaixo; ela exige publicação e configuração pelo administrador.

O login aceita até 10 tentativas por minuto para a mesma origem, tenant e usuário.

## Rotas

| Finalidade | Requisição |
|---|---|
| Conversas | `GET /api/whatsapp/conversations?page=1&limit=100` |
| Conversas de um contato | `GET /api/whatsapp/conversations?contactId=123` |
| Conversas finalizadas no período | `GET /api/whatsapp/conversations?finishedFrom=2026-08-01T00:00:00-03:00&finishedTo=2026-08-31T23:59:59.999-03:00` |
| Uma conversa | `GET /api/whatsapp/conversations/456` |
| Transferências por período | `GET /api/whatsapp/transfers?transferredFrom=2026-08-01T00:00:00-03:00&transferredTo=2026-08-31T23:59:59.999-03:00&limit=100&afterId=999` |
| Transferências de uma conversa | `GET /api/whatsapp/transfers?conversationId=456` |
| Mensagens da conversa | `GET /api/whatsapp/conversations/456/messages?limit=100&beforeId=999` |
| Mensagens por período | `GET /api/whatsapp/messages/export?sentFrom=2026-08-01T00:00:00Z&sentTo=2026-09-01T00:00:00Z&limit=100&afterId=999` |
| Usuários | `GET /api/whatsapp/users?page=1&limit=100&active=true` |
| Setores | `GET /api/whatsapp/sectors` |

Listagens retornam o envelope `{"message":"...","data":{...}}`. Conversas usam `data.items` e `data.pagination`. O filtro `contactId` é aplicado junto com o tenant do token. Conversas aceitam `startedFrom`/`startedTo` e `finishedFrom`/`finishedTo` (inclusivos).

### Conversas com atividade no período (`updatedFrom` / `updatedTo`)

`GET /api/whatsapp/conversations?updatedFrom=2026-10-16T00:00:00-03:00&updatedTo=2026-10-17T00:00:00-03:00&limit=100`

O filtro seleciona conversas com pelo menos um destes eventos no intervalo inclusivo: abertura (`started_at`), encerramento (`finished_at`), mensagem (`sent_at`), transferência registrada (`transferred_at`) ou última alteração do contato vinculado (`contacts.updated_at`). O total e os itens usam o mesmo filtro, combinado com os demais filtros da rota. A ordenação continua `startedAt DESC, id DESC`.

`updatedFrom` é obrigatório quando `updatedTo` é informado. Ambos exigem ISO 8601 com fuso. A janela máxima é de 31 dias; divida períodos maiores. Sem `updatedTo`, o servidor fixa o instante da consulta e o devolve em `data.activityWindow.to`; reutilize esse valor nas páginas seguintes. `data.activityWindow.semantics` é `activity`.

Este contrato acompanha **atividade**, sem novas colunas e sem migração. Não é um histórico de todas as alterações: resultado/tag alterados sem novo evento, edições/status de mensagens antigas, exclusões, alterações diretas no CRM/ERP e contatos cujo `updated_at` foi novamente alterado depois da janela não são garantidos. As respostas são o estado atual, não uma fotografia histórica. Mudanças durante a paginação ainda podem deslocar itens. Use sobreposição entre janelas, deduplicação por ID, recarga das conversas abertas e reconciliação completa periódica para o BI. O filtro não exige nem utiliza `chats.updated_at` ou `messages.updated_at`.

Na exportação por período, repita a chamada usando `data.pagination.nextCursor` como `afterId`. Termine quando `hasMore` for `false`. `sentFrom` e `sentTo` são inclusivos. A rota de transferências pagina do mesmo jeito.

Em conversas, `contact.customer` traz o cliente do CRM vinculado ao contato (`null` quando não há vínculo):

```json
{"contact":{"customerId":123,"customer":{"id":123,"name":"RAZÃO SOCIAL","cpfCnpj":"00000000000191","erpCode":"C0001"}}}
```

## Transferências

Cada troca de responsável ou de setor de uma conversa gera um item:

```json
{"id":999,"conversationId":456,"fromUserId":10,"toUserId":20,"fromSectorId":1,"toSectorId":1,"initiatedByUserId":10,"source":"manual","transferredAt":"2026-08-10T14:00:00.000Z"}
```

`source` indica a origem: `manual` (operador), `auto-sector`, `auto-operator` (distribuição automática) e `bot-return-previous-operator`. O histórico existe a partir de 31/03/2026. Com o `userId` atual da conversa e esta lista, é possível reconstituir o responsável em qualquer momento: antes da primeira transferência, o responsável é o `fromUserId` dela.

## Direção, status e tipo

Cada mensagem retorna:

```json
{"direction":"INBOUND|OUTBOUND|INTERNAL","senderType":"CONTACT|ATTENDANT|WHATSAPP_ACCOUNT|BOT|SYSTEM|THIRD_PARTY"}
```

`direction` e `senderType` descrevem a origem da mensagem. Para reproduzir os relatórios do painel, use o campo `report` (seção abaixo). O campo `userId` identifica o atendente autor. Após a publicação da correção, templates enviados por uma sessão humana também gravam esse autor; agentes preservam `agentId` e não recebem autoria humana. Templates históricos sem autor permanecem assim: o responsável atual da conversa não prova quem disparou. Não use `status` para inferir direção: `RECEIVED` também pode significar que uma mensagem enviada foi entregue.

Status possíveis: `PENDING`, `SENT`, `RECEIVED`, `READ`, `DOWNLOADED`, `ERROR`, `REVOKED`.

`type` é aberto e depende do provedor. Valores comuns: `chat`, `text`, `audio`, `ptt`, `image`, `video`, `document`, `sticker`, `location`, `vcard`, `reaction`, `interactive`, `template`. A integração deve aceitar valores desconhecidos.

Áudios normalmente têm `body` vazio e usam `fileId`, `fileName`, `fileType` e `fileSize`. Não há transcrição disponível.

## Regras dos relatórios (`report`)

Mensagens (exportação por período e mensagens da conversa) e conversas trazem o campo `report`, calculado com as mesmas regras dos relatórios do painel (`/reports/dashboard`). Somar esses campos reproduz os números do painel.

Mensagem:

```json
{"report":{"counted":true,"type":"SENT|RECEIVED","userId":123}}
```

- `counted`: a mensagem entra no total "Mensagens". Ficam de fora mensagens de sistema, de terceiros/erros e de bots, mensagens de conversas sem responsável e as do usuário de código 1.
- `type`: `SENT` para toda mensagem enviada pelo número da empresa (atendente, template, encaminhamento); `RECEIVED` para mensagem do contato.
- `userId`: operador a quem o painel atribui a mensagem: o `userId` da mensagem ou, se vazio, o responsável atual da conversa. `-1` é a linha "Sistema/Admin" (responsável de sistema ou sem cadastro de operador).

Conversa:

```json
{"report":{"userId":123,"finishedCounted":true,"finishedByUserId":123,"cycleSeconds":3600}}
```

- `userId`: responsável atual pela mesma regra (`-1` = Sistema/Admin, `null` = fora dos relatórios).
- `finishedCounted`: a conversa entra em "Finalizados" no período do seu `finishedAt`.
- `finishedByUserId`: quem finalizou; finalização automática (sem autor) conta como `-1`.
- `cycleSeconds`: duração de `startedAt` a `finishedAt`, usada no "Ciclo do atendimento".

`/users` lista todos os operadores considerados nos relatórios, inclusive os ocultos no WhatsApp (`visibleInWhatsapp: false`), então todo `report.userId` positivo tem um usuário correspondente.

O painel usa dias no horário de Brasília: para um mês, filtre de `...T00:00:00-03:00` até `...T23:59:59.999-03:00`. "Pendências" é uma foto do momento da consulta e não tem campo equivalente.

## Uso recomendado

Por padrão, as rotas de BI compartilham a quota de 50 chamadas por minuto por token e aceitam no máximo 4 chamadas simultâneas por token. Ao exceder, retornam `429` com `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining` e `RateLimit-Reset`. Limitação anterior à autenticação retorna `429` e `Retry-After`.

Use `limit=100` e, no cliente, no máximo 2 chamadas simultâneas. Em `429`, `502`, `503` ou `504`, faça nova tentativa com espera exponencial e respeite `Retry-After`.

## Configuração opcional pelo administrador

Nenhuma credencial ou cota foi ativada por esta alteração. Não incluir tokens em Git, logs ou exemplos reais.

`PUBLIC_BI_SERVICE_TOKENS_FILE` aponta para um arquivo JSON externo ao repositório, legível apenas pelo processo/administrador. Cada entrada contém `id`, `instance`, `sha256` (64 caracteres hexadecimais minúsculos), `expiresAt` (ISO com fuso) e opcionalmente `disabled`. Gerar o segredo com aleatoriedade criptográfica: prefixo `bi1_` mais pelo menos 32 bytes aleatórios codificados em base64url; guardar somente seu SHA-256 no arquivo e entregar o segredo por canal seguro. A expiração é explícita, podendo superar os sete dias do JWT. O administrador define a validade.

O arquivo é relido a cada requisição dessa credencial. Remover/desativar uma entrada revoga o acesso; uma rotação pode manter temporariamente dois hashes com o mesmo `id` e tenant. Arquivo inválido/ilegível retorna `503` sem afetar o login comum. Sem arquivo configurado, essas credenciais são recusadas. Limites: 128 entradas e 64 KiB.

A credencial só aceita os GETs da tabela de rotas acima, pertence a um único tenant e dá leitura de BI de todo esse tenant; não é uma restrição por setor. POST, HEAD e demais rotas são recusados antes dos controladores. Não fornece sessão de operador nem acesso ao CRM, ao painel ou ao reports-service.

`PUBLIC_BI_RATE_PROFILES_JSON` configura cotas por tenant e janela noturna. Exemplo ilustrativo, não aplicado:

```json
[{"instance":"TENANT","maxRequests":50,"maxConcurrent":4,"night":{"start":"22:00","end":"06:00","timeZone":"America/Sao_Paulo","maxRequests":120,"maxConcurrent":4}}]
```

Os tokens do tenant com perfil compartilham a cota e a concorrência. Início inclusivo/fim exclusivo; atravessar meia-noite é suportado. Sem perfil, mantêm-se os limites por token e as variáveis existentes `PUBLIC_BI_RATE_LIMIT_MAX_REQUESTS`, `PUBLIC_BI_RATE_LIMIT_WINDOW_MS`, `PUBLIC_BI_MAX_CONCURRENT_REQUESTS`. Perfis são lidos no início do processo. Contadores são locais ao processo; não usar múltiplos workers como se houvesse uma cota distribuída. Validar capacidade e EXPLAIN das consultas antes de ampliar a cota.

## Primeira devolutiva e qualidade dos dados

A primeira devolutiva é a média aritmética, em segundos corridos, de uma primeira resposta por conversa elegível. Parte da primeira mensagem do cliente e termina na primeira mensagem da operação estritamente posterior, dentro do período filtrado. A regra existente exige a mesma data SQL dos timestamps armazenados; não desconta horário não útil. Mensagens identificadas como bot ficam fora normalmente; templates com origem da operação podem contar. Saudações/confirmações reconhecidas até uma hora após outro encerramento do contato são excluídas. A consulta dos detalhes passou a usar a mesma seleção do KPI e da série diária. O painel mostra soma, contagem e média dos detalhes.

Em contatos, o filtro **Sem cliente** permite listar os registros a completar. **Vincular cliente** usa a busca por CPF/CNPJ existente e exige seleção e confirmação; nunca substitui um vínculo já preenchido por outro usuário. Uma falha de sincronização com o CRM é informada e permite repetir a mesma confirmação. Sugestões por telefone dependem do parâmetro de instância `contact_customer_phone_suggestions_enabled=true`, desativado por padrão, schema compatível e acesso ao CRM. Correspondências ambíguas continuam exigindo escolha humana; não há preenchimento em lote.

Na pesquisa, registros sem data não passam mais por filtros de período. A resposta do relatório informa metadados de dados ausentes e associação não verificada. O enriquecimento histórico da Exatron ainda depende de validar o schema/dados legados. O bot guarda referências a respostas pendentes no arquivo de sessões existente, confirma a gravação antes de avançar e usa a mensagem de origem para evitar duplicação em tentativas após falha. Isso pressupõe um único processo proprietário do arquivo e não garante envio exatamente uma vez após queda entre checkpoint e envio. Não houve ativação do disparo automático, reenvio de pesquisas ou alteração de motivos de encerramento.
