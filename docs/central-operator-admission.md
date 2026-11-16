# Pausa global com armazenamento central

O modo central usa `operator_runtime_policy` e `operator_runtime_state` no mesmo banco MySQL de `chats`, `chat_user_preferences`, `messages` e `operator_outbound_send`. Não usa o estado do CRM nem move dados. O núcleo e sua migração ficam em `src/operator-runtime/`.

A instância da sessão é canonicalizada antes da seleção do perfil e das chaves de estado. Um perfil dedicado e confiável seleciona as instâncias atendidas pelo núcleo. Perfil inválido falha fechado. Instâncias não selecionadas mantêm o fluxo legado somente depois de conferir que não existe política central persistida ON; apagar ou remover uma instância do perfil não pode desativar uma política ON.

Para instâncias selecionadas, o escritor abre a mesma transação Prisma usada para o atendimento: política compartilhada, operadores em ordem crescente, conversa, escrita e preferência de não lida. A pausa usa os mesmos locks. `pending` e `paused` negam novas atribuições; a mesma atribuição de uma conversa já aberta permanece disponível. Reabrir uma conversa finalizada, iniciar uma agenda ainda não iniciada ou transferir para outro operador exige nova admissão. Início manual confere também o ator, inclusive quando o destino é compartilhado (`-1`). Atividade, permissões e regras de fidelização continuam a cargo das validações existentes.

Respostas em uma conversa aberta pertencente ao operador continuam permitidas. Em conversa compartilhada, o início precisa ser estritamente anterior ao `unavailable_since` persistido. Igualdade ou ausência de evidência nega até Retomar. Os IDs informados precisam corresponder ao contato real da conversa e ao destino efetivo, distinguindo telefone, LID e grupo.

Os envios humanos legados fazem uma transação curta de admissão antes de chamar o provedor. Depois de admitidos, podem terminar durante a pausa. No envio durável, admissão, mensagem e job são gravados na mesma transação. Replay de uma intenção já aceita ocorre antes da nova admissão e preserva `UNKNOWN`, sem reenvio. Instâncias legadas não selecionadas mantêm a criação aninhada original sem transação interativa.

Entradas automáticas continuam recebendo mensagens. Filtros de operadores são orientativos e os escritores repetem a conferência antes de gravar. As filas de distribuição, WABA e Gupshup preservam a entrada e aguardam 30 segundos em `OPERATOR_PAUSED` ou `OPERATOR_AVAILABILITY_UNAVAILABLE`, sem consumir tentativa. Gupshup reutiliza a mensagem já persistida ao retomar uma entrada cujo atendimento ainda não foi criado.

## Escritores conferidos

- Início manual e de sistema, transferência manual, distribuição inicial e transferências por fluxo/bot: `withUnreadAssignment`, com escopo obrigatório.
- Importação de atendimento ativo: guarda e escrita na mesma transação; histórico finalizado mantém o comportamento anterior.
- Texto, arquivo, template e encaminhamento humanos: admissão antes do provedor; o encaminhamento confere todos os destinos antes do primeiro efeito.
- Reação humana externa: admissão antes do despacho.
- Envio durável: transação guardada no repositório, antes de criar mensagem e job.
- Atualizações de avatar, conclusão, resultado, vinculação de cliente, bot e recebimento de reação não criam nova atribuição.

## Validação e ativação

`central-operator-admission.mysql.test.ts` usa Prisma real e um schema local aleatório no MySQL 8. Confere isolamento de instância com o mesmo operador, aliases de caixa, rollback de preferência e job, concorrência nos dois sentidos, reabertura/agendamento, corte em milissegundos, destino real e replay UNKNOWN. `central-operator-admission.test.ts` e `central-operator-queues.test.ts` cobrem contrato e filas sem provedor.

A ativação de uma nova instância deve instalar o perfil antes de habilitar a política, depois de publicar e drenar escritores antigos. A revisão deve comprovar que política/estado e tabelas de escrita pertencem à mesma transação e usam InnoDB. A presença do código e das tabelas não habilita a funcionalidade. O deployer coordena migração, revisão/hash, políticas e rollback; este módulo não executa DDL na inicialização.
