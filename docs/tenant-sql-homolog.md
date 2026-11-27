# SQL direto no banco do tenant em homolog

## Implantação de 26/11/2026

`homolog-whatsapp` contém dez tabelas após a retirada. O ingresso usa `ingress_waba`, `ingress_gupshup`, `ingress_remote` e `homolog_ingress_routes`. As seis técnicas são o histórico do Prisma, as três tabelas vazias de telemetria do frontend e as duas tabelas vazias do controle de migrações. O health identifica somente `infotec` e `suprimaxxi`. O registro preserva o incremento 4 para a faixa de IDs da Infotec.

O receptor de homologação usa um pool dedicado ao ingresso. Os hosts REMOTE locais usam a porta privada. Chamadas encaminhadas precisam de `X-Inpulse-Webhook-Token` correspondente a `HOMOLOG_REMOTE_CALLBACK_TOKEN`. Para callbacks públicos, a WABA exige a assinatura dos bytes originais com `HOMOLOG_WABA_<TENANT>_SECRET`. O Gupshup usa o cabeçalho de token com `HOMOLOG_GUPSHUP_<TENANT>_SECRET`. A autenticação precede a admissão. A associação entre canal e tenant é atualizada na mesma transação de cadastro do canal. Em homologação há canais ativos REMOTE e nenhum canal público WABA/Gupshup configurado. Provisionar o respectivo segredo por meio do ambiente antes de ativar um deles.

Na topologia homologada, ingresso e tenants estão no mesmo servidor MySQL. Uma transação InnoDB entrega na fila durável do tenant e substitui o conteúdo central por NULL. O comprovante técnico permite identificar reentregas. O worker conserva o evento pendente se a gravação no tenant falhar. Os processos do banco de logs registram metadados operacionais. O histórico `wpp_hml_arquivo_20261009_*` no CRM da Suprimaxxi conserva versões antigas à parte dos cadastros ativos.

### Virada física da Infotec

Em 27/11/2026, o executor retirou as 61 cópias congeladas depois de conferir os checksums do recibo de migração. O schema `homolog-infotec-whatsapp-runtime` contém apenas 61 views atualizáveis. As 61 tabelas físicas e suas 12 triggers ficam em `crm-sgr-infotec-prod`. O simulador privado confirmou a gravação de uma nova conversa após a retirada.

O executor `scripts/move-infotec-homolog-runtime.cjs` usa apenas a conexão operacional indicada pelo DBA em `HOMOLOG_RESIDENCY_DBA_URL`. O primeiro comando confere servidor, catálogo, tabelas, referências e gatilhos. O segundo cria as tabelas `wpp_hml_*` no CRM compartilhado e concede acesso ao usuário de homologação apenas para esses objetos. A troca reserva os nomes da origem em um único RENAME, copia os dados, verifica contagens e checksums, preserva AUTO_INCREMENT e recompõe as triggers. As views atualizáveis com SECURITY INVOKER preservam os nomes esperados pelos clientes existentes. Elas armazenam zero linhas. A origem física fica retida para verificação antes de sua retirada.

```sh
node scripts/move-infotec-homolog-runtime.cjs --inspect
node scripts/move-infotec-homolog-runtime.cjs --apply /caminho-privado/infotec-cutover.json
```

Após verificar login, leitura e uma operação de escrita pela aplicação Infotec, executar a retirada da origem com o mesmo recibo. O executor exige os checksums das tabelas retidas, as views no destino correto e a ausência de FKs externas.

```sh
node scripts/move-infotec-homolog-runtime.cjs --retire-origin /caminho-privado/infotec-cutover.json
```

Se houver falha antes da ativação das views, o executor tenta devolver os nomes originais. DDL parcial no destino exige reconciliação com o inventário antes de uma nova tentativa. Depois da ativação, qualquer retorno precisa preservar as novas gravações no CRM. Manter o ingresso em operação durante a janela e conferir pendências e duplicatas ao terminar. O plano, o resultado dos ensaios e os recibos de implantação ficam em `planejamento/cross-service/INF-20260918-001-tenant-data-migration/execucao-homolog-20261126/`.

## Destino acordado em 26/11/2026

