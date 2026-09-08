import assert from "node:assert/strict";
import type { SendFileOptions } from "../types/whatsapp-instance.types";
import { buildRemoteSendFileOptions } from "./remote-send-file-options";

function input(mimeType: string, sendAsAudio?: boolean, sendAsDocument?: boolean) {
	return {
		file: { id: 42, name: "attachment.ogg", mime_type: mimeType } as SendFileOptions["file"],
		publicFileUrl: "https://files.example.test/attachment",
		...(sendAsAudio !== undefined ? { sendAsAudio } : {}),
		...(sendAsDocument !== undefined ? { sendAsDocument } : {})
	};
}

const voice = input("audio/ogg", true, false);
const voicePayload = buildRemoteSendFileOptions(voice);
assert.equal(voicePayload.fileType, "audio", "a recorded voice note must never become a document");
assert.equal(voicePayload.sendAsAudio, false, "the remote API selects PTT with sendAsAudio=false");
assert.equal(voicePayload.sendAsDocument, false);
assert.equal(voicePayload.file, voice.file);
assert.equal(voicePayload.fileName, voice.file.name);
assert.equal(voicePayload.fileUrl, voice.publicFileUrl);
assert.equal(voice.sendAsAudio, true, "translation must not mutate the persisted system payload");

for (const flag of [false, undefined]) {
	const audio = buildRemoteSendFileOptions(input("audio/mpeg", flag));
	assert.equal(audio.fileType, "audio");
	assert.equal(audio.sendAsAudio, true, "a normal audio attachment must not be converted to a voice note");
}

for (const mimeType of ["audio/ogg", "image/png", "video/mp4"]) {
	const document = buildRemoteSendFileOptions(input(mimeType, true, true));
	assert.equal(document.fileType, "document", "explicit document mode takes precedence over voice/media flags");
	assert.equal(document.sendAsDocument, true);
}

assert.equal(buildRemoteSendFileOptions(input("image/png")).fileType, "image");
assert.equal(buildRemoteSendFileOptions(input("video/mp4")).fileType, "video");
assert.equal(buildRemoteSendFileOptions(input("application/pdf")).fileType, "document");
assert.equal(buildRemoteSendFileOptions(input("application/octet-stream", true)).fileType, "audio");
assert.deepEqual(buildRemoteSendFileOptions(voice), voicePayload, "retries serialize the same attachment intent");

console.log("Remote send file option tests passed");
