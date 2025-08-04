"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const sdk_1 = require("@in.pulse-crm/sdk");
const SOCKET_API_URL = process.env["SOCKET_API_URL"] || "http://localhost:8004";
exports.default = new sdk_1.SocketServerClient(SOCKET_API_URL);
