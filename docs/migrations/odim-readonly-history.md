# Consulta do histórico Odim sem virada

Arquivo independente dos registros operacionais, criado pelas duas tabelas da migration 20261110160000. O carregador exige snapshot consistente da origem identificada, hashes imutáveis e confirmação explícita. Não executar prisma migrate deploy globalmente em produção: conferir o schema físico e o registro desta aplicação específica primeiro.

`feature_legacy_history_enabled`: booleano textual, default `false`. Escopos existentes INSTANCE, SECTOR e USER; precedência default < instância < setor < usuário, mantendo as restrições existentes para setores globais no perfil access-only. Habilitação inicial somente INSTANCE/odim. Não concede autorização: exige sessão ADMIN, tenant odim, perfil access-only válido e snapshot PUBLISHED. Consumidores: GET /api/whatsapp/odim-history/* e interface atual /odim/historico, menu desktop/mobile. Não habilita provedores, envios ou sockets operacionais.

Todos os identificadores pertencem ao snapshot, separados dos IDs operacionais. Datas civis e referências originais são preservadas. Contagens e hashes completos são validados antes de publicar. Contatos e atendimentos são carregados antes das mensagens; consulta paginada em ordem de ID decrescente. Mensagens sem atendimento podem ser consultadas pelo contato comprovado. Metadados de anexos não significam disponibilidade dos bytes; a interface informa a pendência e não publica caminhos internos.

Ativação: publicar o snapshot validado e inserir o parâmetro da instância com o publicador restrito e recibo privado. Reversão de consulta: restaurar o parâmetro anterior, ocultar o snapshot e restaurar os cinco módulos JS/publicação frontend pelos manifests de backup. Preservar os dados arquivados, sem DROP/DELETE. O canal continua no legado. Isto não conclui a migração operacional, a reconciliação de mudanças posteriores ou a disponibilidade de arquivos.

Validação: testes de fixture MySQL real e Prisma, HTTP/autorização/flags/SQL parametrizado, preservação Unicode e autores especiais, frontend SSR escapado e build Linux. Não importar o main nos testes (inicia workers).
