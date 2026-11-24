# Integração CIAG v1

O CIAG usa a instância, setor e conexão WABA exclusivos do seu número. Contatos, histórico, arquivos e comunicação com a Meta permanecem no Inpulse. Listas, agendamentos e seleção de usuários permanecem no CIAG. Esta integração não inicia bots ou fluxos automáticos no número do CIAG.

As conversas CIAG são criadas no histórico central sob o lock do contato e no setor vinculado. As mensagens dessa conexão não são replicadas para um banco CRM de tenant: não cadastre um espelho do banco CIAG no serviço legado de instâncias. Os testes exercitam os serviços reais de persistência e proíbem consultas ao CRM legado. Uploads cujo conteúdo já existe no serviço de arquivos reutilizam seu vínculo sem erro de duplicidade.

## Publicação e ativação

1. Faça backup do banco e dos arquivos. Instale dependências com o lockfile, execute `npx prisma generate` e `npx prisma migrate deploy` e compile com `npx tsc --noEmit`. A migração `20261123190000_add_ciag_integration` adiciona seis tabelas, sem alterar as tabelas atuais.
2. Configure `WABA_GRAPH_API_VERSION=v27.0`, o `WABA_WEBHOOK_TOKEN` de verificação e o **App Secret** em `WABA_APP_SECRET`. Para vários aplicativos, use `WABA_APP_SECRETS` como JSON indexado por `phone_number_id`. Não confunda App Secret com o access token da conta. As notificações POST sem assinatura válida são recusadas; configure os secrets de todos os números WABA existentes antes de atualizar o serviço.
3. Prepare uma instância dedicada, um setor e uma conexão WABA ativa no Inpulse. Associe a conexão ao setor e escolha-a como padrão. Cadastre WABA Account ID, Phone Number ID e access token de usuário do sistema com as permissões de mensagens e gerenciamento necessárias. Configure o recebimento em `/api/whatsapp/waba/INSTANCIA/webhooks`, assine o campo `messages` e confirme o desafio GET com o verify token.
4. Defina temporariamente `CIAG_INSTANCE`, `CIAG_CLIENT_ID` e `CIAG_SECTOR_ID` no ambiente privado e execute `npm run ciag:provision`. O comando valida o vínculo e apresenta uma chave nova uma única vez. Guarde-a diretamente no ambiente privado do CIAG como `INPULSE_API_KEY`; não cole em issues, commits ou frontend. Reexecutar o provisionamento rotaciona a chave anterior.
5. Configure `CIAG_INTEGRATION_ENABLED=true` e reinicie o serviço. Configure a origem do Inpulse no CIAG. Em Configurações, teste a conexão (GET na Meta, sem envio), sincronize modelos e homologue com destinatários de teste. Habilite os envios no CIAG somente após essa validação.
6. Valide todos os tipos de mídia e webhooks com o número oficial, inclusive o acesso do files-service às mídias WABA. FFmpeg e FFprobe com libopus são necessários para gravações. As confirmações de entrega dependem da Meta e das configurações do destinatário.

O número precisa ser exclusivo: a chave não aceita um `instance`, `clientId` ou `sectorId` arbitrário enviado pelo CIAG. Os valores são obtidos do registro provisionado e validados contra a conexão. A operação esperada é um servidor do serviço; locks persistidos protegem contatos e envios contra concorrência e reinícios.

## Compatibilidade na implantação existente

A branch de publicação parte da revisão em produção, preservando as correções existentes de envio WABA, health checks, eventos incrementais de sessão e classificação de resultados incertos. `WABA_GRAPH_API_VERSIONS` permite um JSON por `phone_number_id`: o CIAG deve usar `v27.0`; a versão das demais conexões pode ser mantida por `WABA_GRAPH_API_VERSION` até sua homologação.

Por padrão, todos os webhooks exigem assinatura. Durante a migração de uma instalação anterior, `WABA_LEGACY_UNSIGNED_INSTANCES` pode listar explicitamente instâncias que ainda não têm App Secret configurado. Essa exceção temporária preserva o recebimento legado; nunca se aplica a uma instância CIAG provisionada. Assim que existir um App Secret para o número, sua assinatura passa a ser obrigatória mesmo nessa lista. Remova as entradas após configurar todos os secrets. A exceção não dispensa validar instância, conexão, persistência, lotes e deduplicação.

