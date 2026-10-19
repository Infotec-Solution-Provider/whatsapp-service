export type SurveyQuery = (sql: string, values: unknown[]) => Promise<unknown>;

export interface SurveyAnswerInput {
	chatId: number;
	numberId: number;
	messageId: number;
	questionKey: string;
	question: string;
	questionIndex: number;
	answer: string;
	rating: number;
}

function rows(result: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(result)) return [];
	return (Array.isArray(result[0]) ? result[0] : result) as Array<Record<string, unknown>>;
}

function missingOptionalColumn(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return /unknown column/i.test(message) && /QUESTION_KEY|SURVEY_VERSION|QUESTION_INDEX|IS_NOT_APPLICABLE|SCALE_MIN|SCALE_MAX/i.test(message);
}

/** The source message is already durable in messages; keep its ID in an existing text column. */
export function surveyQuestionStorageText(input: Pick<SurveyAnswerInput, "questionKey" | "question" | "messageId">): string {
	if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !/^q[1-4]$/.test(input.questionKey)) {
		throw new Error("SURVEY_INVALID_ANSWER_IDENTITY");
	}
	return `[${input.questionKey}] [m:${input.messageId}] ${input.question}`;
}

/** Serialized by chat by the caller. Readback also resolves a lost INSERT response. */
export async function persistSurveyAnswer(query: SurveyQuery, input: SurveyAnswerInput): Promise<void> {
	const storedQuestion = surveyQuestionStorageText(input);
	const confirmed = async () => {
		const existing = rows(await query(
			"SELECT RESPOSTA, NOTA FROM w_questionarios_respostas WHERE CODIGO_ATENDIMENTO = ? AND PERGUNTA = ? LIMIT 2",
			[input.chatId, storedQuestion],
		));
		if (existing.length > 1 || existing.some(row => String(row["RESPOSTA"] ?? "") !== input.answer || Number(row["NOTA"]) !== input.rating)) {
			throw new Error("SURVEY_IDEMPOTENCY_CONFLICT");
		}
		return existing.length === 1;
	};
	if (await confirmed()) return;
	const guard = " SELECT ?, ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM w_questionarios_respostas WHERE CODIGO_ATENDIMENTO = ? AND PERGUNTA = ?)";
	const legacyValues = [input.chatId, input.numberId, storedQuestion, input.answer, input.rating];
	try {
		try {
			await query(
				"INSERT INTO w_questionarios_respostas (CODIGO_ATENDIMENTO, CODIGO_NUMERO, PERGUNTA, RESPOSTA, NOTA, QUESTION_KEY, SURVEY_VERSION, QUESTION_INDEX, IS_NOT_APPLICABLE, SCALE_MIN, SCALE_MAX) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM w_questionarios_respostas WHERE CODIGO_ATENDIMENTO = ? AND PERGUNTA = ?)",
				[...legacyValues, input.questionKey, "EXA_V2_1_10", input.questionIndex + 1, input.rating === 99 ? 1 : 0, 1, 10, input.chatId, storedQuestion],
			);
		} catch (error) {
			// A transport error may mean COMMIT already happened. Never issue the fallback for that case.
			if (!missingOptionalColumn(error)) throw error;
			await query(
				"INSERT INTO w_questionarios_respostas (CODIGO_ATENDIMENTO, CODIGO_NUMERO, PERGUNTA, RESPOSTA, NOTA)" + guard,
				[...legacyValues, input.chatId, storedQuestion],
			);
		}
	} catch {
		if (await confirmed()) return;
		throw new Error("SURVEY_ANSWER_PERSISTENCE_UNCONFIRMED");
	}
	if (!await confirmed()) throw new Error("SURVEY_ANSWER_PERSISTENCE_UNCONFIRMED");
}

export async function persistInitialSurveyRating(query: SurveyQuery, chatId: number, answer: string, rating: number): Promise<void> {
	const confirmed = async () => rows(await query(
		"SELECT NOTA_ATENDIMENTO, COMENTARIO FROM w_atendimentos_feedbacks WHERE CODIGO_ATENDIMENTO = ?",
		[chatId],
	)).some(row => Number(row["NOTA_ATENDIMENTO"]) === rating && String(row["COMENTARIO"] ?? "") === answer);
	if (await confirmed()) return;
	try {
		await query("UPDATE w_atendimentos_feedbacks SET NOTA_ATENDIMENTO = ?, COMENTARIO = ? WHERE CODIGO_ATENDIMENTO = ?", [rating, answer, chatId]);
	} catch {
		if (await confirmed()) return;
		throw new Error("SURVEY_INITIAL_RATING_UNCONFIRMED");
	}
	if (!await confirmed()) throw new Error("SURVEY_INITIAL_RATING_UNCONFIRMED");
}

export class SurveyChatLock {
	private readonly tails = new Map<number, Promise<void>>();
	async run<T>(chatId: number, action: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(chatId) ?? Promise.resolve();
		let release!: () => void;
		const tail = new Promise<void>(resolve => { release = resolve; });
		this.tails.set(chatId, tail);
		await previous;
		try { return await action(); }
		finally {
			release();
			if (this.tails.get(chatId) === tail) this.tails.delete(chatId);
		}
	}
}
