import { Logger, sanitizeErrorMessage } from "@in.pulse-crm/utils";
import { InternalChat, InternalMessage, Prisma } from "@prisma/client";
import { Pool, PoolOptions, RowDataPacket, createPool } from "mysql2/promise";
import prismaService from "./prisma.service";

interface BackfillOptions {
	instance: string | undefined;
	chatId: number | undefined;
	groupId: string | undefined;
	fromId: number | undefined;
	toId: number | undefined;
	batchSize: number | undefined;
	limit: number | undefined;
	windowSeconds: number | undefined;
	maxLogCandidates: number | undefined;
	apply: boolean | undefined;
}

interface ResolvedBackfillOptions {
	instance: string | undefined;
	chatId: number | undefined;
	groupId: string | undefined;
	fromId: number | undefined;
	toId: number | undefined;
	batchSize: number;
	limit: number;
	windowSeconds: number;
	maxLogCandidates: number;
	dryRun: boolean;
}

interface BackfillStats {
	processed: number;
	matched: number;
	updated: number;
	skippedNoMatch: number;
	skippedAmbiguous: number;
	skippedNoIds: number;
	failed: number;
}

type InternalMessageCandidate = Pick<
	InternalMessage,
	"id" | "instance" | "body" | "timestamp" | "fileName" | "type" | "wwebjsId" | "wwebjsIdStanza"
> & {
	chat: Pick<InternalChat, "id" | "wppGroupId"> | null;
};

interface WwebjsSendLogRow extends RowDataPacket {
	id: number;
	start_time: Date;
	input: string | null;
	output: string | null;
}

interface SendLogInputProps {
	to?: string;
	text?: string | null;
	fileName?: string;
	fileType?: string;
}

interface SendLogInput {
	props: SendLogInputProps;
	isGroup: boolean;
}

interface SendLogResult {
	body?: string;
	type?: string;
	wwebjsId?: string | null;
	wwebjsIdStanza?: string | null;
}

interface ParsedSendLog {
	logId: number;
	startTime: Date;
	input: SendLogInput;
	result: SendLogResult;
}

interface ScoredCandidate {
	candidate: ParsedSendLog;
	timeDiffMs: number;
	exactText: boolean;
	exactFile: boolean;
	exactType: boolean;
}

class InternalMessageWwebjsBackfillService {
	private pool: Pool | null = null;

	public async execute(options: BackfillOptions): Promise<BackfillStats> {
		const resolved = this.resolveOptions(options);
		const stats: BackfillStats = {
			processed: 0,
			matched: 0,
			updated: 0,
			skippedNoMatch: 0,
			skippedAmbiguous: 0,
			skippedNoIds: 0,
			failed: 0
		};
		const usedLogIds = new Set<number>();

		Logger.info(
			`[internal-message-wwebjs-backfill] Iniciando backfill (dryRun=${resolved.dryRun}, batchSize=${resolved.batchSize}, limit=${resolved.limit}, windowSeconds=${resolved.windowSeconds})`
		);

		try {
			let lastProcessedId = Math.max(0, resolved.fromId || 0);
			let remaining = resolved.limit;

			while (remaining > 0) {
				const batchSize = Math.min(resolved.batchSize, remaining);
				const messages = await this.fetchBatch(lastProcessedId, batchSize, resolved);

				if (!messages.length) {
					break;
				}

				for (const message of messages) {
					stats.processed += 1;
					lastProcessedId = message.id;

					try {
						const matchResult = await this.findBestCandidate(message, resolved, usedLogIds);

						if (matchResult === "no-match") {
							stats.skippedNoMatch += 1;
							continue;
						}

						if (matchResult === "ambiguous") {
							stats.skippedAmbiguous += 1;
							continue;
						}

						stats.matched += 1;

						const updateData = this.buildUpdateData(message, matchResult.result);

						if (!Object.keys(updateData).length) {
							stats.skippedNoIds += 1;
							continue;
						}

						usedLogIds.add(matchResult.logId);

						if (resolved.dryRun) {
							Logger.info(
								`[internal-message-wwebjs-backfill] Dry-run mensagem ${message.id} -> log ${matchResult.logId} | wwebjsId=${matchResult.result.wwebjsId || "null"} | wwebjsIdStanza=${matchResult.result.wwebjsIdStanza || "null"}`
							);
							continue;
						}

						await prismaService.internalMessage.update({
							where: { id: message.id },
							data: updateData
						});

						stats.updated += 1;
						Logger.info(
							`[internal-message-wwebjs-backfill] Mensagem ${message.id} atualizada via log ${matchResult.logId}`
						);
					} catch (error) {
						stats.failed += 1;
						Logger.error(
							`[internal-message-wwebjs-backfill] Falha ao processar mensagem ${message.id}: ${sanitizeErrorMessage(error)}`
						);
					}
				}

				remaining -= messages.length;
				Logger.info(
					`[internal-message-wwebjs-backfill] Progresso: processed=${stats.processed}, matched=${stats.matched}, updated=${stats.updated}, noMatch=${stats.skippedNoMatch}, ambiguous=${stats.skippedAmbiguous}, noIds=${stats.skippedNoIds}, failed=${stats.failed}`
				);
			}

			Logger.info(
				`[internal-message-wwebjs-backfill] Finalizado. processed=${stats.processed}, matched=${stats.matched}, updated=${stats.updated}, noMatch=${stats.skippedNoMatch}, ambiguous=${stats.skippedAmbiguous}, noIds=${stats.skippedNoIds}, failed=${stats.failed}`
			);

			return stats;
		} finally {
			await this.closePool();
		}
	}

