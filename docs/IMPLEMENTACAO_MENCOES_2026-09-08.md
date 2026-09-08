# Menções exibidas como ID — implementação de 08/09/2026

Status: implementação local, ainda sem encerramento em produção da reclamação R-09.

Branch de trabalho nos três repositórios: `fix/reliable-outbound-send-20260908`.
Nenhum commit, push ou deploy foi realizado nesta implementação. `wa-client-lite`
e `inpulse_whatsapp_react` não foram incluídos.

## Motivo e correção

O fluxo não preservava uma representação estruturada da pessoa mencionada até
o histórico e a tela. A exibição também dependia de resoluções diferentes entre
mensagens comuns, grupos, legendas e citações. No parser Baileys, substituir o
identificador diretamente no texto impedia uma nova resolução confiável depois.

| Componente | Correção local de 08/09/2026 |
| --- | --- |
| `wwebjs-api` | Baileys/Zapo mantêm o corpo original e acrescentam identidades de menção em texto, legendas, envelopes e edições; resolução limitada à sessão e com cache limitado. |
| `whatsapp-service` | Persistência JSON separada do corpo; resolução em lote de nomes conhecidos; metadados em histórico, citações, prévias e eventos; edições descartam identidades antigas quando necessário. |
| `inpulse-frontend` | Resolvedor compartilhado para mensagens, legendas, citações, prévias e notificações; nome conhecido ou participante não identificado, com ID acessível nos detalhes da menção. |

LID, telefone e código de usuário interno são identidades distintas. Um LID
numérico não vira telefone pela quantidade de dígitos. Aliases só são ligados
quando o provedor ou cadastro confirma a relação. Nomes manuais de participantes
internos são aplicados somente aos grupos pertinentes à consulta; não há busca
global entre instâncias. O texto original continua disponível para edição/cópia.

## Contrato e compatibilidade

- `mentionEntities` é um campo aditivo no DTO público. Não substitui o contrato
  existente de envio `mentions` nem a relação `InternalMention` de usuários.
- Cada entidade contém `id`, `type` (`lid`, `phone` ou `user`), `tokens` e nome
  opcional. `phone`/`lid` opcionais representam mapeamentos confirmados.
- O cliente remoto limita a extração a 100 pessoas por mensagem. A persistência
  admite até 200 entidades para acomodar código interno e telefone das 100
  seleções já aceitas pelo envio do operador.
- `mention_metadata = NULL` significa que o registro antigo não tem informação
  protocolar suficiente; `[]` significa ausência confirmada de menções.
- Atualização de status ou replay sem mudança de texto preserva metadados;
  edição sem metadados invalida as identidades do texto anterior.
- Não há reescrita em massa das mensagens antigas. Textos já convertidos em
  nomes por versões anteriores não permitem reconstruir o ID original com
  certeza. Históricos sem metadados usam somente os dados conhecidos disponíveis.
- Envio idempotente, reações e sincronização legada mantêm seus contratos. O
  problema separado de eco de reações próprias criptografadas não integra esta
  entrega.

## Banco e publicação

Migração preparada, não aplicada em banco real:
`prisma/migrations/20260908180000_message_mention_metadata/migration.sql`.
Adiciona `mention_metadata JSON NULL` em `messages` e `internalmessages`, sem
alterar o corpo nem a relação de menções internas. O banco de espelhamento legado
não é alterado; a persistência deste recurso fica no banco central do serviço novo.

Ordem recomendada para homologação: revisar e aplicar a migração central, publicar
o backend e o frontend compatíveis e então publicar o cliente remoto. O gerenciador
de migrações deve considerar também as migrações anteriores ainda não aplicadas;
não execute indiscriminadamente um deploy de todas as migrações pendentes.

Não remover a coluna como rollback automático: ela contém os metadados já
recebidos. Em rollback de aplicação, preservar a coluna e os registros.

## Validação e próximo passo

Resultados locais em 08/09/2026:

- Frontend: 35 testes específicos de menções e 93 testes na suíte completa;
  TypeScript e build de produção passaram.
- Serviço: 10 testes de normalização, 15 de hidratação e testes de persistência,
  edição e socket passaram; regressões de envio, reações, inbox remoto e encoding
  legado passaram; TypeScript e `prisma validate` passaram.
- Cliente remoto: suíte completa, testes específicos de menções e TypeScript
  passaram. `git diff --check` passou nos três repositórios.

As verificações locais cobrem normalização/PN-LID, texto original, inclusão e
remoção em edições, persistência e reprocessamento, escopo de nomes, histórico e
renderização, além das regressões de envio confiável e reações. Os comandos
reproduzíveis são `npm run test:mentions` e `npx tsc --noEmit` em cada repositório;
`npm test` no cliente remoto, `npm run test:operator-send`, `npm run test:reactions`
e `npm run test:remote-inbound` no serviço; e `npm run build` no frontend.

Próximo passo: homologar com duas contas reais e um grupo, verificando menção a
contato conhecido, participante sem cadastro, LID sem telefone, múltiplas menções,
legenda e resposta citada. Editar adicionando/removendo menções, reconectar e
recarregar o histórico; conferir nomes, identidade nos detalhes e texto copiado.
Também verificar que uma sequência numérica literal não virou uma menção e que
um nome cadastrado em grupo privado não aparece fora do escopo permitido.

Build e testes locais não comprovam migração MySQL, implantação, reinício de
serviços ou funcionamento ponta a ponta com WhatsApp real. R-09 só pode ser
encerrada após essa validação operacional.
