import assert from "node:assert/strict";
import {
	buildNativeMigrationMetadata, buildNativeOwnershipPredicate, quoteMigrationIdentifier,
	rewriteNativeCreateTable, NativeMigrationError
} from "./migration";

const tables = buildNativeMigrationMetadata();
assert(!tables.some(table => /process_logs|frontend_performance|instance_migration/.test(table.source)));
assert(tables.some(table => table.source === "operator_outbound_send"));
assert(tables.some(table => table.source === "remote_inbound_event_inbox"));
for (const table of tables) {
	const ownership = buildNativeOwnershipPredicate(table, tables);
	assert(ownership.sql.includes("instance"), `No tenant ownership for ${table.source}`);
	assert.equal((ownership.sql.match(/\?/g) || []).length, ownership.parameters.length);
	assert(ownership.parameters.length > 0);
	assert.equal(table.destination, `wpp_runtime_${table.source}`);
	assert(table.keys.length > 0);
}
for (const name of ["_sector_clients", "_WppChatToWppTag", "contacts_sectors"]) {
	const association = tables.find(table => table.source === name)!;
	assert.equal(buildNativeOwnershipPredicate(association, tables).parameters.length, 2, `${name} must require both tenant owners`);
}
const parameters = buildNativeOwnershipPredicate(tables.find(table => table.source === "parameters")!, tables);
assert(parameters.sql.includes("IS NULL AND s.`scope` = 'SECTOR'"));
assert(parameters.sql.includes("p.`id` = s.`sectorId`"));
assert(!parameters.sql.includes("GLOBAL"));
const messages = tables.find(table => table.source === "messages")!;
const sourceDdl = "CREATE TABLE `messages` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `contact_id` int DEFAULT NULL,\n  PRIMARY KEY (`id`),\n  CONSTRAINT `messages_contact_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`),\n  CONSTRAINT `messages_orphan_fk` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4";
const rewritten = rewriteNativeCreateTable(sourceDdl, messages, tables, new Set(["messages_orphan_fk"]));
assert(rewritten.startsWith("CREATE TABLE `wpp_runtime_messages`"));
assert(rewritten.includes("REFERENCES `wpp_runtime_contacts`"));
assert.equal((rewritten.match(/FOREIGN KEY/g) || []).length, 1);
assert(!rewritten.includes("AUTO_INCREMENT="));
assert(!rewritten.includes(",\n)"));
assert(!rewritten.includes("messages_contact_fk"));
assert.equal(quoteMigrationIdentifier("homolog-crm-suprimaxxi"), "`homolog-crm-suprimaxxi`");
assert.throws(() => quoteMigrationIdentifier("homolog-crm`;DROP DATABASE x"), NativeMigrationError);
console.log("Native migration metadata, tenant isolation, and safe DDL tests passed");
