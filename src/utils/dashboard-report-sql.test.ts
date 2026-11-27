import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildMessagesPerContactQuery, CONTACTS_WAITING_RESPONSE_SQL } from "./dashboard-report-sql";

import { DatabaseSync } from "node:sqlite";

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.function("regexp", (pattern, value) => {
		if (typeof pattern !== "string" || typeof value !== "string") return null;
		const translated = pattern.replaceAll("[[:space:][:punct:]]", "[\\s\\p{P}]").replaceAll("[[:space:]]", "\\s");
		return Number(new RegExp(translated, "u").test(value));
	});
	db.exec(`
		CREATE TABLE contacts (id INTEGER PRIMARY KEY, instance TEXT, name TEXT, customer_id INTEGER);
		CREATE TABLE chats (
			id INTEGER PRIMARY KEY, instance TEXT, contact_id INTEGER, user_id INTEGER, sector_id INTEGER,
			is_finished INTEGER, started_at TEXT, finished_at TEXT
		);
		CREATE TABLE messages (
			id INTEGER PRIMARY KEY, instance TEXT, contact_id INTEGER, chat_id INTEGER, user_id INTEGER,
			"from" TEXT, "to" TEXT, body TEXT, sent_at TEXT
		);
	`);
	return db;
}

test("mensagens por contato contam cada mensagem uma vez e usam apenas o atendimento vinculado", () => {
	const db = fixture();
	try {
		db.exec(`
			INSERT INTO contacts VALUES (1, 'tenant-a', 'Maria', 10), (2, 'tenant-a', 'Outro', NULL),
				(3, 'tenant-b', 'Outro tenant', NULL);
			INSERT INTO chats VALUES
				(1, 'tenant-a', 1, 7, NULL, 1, '2026-10-02T10:00:00.000Z', '2026-10-02T11:00:00.000Z'),
				(2, 'tenant-a', 1, 8, NULL, 1, '2026-10-03T10:00:00.000Z', '2026-10-03T11:00:00.000Z'),
				(3, 'tenant-b', 1, 7, NULL, 0, NULL, NULL);
			INSERT INTO messages VALUES
				(1, 'tenant-a', 1, 1, 8, 'me:8', '551', 'Resposta', '2026-10-02T10:01:00.000Z'),
				(2, 'tenant-a', 1, 1, NULL, '551', '5510', 'Pergunta', '2026-10-02T10:02:00.000Z'),
				(3, 'tenant-a', 1, NULL, NULL, '551', '5510', 'Sem atendimento', '2026-10-02T10:03:00.000Z'),
				(4, 'tenant-a', 1, 3, NULL, '551', '5510', 'Atendimento externo', '2026-10-02T10:04:00.000Z'),
				(5, 'tenant-a', 1, 1, NULL, 'system:1', '551', 'Sistema', '2026-10-02T10:05:00.000Z'),
				(6, 'tenant-a', 1, 1, 7, 'me:7', '551', 'Fora das datas', '2026-09-30T10:00:00.000Z'),
				(7, 'tenant-b', 1, 1, 7, 'me:7', '551', 'Instância externa', '2026-10-02T10:06:00.000Z'),
				(8, 'tenant-a', 2, 1, NULL, '552', '5510', 'Outro contato', '2026-10-02T10:06:00.000Z');
		`);
		const from = new Date("2026-10-01T00:00:00.000Z");
		const to = new Date("2026-10-31T23:59:59.999Z");
		const report = (userId: number | null) => {
			const { query, values } = buildMessagesPerContactQuery("tenant-a", from, to, userId);
			const rows: Array<Record<string, unknown>> = db.prepare(query)
				.all(...values.map((value) => value instanceof Date ? value.toISOString() : value));
			return rows.map((row) => [
				row["contactId"], row["messagesCount"], row["sentMessagesCount"], row["receivedMessagesCount"], row["attendancesCount"]
			]);
		};
		deepEqual(report(null), [[1, 4, 1, 3, 2], [2, 1, 0, 1, 0]]);
		deepEqual(report(7), [[1, 1, 0, 1, 1]]);
		deepEqual(report(8), [[1, 1, 1, 0, 1]]);
	} finally {
		db.close();
	}
});

test("aguardando retorno considera a mensagem mais recente do cliente por atendimento aberto", () => {
	const db = fixture();
	try {
		db.exec(`
			INSERT INTO contacts VALUES (1, 'tenant-a', 'Maria', 10), (2, 'tenant-b', 'Outro tenant', NULL);
			INSERT INTO chats VALUES
				(1, 'tenant-a', 1, 7, NULL, 0, '2026-10-02 10:00:00', NULL),
				(2, 'tenant-a', 1, 8, NULL, 0, '2026-10-02 11:00:00', NULL),
				(3, 'tenant-a', 1, 8, NULL, 1, '2026-10-02 11:30:00', '2026-10-02 11:40:00'),
				(4, 'tenant-a', 1, 8, NULL, 0, '2026-10-02 11:45:00', NULL),
				(5, 'tenant-b', 2, 9, NULL, 0, '2026-10-02 10:00:00', NULL),
				(6, 'tenant-a', 1, 8, NULL, 0, '2026-10-02 10:05:00', NULL);
			INSERT INTO messages VALUES
				(10, 'tenant-a', 1, 1, NULL, '551', '5510', 'Pergunta', '2026-10-02 10:01:00'),
				(11, 'tenant-a', 1, 1, 7, 'me:7', '551', 'Resposta', '2026-10-02 10:02:00'),
				(12, 'tenant-a', 1, 1, NULL, '551', '5510', 'Voltou a falar', '2026-10-02 10:03:00'),
				(13, 'tenant-a', 1, 1, NULL, 'bot:7', '551', 'Bot após pergunta', '2026-10-02 10:04:00'),
				(14, 'tenant-a', 1, 2, NULL, '551', '5510', 'Pergunta', '2026-10-02 11:01:00'),
				(15, 'tenant-a', 1, 2, 8, 'me:8', '551', 'Resposta', '2026-10-02 11:02:00'),
				(16, 'tenant-a', 1, 3, NULL, '551', '5510', 'Fechado', '2026-10-02 11:31:00'),
				(17, 'tenant-a', 1, 4, NULL, '551', '5510', 'Obrigado!', '2026-10-02 11:46:00'),
				(18, 'tenant-b', 2, 5, NULL, '552', '5510', 'Outro tenant', '2026-10-02 10:01:00'),
				(19, 'tenant-b', 1, 1, 7, 'me:7', '551', 'Atividade de outro tenant', '2026-10-02 10:10:00'),
				(20, 'tenant-a', 1, 6, NULL, '551', '5510', 'Pergunta', '2026-10-02 10:06:00');
		`);
		const query = CONTACTS_WAITING_RESPONSE_SQL.replace(
			"DATE_SUB(customer.sent_at, INTERVAL 1 HOUR)", "datetime(customer.sent_at, '-1 hour')"
		);
		const rows: Array<Record<string, unknown>> = db.prepare(query).all("tenant-a");
		deepEqual(rows.map((row) => [row["CODIGO_ATENDIMENTO"], row["contactId"], row["DATA_MENSAGEM_CLIENTE"]]), [
			[1, 1, "2026-10-02 10:03:00"], [6, 1, "2026-10-02 10:06:00"]
		]);
	} finally {
		db.close();
	}
});