Em ambientes que receberam ajustes diretamente no JavaScript compilado, preserve o runtime ativo. A publicação CIAG foi validada também sobre esse runtime: o delta afeta somente os módulos necessários, mantém os demais arquivos idênticos e confere hashes antes de instalar. Preserve os controles de acesso, rotas administrativas, reações, tratamento de recibos e políticas operacionais existentes. Não substitua todo o `dist` nem rode instalação de dependências sobre o processo em uso. A referência TypeScript, os artefatos, o manifesto de hashes e os backups da publicação devem ser mantidos juntos. `CIAG_TEST_COMPILED_ENTRY` permite executar a mesma suíte CIAG contra o arquivo JavaScript de testes de um candidato compilado, com banco descartável.

O ambiente existente não possui histórico Prisma de migrações. Nesse caso, execute somente o SQL aditivo das seis tabelas CIAG após backup; não execute migrações históricas sobre um banco já em uso. Confirme as tabelas e gere o cliente Prisma antes de iniciar a release.

### Mídias no armazenamento central

Cadastre um armazenamento `server` padrão exclusivo para a instância `ciag` no serviço de arquivos. O adaptador CIAG faz o upload e o download na Meta pela conexão WABA vinculada, com a versão Graph do número, e mantém os arquivos no armazenamento central existente. Não é necessário um agente Windows para esse número. Outras instâncias conservam seu transporte anterior.

No `uploadFile` do serviço de arquivos legado, a conversão automática para MP3 deve usar `instance !== "ciag" && file.mimetype.startsWith("audio/")`. O CIAG já valida o conteúdo e converte gravações para OGG/Opus antes de armazená-las; converter novamente destruiria o formato de mensagem de voz. Preserve os bytes recebidos da Meta e os arquivos validados do CIAG. A conversão dos demais clientes continua igual. Confira o cabeçalho `OggS` e a reprodução após baixar pelo proxy autenticado.

As conversas CIAG usam o histórico central e não consultam um servidor CRM legado por instância. O worker e o recebimento criam a conversa no escopo da integração sob o lock persistente do contato. A deduplicação de arquivos do serviço existente também é preservada: uploads repetidos podem devolver o mesmo identificador sem criar outro registro de propriedade.

Instale o middleware compilado de `src/integrations/ciag/files-guard.ts` no serviço de arquivos, antes das rotas de arquivos, fornecendo consultas do proprietário real do arquivo e de seu identificador público. A rota multipart deve também chamar `allowCiagFilesAccess` após o parser. Defina `CIAG_FILES_SERVICE_KEY` no ambiente privado do WhatsApp e seu SHA-256 como `CIAG_FILES_SERVICE_KEY_HASH` no serviço de arquivos. Não exponha essa chave no frontend. A proteção abrange download, visualização, metadados, consulta por hash, exclusão, upload e os caminhos públicos legados dos arquivos CIAG; o proxy autenticado sozinho não protege essas URLs antigas. Valide acesso sem chave tanto pelo proxy quanto pelas URLs antigas. Preserve os clientes de armazenamento dos demais tenants ao publicar.

## Contrato HTTP

Prefixo `/api/integrations/ciag/v1`, com `Authorization: Bearer CHAVE_DE_SERVICO`. A chave é armazenada somente como SHA-256. Respostas são JSON direto, sem envelope `data`; erros são `{ "error": "..." }` com status HTTP. Chaves inválidas retornam 401; dados de outro escopo não são expostos.

