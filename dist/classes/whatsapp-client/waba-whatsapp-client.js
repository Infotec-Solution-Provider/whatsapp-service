"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class WABAWhatsappClient {
    instance;
    name;
    phone;
    constructor(instance, name, phone) {
        this.instance = instance;
        this.name = name;
        this.phone = phone;
    }
    async getProfilePictureUrl(_) {
        throw new Error("Method not implemented.");
    }
    async isValidWhatsapp(_) {
        throw new Error("Method not implemented.");
    }
    async sendMessage({}) {
        throw new Error("Method not implemented.");
    }
}
exports.default = WABAWhatsappClient;
