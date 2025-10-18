import React from "react";
import type { FlowStep } from "../types/flow.types";
import {
  Box,
  Card,
  CardContent,
  CardActions,
  Chip,
  Typography,
  Stack,
  Divider
} from "@mui/material";
import {
  PlayArrow as PlayArrowIcon,
  Pause as PauseIcon,
  ArrowForward as ArrowForwardIcon,
  TrendingFlat as TrendingFlatIcon,
  SubdirectoryArrowLeft as SubdirectoryArrowLeftIcon
} from "@mui/icons-material";

interface VisualFlowBuilderProps {
  steps: FlowStep[];
  onStepSelect: (step: FlowStep) => void;
  selectedStepId?: number;
}

export const VisualFlowBuilder: React.FC<VisualFlowBuilderProps> = ({
  steps,
  onStepSelect,
  selectedStepId,
}) => {
  const getStepConnections = (step: FlowStep) => {
    const connections = [];
    
    if (step.nextStepId) {
      const nextStep = steps.find(s => s.id === step.nextStepId);
      if (nextStep) {
        connections.push({ type: "next", step: nextStep });
      }
    }
    
    if (step.fallbackStepId) {
      const fallbackStep = steps.find(s => s.id === step.fallbackStepId);
      if (fallbackStep) {
        connections.push({ type: "fallback", step: fallbackStep });
      }
    }
    
    return connections;
  };

  const renderStep = (step: FlowStep, depth: number = 0) => {
    const connections = getStepConnections(step);
    const indent = depth * 2;

    return (
      <Card
        key={step.id}
        elevation={selectedStepId === step.id ? 6 : 1}
        sx={{
          mb: 2,
          ml: `${indent}rem`,
          cursor: 'pointer',
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          border: selectedStepId === step.id ? '3px solid' : '2px solid transparent',
          borderColor: selectedStepId === step.id ? 'primary.main' : 'transparent',
          opacity: step.enabled ? 1 : 0.6,
          '&:hover': {
            transform: 'translateX(4px)',
            elevation: 4,
          }
        }}
        onClick={() => onStepSelect(step)}
      >
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Chip
              label={`#${step.stepNumber}`}
              size="small"
              color="primary"
              variant="filled"
            />
            <Chip
              label={step.stepType}
              size="small"
              color="secondary"
              variant="outlined"
            />
            {!step.enabled && (
              <Chip
                icon={<PauseIcon />}
                label="Desabilitado"
                size="small"
                color="warning"
                variant="filled"
              />
            )}
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {step.description || <em>Sem descrição</em>}
          </Typography>

          {step.config['text'] && (
            <Box
              sx={{
                bgcolor: 'grey.100',
                p: 1,
                borderRadius: 1,
                fontSize: '0.875rem',
              }}
            >
              💬 {step.config['text']}
            </Box>
          )}
        </CardContent>

        <Divider />

        <CardActions sx={{ justifyContent: 'space-between', px: 2, py: 1 }}>
          <Typography variant="caption" color="text.secondary">
            ID: {step.id}
          </Typography>
          <Stack direction="row" spacing={1}>
            {step.nextStepId && (
              <Chip
                icon={<ArrowForwardIcon />}
                label={`→ #${steps.find(s => s.id === step.nextStepId)?.stepNumber}`}
                size="small"
                variant="outlined"
                color="success"
              />
            )}
            {step.fallbackStepId && (
              <Chip
                icon={<SubdirectoryArrowLeftIcon />}
                label={`⤴ #${steps.find(s => s.id === step.fallbackStepId)?.stepNumber}`}
                size="small"
                variant="outlined"
                color="error"
              />
            )}
          </Stack>
        </CardActions>
      </Card>
    );
  };

  // Build a simple tree structure
  const sortedSteps = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);

  return (
    <Box>
      <Stack spacing={2}>
        {sortedSteps.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
            <Typography variant="body1">Nenhum step para visualizar</Typography>
          </Box>
        ) : (
          sortedSteps.map((step) => renderStep(step, 0))
        )}
      </Stack>

      <Divider sx={{ my: 3 }} />

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Legenda:
        </Typography>
        <Stack spacing={1}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ArrowForwardIcon fontSize="small" color="success" />
            <Typography variant="caption">Próximo Step (next_step_id)</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <SubdirectoryArrowLeftIcon fontSize="small" color="error" />
            <Typography variant="caption">Fallback Step (fallback_step_id)</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PauseIcon fontSize="small" color="warning" />
            <Typography variant="caption">Step Desabilitado</Typography>
          </Box>
        </Stack>
      </Box>
    </Box>
  );
};
