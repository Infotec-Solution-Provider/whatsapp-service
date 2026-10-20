# Pesquisa de público para disparos

`POST /api/whatsapp/contacts/customer/search` é uma leitura autenticada por JWT.
O tenant vem exclusivamente da sessão. O GET anterior de contatos permanece com
seu contrato e configuração existentes.

## Contrato

O body aceita somente `contactFilters`, `customerFilters` e `pagination`, todos
objetos obrigatórios. Os filtros do contato são `id`, `ids` (até 100), `name`,
`phone`, `hasCustomer` e `sectorIds` (até 100). Valores dentro da mesma seleção
são alternativas; campos diferentes são combinados com AND. `ids:[]` representa
nenhum contato, evitando que um lote manual vazio vire toda a base.

`customerFilters` aceita as chaves atuais de filtros de Clientes, com valores
string/CSV: `CODIGO`, `RAZAO`, `FANTASIA`, `COD_ERP`, `CPF_CNPJ`, `CIDADE`,
`ESTADO`, `ATIVO`, `PESSOA`, `phone`, `email`, `purchaseStatus`, `purchaseFrom`,
`purchaseTo`, `registeredFrom`, `registeredTo`, `campaignIds`, `segmentIds`,
`groupIds`, `originIds`, `mediaIds`, `unitIds`, `brandIds`, `positionIds`,
`loyaltyOperatorIds` e `states`. Paginação, ordenação e `instance` não são filtros
permitidos. O serviço de Clientes valida suas regras antes de qualquer leitura
de contatos, inclusive quando não há candidatos. Filtros de cliente excluem
contatos sem cliente ou sem um cadastro correspondente.

Para a tela, `pagination:{page:1,perPage:20}` aceita até 100 itens e retorna
`{data,pagination:{page,perPage,total,totalPages,hasNext,hasPrev},summary:{total,eligible,blocked,skipped}}`.
O total considera todos os filtros antes da paginação, inclusive para páginas
vazias. Os grupos do resumo são disjuntos: sem dígitos no telefone é `skipped`;
com telefone e bloqueado é `blocked`; os demais são `eligible`. Isso não atesta
consentimento, janela de conversa ou autorização de um provedor para envio.

Para resolução de snapshot, `pagination:{afterId:0,limit:200}` captura o maior ID
atual da sessão e retorna
`{data,pagination:{hasNext,nextCursor,upperId}}`. Havendo próxima página,
enviar `afterId:nextCursor` e o mesmo `upperId`. A ordenação é por ID crescente;
novos contatos acima do limite não entram nessa travessia. O limite por cursor
é 200. O limite de ID não cria uma transação distribuída de leitura: alterações
cadastrais durante a resolução podem afetar os lotes seguintes. O snapshot de
Marketing fixa os membros depois de resolvido.

## Dados e limites

O repositório lê somente `contacts` e `contacts_sectors` da fonte autoritativa,
sempre com `instance` em parâmetros vinculados. No storage central, usa o
transporte raw existente; em `tenant-sql`, usa o mesmo contrato do router nativo,
que reescreve para as tabelas preparadas `wpp_runtime_*` sem engine Prisma.

O cache legado `wpp_contacts`, criado por `local-sync.service.ts`, copia somente
ID, instância, nome, telefone, cliente e exclusão. Ele não contém estado de
bloqueio nem janela de conversa. Por isso `use_local_contacts_sync` não altera
a fonte desse novo POST e não pode declarar elegibilidade a partir desse cache.

O leitor percorre candidatos em lotes de 100. Cada lote envia somente os IDs CRM
candidatos para `POST /api/customers/search/matches`, com o JWT da sessão e o
body `{customerIds,filters}`. A resposta esperada é `{data:Customer[]}`. IDs CRM
signed32, inclusive zero/negativos legados, são preservados. Não há lista global
de IDs, `IN` ilimitado nem truncamento silencioso. A tela mantém em memória
somente sua página e contadores; o cursor mantém até 200 itens.

O novo endpoint tem admissão própria: até 2 pesquisas diferentes simultâneas
por instância/usuário, 4 aguardantes por consulta e 5000 identidades temporárias.
Consultas idênticas compartilham apenas trabalho pendente. Uma desconexão não
libera o slot de trabalho ainda em execução. Não aplica a quota de 30 GETs/10s
à exportação sequencial. Excesso concorrente devolve 429 e `Retry-After`.
Leituras ao serviço de Clientes têm timeout de 15s; a resolução tem prazo de 55s,
verificado entre operações. Falhas intermediárias rejeitam a resposta inteira,
sem devolver total parcial. O cálculo de total da tela percorre os candidatos;
se a base não puder ser percorrida no prazo, o erro fica explícito.

## Validação local

`npx tsc --noEmit --pretty false`

`npx ts-node src/services/contact-audience/audience.test.ts`

`npx ts-node src/services/contact-audience/service.test.ts`

`npx ts-node --files src/controllers/contact-audience.controller.test.ts`

Os testes usam SQLite em memória ou dependências falsas. Cobrem os layouts
central/runtime, mais de 100 candidatos, cursor com novos registros, exclusão,
setores sem duplicação, resumo, filtros inválidos com zero candidatos, página
vazia com total, IDs CRM legados, autenticação, admissão e falhas intermediárias.
Nenhum banco externo, envio real, migração ou alteração de configuração é usado.
