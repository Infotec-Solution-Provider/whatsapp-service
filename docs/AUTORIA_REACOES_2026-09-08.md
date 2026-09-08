# Usuário interno nas reações

Implementação local em `whatsapp-service` e `inpulse-frontend`.

A reação da conta compartilhada registra `internalUserId` e `internalUserName`
da sessão autenticada, depois da confirmação do envio. O nome é um retrato da
sessão no momento da ação. Os dados aparecem na resposta HTTP, nos eventos
socket e no histórico de conversas WhatsApp e grupos sincronizados.

Na interface, passar o mouse sobre a reação mostra o nome. Clicar ou ativar
o botão pelo teclado abre “Quem reagiu”, com nome e código do usuário interno.
A conta WhatsApp continua tendo uma única reação por mensagem: uma alteração
por outro atendente substitui a reação e sua autoria. Não é um histórico de
todas as ações dos atendentes.

## Confirmações e compatibilidade

- A identidade interna vem exclusivamente da sessão; webhooks e payloads do
  navegador não podem escolher esse usuário.
- `sourceEventId` é exposto como campo opcional para correlacionar a resposta
  e o evento da mesma reação. O identificador serializado WWEBJS é normalizado.
- Um evento recebido antes da resposta HTTP pode receber a autoria depois,
  inclusive com timestamps iguais. A tela aceita esse enriquecimento sem
  ressuscitar reações removidas ou substituir outra reação.
- A autoria sobrevive a confirmações do mesmo evento. Um evento mais recente
  de outro dispositivo, sem autor interno comprovado, limpa essa informação.
- Reações antigas não têm autoria recuperável por esta migração. A interface
  mostra “usuário interno não identificado”; nomes não são inferidos pelo
  atendente da conversa nem pelo usuário que está visualizando a tela.

### Limitação do adaptador WWEBJS local

`wwebjs-whatsapp-client.ts` atualmente retorna um UUID sintético em
`sendReaction`, enquanto seu evento recebe o ID real do WhatsApp. A biblioteca
instalada não retorna esse ID em `message.react()`. Assim, a autoria registrada
na confirmação HTTP pode ficar indisponível se um evento não correlacionável
for considerado mais recente, ou se ele chegar primeiro com timestamp maior.
Esta implementação não associa eventos apenas pelo emoji ou proximidade de
horário, pois isso poderia atribuir a um atendente uma ação de outro dispositivo.

Os adaptadores remotos Baileys/Zapo consultados retornam o ID de envio real.
O fluxo de correlação foi validado localmente com testes isolados; não foi
validado com um provedor WhatsApp real nesta alteração.

## Publicação

Aplicar a migração `20260908200000_message_reaction_internal_user` antes de
iniciar o backend atualizado, gerar o Prisma Client e publicar backend/frontend.
A migração acrescenta duas colunas anuláveis, sem backfill ou remoção de dados.

Nenhuma migração foi aplicada ao banco, nenhum serviço foi reiniciado e nenhum
deploy foi realizado nesta tarefa.

## Validação local

- Testes do repositório e serviço: autoria em HTTP/socket/histórico, isolamento,
  substituição por outro atendente, remoção, eventos de dispositivos, chegada
  fora de ordem, concorrência e rejeição de identidade forjada em webhook.
- Testes do frontend: nomes e fallback, botão acessível, enriquecimento de
  autoria, preservação do histórico e ausência de ressurreição de reações.
- Checagem TypeScript dos dois projetos e geração do Prisma Client.
- Banco real, interação em navegador e WhatsApp em produção não validados.
