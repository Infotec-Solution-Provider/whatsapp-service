import prismaService from "./prisma.service";

class ContactsService {
	public async getOrCreateContact(
		instance: string,
		name: string,
		phone: string
	) {
		const contact = await prismaService.wppContact.findFirst({
			where: {
				instance,
				name,
				phone
			}
		});

		if (contact) {
			return contact;
		}

		return await prismaService.wppContact.create({
			data: {
				instance,
				name,
				phone
			}
		});
	}
}

export default new ContactsService();
