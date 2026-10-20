import { Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import protectedRead from "../middlewares/protected-read";
import { ReadRequestGate } from "../utils/read-request-gate";
import { searchContactAudience } from "../services/contact-audience/service";

// A sequential cursor export must not exhaust the UI's short request window.
// Every search still shares pending work and holds one of two per-session slots
// until completion, including after a disconnected caller abandons its waiter.
const audienceGate = new ReadRequestGate({
	maxRequests: Number.MAX_SAFE_INTEGER, windowMs: 10_000, maxConcurrent: 2, maxWaiters: 4, maxUsers: 5000
});
const router = Router();
router.post("/api/whatsapp/contacts/customer/search", isAuthenticated, protectedRead("contacts.audience", async req =>
	searchContactAudience(req.session, req.headers.authorization ?? "", req.body), audienceGate));

export default { router };
