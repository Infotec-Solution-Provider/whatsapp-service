# Resolução de cliente no Message Flow

`QUERY` aceita `{ "operation": "resolveContactCustomer", "storeAs": "customerResolution" }`. A operação não recebe usuário de destino: a etapa seguinte do fluxo decide a atribuição a partir de `customerResolution.status`. Não há novo enum nem migration.

O leitor genérico recebe o tenant e setor do fluxo, valida a propriedade do setor e relê o contato por tenant/ID. Contatos com vínculo positivo preservam o vínculo e dispensam consulta ao CRM. Os demais só podem ser vinculados quando o valor atual é `NULL`, `0` ou `-1`.

Uma consulta parametrizada reúne os IDs de `clientes` e `contatos`; `DISTINCT` ocorre antes de `LIMIT 2`. Consulta e normalização usam apenas recursos existentes no MySQL 5.5. São aceitos telefone completo brasileiro, DDI, DDD e variações móveis com/sem nono dígito. Não há comparação por sufixo. As duas fontes precisam concluir para classificar `found` ou `not_found`; falha de schema/conexão/consulta gera `unavailable`.

A fonte `contatos` exige que `CLIENTE` exista em `clientes`; IDs órfãos não são candidatos. O adaptador limita a chamada HTTP da consulta e da sincronização a 3000 ms por operação. `InstancesClient.executeQuery` aceita uma quarta opção `{ timeoutMs }`, validada entre 1 e 60000 ms; chamadas existentes mantêm o padrão de 60000 ms. O timeout aborta a requisição Axios. Isso não garante cancelar a consulta que o `instances-service` já iniciou no MySQL remoto.

Estados: `found` com `customerId`, `not_found`, `ambiguous` e `unavailable`. O vínculo é aplicado com CAS do valor anterior, endereço e estado ativo, seguido de releitura. Um vínculo manual concorrente prevalece. O nome do contato não é alterado. A sincronização existente para `wpp_contacts` é chamada após o vínculo; falha mantém o vínculo central e produz `found` com `reason=sync_pending`. O log registra IDs, motivo e duração, sem telefone, nome ou texto de mensagem. Esse motivo permite distinguir a necessidade de reparo do espelho; esta mudança não cria uma fila de reparo.

Executar somente para a decisão de criação do atendimento, pela configuração do fluxo. A resolução não deve ser chamada em toda mensagem de um atendimento aberto. `storeAs` deve ser chave simples e livre, fora das propriedades reservadas do contexto.

Validação local:

```powershell
.\node_modules\.bin\ts-node.cmd src/services/contact-customer-resolution.test.ts
.\node_modules\.bin\ts-node.cmd src/message-flow/base/query-customer-resolution.test.ts
.\node_modules\.bin\ts-node.cmd src/services/contact-customer-resolution.mysql.test.ts
.\node_modules\.bin\ts-node.cmd src/sdk-local/instance-query-timeout.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
```

O teste MySQL usa exclusivamente endpoints QA fixos `127.0.0.1:13455` (CRM) e `127.0.0.1:13418` (central), com schema `odim_flow_crm_qa_20261113_resolution`. Não lê configuração da aplicação. Ele cria fixtures e verifica os quatro estados, deduplicação entre fontes, falha de uma fonte, CAS com duas conexões e preservação de mudança manual de vínculo/endereço. QA CRM MySQL 5.5.62 e central 8.0.46; a produção CRM usa 5.5.0-m2, portanto a compatibilidade não foi demonstrada na versão exata. A fixture funcional não constitui benchmark representativo do volume de produção.
