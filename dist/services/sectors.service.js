"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("./prisma.service"));
class SectorsService {
    async getSectors(instance) {
        const sectors = await prisma_service_1.default.wppSector.findMany({
            where: {
                instance
            }
        });
        return sectors;
    }
}
exports.default = new SectorsService();
