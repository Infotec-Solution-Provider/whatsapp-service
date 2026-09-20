# Coleta automática de incidentes do banco

## Medição de operações Prisma

A medição está ativa por padrão no cliente Prisma compartilhado. `DATABASE_OPERATION_METRICS=false` a desabilita; `DATABASE_SLOW_OPERATION_MS` define o limiar de operação lenta (padrão: 1000 ms). Não há novas consultas de diagnóstico ao banco. O listener de erros permanece no cliente base e a extensão encaminha a operação original, preservando sua transação.

Operações lentas ou com erro geram `[database-operation]` no stderr do PM2, no máximo uma linha a cada cinco segundos por processo. `suppressed` conta as observações omitidas desde a última linha; todas continuam contribuindo para os agregados. O registro contém modelo/ação, duração, código Prisma quando disponível, quantidade de itens do array retornado e operações em andamento. Não inclui SQL, argumentos, destinatários, conteúdo, resultados ou texto do erro.

Cada novo JSONL de incidente inclui `databaseOperations` no registro `trigger`:

- `active`: até 20 operações acompanhadas com maior tempo decorrido, ainda sem terminar na hora do erro.
- `operations`: até 20 grupos por modelo/ação, ordenados por operações em andamento e duração acumulada; contagens, falhas, lentas, duração total/máxima, pico de concorrência e maior quantidade de itens retornados. Os agregados são cumulativos desde o início do processo e durações simultâneas se sobrepõem.
- `recent`: últimas 20 operações lentas ou com erro, incluindo código e tamanho do array, quando disponíveis.
- `inFlight`: quantidade de operações Prisma em andamento, incluindo espera no pool. Não representa conexões ocupadas nem threads MySQL.
- `untrackedInFlight`: operações além do limite de 256 acompanhamentos individuais. Continuam nos contadores; seus tempos individuais não aparecem em `active`. São mantidos no máximo 128 grupos; excedentes entram em `other`.

As durações são observadas pela aplicação: incluem espera por conexão, execução, transferência, processamento do resultado e atrasos do event loop. Não são medidas exclusivas do SQL. Consultas raw são agrupadas pela ação (`raw.$queryRawUnsafe`, por exemplo). Gravações aninhadas aparecem como a operação Prisma externa, sem separar os INSERTs internos. `resultRows`/`maxResultRows` contam apenas itens do array externo, sem percorrer relações aninhadas ou estimar bytes.

Para consultar as novas linhas após publicar e reiniciar o processo correto:

```bash
pm2 logs 13 --err --nostream --lines 3000 | grep -F '[database-operation]'
```

Para este ambiente, confirme primeiro com `pm2 describe 13` que o processo corresponde ao serviço `whatsapp`. Não há migration ou dependência nova. Publicar o código compilado e manter o script do coletor na estrutura descrita abaixo. Configurações de caminhos devem usar endereço absoluto; `~` literal em `.env` não é expandido pelo serviço.

O enqueue de envio do operador agora grava mensagem e job usando um `create` aninhado. Mantém atomicidade, escopo da chave de idempotência e tratamento de colisão `P2002`, sem o callback da transação interativa de cinco segundos. Não chama o provedor e não altera recuperação de `UNKNOWN`, limites de tentativas ou os demais usos de transações. Isso elimina aquele ponto de expiração; não comprova resolução da pressão de memória, locks ou P2024 observados em produção.

O serviço arma a coleta automaticamente ao iniciar em Linux pelo PM2 (`pm_id` no ambiente). Quando o listener de erros do Prisma detecta P2028, P2024 ou outro erro de conexão reconhecido, salva um arquivo em `logs/database-incidents/`, relativo ao diretório de trabalho do processo. Não é necessário acompanhar os logs ou iniciar o coletor durante a falha.

Cada arquivo contém:

- Horário, PID, ID do PM2, código e origem do erro, para correlação com o log normal.
- Até 60 amostras de memória, CPU e atraso do temporizador, tomadas a cada 5 segundos antes do erro (cerca de 5 minutos). Esse histórico fica apenas em memória até um incidente.
- Três amostras posteriores do coletor existente: PM2, `/proc`, conexões e transações MySQL, conforme as permissões do usuário do banco. Abre no máximo uma conexão adicional, fora do pool Prisma, usando apenas SELECT/SHOW.

Não há consultas contínuas ao banco. Apenas uma coleta pode executar por processo, com intervalo mínimo de 5 minutos entre inícios, inclusive após falhas. O processo auxiliar tem limite de 60 segundos e 512 KiB de saída. São mantidos os 5 arquivos mais recentes de cada ID do PM2, inclusive entre reinicializações; outros arquivos são preservados. O início e o fim da coleta aparecem no PM2 com o prefixo `[database-incident-capture]` e o caminho do arquivo. Os arquivos são criados com permissão 0600.

## Ativação em produção

Publicar o código compilado e **também `scripts/capture-resource-incident.cjs`**, preservando a estrutura `dist/` e `scripts/` na raiz do serviço. Reiniciar o processo correto no PM2. Não exige migration. O Node e o comando `pm2` precisam estar disponíveis para o usuário do serviço.

Variáveis opcionais:

```dotenv
DATABASE_INCIDENT_AUTO_CAPTURE=true
DATABASE_INCIDENT_CAPTURE_DIR=/home/inpulse/htdocs/inpulse.infotecrs.inf.br/whatsapp/logs/database-incidents
```

O padrão já é ativo em Linux/PM2; `DATABASE_INCIDENT_AUTO_CAPTURE=false` desabilita a coleta e o histórico. Para ambiente injetado pelo PM2, aplicar alterações com `--update-env`. O diretório deve ser gravável pelo usuário do processo. Windows ou execução sem `pm_id` mantêm apenas o registro de incidentes existente.

## Leitura posterior e limites

Consultar o arquivo indicado por `[database-incident-capture]`, correlacionando o horário com `logs/database-incidents.log` e `[message-send]`. `timerDelayMs` é atraso observado do temporizador de 5 segundos, não a métrica p95 do PM2; `timeSinceLastSampleMs` preserva o intervalo ainda não amostrado quando o erro chega antes do próximo timer. CPU pode exceder 100% se o processo utilizar vários núcleos.

O histórico anterior é do processo Node; as amostras do MySQL são posteriores ao erro e podem não mostrar um lock que já terminou. Um processo completamente travado só inicia a coleta quando voltar a executar JavaScript. Reiniciar o serviço perde o histórico ainda não persistido. Falhas de permissão, PM2, configuração TLS/socket não suportada pelo coletor ou indisponibilidade do banco ficam registradas nas amostras; não representam ausência de contenção. `capture_end.failed=true` indica falha/limite do processo auxiliar; `false` indica sua conclusão, mas é necessário inspecionar os erros de cada amostra.

A coleta não muda status, não reenvia mensagens e não reinicia serviços. Arquivos de diagnóstico não incluem conteúdo das mensagens, SQL completo ou credenciais do ambiente. A classificação também reconhece o texto de transação expirada do evento Prisma, mesmo quando o evento não expõe `code`.
