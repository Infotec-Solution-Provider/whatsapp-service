class BuildApplicationError extends Error {
	constructor(cause: Error) {
		super("Failed to start application.", { cause });
	}
}

export default BuildApplicationError;
