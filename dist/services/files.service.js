"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const sdk_1 = require("@in.pulse-crm/sdk");
require("dotenv/config");
const FILES_API_URL = process.env["FILES_API_URL"] || "http://localhost:8003";
exports.default = new sdk_1.FilesClient(FILES_API_URL);
