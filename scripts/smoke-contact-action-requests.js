const { spawnSync } = require("child_process");
const mysql = require("mysql2/promise");
require("dotenv").config();

const databaseName = `contact_action_smoke_${Date.now()}`;

if (!/^[a-z0-9_]+$/.test(databaseName)) {
	throw new Error("Invalid disposable database name");
}

function databaseUrlFor(databaseUrl, database) {
	const url = new URL(databaseUrl);
	url.pathname = `/${database}`;
	return url.toString();
}

async function main() {
	const sourceUrl = process.env.WHATSAPP_DATABASE_URL;
	if (!sourceUrl) {
		throw new Error("WHATSAPP_DATABASE_URL is required");
	}

	const source = new URL(sourceUrl);
	const connectionOptions = {
		host: source.hostname,
		port: Number(source.port || 3306),
		user: decodeURIComponent(source.username),
		password: decodeURIComponent(source.password)
	};
	const admin = await mysql.createConnection(connectionOptions);
	let db;

	try {
		await admin.query(`CREATE DATABASE \`${databaseName}\``);

		const prismaCli = require.resolve("prisma/build/index.js");
		const migration = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				WHATSAPP_DATABASE_URL: databaseUrlFor(sourceUrl, databaseName)
			},
			encoding: "utf8"
		});
		if (migration.status !== 0) {
			throw new Error(`Migration failed:\n${migration.error?.message || migration.stderr || migration.stdout}`);
		}

		db = await mysql.createConnection({
			...connectionOptions,
			database: databaseName
		});
		const instance = "contact-action-smoke";
		const [contactResult] = await db.execute(
			"INSERT INTO contacts (name, phone, instance, is_deleted, created_at) VALUES (?, ?, ?, false, NOW(3))",
			["Contato atual", "5511999999999", instance]
		);
		const contactId = contactResult.insertId;
		const pendingDeleteKey = `${instance}:${contactId}:DELETE`;

		await db.execute(
			`INSERT INTO contact_action_requests
       (instance, contact_id, action, requested_by, payload, contact_snapshot, status, pending_key, created_at, updated_at)
       VALUES (?, ?, 'DELETE', 10, NULL, ?, 'PENDING', ?, NOW(3), NOW(3))`,
			[instance, contactId, JSON.stringify({ name: "Contato atual" }), pendingDeleteKey]
		);

		let duplicateBlocked = false;
		try {
			await db.execute(
				`INSERT INTO contact_action_requests
         (instance, contact_id, action, requested_by, contact_snapshot, status, pending_key, created_at, updated_at)
         VALUES (?, ?, 'DELETE', 11, '{}', 'PENDING', ?, NOW(3), NOW(3))`,
				[instance, contactId, pendingDeleteKey]
			);
		} catch (error) {
			duplicateBlocked = error.code === "ER_DUP_ENTRY";
		}
		if (!duplicateBlocked) throw new Error("pendingKey did not prevent duplicates");

		await db.beginTransaction();
		await db.execute("UPDATE contacts SET is_deleted = true WHERE id = ?", [contactId]);
		await db.execute(
			`UPDATE contact_action_requests
       SET status = 'APPROVED', pending_key = NULL, reviewed_by = 1, reviewed_at = NOW(3), updated_at = NOW(3)
       WHERE pending_key = ?`,
			[pendingDeleteKey]
		);
		await db.commit();

		const rejectedKey = `${instance}:${contactId}:REACTIVATE`;
		await db.execute(
			`INSERT INTO contact_action_requests
       (instance, contact_id, action, requested_by, payload, contact_snapshot, status, pending_key, created_at, updated_at)
       VALUES (?, ?, 'REACTIVATE', 10, ?, '{}', 'PENDING', ?, NOW(3), NOW(3))`,
			[instance, contactId, JSON.stringify({ name: "Proposta rejeitada" }), rejectedKey]
		);
		await db.execute(
			`UPDATE contact_action_requests
       SET status = 'REJECTED', pending_key = NULL, reviewed_by = 1, reviewed_at = NOW(3), updated_at = NOW(3)
       WHERE pending_key = ?`,
			[rejectedKey]
		);
		const [[afterRejection]] = await db.execute("SELECT is_deleted AS isDeleted FROM contacts WHERE id = ?", [
			contactId
		]);
		if (!afterRejection.isDeleted) throw new Error("rejection changed the contact");

		const approvedKey = `${instance}:${contactId}:REACTIVATE`;
		const [sectorResult] = await db.execute(
			"INSERT INTO sectors (name, instance, start_chats, receive_chats) VALUES (?, ?, true, true)",
			[`Smoke ${Date.now()}`, instance]
		);
		await db.execute(
			`INSERT INTO contact_action_requests
       (instance, contact_id, action, requested_by, payload, contact_snapshot, status, pending_key, created_at, updated_at)
       VALUES (?, ?, 'REACTIVATE', 10, ?, '{}', 'PENDING', ?, NOW(3), NOW(3))`,
			[
				instance,
				contactId,
				JSON.stringify({ name: "Contato reativado", sectorIds: [sectorResult.insertId] }),
				approvedKey
			]
		);

		await db.beginTransaction();
		await db.execute("UPDATE contacts SET name = ?, is_deleted = false WHERE id = ?", [
			"Contato reativado",
			contactId
		]);
		await db.execute("INSERT INTO contacts_sectors (contactId, sectorId) VALUES (?, ?)", [
			contactId,
			sectorResult.insertId
		]);
		await db.execute(
			`UPDATE contact_action_requests
       SET status = 'APPROVED', pending_key = NULL, reviewed_by = 1, reviewed_at = NOW(3), updated_at = NOW(3)
       WHERE pending_key = ?`,
			[approvedKey]
		);
		await db.commit();

		try {
			await db.beginTransaction();
			await db.execute("UPDATE contacts SET name = 'rollback-failed' WHERE id = ?", [contactId]);
			await db.execute("INSERT INTO contacts_sectors (contactId, sectorId) VALUES (?, ?)", [
				contactId,
				sectorResult.insertId
			]);
			await db.commit();
			throw new Error("rollback trigger unexpectedly succeeded");
		} catch (error) {
			await db.rollback();
			if (error.code !== "ER_DUP_ENTRY") throw error;
		}

		const [[contact]] = await db.execute(
			`SELECT name, is_deleted AS isDeleted,
        (SELECT COUNT(*) FROM contacts_sectors WHERE contactId = contacts.id) AS sectorCount
       FROM contacts WHERE id = ?`,
			[contactId]
		);
		const [[requestCounts]] = await db.execute(
			`SELECT
        SUM(status = 'APPROVED') AS approved,
        SUM(status = 'REJECTED') AS rejected,
        SUM(status = 'PENDING') AS pending
       FROM contact_action_requests WHERE contact_id = ?`,
			[contactId]
		);
		if (
			contact.name !== "Contato reativado" ||
			contact.isDeleted ||
			Number(contact.sectorCount) !== 1 ||
			Number(requestCounts.approved) !== 2 ||
			Number(requestCounts.rejected) !== 1 ||
			Number(requestCounts.pending) !== 0
		) {
			throw new Error("unexpected final state");
		}

		console.log("CONTACT_ACTION_MYSQL_SMOKE_OK");
	} finally {
		if (db) await db.end();
		await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
		await admin.end();
	}
}

main().catch((error) => {
	console.error(error.stack || error.message);
	process.exitCode = 1;
});
