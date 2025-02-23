const PUPPETEER_ARGS = {
	headless: true,
	executablePath: process.env["WPP_BROWSER_PATH"]!,
	args: [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-dev-shm-usage",
		"--disable-accelerated-2d-canvas",
		"--no-first-run",
		"--no-zygote",
		"--disable-gpu"
	]
};

export default PUPPETEER_ARGS;