	private resolveOptions(options: BackfillOptions): ResolvedBackfillOptions {
		return {
			instance: options.instance,
			chatId: options.chatId,
			groupId: options.groupId,
			fromId: options.fromId,
			toId: options.toId,
			batchSize: Math.max(1, options.batchSize || 50),
			limit: Math.max(1, options.limit || 500),
			windowSeconds: Math.max(10, options.windowSeconds || 120),
			maxLogCandidates: Math.max(1, options.maxLogCandidates || 25),
			dryRun: !options.apply
		};
	}

	private async fetchBatch(
		lastProcessedId: number,
		take: number,
		options: ResolvedBackfillOptions
	): Promise<InternalMessageCandidate[]> {
		const where: Prisma.InternalMessageWhereInput = {
			id: {
				gt: lastProcessedId,
				...(options.toId ? { lte: options.toId } : {})
			},
			from: {
				startsWith: "user:"
			},
			OR: [{ wwebjsId: null }, { wwebjsIdStanza: null }],
			chat: {
				is: {
					wppGroupId: {
						not: null
					},
					...(options.instance ? { instance: options.instance } : {}),
					...(options.chatId ? { id: options.chatId } : {}),
					...(options.groupId ? { wppGroupId: options.groupId } : {})
				}
			}
		};

		return prismaService.internalMessage.findMany({
			where,
			select: {
				id: true,
				instance: true,
				body: true,
				timestamp: true,
				fileName: true,
				type: true,
				wwebjsId: true,
				wwebjsIdStanza: true,
				chat: {
					select: {
						id: true,
						wppGroupId: true
					}
				}
			},
			orderBy: {
				id: "asc"
			},
			take
		});
	}

	private async findBestCandidate(
		message: InternalMessageCandidate,
		options: ResolvedBackfillOptions,
		usedLogIds: Set<number>
	): Promise<ParsedSendLog | "no-match" | "ambiguous"> {
		const candidates = await this.fetchLogCandidates(message, options);
		const scoredCandidates: ScoredCandidate[] = [];

		for (const candidate of candidates) {
			if (usedLogIds.has(candidate.logId)) {
				continue;
			}

			const scored = this.scoreCandidate(message, candidate);
			if (scored) {
				scoredCandidates.push(scored);
			}
		}

		if (!scoredCandidates.length) {
			return "no-match";
		}

		scoredCandidates.sort((left, right) => {
			if (left.exactText !== right.exactText) {
				return left.exactText ? -1 : 1;
			}

			if (left.exactFile !== right.exactFile) {
				return left.exactFile ? -1 : 1;
			}

			if (left.exactType !== right.exactType) {
				return left.exactType ? -1 : 1;
			}

			if (left.timeDiffMs !== right.timeDiffMs) {
				return left.timeDiffMs - right.timeDiffMs;
			}

			return left.candidate.logId - right.candidate.logId;
		});

		const [best, second] = scoredCandidates;

		if (best && second) {
			const sameQuality =
				best.exactText === second.exactText &&
				best.exactFile === second.exactFile &&
				best.exactType === second.exactType;
			const closeTimeDiff = Math.abs(best.timeDiffMs - second.timeDiffMs) <= 1000;

			if (sameQuality && closeTimeDiff) {
				Logger.info(
					`[internal-message-wwebjs-backfill] Match ambíguo para mensagem ${message.id}: logs ${best.candidate.logId} e ${second.candidate.logId}`
				);
				return "ambiguous";
			}
		}

		return best!.candidate;
	}

