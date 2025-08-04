"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@in.pulse-crm/utils");
require("dotenv/config");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const LOGS_PATH = process.env["LOGS_PATH"] || "./logs";
class ProcessingLogger {
    instance;
    processName;
    processId;
    input;
    constructor(instance, processName, processId, input) {
        this.instance = instance;
        this.processName = processName;
        this.processId = processId;
        this.input = input;
    }
    logEntries = new Array();
    startTime = new Date();
    endTime = null;
    output = null;
    error = null;
    log(entry, output) {
        this.logEntries.push(`${new Date().toISOString()}: ${entry}`);
        if (output) {
            this.output = output;
        }
    }
    success(result) {
        this.output = result;
        this.endTime = new Date();
        this.save();
    }
    failed(err) {
        this.error = err;
        this.endTime = new Date();
        this.save();
    }
    async save() {
        try {
            const logData = {
                startTime: this.startTime.toISOString(),
                endTime: this.endTime.toISOString(),
                duration: this.endTime.getTime() - this.startTime.getTime(),
                logEntries: this.logEntries,
                input: this.input,
                output: this.output,
                error: this.error,
                errorMessage: (0, utils_1.sanitizeErrorMessage)(this.error)
            };
            const logDir = this.error
                ? node_path_1.default.join(LOGS_PATH, this.instance, this.processName, "errors")
                : node_path_1.default.join(LOGS_PATH, this.instance, this.processName);
            const logFileName = `${this.processId}.json`;
            const logFilePath = node_path_1.default.join(logDir, logFileName);
            await (0, promises_1.mkdir)(logDir, { recursive: true });
            await (0, promises_1.writeFile)(logFilePath, JSON.stringify(logData, null, 2), {
                encoding: "utf-8"
            });
        }
        catch (err) {
            utils_1.Logger.error("Failed to save log file", err);
        }
    }
}
exports.default = ProcessingLogger;
