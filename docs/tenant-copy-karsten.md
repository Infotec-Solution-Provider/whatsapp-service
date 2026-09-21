# Cópia e conferência do Karsten

Disponíveis: `--phase copy` e `--phase verify`, para `contacts`, `chats`,
`messages`, `schedules` e `contacts_sectors`, nas estruturas `wpp_*` já preparadas.
O usuário confirmou PREPARED em produção em 21/09. Não repetir prepare nem apagar
seu journal. O contrato/hash dessa preparação permanece inalterado.

O banco central é somente leitura e **é a fonte de verdade**, conforme decisão do
usuário em 21/09. A cópia insere registros ausentes e atualiza campos divergentes
do mesmo registro no destino com os valores centrais, inclusive NULL. Preserva
encoding, fuso legado e milissegundos pelo mapeamento existente. Antes de atualizar,
guarda os valores anteriores em `wpp_tenant_copy_audit`, na mesma transação da
alteração e do checkpoint. Nenhum DELETE, TRUNCATE, REPLACE, envio de mensagem ou
ativação de runtime ocorre. Identidade/tenant divergentes e colisões entre IDs
distintos continuam bloqueando: não há renumeração nem fusão de registros.

Esta política substitui o bloqueio de qualquer divergência de conteúdo. O contrato
de **copy** mudou; usar um **novo run-id** se já aplicou uma versão anterior.
O contrato de **prepare** não mudou: não repetir prepare nem apagar seus journals.

## 1. Publicar, compilar e simular

Na pasta `whatsapp` do servidor, usando o mesmo ambiente do prepare:

```bash
npx tsc --pretty false
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase copy --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --legacy-timezone auto --dry-run
```

Destino: `TENANT_DATABASE_URL`, ou resolução pelo catálogo `INSTANCES_DATABASE_URL`.
Origem: `TENANT_MIGRATION_SOURCE_URL`, com fallback para `WHATSAPP_DATABASE_URL`.
É preferível configurar uma conta central com somente SELECT. O CLI também
configura a sessão central como transação somente leitura; o servidor de origem
precisa suportar `SET SESSION TRANSACTION READ ONLY`. O parâmetro Prisma `schema`
da URL é ignorado; no MySQL o banco selecionado é o caminho da URL.

Não enviar URLs ou senhas. O resultado mostra `sourceIdentity.hostname` e
`sourceIdentity.database_name`, necessários aos comandos seguintes. Confira que
identificam a origem central pretendida. Origem e destino iguais são recusados.

A simulação não cria journal nem grava dados. Ela percorre as páginas do início,
limitada por quantidade de lotes e tempo. `PLANNED` com `complete:true` significa
que toda a simulação de cópia terminou sem conflito. `INCOMPLETE` significa apenas
prévia parcial; não é prova sobre as páginas ainda não lidas. Pode aumentar os
limites para ampliar a prévia. Dry-run não retoma checkpoints antigos.

## 2. Fuso das datas antigas

`--legacy-timezone auto` consulta os 100 menores e os 100 maiores IDs do tenant
no destino e busca seus correspondentes na origem. IDs presentes nas duas
extremidades contam uma única vez (até 200 mensagens distintas). Exige pelo menos
três pares válidos e concordância integral em apenas uma opção: UTC ou
America/Sao_Paulo. Divergências antigas não são descartadas quando há pares recentes.
O resultado mostra `timezone.timezone`, método, pontuações e `sample`: quantidades
por extremidade, IDs distintos, IDs encontrados na origem, ausentes e pares com
datas NULL. Nenhum horário é alterado por essa identificação.

Em 21/09, o primeiro dry-run de produção retornou `observations:0` usando somente
os 100 menores IDs. Isso não determina o fuso nem prova ausência de IDs comuns
em todas as tabelas. O usuário depois forneceu o par ID `3022374`: destino
`2026-09-21 04:38:07`, origem `2026-09-21 07:38:07`, timestamp `1789976287000`
(07:38:07 UTC), compatível com America/Sao_Paulo nessa mensagem. A amostragem
ampliada ainda precisa ser executada em produção para conferir outros pares.

