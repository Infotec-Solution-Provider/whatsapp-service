# Leitura de chats e pressão de memória

Correção local de 23/09/2026 em conjunto com `inpulse-frontend`.

## Contatos

`ContactEnricher` consulta apenas chats ativos da instância e dos contatos retornados
pela página, selecionando `contactId` e `userId`. Não carrega mensagens, contatos ou
agendamentos relacionados. Havendo mais de um chat ativo, o de maior ID determina
o operador apresentado. Páginas vazias não consultam chats.

Isso também atende enriquecimento de contatos desativados e conflito de cadastro.
A seleção de `use_local_contacts_sync` permanece inalterada.

## Frontend

- A listagem automática do `ContactsProvider` só é carregada na rota de contatos.
  O modal de iniciar conversa mantém sua busca própria e paginada.
- A entrada na aplicação solicita `session/chats?messages=false&contact=true`.
  A lista usa `lastMessage`, `isUnread` e preferências retornadas pelo backend.
- Ao abrir uma conversa, busca seu histórico pelo endpoint existente de detalhe.
  Respostas de aberturas anteriores ou de outra sessão são descartadas e mensagens
  recebidas pelo socket durante a leitura são preservadas.
- Transferir um atendimento atualiza o estado local sem buscar `/session/monitor`.
- A monitoria configurada com `monitor:use_local_search=true` não foi modificada.

O histórico de uma conversa aberta ainda é integral. Paginação desse histórico,
da monitoria local e otimização da rotina `idle-chats` são trabalhos separados.

## Validação e publicação

Backend: `npx ts-node src/services/contact-search-memory.test.ts`,
`npm run test:contact-registration` e `npx tsc --noEmit --pretty false`.

Frontend: `npx vitest run src/lib/process-chats-and-messages.test.ts
src/lib/event-handlers/message-mentions.test.ts
src/lib/event-handlers/message-reaction.test.ts
src/lib/utils/pending-chat-sends.test.ts` (em uma linha) e
`npx tsc --noEmit --pretty false --incremental false`.

Publicar backend e frontend; não há migration. Validar entrada, prévia/não lidas,
abertura/troca rápida de conversas, busca no modal e transferência. Comparar
latência, RSS/heap e operações pendentes em tráfego equivalente após a publicação.
O arquivo de incidente confirma concorrência e pressão, mas não identifica a
origem HTTP de cada consulta nem prova um vazamento nativo. `maxResultRows` é um
máximo acumulado desde a inicialização do processo.

## Recarregamentos repetidos (F5)

Os carregamentos autenticados de chats da sessão (WhatsApp e internos), listas e
pesquisa de contatos e monitoria (busca local e endpoints legados) passam por
`protectedRead`, após autenticação e verificação de administrador quando exigida.

- Limites compartilhados entre essas rotas: 4 operações diferentes em andamento e
  30 requisições por janela de 10 segundos, por instância + usuário.
- Consultas idênticas compartilham o trabalho ainda em andamento. A chave inclui
  operação, sessão completa (inclusive setor/papel), parâmetros, query e body,
  em ordem canônica e com hash. Token e IP não são utilizados como identidade.
- Cada operação admite até 8 conexões aguardando. Desconectar remove apenas aquele
  aguardante. O limite da operação só é liberado quando ela resolve/rejeita.
- Não há cache de resultados concluídos, fila de operações ou retries de consultas.
  Erros liberam a operação e chegam aos aguardantes que continuam conectados.
- As estruturas são limitadas a 5000 identidades por processo. Identidades sem
  trabalho ativo e com janela expirada são removidas na próxima requisição.
- O excesso recebe HTTP 429, `Retry-After` e código `READ_REQUEST_LIMIT`. O SDK
  apresenta uma notificação de espera deduplicada e não repete automaticamente.

O controle é em memória por processo. Ele cobre o processo único atual; múltiplos
processos/réplicas teriam cotas independentes e exigiriam coordenação adicional.
Chamadas de autenticação anteriores ao controle e outras rotas não entram nessa
cota. Envios, webhooks e operações de escrita não usam esse compartilhamento.

Validação: `npm run test:read-protection` inclui desconexão seguida de recarga,
concorrência, frequência, limite de aguardantes, isolamento, falha e limpeza.
Frontend: `npx vitest run src/lib/utils/read-request-limit.test.ts`.
