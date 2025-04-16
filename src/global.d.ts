import { SessionData } from "@in.pulse-crm/sdk";

declare global {
	namespace Express {
		interface Request {
			session: SessionData;
		}
	}
}
