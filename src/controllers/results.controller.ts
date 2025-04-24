import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import whatsappService from "../services/whatsapp.service";

class ResultsController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/results",
			isAuthenticated,
			this.getResults
		);
	}

	private async getResults(req: Request, res: Response) {
		const data = await whatsappService.getResults(req.session.instance);

		res.status(200).send({
			message: "Results retrieved successfully!",
			data
		});
	}
}

export default new ResultsController(Router());
