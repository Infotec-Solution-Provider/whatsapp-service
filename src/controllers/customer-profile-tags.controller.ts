import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import onlyLocal from "../middlewares/only-local.middleware";
import customerProfileTagsService from "../services/customer-profile-tags.service";
import {
	CustomerAgeLevel,
	CustomerInteractionLevel,
	CustomerProfileManualOverrides,
	CustomerPurchaseInterestLevel,
	CustomerProfileSummaryFilters,
	CustomerProfileSummaryLevel,
	CustomerPurchaseLevel,
	UpdateCustomerProfileManualOverridesInput,
} from "../types/customer-profile-tag.types";

class CustomerProfileTagsController {
	constructor(public readonly router: Router) {
		this.router.post(
			"/api/whatsapp/customers/profile-tags/summary/batch",
			isAuthenticated,
			this.getCustomerProfileSummaries
		);

		this.router.get(
			"/api/whatsapp/customers/profile-tags/customer-ids",
			isAuthenticated,
			this.findCustomerIdsByProfileFilters
		);

		this.router.post(
			"/api/internal/whatsapp/customers/profile-tags/customer-ids",
			onlyLocal,
			this.findInternalCustomerIdsByProfileFilters
		);

		this.router.get(
			"/api/whatsapp/customers/:customerId/profile-tags/manual-overrides",
			isAuthenticated,
			this.getCustomerProfileManualOverrides
		);

		this.router.put(
			"/api/whatsapp/customers/:customerId/profile-tags/manual-overrides",
			isAuthenticated,
			this.updateCustomerProfileManualOverrides
		);

		this.router.get(
			"/api/whatsapp/customers/:customerId/profile-tags/interaction",
			isAuthenticated,
			this.getInteractionTag
		);

		this.router.post(
			"/api/whatsapp/customers/:customerId/profile-tags/interaction/rebuild",
			isAuthenticated,
			this.rebuildInteractionTag
		);

		this.router.post(
			"/api/whatsapp/customers/profile-tags/interaction/rebuild",
			isAuthenticated,
			this.rebuildInteractionTagsForInstance
		);

		this.router.get(
			"/api/whatsapp/customers/:customerId/profile-tags/purchase",
			isAuthenticated,
			this.getPurchaseTag
		);

		this.router.post(
			"/api/whatsapp/customers/:customerId/profile-tags/purchase/rebuild",
			isAuthenticated,
			this.rebuildPurchaseTag
		);

		this.router.post(
			"/api/whatsapp/customers/profile-tags/purchase/rebuild",
			isAuthenticated,
			this.rebuildPurchaseTagsForInstance
		);

		this.router.get(
			"/api/whatsapp/customers/:customerId/profile-tags/age",
			isAuthenticated,
			this.getCustomerAgeTag
		);

		this.router.get(
			"/api/whatsapp/customers/:customerId/profile-tags/summary",
			isAuthenticated,
			this.getCustomerProfileSummary
		);

		this.router.post(
			"/api/whatsapp/customers/:customerId/profile-tags/age/rebuild",
			isAuthenticated,
			this.rebuildCustomerAgeTag
		);

		this.router.post(
			"/api/whatsapp/customers/profile-tags/age/rebuild",
			isAuthenticated,
			this.rebuildCustomerAgeTagsForInstance
		);
	}

	private parseCustomerId = (req: Request): number => {
		const customerId = Number(req.params["customerId"]);
		if (!Number.isInteger(customerId) || customerId <= 0) {
			throw new BadRequestError("Customer ID must be a positive integer!");
		}

		return customerId;
	};

	private parseCustomerIds = (req: Request): number[] => {
		const customerIds = Array.isArray(req.body?.customerIds)
			? req.body.customerIds
			: [];

		if (!customerIds.length) {
			return [];
		}

		const parsedCustomerIds = customerIds
			.map((customerId) => Number(customerId))
			.filter((customerId) => Number.isInteger(customerId) && customerId > 0);

		return Array.from(new Set(parsedCustomerIds));
	};

