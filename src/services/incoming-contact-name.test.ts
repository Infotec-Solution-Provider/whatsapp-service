import assert from "node:assert/strict";
import type { WppContact } from "@prisma/client";
import { incomingContactName, placeholderContactName, wabaContactName } from "../utils/incoming-contact-name";

async function main() {
	const phone = "5511987654321";
	assert.equal(wabaContactName([{ wa_id: phone, profile: { name: " Perfil " } }], phone), "Perfil");
	assert.equal(wabaContactName([{ wa_id: "5511666666666", profile: { name: "Outro" } }], phone), null);
	assert.equal(wabaContactName([{ wa_id: phone, profile: { name: "Um" } }, { wa_id: phone, profile: { name: "Dois" } }], phone), null);
	assert.equal(wabaContactName(null, phone), null);
	assert.equal(incomingContactName(" \u0000 "), null);
	assert.equal(Array.from(incomingContactName("😀".repeat(300))!).length, 191);
	assert.equal(placeholderContactName({ name: "Nome manual 2026", phone, whatsappId: phone }, "Perfil"), null);
	assert.equal(placeholderContactName({ name: "+55 (11) 98765-4321", phone, whatsappId: phone }, "Perfil"), "Perfil");
	assert.equal(placeholderContactName({ name: "", phone, whatsappId: phone }, "+55 (11) 98765-4321"), null);

	const saved = new Map<string, NodeModule | undefined>();
	const replace = (path: string, value: unknown) => {
		const id = require.resolve(path); saved.set(id, require.cache[id]);
		require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: value } } as NodeModule;
	};
	let row = { id: 42, instance: "odim", name: "+55 (11) 98765-4321", phone, whatsappId: phone, isDeleted: false, customerId: 81 } as WppContact;
	let race = false, writes = 0, synced = 0;
	try {
		replace("./parameters.service", {});
		replace("./instances.service", { executeQuery: async () => { synced++; return []; } });
		replace("./prisma.service", { wppContact: {
			findFirst: async ({ where }: any) => { assert.equal(where.instance, "odim"); return structuredClone(row); },
			updateMany: async ({ where, data }: any) => {
				assert.deepEqual(where, { id: 42, instance: "odim", isDeleted: false, name: "+55 (11) 98765-4321", phone, whatsappId: phone });
				assert.deepEqual(data, { name: "Perfil verificado" });
				if (race) { row.name = "Edição humana concorrente"; return { count: 0 }; }
				row = { ...row, ...data }; writes++; return { count: 1 };
			}
		} });
		const id = require.resolve("./contacts.service"); saved.set(id, require.cache[id]); delete require.cache[id];
		const service = (require("./contacts.service") as typeof import("./contacts.service")).default;
		const updated = await service.getOrCreateContact("odim", "Perfil verificado", phone, phone);
		assert.equal(updated.name, "Perfil verificado"); assert.equal(updated.customerId, 81);
		assert.equal(writes, 1); assert.equal(synced, 1);
		await service.getOrCreateContact("odim", "Outro perfil", phone, phone);
		assert.equal(row.name, "Perfil verificado"); assert.equal(writes, 1);
		row.name = "+55 (11) 98765-4321"; race = true;
		const manual = await service.getOrCreateContact("odim", "Perfil verificado", phone, phone);
		assert.equal(manual.name, "Edição humana concorrente"); assert.equal(synced, 1); assert.equal(writes, 1);
		console.log("incoming-contact-name: PASS peer profile, placeholders, Unicode, manual names and concurrent edit preservation");
	} finally { for (const [id, value] of saved) { if (value) require.cache[id] = value; else delete require.cache[id]; } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
