import { randomUUID } from "node:crypto";
import type { Prisma, WppClient } from "@prisma/client";
import type { SessionData } from "../sdk-local/types/auth.types";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import ProcessingLogger from "../utils/processing-logger";
import database, { type DatabaseClient } from "./prisma.service";
import { MetaGraphError, MetaManagementGraph, type MetaPhoto, type MetaProfilePatch, type MetaTemplateFilters, type MetaTemplateInput } from "./meta-management.graph";

const assetFields = { WABAAccountId: true, WABAPhoneId: true } as const;
const directoryFields = { id: true, name: true, phone: true, ...assetFields } as const;
const officialChannel = {
	type: "WABA", isActive: true, AND: [{ WABAToken: { not: null } }, { WABAToken: { not: "" } }]
} satisfies Prisma.WppClientWhereInput;
type DirectoryRow = Pick<WppClient, keyof typeof directoryFields>;
type ConfiguredAssets = { WABAAccountId: string; WABAPhoneId: string };

function eligibleAssets(row: DirectoryRow): row is DirectoryRow & ConfiguredAssets {
	const metaId = /^[1-9]\d{0,31}$/;
	return Boolean(row.WABAAccountId && metaId.test(row.WABAAccountId) && row.WABAPhoneId && metaId.test(row.WABAPhoneId));
}

function publicChannel(channel: DirectoryRow) {
	return { clientId: channel.id, name: channel.name, phone: channel.phone };
}

function unavailableChannel(): MetaGraphError {
	return new MetaGraphError(404, "META_CHANNEL_NOT_FOUND", "Canal oficial indisponível para esta instância.");
}

function inconsistentBinding(): MetaGraphError {
	return new MetaGraphError(409, "META_ASSET_MISMATCH", "Confira o vínculo entre o canal e a conta no WhatsApp Manager.");
}

export class MetaManagementService {
	constructor(
		private readonly db: Pick<DatabaseClient, "wppClient"> = database,
		private readonly createGraph = (token: string) => new MetaManagementGraph(token)
	) {}

	private async sharedAccounts(instance: string, channels: ConfiguredAssets[]): Promise<Set<string | null>> {
		const accountIds = [...new Set(channels.map((channel) => channel.WABAAccountId))];
		if (!accountIds.length) return new Set();
		// A WABA's templates are visible from any of its numbers. Include inactive local links in the check.
		const localLinks = await this.db.wppClient.findMany({
			where: { instance, WABAAccountId: { in: accountIds }, WABAPhoneId: { not: null } }, select: assetFields
		});
		const links = [...channels, ...localLinks];
		const phoneIds = [...new Set(links.flatMap((link) => link.WABAPhoneId ? [link.WABAPhoneId] : []))];
		// The tenant SQL router otherwise binds the lookup to the authenticated tenant's database.
		// Read only the IDs needed for the collision check across prepared databases.
		const foreignClaims = await withDatabaseTenant(null, async () => this.db.wppClient.findMany({
			where: { instance: { not: instance }, OR: [{ WABAAccountId: { in: accountIds } }, { WABAPhoneId: { in: phoneIds } }] },
			select: assetFields
		}));
		const shared = new Set(foreignClaims.map((claim) => claim.WABAAccountId));
		const foreignPhones = new Set(foreignClaims.map((claim) => claim.WABAPhoneId));
		for (const link of links) if (foreignPhones.has(link.WABAPhoneId)) shared.add(link.WABAAccountId);
		return shared;
	}

	public async listChannels(instance: string) {
		const rows = await this.db.wppClient.findMany({
			where: { instance, ...officialChannel }, select: directoryFields, orderBy: [{ name: "asc" }, { id: "asc" }]
		});
		const channels = rows.filter(eligibleAssets);
		const shared = await this.sharedAccounts(instance, channels);
		return channels.filter((channel) => !shared.has(channel.WABAAccountId)).map(publicChannel);
	}

