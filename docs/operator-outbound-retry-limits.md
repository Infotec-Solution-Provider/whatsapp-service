# Limites de tentativas do envio de operadores

## Incidente de 15/09/2026

O extrato fornecido contém 14 registros `REMOTE` do canal 11, todos sem
`remote_job_id` nem `provider_outcome`, com contadores entre 650 e 24.973.
A maioria estava `PENDING`; um registro estava `PROCESSING`.

O worker reagendava respostas pendentes a cada 2 segundos. Sem ID remoto,
ele só interrompia após 23 horas desde a primeira tentativa. Com ID remoto,
nem esse prazo se aplicava. O adaptador também convertia erros HTTP permanentes,
como 404, 401 e 403, em `PENDING`, apagando a causa com um texto genérico.

`attempt_count` conta execuções do handler remoto, tanto submissões quanto
consultas. Sem `remote_job_id`, o adaptador chama `POST /api/send-message/jobs`
com a mesma chave `operator-outbound:v1:<id>`. Com ID, chama somente `GET`.
O cliente HTTP pode fazer até três chamadas por execução, na configuração padrão.
Esses contadores não provam entregas repetidas no WhatsApp: a submissão depende
da deduplicação do serviço remoto pela chave e pela sessão.

O extrato não permite recuperar o erro HTTP original. Rota ausente ou serviço
remoto incompatível são hipóteses; confirmar pelo destino configurado do canal
e pelos logs de requisições, sem reenviar os conteúdos do incidente.

## Comportamento corrigido

- Até 10 execuções remotas por registro, incluindo a primeira chamada e consultas.
- Prazo de 5 minutos desde a primeira tentativa, com ou sem ID remoto.
- Intervalos de 2, 4, 8, 16 e depois 30 segundos entre execuções pendentes.
- Verificação dos limites antes da chamada e depois de uma resposta pendente.
  Uma chamada já em andamento pode terminar após o prazo; sua confirmação final
  continua válida.
- Ao esgotar os limites, grava `UNKNOWN`, finaliza a mensagem e agenda sua
  notificação pelo fluxo existente. Não há nova submissão automática.
- Erros HTTP 4xx, exceto 408, 425 e 429, encerram como `UNKNOWN` imediatamente;
  a ausência de confirmação não é prova de que a mensagem não foi enviada.
- Diagnóstico HTTP/código de transporte é preservado sem copiar corpos de resposta,
  URLs, credenciais ou conteúdo da mensagem para o erro apresentado.

O contador e a data da primeira tentativa já persistidos impedem que um restart
reinicie o orçamento. Registros antigos acima do limite são finalizados na próxima
aquisição pelo worker, sem chamar o provedor; um registro `PROCESSING` abandonado
aguarda expiração da posse. Um resultado do provedor já persistido tem prioridade
e continua sua finalização local. Estados confirmados como `READ` não regridem.

O prazo começa na primeira tentativa, não na criação do registro. Uma mensagem
que nunca tentou envio continua aguardando a disponibilidade inicial do canal.
Retentativas de sincronização/notificação local não enviam novamente ao provedor.
`UNKNOWN` encerra o acompanhamento automático local; não cancela uma tarefa que
o serviço remoto já tenha aceitado e ainda esteja processando.

## Aplicação e verificação

Não exige migração de banco ou ajuste manual dos registros. Publicar a versão
corrigida do `whatsapp-service` e reiniciar seu processo para aplicar os limites.
Após isso, conferir que os registros vencidos deixam `PENDING`/`PROCESSING`,
recebem `completed_at` e param de incrementar `attempt_count`, além da atualização
de estado na interface. Confirmar a compatibilidade da rota de jobs do canal 11.

Validação local: `npm run test:operator-send`, `npx tsc --noEmit` e
`git diff --check`. Os testes usam dependências isoladas e não comprovam banco,
socket, publicação ou entrega real em produção.