	private scoreCandidate(message: InternalMessageCandidate, candidate: ParsedSendLog): ScoredCandidate | null {
		if (!message.chat) {
			return null;
		}

		const expectedGroupId = message.chat.wppGroupId;
		if (!expectedGroupId || candidate.input.props.to !== expectedGroupId) {
			return null;
		}

		if (!candidate.input.isGroup) {
			return null;
		}

		const candidateFileName = candidate.input.props.fileName || null;
		const messageFileName = message.fileName || null;

		if (messageFileName !== candidateFileName) {
			return null;
		}

		const candidateText = candidate.input.props.text ?? candidate.result.body ?? "";
		if (!this.isCompatibleText(message.body, candidateText)) {
			return null;
		}

		const normalizedMessageBody = this.normalizeText(message.body);
		const normalizedCandidateText = this.normalizeText(this.stripSenderPrefix(candidateText));
		const timeDiffMs = Math.abs(this.toDate(message.timestamp).getTime() - candidate.startTime.getTime());

		return {
			candidate,
			timeDiffMs,
			exactText: normalizedMessageBody === normalizedCandidateText,
			exactFile: messageFileName === candidateFileName,
			exactType: !!message.type && !!candidate.result.type && message.type === candidate.result.type
		};
	}

	private async fetchLogCandidates(
		message: InternalMessageCandidate,
		options: ResolvedBackfillOptions
	): Promise<ParsedSendLog[]> {
		if (!message.chat) {
			return [];
		}

		const pool = this.getPool();
		const sentAt = this.toDate(message.timestamp);
		const startsAt = new Date(sentAt.getTime() - options.windowSeconds * 1000);
		const endsAt = new Date(sentAt.getTime() + options.windowSeconds * 1000);
		const groupId = message.chat.wppGroupId;

		if (!groupId) {
			return [];
		}

		const [rows] = await pool.query<WwebjsSendLogRow[]>(
			`
				SELECT id, start_time, input, output
				FROM logs
				WHERE instance = ?
				  AND process_name = 'Send Message'
				  AND has_error = 0
				  AND start_time BETWEEN ? AND ?
				  AND input LIKE ?
				  AND input LIKE '%"isGroup":true%'
				ORDER BY start_time ASC
				LIMIT ?
			`,
			[message.instance, startsAt, endsAt, `%"to":"${groupId}"%`, options.maxLogCandidates]
		);

		return rows
			.map((row) => this.parseLogRow(row))
			.filter((row): row is ParsedSendLog => row !== null);
	}

	private parseLogRow(row: WwebjsSendLogRow): ParsedSendLog | null {
		const input = this.safeParseJson(row.input);
		const output = this.safeParseJson(row.output);

		if (!input || typeof input !== "object") {
			return null;
		}

		const inputData = input as { props?: SendLogInputProps; isGroup?: boolean };
		if (!inputData.props || typeof inputData.props !== "object") {
			return null;
		}

		const result = this.extractResultFromOutput(output);
		if (!result || (!result.wwebjsId && !result.wwebjsIdStanza)) {
			return null;
		}

		return {
			logId: row.id,
			startTime: new Date(row.start_time),
			input: {
				props: inputData.props,
				isGroup: inputData.isGroup === true
			},
			result
		};
	}

