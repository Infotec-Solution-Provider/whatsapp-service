import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeDecode, safeEncode } from "../utils/safe-encode";

const original = "Olá 🏦 proposta 💰 arquivo 💻.pdf";
const encoded = safeEncode(original);

assert.ok(encoded);
assert.equal(
	[...encoded].every((character) => character.codePointAt(0)! <= 0x7f),
	true
);
assert.equal(safeDecode(encoded), original);

const messagesServiceSource = readFileSync(join(__dirname, "messages.service.ts"), "utf8");
const encodedBodyBindings = messagesServiceSource.match(/safeEncode\(message\.body\) \|\| ""/g) || [];
const encodedFileNameBindings = messagesServiceSource.match(/safeEncode\(message\.fileName\)/g) || [];

assert.equal(encodedBodyBindings.length, 4, "every legacy message body binding must be ASCII-safe");
assert.equal(encodedFileNameBindings.length, 4, "every legacy file-name binding must be ASCII-safe");
assert.doesNotMatch(messagesServiceSource, /^\s*message\.body \|\| "",$/m);
assert.doesNotMatch(messagesServiceSource, /^\s*message\.fileName,$/m);

console.log("Legacy local message encoding tests passed");