Sem evidência suficiente, com horários misturados ou diferenças não explicadas,
o comando para com `TENANT_LEGACY_TIMEZONE_UNRESOLVED`. Não escolhe fuso por padrão.
O erro inclui as identidades dos bancos e um motivo: `NO_TARGET_SAMPLE`,
`NO_OVERLAP_IN_SAMPLE`, `INSUFFICIENT_DATED_PAIRS` ou `INCONSISTENT_DATES`.
`SAMPLE_CHANGED` indica que a mesma data mudou entre as duas leituras; repetir
com os gravadores pausados. Ausência na amostra não prova ausência em toda a tabela.
Uma opção explícita, como `--legacy-timezone America/Sao_Paulo`, só deve ser usada
depois de confirmar o fuso real. Todo registro existente ainda terá suas datas
comparadas durante a cópia/conferência; o resultado da amostra não dispensa isso.

Datas da origem seguem o contrato UTC do Prisma. O migrador preserva milissegundos
nos campos `*_epoch_ms`, e usa o fuso identificado para as colunas DATETIME legadas
sem frações. Não converte o histórico existente nem inventa milissegundos a partir
dele. Datas inválidas ou precisão maior que milissegundos são recusadas.

## 3. Copiar na janela de manutenção

Manter **os gravadores da origem e do destino pausados**, incluindo sincronizador,
workers e integrações que alterem esse domínio. Preservar entrada durável de eventos
durante a janela. `--writers-quiesced` declara essa pausa; não a executa. Não há
captura de alterações concorrentes nesta entrega.

Escolha um `run-id` exclusivo para essa janela e mantenha-o em todas as retomadas.
No exemplo abaixo, substituir HOST_ORIGEM e BANCO_ORIGEM pelos campos conferidos
na simulação. O run-id de exemplo deve ser novo no seu banco:

```bash
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase copy --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --expected-source-hostname HOST_ORIGEM --expected-source-database BANCO_ORIGEM --legacy-timezone auto --run-id karsten-janela-01 --apply --writers-quiesced
```

Resultados:

| Status | Ação |
|---|---|
| `COPIED`, `complete:true` | Cópia forward concluída; executar verify |
| `INCOMPLETE`, `complete:false` | Repetir o mesmo comando, na mesma pausa, com o mesmo run-id |
| `CONFLICT` | Conferir entity/key/columns/reason; a página conflitante não foi aplicada |
| Erro em stderr | Conferir etapa/consulta/código; não apagar journal nem presumir rollback após perda de conexão |

O relatório contém `conflictPolicy: "source-wins"`, checkpoints e contadores por
entidade. `inserted` contabiliza linhas novas e `updated` linhas existentes
reconciliadas, incluindo extensões preenchidas; na simulação são ações previstas.
A coluna interna `enriched` do journal continua armazenando o contador de updates
para preservar sua estrutura, mas o JSON agora usa `updated`.
`reconciliation.rowsThisInvocation` e `byEntity` contam apenas as páginas desta
invocação; `samples` mostra até 20 IDs e campos, sem conteúdos. Os checkpoints
contêm os acumulados do run-id, incluindo páginas retomadas. No dry-run tudo é
prévia, sem gravação de auditoria, alterações ou checkpoints.
Progresso por página sai em stderr. Conflitos retornados em stdout
usam exit code 2; erros de validação/driver usam exit code 1. `INCOMPLETE` usa
exit code 0, portanto automações precisam conferir `complete`, não apenas o código.

## 4. Conferir nos dois sentidos

Com os gravadores ainda pausados, executar com o mesmo run-id e identidades:

```bash
node ./dist/scripts/tenant-migrate.js --tenant karsten --phase verify --text-profile percent-encoded-v1 --expected-hostname KSASGR --expected-database crm_sgr --expected-source-hostname HOST_ORIGEM --expected-source-database BANCO_ORIGEM --legacy-timezone auto --run-id karsten-janela-01 --writers-quiesced
```

