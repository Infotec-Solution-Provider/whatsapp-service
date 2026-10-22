import { BadRequestError, ConflictError } from "@rgranatodutra/http-errors";
import type { WppContact } from "@prisma/client";

export interface LinkCustomer {
	id: number;
	name: string;
	cpfCnpj: string | null;
	erpCode: string | null;
}

export interface ContactCustomerLinkDependencies {
	getContact(instance: string, id: number): Promise<WppContact | null>;
	getCustomer(id: number): Promise<LinkCustomer | null>;
	linkIfUnlinked(instance: string, id: number, customerId: number): Promise<number>;
	syncContact(contact: WppContact): Promise<void>;
}

export function positiveContactId(value: unknown): number {
	const id = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
	if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestError("Identificador inválido.");
	return id;
}

/** Only fills an empty link. Editing/replacing a customer's link is a separate action. */
export class ContactCustomerLinkService {
	constructor(private readonly dependencies: ContactCustomerLinkDependencies) {}

	async link(instance: string, rawContactId: unknown, rawCustomerId: unknown) {
		const contactId = positiveContactId(rawContactId);
		const customerId = positiveContactId(rawCustomerId);
		const contact = await this.dependencies.getContact(instance, contactId);
		if (!contact || contact.isDeleted) throw new BadRequestError("Contato ativo não encontrado.");
		const unlinked = contact.customerId === null || contact.customerId === 0 || contact.customerId === -1;
		if (!unlinked && contact.customerId !== customerId) {
			throw new ConflictError("Este contato já possui cliente vinculado. Atualize a lista antes de continuar.");
		}
		const customer = await this.dependencies.getCustomer(customerId);
		if (!customer || customer.id !== customerId) throw new BadRequestError("Cliente não encontrado ou sem acesso.");
		if (unlinked) {
			const count = await this.dependencies.linkIfUnlinked(instance, contactId, customerId);
			if (count !== 1) {
				throw new ConflictError("O contato foi alterado durante a confirmação. Atualize a lista antes de continuar.");
			}
		}
		const updated = await this.dependencies.getContact(instance, contactId);
		if (!updated || updated.isDeleted || updated.customerId !== customerId) {
			throw new ConflictError("O contato foi alterado. Atualize a lista para conferir o vínculo.");
		}
		await this.dependencies.syncContact(updated);
		return { contact: updated, customer };
	}
}
