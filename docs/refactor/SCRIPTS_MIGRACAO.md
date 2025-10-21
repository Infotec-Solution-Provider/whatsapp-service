# 🔧 Scripts de Migração

Scripts úteis para facilitar a refatoração do projeto.

---

## Script 1: Encontrar God Classes

```bash
#!/bin/bash
# find-god-classes.sh

echo "📊 Analisando tamanho dos arquivos..."
echo ""

find src -name "*.ts" -type f -exec wc -l {} + | sort -rn | head -20 | while read lines file; do
    if [ "$lines" -gt 200 ]; then
        echo "🔴 $file - $lines linhas (MUITO GRANDE)"
    elif [ "$lines" -gt 100 ]; then
        echo "🟡 $file - $lines linhas (grande)"
    else
        echo "🟢 $file - $lines linhas"
    fi
done
```

**Uso:**
```bash
chmod +x scripts/find-god-classes.sh
./scripts/find-god-classes.sh
```

---

## Script 2: Encontrar Uso de `any`

```bash
#!/bin/bash
# find-any-types.sh

echo "🔍 Procurando uso de 'any'..."
echo ""

grep -rn "any" src/**/*.ts | grep -v "node_modules" | while IFS=: read file line content; do
    echo "❌ $file:$line"
    echo "   $content"
    echo ""
done | head -50

echo ""
echo "Total de ocorrências:"
grep -r "any" src/**/*.ts | grep -v "node_modules" | wc -l
```

---

## Script 3: Gerar Relatório de Complexidade

```bash
#!/bin/bash
# complexity-report.sh

echo "📊 Relatório de Complexidade Ciclomática"
echo ""

# Instalar: npm install -g complexity-report
cr src/**/*.ts --format markdown > docs/complexity-report.md

echo "✅ Relatório gerado em docs/complexity-report.md"
```

---

## Script 4: Migração Automática - Exemplo

```typescript
// scripts/migrate-to-repository.ts
import { Project, SyntaxKind } from "ts-morph";

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
});

// Encontrar todos services que usam Prisma diretamente
const sourceFiles = project.getSourceFiles("src/services/**/*.ts");

for (const sourceFile of sourceFiles) {
  const imports = sourceFile.getImportDeclarations();
  
  imports.forEach(importDecl => {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    
    // Se importa prismaService
    if (moduleSpecifier === "./prisma.service") {
      console.log(`📝 Encontrado uso em: ${sourceFile.getFilePath()}`);
      
      // TODO: Aplicar transformações
      // 1. Adicionar import do repository
      // 2. Injetar via constructor
      // 3. Substituir chamadas prisma por repository
    }
  });
}

project.save();
```

**Uso:**
```bash
npx ts-node scripts/migrate-to-repository.ts
```

---

## Script 5: Verificar Dependências Circulares

```bash
#!/bin/bash
# check-circular-deps.sh

echo "🔄 Verificando dependências circulares..."
echo ""

npx madge --circular --extensions ts src/

if [ $? -eq 0 ]; then
    echo "✅ Nenhuma dependência circular encontrada!"
else
    echo "❌ Dependências circulares detectadas!"
    echo "Execute: npx madge --circular --extensions ts --image graph.svg src/"
    echo "Para gerar um gráfico visual"
fi
```

---

## Script 6: Executar Todas as Validações

```bash
#!/bin/bash
# validate-all.sh

echo "🔍 Executando todas as validações..."
echo ""

# 1. Type check
echo "1️⃣ TypeScript Check..."
npm run type-check

# 2. Linter
echo "2️⃣ ESLint..."
npm run lint

# 3. Testes
echo "3️⃣ Tests..."
npm test

# 4. Dependências circulares
echo "4️⃣ Circular Dependencies..."
./scripts/check-circular-deps.sh

# 5. Coverage
echo "5️⃣ Test Coverage..."
npm run test:coverage

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Todas as validações passaram!"
else
    echo ""
    echo "❌ Algumas validações falharam!"
    exit 1
fi
```

---

## Script 7: Configuração Inicial do Projeto

