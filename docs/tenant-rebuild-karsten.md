# Reconstrução rápida das tabelas do Karsten

Decisão de 21/09: descartar o conteúdo antigo das tabelas de negócio do tenant e
reconstruí-las com os dados do Karsten no banco central. Não corrigir o histórico
central nem reconciliar linha a linha com as cópias antigas.

Use `--phase rebuild`. Esta fase substitui o fluxo copy/verify para essa operação.
O central continua somente leitura e a aplicação continua usando seu roteamento
atual. `REBUILT` não ativa os repositórios do tenant (`readyForCutover: false`).

## O que é substituído

Seis tabelas no banco do tenant:

- `wpp_contacts`
- `wpp_chats`
- `wpp_messages`
- `wpp_schedules`
- `wpp_contact_sectors`
- `wpp_last_messages`, reconstruída a partir da mensagem de maior ID por contato.

Todo conteúdo anterior dessas seis tabelas é descartado depois da validação e
troca bem-sucedidas, inclusive registros extras que não existem mais na origem.
Tabelas do ERP, logs, filas centrais, `wpp_sync_migrations` e journals anteriores
não são apagados. Se `wpp_sync_state` existe, seu cursor de `messages` é ajustado
ao maior ID carregado (ou zero), para não pular novas mensagens por causa de um
cursor antigo maior. Os outros cursores permanecem como estão.

## Publicar e conferir o plano

Na pasta `whatsapp` do servidor, publicar o código e compilar:

```bash
npx tsc --pretty false
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase rebuild --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --legacy-timezone America/Sao_Paulo --run-id karsten-rebuild-01 --dry-run
```

O dry-run lê estrutura, identidades e contagens centrais. Não percorre todos os
payloads, não cria tabelas e não altera dados. Retorna `PLANNED`, `previewOnly:true`,
`payloadsValidated:false`, `complete:false`: é um plano, não uma carga concluída.
Confira `sourceIdentity` e os seis pares de nomes em `tables`.

O prepare já concluído permanece válido. Não repetir prepare, não executar o SQL
de correção histórica do chat 122396 e não reutilizar run-id de copy/verify.

## Carregar, validar, trocar e limpar

Pausar os gravadores do central e do tenant para esse domínio, incluindo o
sincronizador antigo, durante toda a operação e eventuais retomadas. A flag apenas
declara essa pausa. Pouco movimento não equivale a uma origem estável.

Substituir `HOST_CENTRAL` e `BANCO_CENTRAL` pelos valores conferidos em
`sourceIdentity.hostname` e `sourceIdentity.database_name` do plano:

```bash
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase rebuild --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --expected-source-hostname HOST_CENTRAL --expected-source-database BANCO_CENTRAL --legacy-timezone America/Sao_Paulo --run-id karsten-rebuild-01 --apply --writers-quiesced
```

Esse comando **já inclui a exclusão das tabelas antigas do tenant ao final**.
Não é necessário executar DROP manual nem dar reload no PM2 para usar o CLI.

1. Cria tabelas persistentes de trabalho `wpp_rb_<token>_n_*`, clonando a estrutura
   preparada. Não usa CREATE TEMPORARY TABLE: as tabelas precisam sobreviver à conexão.
2. Lê apenas o tenant solicitado na origem, transforma texto/datas e insere em
   lotes. Não consulta conteúdo antigo, não atualiza por campo e não gera auditoria
   de cada linha. Cada lote e seu checkpoint/checksum são confirmados juntos.
3. Valida contagens e checksums no servidor do tenant, sem trazer todas as linhas
   de volta pela rede. Reconstrói `wpp_last_messages` nas tabelas de trabalho.
4. Um único `RENAME TABLE` troca as seis tabelas: atuais viram `wpp_rb_<token>_o_*`
   e novas assumem os nomes definitivos.
5. Confere marcadores/contagens da nova geração, ajusta o cursor do sincronizador,
   remove somente os seis nomes antigos dessa execução e grava `COMPLETE`.

Sucesso: `status: "REBUILT"`, `complete: true`, `state: "COMPLETE"`.
Os checkpoints mostram `count`, `cursor`, `done` e os dois acumuladores do checksum.

