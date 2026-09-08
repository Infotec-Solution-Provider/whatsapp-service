import assert from "node:assert/strict";
import { hashOperatorSendRequest, normalizeOperatorSendRequest, resolveOperatorIdempotencyKey } from "./operator-send-request";

const request = normalizeOperatorSendRequest(3, "5511999999999", { contactId: 5, chatId: 2, text: "Olá", sendAsAudio: false });
const retry = normalizeOperatorSendRequest("3", "5511999999999", { contactId: "5", chatId: "2", text: "Olá", sendAsAudio: "false", traceId: "different-trace" });
assert.equal(hashOperatorSendRequest(request), hashOperatorSendRequest(retry), "JSON and multipart retry must identify the same intent");
for (const changed of [{ text: "Outro" }, { quotedId: 10 }, { contactId: 9 }, { fileId: 8 }, { sendAsDocument: true }, { chatId: 3 }]) {
	assert.notEqual(hashOperatorSendRequest(request), hashOperatorSendRequest(normalizeOperatorSendRequest(3, request.to, { contactId: 5, chatId: 2, text: "Olá", ...changed })));
}
assert.notEqual(hashOperatorSendRequest(request), hashOperatorSendRequest({ ...request, clientId: 4 }));
assert.equal(resolveOperatorIdempotencyKey("intent-123", "intent-123"), "intent-123");
assert.equal(resolveOperatorIdempotencyKey(undefined, undefined), null, "unkeyed clients retain compatibility");
assert.throws(() => resolveOperatorIdempotencyKey("intent-123", "intent-456"));
assert.throws(() => resolveOperatorIdempotencyKey("", undefined));
assert.throws(() => normalizeOperatorSendRequest(3, request.to, { contactId: 5, text: "" }));
assert.throws(() => normalizeOperatorSendRequest(3, request.to, { contactId: true, text: "Olá" }));
assert.throws(() => normalizeOperatorSendRequest(3, request.to, { contactId: 5, text: "Olá", sendAsAudio: "garbage" }));
assert.throws(() => normalizeOperatorSendRequest(3, request.to, { contactId: 5, text: "Olá", mentions: "bad json" }));
const file = { buffer: Buffer.from("content"), size: 7, originalname: "test.txt", mimetype: "text/plain" } as Express.Multer.File;
assert.notEqual(
	hashOperatorSendRequest(normalizeOperatorSendRequest(3, request.to, { contactId: 5 }, file)),
	hashOperatorSendRequest(normalizeOperatorSendRequest(3, request.to, { contactId: 5 }, { ...file, buffer: Buffer.from("changed") })),
);
console.log("operator-send-request: normalization, payload conflicts and attachment identity passed");
