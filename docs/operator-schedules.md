# Agenda pessoal do operador

`GET /api/whatsapp/schedules/mine` exige sessão autenticada e deriva tenant e usuário dela. A rota recusa `userId` e `sectorId`, mesmo quando coincidem com a sessão. Retornos WhatsApp pendentes explicitamente atribuídos ao usuário aparecem também quando seu setor difere do setor atual da sessão; contatos excluídos ou restritos a administradores continuam protegidos. A leitura não inicia nem encerra atendimentos e não grava snapshots.

`GET /api/whatsapp/schedules/unified` continua atendendo consumidores existentes, incluindo o dashboard administrativo com `perPage=100`. Somente ADMIN pode escolher outro usuário/setor. A rota legada `/api/whatsapp/schedules` também restringe operadores à própria sessão; ADMIN preserva a consulta administrativa. Criação, edição, exclusão e workers não foram alterados.

## Query e resposta

Todos os parâmetros HTTP são strings escalares. Arrays/objetos, campos desconhecidos, enums inválidos, IDs não positivos e excesso de tamanho retornam 400. Listas CSV têm no máximo 100 valores; busca tem no máximo 200 caracteres; página começa em 1, máximo 1.000.000; `perPage` vai de 1 a 100. A interface oferece 10/25/50.

| Parâmetro | Valores/semântica |
|---|---|
| `page`, `perPage` | Padrões 1 e 25; uma página acima do fim é normalizada para a última |
| `channels` | `WHATSAPP,TELEFONIA`; ausência seleciona os canais habilitados |
| `search` | Busca global por contato, telefone, descrição, cliente/fantasia, campanha do cliente, campanha telefônica, origem e labels autorizados de perfil/tags |
| `period` | `all` (padrão), `overdue`, `today`, `next7`, `custom` |
| `scheduledFrom`, `scheduledTo` | Obrigatórios apenas em `custom`; ISO com fuso, normalizado para UTC; início inclusivo e fim exclusivo |
| `sortOrder` | `asc` (padrão) ou `desc`; empate por canal e ID crescentes |
| `customerCampaignIds` | CSV de IDs de campanha do cliente, independente da campanha operacional |
| `repurchaseStatuses` | CSV `green,yellow,red,neutral` |
| `profileLevel`, `interactionLevel`, `purchaseLevel`, `ageLevel`, `purchaseInterestLevel` | Valores do contrato de perfil existente |

Valores do mesmo filtro são OR; grupos são AND. Busca normaliza acentos/caixa e telefone formatado. Todos os predicados são aplicados antes da contagem/paginação. A metadata de campanhas é obtida no conjunto autorizado do canal/período, antes dos filtros comerciais e da busca; filtros que zeram resultados não apagam suas próprias opções.

A resposta mantém `data`, `page`, `pagination` e `filters.customerCampaigns`, acrescentando:

```ts
referenceAt: string; // uma referência ISO para a requisição
timeZone: "America/Sao_Paulo";
warnings: Array<{ code: string; message: string }>;
capabilities: { channels: Array<"WHATSAPP" | "TELEFONIA">; commercial: boolean };
// Em data[].meta, além das identidades existentes:
commercialRestricted?: boolean;
enrichmentUnavailable?: boolean;
```

Hoje usa o dia civil de São Paulo; atrasados são anteriores à referência; próximos sete dias começam na referência e terminam 168 horas depois. `DATETIME` de telefonia é lido por `DATE_FORMAT` e convertido de hora civil de São Paulo para instante, preservando o comportamento do escritor CRM. Valores zero, mês/dia ausentes e calendário inválido são excluídos da fonte de telefonia, com aviso `INVALID_SCHEDULE_DATES` e quantidade no escopo consultado. Não se acrescenta `Z` a uma data civil.

## Responsabilidade e acesso comercial

Na telefonia, a carteira é `campanhas_clientes.OPERADOR`. A finalização grava o executor histórico em `OPERADOR_LIGACAO`, sem transferir a carteira. A rota pessoal seleciona carteira e apresenta `scheduledFor=OPERADOR`, `scheduledBy=OPERADOR_LIGACAO`; `/unified` preserva seu mapeamento antigo por compatibilidade.

