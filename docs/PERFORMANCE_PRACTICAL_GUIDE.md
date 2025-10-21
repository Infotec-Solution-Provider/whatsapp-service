# 💡 Guia Prático - Performance Tips

## 🎯 Como Aproveitar as Otimizações

### ✅ Faça Isso

#### 1. Use Paginação Sempre
```bash
# ✅ BOM
GET /contacts/customer?page=1&perPage=50

# ❌ EVITE (vai buscar tudo)
GET /contacts/customer
```

#### 2. Combine Filtros de Contato
```bash
# ✅ BOM - Filtra no banco primeiro
GET /contacts/customer?name=João&hasCustomer=true&page=1

# ⚠️ OK - Mas mais lento
GET /contacts/customer?customerName=Empresa
```

#### 3. Use perPage Moderado
```bash
# ✅ BOM - Balanceado
?perPage=50

# ✅ OK - Para listagens pequenas
?perPage=20

# ❌ EVITE - Muito pesado
?perPage=100
```

#### 4. Filtros Específicos
```bash
# ✅ BOM - ID exato é mais rápido
GET /contacts/customer?customerId=123

# ⚠️ OK - Mas busca mais dados
GET /contacts/customer?name=João
```

---

## ⚡ Estratégias por Caso de Uso

### Caso 1: Listagem Principal
```bash
# Objetivo: Mostrar todos os contatos paginados
GET /contacts/customer?page=1&perPage=50

# Performance: ~85ms ⚡⚡⚡
# Usa: Paginação no banco
```

### Caso 2: Busca por Nome
```bash
# Objetivo: Encontrar contato específico
GET /contacts/customer?name=João Silva&page=1&perPage=20

# Performance: ~90ms ⚡⚡⚡
# Usa: Filtro no banco + paginação
```

### Caso 3: Contatos com Cliente
```bash
# Objetivo: Listar apenas com cliente vinculado
GET /contacts/customer?hasCustomer=true&page=1&perPage=50

# Performance: ~95ms ⚡⚡⚡
# Usa: Filtro no banco + paginação
```

### Caso 4: Busca por Cliente
```bash
# Objetivo: Encontrar contatos de um cliente específico
GET /contacts/customer?customerId=123

# Performance: ~70ms ⚡⚡⚡⚡
# Usa: Índice de FK no banco
```

### Caso 5: Busca Complexa (Cliente + Contato)
```bash
# Objetivo: Filtros combinados
GET /contacts/customer?name=Maria&customerName=Tech&page=1

# Performance: ~250ms ⚡⚡
# Usa: Filtro contato no banco + pós-processamento cliente
```

### Caso 6: Apenas Filtros de Cliente
```bash
# Objetivo: Buscar por dados do cliente
GET /contacts/customer?customerName=Empresa&page=1

# Performance: ~380ms ⚡
# Usa: Busca todos + pós-processamento
```

---

## 📊 Tabela de Performance Esperada

| Filtros Usados | Performance | Recomendação |
|----------------|-------------|--------------|
| Nenhum | ~85ms ⚡⚡⚡ | ✅ Ótimo para listagem |
| `name` ou `phone` | ~90ms ⚡⚡⚡ | ✅ Ótimo para busca |
| `customerId` | ~70ms ⚡⚡⚡⚡ | ✅ Melhor opção |
| `hasCustomer` | ~95ms ⚡⚡⚡ | ✅ Ótimo para filtros |
| `name` + `customerName` | ~250ms ⚡⚡ | ⚠️ OK para buscas específicas |
| Apenas `customerName` | ~380ms ⚡ | ⚠️ Use com outros filtros |
| `customerCnpj` + `customerErp` | ~400ms ⚡ | ⚠️ Use com filtros contato |

---

## 🚀 Otimização por Frontend

### React/Vue/Angular - Best Practices

#### 1. Debounce em Buscas
```typescript
// ✅ BOM - Aguarda usuário parar de digitar
const debouncedSearch = debounce((name) => {
  api.get(`/contacts/customer?name=${name}&page=1&perPage=20`);
}, 300);

// ❌ EVITE - Dispara a cada tecla
onChange={(e) => {
  api.get(`/contacts/customer?name=${e.target.value}`);
}}
```

#### 2. Cache no Cliente
```typescript
// ✅ BOM - Cache com React Query
const { data } = useQuery(
  ['contacts', page, filters],
  () => fetchContacts(page, filters),
  { staleTime: 60000 } // 1 minuto
);

// ❌ EVITE - Busca sempre
useEffect(() => {
  fetchContacts(page, filters);
}, [page, filters]);
```

#### 3. Paginação Incremental
```typescript
// ✅ BOM - Scroll infinito com páginas pequenas
?page=1&perPage=20
?page=2&perPage=20
// Carrega rápido e progressivamente

// ❌ EVITE - Tudo de uma vez
?page=1&perPage=1000
```

#### 4. Loading States
```typescript
// ✅ BOM - Feedback imediato
{isLoading && <Skeleton />}
{data && <ContactList data={data} />}

// ❌ EVITE - Tela branca enquanto carrega
{data && <ContactList data={data} />}
```

