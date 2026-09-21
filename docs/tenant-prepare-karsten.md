# Preparação do Karsten

`tenant-migrate --phase prepare` prepara a estrutura básica de contatos, chats,
mensagens e agendamentos nas tabelas existentes. Usa o contrato do probe fornecido
em 20/09/2026 (KSASGR / crm_sgr / MySQL 5.5.0-m2-community).
Não conecta ao banco central, copia registros, altera roteamento ou libera cutover.
Não é uma migration do Prisma; não execute `prisma migrate deploy` no tenant.

Após PREPARED, usar [cópia e conferência do Karsten](tenant-copy-karsten.md).
Copy/verify já estão implementados para o núcleo preparado, com retomada; a
aplicação continua no banco central até uma futura implementação de cutover.

## Executar

Publique esta versão do whatsapp-service e compile na raiz `whatsapp` do servidor:

```bash
npx tsc --pretty false
node ./dist/scripts/tenant-migrate.js --help
```

Use o mesmo diretório e ambiente do probe aprovado. O comando carrega `.env` do
diretório corrente; `TENANT_DATABASE_URL` tem prioridade sobre o catálogo
`INSTANCES_DATABASE_URL`. Não é necessário recarregar o PM2 para executar esse CLI.
`npx tsc` apenas compila; o script `npm run build` deste projeto também copia `.env` para `dist`.

Primeiro, simule. Este comando consulta metadados e o journal, caso já exista;
não executa DDL nem escreve dados:

```bash
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase prepare --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --dry-run
```

O resultado deve ter `status: "PLANNED"` e `planned` com o SQL exato. Na estrutura
do probe recebido são quatro ALTERs (um por tabela) e a criação de
`wpp_tenant_prepare`. Um problema em qualquer tabela impede toda a aplicação.
Incompatibilidades saem em stderr com etapa, código e `blockers`, sem payloads
nem credenciais.

Na janela de manutenção, com backup disponível e os gravadores das `wpp_*`
pausados, incluindo sincronizador legado, serviço e integrações do ERP que escrevam
nessas tabelas, aplique:

```bash
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase prepare --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --apply --writers-quiesced
```

`--writers-quiesced` declara que essa pausa foi feita; não para serviços automaticamente.
O lock do migrador exclui outra preparação no mesmo banco, mas não impede escritores
que desconheçam esse lock. O ALTER pode reconstruir tabelas e bloquear acessos no
MySQL antigo: reservar tempo/espaço no destino. DDL tem prazo de 10 minutos por
comando, configurável com `--ddl-timeout-ms` entre 1000 e 3600000. Conexão mantém
10 segundos. Consultas administrativas de prepare (incluindo sessão, catálogo,
identidade, metadados, probe e journal) têm prazo de **30 segundos por consulta**,
configurável com `--query-timeout-ms` entre 1000 e 120000. Os limites de consultas
do runtime, inspect e probe avulsos permanecem inalterados.

Progresso vai para stderr, com etapa, tabela e rótulo da consulta, sem SQL nem dados.
Diagnósticos versão 3 mostram queryTimeoutMs e ddlTimeoutMs separadamente.
Conferência final e gravação de recibo também têm etapas distintas.
Conclusão em stdout: `status: "PREPARED"`,
`schemaChangesRequired: false` e **`readyForCutover: false`**. Repetir a simulação
deve produzir `planned: []`. Após conclusão e conferência, os gravadores legados
podem ser retomados: nenhuma troca de autoridade ocorreu. A próxima cópia ainda
exigirá pausa/reconciliação próprias; os campos novos não são mantidos pelo legado.

## Alterações e contrato de armazenamento

| Tabela | Preparação |
|---|---|
| `wpp_contacts` | Amplia `name` de VARCHAR(255) para LONGTEXT, com o mesmo charset/collation; permite `phone` NULL; adiciona identidade WhatsApp, flags, avatar, expiração e datas em epoch ms |
| `wpp_chats` | Adiciona wallet/agent/schedule, prioridade, avatar codificado separado e datas em epoch ms |
| `wpp_messages` | Adiciona metadados de menções, timestamp do status, agente e data de envio em epoch ms |
| `wpp_schedules` | Adiciona as duas datas em epoch ms; mantém `instance`, já presente no probe mais recente |
| `wpp_contact_sectors` | Confere estrutura e chave composta, sem ALTER |
| `wpp_tenant_prepare` | Journal exclusivo desta preparação; não reutiliza o controle do sincronizador antigo |

Novos campos são nullable e ficam NULL até uma cópia conferida. Isso evita
apresentar flags/prioridade/datas desconhecidas como valores corretos. Ampliação
de nome e relaxamento de telefone não modificam os valores já armazenados.
Não há conversão global de charset, alteração de IDs/AUTO_INCREMENT, UPDATE de
dados de negócio, exclusão ou regravação do histórico. As novas colunas textuais
declaram utf8 explicitamente e não herdam latin1 do banco.

Contrato para a futura cópia/adaptador:

- `contacts → wpp_contacts`, `chats → wpp_chats`, `messages → wpp_messages`,
  `schedules → wpp_schedules`; `contacts_sectors.contactId/sectorId →
  wpp_contact_sectors.contact_id/sector_id`.
- Preservar IDs centrais. Exigir conferência de `wpp_chats.id = original_id` antes
  de reutilizar referências. A preparação não renumera nem comprova essa igualdade.