```bash
#!/bin/bash
# setup-refactoring.sh

echo "🚀 Configurando projeto para refatoração..."
echo ""

# 1. Instalar dependências de desenvolvimento
echo "📦 Instalando dependências..."
npm install -D \
  jest \
  ts-jest \
  @types/jest \
  supertest \
  @types/supertest \
  eslint \
  @typescript-eslint/parser \
  @typescript-eslint/eslint-plugin \
  prettier \
  eslint-config-prettier \
  madge

# 2. Instalar dependências de produção
npm install \
  tsyringe \
  reflect-metadata \
  zod

# 3. Criar estrutura de pastas
echo "📁 Criando estrutura de pastas..."
mkdir -p src/domain/entities
mkdir -p src/domain/repositories
mkdir -p src/domain/services
mkdir -p src/domain/events
mkdir -p src/application/use-cases
mkdir -p src/application/dtos
mkdir -p src/infrastructure/database/repositories
mkdir -p src/infrastructure/http/controllers
mkdir -p src/infrastructure/http/middlewares
mkdir -p src/shared/errors
mkdir -p src/shared/utils
mkdir -p tests/unit
mkdir -p tests/integration
mkdir -p tests/e2e
mkdir -p docs/architecture/decisions

# 4. Criar arquivos de configuração
echo "⚙️ Criando arquivos de configuração..."

# ESLint
cat > .eslintrc.json << 'EOF'
{
  "parser": "@typescript-eslint/parser",
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier"
  ],
  "rules": {
    "no-console": "warn",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-unused-vars": ["error", { 
      "argsIgnorePattern": "^_" 
    }]
  }
}
EOF

# Prettier (já existe, mas garantir)
cat > .prettierrc << 'EOF'
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": false,
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": true
}
EOF

# Jest config
cat > jest.config.js << 'EOF'
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/main.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  }
};
EOF

# 5. Atualizar package.json scripts
echo "📝 Atualizando scripts no package.json..."
npm pkg set scripts.test="jest"
npm pkg set scripts.test:watch="jest --watch"
npm pkg set scripts.test:coverage="jest --coverage"
npm pkg set scripts.lint="eslint src/**/*.ts"
npm pkg set scripts.lint:fix="eslint src/**/*.ts --fix"
npm pkg set scripts.type-check="tsc --noEmit"

echo ""
echo "✅ Setup concluído!"
echo ""
echo "Próximos passos:"
echo "1. Execute: npm run lint"
echo "2. Execute: npm run type-check"
echo "3. Crie seu primeiro teste"
echo "4. Leia docs/GUIA_IMPLEMENTACAO.md"
```

**Uso:**
```bash
chmod +x scripts/setup-refactoring.sh
./scripts/setup-refactoring.sh
```

---

## Script 8: Template de ADR

```bash
#!/bin/bash
# new-adr.sh

if [ -z "$1" ]; then
    echo "Uso: ./new-adr.sh \"Título da Decisão\""
    exit 1
fi

TITLE=$1
NUMBER=$(ls docs/architecture/decisions/*.md 2>/dev/null | wc -l)
NUMBER=$((NUMBER + 1))
FILENAME=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
FILEPATH="docs/architecture/decisions/$(printf "%03d" $NUMBER)-${FILENAME}.md"

cat > "$FILEPATH" << EOF
# $NUMBER. $TITLE

Data: $(date +%Y-%m-%d)

## Status

Proposto

## Contexto

[Descreva o contexto e o problema que está sendo abordado]

## Decisão

[Descreva a decisão que foi tomada]

## Consequências

### Positivas

- 

### Negativas

- 

## Alternativas Consideradas

1. **Alternativa 1**
   - Prós:
   - Contras:

2. **Alternativa 2**
   - Prós:
   - Contras:

## Referências

- 
EOF

echo "✅ ADR criado: $FILEPATH"
echo "📝 Edite o arquivo para adicionar detalhes"
```

**Uso:**
```bash
chmod +x scripts/new-adr.sh
./scripts/new-adr.sh "Usar Repository Pattern"
```

---

## Script 9: Análise de Imports

