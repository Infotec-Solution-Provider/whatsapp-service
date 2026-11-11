import type { WppContact } from "@prisma/client";
import { BadRequestError, InternalServerError, NotFoundError, UnauthorizedError } from "@rgranatodutra/http-errors";
import type { SessionData } from "../sdk-local";
import contactsService from "./contacts.service";
import parametersService from "./parameters.service";
import prismaService from "./prisma.service";

export const START_CHATS_ONLY_FOR_LOYAL_OPERATOR = "start_chats_only_for_loyal_operator";
export const START_CHATS_BLOCK_PUBLIC_AGENDA = "start_chats_block_public_agenda";

interface ManualChatPolicy {
	blockOtherLoyalOperator: boolean;
	blockPublicAgenda: boolean;
}

function canonicalAddress(address: unknown): string | null {
	if (typeof address !== "string") return null;
	const value = address.trim().replace(/^me:/, "");
	const jid = /^(\d+)@(c\.us|s\.whatsapp\.net|lid)$/.exec(value);
	if (jid) return `${jid[2] === "lid" ? "lid" : "phone"}:${jid[1]}`;
	if (!/^\+?[\d\s().-]+$/.test(value)) return null;
	const digits = value.replace(/\D/g, "");
	return digits ? `phone:${digits}` : null;
}

class ManualChatAuthorizationService {
	private async getPolicy(instance: string): Promise<ManualChatPolicy> {
		// An operator/sector override must not disable this instance policy.
		const [blockOtherLoyalOperator, blockPublicAgenda] = await Promise.all([
			parametersService.getInstanceBooleanParam(instance, START_CHATS_ONLY_FOR_LOYAL_OPERATOR, false),
			parametersService.getInstanceBooleanParam(instance, START_CHATS_BLOCK_PUBLIC_AGENDA, false)
		]);
		return { blockOtherLoyalOperator, blockPublicAgenda };
	}

	public async isEnabled(instance: string) {
		// Transfer protections are required when either start policy is enabled.
		const policy = await this.getPolicy(instance);
		return policy.blockOtherLoyalOperator || policy.blockPublicAgenda;
	}

	private async assertCustomerPolicy(session: SessionData, contact: WppContact, policy: ManualChatPolicy) {
		if (session.role === "ADMIN" || !contact.customerId) return;
		// Keep the existing WhatsApp definition: greatest campanhas_clientes.CODIGO,
		// without introducing a FIDELIZA/CONCLUIDO filter or clientes.OPERADOR fallback.
		const loyalty = await contactsService.getContactLoalty(contact);
		if (!loyalty) return;
		const rawUserId: unknown = loyalty.userId;
		// Public agenda is an explicit zero in an existing campaign row. A null,
		// missing row or unlinked contact must not acquire that meaning.
		if (policy.blockPublicAgenda && (rawUserId === 0 || rawUserId === "0")) {
			throw new UnauthorizedError("Este cliente está na agenda pública. Solicite a atribuição ao supervisor antes de iniciar a conversa.");
		}
		const userId = rawUserId === null ? 0 : Number(rawUserId);
		if ((rawUserId !== null && typeof rawUserId !== "number" &&
			(typeof rawUserId !== "string" || !/^-?\d+$/.test(rawUserId))) || !Number.isSafeInteger(userId)) {
			throw new InternalServerError("Não foi possível confirmar a fidelização deste cliente.");
		}
		if (policy.blockOtherLoyalOperator && userId > 0 && userId !== session.userId) {
			throw new UnauthorizedError("Este cliente está fidelizado com outro operador. Solicite a transferência ao supervisor.");
		}
	}

	public async assertCanStart(session: SessionData, contact: WppContact) {
		if (contact.instance !== session.instance) throw new NotFoundError("Contato não encontrado!");
		// The CRM's Supervisor profile is ADMIN. This instance policy is only for
		// ordinary operators; supervisors retain the pre-existing runtime behavior.
		if (session.role === "ADMIN") return;
		const policy = await this.getPolicy(session.instance);
		if (policy.blockOtherLoyalOperator || policy.blockPublicAgenda) {
			if (contact.isDeleted) throw new NotFoundError("Contato não encontrado!");
			await this.assertCustomerPolicy(session, contact, policy);
		}
	}

	public async assertCanSend(session: SessionData, clientId: number, contactId: number, chatId: number | null | undefined, to: string) {
		if (session.role === "ADMIN") return;
		const policy = await this.getPolicy(session.instance);
		if (!policy.blockOtherLoyalOperator && !policy.blockPublicAgenda) return;
		const resolvedContactId = Number(contactId);
		const resolvedChatId = chatId === null || chatId === undefined ? null : Number(chatId);
		if (!Number.isSafeInteger(resolvedContactId) || resolvedContactId <= 0 ||
			(resolvedChatId !== null && (!Number.isSafeInteger(resolvedChatId) || resolvedChatId <= 0))) {
			throw new BadRequestError("Contato ou conversa inválidos.");
		}
		const [contact, client] = await Promise.all([
			prismaService.wppContact.findFirst({ where: { id: resolvedContactId, instance: session.instance, isDeleted: false } }),
			prismaService.wppClient.findFirst({ where: { id: clientId, instance: session.instance, isActive: true } })
		]);
		if (!contact) throw new NotFoundError("Contato não encontrado!");
		if (!client) throw new BadRequestError("Canal indisponível para envio.");
		const target = canonicalAddress(to);
		// Preserve the UI's phone and the existing sender's resolved address. An
		// explicit LID remains distinct from a phone JID; group/unknown suffixes fail.
		const addresses = [contact.phone, contact.whatsappId]
			.map(canonicalAddress).filter(Boolean);
		// The existing sender strips a known LID suffix. Accept that exact bare
		// alias, without turning it into an accepted explicit phone/group JID.
		const bareTarget = typeof to === "string" && !to.includes("@");
		const senderAlias = bareTarget ? canonicalAddress(contactsService.resolveContactAddress(contact)) : null;
		if (!target || (!addresses.includes(target) && target !== senderAlias)) {
			throw new BadRequestError("O destinatário não corresponde ao contato informado.");
		}

		if (resolvedChatId !== null) {
			const chat = await prismaService.wppChat.findFirst({
				where: { id: resolvedChatId, instance: session.instance, contactId: contact.id, isFinished: false }
			});
			if (!chat) throw new BadRequestError("Conversa inválida para este contato.");
			// A transfer changes the current owner without changing CRM loyalty.
			if (session.role === "ADMIN" || chat.userId === session.userId) return;
			if (chat.userId && chat.userId > 0) throw new UnauthorizedError("Este atendimento pertence a outro operador.");
		}
		await this.assertCustomerPolicy(session, contact, policy);
	}
}

export default new ManualChatAuthorizationService();
