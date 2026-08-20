# API de Mensagens da Conversa

Retorna as mensagens de uma conversa do tenant associado ao token de autenticação.

## Endpoint

```http
GET /api/whatsapp/conversations/:id/messages
```

Substitua `:id` pelo ID da conversa retornado pela API de conversas.

## Autenticação

Envie o token no header `Authorization`:

```http
Authorization: SEU_TOKEN
```

## Parâmetros

| Parâmetro | Local | Tipo | Padrão | Descrição |
|---|---|---:|---:|---|
| `id` | URL | inteiro | obrigatório | ID da conversa. |
| `limit` | query string | inteiro | `50` | Quantidade de mensagens. Mínimo: `1`; máximo: `100`. |
| `beforeId` | query string | inteiro | — | Retorna mensagens anteriores à mensagem com este ID. |

As mensagens são retornadas em ordem cronológica dentro da página. Para buscar a página anterior, use o `nextCursor` retornado na resposta como `beforeId`.

## Exemplo de requisição

```bash
curl --request GET \
  --url 'https://inpulse.infotecrs.inf.br/api/whatsapp/conversations/123/messages?limit=50' \
  --header 'Authorization: SEU_TOKEN'
```

## Exemplo de paginação

```bash
curl --request GET \
  --url 'https://inpulse.infotecrs.inf.br/api/whatsapp/conversations/123/messages?limit=50&beforeId=980' \
  --header 'Authorization: SEU_TOKEN'
```

## Exemplo de resposta

```json
{
  "message": "Chat messages retrieved successfully!",
  "data": {
    "messages": [
      {
        "id": 981,
        "chatId": 123,
        "contactId": 456,
        "from": "5511999999999",
        "to": "5511888888888",
        "type": "chat",
        "body": "Olá, gostaria de saber mais detalhes.",
        "timestamp": "2026-08-20T12:30:00.000Z",
        "status": "RECEIVED",
        "sentAt": "2026-08-20T12:30:00.000Z"
      }
    ],
    "quotedMessages": [],
    "nextCursor": 981
  }
}
```

Quando não houver mais mensagens anteriores, `nextCursor` será `null`.

## Respostas de erro

| Status | Situação |
|---:|---|
| `400` | ID da conversa, `limit` ou `beforeId` inválido, ou conversa não encontrada no tenant. |
| `401` | Token ausente ou inválido. |

