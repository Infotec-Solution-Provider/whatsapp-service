"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const sdk_1 = require("@in.pulse-crm/sdk");
const CUSTOMERS_API_URL = process.env["CUSTOMERS_API_URL"] || "http://localhost:8002";
exports.default = new sdk_1.CustomersClient(CUSTOMERS_API_URL);
