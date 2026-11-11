# Não lida ao atribuir atendimento

Demanda: `INF-20261111-001-assigned-chat-unread`, em `planejamento/cross-service/` do workspace.

O status READ das mensagens pode pertencer à leitura do atendente anterior. Ele não comprova que o novo destinatário viu o atendimento. O resumo usado pelo polling considera mensagens pendentes e a preferência pessoal `chat_user_preferences.is_marked_unread`.

A criação receptiva, a criação pelo sistema e as transferências manual e automática agora gravam a atribuição e essa preferência do operador positivo na mesma transação Prisma. O upsert preserva fixação. Os triggers existentes publicam ambos no journal, sem migration nova e sem I/O HTTP/CRM dentro da transação. Falha na preferência impede confirmar a atribuição. Início manual pelo próprio operador mantém o fluxo anterior.

A leitura limpa a preferência do usuário autenticado antes da sincronização opcional com o CRM. O evento `wpp_contact_messages_read` inclui `userId` opcional; o frontend usa esse campo para não limpar a pendência de outro destinatário. A atualização central das mensagens também filtra a instância.

Escopo: atendimentos atribuídos diretamente a um operador (`userId > 0`). Filas sem operador, carteira compartilhada, destinatário administrativo `-1`, monitoria e chats internos conservam suas regras anteriores. Não há backfill: chats antigos não devem ser marcados em massa sem identificar o que já foi visto. O retorno ao operador anterior específico do bot Nunes não passa pelas transferências automáticas deste serviço e permanece fora desta alteração.

Validação: `npm run test:assigned-chat-unread`, `npm run test:session-changes`, `npx tsc --noEmit`. O primeiro executa serviços reais e projeção de resumos com doubles de banco e transporte; não demonstra isolamento/locks do MySQL. Validar migration/journal já existentes e transferência com mensagens READ em homolog, incluindo reload e leitura em duas sessões, antes de publicar. Publicar backend e frontend compatíveis juntos. Restaurar os artefatos anteriores reverte o comportamento; preferências gravadas permanecem até leitura/alteração manual.
