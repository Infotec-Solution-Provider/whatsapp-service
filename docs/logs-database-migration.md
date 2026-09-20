# Banco dedicado de logs

Implementação disponível para `process_logs`: escrita em pool mysql2 dedicado, histórico copiado com checkpoint e conferência, retorno offline e limpeza diária às 19h em America/Sao_Paulo. Implantação e alteração de configuração são etapas separadas; instalar o código mantém `PROCESS_LOG_STORAGE=legacy` por padrão.

## Configuração

Definir `LOGS_DATABASE_URL` no ambiente do serviço e do comando administrativo, sem passá-la como argumento de shell. O destino desta primeira implementação é MySQL 8.x, com banco dedicado previamente criado, por exemplo `inpulse-logs`. Os tenants MySQL 5.5 são tratados por outro adaptador; não são o destino dos logs.

| Variável | Padrão | Regra |
|---|---|---|
| PROCESS_LOG_STORAGE | legacy | dedicated grava somente no banco de logs; falhas nunca voltam automaticamente ao operacional |
| PROCESS_LOG_POOL_SIZE | 2 | De 1 a 10 conexões por processo |
| PROCESS_LOG_MAX_PENDING | 20 | Limite de gravações em andamento/espera; excedentes são descartados com contadores |
| PROCESS_LOG_RETENTION_SUCCESS_DAYS | 7 | 0 conserva sucessos indefinidamente |
| PROCESS_LOG_RETENTION_FAILED_DAYS | 30 | 0 conserva falhas indefinidamente |
| PROCESS_LOG_CLEANUP_ENABLED | false | Habilitar somente depois de validar a migração/política |
| PROCESS_LOG_CLEANUP_CRON | 0 19 * * * | Um horário diário explícito |
| PROCESS_LOG_CLEANUP_TIMEZONE | America/Sao_Paulo | Independente do timezone do servidor |
| PROCESS_LOG_CLEANUP_BATCH_SIZE | 500 | Máximo 2000 linhas por lote |
| PROCESS_LOG_CLEANUP_MAX_BATCHES | 20 | Orçamento total compartilhado por sucesso/falha |
| PROCESS_LOG_CLEANUP_MAX_DURATION_SECONDS | 600 | Até 3600; consultas limitadas também individualmente |

Retenção usa `created_at` UTC preservado na cópia, comparação estrita de data e resultado exato. Status desconhecidos, inclusive variantes com espaços finais, são preservados. Não executa ao iniciar, não recupera horário perdido e registra a janela concluída/iniciada no banco para evitar nova execução por outro processo. Uma falha após iniciar a janela deixa o restante para o dia seguinte.

Os lotes alternam categorias e têm pausa. Logs de auditoria da limpeza vão ao stdout, e falhas de persistência têm diagnóstico limitado no stderr. O logger mantém contadores de salvos/falhos/rejeitados e limites de payload, profundidade e entradas; não armazena filas ilimitadas. Logs são observabilidade, não recibos de entrega: os controles de envio/idempotência permanecem nas tabelas operacionais.

## Sequência de implantação

**Decisão atual: começar sem histórico.** O usuário já executou prepare/copy, mas não activate. Usar o procedimento abaixo no lugar da sequência de cópia/conferência histórica. A sequência antiga permanece documentada somente como alternativa.

### Começar vazio após uma cópia parcial

1. Publicar a versão que inclui a fase `activate-empty` e conferir `npm run logs:migrate -- --help`. Manter `PROCESS_LOG_STORAGE=legacy` e a limpeza desligada até a janela de virada.
2. No destino configurado em `LOGS_DATABASE_URL`, conferir `SELECT state FROM process_log_store WHERE id = 1;`: espera-se COPYING. Conferir origem/destino com `--phase inspect`. Estados ACTIVE, PAUSED e ROLLED_BACK são recusados pelo novo comando; ele não serve para limpar um banco dedicado já em uso.
3. O usuário do migrador precisa também de ALTER **somente na tabela process_logs do destino**, para reservar os próximos IDs acima do histórico que permanecerá na origem. Como administrador, adaptar o host ao mesmo usado no CREATE USER:

