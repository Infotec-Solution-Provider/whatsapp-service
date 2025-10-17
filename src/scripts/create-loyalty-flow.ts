/**
 * Script para criar fluxo de fidelização com tratamento especial
 *
 * REGRAS:
 * - Prioriza operador fidelizado (mesmo offline)
 * - OPERADOR 0 (Sistema) -> Supervisão
 * - OPERADOR -2 (Inválido) -> Supervisão
 * - Sem fidelização -> Supervisão
 *
 * USO:
 * npx ts-node src/scripts/create-loyalty-flow.ts
 */

import { Prisma } from "@prisma/client";
import prismaService from "../services/prisma.service";

function isPrismaError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
	return typeof err === "object" && err !== null && "code" in err;
}

async function createLoyaltyFlowWithSpecialHandling() {
	console.log("🚀 Iniciando criação do fluxo de fidelização...\n");
	console.log("⚠️  IMPORTANTE: Execute 'npx prisma generate' se houver erros de tipo!\n");

	try {
		// Verificar se já existe fluxo similar
		const existingFlow = await prismaService.wppMessageFlow.findFirst({
			where: {
				description: {
					contains: "Fidelização com Tratamento Especial"
				}
			}
		});

		if (existingFlow) {
			console.log("⚠️  Fluxo já existe!");
			console.log(`   ID: ${existingFlow.id}`);
			console.log(`   Instance: ${existingFlow.instance}`);
			console.log(`   Sector: ${existingFlow.sectorId}`);
			console.log("\n❓ Deseja continuar mesmo assim? (Ctrl+C para cancelar)\n");

			// Aguardar 3 segundos
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}

		// Criar o fluxo
		const flow = await prismaService.wppMessageFlow.create({
			data: {
				instance: "vollo",
				sectorId: 1, // Ajuste conforme necessário
				description: "Fidelização com Tratamento Especial (OPERADOR 0/-2)",
				WppMessageFlowStep: {
					create: [
						// ============================================
						// STEP 1: Busca fidelização do cliente
						// ============================================
						{
							type: "QUERY",
							stepNumber: 1,
							config: {
								query: `SELECT 
                          cc.OPERADOR, 
                          cc.FIDELIZA, 
                          c.CODIGO as CUSTOMER_ID,
                          c.NOME as CUSTOMER_NAME
                        FROM campanhas_clientes cc 
                        LEFT JOIN clientes c ON cc.CLIENTE = c.CODIGO 
                        WHERE c.CODIGO = ? 
                        ORDER BY cc.CODIGO DESC 
                        LIMIT 1`,
								params: ["${contact.customerId}"],
								storeAs: "loyalty",
								single: true,
								required: false
							},
							nextStepId: 2,
							fallbackStepId: 100,
							enabled: true,
							description: "Busca informações de fidelização do cliente"
						},

						// ============================================
						// STEP 2: Verifica se tem operador fidelizado
						// ============================================
						{
							type: "CONDITION",
							stepNumber: 2,
							config: {
								field: "loyalty.OPERADOR",
								operator: "exists",
								value: true,
								onTrue: 3,
								onFalse: 100
							},
							enabled: true,
							description: "Verifica se cliente tem operador fidelizado"
						},

						// ============================================
						// STEP 3: Verifica se OPERADOR é 0 (Sistema)
						// ============================================
						{
							type: "CONDITION",
							stepNumber: 3,
							config: {
								field: "loyalty.OPERADOR",
								operator: "equals",
								value: 0,
								onTrue: 100,
								onFalse: 4
							},
							enabled: true,
							description: "Rejeita OPERADOR = 0 (Sistema/Automático)"
						},

						// ============================================
						// STEP 4: Verifica se OPERADOR é -2 (Inválido)
						// ============================================
						{
							type: "CONDITION",
							stepNumber: 4,
							config: {
								field: "loyalty.OPERADOR",
								operator: "equals",
								value: -2,
								onTrue: 100,
								onFalse: 10
							},
							enabled: true,
							description: "Rejeita OPERADOR = -2 (Operador inválido/desativado)"
						},

						// ============================================
						// STEP 10: Atribui para operador fidelizado válido
						// ============================================
						{
							type: "ASSIGN",
							stepNumber: 10,
							config: {
								userId: "${loyalty.OPERADOR}",
								priority: "HIGH",
								systemMessage: "🎯 Cliente fidelizado - Atendimento prioritário pelo operador habitual"
							},
							enabled: true,
							description: "Atribui chat ao operador fidelizado (aceita offline)"
						},

						// ============================================
						// STEP 100: Envia para supervisão/admin
						// ============================================
						{
							type: "ASSIGN",
							stepNumber: 100,
							config: {
								userId: -1,
								priority: "NORMAL",
								systemMessage:
									"⚠️ Cliente sem fidelização válida ou com OPERADOR especial (0/-2). Requer atenção da supervisão para definir atendimento."
							},
							enabled: true,
							description: "Encaminha para supervisão casos sem fidelização ou com operadores especiais"
						}
					]
				}
			},
			include: {
				WppMessageFlowStep: {
					orderBy: {
						stepNumber: "asc"
					}
				}
			}
		});

		console.log("✅ Fluxo criado com sucesso!\n");
		console.log("📋 Detalhes do Fluxo:");
		console.log("═══════════════════════════════════════");
		console.log(`ID do Fluxo:     ${flow.id}`);
		console.log(`Instance:        ${flow.instance}`);
		console.log(`Setor:           ${flow.sectorId}`);
		console.log(`Descrição:       ${flow.description}`);

		// Buscar steps criados
		const steps = await prismaService.wppMessageFlowStep.findMany({
			where: { messageFlowId: flow.id },
			orderBy: { stepNumber: "asc" }
		});

		console.log(`Steps criados:   ${steps.length}`);
		console.log("═══════════════════════════════════════\n");

		console.log("📌 Steps do Fluxo:");
		console.log("───────────────────────────────────────");
		steps.forEach((step) => {
			console.log(`\n[${step.stepNumber}] ${step.type}`);
			console.log(`    ${step.description}`);
			console.log(`    Habilitado: ${step.enabled ? "✅ Sim" : "❌ Não"}`);
			if (step.nextStepId) {
				console.log(`    Próximo step: ${step.nextStepId}`);
			}
			if (step.fallbackStepId) {
				console.log(`    Fallback: ${step.fallbackStepId}`);
			}
		});

		console.log("\n───────────────────────────────────────");
		console.log("\n🎯 Próximos passos:");
		console.log("   1. Verifique se o fluxo foi criado corretamente");
		console.log("   2. Ajuste o sectorId se necessário (atualmente: 1)");
		console.log("   3. Teste com diferentes cenários:");
		console.log("      - Cliente com OPERADOR válido (> 0)");
		console.log("      - Cliente com OPERADOR = 0");
		console.log("      - Cliente com OPERADOR = -2");
		console.log("      - Cliente sem fidelização");
	} catch (error: unknown) {
		console.error("❌ Erro ao criar fluxo:", error);

		if (isPrismaError(error) && error.code === "P2002") {
			console.error("\n⚠️  Erro de duplicidade. Verifique se já existe um fluxo similar.");
		} else if (isPrismaError(error) && error.code === "P2003") {
			console.error("\n⚠️  Erro de chave estrangeira. Verifique se o sectorId existe.");
		}

		throw error;
	} finally {
		await prismaService.$disconnect();
	}
}

// Executar o script
if (require.main === module) {
	createLoyaltyFlowWithSpecialHandling()
		.then(() => {
			console.log("🎉 Script concluído com sucesso!");
			process.exit(0);
		})
		.catch((error) => {
			console.error("\n💥 Falha na execução:", error.message);
			process.exit(1);
		});
}

export default createLoyaltyFlowWithSpecialHandling;
