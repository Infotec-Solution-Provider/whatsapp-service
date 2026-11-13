# Agenda pessoal do operador

`GET /api/whatsapp/schedules/mine` exige sessão autenticada e deriva tenant e usuário dela. A rota recusa `userId` e `sectorId`, mesmo quando coincidem com a sessão. Retornos WhatsApp pendentes explicitamente atribuídos ao usuário aparecem também quando seu setor difere do setor atual da sessão; contatos excluídos ou restritos a administradores continuam protegidos. A leitura não inicia nem encerra atendimentos e não grava snapshots.

`GET /api/whatsapp/schedules/unified` continua atendendo consumidores existentes, incluindo o dashboard administrativo com `perPage=100`. Somente ADMIN pode escolher outro usuário/setor. A rota legada `/api/whatsapp/schedules` também restringe operadores à própria sessão; ADMIN preserva a consulta administrativa. Criação, edição, exclusão e workers não foram alterados.

## Query e resposta

Todos os parâmetros HTTP são strings escalares. Arrays/objetos, campos desconhecidos, enums inválidos, IDs fora dos limites e excesso de tamanho retornam 400. Códigos de catálogos CRM e de campanhas aceitam inteiros signed de 32 bits, incluindo zero e negativos; IDs de usuário/setor da consulta administrativa continuam positivos. Listas CSV têm no máximo 100 valores; busca tem no máximo 200 caracteres; página começa em 1, máximo 1.000.000; `perPage` vai de 1 a 100. A interface oferece 10/25/50.

| Parâmetro | Valores/semântica |
|---|---|
| `page`, `perPage` | Padrões 1 e 25; uma página acima do fim é normalizada para a última |
| `channels` | `WHATSAPP,TELEFONIA`; ausência seleciona os canais habilitados |
| `search` | Busca global por contato, telefone, descrição, cliente/fantasia, campanha do cliente, campanha telefônica, origem e labels autorizados de perfil/tags |
| `period` | `all` (padrão), `overdue`, `today`, `next7`, `custom` |
| `scheduledFrom`, `scheduledTo` | Obrigatórios apenas em `custom`; ISO com fuso, normalizado para UTC; início inclusivo e fim exclusivo |
| `sortOrder` | `asc` (padrão) ou `desc`; empate por canal e ID crescentes |
| `view` | A interface atual envia `crm` na rota pessoal; sem esse marcador, mantém o comportamento de abas antigas |
| `customerCampaignIds` | CSV de IDs de campanha do cliente, independente da campanha operacional |
| `repurchaseStatuses` | CSV `green,yellow,red,neutral` |
| `profileLevel`, `interactionLevel`, `purchaseLevel`, `ageLevel`, `purchaseInterestLevel` | Valores do contrato de perfil existente |

Valores do mesmo filtro são OR; grupos são AND. Busca normaliza acentos/caixa e telefone formatado. Todos os predicados são aplicados antes da contagem/paginação. A metadata de campanhas é obtida no conjunto autorizado do canal/período, antes dos filtros comerciais e da busca; filtros que zeram resultados não apagam suas próprias opções.

## Filtros de clientes do CRM

A interface atual substitui classificações automáticas pelos campos de cliente utilizados no CRM. A referência de semântica é `customers-service` homolog `bd41497`, `src/services/customer-search/query.ts`, parser `parseCustomerSearch` e predicados `applyCustomerSearch`, também usados pelo público de disparos por `/customers/search/matches`. A agenda projeta os mesmos predicados em SQL parametrizado, com no máximo 200 IDs candidatos por chamada ao `instances-service`; não consulta outro banco diretamente nem cria contrato ou migração no serviço de clientes.

