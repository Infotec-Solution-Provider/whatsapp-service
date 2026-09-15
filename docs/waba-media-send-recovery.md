# Envio de mídia pelo WhatsApp oficial

O envio consulta o cache de mídia do `files-service`. O cache agora registra a
data do upload na Meta, renova antes de completar 30 dias e renova registros
antigos que ainda não têm essa data. O prazo escolhido é 27 dias. A data de
criação do arquivo não é usada como data do upload.

Se a Meta rejeitar explicitamente o ID do anexo com HTTP 4xx, código 100 e a
mensagem de mídia inválida correspondente ao tipo enviado, o cliente pede um
novo ID passando `rejectedMediaId` ao serviço de arquivos. Só depois de obter
um ID diferente faz **uma** nova tentativa. Uma segunda rejeição encerra a
tentativa; não existe repetição ilimitada.

| Resultado | Tentativa durável | Mensagem no histórico | Interface |
| --- | --- | --- | --- |
| Falha na preparação, antes do envio | FAILED | ERROR | Falha e recuperação manual do rascunho |
| Rejeição explícita, não transitória, da Meta | FAILED | ERROR | Motivo da falha e recuperação manual |
| Timeout, conexão interrompida, erro transitório ou resposta sem ID | UNKNOWN | UNKNOWN | Resultado incerto, sem reenvio automático |
| Resposta da Meta com ID válido | SENT | SENT ou confirmação posterior | Fluxo normal de confirmação |

Erros de gateway/servidor e respostas que contenham um recibo não são tratados
como rejeição segura. A falha no segundo envio, depois da renovação, também
permanece UNKNOWN quando o resultado for ambíguo. Os logs retêm código,
subcódigo, referência e mensagem da Meta, sem os headers e o objeto Axios.
O motivo seguro chega ao frontend por `sendError`, inclusive por consulta,
socket e recarga do histórico. No frontend, recuperar significa restaurar o
rascunho; o operador precisa enviá-lo explicitamente.

## Atualização

1. Atualize o `files-service` seguindo
   [o procedimento do cache](../../files-service/docs/waba-media-cache.md).
   A migration `20260914213000_waba_media_uploaded_at` deve ser aplicada no
   **banco do files-service**, antes de iniciar seu novo runtime.
2. Atualize o `whatsapp-service` e execute `npm run test:operator-send` e
   `npx tsc --noEmit` (e o build usado pelo ambiente, se executar `dist`).
   Reinicie a aplicação PM2 correspondente com `--update-env`.
3. Faça o build e a publicação do `inpulse-frontend` para exibir a classificação
   corrigida e o motivo. Não é necessário alterar o `wwebjs-api`.
4. Valide um envio real pelo canal oficial: mídia aceita com `wabaId`, motivo
   visível em uma rejeição controlada e nenhuma repetição em resultado incerto.

Os testes locais usam uploads, banco e respostas da Meta simulados. Não provam
deploy, migração MySQL, reinício PM2, upload pelo storage-client ou entrega real.
A primeira utilização de cada cache antigo exige um upload adicional.

Não há alteração automática nos registros antigos `UNKNOWN`, nem reenvio das
mensagens deste incidente. A mensagem genérica antiga não permite reconstruir
a resposta original da Meta ou confirmar a entrega.

Referência: [retenção de mídia documentada pela Meta](https://whatsappbusiness.com/blog/media-messages-via-app/).
