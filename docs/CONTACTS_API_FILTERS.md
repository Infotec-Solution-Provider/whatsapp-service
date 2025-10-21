# 🔍 API de Contatos - Filtros e Paginação

## ⚡ ATUALIZADO: Performance 10x Mais Rápida!

> **Novidade:** Implementamos otimizações que tornaram a API **10x mais rápida**!
> - ✅ Paginação no banco (skip/take)
> - ✅ Count otimizado em paralelo
> - ✅ Map lookups O(1)
> - ✅ Busca apenas dados relevantes
>
> 📖 Detalhes completos: [PERFORMANCE_OPTIMIZATIONS.md](./PERFORMANCE_OPTIMIZATIONS.md)  
> 📊 Referência rápida: [PERFORMANCE_QUICK_REFERENCE.md](./PERFORMANCE_QUICK_REFERENCE.md)

---

## Endpoint

```
GET /api/whatsapp/contacts/customer
```

## Parâmetros de Query

### 🔎 Filtros de Contato

| Parâmetro | Tipo | Descrição | Exemplo |
|-----------|------|-----------|---------|
| `name` | string | Filtra por nome do contato (parcial) | `?name=João` |
| `phone` | string | Filtra por telefone (parcial) | `?phone=5511` |
| `customerId` | number | Filtra por ID do cliente | `?customerId=123` |
| `hasCustomer` | boolean | Filtra contatos com/sem cliente | `?hasCustomer=true` |

### 👥 Filtros de Cliente

| Parâmetro | Tipo | Descrição | Exemplo |
|-----------|------|-----------|---------|
| `customerErp` | string | Filtra por código ERP do cliente | `?customerErp=ERP001` |
| `customerCnpj` | string | Filtra por CPF/CNPJ do cliente | `?customerCnpj=12345` |
| `customerName` | string | Filtra por nome/fantasia do cliente | `?customerName=Tech` |

### 📄 Paginação

| Parâmetro | Tipo | Padrão | Máximo | Descrição |
|-----------|------|--------|--------|-----------|
| `page` | number | 1 | - | Número da página |
| `perPage` | number | 50 | 100 | Itens por página |

---

## 📋 Exemplos de Uso

### 1. Listar Todos os Contatos (com paginação padrão)
```bash
GET /api/whatsapp/contacts/customer
```

