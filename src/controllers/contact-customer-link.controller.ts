import { Router, type Request } from "express";
import { BadRequestError } from "@rgranatodutra/http-errors";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import protectedRead from "../middlewares/protected-read";
import prismaService from "../services/prisma.service";
import contactsService from "../services/contacts.service";
import getCustomersClient from "../services/customers.service";
import instancesService from "../services/instances.service";
import parametersService from "../services/parameters.service";
import { ContactCustomerLinkService, positiveContactId, type LinkCustomer } from "../services/contact-customer-link.service";
import { CONTACT_PHONE_SUGGESTIONS_PARAMETER, CUSTOMER_PHONE_COLUMNS, suggestCustomersByPhone } from "../services/contact-customer-suggestions.service";

const router = Router();

function customerLookup(req: Request) {
	const client = getCustomersClient();
	client.setAuth((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
	return async (id: number): Promise<LinkCustomer | null> => {
		const response = await client.getCustomers({ CODIGO: String(id), page: "1", perPage: "1" });
		const customer = response.data?.find((row) => Number(row.CODIGO) === id);
		return customer ? {
			id, name: customer.RAZAO || customer.FANTASIA || String(id),
			cpfCnpj: customer.CPF_CNPJ || null, erpCode: customer.COD_ERP || null
		} : null;
	};
}

router.post("/api/whatsapp/contacts/:contactId/customer", isAuthenticated, async (req, res) => {
	const service = new ContactCustomerLinkService({
		getContact: (instance, id) => prismaService.wppContact.findFirst({ where: { instance, id } }),
		getCustomer: customerLookup(req),
		linkIfUnlinked: async (instance, id, customerId) => (await prismaService.wppContact.updateMany({
			where: { instance, id, isDeleted: false, OR: [{ customerId: null }, { customerId: { in: [0, -1] } }] }, data: { customerId }
		})).count,
		syncContact: (contact) => contactsService.syncContactStateToLocal(contact, undefined, true)
	});
	const data = await service.link(req.session.instance, req.params["contactId"], req.body?.customerId);
	res.status(200).send({ message: "Cliente vinculado ao contato.", data });
});

router.get("/api/whatsapp/contacts/:contactId/customer-suggestions", isAuthenticated,
	protectedRead("contacts.customer-suggestions", async (req) => {
		const instance = req.session.instance;
		const id = positiveContactId(req.params["contactId"]);
		const contact = await prismaService.wppContact.findFirst({ where: { instance, id, isDeleted: false } });
		if (!contact) throw new BadRequestError("Contato ativo não encontrado.");
		const enabled = await parametersService.getInstanceBooleanParam(instance, CONTACT_PHONE_SUGGESTIONS_PARAMETER, false);
		const data = await suggestCustomersByPhone(enabled, contact.phone, {
			columns: async () => {
				const placeholders = CUSTOMER_PHONE_COLUMNS.map(() => "?").join(",");
				const rows = await instancesService.executeQuery<Array<{ COLUMN_NAME: string }>>(instance,
					`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (${placeholders})`,
					["clientes", ...CUSTOMER_PHONE_COLUMNS]);
				return rows.map((row) => row.COLUMN_NAME);
			},
			query: (sql, params) => instancesService.executeQuery<Array<{ id: number }>>(instance, sql, params),
			getCustomer: customerLookup(req)
		});
		return { data };
	})
);

export default router;
