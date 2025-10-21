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
		this.router.put("/api/whatsapp/contacts/:contactId", isAuthenticated, this.updateContact);
		this.router.delete("/api/whatsapp/contacts/:contactId", isAuthenticated, this.deleteContact);
	}

	private async getCustomerContacts(req: Request, res: Response) {
		const data = await contactsService.getCustomerContacts(req.session.instance, Number(req.params["id"]));

		res.status(200).send({
			message: "Chats retrieved successfully!",
			data
		});
	}

	private async getContacts(req: Request, res: Response) {
		const data = await contactsService.getContacts(req.session.instance);

		res.status(200).send({
			message: "Chats retrieved successfully!",
			data
		});
	}

	private async getContactsWithCustomer(req: Request, res: Response) {
		const filters = {
			name: (req.query['name'] as string) || null,
			phone: (req.query['phone'] as string) || null,
			customerId: req.query['customerId'] ? Number(req.query['customerId']) : null,
			customerErp: (req.query['customerErp'] as string) || null,
			customerCnpj: (req.query['customerCnpj'] as string) || null,
			customerName: (req.query['customerName'] as string) || null,
			hasCustomer: req.query['hasCustomer'] ? req.query['hasCustomer'] === 'true' : null,
			page: req.query['page'] ? Number(req.query['page']) : 1,
			perPage: req.query['perPage'] ? Number(req.query['perPage']) : 50
		};

		const result = await contactsService.getContactsWithCustomer(
			req.session.instance,
			req.headers["authorization"] as string,
			filters
		);

		const resBody = {
			message: "Contacts retrieved successfully!",
			...result
		}
		res.status(200).send(resBody);
	}

	private async createContact(req: Request, res: Response) {
		const customerId = Number(req.params["id"]);
		const { name, phone } = req.body;

		const contact = await contactsService.createContact(req.session.instance, name, phone, customerId);

		res.status(200).send({
			message: "Contact created successfully!",
			data: contact
		});
	}

	private async updateContact(req: Request, res: Response) {
		const contactId = Number(req.params["contactId"]);
		const updatedContact = await contactsService.updateContact(contactId, req.body);

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
