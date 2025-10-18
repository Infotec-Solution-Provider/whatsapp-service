/**
 * Script de teste para verificar o carregamento de steps
 * 
 * Execute: node scripts/test-flow-data.js
 */

const fetch = require('node-fetch');

const API_URL = 'http://localhost:8005';

async function testFlowData() {
  console.log('🧪 Testando carregamento de dados do Flow...\n');

  try {
    // 1. Busca flows de uma instância
    console.log('1️⃣ Buscando flows da instância "vollo"...');
    const flowsResponse = await fetch(`${API_URL}/api/message-flows?instance=vollo`);
    
    if (!flowsResponse.ok) {
      throw new Error(`HTTP ${flowsResponse.status}: ${flowsResponse.statusText}`);
    }

    const flows = await flowsResponse.json();
    console.log(`   ✅ Encontrados ${flows.length} flows\n`);

    if (flows.length === 0) {
      console.log('⚠️  Nenhum flow encontrado. Crie um flow primeiro.\n');
      return;
    }

    // 2. Pega o primeiro flow
    const flow = flows[0];
    console.log('2️⃣ Analisando primeiro flow:');
    console.log(`   ID: ${flow.id}`);
    console.log(`   Instance: ${flow.instance}`);
    console.log(`   Sector ID: ${flow.sectorId}`);
    console.log(`   Description: ${flow.description || '(sem descrição)'}\n`);

    // 3. Verifica se tem steps
    console.log('3️⃣ Verificando steps:');
    
    if (flow.WppMessageFlowStep) {
      console.log(`   ✅ Steps vieram no objeto flow!`);
      console.log(`   ✅ Propriedade: "WppMessageFlowStep" (nome da relação Prisma)`);
      console.log(`   ✅ Quantidade: ${flow.WppMessageFlowStep.length} steps\n`);

      if (flow.WppMessageFlowStep.length > 0) {
        const firstStep = flow.WppMessageFlowStep[0];
        console.log('4️⃣ Estrutura do primeiro step (Backend):');
        console.log('   {');
        console.log(`     id: ${firstStep.id},`);
        console.log(`     type: "${firstStep.type}",`);
        console.log(`     messageFlowId: ${firstStep.messageFlowId},`);
        console.log(`     stepNumber: ${firstStep.stepNumber},`);
        console.log(`     nextStepId: ${firstStep.nextStepId},`);
        console.log(`     fallbackStepId: ${firstStep.fallbackStepId},`);
        console.log(`     enabled: ${firstStep.enabled},`);
        console.log(`     description: "${firstStep.description || ''}"`);
        console.log('   }\n');

        console.log('5️⃣ Mapeamento necessário (Frontend espera):');
        console.log('   {');
        console.log(`     id: ${firstStep.id},`);
        console.log(`     stepType: "${firstStep.type}",           // type → stepType`);
        console.log(`     flowId: ${firstStep.messageFlowId},      // messageFlowId → flowId`);
        console.log(`     stepNumber: ${firstStep.stepNumber},`);
        console.log(`     nextStepId: ${firstStep.nextStepId},`);
        console.log(`     fallbackStepId: ${firstStep.fallbackStepId},`);
        console.log(`     enabled: ${firstStep.enabled},`);
        console.log(`     config: ${JSON.stringify(firstStep.config || {})},`);
        console.log(`     description: "${firstStep.description || ''}"`);
        console.log('   }\n');
      }
    } else if (flow.steps) {
      console.log(`   ✅ Steps na propriedade "steps" (já mapeado)`);
      console.log(`   ✅ Quantidade: ${flow.steps.length} steps\n`);
    } else {
      console.log(`   ⚠️  Nenhum step encontrado no flow`);
      console.log(`   💡 Steps precisam ser buscados separadamente via API\n`);
    }

    // 4. Teste de busca de steps via API
    console.log('6️⃣ Testando busca de steps via API:');
    const stepsResponse = await fetch(`${API_URL}/api/message-flows/${flow.id}/steps`);
    
    if (!stepsResponse.ok) {
      console.log(`   ⚠️  Endpoint de steps retornou erro: ${stepsResponse.status}\n`);
    } else {
      const steps = await stepsResponse.json();
      console.log(`   ✅ Endpoint retornou ${steps.length} steps\n`);
    }

    console.log('✅ Teste concluído com sucesso!\n');
    console.log('📝 Resumo:');
    console.log('   - Backend retorna steps como "WppMessageFlowStep"');
    console.log('   - Frontend mapeia para "steps" com campos renomeados');
    console.log('   - Mapeamento é feito no componente FlowEditor.tsx');
    console.log('   - Veja docs/flows/DATA_MAPPING.md para detalhes\n');

  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    console.log('\n💡 Certifique-se que:');
    console.log('   1. O servidor está rodando (npm start)');
    console.log('   2. Existe pelo menos um flow cadastrado');
    console.log('   3. A porta 8005 está acessível\n');
  }
}

// Executa o teste
testFlowData();
