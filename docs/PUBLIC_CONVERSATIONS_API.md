# API de Conversas do Tenant

Retorna as conversas do tenant associado ao token de autenticação, com paginação e filtros.

## Endpoint

```http
GET /api/whatsapp/conversations
```

O tenant não é informado na URL. Ele é identificado automaticamente a partir do `instance` da sessão autenticada.

## Autenticação

Envie o token no header `Authorization`:

```http
Authorization: SEU_TOKEN
```

## Parâmetros

Todos os parâmetros são opcionais.

| Parâmetro | Tipo | Padrão | Descrição |
|---|---:|---:|---|
| `page` | inteiro | `1` | Número da página. |
| `limit` | inteiro | `25` | Quantidade de conversas por página. Máximo: `100`. |
| `isFinished` | booleano | — | Filtra conversas finalizadas (`true`) ou em andamento (`false`). |
| `userId` | inteiro | — | Filtra pelo usuário responsável. |
| `sectorId` | inteiro | — | Filtra pelo setor. |
| `contactId` | inteiro | — | Filtra pelo contato. |
| `search` | texto | — | Busca por nome, telefone ou WhatsApp ID do contato. |
| `startedFrom` | data | — | Data/hora inicial da conversa, em formato aceito pelo JavaScript, como `2026-08-01T00:00:00Z`. |
| `startedTo` | data | — | Data/hora final da conversa. |

As conversas são ordenadas da mais recente para a mais antiga.

## Exemplo de requisição

```bash
curl --request GET \
  --url 'https://inpulse.infotecrs.inf.br/api/whatsapp/conversations?page=1&limit=25&isFinished=false&search=Maria' \
  --header 'Authorization: SEU_TOKEN'
```

## Exemplo de resposta

```json
{
  "message": "Conversations retrieved successfully!",
  "data": {
    "items": [
      {
        "id": 123,
        "instance": "tenant-exemplo",
        "contactId": 456,
        "userId": 10,
        "sectorId": 2,
        "isFinished": false,
        "startedAt": "2026-08-20T12:30:00.000Z",
        "finishedAt": null,
        "contact": {
          "id": 456,
          "name": "Maria Silva",
          "phone": "5511999999999",
          "whatsappId": "5511999999999"
        },
        "sector": {
          "id": 2,
          "name": "Vendas"
        },
        "_count": {
          "messages": 18
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 25,
      "total": 128,
      "totalPages": 6,
      "hasNextPage": true,
      "hasPreviousPage": false
    }
  }
}
```

## Respostas de erro

| Status | Situação |
|---:|---|
| `401` | Token ausente ou inválido. |
| `400` | Parâmetro inválido, como `isFinished` diferente de `true`/`false` ou ID não positivo. |