| Query | Semântica do CRM preservada |
|---|---|
| `purchaseStatus` | `with_purchases` exige alguma compra; `without_purchases` exige ausência de compras em todo o histórico |
| `purchaseFrom`, `purchaseTo` | Datas civis `YYYY-MM-DD`; início inclusivo e fim inclusivo por `< DATE_ADD(dataFinal, 1 dia)`. Datas sem status implicam alguma compra no período. Sem compras + período retorna 400 |
| `registeredFrom`, `registeredTo` | Datas civis inclusivas sobre `clientes.DATACAD`; cadastro não é idade da pessoa |
| `segmentIds`, `groupIds`, `originIds`, `mediaIds`, `unitIds` | CSV sobre SEGMENTO, GRUPO, ORIGEM, COD_MIDIA e COD_UNIDADE, respectivamente |
| `brandIds`, `positionIds` | Relações por EXISTS em clientes_marcas (MARCA) e contatos (CARGO), sem duplicar clientes com várias relações |
| `loyaltyOperatorIds` | EXISTS em campanhas_clientes do cliente, OPERADOR selecionado e `(CONCLUIDO='NAO' OR DT_RESULTADO<'1970-01-01')`; inclui carteira pública zero quando selecionada |
| `states` | CSV de UFs maiúsculas sobre ESTADO |
| `phone` | Trecho com no mínimo três dígitos, normalizando espaço, hífen, parênteses, ponto e `+` nos FONE1/2/3 do cliente; não usa telefone do contato WhatsApp, FAX ou outros telefones |
| `email` | Trecho literal em clientes.EMAIL; não busca em EMAIL2 |
| `CODIGO` | Trecho numérico signed comparado ao código convertido para texto, como no CRUD |
| `CPF_CNPJ` | Igualdade aos dígitos normalizados, sem pesquisa parcial |
| `COD_ERP` | Trecho literal; `%`, `_` e `!` são escapados |
| `CIDADE` | Igualdade, preservando a semântica do CRUD |
| `ATIVO`, `PESSOA` | SIM/NAO e FIS/JUR, respectivamente |

A campanha do cliente permanece no filtro principal `customerCampaignIds`, sem um segundo campo `campaignIds`. Todos os filtros de clientes são AND com os filtros de agenda, e uma seleção múltipla é OR dentro do próprio campo. O parser valida datas, intervalos, documentos, códigos, listas e texto mesmo quando a agenda está vazia. Retornos sem cliente vinculado ou com cliente inexistente não correspondem a um filtro de cliente ativo.

`view=crm` conserva a busca global em cliente/fantasia, contato, telefone, descrição, campanhas e origem, e não calcula nem devolve perfil/recompra automáticos. A rota `/unified`, chamadas pessoais sem `view` e chamadas que ainda enviam predicados automáticos preservam a compatibilidade. Assim, abas anteriores continuam funcionando até serem atualizadas; a nova interface não envia nem oferece esses predicados.

Somente filtros de compras exigem permissão financeira. Os filtros de cadastro, catálogo, fidelização, estado e contato continuam disponíveis sem essa permissão. Compras exigem a política já aplicada pela agenda: ADMIN, ou operador não inativo (inclusive ATIVO NULL legado) com VISUALIZA_COMPRAS=SIM. Para operador, clientes BLOCK_COMPRAS=SIM são excluídos de filtros de presença e ausência de compras, impedindo inferência pelos totais. Falha da consulta de correspondências rejeita o carregamento, sem ampliar o conjunto nem ignorar o predicado.

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
- Em `view=crm`, perfil/recompra não são carregados. Filtros CRM leem somente IDs correspondentes por lote; enriquecimento básico preserva nomes/campanhas/origem. No contrato legado, sem busca/filtros derivados, perfil e recompra só são enriquecidos para a página final; busca por labels de perfil ou filtro derivado exige esses dados antes da paginação.
- Perfis usam leitura em lote de snapshots. Dados ausentes são calculados em agregados de contatos/mensagens/chats, compras e cadastro, sem chamadas por cliente e sem upsert. A regra de atualização dos snapshots existentes permanece igual ao resolvedor original, inclusive overrides manuais.
- Recompra usa um agregado SQL compatível com MySQL 5.5, com predecessor por cliente/data/ID. Mantém o intervalo mínimo de um dia e a média dos intervalos arredondados, inclusive compras no mesmo instante; não transfere o histórico de compras ao Node.
- A página entre WhatsApp e telefonia usa partição binária das duas ordenações; sondagens leem duas linhas, a leitura final recebe no máximo uma página de cada fonte.
- **Ainda há varredura dos candidatos pendentes em cada requisição**, inclusive para metadata/contagem; IDs e `IN` crescem com o conjunto. Agregados SQL também podem examinar histórico no banco. Isto não constitui custo constante nem prova do p95 do ambiente. Não houve DDL/índice novo.
- Não há snapshot distribuído entre consultas/fontes: alterações concorrentes podem mudar contagem/página. Cancelamento HTTP não garante cancelamento SQL. Consultas CRM usam timeout de transporte de 10s; hints `MAX_EXECUTION_TIME(5000)` são aproveitados quando o MySQL os suporta. Não são um limite rígido no MySQL 5.5.
- O log `[operator-schedules]` registra tenant/usuário técnico, canais, contagem, página, duração e tempos de consulta/enriquecimento por fonte; não contém nomes, telefones, busca, descrição ou SQL. Medir essas durações com carga representativa antes de concluir sobre desempenho remoto.

