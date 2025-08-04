"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const sdk_1 = require("@in.pulse-crm/sdk");
const AUTH_API_URL = process.env["AUTH_API_URL"] || "http://localhost:8001";
exports.default = new sdk_1.AuthClient(AUTH_API_URL);
