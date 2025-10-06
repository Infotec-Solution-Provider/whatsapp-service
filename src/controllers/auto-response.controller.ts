import { Request, Response, Router } from "express";
import isAuthenticated from "../middlewares/is-authenticated.middleware";
import autoResponseService from "../services/auto-response.service";
import { BadRequestError } from "@rgranatodutra/http-errors";

class AutoResponseController {
    constructor(public readonly router: Router) {
        const path = "/api/auto-response-rules";

        this.router.get(path, isAuthenticated, this.getRules);

        this.router.get(`${path}/:id`, isAuthenticated, this.getRuleById);

        this.router.post(path, isAuthenticated, this.createRule);

        this.router.put(`${path}/:id`, isAuthenticated, this.updateRule);

        this.router.delete(`${path}/:id`, isAuthenticated, this.deleteRule);
    }

private getRules = async (req: Request, res: Response) => {
    const { instance } = req.session;
    const rules = await autoResponseService.getRules(instance);
    res.status(200).send({
        message: "Regras recuperadas com sucesso!",
        data: rules
    });
}


    private getRuleById = async (req: Request, res: Response) => {
        const ruleId = Number(req.params["id"]);
        const rule = await autoResponseService.getRuleById(ruleId);
        res.status(200).send({
            message: "Regra recuperada com sucesso!",
            data: rule
        });
    }

    private createRule = async (req: Request, res: Response) => {
        const { instance } = req.session;
        const { name, message, isEnabled, schedules } = req.body;

        if (!name || !message || typeof isEnabled !== 'boolean' || !Array.isArray(schedules)) {
            throw new BadRequestError("Campos 'name', 'message', 'isEnabled' e 'schedules' são obrigatórios.");
        }

        const newRule = await autoResponseService.createRule({ instance, ...req.body });
        res.status(201).send({
            message: "Regra criada com sucesso!",
            data: newRule
        });
    }

    private updateRule = async (req: Request, res: Response) => {
        const ruleId = Number(req.params["id"]);
        const updatedRule = await autoResponseService.updateRule(ruleId, req.body);
        res.status(200).send({
            message: "Regra atualizada com sucesso!",
            data: updatedRule
        });
    }

    private deleteRule = async (req: Request, res: Response) => {
        const ruleId = Number(req.params["id"]);
        await autoResponseService.deleteRule(ruleId);
        res.status(200).send({ message: "Regra deletada com sucesso!" });
    }
}

export default new AutoResponseController(Router());
