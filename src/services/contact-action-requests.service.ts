import { ContactActionRequestStatus, ContactActionRequestType, Prisma, WppContact } from "@prisma/client";
import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import { SessionData } from "../sdk-local";
import contactsService from "./contacts.service";
import parametersService, { CONTACT_APPROVAL_PARAMETERS } from "./parameters.service";
import prismaService from "./prisma.service";
import getUsersClient from "./users.service";

export interface ContactActionPayload {
	name?: string;
	customerId?: number | null;
	sectorIds?: number[];
}

export type ContactActionOutcome =
	| { outcome: "EXECUTED"; contact: WppContact; request?: unknown }
	| { outcome: "REQUESTED"; request: unknown };

class ContactActionRequestsService {
	private pendingKey(instance: string, contactId: number, action: ContactActionRequestType) {
		return `${instance}:${contactId}:${action}`;
	}

	private cleanSectorIds(value: unknown): number[] {
		if (!Array.isArray(value)) return [];
		return [...new Set(value.filter((id): id is number => Number.isInteger(id) && id > 0))];
	}

	private normalizePayload(
		contact: WppContact & { sectors?: Array<{ sectorId: number }> },
		payload?: ContactActionPayload | Prisma.JsonValue | null
	) {
		const source =
			payload && typeof payload === "object" && !Array.isArray(payload)
				? (payload as Record<string, unknown>)
				: {};
		const proposedName = typeof source["name"] === "string" ? source["name"].trim() : "";
		const customerId =
			source["customerId"] === null
				? null
				: typeof source["customerId"] === "number" && Number.isInteger(source["customerId"])
					? source["customerId"]
					: contact.customerId;
		const sectorIds =
			Object.prototype.hasOwnProperty.call(source, "sectorIds") && source["sectorIds"] !== undefined
				? this.cleanSectorIds(source["sectorIds"])
				: this.cleanSectorIds(contact.sectors?.map((sector) => sector.sectorId));

		return {
			name: proposedName || contact.name,
			customerId,
			sectorIds
		};
	}

	private snapshot(contact: WppContact & { sectors?: Array<{ sectorId: number }> }): Prisma.InputJsonObject {
		return {
			id: contact.id,
			name: contact.name,
			phone: contact.phone,
			customerId: contact.customerId,
			isDeleted: contact.isDeleted,
			sectorIds: this.cleanSectorIds(contact.sectors?.map((sector) => sector.sectorId))
		};
	}

	private async requiresApproval(instance: string, action: ContactActionRequestType) {
		const key =
			action === "REACTIVATE" ? CONTACT_APPROVAL_PARAMETERS.reactivation : CONTACT_APPROVAL_PARAMETERS.deletion;
		return parametersService.getInstanceBooleanParam(instance, key, false);
	}

	public async process(
		session: SessionData,
		contactId: number,
		action: ContactActionRequestType,
		payload: ContactActionPayload | undefined,
		authToken: string
	): Promise<ContactActionOutcome> {
		const approvalRequired = await this.requiresApproval(session.instance, action);
		if (approvalRequired && session.role !== "ADMIN") {
			return this.createOrReuse(session, contactId, action, payload, authToken);
		}

		return this.executeDirect(session, contactId, action, payload);
	}

	private async createOrReuse(
		session: SessionData,
		contactId: number,
		action: ContactActionRequestType,
		payload: ContactActionPayload | undefined,
		authToken: string
	): Promise<ContactActionOutcome> {
		const key = this.pendingKey(session.instance, contactId, action);
		const existing = await prismaService.contactActionRequest.findUnique({
			where: { pendingKey: key },
			include: { contact: { include: { sectors: true } } }
		});
		if (existing) {
			this.validateState(existing.contact, action);
			return { outcome: "REQUESTED", request: existing };
		}

		const contact = await prismaService.wppContact.findFirst({
			where: { id: contactId, instance: session.instance },
			include: { sectors: true } as any
		});
		this.validateState(contact, action);
		const normalizedPayload = action === "REACTIVATE" ? this.normalizePayload(contact!, payload) : null;

		let request;
		let created = false;
		try {
			request = await prismaService.contactActionRequest.create({
				data: {
					instance: session.instance,
					contactId,
					action,
					requestedBy: session.userId,
					requestedByName: session.name || null,
					payload: normalizedPayload ?? Prisma.JsonNull,
					contactSnapshot: this.snapshot(contact!),
					pendingKey: key
				},
				include: { contact: { include: { sectors: true } } }
			});
			created = true;
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
			request = await prismaService.contactActionRequest.findUnique({
				where: { pendingKey: key },
				include: { contact: { include: { sectors: true } } }
			});
			if (!request) throw error;
		}

		if (created) {
			await this.notifySupervisors(session.instance, session.name, contact!.phone, action, authToken);
		}
		return { outcome: "REQUESTED", request };
	}

	private validateState(contact: WppContact | null, action: ContactActionRequestType) {
		if (!contact) throw new BadRequestError("Contato não encontrado.");
		if (action === "DELETE" && contact.isDeleted) throw new ConflictError("O contato já está desativado.");
		if (action === "REACTIVATE" && !contact.isDeleted) throw new ConflictError("O contato já está ativo.");
	}

