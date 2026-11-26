# SQL direto no banco do tenant em homolog

## Destino acordado em 26/11/2026

O histórico de cada empresa deve residir no mesmo banco físico de seu CRM. Na Suprimaxxi o destino é `homolog-crm-suprimaxxi`. Para a Infotec, a próxima migração parte de `homolog-infotec-whatsapp-runtime` para o CRM compartilhado `crm-sgr-infotec-prod`. O desenho proposto reserva tabelas exclusivas de homologação nesse CRM e exige segregação de permissões e de rotas. Os dados de teste da antiga instância `homolog` estão destinados ao descarte após identificação dos seus vínculos.

O modo `tenant-sql` atualmente roteia também as filas operacionais. A proposta reserva três entradas para persistência temporária no banco da aplicação, `waba_webhook_queue`, `gupshup_webhook_queue` e `remote_inbound_event_inbox`. Cada worker deve receber a confirmação de uma transação durável no tenant antes de eliminar o payload central. O recibo mínimo de deduplicação precisa sobreviver a uma reentrega. Filas pós-entrada e controles de envio permanecem junto às mensagens no tenant.

Para implementar, separar o repositório de ingresso do roteador geral e validar o vínculo entre provedor, canal e instância mesmo durante uma queda do CRM. No REMOTE, incluir o tenant nas chaves de evento. Na WABA, ajustar o caminho de erro que hoje responde HTTP 200 quando falha a persistência. Remover o conteúdo dos webhooks também do logger chamado pelos controllers. Testar queda antes do commit, confirmação perdida depois do commit, repetição de callbacks, canais de tenants com o mesmo ID e descarte do conteúdo após confirmação. O descarte do payload deve preservar a deduplicação e a reconciliação de recibos atrasados.

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
