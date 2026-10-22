# Recuperação incremental das conversas da sessão

Implementação local em 22/10/2026, coordenada com `inpulse-frontend`. Demanda central: `planejamento/cross-service/INF-20261022-002-message-sync`.

## Contrato e consistência

- `GET /api/whatsapp/session/chats` mantém o contrato anterior e acrescenta `data.syncCursor`, capturado **antes** de consultar os resumos.
- `GET /api/whatsapp/session/changes?cursor=...&limit=100` é autenticado e usa `protectedRead`. Retorna `data.{changes,nextCursor,hasMore,resetRequired}`.
- `changes` contém `chats`, `messages`, `removedChatIds`, `removedMessageIds`. Resumos são limitados aos chats citados na página. Nenhuma consulta periódica recarrega todos os históricos ou consulta o provedor WhatsApp.
- O cursor é opaco, expira em sete dias e inclui versão, geração da instância, sequência decimal e hash de instância/operador/setor/papel/carteiras atuais. Não é autorização: toda projeção reaplica as permissões no servidor. Alteração de carteira ou escopo exige novo snapshot.
- A página é limitada a 100 registros do journal, incluindo eventos invisíveis ao usuário. Isso limita o trabalho por requisição e permite avançar por eventos de outros operadores sem revelar seus IDs/conteúdo.
- Snapshot e journal têm sobreposição intencional: aplicar mensagens por ID e estado atual torna o replay idempotente. Eventos do socket não avançam o cursor HTTP.

## Gravação durável

A migration `20261022120000_session_changes` cria duas tabelas centrais e nove triggers (insert/update/delete de `messages`, `chats` e `chat_user_preferences`). O journal armazena referências e antigos destinatários, nunca textos ou arquivos.

Cada trigger atualiza o contador de sua instância e escreve o evento dentro da transação do escritor. O lock dessa linha é mantido até commit/rollback: duas transações da mesma instância não publicam sequências em ordem de confirmação invertida. Instâncias distintas têm contadores independentes. BIGINT circula como string; SQL ordena pela coluna numérica, sem usar o alias convertido para texto.

Mensagens sem `chat_id` ainda não são publicadas. A vinculação posterior produz um evento, mesmo que o ID da mensagem seja menor que os já recebidos. Mover uma mensagem também atualiza a conversa anterior. Transferências e encerramentos permitem remover o atendimento da sessão anterior sem devolver seu conteúdo.

O leitor captura head e página na mesma transação curta REPEATABLE READ, sem I/O externo dentro dela. A projeção lê o estado atual depois; ele pode estar adiante da página, e os eventos seguintes continuam sendo consumidos. Não é um histórico imutável de conteúdo.

## Frontend

Uma rotina por sessão/aba consulta a cada 15–18 segundos e aguarda cada requisição terminar. Páginas adicionais têm intervalo de 250 ms. Timeout de 20 segundos e backoff de 30/60/120 segundos, respeitando `Retry-After`.

Reconexão, evento `online`, foco e retorno à aba antecipam a consulta; aba oculta/offline pausa novas buscas. O cursor só avança depois da aplicação. Respostas de sessão anterior são canceladas/descartadas. Eventos do socket ou troca de conversa durante uma leitura invalidam aquela resposta, que é repetida sem avançar o cursor. Os rooms dos chats recuperados são registrados e reinscritos após reconexão.

O replay é silencioso: não repete sons/notificações e não marca mensagens como lidas em segundo plano. Preserva históricos carregados durante deltas, aplica edições/status/remoções e atualiza prévias/não lidas. Um cursor inválido/vencido refaz os resumos e, se necessário, o histórico da conversa própria aberta.

Escopo: atendimentos WhatsApp da sessão. Monitoria, chats internos e mudanças isoladas em contatos ou reações que não alterem `messages` não têm journal dedicado nesta entrega; continuam nos fluxos existentes.

## Retenção e custos

A cada cinco minutos, um worker sem sobreposição percorre até 20 instâncias e elimina até 1000 eventos expirados por instância. Mantém o mesmo lock de publicação e atualiza `floor_sequence` na mesma transação. Só remove prefixo contíguo com mais de sete dias; cursor anterior ao piso provoca reset.

A chave primária `(instance,sequence)` atende a paginação por intervalo. Existe índice de `created_at` para inspeção operacional. A frequência deve ser medida em homologação: 1000 abas visíveis representam aproximadamente 56–67 buscas/segundo, além de autenticação e projeções. Não há coordenação entre abas neste escopo.

## Validação e ativação

- `npm run test:session-changes`: precisão, formato, expiração e isolamento dos cursores.
- `npm run test:session-changes:mysql`: usa exclusivamente MySQL local em `127.0.0.1:13328`, cria schema descartável, executa a migration real e valida commit/rollback, concorrência, vinculação tardia, isolamento, carteira, transferência, remoção, paginação numérica e retenção/EXPLAIN.
- `npm run test:read-protection`, `npm run test:remote-inbound`, `npx tsc --noEmit --pretty false`.
- Frontend: `npm run test:message-sync`, `npm run test:message-sync:e2e`, testes existentes de mensagens e `npx tsc --noEmit --pretty false --incremental false`.

Antes de publicar: integrar os commits em `homolog`, revisar/aplicar a migration no **banco central homolog do WhatsApp**, verificar as nove triggers e executar smoke com socket interrompido e HTTP disponível. Não executar DDL nos bancos CRM dos tenants. Conferir latência p95, leituras/vazão, espera pelo contador, deadlocks e capacidade da retenção sob tráfego equivalente. Os testes locais não medem o tráfego real ou o custo da rede até os CRMs.

Ordem: migration completa → backend → frontend. Não há DDL no startup. A criação dos triggers adquire metadata locks; fazer a ativação em janela controlada. O novo lock de contador pode aumentar contenção e deadlocks em transações que atualizem várias linhas: avaliar em homologação antes de produção.

Rollback de aplicação: restaurar os artefatos anteriores de frontend/backend, mantendo tabelas e triggers para não quebrar gravações em andamento. Não remover as tabelas enquanto existirem triggers. A remoção definitiva do mecanismo requer procedimento separado com escritores controlados.

Nenhum deploy ou DDL em homologação/produção foi executado nesta implementação.