Telefonia só é consultada quando `use_old_crm_schedule === "true"` no resolvedor de parâmetros da sessão. Esta entrega não altera flags ou defaults. Um canal explicitamente solicitado e desabilitado produz `CHANNEL_UNAVAILABLE`, sem consulta à fonte; a resposta informa os canais habilitados.

A política comercial acompanha a projeção de `customers-service`: ADMIN possui acesso; operador precisa de `VISUALIZA_COMPRAS='SIM'` explícito e não acessa dados de clientes `BLOCK_COMPRAS='SIM'`. A consulta do operador aceita `ATIVO IS NULL` conforme o autenticador legado e recusa `ATIVO='NAO'`. A permissão é consultada pelo usuário autenticado, mesmo em consulta administrativa. Sem acesso, perfil/recompra são `null`, filtros dependentes retornam 403 e busca ignora labels comerciais ocultos. Clientes bloqueados são excluídos de filtros derivados, inclusive a categoria neutra; não há inferência por contagem. Os SELECTs do cliente projetam somente campos necessários, sem saldos ou potencial financeiro.

Falha ao verificar permissão fecha acesso comercial: consulta básica recebe aviso; filtro dependente recebe erro recuperável. Falha de canal rejeita a requisição inteira. Falha de enriquecimento acessório permite a lista básica com `ENRICHMENT_UNAVAILABLE`; quando busca/filtro depende desse enriquecimento, retorna erro em vez de ignorar o predicado ou produzir um falso total. A rota pessoal usa `Cache-Control: private, no-store`, `Vary: Authorization` e o limitador/deduplicador de leituras existente.

## Custo, limites e observação

- Os candidatos pendentes do usuário são percorridos em lotes de 200; somente IDs elegíveis e opções de campanha são retidos. Não existe corte silencioso do conjunto.
- Sem busca/filtros derivados, perfil e recompra só são enriquecidos para a página final. Busca por labels de perfil ou filtro derivado exige esses dados em lotes antes da paginação.
- Perfis usam leitura em lote de snapshots. Dados ausentes são calculados em agregados de contatos/mensagens/chats, compras e cadastro, sem chamadas por cliente e sem upsert. A regra de atualização dos snapshots existentes permanece igual ao resolvedor original, inclusive overrides manuais.
- Recompra usa um agregado SQL compatível com MySQL 5.5, com predecessor por cliente/data/ID. Mantém o intervalo mínimo de um dia e a média dos intervalos arredondados, inclusive compras no mesmo instante; não transfere o histórico de compras ao Node.
- A página entre WhatsApp e telefonia usa partição binária das duas ordenações; sondagens leem duas linhas, a leitura final recebe no máximo uma página de cada fonte.
- **Ainda há varredura dos candidatos pendentes em cada requisição**, inclusive para metadata/contagem; IDs e `IN` crescem com o conjunto. Agregados SQL também podem examinar histórico no banco. Isto não constitui custo constante nem prova do p95 do ambiente. Não houve DDL/índice novo.
- Não há snapshot distribuído entre consultas/fontes: alterações concorrentes podem mudar contagem/página. Cancelamento HTTP não garante cancelamento SQL. Consultas CRM usam timeout de transporte de 10s; hints `MAX_EXECUTION_TIME(5000)` são aproveitados quando o MySQL os suporta. Não são um limite rígido no MySQL 5.5.
- O log `[operator-schedules]` registra tenant/usuário técnico, canais, contagem, página, duração e tempos de consulta/enriquecimento por fonte; não contém nomes, telefones, busca, descrição ou SQL. Medir essas durações com carga representativa antes de concluir sobre desempenho remoto.

## Validação

`npm run test:operator-schedules` cobre parser, autorização, isolamento, setores, contatos restritos, busca global, filtros, datas, falhas, custo do batch, perfil manual, ordenação/paginação entre fontes e contrato HTTP/cache. Compilar com `node node_modules/typescript/bin/tsc`; não usar o script `build` para ensaio local, pois ele copia `.env`.

Na demanda `INF-20261113-003`, os agregados, a listagem e o adaptador nativo de tenant foram executados também contra MySQL 8.0 e 5.5 descartáveis, com 446 clientes e dados sintéticos. Regressões existentes `test:crm-security`, `test:crm-schedule-sector` e `test:monitor` passaram. As evidências completas ficam no planejamento central, em `artifacts/sql-validation/`. Esses ensaios não representam benchmark p95 da homologação nem navegação autenticada real no ambiente remoto.
