# Coleta automática de incidentes do banco

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
