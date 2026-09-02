import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import publicBiRateLimit from "../middlewares/public-bi-rate-limit.middleware";
import getUsersClient from "../services/users.service";

class PublicDirectoryController {
	constructor(public readonly router: Router) {
		this.router.get("/api/whatsapp/users", publicBiRateLimit, isAuthenticated, this.getUsers);
	}

	private async getUsers(req: Request, res: Response) {
		const rawPage = req.query["page"];
		const rawLimit = req.query["limit"];
		const page = rawPage === undefined || rawPage === "" ? 1 : Number(rawPage);
		const limit = rawLimit === undefined || rawLimit === "" ? 50 : Number(rawLimit);
		const rawActive = req.query["active"];

		if (!Number.isInteger(page) || page <= 0) {
			throw new BadRequestError("page must be a positive integer!");
		}

		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new BadRequestError("limit must be an integer between 1 and 100!");
		}

		if (rawActive !== undefined && rawActive !== "true" && rawActive !== "false") {
			throw new BadRequestError("active must be true or false!");
		}

		const usersClient = getUsersClient();
		const token = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
		usersClient.setAuth(token);
		const users = await usersClient.getUsers({
			page: String(page),
			perPage: String(limit),
			sortBy: "CODIGO",
			...(rawActive === undefined ? {} : { ATIVO: rawActive === "true" ? "SIM" : "NAO" })
		});
		const total = users.page.totalRows;

		res.status(200).send({
			message: "Users retrieved successfully!",
			data: {
				items: users.data.map((user) => ({
					id: user.CODIGO,
					name: user.NOME,
					displayName: user.NOME_EXIBICAO,
					sectorId: user.SETOR,
					role: user.NIVEL,
					active: user.ATIVO === "SIM"
				})),
				pagination: {
					page,
					limit,
					total,
					totalPages: Math.ceil(total / limit),
					hasNextPage: page * limit < total,
					hasPreviousPage: page > 1
				}
			}
		});
	}
}

export default new PublicDirectoryController(Router());
