import { ExpandMore as ExpandMoreIcon, MenuBook as MenuBookIcon } from "@mui/icons-material";
import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from "@mui/material";
import React from "react";

export const StepEditorExamples: React.FC = () => {
	return (
		<Accordion sx={{ bgcolor: "grey.50" }}>
			<AccordionSummary expandIcon={<ExpandMoreIcon />}>
				<Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
					<MenuBookIcon fontSize="small" />
					<Typography sx={{ fontWeight: 600, color: "info.main" }}>
						Exemplos de Configuração por Tipo
					</Typography>
				</Box>
			</AccordionSummary>
			<AccordionDetails sx={{ bgcolor: "background.paper" }}>
				<Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
					{/* QUERY Example */}
					<Box>
						<Typography variant="subtitle2" gutterBottom color="primary">
							QUERY - Executar Query SQL:
						</Typography>
						<Box
							component="pre"
							sx={{
								bgcolor: "grey.100",
								p: 1.5,
								borderRadius: 1,
								overflow: "auto",
								fontSize: "0.85rem"
							}}
						>
							{`{
  "query": "SELECT * FROM users WHERE id = ?",
  "params": ["\${contact.userId}"],
  "storeAs": "user",
  "single": true,
  "required": false
}`}
						</Box>
						<Typography variant="caption" color="text.secondary">
							Executa query e armazena resultado em context.user
						</Typography>
					</Box>

					{/* CONDITION Example */}
					<Box>
						<Typography variant="subtitle2" gutterBottom color="primary">
							CONDITION - Avaliar Condição:
						</Typography>
						<Box
							component="pre"
							sx={{
								bgcolor: "grey.100",
								p: 1.5,
								borderRadius: 1,
								overflow: "auto",
								fontSize: "0.85rem"
							}}
						>
							{`{
  "field": "contact.isOnlyAdmin",
  "operator": "equals",
  "value": true
}`}
						</Box>
						<Typography variant="caption" color="text.secondary">
							Operadores: equals, notEquals, contains, in, gt, gte, lt, lte, exists, regex
							<br />
							<strong>Note:</strong> Use a seção "Conexões Condicionais" acima para definir onTrue e
							onFalse
						</Typography>
					</Box>

					{/* ROUTER Example */}
					<Box>
						<Typography variant="subtitle2" gutterBottom color="primary">
							ROUTER - Roteamento por Valor:
						</Typography>
						<Box
							component="pre"
							sx={{
								bgcolor: "grey.100",
								p: 1.5,
								borderRadius: 1,
								overflow: "auto",
								fontSize: "0.85rem"
							}}
						>
							{`{
  "field": "message.body"
}`}
						</Box>
						<Typography variant="caption" color="text.secondary">
							Mapeia o valor do campo para steps diferentes
							<br />
							<strong>Note:</strong> Use a seção "Conexões Condicionais" acima para definir as rotas
						</Typography>
					</Box>

					{/* ASSIGN Example */}
					<Box>
						<Typography variant="subtitle2" gutterBottom color="primary">
							ASSIGN - Atribuir Chat:
						</Typography>
						<Box
							component="pre"
							sx={{
								bgcolor: "grey.100",
								p: 1.5,
								borderRadius: 1,
								overflow: "auto",
								fontSize: "0.85rem"
							}}
						>
							{`{
  "userId": 123,
  "walletId": null,
  "priority": "NORMAL",
  "systemMessage": "Chat atribuído a \${user.name}",
  "type": "RECEPTIVE"
}`}
						</Box>
						<Typography variant="caption" color="text.secondary">
							Atribui chat a usuário/carteira. userId -1 = admin. Suporta interpolação
						</Typography>
					</Box>

					{/* Specific Steps Example */}
					<Box>
						<Typography variant="subtitle2" gutterBottom color="primary">
							Steps Específicos (sem config):
						</Typography>
						<Box
							component="pre"
							sx={{
								bgcolor: "grey.100",
								p: 1.5,
								borderRadius: 1,
								overflow: "auto",
								fontSize: "0.85rem"
							}}
						>
							{`// SEND_TO_ADMIN
{}

// CHECK_ONLY_ADMIN
{}

// CHECK_LOYALTY
{}

// CHECK_AVAILABLE_USERS
{}`}
						</Box>
						<Typography variant="caption" color="text.secondary">
							Steps específicos geralmente não precisam de configuração
						</Typography>
					</Box>
				</Box>
			</AccordionDetails>
		</Accordion>
	);
};
