"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("../../services/prisma.service"));
const message_flow_1 = __importDefault(require("./message-flow"));
const check_available_users_step_1 = __importDefault(require("./steps/check-available-users.step"));
const check_loalty_step_1 = __importDefault(require("./steps/check-loalty.step"));
const check_only_admin_step_1 = __importDefault(require("./steps/check-only-admin.step"));
const send_to_admin_step_1 = __importDefault(require("./steps/send-to-admin.step"));
const stepConstructors = {
    CHECK_ONLY_ADMIN: check_only_admin_step_1.default,
    CHECK_LOALTY: check_loalty_step_1.default,
    CHECK_AVAILABLE_USERS: check_available_users_step_1.default,
    SEND_TO_ADMIN: send_to_admin_step_1.default
};
class MessageFlowFactory {
    static createStep(type, instance, sectorId, stepId, nextStepId) {
        const StepConstructor = stepConstructors[type];
        if (!StepConstructor) {
            throw new Error(`Step type ${type} is not supported.`);
        }
        return new StepConstructor({
            instance,
            sectorId,
            stepId,
            nextStepId: nextStepId ?? -1
        });
    }
    static createDefaultMessageFlow(instance, sectorId) {
        const messageFlow = new message_flow_1.default();
        const steps = [
            { type: "CHECK_ONLY_ADMIN", stepId: 1, nextStepId: 2 },
            { type: "CHECK_LOALTY", stepId: 2, nextStepId: 3 },
            { type: "CHECK_AVAILABLE_USERS", stepId: 3, nextStepId: 4 },
            { type: "SEND_TO_ADMIN", stepId: 4 }
        ];
        for (const stepConfig of steps) {
            const step = this.createStep(stepConfig.type, instance, sectorId, stepConfig.stepId, stepConfig.nextStepId);
            messageFlow.addStep(step);
        }
        return messageFlow;
    }
    static async createMessageFlow(instance, sectorId) {
        const flow = await prisma_service_1.default.wppMessageFlow.findUnique({
            where: {
                instance_sectorId: {
                    instance,
                    sectorId
                }
            },
            include: {
                WppMessageFlowStep: true
            }
        });
        if (!flow) {
            return this.createDefaultMessageFlow(instance, sectorId);
        }
        const messageFlow = new message_flow_1.default();
        let currentStepId = 1;
        for (const step of flow.WppMessageFlowStep) {
            const nextStepId = step.type === "SEND_TO_ADMIN" ? undefined : currentStepId + 1;
            const stepInstance = this.createStep(step.type, instance, sectorId, currentStepId, nextStepId);
            messageFlow.addStep(stepInstance);
            currentStepId++;
        }
        return messageFlow;
    }
}
exports.default = MessageFlowFactory;
