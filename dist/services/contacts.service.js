"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_service_1 = __importDefault(require("./prisma.service"));
const whatsapp_service_1 = __importDefault(require("./whatsapp.service"));
const customers_service_1 = __importDefault(require("./customers.service"));
const chats_service_1 = __importDefault(require("./chats.service"));
const users_service_1 = __importDefault(require("./users.service"));
class ContactsService {
    async getOrCreateContact(instance, name, phone) {
        const contact = await prisma_service_1.default.wppContact.findFirst({
            where: {
                instance,
                name,
                phone
            }
        });
        if (contact) {
            return contact;
        }
        return await prisma_service_1.default.wppContact.create({
            data: {
                instance,
                name,
                phone
            }
        });
    }
    async getContactsWithCustomer(instance, token) {
        const chats = await chats_service_1.default.getChats({ isFinished: "false" });
        users_service_1.default;
        users_service_1.default.setAuth(token);
        const users = await users_service_1.default
            .getUsers({ perPage: "999" })
            .then((res) => {
            const users = new Map();
            res.data.forEach((user) => {
                users.set(user.CODIGO, user);
            });
            return users;
        });
        const contacts = await prisma_service_1.default.wppContact.findMany({
            where: {
                instance
            }
        });
        customers_service_1.default.setAuth(token);
        const res = await customers_service_1.default.getCustomers({
            perPage: "999999"
        });
        return contacts.map((contact) => {
            const customer = contact.customerId &&
                res.data.find((c) => c.CODIGO === contact.customerId);
            const chat = chats.find((c) => c.contactId === contact.id);
            const user = chat
                ? users.get(chat.userId || -200)?.NOME || "Supervisão"
                : null;
            return {
                ...contact,
                customer: customer || null,
                chatingWith: user
            };
        });
    }
    async getCustomerContacts(instance, customerId) {
        const contacts = await prisma_service_1.default.wppContact.findMany({
            where: {
                instance,
                customerId
            }
        });
        return contacts;
    }
    async createContact(instance, name, phone, customerId) {
        const validPhone = await whatsapp_service_1.default.getValidWhatsappPhone(instance, phone);
        if (!validPhone) {
            throw new Error("Invalid phone number!");
        }
        const contact = await prisma_service_1.default.wppContact.create({
            data: {
                instance,
                name,
                phone: validPhone,
                customerId
            }
        });
        return contact;
    }
    async updateContact(contactId, data) {
        const contact = await prisma_service_1.default.wppContact.update({
            where: {
                id: contactId
            },
            data
        });
        return contact;
    }
    async deleteContact(contactId) {
        const contact = await prisma_service_1.default.wppContact.delete({
            where: {
                id: contactId
            }
        });
        return contact;
    }
}
exports.default = new ContactsService();