```typescript
// scripts/analyze-imports.ts
import { Project } from "ts-morph";
import * as fs from "fs";

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
});

interface ImportAnalysis {
  file: string;
  imports: {
    module: string;
    count: number;
  }[];
}

const results: ImportAnalysis[] = [];

const sourceFiles = project.getSourceFiles("src/**/*.ts");

for (const sourceFile of sourceFiles) {
  const imports = sourceFile.getImportDeclarations();
  
  const importMap = new Map<string, number>();
  
  imports.forEach(imp => {
    const module = imp.getModuleSpecifierValue();
    importMap.set(module, (importMap.get(module) || 0) + 1);
  });
  
  results.push({
    file: sourceFile.getFilePath().replace(process.cwd(), ""),
    imports: Array.from(importMap.entries()).map(([module, count]) => ({
      module,
      count
    }))
  });
}

// Encontrar arquivos mais importados
const allImports = results.flatMap(r => r.imports);
const importCounts = new Map<string, number>();

allImports.forEach(imp => {
  const current = importCounts.get(imp.module) || 0;
  importCounts.set(imp.module, current + 1);
});

const sortedImports = Array.from(importCounts.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

console.log("📊 Arquivos mais importados (Top 20):\n");
sortedImports.forEach(([module, count]) => {
  console.log(`${count}x - ${module}`);
});

// Salvar relatório completo
fs.writeFileSync(
  "docs/import-analysis.json",
  JSON.stringify(results, null, 2)
);

console.log("\n✅ Relatório completo salvo em docs/import-analysis.json");
```

---

## Script 10: Gerador de Boilerplate

```bash
#!/bin/bash
# generate-use-case.sh

if [ -z "$1" ]; then
    echo "Uso: ./generate-use-case.sh NomeDoCasoDeUso"
    exit 1
fi

NAME=$1
LOWER_NAME=$(echo "$NAME" | sed 's/\([A-Z]\)/-\1/g' | sed 's/^-//' | tr '[:upper:]' '[:lower:]')
ENTITY=$(echo "$NAME" | sed 's/UseCase$//')

# Criar Use Case
cat > "src/application/use-cases/${LOWER_NAME}.ts" << EOF
import { injectable, inject } from "tsyringe";

interface ${NAME}Input {
  // TODO: Definir inputs
}

interface ${NAME}Output {
  // TODO: Definir outputs
}

@injectable()
export class $NAME {
  constructor(
    // TODO: Injetar dependências
  ) {}

  async execute(input: ${NAME}Input): Promise<${NAME}Output> {
    // TODO: Implementar lógica
    throw new Error("Not implemented");
  }
}
EOF

# Criar Teste
cat > "tests/unit/application/use-cases/${LOWER_NAME}.test.ts" << EOF
import "reflect-metadata";
import { $NAME } from "@application/use-cases/${LOWER_NAME}";

describe('$NAME', () => {
  let useCase: $NAME;

  beforeEach(() => {
    // TODO: Setup mocks
    useCase = new $NAME(/* dependencies */);
  });

  it('should execute successfully', async () => {
    // Arrange
    const input = {
      // TODO: Define input
    };

    // Act
    const result = await useCase.execute(input);

    // Assert
    expect(result).toBeDefined();
  });
});
EOF

echo "✅ Use Case criado:"
echo "   📄 src/application/use-cases/${LOWER_NAME}.ts"
echo "   🧪 tests/unit/application/use-cases/${LOWER_NAME}.test.ts"
```

**Uso:**
```bash
chmod +x scripts/generate-use-case.sh
./scripts/generate-use-case.sh SendMessageUseCase
```

---

## 📦 Package.json - Scripts Adicionais

Adicione ao seu `package.json`:

```json
{
  "scripts": {
    "analyze:complexity": "cr src/**/*.ts --format markdown > docs/complexity-report.md",
    "analyze:circular": "madge --circular --extensions ts src/",
    "analyze:imports": "ts-node scripts/analyze-imports.ts",
    "find:any": "bash scripts/find-any-types.sh",
    "find:god-classes": "bash scripts/find-god-classes.sh",
    "validate": "bash scripts/validate-all.sh",
    "generate:use-case": "bash scripts/generate-use-case.sh",
    "new:adr": "bash scripts/new-adr.sh"
  }
}
```

---

**Use estes scripts para acelerar e padronizar sua refatoração! 🚀**
