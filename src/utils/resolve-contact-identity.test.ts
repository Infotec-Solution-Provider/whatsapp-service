import assert from "node:assert/strict";
import resolveContactIdentity from "./resolve-contact-identity";

const lid = resolveContactIdentity("24709550891217");
assert.deepEqual(lid, {
	name: "24709550891217",
	phone: null,
	whatsappId: "24709550891217"
});

const phone = resolveContactIdentity("me:555184449218");
assert.deepEqual(phone, {
	name: "+55 (51) 8444-9218",
	phone: "555184449218",
	whatsappId: "555184449218"
});

const namedLid = resolveContactIdentity("24709550891217@lid", "Contato LID");
assert.deepEqual(namedLid, {
	name: "Contato LID",
	phone: null,
	whatsappId: "24709550891217@lid"
});

const phoneLengthLid = resolveContactIdentity("551199999999@lid");
assert.deepEqual(phoneLengthLid, {
	name: "551199999999@lid",
	phone: null,
	whatsappId: "551199999999@lid"
});

console.log("Contact identity resolver tests passed");
