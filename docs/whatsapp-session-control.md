# Sessões e chamadas nos canais remotos

Esta integração conecta a tela **Canais WhatsApp** e as chamadas na conversa a um `wwebjs-api` com as APIs de gestão e chamadas instaladas. Cada operação usa a instância autenticada e o canal cadastrado no CRM.

## Habilitar em homologação

1. Preparar o host com as migrações de sessões e de histórico de chamadas, a configuração habitual de eventos do CRM e o segredo de monitoramento. Para oferecer whatsmeow no seletor, instalar o bridge Go e configurar seu diretório persistente. A escolha da biblioteca é feita por sessão.
2. No `whatsapp-service`, listar em `WWEBJS_CONTROL_HOSTS` as URLs base dos hosts preparados, separadas por vírgula. Incluir o prefixo do proxy, caso exista. Antes de incluir um host em uso, conferir os pares de instância e ID lógico dos canais existentes em ambos os serviços. O envio nesses hosts passa a resolver a principal pelo par a cada solicitação e acompanha as trocas de papel.
3. Configurar o mesmo `WWEBJS_SESSION_MANAGEMENT_TOKEN` nos dois backends, com pelo menos 32 bytes. A administração pelo CRM exige o papel ADMIN e o parâmetro de monitoramento de sessões já usado pela tela de canais.
4. Para o piloto de chamadas, configurar também `WHATSAPP_CALLS_INTERNAL_KEY` nos dois serviços, com pelo menos 32 bytes. No host, `WHATSAPP_CALLS_SESSIONS` seleciona os IDs físicos das sessões Zapo principais com voz habilitada. O subconjunto autorizado a usar vídeo fica em `WHATSAPP_VIDEO_CALLS_SESSIONS`. O navegador usa o token do atendente no CRM. As credenciais internas ficam nos backends.

## Operar

Em **Canais WhatsApp**, usar **Gerenciar sessões do canal** na linha do número desejado, escolher uma principal Baileys ou Zapo e preparar um shadow. Para um grupo existente, conferir o número esperado. Usar o assistente do grupo para ler cada QR. A promoção de uma sessão exige pareamento do mesmo número e capacidade de envio.

Grupos novos começam em **Somente comparar**. Depois de validar o número pareado e a cobertura, **Entregar também pelo shadow** permite usar a cópia recebida por uma das sessões para o mesmo canal. O host verifica se o receptor aceita a mesma mensagem de forma idempotente durante a transição. Esta opção controla o recebimento no CRM. A promoção troca a sessão responsável pelos envios.

Nas conversas externas abertas e atribuídas ao operador, os controles de chamadas aparecem quando o canal oferece o recurso. O servidor determina o canal pela última mensagem da conversa que tenha canal ou, em um atendimento novo, pelo padrão do setor. O destino é obtido do contato da conversa. Uma única aba assume a chamada. A troca de responsável pela conversa revoga o acesso da aba anterior nas solicitações seguintes.

Validar com uma conta e um celular de homologação. Conferir áudio nos dois sentidos, chamada recebida e originada, recusa, câmera nas duas pontas e liberação do microfone ao desligar. Conferir também que uma promoção preserva o canal do CRM e que mensagens das duas sessões aparecem uma única vez.
