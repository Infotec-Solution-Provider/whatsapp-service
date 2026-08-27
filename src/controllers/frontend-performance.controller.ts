import { BadRequestError, UnauthorizedError } from "@rgranatodutra/http-errors";
import { Logger } from "@in.pulse-crm/utils";
import express, { Request, Response, Router } from "express";
import isAdmin from "../middlewares/is-admin.middleware";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import frontendPerformanceRateLimit from "../middlewares/frontend-performance-rate-limit.middleware";
import frontendPerformanceService, {
	FRONTEND_PERFORMANCE_FLAG,
	FRONTEND_PERFORMANCE_MAX_BATCH_BYTES,
	FrontendPerformanceFilters,
	FrontendPerformanceValidationError,
	redactFrontendInstanceFromRoute,
	parseFrontendPerformanceBatch
} from "../services/frontend-performance.service";
import parametersService from "../services/parameters.service";

function waitForDrainOrClose(res: Response): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			res.off("drain", finish);
			res.off("close", finish);
			res.off("error", finish);
			resolve();
		};
		res.once("drain", finish);
		res.once("close", finish);
		res.once("error", finish);
	});
}

async function writeCsvChunk(res: Response, chunk: string): Promise<boolean> {
	if (res.destroyed || res.writableEnded) return false;
	if (res.write(chunk)) return true;
	await waitForDrainOrClose(res);
	return !res.destroyed && !res.writableEnded;
}

function parseDate(value: unknown, fallback: Date): Date {
	if (typeof value !== "string") return fallback;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new BadRequestError("Invalid date filter");
	return date;
}

function handleTelemetryJsonError(error: unknown, _req: Request, res: Response, next: express.NextFunction) {
	const parserError = error as { status?: number; type?: string };
	if (parserError.status === 413 || parserError.type === "entity.too.large") {
		res.status(413).json({ message: "Frontend performance telemetry batch is too large" });
		return;
	}
	if (parserError.status === 400 || parserError.type === "entity.parse.failed") {
		res.status(400).json({ message: "Frontend performance telemetry batch contains invalid JSON" });
		return;
	}
	if (
		parserError.status === 415 ||
		parserError.type === "encoding.unsupported" ||
		parserError.type === "charset.unsupported"
	) {
		res.status(415).json({ message: "Frontend performance telemetry encoding is not supported" });
		return;
	}
	next(error);
}

function requireTelemetryJsonContentType(req: Request, res: Response, next: express.NextFunction) {
	const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/json" && !/^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(contentType ?? "")) {
		res.status(415).json({ message: "Frontend performance telemetry requires a JSON content type" });
		return;
	}
	next();
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
	if (typeof req.query["route"] === "string") {
		filters.route = redactFrontendInstanceFromRoute(req.query["route"], req.session.instance);
	}
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
		this.router.post(
			"/api/whatsapp/frontend-performance/batches",
			isAuthenticated,
			frontendPerformanceRateLimit,
			requireTelemetryJsonContentType,
			express.json({
				limit: FRONTEND_PERFORMANCE_MAX_BATCH_BYTES,
				strict: true,
				// Content type is validated above. Parsing every accepted request keeps
				// the byte limit independent from body-parser media-type heuristics.
				type: () => true
			}),
			handleTelemetryJsonError,
			this.ingest
		);
		this.router.get("/api/whatsapp/frontend-performance/summary", isAuthenticated, isAdmin, this.summary);
		this.router.get("/api/whatsapp/frontend-performance/export.csv", isAuthenticated, isAdmin, this.exportCsv);
	}

	private ingest = async (req: Request, res: Response) => {
		const parameters = await parametersService.getSessionParams(req.session);
		if (parameters[FRONTEND_PERFORMANCE_FLAG] !== "true") {
			throw new UnauthorizedError("Frontend performance telemetry is disabled for this session");
		}

		try {
			const batch = parseFrontendPerformanceBatch(req.body, req.session.instance);
			const result = await frontendPerformanceService.ingest(req.session.instance, req.session.userId, batch);
			res.status(202).send(result);
		} catch (error) {
			if (error instanceof FrontendPerformanceValidationError) throw new BadRequestError(error.message);
			throw error;
		}
	};

	private summary = async (req: Request, res: Response) => {
		try {
			res.status(200).send(await frontendPerformanceService.summary(req.session.instance, parseFilters(req)));
		} catch (error) {
			if (error instanceof FrontendPerformanceValidationError) throw new BadRequestError(error.message);
			throw error;
		}
	};

	private exportCsv = async (req: Request, res: Response) => {
		const filters = parseFilters(req);
		const chunks = frontendPerformanceService.exportCsvChunks(req.session.instance, filters);
		// Force the first database page before committing a 200 response. Later
		// streaming failures close the response so a partial CSV is never mistaken
		// for a complete export.
		const firstChunk = await chunks.next();
		res.setHeader("Content-Type", "text/csv; charset=utf-8");
		res.setHeader("Content-Disposition", 'attachment; filename="frontend-performance.csv"');
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.status(200);
		try {
			if (!await writeCsvChunk(res, "\uFEFF")) return;
			if (!firstChunk.done && !await writeCsvChunk(res, firstChunk.value)) return;
			for await (const chunk of chunks) {
				if (!await writeCsvChunk(res, chunk)) return;
			}
			res.end();
		} catch (error) {
			Logger.error("Frontend performance CSV export failed", error as Error);
			if (!res.destroyed) {
				res.destroy(error instanceof Error ? error : undefined);
			}
		}
	};
}

export default new FrontendPerformanceController(Router());
