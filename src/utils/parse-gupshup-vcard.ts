import { GSContactData } from "../types/gupshup-api.types";

function parseGSVcard(contact: GSContactData) {
	let phoneNumber = contact.phones[0]?.phone || "";

	let parsedDatas: string = `--- Anexo de Contato ---\n${contact.name}\n${phoneNumber}\n--------------------------`;
	return parsedDatas.trim();
}

export default parseGSVcard;
