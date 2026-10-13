interface Token { kind: "word" | "number" | "parameter" | "symbol" | "quoted"; value: string; start: number; end: number; parameter?: number }

/** mysql2 encodes JS numbers as DOUBLE, which MySQL rejects for prepared LIMIT/OFFSET. */
export function compileRawPagination(sql: string, values: readonly unknown[]): { sql: string; values: unknown[] } {
	const tokens: Token[] = [];
	let index = 0, parameter = 0;
	while (index < sql.length) {
		const char = sql[index]!;
		if (/\s/.test(char)) { index++; continue; }
		if (char === "#" || char === "-" && sql[index + 1] === "-" && /\s/.test(sql[index + 2] ?? " ")) {
			while (index < sql.length && sql[index] !== "\n") index++;
			continue;
		}
		if (char === "/" && sql[index + 1] === "*") {
			const end = sql.indexOf("*/", index + 2);
			if (end < 0) throw new Error("TENANT_SQL_RAW_UNTERMINATED_COMMENT");
			// Executable comments have server/version-dependent placeholder semantics; never rewrite them.
			if (sql[index + 2] === "!" && sql.slice(index + 3, end).includes("?")) throw new Error("TENANT_SQL_RAW_EXECUTABLE_COMMENT_PARAMETER");
			index = end + 2;
			continue;
		}
		const start = index;
		if (char === "'" || char === '"' || char === "`") {
			const delimiter = char;
			let closed = false;
			index++;
			while (index < sql.length) {
				if (delimiter !== "`" && sql[index] === "\\") { index += 2; continue; }
				if (sql[index] === delimiter) {
					index++;
					if (sql[index] === delimiter) { index++; continue; }
					closed = true;
					break;
				}
				index++;
			}
			if (!closed) throw new Error("TENANT_SQL_RAW_UNTERMINATED_QUOTE");
			tokens.push({ kind: "quoted", value: sql.slice(start, index), start, end: index });
		} else if (/[A-Za-z_$]/.test(char)) {
			while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index++;
			tokens.push({ kind: "word", value: sql.slice(start, index), start, end: index });
		} else if (/[0-9]/.test(char)) {
			while (index < sql.length && /[0-9]/.test(sql[index]!)) index++;
			tokens.push({ kind: "number", value: sql.slice(start, index), start, end: index });
		} else {
			index++;
			tokens.push({ kind: char === "?" ? "parameter" : "symbol", value: char, start, end: index, ...(char === "?" ? { parameter: parameter++ } : {}) });
		}
	}
	if (parameter !== values.length) throw new Error("TENANT_SQL_RAW_PARAMETER_COUNT_MISMATCH");
	const replacements = new Map<number, { token: Token; literal: string }>();
	const replace = (token: Token | undefined): void => {
		if (token?.kind !== "parameter") return;
		const value = values[token.parameter!];
		if (typeof value === "number" ? !Number.isSafeInteger(value) || value < 0 : typeof value !== "bigint" || value < 0n || value > 18446744073709551615n) throw new Error("TENANT_SQL_RAW_PAGINATION_INVALID");
		replacements.set(token.parameter!, { token, literal: String(value) });
	};
	for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
		const token = tokens[tokenIndex]!;
		if (token.kind !== "word") continue;
		const keyword = token.value.toUpperCase();
		if (keyword === "LIMIT") {
			const first = tokens[tokenIndex + 1];
			replace(first);
			if ((first?.kind === "parameter" || first?.kind === "number") && tokens[tokenIndex + 2]?.value === ",") replace(tokens[tokenIndex + 3]);
		} else if (keyword === "OFFSET") replace(tokens[tokenIndex + 1]);
	}
	let rewritten = "", cursor = 0;
	for (const { token, literal } of [...replacements.values()].sort((a, b) => a.token.start - b.token.start)) {
		rewritten += sql.slice(cursor, token.start) + literal;
		cursor = token.end;
	}
	rewritten += sql.slice(cursor);
	return { sql: rewritten, values: values.filter((_value, valueIndex) => !replacements.has(valueIndex)) };
}
