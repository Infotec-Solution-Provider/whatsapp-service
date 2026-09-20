import { createHash } from "node:crypto";
import { legacyContract } from "./legacy-contract";

export const prepareVersion = "karsten-core-v1";
export const journalTable = "wpp_tenant_prepare";
export const quote = (name: string) => `\`${name}\``;

// Existing rows stay unknown (NULL) until a verified copy populates these fields.
// Epoch milliseconds are UTC instants; never reinterpret legacy DATETIME values.
export const additions: Record<string, Record<string, string>> = {
	wpp_contacts: {
		whatsapp_id: "varchar(191)", is_blocked: "tinyint(1)", is_only_admin: "tinyint(1)",
		avatar_url: "longtext", created_at_epoch_ms: "bigint(20)", updated_at_epoch_ms: "bigint(20)",
		last_out_of_hours_reply_sent_at_epoch_ms: "bigint(20)", conversation_expiration: "varchar(191)",
	},
	wpp_chats: {
		wallet_id: "int(11)", agent_id: "int(11)", schedule_id: "int(11)", priority: "varchar(50)",
		avatar_url_encoded: "longtext", started_at_epoch_ms: "bigint(20)", finished_at_epoch_ms: "bigint(20)",
	},
	wpp_messages: {
		mention_metadata: "longtext", status_timestamp: "varchar(191)", agent_id: "int(11)", sent_at_epoch_ms: "bigint(20)",
	},
	wpp_schedules: { scheduled_at_epoch_ms: "bigint(20)", schedule_date_epoch_ms: "bigint(20)" },
};

export function columnDefinition(name: string, type: string): string {
	const text = /char|text/.test(type) ? " CHARACTER SET utf8 COLLATE utf8_general_ci" : "";
	return `${quote(name)} ${type}${text} NULL`;
}

// No integer/provider ID, legacy date or legacy message body is modified.
export const modifications = {
	name: "`name` LONGTEXT CHARACTER SET utf8 COLLATE utf8_general_ci NOT NULL",
	phone: "`phone` VARCHAR(50) CHARACTER SET utf8 COLLATE utf8_general_ci NULL",
};

export const journalColumns = {
	step_id: "varchar(64)", tenant: "varchar(191)", target_fingerprint: "char(64)",
	manifest_hash: "char(64)", state: "varchar(16)", updated_at: "datetime",
};
export const journalDdl = `CREATE TABLE ${quote(journalTable)} (
	step_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
	tenant VARCHAR(191) CHARACTER SET utf8 COLLATE utf8_bin NOT NULL,
	target_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	manifest_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci`;

export const manifestHash = createHash("sha256").update(JSON.stringify({
	prepareVersion, legacyContract, additions, modifications, journalDdl,
})).digest("hex");

export const storageContract = {
	version: prepareVersion,
	tables: { contacts: "wpp_contacts", contacts_sectors: "wpp_contact_sectors", chats: "wpp_chats", messages: "wpp_messages", schedules: "wpp_schedules" },
	ids: "Preserve central IDs. Verify chats.id = chats.original_id before copying; never renumber existing rows in prepare.",
	percentEncoded: ["wpp_contacts.name", "wpp_contacts.avatar_url", "wpp_chats.avatar_url_encoded", "wpp_messages.body", "wpp_messages.file_name", "wpp_messages.mention_metadata", "wpp_schedules.description"],
	dates: "New *_epoch_ms fields hold UTC epoch milliseconds; NULL means not reconciled. Existing DATETIME fields remain untouched.",
	json: "mention_metadata is JSON.stringify followed by encodeURIComponent; SQL NULL remains NULL.",
	chatAvatar: "Existing avatar_url may have mixed encoding; future verified copy uses avatar_url_encoded from the central value.",
	missingValues: "New columns remain NULL until copy; do not treat NULL flags/priority as false/NORMAL.",
	remaining: ["source/destination ID and content reconciliation", "runtime identity uniqueness and query indexes", "domain repositories and all consumers", "queues and durable outbound controls", "copy/verify and routing"],
};
