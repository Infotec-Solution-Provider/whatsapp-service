import type { WppContact } from "@prisma/client";
import contactsService from "./contacts.service";
import instancesService from "./instances.service";
import prismaService from "./prisma.service";
import { ContactCustomerResolutionService, CustomerResolutionScope } from "./contact-customer-resolution.service";

const resolver = new ContactCustomerResolutionService({
	sectorBelongsToInstance: async (instance, sectorId) => Boolean(await prismaService.wppSector.findFirst({ where: { id: sectorId, instance }, select: { id: true } })),
	getContact: (instance, id) => prismaService.wppContact.findFirst({ where: { instance, id } }),
	query: (instance, sql, params) => instancesService.executeQuery(instance, sql, params),
	linkIfUnchanged: async (contact, customerId) => {
		const changed = await prismaService.wppContact.updateMany({
			where: { instance: contact.instance, id: contact.id, isDeleted: false, customerId: contact.customerId, phone: contact.phone, whatsappId: contact.whatsappId },
			data: { customerId }
		});
		return changed.count;
	},
	syncContact: contact => contactsService.syncContactStateToLocal(contact, undefined, true)
});

export const resolveContactCustomerForFlow = (scope: CustomerResolutionScope, contact: WppContact) => resolver.resolve(scope, contact);
