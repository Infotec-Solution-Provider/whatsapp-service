# Monitoria operacional

As rotas modernas da Monitoria exigem autenticação e `role === ADMIN`, usando o middleware administrativo existente. O tenant vem da sessão; filtros enviados no corpo não alteram esse escopo. A regra de setor existente continua aplicada: em `nunes`, quem não pertence ao setor 3 vê apenas seu setor. A mesma restrição vale para agendamentos pendentes e histórico. As rotas legadas mantêm o contrato dos consumidores existentes.

## Contrato e filtros

- `POST /api/whatsapp/monitor/search`: `{ page, pageSize, filters }`; retorna `{ data: { items, totalCount, page, pageSize } }`. Página começa em 1; tamanho padrão 20, máximo 100. Limites e enums inválidos retornam 400.
- `POST /api/whatsapp/monitor/summary`: `{ filters }`; retorna `{ data: { inProgress, waitingAgent, waitingCustomer, unread, overdue, scheduled, slaMinutes } }`.
- `GET /api/whatsapp/monitor/chats/:type/:id/messages?limit=50&beforeId=123`: `type` é `wpp` ou `internal`; tamanho máximo 100. Retorna `{ data: { messages, quotedMessages, nextCursor } }`, mensagens em ordem crescente e cursor pela menor ID da página. Verifica acesso ao atendimento antes de ler mensagens. Citações são restritas ao mesmo atendimento/tenant. Ler na Monitoria não marca mensagens como lidas. Menções, reações e erros de envio passam pela apresentação compartilhada.

O resumo ignora **somente** `operationalStatus`: demais filtros, categorias, usuário, períodos e bots continuam ativos. Os contadores podem se sobrepor. `inProgress` inclui toda conversa não finalizada selecionada, inclusive internos e aguardando resposta. `unread` conta conversas, não mensagens. `scheduled` conta agendamentos sem atendimento associado com execução até agora + 24 horas, incluindo atrasados; o filtro operacional `scheduled` usa a mesma janela. Sem esse filtro, a listagem pode mostrar agendamentos posteriores.

Filtros `startedAt`/`finishedAt` se aplicam às conversas; `scheduledAt`/`scheduledTo`, `scheduledBy` e `scheduledFor` se aplicam aos agendamentos e às conversas originadas deles. Internos não entram em filtros de agendamento. Pesquisa por mensagem examina a última mensagem do atendimento e a descrição do agendamento, sem carregar histórico completo. Telefones formatados aceitam também os dígitos. Texto e ordenação não entram em SQL sem parametrização/validação.

Datas completas ISO mantêm seu instante. Datas `YYYY-MM-DD` incluem o dia civil inteiro no fuso do processo; o frontend deve enviar início/fim do dia como ISO com fuso para conservar o dia escolhido no navegador. No modo local, os `DATETIME` legados foram gravados pelo sincronizador com `getHours()`; a leitura compensa o offset atual desse mesmo processo e envia limites locais formatados para o MySQL. Mensagens usam seu `timestamp` absoluto para última atividade e espera. Antes de liberar, confirme que o processo leitor conserva o fuso do gravador; histórico migrado em outro fuso/offset ou anterior a mudanças de horário de verão exige reconciliação de datas. Não se assume que todo `DATETIME` legado seja UTC.

## Espera, SLA e entrega

`monitor:sla_minutes` usa a resolução de parâmetros existente (instância, setor, usuário). Ausente, inválido ou não positivo resulta em `slaMinutes: null` e `slaBreached: null`; nenhuma meta universal é criada. SLA mede apenas espera por atendente em conversas WhatsApp. Internos e agendamentos têm SLA nulo.

A última mensagem é associada por `instance + chatId`, nunca pelo contato. O mesmo contato pode ter atendimentos históricos sem que uma mensagem nova contamine todos eles. Mensagens de `bot`, `system` e `thirdparty` não são tratadas como mensagens do cliente. Um bot ativo continua `in_progress`. Sem atendente ou com mensagem do cliente aguardando resposta humana, a conversa fica `waiting_agent`; a espera começa na primeira mensagem do cliente após a última saída humana confirmada (ou no início da conversa sem mensagem pendente). `waiting_customer` começa na última saída humana confirmada.

Somente saídas humanas `SENT`, `RECEIVED` ou `READ` encerram a espera. Tentativas `PENDING`, `PROCESSING`, `UNKNOWN` e falhas não encerram nem reiniciam esse relógio. O status de entrega da última saída também consulta a tentativa durável central por `messageId` — campo obrigatório no contrato atual — e mantém incerteza explícita. A Monitoria não reenvia mensagens. O modo local depende da sincronização existente: uma mensagem ainda ausente do espelho pode atrasar a exibição da tentativa correspondente.

Não lidas de WhatsApp excluem os remetentes internos acima e são contadas no atendimento. Nos internos, são calculadas pelo `lastReadAt` do usuário participante, excluindo suas próprias mensagens e avisos do sistema. Para supervisor não participante, `unreadCount` é nulo: não existe uma confirmação pessoal de leitura a inferir.

## Consulta, validação e publicação

`monitor:use_local_search` continua escolhendo `wpp_*` no CRM ou as tabelas centrais. Internos permanecem centrais. Categorias no mesmo banco são combinadas por `UNION ALL` com ordenação estável e `LIMIT/OFFSET` no banco. Quando CRM e central precisam ser combinados, uma partição binária encontra o início da página; as sondagens leem duas linhas por banco, e a seleção final lê no máximo duas páginas. Páginas profundas não percorrem nem guardam todos os objetos anteriores. A lista não retorna históricos.

Contagem e resumo são consultas agregadas separadas. O transporte e a memória da aplicação são limitados, mas contagens, correlações de mensagens e ordenações ainda podem examinar muitas linhas no banco. Não houve criação de índices nem afirmação de custo constante: comparar `EXPLAIN`, latência e carga representativa nos dois modos antes de concluir sobre performance em produção. Entre contagem, sondagens e página, alterações concorrentes podem mudar o conjunto; não há snapshot distribuído entre bancos.

Validação local: `npm run test:monitor` executa SQL em duas bases SQLite descartáveis em memória, adaptando funções de época/charset de MySQL. Cobre scoping ADMIN/tenant/setor, limites e injeção, períodos, associações, SLA, falhas/incerteza, filtros por categoria, resumo, ordenações, paginação profunda e histórico. Requer Node com `node:sqlite` (validado em Node 24). Complementar com `npm run test:read-protection` e `npx tsc --noEmit`. Esses testes não substituem um smoke MySQL do ambiente de destino.

Publicar o backend antes do frontend, pois a UI usa `/summary` e o histórico paginado. Fazer smoke autenticado com ADMIN e rejeição com usuário comum, instancia/setor distintos, filtros/períodos, abrir histórico e ações de transferência/finalização. Conferir o fuso do sincronizador, o parâmetro SLA desejado e a sincronização local. Este trabalho não aplicou DDL, migrações, deploy ou mudanças de produção.
