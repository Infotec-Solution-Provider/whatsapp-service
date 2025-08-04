"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const sdk_1 = require("@in.pulse-crm/sdk");
const INSTANCES_API_URL = process.env["INSTANCES_API_URL"] || "http://localhost:8000";
exports.default = new sdk_1.InstancesClient(INSTANCES_API_URL);
