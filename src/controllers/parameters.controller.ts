import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import parametersService from "../services/parameters.service";

class ParametersController {
	constructor(public readonly router: Router) {
		this.router.get(
			"/api/whatsapp/session/parameters",
			isAuthenticated,
			this.getParmetersBySession
		);
	}

	private async getParmetersBySession(req: Request, res: Response) {
		const parameters = await parametersService.getSessionParams(
			req.session
		);

		res.status(200).send({
			message: "successfuly loaded session parameters",
			parameters
		});
	}
}

export default new ParametersController(Router());
