# Catálogo de Parâmetros

## Visão geral

Os parâmetros dinâmicos ficam armazenados na tabela `parameters` do banco de dados MySQL e são expostos pela `ParametersService`. Eles permitem ajustar comportamentos em nível de instância, setor ou usuário sem necessidade de deploy. A resolução de escopo obedece à seguinte ordem de precedência:

1. parâmetros da instância (`scope = INSTANCE`)
2. parâmetros do setor (`scope = SECTOR`)
3. parâmetros do usuário (`scope = USER`)

Quando um parâmetro existe em escopos diferentes, o valor de maior precedência sobrepõe os demais. Todos os valores são persistidos como `string` e cada consumidor é responsável por efetuar o parse para o tipo adequado.

## Estrutura de dados

| Campo      | Tipo             | Observações                                                    |
| ---------- | ---------------- | -------------------------------------------------------------- |
| `id`       | `Int`            | Chave primária.                                                |
| `scope`    | `ParameterScope` | `INSTANCE`, `SECTOR` ou `USER`.                                |
| `key`      | `String`         | Identificador do parâmetro (case sensitive).                   |
| `value`    | `String`         | Valor em texto. Convertido no consumo conforme necessário.     |
| `instance` | `String?`        | Obrigatório para escopos `INSTANCE` e `USER`.                  |
| `sectorId` | `Int?`           | Obrigatório para escopos `SECTOR` e `USER` (quando aplicável). |
| `userId`   | `Int?`           | Obrigatório para escopo `USER`.                                |

Uniqueness: `scope + instance + sectorId + userId + key`.

## APIs e serviços relevantes

- `GET /api/whatsapp/session/parameters`: retorna o objeto de parâmetros resolvidos para a sessão autenticada.
- `ParametersService.getSessionParams(session: SessionData)`: carrega e mescla os parâmetros dos três escopos.

## Parâmetros em uso

### Aprovação de ações sobre contatos

| Chave                                                  | Escopo     | Padrão  | Descrição                                                                                                              |
| ------------------------------------------------------ | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `require_supervisor_approval_for_contact_reactivation` | `INSTANCE` | `false` | Quando `true`, usuários comuns enviam uma solicitação antes de reativar um contato. Supervisores executam diretamente. |
| `require_supervisor_approval_for_contact_deletion`     | `INSTANCE` | `false` | Quando `true`, usuários comuns enviam uma solicitação antes do soft delete. Supervisores executam diretamente.         |

Somente os valores literais `true` e `false` são aceitos. Valor ausente ou inválido assume `false`. Essas duas chaves são lidas exclusivamente no escopo da instância, sem sobrescrita por setor ou usuário.

Para habilitar as duas aprovações em um tenant, substitua `nome_da_instancia` e execute:

```sql
UPDATE parameters
SET value = 'true'
WHERE scope = 'INSTANCE'
  AND instance = 'nome_da_instancia'
  AND sectorId IS NULL
  AND userId IS NULL
  AND `key` IN (
    'require_supervisor_approval_for_contact_reactivation',
    'require_supervisor_approval_for_contact_deletion'
  );

INSERT INTO parameters (scope, instance, sectorId, userId, `key`, value)
SELECT 'INSTANCE', 'nome_da_instancia', NULL, NULL, requested.key_name, 'true'
FROM (
  SELECT 'require_supervisor_approval_for_contact_reactivation' AS key_name
  UNION ALL
  SELECT 'require_supervisor_approval_for_contact_deletion'
) AS requested
WHERE NOT EXISTS (
  SELECT 1
  FROM parameters current_parameter
  WHERE current_parameter.scope = 'INSTANCE'
    AND current_parameter.instance = 'nome_da_instancia'
    AND current_parameter.sectorId IS NULL
    AND current_parameter.userId IS NULL
    AND current_parameter.`key` = requested.key_name
);
```

Cada chave pode ser habilitada ou desabilitada independentemente alterando seu `value` para `true` ou `false`.

### `chat_inactivity_ms`

- **Descrição**: Tempo máximo (em milissegundos) sem atividade antes de o chat ser considerado inativo.
- **Valor padrão**: `1800000` (30 minutos), aplicado quando o parâmetro não está cadastrado.
- **Escopos suportados**: `INSTANCE`, `SECTOR`, `USER` (escopos mais específicos prevalecem).
- **Consumo**: `src/services/schedules.service.ts` (`getTimeoutConfig`).
- **Observações**: Valor precisa ser numérico. Usado pelo monitoramento para decidir quando finalizar conversas sem interação.

### `chat_menu_response_ms`

- **Descrição**: Janela de espera (em milissegundos) para resposta do menu automático após sua última apresentação.
- **Valor padrão**: `900000` (15 minutos).
- **Escopos suportados**: `INSTANCE`, `SECTOR`, `USER`.
- **Consumo**: `src/services/schedules.service.ts` (`getTimeoutConfig`).
- **Observações**: Deve ser um número inteiro em ms; usado nas decisões de envio do menu de setores.

### `chat_auto_finish_enabled`

- **Descrição**: Liga/desliga a finalização automática de chats inativos.
- **Valor padrão**: `false` (qualquer valor diferente de `"true"` é interpretado como `false`).
- **Escopos suportados**: `INSTANCE`, `SECTOR`, `USER`.
- **Consumo**: `src/services/schedules.service.ts` (`getTimeoutConfig`).
- **Observações**: Configure como `"true"` para habilitar a rotina de finalização automática.

### `satisfaction_survey_timeout_ms`

- **Descrição**: Tempo limite (em milissegundos) para respostas na pesquisa de satisfação da Exatron.
- **Valor padrão**: Valor do ambiente `EXATRON_PESQUISA_TIMEOUT_MS`, ou `1800000` (30 minutos) se a env var estiver ausente.
- **Escopos suportados**: `INSTANCE`, `SECTOR`, `USER`.
- **Consumo**: `src/bots/exatron-satisfaction.bot.ts` (`getOrCreate`).
- **Observações**: Permite customizar o timeout da pesquisa por usuário/setor/instância; o valor precisa ser parseável para número.

## Como cadastrar ou atualizar parâmetros

1. Identifique o escopo necessário (instância, setor ou usuário).
2. Garanta que o trio `(scope, instance, sectorId, userId)` esteja coerente para o escopo escolhido.
3. Defina o `key` exatamente como listado acima e atribua o `value` em formato texto.
4. Atualize/insira o registro na tabela `parameters` via Prisma Client ou ferramenta SQL administrativa.
5. As alterações são aplicadas imediatamente nos próximos carregamentos de sessão (não requer restart da aplicação).

## Boas práticas e follow-ups

- Documente novos parâmetros neste arquivo sempre que criar chaves adicionais.
- Valide os valores após alteração (ex.: números parseáveis, booleanos coerentes).
- Considere automatizar testes unitários para validar comportamento padrão quando parâmetros estiverem ausentes.