- Codificar exatamente uma vez os valores nativos de `contacts.name/avatar_url`,
  `messages.body/file_name`, `schedules.description` e o novo
  `chats.avatar_url_encoded`. Não recodificar automaticamente os valores existentes.
- `mention_metadata`: JSON serializado e depois `encodeURIComponent`; NULL SQL
  permanece NULL. Não usar tipo JSON indisponível neste servidor.
- O avatar legado dos chats pode misturar texto nativo e codificado. Manter esse
  campo intacto; preencher a nova coluna a partir do valor central conferido.
- Datas novas usam BIGINT com epoch UTC em milissegundos. NULL significa não
  reconciliado. Não derivar automaticamente esses valores dos DATETIME legados,
  que perderam precisão e dependem do fuso usado pelo gravador antigo.
- IDs de provedor, telefones e demais campos não recebem percent-encoding por padrão.

A preparação verifica PKs e índices únicos existentes por colunas completas,
sem aceitar índices prefixados como prova de unicidade. Não cria ainda os novos
índices de identidade/consulta, filas ou controles de envio. Isso depende dos
repositórios e da reconciliação dos registros existentes. `PREPARED` significa
estrutura desta versão concluída, não domínio pronto para operar no tenant.

## Retomada e limites

MySQL faz commits implícitos em DDL; a execução inteira não é uma transação.
O journal registra tenant, identidade do destino, hash do contrato e estado por
tabela antes/depois do ALTER, com autocommit explícito na conexão administrativa.
A retomada sempre inspeciona a estrutura real:
se o ALTER terminou e somente a confirmação foi perdida, ele não é repetido.
Uma estrutura registrada como concluída que desapareceu é divergência, não
reparo automático. Tenant/hash incompatíveis também impedem a execução.

Se houver timeout ou desconexão, o DDL pode ainda estar executando ou já ter
terminado no servidor. Não apague o journal nem assuma rollback. Confira a
operação no servidor e execute novamente o dry-run; depois de resolver a falha,
o mesmo comando de aplicação retoma a preparação. Não há retry automático.

No incidente recebido em 20/09, `prepare-verify / wpp_messages` expirou com
`PROTOCOL_SEQUENCE_TIMEOUT`. Nessa versão o ALTER tinha prazo próprio, mas a
conferência e o recibo ainda usavam 3000 ms. O diagnóstico antigo não distingue
qual dessas consultas expirou nem explica a demora no servidor. Corrigido o prazo
administrativo sem mudar o contrato/hash do journal. Depois de publicar e compilar
essa correção, executar o dry-run e, na janela com gravadores pausados, retomar:

```bash
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase prepare --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --dry-run --query-timeout-ms 30000
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase prepare --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --apply --writers-quiesced --query-timeout-ms 30000
```

Se retornar `TENANT_PREPARE_BUSY`, a sessão anterior ainda pode estar terminando
no servidor; verificar a operação e aguardar sua conclusão, sem apagar journal
nem forçar liberação do lock. A retomada mantém o mesmo contrato e só aplica
ALTERs ainda necessários. Um recibo STARTED não exige repetir um ALTER concluído.

Triggers e FKs visíveis nas tabelas envolvidas bloqueiam a preparação automática
para revisão. Uma conta sem acesso a esses metadados não comprova sua ausência.
Use uma conta administrativa com visibilidade das dependências e permissões de
SELECT, ALTER, CREATE, CREATE TEMPORARY TABLES e INSERT/UPDATE no journal. As
operações ALTER do servidor também podem exigir INSERT; valide os grants da conta
administrativa utilizada. Não são necessários DROP/DELETE nos dados de negócio.

## Validação local

Compilação TypeScript e ensaio descartável em MySQL 5.5.62, default latin1 e pacote
de 1 MiB, com registros preexistentes. Conferidos: simulação sem DDL, validação
global antes da mutação, identidade/pausa, exclusividade, trigger incompatível,
interrupção após ALTER real e antes do recibo, retomada sem repetir esse ALTER,
segunda aplicação sem alterações, preservação de todos os campos/IDs/datas/textos
anteriores, recusa de tenant/hash divergentes e drift estrutural. Também conferidos
timeout real com ALTER bloqueado e retomada explícita, persistência do journal com
autocommit inicialmente desligado, nome codificado maior que 255 caracteres,
telefone NULL e milissegundos. Defaults/índices personalizados sobre campos
modificados são recusados antes de alteração. Sem suíte nova
permanente. O prepare ainda não foi executado no MySQL 5.5.0-m2 de produção;
o probe de texto nessa versão foi aprovado pelo usuário.

Correção do prazo: ensaio descartável 5.5.62 reproduziu timeout de metadados após
ALTER real, com recibo STARTED e operação schema-tables identificada. A retomada
com 30 s suportou consultas de metadados/journal acima de 3 s e não repetiu o
ALTER de mensagens. Confirmados hash inalterado, valores preservados, repetição
sem ALTER, limites da opção do CLI e preservação do erro original quando a
limpeza da tabela temporária encontra uma conexão já encerrada. Não houve
validação dessa correção em produção pelo agente.

Referência: [MySQL 5.5 Reference Manual](https://downloads.mysql.com/docs/refman-5.5-en.pdf),
seções ALTER TABLE, commits implícitos e funções GET_LOCK/RELEASE_LOCK.
