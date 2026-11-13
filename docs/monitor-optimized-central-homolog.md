# Port dos leitores centrais de monitoria para homolog

Base homolog: `030c2a0`. O port mantém o serviço e o contrato genéricos de monitoria; traz somente as funções puras de consulta, seleção de página, resumo e observação da candidata de produção `9c37e85` para `src/services/monitor/optimized-*.ts`.

O despacho usa os leitores otimizados exclusivamente para sessões ADMIN de Odim/Infotec com armazenamento central e `context.local=false`. O modo tenant SQL, as consultas locais e os outros tenants conservam o caminho anterior. Nenhum catálogo, flag, banco de tenant ou processo é ativado por esta alteração. A hidratação de canais, participantes, tentativas de entrega e clientes permanece em `monitor.service.ts`; o DTO continua usando `mapMonitorRow` genérico. Histórico e marcação READ não foram alterados.

As consultas separaram contagem, seleção de IDs e hidratação dos detalhes da página. A deduplicação de agendas ocorre antes da página e os filtros de última mensagem continuam sobre a última mensagem geral. O resumo reutiliza os fatos agregados do atendimento para a contagem de SLA. Os limites SQL existentes de 5/10 segundos foram preservados. A observação registra assinatura de filtros sem texto pesquisado, duração na aplicação/pool e etapas; não afirma medir isoladamente o tempo dentro do servidor MySQL.

Comandos de validação, executados sem configuração ou credenciais da aplicação:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
.\node_modules\.bin\ts-node.cmd --files src/services/monitor/monitor.test.ts
.\node_modules\.bin\ts-node.cmd src/services/monitor/optimized-dispatch.test.ts
.\node_modules\.bin\ts-node.cmd src/tenant-sql/engine.test.ts
node scripts/monitor-optimized-central.mysql.test.cjs
```

Resultados: TypeScript aprovado; 18 casos existentes de monitoria central/local e histórico aprovados; despacho central versus local/tenant SQL aprovado; 17 casos existentes do motor tenant SQL aprovados. O diferencial MySQL executou 109 cenários de página e seus resumos contra o construtor genérico anterior, cobrindo todos os modos de ordenação, filtros, paginação profunda, IDs coincidentes entre categorias, agendas duplicadas, última mensagem/canal, fatos operacionais, tenants isolados, Odim/Infotec vazios e populados, parâmetros e repetição prepared. A referência aplica deduplicação por atendimento para agendas múltiplas, conforme o contrato desejado.

O teste MySQL cria e remove somente schemas com prefixo `odim_monitor_homolog_qa_20261113_` no novo container QA `odim-flow-qa-mysql8-20261113`, endpoint `127.0.0.1:13418`. Não usa `.env`, bancos/processos de homolog ativos ou produção. Fixtures funcionais não constituem o benchmark representativo de 100 mil atendimentos.

O pacote B continua condicionado ao aceite de desempenho da candidata de produção. A medição histórica com pool/buffer de QA subdimensionado apresentou timeout e está sendo repetida com configuração representativa; este port funcional não declara o gargalo histórico encerrado. Se as funções puras de produção receberem correção posterior, atualizar `optimized-query.ts`, `optimized-search.ts` e `optimized-summary.ts` juntos e repetir o diferencial antes da publicação.
