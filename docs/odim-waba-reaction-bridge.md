# Ponte Odim de reações WABA

Base do worker: `df6cd2762980b9dea6e85a52b5f8c426a04f7726`, preservando reconciliador de leitura e cópia de áudio. Dependência ledger: `a84ce60` (cherry-pick local `6adc7fe`). Util `waba-reaction.ts` compartilhado com a implementação principal do provedor.

O ingress autenticado separa cada mensagem de reação como `kind=reaction`, preserva conta e phone-number-id do envelope e usa o wamid do alvo no lookup da cópia. O próprio evento de reação não exige registro em `w_mensagens` nem vira bolha. Lotes normais de mensagem/status mantêm o fluxo existente. Linhas técnicas `TIPO=reaction` do source são ignoradas com avanço do cursor.

O worker continua limitado a 20 eventos pendentes por ciclo. Projeção e decisão APPLIED/PENDING compartilham o BEGIN/COMMIT já pertencente à conexão MySQL do worker; nenhuma instância Prisma ou pool adicional é criada. Conta, phone-number-id, clientId operacional ativo, telefone e peer são validados. Reações entram em `message_reactions` por tenant/client/alvo/ator, com tombstone de remoção e comparação temporal existente. Duplicatas não regravam; remoção vence empate de timestamp. Nenhuma mensagem, chat, flag de leitura ou espera é modificada por esse caminho.

Eventos novos com metadata comprovada podem preceder o alvo. Hidratação SQL e emissão após a cópia do alvo filtram atores externos pelo peer exato; uma reação de outro número não aparece nesse atendimento. Um alvo já pertencente a outro tenant/canal é rejeitado. Eventos antigos `kind=message` com payload `type=reaction` e sem metadata são aceitos apenas após existir alvo com client operacional e peer/lado próprio comprovados. O lookup usa o alvo, permitindo catchup normal desses eventos sem backfill manual.

Recibos de saída passam primeiro pelo `WabaReactionReceiptsService.applyStatus`, na mesma transação e com scope persistido no envelope. A correlação usa callback ou wamid do ledger. Um callback de reação não reconhecido não cai no status de mensagem normal. Snapshot e socket `WppMessageReaction` são emitidos após COMMIT; falha da notificação não desfaz o estado persistido. O fallback normal `applyOdimOwnedProviderStatus` permanece intacto para mensagens ordinárias.

## Módulos runtime

- `dist/scripts/odim-live-copy-sync.js`
- `dist/services/odim-live-copy.ingress.js`
- `dist/services/odim-copy-reactions.js`
- `dist/utils/waba-reaction.js` (util compartilhado)

Dependências existentes/ledger: `services/waba-reaction-receipts.service.js`, `services/message-reactions.types.js`, `services/odim-copy-provider-status.js`, `utils/message-reaction.js`, SDK local. Os módulos de core, áudio e reconciliador de leitura não foram alterados.

## Validação

```text
node node_modules/typescript/bin/tsc --pretty false
node --test scripts/odim-copy-reactions-http.test.cjs scripts/odim-copy-read-reconciliation.test.cjs
git diff --check
```

Compilação e 11 testes locais aprovados. Os três testes HTTP exercitam ingress real, batch, autenticidade, metadata, remoção, payload inválido, acknowledgement durável e ausência de singleton Prisma. Os oito testes existentes do reconciliador preservam leitura, cursores, concorrência, falhas e writer.

`scripts/odim-copy-reactions.mysql.test.cjs` exporta `runOdimCopyReactionSuite({db,compiledRoot,migrationSql,log})` para o adapter QA. Exige banco com nome `homolog-reaction-qa-YYYYMMDD`; cria/amplia somente tabelas fixture desse banco. Os seis grupos cobrem inbound/dedup/remoção/ordem, escopo/foreign, alvo atrasado/legado, rollback sem emissão, precedência do ledger e fallback de status ordinário. O coordenador executou a suíte com MySQL real isolado e informou PASS6; o registro final do plano identifica o artefato exato executado.

Nenhuma DDL de ambiente, publicação, reinício ou reação real é realizada por esses testes.