| Método | Rota | Uso |
| --- | --- | --- |
| GET | `/status` | Estado e número, sem segredos; `?test=true` verifica a conexão Meta. |
| GET | `/contacts` | Contatos do número/setor, autorização, bloqueios, não lidas e última entrada. |
| POST | `/contacts/upsert` | `{phone,name}`, com correspondência exata do número internacional. |
| POST | `/contacts/consent` | `{phone,status,evidence,actor}`, para autorização ou descadastro auditado. |
| GET | `/templates` | Modelos e componentes; `?refresh=true` atualiza o cache de até 60 segundos. |
| POST | `/content/validate` | `{content}`, valida modelo, parâmetros, mídia e propriedade do arquivo, sem envio. |
| GET | `/messages` | `?phone=...&beforeId=...`, até 50 mensagens e cursor da página anterior. |
| POST | `/messages/read` | `{phone}`, atualiza a leitura da caixa compartilhada sem alterar entrega. |
| POST | `/messages` | Enfileira envio idempotente com `{externalId,phone,content,actor,broadcast}`. |
| GET | `/messages/result` | `?externalId=...`, retorna a mensagem ou `null` se não foi submetida. |
| POST | `/messages/cancel` | `{externalId}`, cancela apenas um envio ainda na fila. |
| POST | `/media` | Multipart, parte `file` e `voice=true` opcional, após autenticação. |
| GET | `/media/:id` | Arquivo pertencente à integração ou presente em mensagens do seu número. |

`content` é `{kind:"text",text}`, `{kind:"media",text?,media:{id,...}}` ou `{kind:"template",template:{id,name,language,variables,media?}}`. Metadados do arquivo são conferidos no files-service. `variables` usa chaves `header:1`, `body:1`, nomes dos parâmetros ou `button:0:1` para URL dinâmica; códigos de cupom usam `button:0:coupon_code`. A mídia deve corresponder ao cabeçalho aprovado. Nome e identificação do operador CIAG ficam na auditoria e histórico; o texto digitado não ganha prefixo automático.

## Filas, falhas e segurança

- `ciag_outbound` armazena a requisição antes do envio; `(integration_id,external_id)` é único. A mesma chave com conteúdo diferente retorna 409. Repetir uma requisição ou consulta após perder a resposta HTTP não cria outra mensagem.
- Os workers usam leases e locks persistidos por contato. Mensagem pendente e vínculo com o item da fila são gravados atomicamente. Antes de chamar a Meta, o worker registra `sending`. Uma interrupção após esse ponto é `unknown`, sem reenvio automático. Recusas explícitas por limite podem ser repetidas com espera progressiva.
- `queued`, `sending`, `sent`, `delivered`, `read`, `failed`, `unknown` e `cancelled` são estados públicos. Aceite HTTP não comprova entrega. Eventos de status atrasados não revertem leitura ou entrega.
- Webhooks são verificados sobre os bytes originais, validados por WABA Account ID e Phone Number ID, separados em todos os itens e persistidos antes do ACK. Falha de persistência retorna 503. Reentregas têm chave determinística. O fluxo de filas de outros números continua usando o processamento já existente.
- Autorizações são mantidas por número e exigidas em transmissões ou ao iniciar contato por modelo. Respostas livres exigem entrada do cliente nas últimas 24 horas. Mensagens exatas SAIR, PARAR, STOP, CANCELAR MENSAGENS e NÃO QUERO RECEBER MENSAGENS revogam a autorização; demais pedidos podem ser registrados pelo operador. O descadastro impede todos os novos envios até uma nova autorização registrada.
- O proxy deve encaminhar o cabeçalho `Authorization` e os cabeçalhos de assinatura Meta. Somente `/api/integrations/ciag/v1/media` precisa permitir corpo de 101 MB e timeout de 150 segundos. Não habilite CORS amplo para expor a chave ao navegador.
- As APIs não retornam segredos. Antes de publicar, verifique logs e políticas do proxy para não registrar cabeçalhos de autorização. Os secrets da Meta permanecem no ambiente privado existente.

## Testes e reversão

`npx tsc --noEmit` verifica tipos. Configure `MYSQL_TEST_HOST`, `MYSQL_TEST_USER` e `MYSQL_TEST_PASSWORD` em um MySQL exclusivo de testes e execute `npm run test:ciag`. O comando cria e remove um schema `ciag_autotest_*`, substitui chamadas externas por simuladores e cobre isolamento, concorrência, idempotência, perda de resposta, consentimento, cancelamento, mídia, webhooks em lote e conversão real de áudio.

Monitore `ciag_outbound` por estado/idade, `ciag_audit` e `waba_webhook_queue` por falha/pendência. Para reverter, primeiro desabilite os envios CIAG e o worker da integração, aguarde operações em andamento e preserve todas as tabelas novas e arquivos. Não apague deduplicação nem reenvie itens `unknown` depois de restaurar um backup. A release anterior pode operar com as tabelas adicionais presentes.