	private async applyAction(
		tx: Prisma.TransactionClient,
		contact: WppContact & { sectors?: Array<{ sectorId: number }> },
		action: ContactActionRequestType,
		payload?: ContactActionPayload | Prisma.JsonValue | null
	) {
		if (action === "DELETE") {
			const updated = await tx.wppContact.update({
				where: { id: contact.id },
				data: { isDeleted: true }
			});
			return { contact: updated, sectorIds: undefined as number[] | undefined };
		}

		const normalized = this.normalizePayload(contact, payload);
		const updated = await tx.wppContact.update({
			where: { id: contact.id },
			data: {
				name: normalized.name,
				customerId: normalized.customerId,
				isDeleted: false,
				sectors: {
					deleteMany: {},
					create: normalized.sectorIds.map((sectorId) => ({ sectorId }))
				}
			} as any
		});
		return { contact: updated, sectorIds: normalized.sectorIds };
	}

	private async executeDirect(
		session: SessionData,
		contactId: number,
		action: ContactActionRequestType,
		payload?: ContactActionPayload
	): Promise<ContactActionOutcome> {
		const key = this.pendingKey(session.instance, contactId, action);
		const result = await prismaService.$transaction(async (tx) => {
			const contact = await tx.wppContact.findFirst({
				where: { id: contactId, instance: session.instance },
				include: { sectors: true } as any
			});
			this.validateState(contact, action);
			const pending = await tx.contactActionRequest.findUnique({ where: { pendingKey: key } });
			const effectivePayload = pending?.payload ?? payload;
			const applied = await this.applyAction(tx, contact!, action, effectivePayload);
			const request = pending
				? await tx.contactActionRequest.update({
						where: { id: pending.id },
						data: {
							status: "APPROVED",
							pendingKey: null,
							reviewedBy: session.userId,
							reviewedAt: new Date()
						}
					})
				: undefined;
			return { ...applied, request };
		});

		await contactsService.syncContactStateToLocal(result.contact, result.sectorIds);
		if (result.request) await this.notifyRequester(result.request, action, "APPROVED");
		return { outcome: "EXECUTED", contact: result.contact, request: result.request };
	}

	private async notifySupervisors(
		instance: string,
		requesterName: string,
		phone: string | null,
		action: ContactActionRequestType,
		authToken: string
	) {
		try {
			const usersClient = getUsersClient();
			usersClient.setAuth(authToken.replace(/^Bearer\s+/i, ""));
			const usersResponse = await usersClient.getUsers({ perPage: "1000" } as any);
			const supervisorIds = usersResponse.data
				.filter((user) => user.NIVEL === "ADMIN" && user.ATIVO !== "NAO")
				.map((user) => user.CODIGO);
			if (supervisorIds.length === 0) return;

			const actionLabel = action === "DELETE" ? "exclusão" : "reativação";
			const description =
				`${requesterName || "Um usuário"} solicitou a ${actionLabel} de ${phone || "um contato"}.`.slice(
					0,
					191
				);
			await prismaService.notification.createMany({
				data: supervisorIds.map((userId) => ({
					instance,
					userId,
					title: `Solicitação de ${actionLabel} de contato`,
					description,
					type: "CONTACT_ACTION_REQUEST",
					actionUrl: "/contact-requests"
				}))
			});
		} catch (error) {
			console.error("[ContactActionRequest] Falha ao notificar supervisores:", error);
		}
	}

	private async notifyRequester(
		request: { instance: string; requestedBy: number },
		action: ContactActionRequestType,
		status: "APPROVED" | "REJECTED"
	) {
		try {
			const actionLabel = action === "DELETE" ? "exclusão" : "reativação";
			const statusLabel = status === "APPROVED" ? "aprovada" : "rejeitada";
			await prismaService.notification.create({
				data: {
					instance: request.instance,
					userId: request.requestedBy,
					title: `Solicitação ${statusLabel}`,
					description: `Sua solicitação de ${actionLabel} de contato foi ${statusLabel}.`,
					type: "CONTACT_ACTION_REQUEST",
					actionUrl: "/contacts"
				}
			});
		} catch (error) {
			console.error("[ContactActionRequest] Falha ao notificar solicitante:", error);
		}
	}

	public async list(instance: string, status?: ContactActionRequestStatus, action?: ContactActionRequestType) {
		return prismaService.contactActionRequest.findMany({
			where: { instance, ...(status ? { status } : {}), ...(action ? { action } : {}) },
			include: { contact: { include: { sectors: true } } },
			orderBy: [{ status: "asc" }, { createdAt: "desc" }]
		});
	}

	public async decide(
		session: SessionData,
		requestId: number,
		decision: "APPROVE" | "REJECT",
		reviewNote?: string | null
	) {
		const result = await prismaService.$transaction(async (tx) => {
			const request = await tx.contactActionRequest.findFirst({
				where: { id: requestId, instance: session.instance },
				include: { contact: { include: { sectors: true } } }
			});
			if (!request) throw new BadRequestError("Solicitação não encontrada.");
			if (request.status !== "PENDING") throw new ConflictError("Esta solicitação já foi analisada.");

			let applied: { contact: WppContact; sectorIds: number[] | undefined } | null = null;
			if (decision === "APPROVE") {
				this.validateState(request.contact, request.action);
				applied = await this.applyAction(tx, request.contact, request.action, request.payload);
			}

			const status: ContactActionRequestStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
			const updatedRequest = await tx.contactActionRequest.update({
				where: { id: request.id },
				data: {
					status,
					pendingKey: null,
					reviewedBy: session.userId,
					reviewedAt: new Date(),
					reviewNote: reviewNote?.trim() || null
				}
			});
			return { request: updatedRequest, applied };
		});

		if (result.applied) {
			await contactsService.syncContactStateToLocal(result.applied.contact, result.applied.sectorIds);
		}
		await this.notifyRequester(
			result.request,
			result.request.action,
			result.request.status as "APPROVED" | "REJECTED"
		);
		return result.request;
	}
}

export default new ContactActionRequestsService();
