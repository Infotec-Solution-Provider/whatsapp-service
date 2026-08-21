import { ContactActionRequestStatus, ContactActionRequestType } from "@prisma/client";
import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAdmin from "../middlewares/is-admin.middleware";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import contactActionRequestsService from "../services/contact-action-requests.service";
import ContactSearchService from "../services/contact-search.service";

class ContactActionRequestsController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/contact-action-requests", isAuthenticated, isAdmin, this.list);
		this.router.patch(
			"/api/whatsapp/contact-action-requests/:requestId/decision",
			isAuthenticated,
			isAdmin,
			this.decide
		);
	}

	private async list(req: Request, res: Response) {
		const statuses: ContactActionRequestStatus[] = ["PENDING", "APPROVED", "REJECTED"];
		const actions: ContactActionRequestType[] = ["REACTIVATE", "DELETE"];
		const status = statuses.includes(req.query["status"] as ContactActionRequestStatus)
			? (req.query["status"] as ContactActionRequestStatus)
			: undefined;
		const action = actions.includes(req.query["action"] as ContactActionRequestType)
			? (req.query["action"] as ContactActionRequestType)
			: undefined;
		const requests = await contactActionRequestsService.list(req.session.instance, status, action);
		const searchService = new ContactSearchService(req.headers["authorization"] || "");
		const summaries = await searchService.enrichContacts(
			req.session.instance,
			requests.map((item) => item.contact)
		);
		const summariesById = new Map(summaries.map((contact) => [contact.id, contact]));

		res.status(200).send({
			message: "Solicitações carregadas com sucesso!",
			data: requests.map((request) => ({
				...request,
				contact: summariesById.get(request.contactId) ?? request.contact
			}))
		});
	}

	private async decide(req: Request, res: Response) {
		const requestId = Number(req.params["requestId"]);
		const decision = req.body?.decision;
		if (!Number.isInteger(requestId) || requestId <= 0) throw new BadRequestError("requestId inválido.");
		if (decision !== "APPROVE" && decision !== "REJECT") {
			throw new BadRequestError("decision deve ser APPROVE ou REJECT.");
		}

		const request = await contactActionRequestsService.decide(
			req.session,
			requestId,
			decision,
			req.body?.reviewNote
		);
		res.status(200).send({ message: "Solicitação analisada com sucesso!", data: request });
	}
}

export default new ContactActionRequestsController(Router());
