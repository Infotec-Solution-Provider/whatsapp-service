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

O token está em `data.token`, vale por 7 dias e é renovado repetindo o login. Não há refresh token nem token longo revogável atualmente.

O login aceita até 10 tentativas por minuto para a mesma origem, tenant e usuário.

## Rotas

| Finalidade | Requisição |
|---|---|
| Conversas | `GET /api/whatsapp/conversations?page=1&limit=100` |
| Conversas de um contato | `GET /api/whatsapp/conversations?contactId=123` |
| Mensagens da conversa | `GET /api/whatsapp/conversations/456/messages?limit=100&beforeId=999` |
| Mensagens por período | `GET /api/whatsapp/messages/export?sentFrom=2026-08-01T00:00:00Z&sentTo=2026-09-01T00:00:00Z&limit=100&afterId=999` |
| Usuários | `GET /api/whatsapp/users?page=1&limit=100&active=true` |
| Setores | `GET /api/whatsapp/sectors` |

Listagens retornam o envelope `{"message":"...","data":{...}}`. Conversas usam `data.items` e `data.pagination`. O filtro `contactId` é aplicado junto com o tenant do token.

Na exportação por período, repita a chamada usando `data.pagination.nextCursor` como `afterId`. Termine quando `hasMore` for `false`. `sentFrom` e `sentTo` são inclusivos.

## Direção, status e tipo

Cada mensagem retorna:

```json
{"direction":"INBOUND|OUTBOUND|INTERNAL","senderType":"CONTACT|ATTENDANT|WHATSAPP_ACCOUNT|BOT|SYSTEM|THIRD_PARTY"}
```

Para métricas humanas, considere saída do atendente somente quando `direction` for `OUTBOUND` e `senderType` for `ATTENDANT`. O campo `userId` identifica o atendente quando disponível. Não use `status` para inferir direção: `RECEIVED` também pode significar que uma mensagem enviada foi entregue.

Status possíveis: `PENDING`, `SENT`, `RECEIVED`, `READ`, `DOWNLOADED`, `ERROR`, `REVOKED`.

`type` é aberto e depende do provedor. Valores comuns: `chat`, `text`, `audio`, `ptt`, `image`, `video`, `document`, `sticker`, `location`, `vcard`, `reaction`, `interactive`, `template`. A integração deve aceitar valores desconhecidos.

Áudios normalmente têm `body` vazio e usam `fileId`, `fileName`, `fileType` e `fileSize`. Não há transcrição disponível.

## Uso recomendado

As rotas de BI compartilham a quota de 50 chamadas por minuto por token e aceitam no máximo 4 chamadas simultâneas por token. Ao exceder, retornam `429` com `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining` e `RateLimit-Reset`.

Use `limit=100` e, no cliente, no máximo 2 chamadas simultâneas. Em `429`, `502`, `503` ou `504`, faça nova tentativa com espera exponencial e respeite `Retry-After`.