	private parseSummaryFilters = (source: Record<string, unknown>): CustomerProfileSummaryFilters => {
		const filters: CustomerProfileSummaryFilters = {};
		const parseNumberList = (value: unknown) => {
			if (typeof value !== "string") {
				if (!Array.isArray(value)) {
					return undefined;
				}

				const parsedArray = value
					.map((item) => Number(item))
					.filter((item) => Number.isInteger(item) && item > 0);

				return parsedArray.length ? Array.from(new Set(parsedArray)) : undefined;
			}

			const parsed = value
				.split(",")
				.map((item) => Number(item.trim()))
				.filter((item) => Number.isInteger(item) && item > 0);

			return parsed.length ? Array.from(new Set(parsed)) : undefined;
		};

		if (typeof source["profileLevel"] === "string") {
			filters.profileLevel = source["profileLevel"] as CustomerProfileSummaryLevel;
		}

		if (typeof source["interactionLevel"] === "string") {
			filters.interactionLevel = source["interactionLevel"] as CustomerInteractionLevel;
		}

		if (typeof source["purchaseLevel"] === "string") {
			filters.purchaseLevel = source["purchaseLevel"] as CustomerPurchaseLevel;
		}

		if (typeof source["ageLevel"] === "string") {
			filters.ageLevel = source["ageLevel"] as CustomerAgeLevel;
		}

		if (typeof source["purchaseInterestLevel"] === "string") {
			filters.purchaseInterestLevel = source["purchaseInterestLevel"] as CustomerPurchaseInterestLevel;
		}

		if (typeof source["state"] === "string") {
			filters.state = source["state"].trim().toUpperCase();
		}

		if (typeof source["city"] === "string") {
			filters.city = source["city"];
		}

		if (typeof source["activeCustomer"] === "string") {
			filters.activeCustomer = source["activeCustomer"] as "SIM" | "NAO";
		}

		if (typeof source["searchTerm"] === "string") {
			filters.searchTerm = source["searchTerm"];
		}

		filters.segmentIds = parseNumberList(source["segmentIds"]);
		filters.campaignIds = parseNumberList(source["campaignIds"]);
		filters.operatorIds = parseNumberList(source["operatorIds"]);

		return filters;
	};

	private parseSummaryFiltersFromRequest = (req: Request): CustomerProfileSummaryFilters => {
		return this.parseSummaryFilters(req.query as Record<string, unknown>);
	};

	private parseSummaryFiltersFromBody = (req: Request): CustomerProfileSummaryFilters => {
		return this.parseSummaryFilters((req.body ?? {}) as Record<string, unknown>);
	};

	private parseInternalInstance = (req: Request): string => {
		const instance = typeof req.body?.instance === "string" ? req.body.instance.trim() : "";

		if (!instance) {
			throw new BadRequestError("instance is required!");
		}

		return instance;
	};

	private parseManualOverridesInput = (req: Request): UpdateCustomerProfileManualOverridesInput => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const input: UpdateCustomerProfileManualOverridesInput = {};

		if ("profileLevel" in body) {
			if (body.profileLevel !== null && typeof body.profileLevel !== "string") {
				throw new BadRequestError("profileLevel must be a string or null!");
			}

			input.profileLevel = (body.profileLevel as CustomerProfileSummaryLevel | null) ?? null;
		}

		if ("purchaseInterestLevel" in body) {
			if (body.purchaseInterestLevel !== null && typeof body.purchaseInterestLevel !== "string") {
				throw new BadRequestError("purchaseInterestLevel must be a string or null!");
			}

			input.purchaseInterestLevel = (body.purchaseInterestLevel as CustomerPurchaseInterestLevel | null) ?? null;
		}

