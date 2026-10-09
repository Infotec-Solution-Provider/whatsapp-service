import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import parametersService from "../services/parameters.service";
import isAdmin from "../middlewares/is-admin.middleware";
import parameterSettingsService from "../services/parameter-settings.service";

class ParametersController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/parameter-settings", isAuthenticated, isAdmin, this.getSettings);
		this.router.patch("/api/whatsapp/parameter-settings", isAuthenticated, isAdmin, this.saveSettings);
		this.router.get(
			"/api/whatsapp/session/parameters",
			isAuthenticated,
			this.getParmetersBySession
		);
	}

	private async getSettings(req: Request, res: Response) {
		res.setHeader("Cache-Control", "no-store");
		res.status(200).send({ data: await parameterSettingsService.get(req.session.instance) });
	}

	private async saveSettings(req: Request, res: Response) {
		res.setHeader("Cache-Control", "no-store");
		res.status(200).send({ data: await parameterSettingsService.save(req.session.instance, req.body) });
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
