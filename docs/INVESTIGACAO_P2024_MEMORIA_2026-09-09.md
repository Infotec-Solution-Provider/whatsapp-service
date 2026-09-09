# Investigação de P2024 e crescimento de memória — 09/09/2026

O incidente afeta o recurso compartilhado pelo backend: requisições HTTP e workers usam o mesmo `PrismaClient` e seu pool, independentemente do cliente/tenant ou da tabela. Foram encontrados e corrigidos defeitos que amplificam a pressão sobre esse recurso. A origem do primeiro timeout e a composição dos 9 GiB ainda dependem de uma captura durante a falha.

## Evidência disponível

| Evidência | Interpretação e limite |
| --- | --- |
| P2024 em `wppContact.findFirst` e `internalChat.findUnique`, pool de 17 e timeout de 10 s | Consultas distintas falham ao obter conexão. O nome da tabela identifica a operação que esperou, não necessariamente a operação que ocupou o pool. |
| Relato de falha em todos os clientes e consumo de 9 GiB no PM2 | Impacto compartilhado; consumo no momento do incidente informado pelo operador. Não há perfil de memória daquele momento. |
| Após reinício: MySQL `max_connections=512`, `Max_used_connections=61`, `Threads_connected=34`, `Threads_running=2` | Essa fotografia não prova o estado do pool, de locks ou de consultas antes do reinício. O limite global do MySQL é diferente do limite do pool da aplicação. |
| Após reinício: 11 conexões do usuário `whatsapp` em `Sleep` | Conexões ociosas são compatíveis com pooling; não demonstram vazamento. Resultado de `innodb_trx` não foi fornecido. |
| PM2: um processo `whatsapp` em fork, uptime de 6 min, 52 reinícios acumulados, aproximadamente 3,1 GB | Não são 52 reinícios em seis minutos. A lista fornecida não mostra cluster desse serviço. |
| Na mesma coleta PM2: heap usado 53,6 MiB, heap total 85,7 MiB, latência HTTP p95 de 10.016,75 ms | A proximidade com o timeout de 10 s é compatível com espera pelo pool, mas não correlaciona uma requisição específica. Memória residente e heap são medidas diferentes. |
| Revisão local `f6410e3`, também presente nos metadados Git do PM2 | Permite comparar o código apontado pelo PM2; não comprova que os arquivos `dist` executados correspondem byte a byte a essa revisão. |

