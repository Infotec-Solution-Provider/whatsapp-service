# Reações WABA em atendimento individual

O cliente WABA implementa o mesmo contrato de reações já utilizado por REMOTE/WWEBJS, sem criar mensagens de texto para representar reações. O envio exige conversa ativa do mesmo tenant/canal, cliente ativo, wamid próprio do alvo, destinatário individual consistente, status SENT/RECEIVED/READ e mensagem de até 30 dias (tolerância de relógio futuro de 5 minutos). Aceita ambas as direções. O dialeto `chat`/`me:odim-legacy-copy` é aceito somente para a cópia Odim verificada pelo tenant/canal.

O provider faz um POST com timeout de 30 segundos. A resposta precisa fornecer um wamid real; rejeição explícita e resultado incerto têm códigos distintos. Nenhuma falha, timeout ou recibo inválido dispara repetição automática. O ID de REMOTE/WWEBJS não serve como fallback para um alvo WABA.

A operação é preparada duravelmente antes do POST e inclui callback opaco. A aceitação e os recibos são materializados pelo journal transacional, sem uma gravação posterior separada de `repository.apply` no sender WABA. Isso permite que falha antecipada, recibo atrasado, substituição e remoção sejam resolvidos pelo mesmo mecanismo. O journal usa SQL parametrizado pela conexão Prisma existente; não requer regeneração do cliente Prisma para consultar a tabela nova. A migration e a implementação da ponte são um pacote separado que deve estar instalado antes de habilitar o recurso.

Eventos recebidos `type=reaction` passam por parser puro e atualizam metadados. Não passam pelo parser de mensagens comuns, distribuição, abertura de atendimento, contador de não lidas ou janela de espera. A entrada verifica account/phone ID e tenant/canal; quando o alvo existe, verifica o peer. Eventos anteriores ao alvo preservam escopo e ator, e a hidratação filtra o ator quando a mensagem chega. Remoções conservam tombstones. Batches são divididos em todos os itens de entry/change/messages/statuses, com limites finitos.

A restrição de ator WABA também se aplica ao watermark de hidratação no repositório: um evento pendente de outro peer não avança `reactionsUpdatedAt`, e uma remoção legítima conserva seu timestamp. A consulta continua em lotes, sem uma consulta extra por mensagem.

Fontes primárias: [coleção oficial Meta](https://www.postman.com/meta/whatsapp-business-platform/overview), operação [Send Reply with Reaction Message](https://www.postman.com/meta/whatsapp-business-platform/request/st3lkd6/send-reply-with-reaction-message) e [tipos do SDK oficial arquivado](https://github.com/WhatsApp/WhatsApp-Nodejs-SDK/blob/main/src/types/messages.ts). A documentação Meta atual respondeu 429 durante a implementação; o limite de idade e os alvos não técnicos são também uma validação conservadora local. Não se atribui à Meta uma restrição de somente mensagens recebidas. O callback já é utilizado pelo envio de health-check existente; o journal também resolve pelo wamid real, sem depender exclusivamente do retorno do callback.

Validação sem conexão externa: `npx tsc --noEmit`, testes de `utils/waba-reaction`, `whatsapp-client/waba-whatsapp-client`, `services/waba-reactions-inbound`, `services/waba-health-status` e `npm run test:reactions`, além dos testes do journal e da ponte no pacote correspondente. Nenhuma reação real foi enviada.

Baselines compilados antes da mudança, iguais aos respectivos arquivos publicados:

| Módulo | SHA-256 produção | SHA-256 homolog |
| --- | --- | --- |
| services/message-reactions.service.js | 331d46c89e6c887c11d66058f031ff658afc747a11b87965c51fe6f379788563 | a77d0e06119ae5cd83f2888f47efa6a2d35ae1fcbfa6ffed7e44eed1b2953d95 |
| services/waba.service.js | 094581d497ee00fd6d03a1769c25f2c67f3f5fbe98290df4c1f5063955830329 | igual à produção |
| whatsapp-client/waba-whatsapp-client.js | e480e21b1f5a1c63c037bb3c88078916c58f25ac4207b8a033ba6944cce9f1ee | igual à produção |
| parsers/waba-message.parser.js | ab151d184a716b18e0eb8790ea3ee4f7cb68737ccfe0b3b95934a061cc7a5fa0 | igual à produção |
| services/message-reactions.repository.js | 80e5d43d62c3a3d5170d61569bb2dcf41a487fc9a2fa008646c78b51999e42fa | igual à produção |

Preservar os demais módulos/overlays do `dist`; não substituir a árvore inteira por uma compilação desta base.