```sql
GRANT ALTER ON `inpulse-logs`.`process_logs`
  TO 'inpulse_logs'@'APP_SERVER_IP';
```

4. Na janela de manutenção, parar e drenar TODOS os gravadores e interromper qualquer comando de cópia em andamento. Executar, com as URLs de origem/destino corretas:

```bash
npm run logs:migrate -- --phase activate-empty --writers-quiesced --discard-copied-history --batch-size 500
```

O comando exclui **apenas process_logs do destino preparado**, em lotes, conservando integralmente os registros da origem. Exige origem registrada correspondente e lock de manutenção; usa RESETTING durante a limpeza para impedir retomada acidental da cópia. A permissão ALTER é exercitada antes da primeira exclusão. Não usa TRUNCATE nem reinicia IDs em 1, pois isso causaria colisões em um eventual retorno.

Se retornar `complete:false`, repetir exatamente o comando, mantendo os gravadores parados. Só seguir quando retornar `complete:true` e `activated:true`. A sequência de IDs começa acima da origem, embora a tabela esteja vazia. O processo também funciona com uma tabela preparada ainda vazia. Não executar copy, verify ou activate tradicionais depois desta decisão, pois eles exigem/conferem histórico.

5. Iniciar TODOS os gravadores com `PROCESS_LOG_STORAGE=dedicated` e `PROCESS_LOG_CLEANUP_ENABLED=false`. Conferir logs novos e então habilitar a limpeza diária conforme a política escolhida. O histórico antigo continua no banco operacional; eventual retirada dele é uma etapa separada.

6. Em caso de erro ou resposta perdida, conferir estado e presença de linhas antes de agir. RESETTING permite retomar o mesmo comando; ACTIVE já concluiu a ativação e não deve ser limpo novamente. Nunca alterar o marcador manualmente para contornar a recusa. O comando rollback documentado adiante também suporta a ativação sem histórico e devolve apenas os novos registros ausentes na origem.

### Alternativa: conservar o histórico no destino

Telemetria foi adiada pelo usuário e não participa desta implantação. Não remover suas tabelas. A fundação transacional do instances-service ainda não está conectada aos domínios operacionais e não precisa ser ativada para separar os logs.

É possível publicar primeiro o código com `PROCESS_LOG_STORAGE=legacy` e `PROCESS_LOG_CLEANUP_ENABLED=false`. Isso conserva o destino atual; os limites/sanitização do novo logger já se aplicam. A ativação dedicada só deve ocorrer depois do ensaio com backup restaurado e volume representativo. Falhas/saturação da gravação de logs são contabilizadas e podem descartar eventos; não há spool durável de logs.

No processo de build do whatsapp-service, instalar as dependências do lockfile (`npm ci`), gerar o cliente (`npx prisma generate`) e compilar (`npx tsc`). Não usar `prisma migrate deploy`, `db push` ou reset para esta mudança de logs. Publicar o artefato completo, incluindo `dist/logs`, `dist/database` e `dist/scripts/migrate-logs.js`. A configuração/arquivos do processo real devem ser mantidos pelo mecanismo existente de deploy; não substituir ambientes pelo `.env.example`.

Confirmar no PM2 o nome, script, cwd e todas as réplicas/hosts que gravam logs. Em Linux, configurar `kill_timeout: 45000` antes da parada: o shutdown atual pode esperar até 30s pelos workers, 5s pelos logs e 1s pelo diagnóstico. O PM2 pode enviar SIGKILL se seu prazo for menor ([documentação](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/)). Isso não garante que todo trabalho pendente finalize; conferir a drenagem no ensaio. Na virada, fazer stop completo dos gravadores, evitando sobreposição de versões legacy/dedicated.

O destino é um banco vazio MySQL 8.x, com espaço para histórico + índices/backup. Um administrador pode provisionar:

