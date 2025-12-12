import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import contactsService from "../services/contacts.service";

class ContactsController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/customer/:id/contacts", isAuthenticated, this.getCustomerContacts);
		this.router.get("/api/whatsapp/contacts/customer", isAuthenticated, this.getContactsWithCustomer);
		this.router.get("/api/whatsapp/contacts", isAuthenticated, this.getContacts);
		this.router.post("/api/whatsapp/customers/:id/contacts", isAuthenticated, this.createContact);
		this.router.post("/api/whatsapp/contacts", isAuthenticated, this.createContact);
		this.router.post("/api/whatsapp/contacts/:contactId/sectors", isAuthenticated, this.addSectorToContact);
		this.router.put("/api/whatsapp/contacts/:contactId", isAuthenticated, this.updateContact);
		this.router.delete("/api/whatsapp/contacts/:contactId", isAuthenticated, this.deleteContact);
	}

	private async addSectorToContact(req: Request, res: Response) {
		const contactId = Number(req.params["contactId"]);
		const sectorId = req.body && req.body.sectorId ? Number(req.body.sectorId) : undefined;

		if (!sectorId) {
			res.status(400).send({ message: "sectorId is required" });
			return;
		}

		const contact = await contactsService.addSectorToContact(contactId, sectorId);

		res.status(200).send({
			message: "Sector added to contact successfully!",
			data: contact
		});
	}

	private async getCustomerContacts(req: Request, res: Response) {
		const data = await contactsService.getCustomerContacts(req.session.instance, Number(req.params["id"]));

		console.log(data);

		res.status(200).send({
			message: "Chats retrieved successfully!",
			data
		});
	}

	private async getContacts(req: Request, res: Response) {
		const data = await contactsService.getContacts(req.session.instance);

		console.log(data[0]);

		res.status(200).send({
			message: "Chats retrieved successfully!",
			data
		});
	}

	private async getContactsWithCustomer(req: Request, res: Response) {
		const sectorIdsParam = req.query["sectorIds"] as string | undefined;
		const sectorIds = sectorIdsParam
			? sectorIdsParam
				.split(",")
				.map((id) => Number(id))
				.filter((id) => !Number.isNaN(id))
			: null;

		const filters = {
			name: (req.query["name"] as string) || null,
			phone: (req.query["phone"] as string) || null,
			customerId: req.query["customerId"] ? Number(req.query["customerId"]) : null,
			customerErp: (req.query["customerErp"] as string) || null,
			customerCnpj: (req.query["customerCnpj"] as string) || null,
			customerName: (req.query["customerName"] as string) || null,
			hasCustomer: req.query["hasCustomer"] ? req.query["hasCustomer"] === "true" : null,
			sectorIds,
			page: req.query["page"] ? Number(req.query["page"]) : 1,
			perPage: req.query["perPage"] ? Number(req.query["perPage"]) : 50
		};

		const result = await contactsService.getContactsWithCustomer(
			req.session.instance,
			req.headers["authorization"] as string,
			filters
		);

		const resBody = {
			message: "Contacts retrieved successfully!",
			...result
		};
		res.status(200).send(resBody);
	}

	private async createContact(req: Request, res: Response) {
		const customerId = req.params["id"] ? Number(req.params["id"]) : undefined;
		const { name, phone, sectorIds } = req.body;

		// sectorIds is optional and should be an array of numbers when provided
		const parsedSectorIds = Array.isArray(sectorIds) ? sectorIds.map((s: any) => Number(s)) : undefined;

		const contact = await contactsService.createContact(
			req.session.instance,
			name,
			phone,
			customerId,
			parsedSectorIds
		);

		res.status(200).send({
			message: "Contact created successfully!",
			data: contact
		});
	}

	private async updateContact(req: Request, res: Response) {
		const contactId = Number(req.params["contactId"]);
		const { sectorIds, ...updateData } = req.body;
		const parsedSectorIds = Array.isArray(sectorIds) ? sectorIds.map((s: any) => Number(s)) : undefined;

		const updatedContact = await contactsService.updateContactWrapper(
			req.session,
			contactId,
			updateData,
			parsedSectorIds
		);

		res.status(200).send({
			message: "Contact updated successfully!",
			data: updatedContact
		});
	}

	private async deleteContact(req: Request, res: Response) {
		const contactId = Number(req.params["contactId"]);

		await contactsService.deleteContact(contactId);

		res.status(200).send({
			message: "Contact deleted successfully!"
		});
	}
}

export default new ContactsController(Router());
