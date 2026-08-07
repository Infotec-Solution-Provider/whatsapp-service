import { SessionData } from "./sdk-local";

declare global {
	namespace Express {
		interface Request {
			session: SessionData;
		}
	}
}
