import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import type { WppSchedule } from "@prisma/client";
import type { SessionData } from "../sdk-local";
import { operatorFeatureProfilePath, OperatorFeatureError } from "./rollout";

test("real schedule service cannot backdate acceptance, switch tenant or target a nonpilot", async () => {
	assert.equal(fs.existsSync(operatorFeatureProfilePath), false);
	fs.writeFileSync(operatorFeatureProfilePath, JSON.stringify({ version: 1, instance: "odim", allowedOperatorIds: [534], effectiveAt: "2026-11-16T12:00:00.123Z", features: { operator: true, telephony: true, crm: true, whatsapp: true } }), { flag: "wx", mode: 0o600 });
	const original: WppSchedule = { id: 1, instance: "odim", contactId: 1, sectorId: 9, description: null, chatId: null, scheduledAt: new Date("2026-11-16T12:00:00.124Z"), scheduleDate: new Date("2026-11-17"), scheduledBy: 534, scheduledFor: 534 };
	let row = { ...original }, writes = 0, localWrites = 0;
	const db = {
		$queryRawUnsafe: async (_sql: string, id: number, instance: string) => row.id === id && row.instance === instance.toLowerCase() ? [{ id }] : [],
		wppChat: { findFirst: async () => null },
		wppContact: { findFirst: async (input: { where: { id: number; instance: string } }) => input.where.id === 1 && input.where.instance === "odim" ? { id: 1 } : null },
		wppSchedule: {
			findUniqueOrThrow: async () => row,
			create: async (input: { data: WppSchedule }) => { writes++; row = { ...input.data, id: 2 }; return row; },
			update: async (input: { data: Partial<WppSchedule> }) => { writes++; row = { ...row, ...input.data }; return row; },
			delete: async () => { writes++; return row; }
		},
		$transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(db)
	};
	const previous = new Map<string, NodeModule | undefined>();
	const replace = (name: string, value: unknown) => { const file = require.resolve(name); previous.set(file, require.cache[file]); require.cache[file] = { id: file, filename: file, loaded: true, exports: { __esModule: true, default: value } } as NodeModule; };
	replace("../services/prisma.service", db);
	replace("../services/chats.service", {});
	replace("../services/instances.service", { executeQuery: async () => { localWrites++; return []; } });
	replace("../services/local-sync.service", {});
	replace("../routines/idle-chats.routine", async () => undefined);
	replace("../routines/schedules.routine", async () => undefined);
	replace("node-cron", { schedule: () => undefined });
	const service = require("../services/schedules.service").default as typeof import("../services/schedules.service").default;
	const session: SessionData = { instance: "odim", userId: 534, sectorId: 9, role: "OPERATOR", name: "Fixture" };
	const denied = (e: unknown) => e instanceof OperatorFeatureError && e.status === 403;
	try {
		await assert.rejects(service.createSchedule({ ...session, userId: 535, role: "ADMIN" }, { contactId: 1, scheduledFor: 534, date: new Date("2026-11-17"), sectorId: 9 }), denied);
		await assert.rejects(service.createSchedule(session, { contactId: 1, scheduledFor: 535, date: new Date("2026-11-17"), sectorId: 9 }), denied);
		for (const patch of [{ scheduledAt: new Date("2026-11-16T12:00:00.122Z") }, { scheduledBy: 535 }, { scheduledFor: 535 }, { instance: "other" }, { id: 2 }, { chatId: 3 }, { contactId: 2 }]) {
			await assert.rejects(service.editSchedule(patch as unknown as WppSchedule, 1, session), denied);
		}
		await assert.rejects(service.editSchedule({ description: "fixture" } as WppSchedule, 2, session), denied);
		await assert.rejects(service.deleteSchedule(2, session), denied);
		assert.equal(writes, 0); assert.equal(localWrites, 0);
		await service.editSchedule({ description: "fixture", scheduledAt: original.scheduledAt.toISOString() } as unknown as WppSchedule, 1, session);
		assert.equal(row.scheduledAt.getTime(), original.scheduledAt.getTime()); assert.equal(row.scheduledBy, 534); assert.equal(writes, 1);
		await service.createSchedule(session, { contactId: 1, scheduledFor: 534, date: new Date("2026-11-17"), sectorId: 9 }); assert.equal(writes, 2);
		assert.equal(row.scheduledBy, 534); assert.ok(row.scheduledAt instanceof Date);
	} finally {
		for (const [file, cached] of previous) if (cached) require.cache[file] = cached; else delete require.cache[file];
		fs.unlinkSync(operatorFeatureProfilePath);
	}
});
