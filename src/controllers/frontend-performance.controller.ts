import { BadRequestError, UnauthorizedError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAdmin from "../middlewares/is-admin.middleware";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import frontendPerformanceService, {
	FRONTEND_PERFORMANCE_FLAG,
	FrontendPerformanceFilters,
	FrontendPerformanceValidationError,
	normalizeFrontendRoute,
	parseFrontendPerformanceBatch
} from "../services/frontend-performance.service";
import parametersService from "../services/parameters.service";

function parseDate(value: unknown, fallback: Date): Date {
	if (typeof value !== "string") return fallback;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new BadRequestError("Invalid date filter");
	return date;
}

function parseFilters(req: Request): FrontendPerformanceFilters {
	const to = parseDate(req.query["to"], new Date());
	const from = parseDate(req.query["from"], new Date(to.getTime() - 4 * 60 * 60 * 1000));
	if (from >= to) throw new BadRequestError("from must be before to");
	if (to.getTime() - from.getTime() > 30 * 24 * 60 * 60 * 1000) {
		throw new BadRequestError("The maximum query window is 30 days");
	}

	const filters: FrontendPerformanceFilters = { from, to };
	if (typeof req.query["name"] === "string") filters.name = req.query["name"].slice(0, 64);
	if (typeof req.query["route"] === "string") filters.route = normalizeFrontendRoute(req.query["route"]);
	if (typeof req.query["buildId"] === "string") filters.buildId = req.query["buildId"].slice(0, 64);
	if (typeof req.query["deviceClass"] === "string") {
		const deviceClass = req.query["deviceClass"].toUpperCase();
		if (!["LOW", "STANDARD", "UNKNOWN"].includes(deviceClass)) throw new BadRequestError("Invalid deviceClass");
		filters.deviceClass = deviceClass;
	}
	return filters;
}

class FrontendPerformanceController {
	constructor(public readonly router: Router) {
		this.router.post("/api/whatsapp/frontend-performance/batches", isAuthenticated, this.ingest);
		this.router.get("/api/whatsapp/frontend-performance/summary", isAuthenticated, isAdmin, this.summary);
		this.router.get("/api/whatsapp/frontend-performance/export.csv", isAuthenticated, isAdmin, this.exportCsv);
	}

	private ingest = async (req: Request, res: Response) => {
		const parameters = await parametersService.getSessionParams(req.session);
		if (parameters[FRONTEND_PERFORMANCE_FLAG] !== "true") {
			throw new UnauthorizedError("Frontend performance telemetry is disabled for this session");
		}

		try {
			const batch = parseFrontendPerformanceBatch(req.body);
			const result = await frontendPerformanceService.ingest(req.session.instance, req.session.userId, batch);
			res.status(202).send(result);
		} catch (error) {
			if (error instanceof FrontendPerformanceValidationError) throw new BadRequestError(error.message);
			throw error;
		}
	};

	private summary = async (req: Request, res: Response) => {
		res.status(200).send(await frontendPerformanceService.summary(req.session.instance, parseFilters(req)));
	};

	private exportCsv = async (req: Request, res: Response) => {
		const csv = await frontendPerformanceService.exportCsv(req.session.instance, parseFilters(req));
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", 'attachment; filename="frontend-performance.csv"');
		res.status(200).send(`\uFEFF${csv}`);
	};
}

export default new FrontendPerformanceController(Router());