	private extractResultFromOutput(output: unknown): SendLogResult | null {
		if (Array.isArray(output)) {
			for (let index = output.length - 1; index >= 0; index -= 1) {
				const item = output[index];
				if (!item || typeof item !== "object") {
					continue;
				}

				const candidate = item as SendLogResult;
				if (candidate.wwebjsId || candidate.wwebjsIdStanza) {
					return candidate;
				}
			}
		}

		if (output && typeof output === "object") {
			const candidate = output as SendLogResult;
			if (candidate.wwebjsId || candidate.wwebjsIdStanza) {
				return candidate;
			}
		}

		return null;
	}

	private buildUpdateData(
		message: InternalMessageCandidate,
		result: SendLogResult
	): Prisma.InternalMessageUpdateInput {
		const data: Prisma.InternalMessageUpdateInput = {};

		if (!message.wwebjsId && result.wwebjsId) {
			data.wwebjsId = result.wwebjsId;
		}

		if (!message.wwebjsIdStanza && result.wwebjsIdStanza) {
			data.wwebjsIdStanza = result.wwebjsIdStanza;
		}

		return data;
	}

	private isCompatibleText(messageBody: string, candidateText: string): boolean {
		const normalizedMessageBody = this.normalizeText(messageBody);
		const normalizedCandidateText = this.normalizeText(candidateText);
		const normalizedCandidateWithoutPrefix = this.normalizeText(this.stripSenderPrefix(candidateText));

		if (!normalizedMessageBody) {
			return normalizedCandidateWithoutPrefix.length === 0;
		}

		return (
			normalizedMessageBody === normalizedCandidateText ||
			normalizedMessageBody === normalizedCandidateWithoutPrefix ||
			normalizedCandidateText.endsWith(normalizedMessageBody) ||
			normalizedCandidateWithoutPrefix.endsWith(normalizedMessageBody)
		);
	}

	private stripSenderPrefix(value: string): string {
		return value.replace(/^\*[^*]+\*:\s*/, "");
	}

	private normalizeText(value: string | null | undefined): string {
		return (value || "").replace(/\s+/g, " ").trim();
	}

	private safeParseJson(value: string | null): unknown {
		if (!value) {
			return null;
		}

		try {
			return JSON.parse(value);
		} catch {
			return null;
		}
	}

	private toDate(timestamp: string): Date {
		return new Date(Number(timestamp));
	}

	private getPool(): Pool {
		if (this.pool) {
			return this.pool;
		}

		this.pool = createPool(this.getPoolConfig());
		return this.pool;
	}

	private getPoolConfig(): PoolOptions {
		const databaseUrl = process.env["WWEBJS_API_DATABASE_URL"];
		if (databaseUrl) {
			const parsed = new URL(databaseUrl);
			return {
				host: parsed.hostname,
				port: parsed.port ? Number(parsed.port) : 3306,
				user: decodeURIComponent(parsed.username),
				password: decodeURIComponent(parsed.password),
				database: parsed.pathname.replace(/^\//, ""),
				connectionLimit: 5
			};
		}

		const host = process.env["WWEBJS_API_DB_HOST"] || process.env["MYSQL_HOST"];
		const port = process.env["WWEBJS_API_DB_PORT"] || process.env["MYSQL_PORT"];
		const user = process.env["WWEBJS_API_DB_USER"] || process.env["MYSQL_USER"];
		const password = process.env["WWEBJS_API_DB_PASSWORD"] || process.env["MYSQL_PASSWORD"];
		const database = process.env["WWEBJS_API_DB_NAME"] || process.env["MYSQL_DATABASE"];

		if (!host || !user || !database) {
			throw new Error(
				"Configure WWEBJS_API_DATABASE_URL, WWEBJS_API_DB_* ou MYSQL_* para acessar o banco do wwebjs-api"
			);
		}

		const config: PoolOptions = {
			host,
			port: port ? Number(port) : 3306,
			user,
			database,
			connectionLimit: 5
		};

		if (password !== undefined) {
			config.password = password;
		}

		return config;
	}

	private async closePool() {
		if (!this.pool) {
			return;
		}

		await this.pool.end();
		this.pool = null;
	}
}

export default new InternalMessageWwebjsBackfillService();