	public async listCostReceiptChannels(instance: string) {
		const rows = await this.db.wppClient.findMany({
			where: { instance, type: "WABA", WABAAccountId: { not: null }, WABAPhoneId: { not: null } },
			select: directoryFields, orderBy: { id: "asc" }
		});
		const channels = rows.filter(eligibleAssets);
		const shared = await this.sharedAccounts(instance, channels);
		return channels.filter(channel => !shared.has(channel.WABAAccountId)).map(channel => ({
			clientId: channel.id, phoneId: channel.WABAPhoneId
		}));
	}

	private async verifiedChannel(instance: string, clientId: number) {
		const channel = await this.db.wppClient.findFirst({
			where: { id: clientId, instance, ...officialChannel }, select: { ...directoryFields, WABAToken: true }
		});
		if (!channel || !eligibleAssets(channel) || !channel.WABAToken || /\s/.test(channel.WABAToken)
			|| (await this.sharedAccounts(instance, [channel])).has(channel.WABAAccountId)) {
			throw unavailableChannel();
		}
		const graph = this.createGraph(channel.WABAToken);
		const number = (await graph.listNumbers(channel.WABAAccountId)).find((item) => item.id === channel.WABAPhoneId);
		if (!number) throw inconsistentBinding();
		return { graph, local: publicChannel(channel), accountId: channel.WABAAccountId, phoneId: channel.WABAPhoneId, number };
	}

	public async getChannelPricing(instance: string, clientId: number, period: { start: Date; end: Date }) {
		const { graph, accountId, number } = await this.verifiedChannel(instance, clientId);
		return number.phone ? graph.getPricingAnalytics(accountId, number.phone, period.start, period.end) : null;
	}

	public async getNumber(instance: string, clientId: number) {
		const { local, number } = await this.verifiedChannel(instance, clientId);
		return {
			...local, phone: number.phone ?? local.phone,
			verifiedName: number.verifiedName, status: number.status, qualityRating: number.qualityRating
		};
	}

	public async listTemplates(instance: string, clientId: number, filters: MetaTemplateFilters) {
		const { graph, accountId } = await this.verifiedChannel(instance, clientId);
		return graph.listTemplates(accountId, filters);
	}

	public async createTemplate(session: SessionData, clientId: number, input: MetaTemplateInput) {
		const { graph, accountId } = await this.verifiedChannel(session.instance, clientId);
		return this.audit(session, "template-create", { accountId, clientId, templateName: input.name, language: input.language },
			() => graph.createTemplate(accountId, input));
	}

	public async getProfile(instance: string, clientId: number) {
		const { graph, phoneId } = await this.verifiedChannel(instance, clientId);
		return graph.getProfile(phoneId);
	}

	public async updateProfile(session: SessionData, clientId: number, input: MetaProfilePatch) {
		const { graph, accountId, phoneId } = await this.verifiedChannel(session.instance, clientId);
		return this.audit(session, "profile-update", { accountId, clientId, phoneId, fields: Object.keys(input) },
			() => graph.updateProfile(phoneId, input));
	}

	public async updatePhoto(session: SessionData, clientId: number, input: MetaPhoto) {
		const { graph, accountId, phoneId } = await this.verifiedChannel(session.instance, clientId);
		return this.audit(session, "photo-update", { accountId, clientId, phoneId }, () => graph.updatePhoto(phoneId, input));
	}

	private async audit<T>(session: SessionData, action: string, metadata: object, run: () => Promise<T>): Promise<T> {
		const log = new ProcessingLogger(session.instance, `meta-management-${action}`, randomUUID(), { actorUserId: session.userId, ...metadata });
		try {
			const result = await run();
			log.success({ outcome: "confirmed" });
			return result;
		} catch (error) {
			if (error instanceof MetaGraphError && error.code === "META_REFRESH_REQUIRED") {
				log.success({ outcome: "accepted_refresh_required" });
			} else {
				const code = error instanceof MetaGraphError ? error.code : "META_MANAGEMENT_FAILED";
				const traceId = error instanceof MetaGraphError ? error.traceId : undefined;
				log.failed({
					outcome: code === "META_WRITE_UNCERTAIN" ? "uncertain" : "failed",
					code,
					...(traceId && /^[A-Za-z0-9_-]{1,100}$/.test(traceId) ? { traceId } : {})
				});
			}
			throw error;
		}
	}
}

export default new MetaManagementService();
