# Notificações técnicas WABA

`messages[].type = system` entra no `WabaSystemEventsService`, antes do parser e da distribuição. O evento é persistido uma vez pelo `waba_id`, com `type/from = thirdparty:meta`, `status = READ`, data original e `chat_id = NULL`. O payload original continua na fila durável e no registro de processamento.

O canal deve corresponder exatamente à instância, conta Meta e ID de telefone ativos. A vinculação opcional ao contato usa apenas telefone ou WhatsApp ID exatos dentro da instância; ausência, exclusão ou ambiguidade deixam o vínculo vazio. A notificação não cria contato, atendimento, tarefas, mensagens automáticas, chamadas de mídia, atividade do cliente, socket de nova conversa ou renovação da janela de 24 horas.

Não interpretar o texto do aviso para alterar telefone ou fundir contatos. Um aviso pode ser histórico e o número novo já pode pertencer a outro cadastro. O payload fica disponível para uma eventual reconciliação explícita de identidade. Esta entrega não implementa atualização automática de números.

Repetições e concorrência são protegidas pelo índice único existente de `waba_id`. IDs já associados a outra instância/canal/tipo/remetente/data geram erro; a fila mantém o evento para investigação. Avisos produzidos pelo parser antigo permanecem intactos e não voltam à distribuição. O parser comum recusa `system`, e a distribuição também bloqueia registros WABA técnicos antigos, antes de procurar contatos ou executar automações.

## Verificação

```sh
node scripts/test-waba-system-events.cjs
node node_modules/typescript/bin/tsc --pretty false
node scripts/test-waba-system-events.cjs --compiled
```

Os testes usam dependências isoladas, sem bancos, provedores ou envios externos. Incluem replay, colisões, corrida de unicidade, canal/tenant, remetente desconhecido/ambíguo, parser/distribuição reais e lotes mistos com texto, áudio, status e reação. O teste funcional de recebimento real requer um novo aviso da Meta; não fabricar uma mudança de número de cliente em produção.

## Implantação

Publicar somente `services/waba.service.js`, `services/waba-system-events.service.js`, `services/messages-distribution.service.js` e `parsers/waba-message.parser.js`. Conferir hashes dos três módulos preexistentes contra o baseline, criar backup e arquivar logs antes de reiniciar apenas `whatsapp`. Sem DDL, atualização de dependências, parâmetros ou reenvio de mensagens. Os atendimentos antigos não são fechados ou apagados pela correção.

Na reversão, restaurar os três módulos preexistentes do backup e reiniciar apenas `whatsapp`. O helper novo pode permanecer sem consumidores. A reversão de código não modifica os registros técnicos já persistidos.
