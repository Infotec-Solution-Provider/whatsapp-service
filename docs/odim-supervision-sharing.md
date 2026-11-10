# Odim: carteira compartilhada da supervisão

Os usuários CRM 6 e 9, autenticados como ADMIN, veem também os atendimentos ativos do outro usuário no mesmo setor da sessão. O setor é o atual da sessão; não há dependência do antigo setor CRM 1. A autoria e o proprietário do chat permanecem individuais, assim como fixação e marcação manual de não lido.

A regra recupera o compartilhamento de atendimentos de `inpulse_whatsapp_react/src/contexts/user/AttendancesContext.tsx:87` do legado. Não altera calendário, telefonia, agendamento, distribuição, fidelização, permissões de transferência ou outros tenants.

O mesmo escopo é aplicado ao snapshot da sessão, preferências e projeção incremental. A revisão `odim-supervision-sharing-v1` muda somente os cursores dos supervisores beneficiados, fazendo sessões existentes recarregarem um snapshot com os chats antigos do par. Ao sair do par, o journal remove o chat das duas listas.

Novos atendimentos e transferências geram aviso na sala pessoal do outro supervisor somente após consulta restrita de `operadores.CODIGO,NIVEL,ATIVO,SETOR`: ele precisa continuar ADMIN, ativo e no setor do chat. Falha do CRM omite esse aviso; o journal continua reparando a lista. A transferência 6↔9 no mesmo setor preserva o chat aberto porque o frontend atual remove a conversa ao receber `wpp_chat_transfer`; a projeção incremental atualiza o proprietário. Sair do par conserva o evento normal de remoção. O bootstrap do socket usa o snapshot de sessão e entra nas salas dos chats compartilhados.

Os chats trazidos pela ponte Odim existente convergem pelo journal/polling já usado pela interface. A ponte não passa por `notifyChatStarted` e sua latência de atualização permanece a do fluxo de sincronização existente.

Validação isolada, sem MySQL, provedores ou envio real:

```
node node_modules/typescript/bin/tsc --noEmit
node node_modules/ts-node/dist/bin.js src/services/odim-supervision-sharing.test.ts
node node_modules/ts-node/dist/bin.js src/services/session-changes/session-change-cursor.test.ts
```

O teste novo exercita os métodos reais de snapshot, preferências, journal, transferência e aviso de novo chat com dependências isoladas; inclui setor divergente, tenant estrangeiro, papel incompatível, receptor desativado, indisponibilidade do CRM e invalidação seletiva do cursor antigo. Não demonstra uso autenticado do navegador nem envio por provedor real.
