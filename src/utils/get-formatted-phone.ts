function getFormattedPhone(phone: string) {
	let formattedPhone: string = "";

	if (!phone) return "";

	if (phone.length === 13) {
		formattedPhone = `+${phone.slice(0, 2)} (${phone.slice(2, 4)}) ${phone.slice(4, 5)} ${phone.slice(5, 9)}-${phone.slice(9, 13)}`;
	} else if (phone.length === 12) {
		formattedPhone = `+${phone.slice(0, 2)} (${phone.slice(2, 4)}) ${phone.slice(4, 8)}-${phone.slice(8, 12)}`;
	} else if (phone.length === 11) {
		formattedPhone = `(${phone.slice(0, 2)}) ${phone.slice(2, 5)}-${phone.slice(5, 8)}-${phone.slice(8, 11)}`;
	} else if (phone.length === 10) {
		formattedPhone = `(${phone.slice(0, 2)}) ${phone.slice(2, 6)}-${phone.slice(6, 10)}`;
	} else {
		formattedPhone = phone;
	}

	return formattedPhone;
}

export default getFormattedPhone;
