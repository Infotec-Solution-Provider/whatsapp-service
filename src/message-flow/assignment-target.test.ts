import assert from "node:assert/strict";
import { resolveAssignmentTarget, AssignmentTargetUnavailableError, AssignmentOperator } from "./assignment-target";
const config = { userId: 70, fallbackUserId: 80, fallbackRequireAdmin: true };
const primary: AssignmentOperator = { CODIGO: 70, SETOR: 900, ATIVO: "SIM", NIVEL: "AMBOS" };
const fallback: AssignmentOperator = { CODIGO: 80, SETOR: 900, ATIVO: "SIM", NIVEL: "ADMIN" };
async function main() {
	assert.deepEqual(await resolveAssignmentTarget(config, 900, async () => [primary, fallback]), { userId: 70, reason: "target_valid" });
	for (const invalid of [{ ...primary, ATIVO: "NAO" }, { ...primary, SETOR: 901 }]) {
		assert.deepEqual(await resolveAssignmentTarget(config, 900, async () => [invalid, fallback]), { userId: 80, reason: "target_invalid_fallback" });
	}
	assert.equal((await resolveAssignmentTarget(config, 900, async () => [fallback])).userId, 80);
	await assert.rejects(resolveAssignmentTarget(config, 900, async () => [primary, primary, { ...fallback, NIVEL: "ATIVO" }]), AssignmentTargetUnavailableError);
	await assert.rejects(resolveAssignmentTarget(config, 900, async () => []), AssignmentTargetUnavailableError);
	assert.deepEqual(await resolveAssignmentTarget(config, 900, async () => { throw new Error("CRM down"); }), { userId: 70, reason: "validation_unavailable" });
	console.log("Assignment target tests passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