		return input;
	};

	private getCustomerProfileSummaries = async (req: Request, res: Response) => {
		const customerIds = this.parseCustomerIds(req);

		if (!customerIds.length) {
			res.status(200).send({
				message: "Customer profile summaries retrieved successfully!",
				data: [],
			});
			return;
		}

		const data = await customerProfileTagsService.getCustomerProfileSummaries(req.session.instance, customerIds);

		res.status(200).send({
			message: "Customer profile summaries retrieved successfully!",
			data,
		});
	};

	private findCustomerIdsByProfileFilters = async (req: Request, res: Response) => {
		const filters = this.parseSummaryFiltersFromRequest(req);
		const data = await customerProfileTagsService.findCustomerIdsByProfileFilters(req.session.instance, filters);

		res.status(200).send({
			message: "Customer ids retrieved successfully!",
			data,
		});
	};

	private findInternalCustomerIdsByProfileFilters = async (req: Request, res: Response) => {
		const instance = this.parseInternalInstance(req);
		const filters = this.parseSummaryFiltersFromBody(req);
		const data = await customerProfileTagsService.findCustomerIdsByProfileFilters(instance, filters);

		res.status(200).send({
			message: "Customer ids retrieved successfully!",
			data,
		});
	};

	private getCustomerProfileManualOverrides = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.getCustomerProfileManualOverrides(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer profile manual overrides retrieved successfully!",
			data,
		});
	};

	private updateCustomerProfileManualOverrides = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const input = this.parseManualOverridesInput(req);
		const data = await customerProfileTagsService.updateCustomerProfileManualOverrides(
			req.session.instance,
			customerId,
			input,
			{
				userId: req.session.userId,
				name: req.session.name,
			}
		);

		res.status(200).send({
			message: "Customer profile manual overrides updated successfully!",
			data,
		});
	};

	private getInteractionTag = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.getOrCreateInteractionTag(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer interaction tag retrieved successfully!",
			data,
		});
	};

	private rebuildInteractionTag = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.rebuildInteractionTag(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer interaction tag rebuilt successfully!",
			data,
		});
	};

	private rebuildInteractionTagsForInstance = async (req: Request, res: Response) => {
		const data = await customerProfileTagsService.rebuildInteractionTagsForInstance(req.session.instance);

		res.status(200).send({
			message: "Customer interaction tags rebuilt successfully!",
			data,
		});
	};

	private getPurchaseTag = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.getOrCreatePurchaseTag(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer purchase tag retrieved successfully!",
			data,
		});
	};

	private rebuildPurchaseTag = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.rebuildPurchaseTag(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer purchase tag rebuilt successfully!",
			data,
		});
	};

	private rebuildPurchaseTagsForInstance = async (req: Request, res: Response) => {
		const data = await customerProfileTagsService.rebuildPurchaseTagsForInstance(req.session.instance);

		res.status(200).send({
			message: "Customer purchase tags rebuilt successfully!",
			data,
		});
	};

	private getCustomerAgeTag = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.getOrCreateCustomerAgeTag(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer age tag retrieved successfully!",
			data,
		});
	};

	private getCustomerProfileSummary = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.getCustomerProfileSummary(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer profile summary retrieved successfully!",
			data,
		});
	};

	private rebuildCustomerAgeTag = async (req: Request, res: Response) => {
		const customerId = this.parseCustomerId(req);
		const data = await customerProfileTagsService.rebuildCustomerAgeTag(req.session.instance, customerId);

		res.status(200).send({
			message: "Customer age tag rebuilt successfully!",
			data,
		});
	};

	private rebuildCustomerAgeTagsForInstance = async (req: Request, res: Response) => {
		const data = await customerProfileTagsService.rebuildCustomerAgeTagsForInstance(req.session.instance);

		res.status(200).send({
			message: "Customer age tags rebuilt successfully!",
			data,
		});
	};
}

export default new CustomerProfileTagsController(Router());