```sql
CREATE DATABASE `inpulse-logs`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Provisionar usuário próprio: a preparação precisa CREATE/SELECT/INSERT/UPDATE no destino; a limpeza também DELETE. A cópia exige SELECT na origem e o retorno exige INSERT nela. Restringir por schema/host. Configurar `LOGS_DATABASE_URL` sem registrar credenciais em comandos ou relatórios. Separar schemas no mesmo servidor não isola CPU/disco; a origem será mantida até o fim da janela de retorno.

1. Confirmar checkout/cwd do serviço implantado, bancos de origem/destino e backup restaurável. Provisionar destino vazio e usuário próprio. Definir a URL sem expor credenciais. Instalar esta versão com modo legacy em todos os gravadores e limpeza desligada.
2. No diretório do serviço, conferir identidades e preparar:

```bash
npm run logs:migrate -- --phase inspect
npm run logs:migrate -- --phase prepare
npm run logs:migrate -- --phase copy
```

O comando usa `WHATSAPP_DATABASE_URL` como origem e `LOGS_DATABASE_URL` como destino. Carrega `.env` do cwd pelo dotenv; conferir especialmente instalações PM2 que usam `dist/.env`. Em instalação somente compilada, usar `node dist/scripts/migrate-logs.js` com os mesmos argumentos e ambiente.

Preparação só aceita destino dedicado e MySQL 8.x, cria três tabelas gerenciadas e o estado COPYING. Não cria bancos, não modifica o schema Prisma operacional e não executa DDL no startup. O lock de manutenção é compartilhado com a limpeza.

A cópia pode ser repetida para retomar. O padrão lê até 100 registros e 4 MiB de payload por lote, até 1000 lotes por chamada. Checkpoint e gravações são confirmados na mesma transação no destino. `complete:false` exige outra chamada. Ajustar limites com `--batch-size`, `--max-batches`, `--max-bytes`; um registro maior que o limite interrompe a cópia, sem truncamento. O histórico copiado não é sanitizado/reformatado, para preservar evidências; restringir o acesso ao destino como à origem.

3. Na janela de manutenção, parar e drenar TODOS os processos que gravam logs na origem. Nesta versão, a virada é **offline**: os argumentos abaixo atestam uma condição operacional, não desligam/fiscalizam os processos. Não usar somente a pausa da limpeza ou presumir que um único PM2 representa todos os gravadores. Coordenar recebimentos/filas durante essa parada.
4. Fazer uma varredura final completa, incluindo IDs antigos que podem ter sido confirmados depois do cursor anterior:

```bash
npm run logs:migrate -- --phase copy --full
```

Se retornar `complete:false`, continuar com `--phase copy` **sem** `--full`, mantendo todos os gravadores parados. Depois:

```bash
npm run logs:migrate -- --phase verify --source-quiesced --max-batches 10000
npm run logs:migrate -- --phase cleanup-preview
npm run logs:migrate -- --phase activate --source-quiesced --max-batches 10000
```

`verify` compara todos os campos e o conjunto de IDs, detectando registros extras/divergentes; `activate` repete essa conferência antes de liberar escrita. Se o limite de lotes da conferência for insuficiente, aumentar `--max-batches` e repetir a verificação inteira. Prévia de limpeza é limitada e retorna `limited:true` quando os resultados são apenas parte dos candidatos.

Os exemplos usam 10.000 lotes na conferência porque o padrão de 1.000 x 100 registros é inferior às aproximadamente 349 mil linhas estimadas no inventário. O limite de bytes pode diminuir os registros por lote; não assumir que 10.000 lotes sempre bastam. A cópia `--full` final mais as duas conferências percorrem o histórico durante a parada. Medir esse tempo no ensaio; a pré-cópia online não assegura uma virada curta. Só continuar após cada comando concluir com sucesso; `complete:false` não autoriza ativação.

5. Iniciar TODOS os gravadores com `PROCESS_LOG_STORAGE=dedicated`. Não manter processos legacy vivos. O writer dedicado recusa inserções enquanto o destino não está ACTIVE. Atualizar consumidores SQL externos para o novo banco; a busca estática encontrou o escritor em ProcessingLogger, mas não comprova ausência de leitores fora deste checkout.
6. Validar novos logs, isolamento, métricas e erros. Habilitar `PROCESS_LOG_CLEANUP_ENABLED=true` no ambiente efetivo e recarregar o processo responsável. Aguardar a janela diária; não há comando de exclusão imediata disponível no CLI.
7. Conservar origem durante a janela de retorno. A ferramenta não apaga a tabela nem os registros de origem. A retirada definitiva é uma operação posterior, após os consumidores terem sido conferidos.

Ao alterar flags, atualizar o ambiente realmente usado pelo processo. Variáveis já injetadas pelo PM2 têm precedência sobre dotenv; editar um `.env` diferente do cwd não surte efeito. Para variáveis do ambiente de lançamento usar restart com `--update-env`, ou reaplicar a declaração do ecosystem conforme a instalação ([PM2](https://pm2.keymetrics.io/docs/usage/process-management/)). Não usar dumps completos do ambiente para compartilhar diagnóstico.

Após ativação, conferir estado e registros recentes no destino, sem consultar payloads:

```sql
SELECT schema_version, state, last_cleanup_slot FROM process_log_store WHERE id = 1;
SELECT id, status, created_at FROM process_logs ORDER BY id DESC LIMIT 10;
```

Confirmar novas gravações originadas por um fluxo controlado, ausência de falhas/rejeições do componente `process-logs`, estabilidade das filas e latência do atendimento. Só depois habilitar a limpeza. Sucesso 7 dias/falha 30 dias são valores iniciais configuráveis, `0` conserva indefinidamente; revisar a prévia com a política escolhida. Às 19h America/Sao_Paulo, conferir `process-log-cleanup` no stdout. Não há execução compensatória no startup.

## Retorno

Parar e drenar gravadores de ambos os destinos. Não reativar legacy antes de reconciliar os logs novos:

```bash
npm run logs:migrate -- --phase rollback --writers-quiesced
```

O comando bloqueia novas escritas dedicadas com estado PAUSED, compara registros de mesmo ID e insere no operacional apenas os ausentes. Conflito de conteúdo interrompe o retorno, sem sobrescrever registros. Há checkpoint; repetir até `complete:true`. A origem pode conservar histórico já expirado no destino. Depois de concluído, destino fica ROLLED_BACK e somente os gravadores legacy podem ser reiniciados. Reativação futura exige uma nova migração planejada; não há reset automático de estados.

## Tenants: funcionalidades disponíveis e limites

```bash
npm run tenant:migrate -- --tenant NOME --phase inspect
npm run tenant:migrate -- --tenant NOME --phase probe
```

Usar `INSTANCES_DATABASE_URL` para resolver `clients_servers` ou `TENANT_DATABASE_URL` para um destino direto. No segundo caso o nome informado é apenas o rótulo do relatório: conferir a identidade retornada. Nenhuma credencial é impressa.

`inspect` lê metadados; `probe` cria uma tabela temporária privada da conexão com dados sintéticos e confere texto e bytes UTF-8, sem alterar tabelas do ERP. Testado em MySQL 5.5.62 com default latin1 e conexão utf8mb4. Não usar o novo codec em campos legados sem identificar seu perfil: vazio/NULL são preservados, escapes inválidos interrompem a conversão e não se aplica decode automaticamente a `%20` nativo.

Conexões novas usam UTC e modo estrito de sessão para impedir truncamento silencioso. Valores são enviados como parâmetros preparados, testados também com NO_BACKSLASH_ESCAPES. Isso não modifica os defaults globais, as tabelas existentes ou os pools legados do instances-service.

O CLI de tenants não oferece prepare/copy/cutover de dados de negócio ainda. Repositórios transacionais, compatibilidade completa dos índices, captura de alterações, roteamento de APIs/jobs e consumidores dos demais serviços permanecem etapas do plano. Não interpretar o sucesso do probe como migração concluída ou elegibilidade de todo o domínio.

## Validação local

`npm run test:log-storage` e TypeScript. Testes reais opt-in: `RUN_MIGRATION_MYSQL_TESTS=true npm run test:log-storage:mysql`, com MySQL descartáveis em 127.0.0.1:13318 (8.x) e 127.0.0.1:13355 (5.5), root sem senha somente nesses containers locais. O teste cria bancos com prefixo migration_test e remove apenas esses bancos. Não apontar os testes para produção.
