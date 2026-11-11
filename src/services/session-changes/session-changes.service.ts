import { SessionChangeRepository } from "./session-change.repository";
import { SessionChangeReader } from "./session-change-reader";

export default new SessionChangeReader(new SessionChangeRepository());