O Prisma enfileira consultas quando não consegue reservar uma conexão; `P2024` indica que o tempo de espera foi excedido. [Documentação do pool no Prisma 6](https://www.prisma.io/docs/orm/v6/prisma-client/setup-and-configuration/databases-connections/connection-pool).

## Defeitos corrigidos localmente

### 1. Lotes sobrepostos durante falha de banco

Na revisão inicialmente investigada, em [remote-inbound-event-inbox.service.ts](../src/services/remote-inbound-event-inbox.service.ts) e no então existente `pipeline-enrollment-outbox.service.ts`, cada lote admitia até 20 tarefas com `Promise.all`. Uma falha no claim, na leitura ou na gravação do retry podia rejeitar essa promessa imediatamente. O `finally` liberava a flag `processing`, embora outras tarefas do lote ainda estivessem executando.

O próximo tick admitia outro lote. Em uma reprodução controlada dos métodos anteriores, três lotes com um claim falhando e 19 tarefas bloqueadas cada deixaram **57 tarefas ainda ativas por worker**, com a flag de processamento liberada. Isso demonstra amplificação durante falhas; não reproduz a carga nem os 9 GiB de produção.

Correção mantida no inbound remoto: aguardar `Promise.allSettled` antes de liberar o lote, reportar a falha após concluir as demais tarefas e selecionar apenas os IDs dos candidatos. A concorrência padrão é **4**, configurável por `REMOTE_INBOUND_EVENT_CONCURRENCY`, com teto de 8 e fallback seguro para valores inválidos. O trabalho excedente permanece na fila persistida. Claims, leases e regras de retry foram preservados. O worker de pipeline recebeu essa correção inicialmente e foi posteriormente desativado junto com seus produtores, conforme item 5.

Há impacto possível na vazão de processamento em segundo plano: reduzir a concorrência pode aumentar a idade da fila sob carga. É necessário acompanhar backlog e latência junto com P2024. Esses limites são locais a cada processo e não reservam conexões exclusivas para HTTP.

### 2. Consulta recente materializava históricos para identificar participação

O commit `464338f`, de **08/09/2026 às 11:47:55 -03:00**, introduziu a consulta de enriquecimento de nomes em [message-mentions.service.ts](../src/services/message-mentions.service.ts). Para saber em quais conversas um remetente participou, ela selecionava sua relação histórica de mensagens e aplicava `distinct` por conversa, sem limite histórico. O lote de 500 mensagens de entrada não limitava essa leitura histórica.

No Prisma 6, esse `distinct` é processado em memória após a leitura. O engine 6.15.0 implementa essa deduplicação em Rust, portanto uma resposta final pequena não descarta alocações grandes fora do heap JavaScript. [Documentação de `distinct`](https://www.prisma.io/docs/orm/v6/prisma-client/queries/aggregation-grouping-summarizing#distinct-under-the-hood), [implementação do engine 6.15.0](https://github.com/prisma/prisma-engines/blob/6.15.0/query-engine/core/src/interpreter/query_interpreters/inmemory_record_processor.rs#L19).

Correção: buscar os metadados dos remetentes e agrupar no banco os pares `whatsappSenderId/internalChatId`, preservando os filtros de tenant e conversas e a prioridade dos nomes. O teste com 10.000 registros históricos duplicados verifica que o serviço pede e usa somente dois pares válidos. Trata-se de teste com banco simulado, não de medição de desempenho do MySQL. O agrupamento ainda pode examinar histórico no banco; o ganho garantido pela mudança é evitar transportar e materializar todas essas linhas no processo para deduplicá-las.

Essa alteração recente é um candidato relevante à regressão relatada. Ainda não há correlação de uma execução dessa consulta com o pico de produção.

### 3. Rejeições não tratadas em workers WABA/Gupshup

Em [waba-webhook-queue.service.ts](../src/services/waba-webhook-queue.service.ts) e [gupshup-webhook-queue.service.ts](../src/services/gupshup-webhook-queue.service.ts), o loop disparava `processItem(...).finally(...)` sem observar rejeições. Uma falha no claim, antes do tratamento interno, ou na gravação do retry escapava como `unhandledRejection`. O teste executado contra o código original reproduziu esse evento com um P2024 simulado no claim WABA. Não foi estabelecida correlação com os reinícios informados pelo PM2.

Correção: observar e registrar essas falhas antes de liberar o contador da tarefa. A promessa do loop também é observada, incluindo falha no reset final do Gupshup. Não foram alterados claims ou decisões de retry/reenvio. Cinco cenários verificam tratamento da rejeição, contador ocupado enquanto a gravação está pendente, liberação ao terminar e ausência de novo envio introduzido pelo tratamento.

### 4. Telemetria de performance removida por solicitação do operador

Após a investigação, foi solicitada a remoção do registro de ações do frontend. Foram excluídas as rotas `POST /api/whatsapp/frontend-performance/batches`, `GET /api/whatsapp/frontend-performance/summary` e `GET /api/whatsapp/frontend-performance/export.csv`, junto com o serviço de gravação/consulta, rate limiter, flag padrão e rotina de retenção. O módulo deixou de ser importado ou iniciado pelo backend.

No repositório `inpulse-frontend`, foram removidos o coletor, provider, hooks, observers, timers e instrumentação de ações/renderização, Axios, sockets e upload. Não há emissor ou chamada residual para essas rotas no código de aplicação. A retirada elimina o trabalho desse fluxo; não comprova que ele era a causa original do P2024.

Os dados históricos e migrations não foram alterados. Os relatórios de produtividade dos operadores são independentes e continuam disponíveis. Publicar os dois repositórios e recarregar as abas abertas é necessário para cessar as chamadas dos navegadores: uma aba com o bundle antigo pode continuar enviando lotes e receber 404 enquanto não for atualizada.

### 5. Fluxo `pipeline_enrollment_outbox` desativado por solicitação do operador

Foi removida a integração que inscrevia clientes automaticamente em funis após o envio de mensagens prontas/templates. O worker deixou de ser iniciado e seu código foi retirado, encerrando polling, recuperação de leases, retries e chamadas a `/api/internal/marketing/pipeline-events` por este backend.

Também foram removidas as gravações na outbox de [messages.service.ts](../src/services/messages.service.ts) e [operator-send.service.ts](../src/services/operator-send.service.ts), inclusive o callback que consumia `pipelineSource` de envios antigos. Criar/atualizar mensagens não abre mais uma transação ou busca `customerId` para essa integração. [whatsapp.service.ts](../src/services/whatsapp.service.ts) deixou de criar e transmitir a origem do gatilho.

Validações de mensagem pronta/template, hash de idempotência, persistência da mensagem, menções, sincronização local e notificações permanecem. A tabela, migrations, registros pendentes e históricos não foram apagados; os pendentes dessa outbox deixam de ser consumidos. Funis e seus registros existentes no marketing não foram alterados. A mudança requer publicar o backend recompilado e reiniciar seu processo; não depende de uma flag em produção.

## Outros caminhos de pressão encontrados

| Caminho | Problema observável no código | Situação |
| --- | --- | --- |
| `monitor.service.ts`, última mensagem por contato | `findMany` com `distinct: ["contactId"]`, todas as colunas e histórico sem limite para obter a última mensagem | Antigo; último commit no arquivo em julho. Candidato a alto uso de memória/consulta; exige otimização que preserve ordenação e contrato do monitor. |
| `internal-chats.service.ts`, `getInternalChatsMonitor` | Inclui históricos inteiros em chamadas nas quais alguns consumidores só usam os chats | Antigo; separar resumo de histórico é uma próxima otimização. Não foi truncada a resposta pública nesta correção. |
| `processing-logger.ts` | Gravações disparadas sem aguardar, com entrada, saída e erro completos, usando o mesmo pool | Pode amplificar fila e retenção de payloads durante falha; quantidade e bytes em produção não medidos. |
| `main.ts`, `multer.middleware.ts`, `files.client.ts` | Limites de corpo/upload de até 2 GB e arquivos inteiros em buffers | Antigo; não há evidência de upload grande no incidente de texto simples. |
| `utils/message-queue.ts`, cliente WWEBJS local | Fila em memória sem teto global; uma falha de banco dentro do tratamento de erro pode interromper o runner antes de concluir a promessa do item | Depende de sessões locais desse tipo. Prioridade seguinte se elas estiverem ativas no processo afetado. |
| `wwebjs-whatsapp-client.ts` | Eventos `ready` criam timers, incluindo um intervalo sem handle para cancelar em `destroy` | Retenção de instâncias possível; antigo e restrito ao cliente WWEBJS local. |
| `waba-whatsapp-client.ts` | Opções Axios de envio sem timeout explícito | Espera externa pode reter requisições/payloads. Não foi encontrada transação Prisma mantida durante essa espera. |

RSS inclui memória nativa e não equivale ao heap JavaScript. O Node também documenta crescimento de RSS com heap estável por fragmentação do alocador em Linux. Portanto, os números após reinício não permitem concluir que houve vazamento de objetos JavaScript ou atribuir os 9 GiB a um único caminho. [Documentação de memória do Node](https://nodejs.org/api/process.html#processmemoryusage).

## Hipóteses verificadas sem confirmação

- O backend possui um singleton Prisma em `prisma.service.ts`; não foi encontrado um novo cliente por requisição ou tenant.
- Nos callbacks de transações auditados, as operações usam o cliente transacional. Não foi encontrada chamada HTTP aguardada dentro da transação nem uso do cliente global causando espera recursiva pelo mesmo pool.
- A autenticação chama o serviço de usuários e pode adicionar latência, mas não mantém conexão do Prisma WhatsApp ocupada durante essa chamada.
- A refatoração recente de status interno reorganiza operações existentes; não apareceu uma multiplicação equivalente à encontrada nos workers.
- As evidências atuais não atribuem esse incidente ao frontend ou ao antigo polling de `message-attempts`.

## Captura durante o incidente

### Ajuste inicial com base no ambiente de produção informado

O ambiente informado usa `WABA_WEBHOOK_MAX_CONCURRENT=10` e `WABA_WEBHOOK_QUEUE_POLL_INTERVAL=100`. A URL do Prisma não fixa `connection_limit`/`pool_timeout`; os erros fornecidos mostram os valores efetivos de 17 conexões e 10 segundos. A proposta inicial é reduzir a concorrência, mantendo o pool e os intervalos, e acompanhar P2024, RSS e idade/crescimento das filas:

```dotenv
WABA_WEBHOOK_QUEUE_POLL_INTERVAL=100
WABA_WEBHOOK_MAX_CONCURRENT=4
GUPSHUP_WEBHOOK_MAX_CONCURRENT=2
REMOTE_INBOUND_EVENT_CONCURRENCY=2
OPERATOR_OUTBOUND_CONCURRENCY=2
```

O WABA admite um item por ciclo. Aumentar o intervalo para 500/1.000 ms limitaria a admissão global a aproximadamente 2/1 item por segundo, antes de considerar o tempo das consultas. Cada item pode conter vários eventos. O ajuste de concorrência também pode aumentar o backlog; é uma configuração inicial de contenção, não garantia de vazão. O limite do inbox requer publicar a versão corrigida do backend.

Persistir esses valores na configuração usada pelo ambiente. Se o PM2 já tiver variáveis injetadas, editar apenas `.env` pode ser insuficiente, pois o dotenv preserva valores existentes. Após publicar e compilar o backend, o seguinte comando aplica explicitamente as cinco chaves não sensíveis ao processo 13 e o reinicia:

```bash
WABA_WEBHOOK_QUEUE_POLL_INTERVAL=100 \
WABA_WEBHOOK_MAX_CONCURRENT=4 \
GUPSHUP_WEBHOOK_MAX_CONCURRENT=2 \
REMOTE_INBOUND_EVENT_CONCURRENCY=2 \
OPERATOR_OUTBOUND_CONCURRENCY=2 \
pm2 restart 13 --update-env
```

O comando não foi executado nesta investigação. `--update-env` atualiza variáveis recebidas pelo PM2; não carrega um arquivo `.env` por si só. [PM2](https://pm2.keymetrics.io/docs/usage/process-management/#updating-environment-variables-and-options), [dotenv](https://github.com/motdotla/dotenv#what-happens-to-environment-variables-that-were-already-set).

### Coletor

Foi incluído [capture-resource-incident.cjs](../scripts/capture-resource-incident.cjs). Executar como o proprietário do PM2, na raiz do backend em produção, **antes de reiniciar o WhatsApp**:

```bash
node scripts/capture-resource-incident.cjs --pm2-id 13 --samples 12 --interval-ms 5000 --db > /tmp/whatsapp-resource-incident-$(date +%Y%m%d-%H%M%S).jsonl
```

O coletor só lê PM2, `/proc` e metadados MySQL. `--db` abre uma conexão adicional, com timeout de conexão/consulta de 3 s. Usa a configuração do processo PM2 e depois seus arquivos `.env`, sem imprimir URL, senha, tokens, ambiente bruto, conteúdo de mensagens, SQL das sessões ou erros brutos. O JSONL contém horários, PID/reinícios, RSS/heap/event loop, memória/swap do servidor, identidade do MySQL, status, processos e transações visíveis à conta configurada.

Permissões insuficientes são reportadas. O intervalo de 5 s começa após cada amostra, não é uma cadência exata. Se o PID mudar, a conexão de diagnóstico é encerrada e deve-se repetir a coleta. O coletor aceita uma única ocorrência de `sslmode=disable`, sem TLS, como na configuração informada. Outros parâmetros SSL/TLS e socket Unix são rejeitados. Não há heap dump nem reinício automático.

## Validação e publicação

- Regressões de concorrência mantidas para inbound remoto: falhas em claim, leitura e gravação de retry; ausência de sobreposição, conclusão das tarefas restantes e excedente preservado no banco. Os testes do worker de pipeline foram substituídos pelos de desativação.
- Suíte existente de inbound remoto aprovada. Quatro cenários de desativação da outbox aprovados, com persistência/sincronização de mensagens, payload antigo de operador e envio de mensagem pronta sem acesso à outbox.
- Suíte de menções aprovada, incluindo identidade PN/LID, isolamento de tenant/conversa, fallback de banco e fluxo de edição/socket.
- Regressões WABA/Gupshup aprovadas, incluindo falhas no claim, gravação do retry e reset final.
- Coletor: ajuda, sintaxe e oito testes locais aprovados; a execução Linux/PM2/MySQL ainda não foi exercitada neste ambiente Windows.
- Após remoção da telemetria: 83 testes e build de produção do frontend aprovados, incluindo TypeScript; backend TypeScript e teste de parâmetros aprovados. Busca no código e nos bundles `.next/static`/`.next/server` não encontrou referências ao coletor ou suas rotas.

Comandos de validação local:

```bash
npm run test:resource-pressure
npm run test:remote-inbound
npm run test:pipeline-events
npm run test:mentions
npx tsc --noEmit
git diff --check
```

As alterações estão no checkout local. Não houve publicação, reinício, alteração do pool, migração, modificação de dados em produção ou validação de entrega com o provedor. Após publicação pelo procedimento do ambiente, comparar P2024, p95 de envio, crescimento do RSS e idade/vazão das filas durante um período representativo de uso. O incidente só pode ser dado como resolvido após essa validação operacional.