A Suprimaxxi grava em `homolog-crm-suprimaxxi`. A Infotec grava em 61 tabelas `wpp_hml_*` do CRM compartilhado `crm-sgr-infotec-prod`. Os clientes SQL continuam usando os nomes `wpp_runtime_*` por meio de views no schema `homolog-infotec-whatsapp-runtime`. As permissões de homologação no CRM compartilhado foram concedidas por tabela.

As três filas de ingresso no banco da aplicação conservam o payload até o commit no tenant. O recibo técnico permite deduplicação após esse commit. Filas pós-entrada e controles de envio residem junto às mensagens no tenant.

No simulador privado da Infotec, a entrada gerou atendimento e mensagem nas tabelas físicas do CRM. Um segundo ensaio conferiu a deduplicação do callback e a remoção do payload central após a entrega.

O plano auditável é `planejamento/cross-service/INF-20260918-001-tenant-data-migration/destino-tabelas-homolog-20261126.md`. A matriz cobre as 52 tabelas físicas do central, os destinos, as condições para retirada e o retorno após novas gravações. As instruções de ativação e cópia inicial abaixo documentam a implantação anterior. Uma nova execução sobre os runtimes atuais exige reconciliação específica.

### Bot de triagem por canal

Antes de disponibilizar o editor, aplicar os DDL aditivos de autoria e execução de `prisma/tenant-sql/` em cada banco operacional preparado do registry de homologação. O modo central usa as migrações Prisma correspondentes. O prefixo das tabelas no modo por tenant é `wpp_runtime_triage_`.

No processo exclusivo `homolog-whatsapp`, definir `INPULSE_ENVIRONMENT=homolog` e `TRIAGE_HOMOLOG_ENABLED=true` para disponibilizar o recurso em todas as empresas desse ambiente. O mesmo resolvedor habilita a API e o parâmetro de sessão consumido pelo menu. Cada canal começa sem bot publicado. O administrador delega o canal aos responsáveis e a publicação da primeira versão inicia a triagem para novas conversas. Remover o override do processo restaura a escolha por instância em `enable_whatsapp_triage`, desabilitada por padrão. A configuração de homologação dispensa gravar parâmetros nos bancos dos clientes.

O modo `WHATSAPP_STORAGE=tenant-sql` usa mysql2 para ler e gravar os dados operacionais do WhatsApp nos bancos CRM dos tenants. O módulo central Prisma não é carregado nesse modo. Os contratos TypeScript e os metadados do schema continuam disponíveis para compatibilidade dos chamadores; nenhuma consulta desse domínio passa pelo Prisma. Logs permanecem no banco dedicado da aplicação.

Esta primeira ativação aceita somente o catálogo de homolog: `homolog` → `127.0.0.1:3306/homolog-crm` e `suprimaxxi` → `127.0.0.1:3306/homolog-crm-suprimaxxi`. Não aceita destinos de produção. A credencial é lida em memória do arquivo privado do ambiente; o registry não contém senha. Não há criação de tabelas ou migração no startup.

## Dados e roteamento

As 40 tabelas operacionais declaradas no schema e duas associações implícitas são armazenadas como `wpp_runtime_<nome físico central>`. As tabelas `wpp_*` anteriores continuam preservadas. A busca de contatos e a monitoria passam a consultar o runtime; as rotinas de sincronização antigas deixam de gravar nos espelhos. O reports-service precisa do mesmo modo e registry para consultar a origem atual.

O contexto da sessão escolhe o tenant e impede acesso a outro destino. Workers sem sessão procuram registros nos dois bancos preparados; leituras e agregações são combinadas, e IDs ambíguos bloqueiam a operação. IDs históricos são preservados. Novos IDs inteiros são reservados acima do maior ID da origem, com incremento 2 e offsets diferentes por tenant; as conexões sempre inicializam UTC e modo estrito. Os pools têm duas conexões e fila de oito por tenant.

Transações e escritas aninhadas usam uma conexão. Consultas em arrays permanecem preguiçosas até entrar na transação e não são repetidas depois. COMMIT sem confirmação retorna `TENANT_COMMIT_UNKNOWN`, destrói a conexão e não autoriza repetir a operação. Clientes transacionais capturados não podem gravar depois do encerramento. Aquisição, consultas e transações têm prazos limitados. Os controles de envio e suas mensagens residem no mesmo banco, preservando chaves de idempotência e `UNKNOWN`.

