"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const sdk_1 = require("@in.pulse-crm/sdk");
const USERS_API_RL = process.env["USERS_API_RL"] || "http://localhost:8001";
exports.default = new sdk_1.UsersClient(USERS_API_RL);