**Response:**
```json
{
  "message": "Contacts retrieved successfully!",
  "data": [
    {
      "id": 1,
      "name": "João Silva",
      "phone": "5511999999999",
      "customerId": 123,
      "customer": {
        "CODIGO": 123,
        "RAZAO": "Empresa LTDA",
        "FANTASIA": "Empresa",
        "CPF_CNPJ": "12345678000123",
        "COD_ERP": "ERP001"
      },
      "chatingWith": "Maria (Operadora)"
    }
  ],
  "pagination": {
    "page": 1,
    "perPage": 50,
    "total": 150,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### 2. Buscar por Nome do Contato
```bash
GET /api/whatsapp/contacts/customer?name=João
```

### 3. Buscar por Telefone
```bash
GET /api/whatsapp/contacts/customer?phone=5511
```

### 4. Buscar por Cliente Específico
```bash
GET /api/whatsapp/contacts/customer?customerId=123
```

### 5. Apenas Contatos COM Cliente
```bash
GET /api/whatsapp/contacts/customer?hasCustomer=true
```

### 6. Apenas Contatos SEM Cliente
```bash
GET /api/whatsapp/contacts/customer?hasCustomer=false
```

### 7. Buscar por Nome do Cliente
```bash
GET /api/whatsapp/contacts/customer?customerName=Tech
```

### 8. Buscar por CNPJ do Cliente
```bash
GET /api/whatsapp/contacts/customer?customerCnpj=12345678
```

### 9. Buscar por Código ERP
```bash
GET /api/whatsapp/contacts/customer?customerErp=ERP001
```

### 10. Filtros Combinados
```bash
GET /api/whatsapp/contacts/customer?name=João&hasCustomer=true&customerName=Tech
```

### 11. Paginação Customizada
```bash
GET /api/whatsapp/contacts/customer?page=2&perPage=20
```

### 12. Busca Completa
```bash
GET /api/whatsapp/contacts/customer?name=Maria&customerName=Empresa&hasCustomer=true&page=1&perPage=25
```

---

## 🎯 Estrutura de Response

### Com Paginação

```json
{
  "message": "Contacts retrieved successfully!",
  "data": [...],
  "pagination": {
    "page": 1,
    "perPage": 50,
    "total": 150,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### Campos da Paginação

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `page` | number | Página atual |
| `perPage` | number | Itens por página |
| `total` | number | Total de itens encontrados |
| `totalPages` | number | Total de páginas |
| `hasNext` | boolean | Existe próxima página? |
| `hasPrev` | boolean | Existe página anterior? |

---

## 🔧 Lógica de Filtragem

### 1. Filtros de Banco de Dados (Mais Rápidos)
Aplicados diretamente na query do Prisma:
- `name`
- `phone`
- `customerId`
- `hasCustomer`

### 2. Filtros de Cliente (Pós-processamento)
Aplicados após buscar do cache/API:
- `customerErp`
- `customerCnpj`
- `customerName`

**Por quê?** Dados de clientes vêm do cache Redis ou API externa, não do banco.

### 3. Paginação
Aplicada após todos os filtros, sobre o resultado final.

---

## 💡 Casos de Uso

### Frontend: Listagem com Busca

```javascript
// Estado inicial
const [contacts, setContacts] = useState([]);
const [filters, setFilters] = useState({
  name: '',
  customerName: '',
  hasCustomer: null,
  page: 1,
  perPage: 50
});

// Buscar contatos
const fetchContacts = async () => {
  const params = new URLSearchParams();
  
  if (filters.name) params.append('name', filters.name);
  if (filters.customerName) params.append('customerName', filters.customerName);
  if (filters.hasCustomer !== null) params.append('hasCustomer', filters.hasCustomer);
  params.append('page', filters.page);
  params.append('perPage', filters.perPage);
  
  const response = await fetch(`/api/whatsapp/contacts/customer?${params}`);
  const result = await response.json();
  
  setContacts(result.data);
  setPagination(result.pagination);
};
```

### Backend: Exportar Contatos Filtrados

```typescript
// Buscar TODOS os contatos de um cliente específico
const allContacts = await fetch(
  '/api/whatsapp/contacts/customer?customerId=123&perPage=100'
);

// Processar em lotes
let page = 1;
while (true) {
  const response = await fetch(
    `/api/whatsapp/contacts/customer?customerId=123&page=${page}&perPage=100`
  );
  const result = await response.json();
  
  // Processar result.data
  
  if (!result.pagination.hasNext) break;
  page++;
}
```

---

## 🚀 Performance

### Otimizações Implementadas

1. **Cache Redis** - Clientes e usuários em cache (5 min)
2. **Busca Paralela** - Chats e contatos buscados simultaneamente
3. **Filtros no Banco** - Reduz dados processados
4. **Paginação** - Evita retornar todos os dados
5. **Busca em Lote** - Múltiplos clientes/usuários de uma vez

### Limites

| Limite | Valor | Motivo |
|--------|-------|--------|
| Máx. por página | 100 | Performance |
| Padrão por página | 50 | Balance |
| Timeout cache | 5 min | Dados atualizados |

---

## 📊 Testes

### Teste 1: Sem Filtros
```bash
curl "http://localhost:8005/api/whatsapp/contacts/customer" \
  -H "Authorization: Bearer TOKEN"
```

### Teste 2: Com Filtros
```bash
curl "http://localhost:8005/api/whatsapp/contacts/customer?name=João&page=1&perPage=10" \
  -H "Authorization: Bearer TOKEN"
```

### Teste 3: Filtro de Cliente
```bash
curl "http://localhost:8005/api/whatsapp/contacts/customer?customerName=Tech&hasCustomer=true" \
  -H "Authorization: Bearer TOKEN"
```

---

## 🐛 Troubleshooting

### Paginação não funciona
```bash
# Verificar parâmetros
?page=1&perPage=50

# Page deve ser >= 1
# PerPage deve ser entre 1 e 100
```

### Filtros não aplicam
```bash
# Verificar encoding de URL
encodeURIComponent("João Silva") // "Jo%C3%A3o%20Silva"
```

### Performance lenta
```bash
# Reduzir perPage
?perPage=25

# Usar filtros mais específicos
?customerId=123  # Melhor que ?customerName=Empresa
```

---

## 📝 Notas Técnicas

- **Case Insensitive:** Filtros de texto não diferenciam maiúsculas/minúsculas
- **Partial Match:** Filtros fazem busca parcial (LIKE %texto%)
- **Redis Cache:** Clientes/usuários são cacheados por 5 minutos
- **Graceful Degradation:** Se Redis cair, busca direto da API
- **Thread Safe:** Múltiplas requisições simultâneas são seguras

---

## 🎉 Resumo

✅ **9 filtros** disponíveis  
✅ **Paginação** com até 100 itens/página  
✅ **Cache Redis** para performance  
✅ **Filtros combinados** funcionam juntos  
✅ **Response padronizado** com metadados  
✅ **Typesafe** com TypeScript  

**Pronto para uso em produção!** 🚀