## Migração

Executar somente no servidor de homolog, com o usuário MySQL `homolog` restrito aos bancos `homolog-*`. O CLI valida identidade do catálogo `homolog-instances.clients_servers`, schema da origem e ownership dos registros. A origem é `homolog-whatsapp`, aberta com transação READ ONLY. As tabelas novas recebem índices e FKs compatíveis; referências históricas órfãs são contadas e documentadas no registry. Não se buscam pais de outro tenant para completar a réplica.

```bash
node dist/scripts/tenant-sql-homolog.js --dry-run
bash scripts/backup-tenant-sql-homolog.sh
pm2 stop homolog-whatsapp
node dist/scripts/tenant-sql-homolog.js --apply --writers-quiesced
node dist/scripts/tenant-sql-smoke.js
```

`--writers-quiesced` declara a pausa; não a realiza. Manter os gravadores parados até a ativação. A cópia é paginada e possui journal. Ao retomar, dados da origem e cada registro existente precisam conferir; divergência bloqueia, sem sobrescrever destino. Contagem e SHA256 de todas as tabelas precisam conferir antes de publicar o registry 600. O smoke faz somente escritas sintéticas dentro de transações que obrigatoriamente sofrem rollback, e confere que o banco central permanece intacto.

Ativar os processos `homolog-whatsapp` e `homolog-reports` com:

```dotenv
WHATSAPP_STORAGE=tenant-sql
WHATSAPP_TENANT_SQL_REGISTRY=/home/inpulse/htdocs/homolog/whatsapp/tenant-sql-registry.json
```

Manter `PROCESS_LOG_STORAGE=dedicated` no WhatsApp. Build: `npx tsc`; não usar o script que copia `.env` local. `/health` do WhatsApp informa o modo de armazenamento. Validar APIs autenticadas e fluxos do simulador depois do restart.

## Retorno

Antes de qualquer gravação no runtime, restaurar os arquivos de ambiente e builds do backup e reiniciar somente os dois processos de homolog retorna à origem preservada. Depois de novas gravações, os bancos dos tenants são a fonte de verdade: parar os gravadores, preservar um backup desses bancos e reconciliar INSERT/UPDATE/DELETE antes de reativar o central. Trocar apenas a variável de ambiente perde a visibilidade das alterações posteriores ao cutover e não é um retorno validado.

Esta entrega não habilita destinos de produção nem demonstra compatibilidade do runtime com o MySQL 5.5/percent-encoding do piloto Karsten. O migrador histórico e os dados centrais permanecem disponíveis.

## Integração das atualizações locais em 13/10/2026

A integração incorpora os recibos REMOTE persistentes (`8e03790`) e a saúde do canal baseada em mensagens (`c5c673f`), além do histórico de `origin/main`. O único conflito de conteúdo, em `remote-client.service.ts`, preserva tanto a seleção do banco do tenant quanto a admissão limitada e o processamento sequenciado dos recibos. O HTTP confirma persistência com 202 enquanto o inbox está pendente e só retorna 200 para conclusão; recibos não localizados ou ambíguos permanecem disponíveis para retry durável. A progressão de status conserva `READ`, e a saúde do canal não provoca reenvio de mensagens `UNKNOWN`.

O `prisma/schema.prisma` continua idêntico ao commit de homolog `3d725b2`. Os recibos utilizam `remote_inbound_event_inbox.event_type` (VARCHAR 64), `payload` JSON e as chaves canônicas existentes; a categoria da falha usa `operator_outbound_send.provider_outcome` JSON. Não há coluna, tabela, índice ou enum novo que exija DDL aditivo nos bancos do tenant. Não executar novamente a cópia da origem central: o runtime já recebeu gravações e permanece como fonte de verdade.

As verificações locais exigidas são `npx tsc --noEmit`, `npm run test:tenant-sql`, `npm run test:remote-inbound` e `npm run test:functional-health`. A suíte de entrada cobre o inbox, a concorrência limitada, o handler real, as respostas HTTP e a preservação do tenant durante a admissão e o processamento assíncrono. A publicação continua restrita à homolog e precisa validar os endpoints autenticados de monitoria e callback depois do restart.
