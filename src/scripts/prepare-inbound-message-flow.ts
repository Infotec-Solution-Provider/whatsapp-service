import { readFileSync } from "node:fs";
import { buildOdimInboundFlow, assertInboundFlowPreflight, FlowDeploymentPreflight, InboundFlowTargets } from "../message-flow/configurations/odim-inbound";

// Preparation only: no Prisma import, network, SQL execution or environment loading.
const targetsPath = process.argv[2];
if (!targetsPath) throw new Error("Usage: ts-node src/scripts/prepare-inbound-message-flow.ts <targets.json> [preflight.json]");
const config = buildOdimInboundFlow(JSON.parse(readFileSync(targetsPath, "utf8")) as InboundFlowTargets);
const preflightPath = process.argv[3];
if (preflightPath) assertInboundFlowPreflight(config, JSON.parse(readFileSync(preflightPath, "utf8")) as FlowDeploymentPreflight);
process.stdout.write(JSON.stringify({ mode: "prepare-only", preflightValidated: Boolean(preflightPath), configuration: config }, null, 2) + "\n");
