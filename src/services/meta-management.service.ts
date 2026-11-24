import { randomUUID } from "node:crypto";
import type { SessionData } from "../sdk-local/types/auth.types";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import ProcessingLogger from "../utils/processing-logger";
import database, { type DatabaseClient } from "./prisma.service";
import { getMetaCredentials, MetaGraphError, MetaManagementGraph, type MetaPhoto, type MetaProfilePatch, type MetaTemplateFilters, type MetaTemplateInput } from "./meta-management.graph";

interface AccountLink {
	id: number;
	name: string;
	phone: string | null;
	isActive: boolean;
	WABAAccountId: string;
	WABAPhoneId: string;
}

interface AvailableAccount {
	id: string;
	links: AccountLink[];
	credentials: NonNullable<ReturnType<typeof getMetaCredentials>>;
}

const metaId = /^\d{1,32}$/;
const localNumber = (link: AccountLink) => ({ clientId: link.id, name: link.name, phone: link.phone });

function accountNotFound(): MetaGraphError {
	return new MetaGraphError(404, "META_ACCOUNT_NOT_FOUND", "Conta Meta indisponível para esta instância.");
}

function numberNotFound(): MetaGraphError {
	return new MetaGraphError(404, "META_NUMBER_NOT_FOUND", "Número Meta indisponível para esta instância.");
}

function inconsistentBinding(): MetaGraphError {
	return new MetaGraphError(409, "META_ASSET_MISMATCH", "Confira o vínculo entre o canal e a conta no WhatsApp Manager.");
}

export class MetaManagementService {
	constructor(
		private readonly db: Pick<DatabaseClient, "wppClient"> = database,
		private readonly credentialsFor = getMetaCredentials,
		private readonly createGraph = (credentials: AvailableAccount["credentials"]) => new MetaManagementGraph(credentials)
	) {}

	private async availableAccounts(instance: string): Promise<AvailableAccount[]> {
		const candidates = await this.db.wppClient.findMany({
			where: { instance, type: "WABA", WABAAccountId: { not: null }, WABAPhoneId: { not: null } },
			select: { id: true, name: true, phone: true, isActive: true, WABAAccountId: true, WABAPhoneId: true },
			orderBy: [{ name: "asc" }, { id: "asc" }]
		});
		const links = candidates.filter((row): row is AccountLink => Boolean(
			row.WABAAccountId && metaId.test(row.WABAAccountId) && row.WABAPhoneId && metaId.test(row.WABAPhoneId)
		));
		const ids = [...new Set(links.filter((link) => link.isActive).map((link) => link.WABAAccountId))];
		if (!ids.length) return [];

		const matchingLinks = links.filter((link) => ids.includes(link.WABAAccountId));
		const phoneIds = [...new Set(matchingLinks.map((link) => link.WABAPhoneId))];
		// The tenant SQL router otherwise binds the lookup to the authenticated tenant's database.
		// Read only the IDs needed for the collision check across prepared databases.
		const foreignClaims = await withDatabaseTenant(null, async () => this.db.wppClient.findMany({
			where: { instance: { not: instance }, OR: [{ WABAAccountId: { in: ids } }, { WABAPhoneId: { in: phoneIds } }] },
			select: { WABAAccountId: true, WABAPhoneId: true }
		}));
		const foreignAccounts = new Set(foreignClaims.map((claim) => claim.WABAAccountId));
		const foreignPhones = new Set(foreignClaims.map((claim) => claim.WABAPhoneId));

		return ids.flatMap((id) => {
			const accountLinks = matchingLinks.filter((link) => link.WABAAccountId === id);
			if (foreignAccounts.has(id) || accountLinks.some((link) => foreignPhones.has(link.WABAPhoneId))) return [];
			const credentials = this.credentialsFor(id);
			return credentials ? [{ id, links: accountLinks.filter((link) => link.isActive), credentials }] : [];
		});
	}

	public async listAccounts(instance: string) {
		return (await this.availableAccounts(instance)).map((account) => ({
			id: account.id,
			name: account.links[0]!.name,
			numbers: account.links.map(localNumber)
		}));
	}

	private async account(instance: string, accountId: string) {
		const account = (await this.availableAccounts(instance)).find((item) => item.id === accountId);
		if (!account) throw accountNotFound();
		return { account, graph: this.createGraph(account.credentials) };
	}

	private async accountNumbers(account: AvailableAccount, graph: MetaManagementGraph) {
		const graphNumbers = await graph.listNumbers(account.id);
		const byId = new Map(graphNumbers.map((number) => [number.id, number]));
		if (!account.links.some((link) => byId.has(link.WABAPhoneId))) throw inconsistentBinding();
		return byId;
	}

	public async listNumbers(instance: string, accountId: string) {
		const { account, graph } = await this.account(instance, accountId);
		const byId = await this.accountNumbers(account, graph);
		return account.links.map((link) => {
			const number = byId.get(link.WABAPhoneId);
			return {
				...localNumber(link),
				phone: number?.phone ?? link.phone,
				verifiedName: number?.verifiedName ?? null,
				status: number?.status ?? null,
				qualityRating: number?.qualityRating ?? null
			};
		});
	}

	public async listTemplates(instance: string, accountId: string, filters: MetaTemplateFilters) {
		const { account, graph } = await this.account(instance, accountId);
		await this.accountNumbers(account, graph);
		return graph.listTemplates(account.id, filters);
	}

	public async createTemplate(session: SessionData, accountId: string, input: MetaTemplateInput) {
		const { account, graph } = await this.account(session.instance, accountId);
		await this.accountNumbers(account, graph);
		return this.audit(session, "template-create", { accountId: account.id, templateName: input.name, language: input.language },
			() => graph.createTemplate(account.id, input));
	}

	private async number(instance: string, clientId: number) {
		const accounts = await this.availableAccounts(instance);
		const account = accounts.find((item) => item.links.some((link) => link.id === clientId));
		const link = account?.links.find((item) => item.id === clientId);
		if (!account || !link) throw numberNotFound();
		const graph = this.createGraph(account.credentials);
		const byId = await this.accountNumbers(account, graph);
		if (!byId.has(link.WABAPhoneId)) throw inconsistentBinding();
		return { graph, accountId: account.id, phoneId: link.WABAPhoneId };
	}

	public async getProfile(instance: string, clientId: number) {
		const { graph, phoneId } = await this.number(instance, clientId);
		return graph.getProfile(phoneId);
	}

	public async updateProfile(session: SessionData, clientId: number, input: MetaProfilePatch) {
		const { graph, accountId, phoneId } = await this.number(session.instance, clientId);
		return this.audit(session, "profile-update", { accountId, clientId, phoneId, fields: Object.keys(input) },
			() => graph.updateProfile(phoneId, input));
	}

	public async updatePhoto(session: SessionData, clientId: number, input: MetaPhoto) {
		const { graph, accountId, phoneId } = await this.number(session.instance, clientId);
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
