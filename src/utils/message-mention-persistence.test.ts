import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { mentionEntitiesFromJids, messageMentionPatch, operatorMentionEntities } from "./message-mention-persistence";

const body = "Olá @123456789012345, pode verificar?";
const entities = mentionEntitiesFromJids(["123456789012345@lid"]);
assert.equal(entities[0]?.type, "lid");
assert.equal(entities[0]?.phone, null, "LID digits are not a phone number");
assert.deepEqual(mentionEntitiesFromJids(undefined), undefined, "absent legacy metadata remains unknown");
assert.deepEqual(mentionEntitiesFromJids([]), [], "explicit absence of protocol mentions remains confirmed");
assert.deepEqual(mentionEntitiesFromJids(["123456789012345@g.us"]), [], "a group is not a person mention");
assert.equal(mentionEntitiesFromJids(["5511999999999:4@c.us"])[0]?.id, "5511999999999@s.whatsapp.net");

const input = { body, mentionEntities: entities };
const patch = messageMentionPatch(input);
assert.equal(input.body, body, "never rewrite persisted body to a name");
assert.deepEqual(patch.mentionMetadata, entities);
assert.deepEqual(messageMentionPatch({}, { body }), {}, "status-only updates preserve metadata");
assert.deepEqual(messageMentionPatch({ body }, { body }), {}, "unchanged body preserves metadata on old-client replay");
assert.equal(messageMentionPatch({ body: "editado" }, { body }).mentionMetadata, Prisma.DbNull,
	"old-client edit invalidates stale identities without claiming confirmed absence");
assert.deepEqual(messageMentionPatch({ body: "editado", mentionEntities: [] }, { body }).mentionMetadata, []);
assert.deepEqual(messageMentionPatch({ mentionMetadata: entities }).mentionMetadata, entities, "forwarding preserves identities");

const selected = operatorMentionEntities([{ userId: 7, name: "Ana", phone: "+55 (11) 99999-9999" }]);
assert.deepEqual(selected.map((entity) => entity.id), ["user:7", "5511999999999@s.whatsapp.net"]);
assert.deepEqual(selected[0]?.tokens, ["@~7"], "internal codes cannot become plain numeric mentions");
assert.deepEqual(operatorMentionEntities([null, { userId: -1 }, { userId: "7" }]), []);
assert.equal(operatorMentionEntities([{ userId: 7, name: "Ana", phone: "123456789012345@lid" }]).length, 1);
assert.deepEqual(operatorMentionEntities([{ userId: 0, name: "Contato", phone: "5511999999999" }]).map((entity) => entity.id),
	["5511999999999@s.whatsapp.net"], "external contacts do not need an internal user ID");
const maximumSelection = operatorMentionEntities(Array.from({ length: 100 }, (_, index) => ({
	userId: index + 1, name: `Pessoa ${index + 1}`, phone: String(5511900000000 + index),
})));
assert.equal(maximumSelection.length, 200, "all 100 accepted selections retain both token namespaces");
assert.ok(maximumSelection.some((entity) => entity.id === "user:100"));
console.log("Message mention persistence tests passed (native IDs, raw body, create/update/forward, operator namespaces)");