## Validação

`npm run test:operator-schedules` cobre parser, autorização, isolamento, setores, contatos restritos, busca global, filtros, datas, falhas, custo do batch, perfil manual, ordenação/paginação entre fontes e contrato HTTP/cache. Inclui execução SQL em SQLite descartável dos predicados de cliente (adaptando DATE_ADD e a coerção de DATE do MySQL), combinações AND/OR, relações duplicadas, filtros financeiros e códigos zero/negativos. Compilar com `node node_modules/typescript/bin/tsc`; não usar o script `build` para ensaio local, pois ele copia `.env`.

Na demanda `INF-20261113-003`, os agregados, a listagem e o adaptador nativo de tenant foram executados também contra MySQL 8.0 e 5.5 descartáveis, com 446 clientes e dados sintéticos. Regressões existentes `test:crm-security`, `test:crm-schedule-sector` e `test:monitor` passaram. As evidências completas ficam no planejamento central, em `artifacts/sql-validation/`. Esses ensaios não representam benchmark p95 da homologação nem navegação autenticada real no ambiente remoto.

## Publicação em homologação — 13/11/2026

Publicado às 14:55 BRT: quatro módulos JavaScript do backend, compilados em Linux sobre as dependências ativas, preservando os outros 330 módulos e os overlays existentes. Fonte funcional `8806bd7`; controle e backups em `/home/inpulse/operator-schedules-20261113-homolog`. Somente `homolog-whatsapp` e `homolog-frontend` foram operados. Produção permaneceu fora do escopo.

Frontend BUILD `xVD9plKkzhNhL4CkuKdeT`, composto sobre a publicação da engrenagem de telefonia `a88ed4f`, preservada integralmente. A primeira tentativa foi recusada antes da instalação porque a baseline mudou durante a preparação. A segunda foi aplicada sob o lock compartilhado `/home/inpulse/.frontend-homolog-deploy.lock`.

Ativação explicitamente autorizada somente em Suprimaxxi: `homolog-crm-suprimaxxi.wpp_runtime_parameters`, linha `3069662`, escopo INSTANCE, `use_old_crm_schedule=true`, sem setor/usuário. Runtime/P04/autoatendimento não foram ativados. A sessão autenticada confirmou o valor resolvido e a capacidade TELEFONIA.

Smoke autenticado em loopback validou consulta pessoal positiva, páginas, busca, período, isolamento e restrições comerciais; uma consulta administrativa conferiu 446 retornos da carteira real contra SQL, limitada a dez itens. Foram usados clientes/agendas futuros e contas efêmeras exclusivos do teste, com remoção por ID/marcador. Testes de navegador da composição usaram HTTP simulado; não houve navegação autenticada visual remota nem benchmark p95.

Registro central: `planejamento/cross-service/INF-20261113-003-meus-agendamentos/deployment.md`, incluindo recibos e SQL de retorno da única linha de parâmetro. O rollback do código é hash-guarded e exige o mesmo lock; não editar o manifesto congelado `release.json`. Reverter configuração e código requer conferir os recibos, os hashes ativos e eventuais alterações posteriores.