## Retomar

`INCOMPLETE` indica o limite de tempo/lotes. Repetir **o mesmo comando e run-id**,
mantendo a mesma pausa contínua. A carga retoma das tabelas de trabalho; não começa
de novo. Antes da troca, as tabelas atuais permanecem com seus dados anteriores.

Depois de timeout/perda de conexão durante COMMIT, RENAME ou DROP, o script consulta
o journal e os nomes/marcadores efetivos antes de continuar. Uma limpeza parcial
retoma somente as tabelas antigas restantes. Um estado misturado ou checksum
divergente bloqueia a remoção; não apagar tabelas/journals para forçar o processo.
Não se presume rollback de DDL após queda de servidor, especialmente no MySQL 5.5.

Se os gravadores forem retomados, iniciar uma nova janela com **novo run-id**.
As tabelas de trabalho de uma execução abandonada não são removidas por outra.
Uma execução antiga detecta a mudança de geração e não substitui uma reconstrução
mais nova. Depois que os backups antigos foram removidos, o script não oferece
retorno automático à cópia anterior; a origem central permanece preservada.

## Histórico e limites

Referências históricas são copiadas como estão, inclusive `chat_id` ausente ou
de outro tenant. O rebuild não tenta consertar, desvincular, renumerar ou importar
o chat de outro tenant. No caso 1561678 → 122396, a mensagem do Karsten é copiada
com esse número; o chat marcado Suprimaxxi não entra na seleção de chats do Karsten.
Portanto a integridade da transferência é verificada, mas isso não certifica que
todos os vínculos históricos sejam válidos para uma futura ativação do runtime.
O `verify` antigo continua mais restritivo e pode recusar tais vínculos; não faz
parte do caminho de reconstrução rápida.

Encoding `percent-encoded-v1`, IDs, NULL e datas seguem o mesmo mapeamento de copy.
Contagem + XOR das duas metades de MD5 por registro verificam a transferência,
incluindo todos os campos mapeados, IDs, marcadores de NULL e comprimento UTF-8.
É detecção de alteração acidental, não assinatura contra adulteração deliberada.
O checksum roda no tenant, evitando uma segunda cópia integral pela rede.

Defaults próprios: `--batch-size 500`, `--max-batches 10000`,
`--max-duration-seconds 3600`, `--query-timeout-ms 120000`.
O orçamento por INSERT continua limitado a metade do menor max_allowed_packet,
com máximo de 512 KiB. Lotes são reduzidos por bytes, não apenas por linhas.
As verificações finais/DDL têm seus próprios prazos; a duração global é conferida
entre páginas. O ganho real em produção depende do volume, rede e índices; não
foi medido pelo agente no Karsten.

Erros de estrutura, dependências visíveis (FKs/triggers), representabilidade e
unicidade continuam interrompendo, sem truncar campos ou pular registros.
São necessários espaço para tabelas atuais + novas durante a carga e permissões
SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/DROP no destino (DELETE apenas na projeção
privada em reconstrução). A origem precisa somente SELECT e suporte à sessão
read-only. O journal administrativo é `wpp_tenant_rebuild`.

## Validação

Compilação TypeScript e ensaio descartável MySQL 8.0.46 → 5.5.62, destino latin1,
tabelas utf8 e packet 1 MiB. Exercitados preview sem mutação, conta de origem
SELECT-only, lotes limitados por bytes, referência histórica cruzada preservada,
filtro de tenant, retomada após COMMIT real sem ACK, corrupção detectada pelo
checksum antes de substituir, RENAME real sem ACK, DROP real sem ACK, remoção das
antigas somente após sucesso, projeção, cursor de sync, nova geração e origem
inalterada. Sem nova suíte permanente. Nenhuma execução remota pelo agente;
o servidor real 5.5.0-m2 ainda depende da execução do usuário.

Referência de DDL: [manual oficial MySQL 5.5](https://downloads.mysql.com/docs/refman-5.5-en.a4.pdf),
seções CREATE TABLE ... LIKE e RENAME TABLE. A retomada inspeciona o estado real;
não assume as garantias de atomic DDL das versões modernas.
