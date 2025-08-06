"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("./prisma.service"));
class ParametersService {
    async getUserParams(instance, userId) {
        const userParams = await prisma_service_1.default.parameter.findMany({
            where: {
                scope: "USER",
                instance,
                userId
            }
        });
        return userParams;
    }
    async getSectorParams(sectorId) {
        const sectorParams = await prisma_service_1.default.parameter.findMany({
            where: {
                scope: "SECTOR",
                sectorId
            }
        });
        return sectorParams;
    }
    async getInstanceParams(instance) {
        const instanceParams = await prisma_service_1.default.parameter.findMany({
            where: { instance }
        });
        return instanceParams;
    }
    async getSessionParams({ instance, sectorId, userId }) {
        const [instanceParams, sectorParams, userParams] = await Promise.all([
            this.getInstanceParams(instance),
            this.getSectorParams(sectorId),
            this.getUserParams(instance, userId)
        ]);
        const toParamMap = (params) => Object.fromEntries(params.map((p) => [p.key, p.value]));
        const mergedParams = {
            ...toParamMap(instanceParams),
            ...toParamMap(sectorParams),
            ...toParamMap(userParams)
        };
        return mergedParams;
    }
}
exports.default = new ParametersService();
