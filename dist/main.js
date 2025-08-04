"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
require("express-async-errors");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_errors_1 = require("@rgranatodutra/http-errors");
const utils_1 = require("@in.pulse-crm/utils");
const whatsapp_service_1 = __importDefault(require("./services/whatsapp.service"));
const chats_controller_1 = __importDefault(require("./controllers/chats.controller"));
const messages_controller_1 = __importDefault(require("./controllers/messages.controller"));
const wallets_controller_1 = __importDefault(require("./controllers/wallets.controller"));
const results_controller_1 = __importDefault(require("./controllers/results.controller"));
const contacts_controller_1 = __importDefault(require("./controllers/contacts.controller"));
const sectors_controller_1 = __importDefault(require("./controllers/sectors.controller"));
const schedules_controller_1 = __importDefault(require("./controllers/schedules.controller"));
const internal_chats_controller_1 = __importDefault(require("./controllers/internal-chats.controller"));
whatsapp_service_1.default.buildClients();
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use((0, cors_1.default)());
app.use(chats_controller_1.default.router);
app.use(messages_controller_1.default.router);
app.use(wallets_controller_1.default.router);
app.use(results_controller_1.default.router);
app.use(contacts_controller_1.default.router);
app.use(sectors_controller_1.default.router);
app.use(schedules_controller_1.default.router);
app.use(internal_chats_controller_1.default.router);
app.use((err, _req, _res, next) => {
    console.error(err);
    next(err);
});
app.use(http_errors_1.handleRequestError);
(0, utils_1.logRoutes)("", [
    chats_controller_1.default.router,
    messages_controller_1.default.router,
    wallets_controller_1.default.router,
    results_controller_1.default.router,
    contacts_controller_1.default.router,
    sectors_controller_1.default.router,
    schedules_controller_1.default.router,
    internal_chats_controller_1.default.router
]);
const serverPort = Number(process.env["LISTEN_PORT"]) || 8005;
app.listen(serverPort, () => {
    utils_1.Logger.info("Server listening on port " + serverPort);
});