`verify` não altera dados de negócio; grava apenas seu progresso no journal.
`--dry-run` faz uma conferência sem persistir progresso, sempre desde o início.
Os checkpoints de copy e verify são separados. Repita o comando em caso de
INCOMPLETE. `VERIFIED` com `complete:true` exige terminar ambas as direções:

- Origem → destino: presença, todos os campos mapeados, encoding, datas, IDs e
  referências centrais do mesmo tenant.
- Destino → origem: registros extras do tenant, além de diferenças de conteúdo.
  Associações do destino sem contato pai são recusadas por não terem tenant seguro.

Uma verificação finalizada é evidência **daquela janela de pausa**. Ao retomar
gravadores ou alterar dados/estrutura para resolver conflitos, use um **novo run-id**
e faça copy/verify desde o início. Um run-id concluído não revalida páginas antigas
automaticamente. Conteúdo previamente copiado será comparado; não será duplicado.
Não habilitar o tenant como autoridade: `readyForCutover` permanece false.

## Limites e garantias da implementação

- `--batch-size`: 1–500, padrão 100. `--max-batches`: 1–10000, padrão 1000.
  `--max-duration-seconds`: 1–3600, padrão 300, conferido entre páginas.
  `--query-timeout-ms`: 1000–120000, padrão 30000. Conexão: 10000 ms.
- Paginação por chave, sem OFFSET. Associações usam `(contactId, sectorId)`.
  Leitura consulta tamanhos antes dos payloads e pode reduzir a página por bytes;
  uma página reduzida não é confundida com fim dos dados.
- Orçamento de escrita: metade do menor max_allowed_packet entre os servidores,
  limitado a 512 KiB. No Karsten de 1 MiB, são 512 KiB. INSERTs e atualizações
  em lote são divididos por bytes, com parâmetros preparados e margem de protocolo.
  Um registro que exceda o orçamento gera erro, sem truncamento.
- `wpp_tenant_copy_state` guarda run-id, fase/direção/entidade, vínculo com
  origem/destino/tenant/fuso/contrato, cursores e contadores. A criação usa o prazo
  de DDL do CLI. Dados da página e checkpoint são confirmados na mesma transação
  InnoDB do destino; perda da resposta do COMMIT não causa replay automático.
- Uma nova execução consulta o checkpoint efetivo. Um vínculo diferente é
  recusado. O mesmo lock usado por prepare exclui outro prepare/copy/verify no
  destino, inclusive a prévia; não bloqueia gravadores legados automaticamente.
- Todos os IDs são preservados, incluindo IDs de provedor. `chats.id` e
  `original_id` divergentes são conflito; não há renumeração. Tombstones de
  contatos participam da cópia e da conferência.
- Campos codificados são comparados pelo valor lógico, decodificando exatamente
  uma vez. `%20` literal, vazio e NULL permanecem distintos. O JSON de menções
  serializado pela origem é preservado e codificado; a conferência desconsidera
  ordem de chaves/espaços, mas preserva os tokens numéricos sem arredondamento. O avatar
  antigo do chat admite as duas representações dos gravadores conhecidos; o novo
  campo canônico recebe o valor central codificado.
- Colunas sem perfil percent-encoded não recebem conversão adivinhada. Valores
  Unicode não representáveis no utf8 antigo, limites de coluna, referências fora
  do tenant e colisões de índices únicos interrompem a operação com IDs/campos,
  sem imprimir nomes, telefones, mensagens, SQL de dados ou credenciais.

Permissões: SELECT na origem; SELECT/INSERT/UPDATE/CREATE no destino e
CREATE TEMPORARY TABLES para a infraestrutura administrativa existente. Não são
necessários DELETE/DROP nos dados de negócio. A estrutura PREPARED deve continuar
compatível; nenhum schema do ERP é alterado globalmente por copy/verify.

Fora desta entrega: filas, controles de envio durável, reações, demais tabelas de
negócio, projeção `wpp_last_messages`, índices novos de runtime, leitores/gravadores
da aplicação, retorno após novas escritas locais e cutover. COPIED/VERIFIED não
substituem essas etapas. O banco central continua sendo a autoridade.

