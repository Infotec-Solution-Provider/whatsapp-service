import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import publicBiRateLimit from "../middlewares/public-bi-rate-limit.middleware";
import instancesService from "../services/instances.service";

interface OperatorDirectoryRow {
	CODIGO: number | string;
	NOME: string;
	NOME_EXIBICAO?: string | null;
	SETOR: number | null;
	NIVEL: string | null;
	ATIVO: string | null;
	DESATIVAR_EXIBICAO_WHATS?: number | string | boolean | null;
}

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

		// Mesma base dos relatórios: todos os operadores do CRM, inclusive os ocultos no WhatsApp,
		// para que todo `report.userId` das rotas BI tenha um usuário correspondente.
		const where = rawActive === undefined ? "" : " WHERE ATIVO = ?";
		const params = rawActive === undefined ? [] : [rawActive === "true" ? "SIM" : "NAO"];
		const [countRows, rows] = await Promise.all([
			instancesService.executeQuery<Array<{ total: number | string }>>(
				req.session.instance,
				`SELECT COUNT(*) AS total FROM operadores${where}`,
				params
			),
			instancesService.executeQuery<OperatorDirectoryRow[]>(
				req.session.instance,
				`SELECT * FROM operadores${where} ORDER BY CODIGO LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
				params
			)
		]);
		const total = Number(countRows[0]?.total ?? 0);

		res.status(200).send({
			message: "Users retrieved successfully!",
			data: {
				items: rows.map((user) => ({
					id: Number(user.CODIGO),
					name: user.NOME,
					displayName: user.NOME_EXIBICAO ?? null,
					sectorId: user.SETOR,
					role: user.NIVEL,
					active: user.ATIVO === "SIM",
					visibleInWhatsapp: !Number(user.DESATIVAR_EXIBICAO_WHATS ?? 0)
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
