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

### Tela administrativa de parâmetros

No frontend atual, **Cadastros → Parâmetros → WhatsApp** oferece controles amigáveis para as opções de
`src/parameters/parameter-settings.catalog.ts`. Adicionar ou remover uma definição desse catálogo altera
a tela sem criar um formulário novo. Chaves fora dele continuam preservadas no banco.

- `GET /api/whatsapp/parameter-settings?scope=SECTOR&sectorId=11` ou `?scope=USER&userId=7`: catálogo compatível, valores explícitos e valores herdados, com a origem de cada um. Sem escopo, consulta a instância.
- `GET /api/whatsapp/parameter-settings/targets?scope=USER&search=nome`: busca de usuários do CRM do tenant, limitada a 50 resultados, sem credenciais; `scope=SECTOR` lista apenas os setores WhatsApp da instância. A busca aceita também código e inclui usuários inativos identificados.
- `PATCH /api/whatsapp/parameter-settings`: `{ changes: [{ key, value, previousValue }] }`.
- Ambas as rotas exigem autenticação e perfil `ADMIN`; a instância vem da sessão, nunca do payload.
- `value: null` remove somente a exceção da chave no alvo selecionado, restaurando a herança. Desativar grava `"false"`; restaurar e desativar têm significados diferentes.
- O salvamento é transacional, com isolamento `Serializable` e comparação de `previousValue`. Conflitos retornam
  HTTP 409, sem sobrescrever a edição concorrente. Não há retry automático de gravação.
- A tela atualiza os parâmetros resolvidos da sessão ao salvar. Outras sessões carregam as opções na próxima consulta.
- Setor e usuário são editáveis pela seleção de escopo. O PATCH aceita `target: { scope: "SECTOR", sectorId: 11 }` ou `{ scope: "USER", userId: 7 }`; o tenant sempre vem da sessão administrativa. Setores e usuários são validados antes da leitura e gravação.
- **Personalizar** fixa uma exceção, inclusive quando igual ao valor herdado. **Usar valor herdado** remove somente a exceção selecionada (`value: null`). Trocar de alvo com rascunho exige descarte explícito; respostas atrasadas do alvo anterior são ignoradas.
- A herança do usuário considera seu setor atual no CRM, validado contra os setores WhatsApp da instância. Sem setor correspondente, herda diretamente da instância. Exceções USER pertencem ao usuário e tenant, independentemente de mudanças de setor.
- Registros SECTOR legados com `instance = NULL` continuam aceitos somente para setores pertencentes ao tenant. Novos registros sempre gravam a instância. Duplicatas legadas são resolvidas pelo maior `id` e atualizadas/removidas juntas para o alvo.
- Aprovações de contatos e sincronização de grupos internos são exclusivas da instância. O bot de vinculação aceita instância e setor. As demais opções do catálogo aceitam os três escopos; o backend rejeita gravações incompatíveis.
- A rotina de inatividade considera ativações por setor/usuário mesmo sem ativação global. A identificação de usuário na rotina inclui o tenant, evitando colisões de códigos entre bancos CRM.
- A configuração atual de inatividade usa `chat_auto_finish_idle_time`, em **milissegundos**, na rotina
  `src/routines/idle-chats.routine.ts`. A tela converte esse valor para minutos; padrão da rotina: 30 minutos.
- O ADMIN da instância gerencia dias fechados em `GET /api/whatsapp/parameter-settings/closed-dates`
  e `PUT` ou `DELETE /api/whatsapp/parameter-settings/closed-dates/:date` (data `AAAA-MM-DD`).
  O GET também informa se a contagem por calendário está ativa no ambiente.
- Depois de aplicar a migração e cadastrar as datas de cada instância, ative
  `CHAT_AUTO_FINISH_CLOSED_DAYS_ENABLED=true` na configuração do processo WhatsApp. A rotina passa
  a excluir sábados, domingos e datas cadastradas no fuso `America/Sao_Paulo`. Omitir a variável
  ou usar `false` restaura a contagem corrida e mantém o cadastro disponível.
- Sincronização de grupos internos possui padrão dependente do provedor; a tela apresenta explicitamente
  **Padrão do provedor**, **Ativada** e **Desativada**.

A aba CRM usa a API do `users-service` e a tabela legada `parametros` do tenant; não usa `clients_parameters`.

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

### `start_chats_only_for_loyal_operator`

- **Escopo**: exclusivamente `INSTANCE`, consumido por `getInstanceBooleanParam`. Valores `USER` e `SECTOR` não habilitam nem desabilitam esta política.
- **Padrão**: `false`. Somente o literal `true` habilita; ausência ou valor inválido preserva o comportamento anterior.
- **Regra**: ao iniciar atendimento manual, um operador não pode iniciar contato vinculado a cliente cuja fidelização pertence a outro operador positivo. A fidelização é a mesma já usada pelo WhatsApp: `campanhas_clientes` do CRM do tenant, filtrado por `CLIENTE` e ordenado por `CODIGO DESC LIMIT 1`, via `ContactsService.getContactLoalty`. Não usa `clientes.OPERADOR` nem acrescenta filtros `FIDELIZA`/`CONCLUIDO`.
- **Exceções**: perfil autenticado `ADMIN`; contato sem cliente; ausência de fidelização; operador de fidelização nulo, zero ou negativo. `start_chats_as_admin` apenas direciona o novo chat à supervisão e não concede exceção ao operador que inicia.
- **Momento da validação**: antes de consultar foto, criar/sincronizar chat, inserir mensagem de sistema ou enviar o template inicial. Contato de outro tenant ou desativado é recusado. Falhas nas consultas necessárias ou identificador de fidelização inválido não liberam o início.
- **Envios manuais**: cobre o endpoint normal, com e sem envio durável, e o endpoint direto de templates. Sob a flag, valida tenant/canal/contato/destinatário e, quando há `chatId`, o atendimento ativo desse contato. O dono atual pode continuar um atendimento recebido por transferência mesmo que a fidelização CRM continue com o dono anterior. Chat ativo de outro operador ou `chatId` inválido não vira uma consulta alternativa de fidelização. Repetições idempotentes devolvem a tentativa já registrada antes da autorização de uma intenção nova.
- **Transferências**: sob a flag, somente `ADMIN` ou o dono atual pode transferir um atendimento ativo do tenant para um operador positivo existente no CRM desse tenant. Atualização condicional confere novamente dono/tenant/estado; uma alteração concorrente retorna `409` sem sincronizar ou notificar a transferência recusada.
- **Limites**: não altera o roteamento receptivo, bots, agentes e agendas do sistema. Não redesenha autorização de encaminhamento de mensagens (`forwarding`) ou edição/vínculo cadastral de contatos; esses fluxos continuam com suas próprias regras. A flag não é uma revisão integral de todas as autorizações do produto.

Cadastrar uma única linha `scope='INSTANCE'`, `instance='<tenant>'`, `sectorId=NULL`, `userId=NULL`, `key='start_chats_only_for_loyal_operator'`, `value='true'` após publicar o backend compatível. A ativação é uma alteração de configuração separada do código; não é executada pela compilação ou pelos testes. Para desativar, alterar o valor dessa linha para `false`. Demais tenants permanecem com o padrão anterior.

Validação isolada: `npm run test:manual-chat-authorization` usa os métodos reais com bancos, HTTP e provedores simulados, incluindo recusa sem efeitos, maior `CODIGO`, escopo da flag, transferência e integridade do destinatário.

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
