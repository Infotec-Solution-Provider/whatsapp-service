import { BadRequestError } from "@rgranatodutra/http-errors";
import { Request, Response, Router } from "express";
import { ChatPayload } from "../message-flow/base/base.step";
import messagesDistributionService from "../services/messages-distribution.service";
import prismaService from "../services/prisma.service";
import ProcessingLogger from "../utils/processing-logger";

interface FlowExecutionRequest {
  instance: string;
  sectorId: number;
  contactId: number;
}

interface FlowExecutionResponse {
  success: boolean;
  data?: ChatPayload;
  error?: string;
}

class FlowExecutionController {
  public readonly router: Router;

  constructor() {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    // Executar flow para um contato
    this.router.post("/api/flow-execution/execute", this.executeFlow.bind(this));
  }

  private async executeFlow(req: Request, res: Response): Promise<Response> {
    const logger = new ProcessingLogger("", "flow-execution", `flow-exec-${Date.now()}`, req.body);

    try {
      const { instance, sectorId, contactId } = req.body as FlowExecutionRequest;

      // Validação básica
      if (!instance || !sectorId || !contactId) {
        throw new BadRequestError(
          "Campos obrigatórios faltando: instance, sectorId e contact.phone são necessários"
        );
      }

      logger.log(`Processando flow para contato: ${contactId} na instância ${instance}`);


      const wppContact = await prismaService.wppContact.findUniqueOrThrow({
        where: { id: contactId }
      });

      const flow = await messagesDistributionService.getFlow(instance, sectorId);
      logger.log(`Flow obtido para setor ${sectorId}`);

      const chatPayload = await flow.getChatPayload(logger, wppContact);
      logger.log(`Flow executado com sucesso`, chatPayload);

      const response: FlowExecutionResponse = {
        success: true,
        data: chatPayload
      };

      logger.success(response);
      return res.status(200).json(response);
    } catch (err) {
      logger.failed(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (err instanceof BadRequestError) {
        return res.status(400).json({
          success: false,
          error: errorMessage
        });
      }

      return res.status(500).json({
        success: false,
        error: "Erro ao processar flow: " + errorMessage
      });
    }
  }
}

export default new FlowExecutionController();
