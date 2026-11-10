# Leituras durante acesso CRM Odim

O perfil de acesso não expõe chats, mensagens, agendas ou exports externos por ID. A lista de leituras agora contém16templatesExpress exatos; filhos, aliases de rota, recursos brutos e operações futuras ficam423. Nenhum caminho externo por ID chega ao handler antigo sem escopo. Outros tenants mantêm o caminho original.

`getUserChatsBySession` devolve `{chats:[],messages:[]}` imediatamente para Odim com perfil ativo, antes do banco. O Socket atual usa cada `chat.instance` recebido para entrar em salas; a resposta vazia impede entrar em salas externas nessa fase, mesmo se o usuário tiver setorCRM1. O frontend recebe snapshot válido e os parâmetros/canais vazios continuam carregando, sem pendurar `loaded`.

| TemplateGET permitido | Prova do escopo existente |
|---|---|
| `/api/whatsapp/sectors` | Consulta de setores com instance da sessão. |
| `/api/whatsapp/sector/:sectorId/clients` | Odim retorna vazio antes de consultar o setor; demais tenants preservam comparação de identidade revisada. |
| `/api/whatsapp/session/parameters` | INSTANCE/USER filtram instance; scope global de setor ignorado para Odim. |
| `/api/whatsapp/session/chats` | Snapshot externo vazio antes de qualquer query Odim. |
| `/api/whatsapp/session/changes` | Eventos e leituras do serviço de changes filtram instance; reconstrução de chats usa snapshot vazio. |
| `/api/whatsapp/notifications` | findMany/count filtram instance+userId. |
| `/api/whatsapp/contacts` | Contatos filtram instance+isDeleted; inclui somente os vínculos de setor dos contatos selecionados. |
| `/api/whatsapp/contacts/customer` | ContactQueryBuilder começa por instance+isDeleted; enriquecimento CRM/operadores usa a instância e chats do enricher também filtram instance. |
| `/api/whatsapp/customer/:id/contacts` | where instance+customerId+isDeleted; não consulta um contato por IDglobal. |
| `/api/internal/session/chats` | where instance+participação do usuário; mensagens e quoted usam instance. |
| `/api/internal/chats/:id/messages` | Confere instance+participante antes de ler mensagens e quoted com instance. |
| `/api/internal/groups` | Consulta de grupos da instância/sessão e membros, sem provider. |
| `/api/internal/whatsapp-senders/names` | where instance, nome público e ACL de participação/ADMIN; seleciona apenas senderId/displayName. |
| `/api/ready-messages` | where instance+setor, sem dereferenciar setor global de outro tenant. |
| `/api/wallets` | where instance+vínculo do usuário. |
| `/api/results` | Consulta resultados pelo gateway CRM da instância autenticada. |

O guard também cobre identidade de serviço BI depois da autenticação global confiável. Credencial BI Odim recebe423 antes de qualquer rota; credenciais de outros tenants e usuários não mudam. JWT comum passa pelo guard autenticado usual e pela mesma allowlist exata.

As duas mutações de notificações foram retiradas da allowlist Odim: handlers antigos filtram só userId e poderiam atualizar notificações de outro tenant com o mesmo código de operador. Não é necessário esse efeito para carregar o CRM. O POST de resumo de profile-tags também não integra o bootstrap mínimo. As operações internas locais restantes continuam com seus checks de tenant/recurso/autoria e a proteção contra vínculo WhatsApp.

Os endpoints onlyLocal de manutenção não fazem parte da allowlist autenticada deste perfil. A topologia do proxy e o transporte interno continuam sendo gates próprios; esta mudança não afirma que todos os endpoints antigos de manutenção foram auditados ou endurecidos globalmente.
