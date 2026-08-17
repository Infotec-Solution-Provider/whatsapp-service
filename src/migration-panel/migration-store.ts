import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import prismaService from "../services/prisma.service";
import { redactMigrationConfig } from "./config";
import {
	MigrationEntity,
	MigrationInstanceConfig,
	MigrationLogEntry,
	MigrationPhase,
	MigrationRunSnapshot,
	MigrationRunStatus,
} from "./types";

interface RunUpdate {
	status?: MigrationRunStatus;
	currentPhase?: MigrationPhase;
}

class MigrationStore {
	private readonly logs = new Map<string, MigrationLogEntry[]>();

	public async createRun(config: MigrationInstanceConfig): Promise<MigrationRunSnapshot> {
		const id = randomUUID();
		const run = await prismaService.instanceMigrationRun.create({
			data: {
				id,
				instance: config.targetInstance,
				status: "CREATED",
				currentPhase: "preflight",
				configJson: redactMigrationConfig(config) as Prisma.InputJsonObject,
			},
		});
		this.logs.set(id, []);
		return this.snapshot(run);
	}

	public async updateRun(id: string, update: RunUpdate): Promise<MigrationRunSnapshot> {
		const run = await prismaService.instanceMigrationRun.update({
			where: { id },
			data: update,
		});
		return this.snapshot(run);
	}

	public async getRun(id: string): Promise<MigrationRunSnapshot | null> {
		const run = await prismaService.instanceMigrationRun.findUnique({ where: { id } });
		return run ? this.snapshot(run) : null;
	}

	public async listRuns(): Promise<MigrationRunSnapshot[]> {
		const runs = await prismaService.instanceMigrationRun.findMany({
			orderBy: { updatedAt: "desc" },
			take: 25,
		});
		return runs.map((run) => this.snapshot(run));
	}

	public appendLog(
		id: string,
		phase: MigrationPhase,
		level: MigrationLogEntry["level"],
		message: string,
		meta?: Record<string, unknown>,
	): MigrationLogEntry {
		const entries = this.logs.get(id) ?? [];
		const entry: MigrationLogEntry = {
			sequence: entries.length + 1,
			at: new Date().toISOString(),
			level,
			phase,
			message,
		};
		if (meta) {
			entry.meta = meta;
		}
		entries.push(entry);
		this.logs.set(id, entries);
		return entry;
	}

	public async upsertMap(
		runId: string,
		instance: string,
		entity: MigrationEntity,
		sourceId: string,
		targetId: number,
		sourceFingerprint?: string,
	): Promise<void> {
		const existing = await prismaService.instanceMigrationMap.findFirst({
			where: { instance, entity, sourceId },
		});
		if (existing) {
			const updateData: Prisma.InstanceMigrationMapUncheckedUpdateInput = { runId, targetId };
			if (sourceFingerprint !== undefined) updateData.sourceFingerprint = sourceFingerprint;
			await prismaService.instanceMigrationMap.update({
				where: { id: existing.id },
				data: updateData,
			});
			return;
		}
		const createData: Prisma.InstanceMigrationMapUncheckedCreateInput = {
			runId,
			instance,
			entity,
			sourceId,
			targetId,
			sourceFingerprint: sourceFingerprint ?? null,
		};
		await prismaService.instanceMigrationMap.create({
			data: createData,
		});
	}

	public async getMap(
		instance: string,
		entity: MigrationEntity,
		sourceId: string,
	): Promise<number | null> {
		const map = await prismaService.instanceMigrationMap.findFirst({
			where: { instance, entity, sourceId },
			select: { targetId: true },
		});
		return map?.targetId ?? null;
	}

	public async getMaps(
		instance: string,
		entity: MigrationEntity,
	): Promise<Map<string, number>> {
		const records = await prismaService.instanceMigrationMap.findMany({
			where: { instance, entity, targetId: { not: null } },
			select: { sourceId: true, targetId: true },
		});
		return new Map(
			records
				.filter((record): record is { sourceId: string; targetId: number } => record.targetId !== null)
				.map((record) => [record.sourceId, record.targetId]),
		);
	}

	private snapshot(run: {
		id: string;
		instance: string;
		status: string;
		currentPhase: string;
		createdAt: Date;
		updatedAt: Date;
	}): MigrationRunSnapshot {
		return {
			id: run.id,
			instance: run.instance,
			status: run.status as MigrationRunStatus,
			currentPhase: run.currentPhase as MigrationPhase,
			createdAt: run.createdAt.toISOString(),
			updatedAt: run.updatedAt.toISOString(),
			logs: [...(this.logs.get(run.id) ?? [])],
		};
	}
}

export default MigrationStore;