## Reconciliação e valores anteriores

Exemplo real recebido: chat 229909 encerrado no central, mas aberto no Karsten.
`copy` passa a planejar/aplicar o encerramento do central com a data convertida
para o fuso confirmado, em vez de bloquear por CONTENT_CONFLICT. Isso vale para
conteúdo dos campos mapeados de contatos, chats, mensagens e agendamentos.
`id`, `instance` e `chats.original_id` não são corrigidos automaticamente; uma
divergência gera IDENTITY_CONFLICT. Chaves de associações também não são trocadas.
Chaves únicas que já pertencem a outro ID exigem revisão, mesmo com origem soberana.
Registros exclusivos do destino são preservados e continuam aparecendo em verify.

`verify` continua somente conferência: divergências de conteúdo geram conflito,
sem reparo automático nessa fase. Se necessário, executar novamente copy e verify
com um novo run-id após resolver a causa e estabelecer uma nova pausa contínua.

O CLI cria `wpp_tenant_copy_audit` somente em copy aplicado. Cada registro guarda
run-id, entidade, chave, vínculo da execução e um JSON em base64, dividido em partes
para respeitar o packet de 1 MiB. O JSON contém `before` (campos mapeados anteriores),
`after` (valores novos dos campos alterados) e `columns`. Para reconstruir, ler por
run-id/entidade/chave ordenando `part`, conferir a quantidade `parts`, concatenar
`payload`, decodificar base64 para UTF-8 e interpretar JSON. Base64 é representação,
não criptografia; o conteúdo permanece no banco do tenant, sem impressão no CLI.
Não usar GROUP_CONCAT sem considerar seus limites de truncamento.

A auditoria é evidência para revisão/restauração; não há comando de restauração
automática. Inserts novos são contabilizados no checkpoint; a auditoria guarda
updates. Uma falha na página desfaz auditoria, updates e checkpoint juntos. Depois
de COMMIT sem resposta, retomar pelo journal com o mesmo run-id e a mesma pausa;
nunca apagar registros de auditoria para forçar replay.

A rotina atual de encerramento confirma primeiro no central e depois sincroniza
o tenant. Uma falha intermediária pode deixar a cópia antiga; a repetição já
encontra o chat encerrado e retorna antes de ressincronizá-lo. Esse mecanismo foi
identificado no código, mas não comprova a causa histórica do chat 229909. A rotina
de sync de produção não foi alterada nesta entrega.

## Validação local

TypeScript e ensaio descartável com origem MySQL 8, conta somente SELECT, e
destino MySQL 5.5/latin1/1 MiB. Exercitados dry-run sem mutação, detecção de fuso,
horários misturados, Unicode/NULL/% literal/milissegundos, conflitos sem overwrite,
isolamento e referência entre tenants, IDs extras, chaves compostas, paginação
reduzida por bytes, INSERTs divididos, payload grande recusado antes da leitura,
retomada após COMMIT real sem ACK, checkpoints e repetição idempotente. Comparados
os registros da origem antes/depois. Sem nova suíte permanente. Nenhum copy/verify
de produção foi executado pelo agente.

Política source-wins: TypeScript e ensaio descartável com origem MySQL 8.0.46
(conta SELECT-only) e destino 5.5.62/latin1/packet 1 MiB. Validados dry-run sem
mutação, reconciliação de campos antigos/novos, NULL, percent-encoding, datas e
milissegundos, rollback conjunto com auditoria/checkpoint, COMMIT sem ACK e retomada,
verify, idempotência, recusa de outro tenant/ID e colisão única, auditoria dividida
em partes e igualdade integral dos dados da origem antes/depois. Sem nova suíte
permanente; execução de produção depende do usuário.

Correção da amostragem validada com TypeScript e ensaio descartável em memória:
histórico antigo sem correspondência e pares recentes válidos, deduplicação,
amostra vazia/sem sobreposição, datas NULL, UTC, fusos misturados, horário sem
correspondência e alteração entre leituras. Esse ensaio não consultou produção
nem repetiu a integração MySQL descrita acima. Contratos de prepare/copy preservados.
