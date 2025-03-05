function getDownloadUrl(fileName: string, instance: string) {
	const baseUrl = `${process.env["API_URL"] || "http://localhost:8000"}/api/${instance}`;

	return `${baseUrl}/custom-routes/file/${fileName}`;
}

export default getDownloadUrl;
