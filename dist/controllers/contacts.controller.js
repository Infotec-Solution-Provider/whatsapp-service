"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const is_authenticated_middleware_1 = __importDefault(require("../middlewares/is-authenticated.middleware"));
const contacts_service_1 = __importDefault(require("../services/contacts.service"));
class ContactsController {
    router;
    constructor(router) {
        this.router = router;
        this.router.get("/api/whatsapp/customer/:id/contacts", is_authenticated_middleware_1.default, this.getCustomerContacts);
        this.router.get("/api/whatsapp/contacts", is_authenticated_middleware_1.default, this.getContactsWithCustomer);
        this.router.post("/api/whatsapp/customers/:id/contacts", is_authenticated_middleware_1.default, this.createContact);
        this.router.put("/api/whatsapp/contacts/:contactId", is_authenticated_middleware_1.default, this.updateContact);
        this.router.delete("/api/whatsapp/contacts/:contactId", is_authenticated_middleware_1.default, this.deleteContact);
    }
    async getCustomerContacts(req, res) {
        const data = await contacts_service_1.default.getCustomerContacts(req.session.instance, Number(req.params["id"]));
        res.status(200).send({
            message: "Chats retrieved successfully!",
            data
        });
    }
    async getContactsWithCustomer(req, res) {
        const data = await contacts_service_1.default.getContactsWithCustomer(req.session.instance, req.headers["authorization"]);
        res.status(200).send({
            message: "Contacts retrieved successfully!",
            data
        });
    }
    async createContact(req, res) {
        const customerId = Number(req.params["id"]);
        const { name, phone } = req.body;
        const contact = await contacts_service_1.default.createContact(req.session.instance, name, phone, customerId);
        res.status(200).send({
            message: "Contact created successfully!",
            data: contact
        });
    }
    async updateContact(req, res) {
        const contactId = Number(req.params["contactId"]);
        const { name, phone } = req.body;
        const updatedContact = await contacts_service_1.default.updateContact(contactId, {
            name,
            phone
        });
        res.status(200).send({
            message: "Contact updated successfully!",
            data: updatedContact
        });
    }
    async deleteContact(req, res) {
        const contactId = Number(req.params["contactId"]);
        await contacts_service_1.default.deleteContact(contactId);
        res.status(200).send({
            message: "Contact deleted successfully!"
        });
    }
}
exports.default = new ContactsController((0, express_1.Router)());
