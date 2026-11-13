import assert from "node:assert/strict";
import { OdimLiveCopyWriter } from "./odim-live-copy.core";

async function main() {
	for (const preserveCurrentOperations of [false, true]) {
		let updated: Record<string, unknown> | undefined;
		const original = { id: 77, status: "READ", file_id: 88, file_name: "Current file", file_type: "audio/ogg",
			waba_id: "wamid.current", wwebjs_id: null, quoted_id: null, body: "Current body", chat_id: 8, contact_id: 9, user_id: null, client_id: 13 };
		const db = {
			execute: async (sql: string) => {
				if (sql.startsWith("SELECT target_id")) return [[{ target_id: 77 }]];
				if (sql.startsWith("SELECT id FROM messages")) return [[{ id: 77 }]];
				if (sql.startsWith("SELECT * FROM messages")) return [[original]];
				if (sql.startsWith("INSERT IGNORE INTO odim_operational_copy_source_versions")) return [{ affectedRows: 1 }];
				throw Error(`Unexpected fixture SQL: ${sql}`);
			},
			query: async (sql: string, values: unknown[]) => {
				assert(sql.startsWith("UPDATE messages SET "));
				const columns = [...sql.matchAll(/`([^`]+)`=\?/g)].map(match => match[1]!);
				updated = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
				return [{ affectedRows: 1 }];
			}
		};
		const writer = new OdimLiveCopyWriter(db, { operationalClientId: 13, preserveCurrentOperations });
		await writer.message({ CODIGO: 1, TIMESTAMP: "1794487020", ID: "wamid.source", TIPO: "audio", FROM_ME: 0,
			STATUS: "RECEIVED", MENSAGEM: "Source body", CODIGO_OPERADOR: null }, { IDENTIFICADOR: "5511987654321" }, 9, 8,
			{ CODIGO: 4, NOME_ORIGINAL: "Source file", TIPO: "audio/mpeg" }, null);
		assert(updated);
		assert.equal(updated["status"], "READ");
		assert.equal(updated["file_name"], "Current file"); assert.equal(updated["file_type"], "audio/ogg");
		if (preserveCurrentOperations) assert.equal(updated["body"], "Current body");
	}
	console.log("odim-copy-preservation: PASS deployed READ, current files and live operation preservation");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
