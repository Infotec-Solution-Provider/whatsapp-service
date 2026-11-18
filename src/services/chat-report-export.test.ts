import { strict as assert } from "node:assert";
import test from "node:test";
import { SessionData } from "../sdk-local";
import { assertChatReportSize, buildChatReportQuery } from "./chat-report-export";

const session = { instance: "tenant-a", role: "SUPERVISOR", sectorId: 9 } as SessionData;
const sector = { sectorId: "9" };
const dates = { start: "2026-11-01T03:00:00.000Z", end: "2026-11-02T02:59:59.999Z" };

test("exports only the session tenant and sector through the actual chat relationship", () => {
	const query = buildChatReportQuery(session, { ...sector, ...dates, userId: "1", instance: "other" });
	assert.deepEqual(query.where.WppChat, { is: { instance: "tenant-a", sectorId: 9, userId: 1 } });
	assert.deepEqual(query.where.WppContact, { is: { instance: "tenant-a", isOnlyAdmin: false } });
	assert.equal(query.where.instance, "tenant-a");
	assert.equal(query.where.sentAt?.lte.toISOString(), dates.end);
	assert.equal(query.take, 20_001);
});

test("restricts individual exports, rejects filters from a different scope and never truncates results", () => {
	assert.deepEqual(buildChatReportQuery(session, { ...sector, chatId: "3" }).where.WppChat.is, { instance: "tenant-a", sectorId: 9, id: 3 });
	assert.throws(() => buildChatReportQuery(session, { sectorId: "8", chatId: "3" }), /setor/);
	assert.throws(() => buildChatReportQuery(session, { ...sector, chatId: "3", contactId: "4" }), /origem/);
	assert.throws(() => buildChatReportQuery(session, { ...sector }), /Período/);
	assert.throws(() => buildChatReportQuery({ ...session, role: "OPERATOR" } as SessionData, { ...sector, chatId: "3" }), /setor/);
	assert.throws(() => assertChatReportSize(20_001), /ultrapassou/);
});