---

## 💾 Padrões de Cache

### Redis Cache (Já Implementado)
```
Customer Data: 5 minutos
User Data: 5 minutos
```

### Client-Side Cache (Recomendado)
```typescript
// React Query / SWR
{
  staleTime: 60000,      // 1 minuto
  cacheTime: 300000,     // 5 minutos
  refetchOnWindowFocus: false
}
```

### Service Worker (Opcional)
```javascript
// Cache API responses
workbox.routing.registerRoute(
  /\/api\/whatsapp\/contacts\/customer/,
  new workbox.strategies.NetworkFirst({
    cacheName: 'contacts-api',
    plugins: [
      new workbox.expiration.Plugin({
        maxEntries: 50,
        maxAgeSeconds: 60 * 5 // 5 minutos
      })
    ]
  })
);
```

---

## 🎯 Quando NÃO Usar Paginação

### 1. Exportação Completa
```typescript
// Para exports (CSV, Excel), buscar tudo
async function exportAllContacts() {
  let allContacts = [];
  let page = 1;
  let hasMore = true;
  
  while (hasMore) {
    const response = await api.get(`/contacts/customer?page=${page}&perPage=100`);
    allContacts = [...allContacts, ...response.data];
    hasMore = response.pagination.hasNext;
    page++;
  }
  
  return exportToCSV(allContacts);
}
```

### 2. Dropdown/Select (Poucos Itens)
```typescript
// Se você sabe que tem poucos resultados
GET /contacts/customer?customerId=123
// Não precisa paginar se retorna 3-5 contatos
```

---

## 📈 Monitoramento em Produção

### 1. Logs de Performance
```typescript
// Adicione no controller
console.log({
  endpoint: 'getContactsWithCustomer',
  filters: JSON.stringify(filters),
  responseTime: endTime - startTime,
  resultCount: data.length,
  fromCache: wasFromCache
});
```

### 2. Alertas
```typescript
// Configure alertas para performance degradada
if (responseTime > 500) {
  logger.warn('Slow API response', {
    endpoint: 'contacts',
    time: responseTime,
    filters
  });
}
```

### 3. Métricas
```typescript
// Prometheus/Grafana
api_response_time_seconds{endpoint="contacts"} 0.085
api_cache_hit_ratio{endpoint="contacts"} 0.85
```

---

## 🔧 Troubleshooting

### Problema: API Ainda Lenta

#### Diagnóstico
```bash
# 1. Verificar logs
tail -f logs/app.log | grep contacts

# 2. Verificar Redis
redis-cli
> DBSIZE
> INFO stats

# 3. Verificar banco
# PostgreSQL
SELECT * FROM pg_stat_activity WHERE query LIKE '%wpp_contact%';
```

#### Soluções
```sql
-- 1. Criar índices se não existem
CREATE INDEX IF NOT EXISTS idx_contact_instance 
  ON wpp_contact(instance);

CREATE INDEX IF NOT EXISTS idx_contact_customer 
  ON wpp_contact(customerId);

-- 2. Analisar tabela
ANALYZE wpp_contact;

-- 3. Vacuum se necessário
VACUUM ANALYZE wpp_contact;
```

### Problema: Muitas Requisições

#### Causa Comum
```typescript
// ❌ Loop de requisições
for (const contact of contacts) {
  const details = await api.get(`/contacts/${contact.id}`);
}
```

#### Solução
```typescript
// ✅ Buscar tudo de uma vez
const contacts = await api.get('/contacts/customer?page=1&perPage=50');
// Já vem com todos os dados
```

### Problema: Cache Desatualizado

#### Diagnóstico
```bash
# Verificar TTL do cache
redis-cli
> TTL customer:instance:123
(integer) 287  # Segundos restantes
```

#### Solução
```typescript
// Invalidar cache quando necessário
await redis.del(`customer:${instance}:${customerId}`);

// Ou aguardar expiração automática (5 min)
```

---

## 📚 Checklist de Implementação

### Frontend ✅
- [ ] Usar paginação em todas as listagens
- [ ] Implementar debounce em buscas
- [ ] Adicionar loading states
- [ ] Cache com React Query/SWR
- [ ] Scroll infinito ou paginação clássica
- [ ] Feedback visual de performance

### Backend ✅ (Já Implementado)
- [x] Paginação no banco
- [x] Count otimizado
- [x] Map lookups
- [x] Redis cache
- [x] Early returns
- [x] Logs de performance

### Infraestrutura
- [ ] Redis configurado (7.x)
- [ ] Índices no banco criados
- [ ] Monitoramento ativo
- [ ] Alertas configurados
- [ ] Backup automático

---

## 🎉 Resultados Esperados

Após implementar estas práticas:

✅ **Listagens:** < 100ms  
✅ **Buscas:** < 200ms  
✅ **Filtros complexos:** < 500ms  
✅ **Cache hit rate:** > 80%  
✅ **Satisfação do usuário:** 📈 Alta  

---

**Última atualização:** 21/10/2025  
**Versão:** 1.0  
**Status:** 📋 Guia de Referência
