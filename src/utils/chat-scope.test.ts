import assert from "node:assert/strict";
import { BadRequestError } from "@rgranatodutra/http-errors";
import {
	buildAgentFinishMessage,
	buildAgentTransferHistoryReason,
	buildAgentTransferMessage,
	buildSyntheticSession,
	buildSystemFinishMessage,
	chatScopeFromSession,
	messagesScopeFromSession,
	normalizeInlineText,
	parseOptionalInstance,
	parsePositiveInt
} from "./chat-scope";

const session = (instance: string, sectorId: number) => ({ instance, sectorId, userId: 10, role: "USER", name: "Ana" });

// Abrir chat: só o tenant, sem regra de setor (inclusive na nunes).
assert.deepEqual(chatScopeFromSession(session("nunes", 5)), { instance: "nunes" });
assert.deepEqual(chatScopeFromSession(session("exatron", 2)), { instance: "exatron" });

// Mensagens: regra atual da nunes (setor 3 vê todos os setores).
assert.deepEqual(messagesScopeFromSession(session("nunes", 5)), { instance: "nunes", sectorId: 5 });
assert.deepEqual(messagesScopeFromSession(session("nunes", 3)), { instance: "nunes" });
assert.deepEqual(messagesScopeFromSession(session("exatron", 5)), { instance: "exatron" });
assert.deepEqual(messagesScopeFromSession(session("vollo", 3)), { instance: "vollo" });

// parsePositiveInt
assert.equal(parsePositiveInt(12), 12);
assert.equal(parsePositiveInt("12"), 12);
assert.equal(parsePositiveInt(" 7 "), 7);
assert.equal(parsePositiveInt(0), null);
assert.equal(parsePositiveInt(-3), null);
assert.equal(parsePositiveInt("-3"), null);
assert.equal(parsePositiveInt(1.5), null);
assert.equal(parsePositiveInt("1.5"), null);
assert.equal(parsePositiveInt("12abc"), null);
assert.equal(parsePositiveInt("1e3"), null);
assert.equal(parsePositiveInt(""), null);
assert.equal(parsePositiveInt(Number.NaN), null);
assert.equal(parsePositiveInt(Number.POSITIVE_INFINITY), null);
assert.equal(parsePositiveInt("99999999999999999999"), null);
assert.equal(parsePositiveInt(null), null);
assert.equal(parsePositiveInt(undefined), null);
assert.equal(parsePositiveInt(["12"]), null);
assert.equal(parsePositiveInt(true), null);

// instance opcional das rotas internas.
assert.equal(parseOptionalInstance(undefined), null);
assert.equal(parseOptionalInstance(null), null);
assert.equal(parseOptionalInstance("   "), null);
assert.equal(parseOptionalInstance(" exatron "), "exatron");
assert.throws(() => parseOptionalInstance(["a", "b"]), BadRequestError);
assert.throws(() => parseOptionalInstance(12), BadRequestError);

// Sessão sintética do agente virtual.
assert.deepEqual(buildSyntheticSession("exatron", 4), {
	instance: "exatron",
	userId: -1,
	sectorId: 4,
	role: "ADMIN",
	name: "Agente virtual"
});
assert.deepEqual(buildSyntheticSession("exatron"), {
	instance: "exatron",
	userId: -1,
	sectorId: -1,
	role: "ADMIN",
	name: "Agente virtual"
});
assert.equal(buildSyntheticSession("exatron", null).sectorId, -1);

// normalizeInlineText
assert.equal(normalizeInlineText("  Ana \n  Silva ", 50), "Ana Silva");
assert.equal(normalizeInlineText("   ", 50), null);
assert.equal(normalizeInlineText(undefined, 50), null);
assert.equal(normalizeInlineText(42, 50), null);
assert.equal(normalizeInlineText("abcdef", 3), "abc");

// Transferência pelo agente.
assert.equal(
	buildAgentTransferMessage("Ana", 7, "Fulano de Tal", 12),
	"Atendimento transferido pelo agente virtual “Ana” para Fulano de Tal."
);
assert.equal(
	buildAgentTransferMessage(null, 7, null, 12),
	"Atendimento transferido pelo agente virtual #7 para #12."
);
assert.equal(
	buildAgentTransferMessage("  ", 7, "  Beto\n ", 12),
	"Atendimento transferido pelo agente virtual #7 para Beto."
);
// Não pode parecer assunção humana (“Atendimento transferido por …”) para o ai-service.
assert.equal(buildAgentTransferMessage("Ana", 7, "Beto", 12).startsWith("Atendimento transferido por "), false);

// Encerramento pelo agente: uma única linha “Motivo:” e só quando houver motivo.
assert.equal(buildAgentFinishMessage("Ana", 7), "Atendimento finalizado pelo agente virtual “Ana”.");
assert.equal(buildAgentFinishMessage(null, 7), "Atendimento finalizado pelo agente virtual #7.");
assert.equal(buildAgentFinishMessage("Ana", 7, "   "), "Atendimento finalizado pelo agente virtual “Ana”.");
const withReason = buildAgentFinishMessage("Ana", 7, "Cliente\nencerrou a conversa");
assert.equal(withReason, "Atendimento finalizado pelo agente virtual “Ana”.\nMotivo: Cliente encerrou a conversa");
assert.equal(withReason.split("\n").length, 2);
assert.equal(withReason.match(/Motivo:/g)?.length, 1);
assert.equal(buildAgentFinishMessage("Ana", 7, "x".repeat(900)).length <= 600, true);

// Motivo no histórico de transferência (VARCHAR 255).
assert.equal(buildAgentTransferHistoryReason(7), "Transferência pelo agente virtual #7");
assert.equal(
	buildAgentTransferHistoryReason(7, "Transferência solicitada pelo agente virtual"),
	"Agente virtual #7: Transferência solicitada pelo agente virtual"
);
assert.equal(buildAgentTransferHistoryReason(7, "y".repeat(400)).length, 255);
assert.equal(buildAgentTransferHistoryReason(7, "y".repeat(400)).startsWith("Agente virtual #7: "), true);

// Finalização pelo sistema (sem usuário): texto legado preservado.
assert.equal(buildSystemFinishMessage(null), "Atendimento finalizado pelo sistema.");
assert.equal(
	buildSystemFinishMessage(null, "Inatividade do operador"),
	"Atendimento finalizado pelo sistema.\nMotivo: Inatividade do operador"
);
assert.equal(
	buildSystemFinishMessage(null, "Agendado para 07/10.\nAgendado por Ana."),
	"Atendimento finalizado pelo sistema.\nMotivo: Agendado para 07/10.\nAgendado por Ana."
);
assert.equal(
	buildSystemFinishMessage("Venda realizada", "Pedido confirmado"),
	"Atendimento finalizado pelo sistema.\nResultado: Venda realizada\nMotivo: Pedido confirmado"
);
assert.equal(buildSystemFinishMessage("  "), "Atendimento finalizado pelo sistema.");

console.log("chat-scope tests passed");
