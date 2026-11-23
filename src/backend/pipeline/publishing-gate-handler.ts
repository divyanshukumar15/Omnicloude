/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PipelineStageName } from '../database/types.ts';
import type {
  IPipelineStageHandler,
  PipelineContext,
  PublishingGateStageOutput,
  StageExecutionResult,
} from './contracts.ts';
import { PublishingGate } from '../publishing-gate/publishing-gate.ts';
import type { PublishingEvaluationTarget } from '../publishing-gate/types.ts';

export interface PublishingGateInput {
  recruitmentId?: string;
  target?: PublishingEvaluationTarget;
}

export class PublishingGateStageHandler
  implements IPipelineStageHandler<PublishingGateInput, PublishingGateStageOutput>
{
  readonly stageName: PipelineStageName = 'PUBLISHING_GATE';

  async execute(
    input: PublishingGateInput,
    context: PipelineContext
  ): Promise<StageExecutionResult<PublishingGateStageOutput>> {
    const recruitmentId =
      input?.recruitmentId ||
      input?.target?.recruitmentId ||
      (typeof context.metadata.recruitmentId === 'string'
        ? context.metadata.recruitmentId
        : undefined);

    if (!input?.target && !recruitmentId) {
      return {
        success: false,
        errorCode: 'INVALID_INPUT',
        errorMessage: 'recruitmentId or target evaluation payload is required for PUBLISHING_GATE stage',
      };
    }

    try {
      const target = input?.target || recruitmentId!;
      const result = await PublishingGate.evaluate(target);
      const output: PublishingGateStageOutput = {
        ...result,
        publishingGateResult: result,
        recruitmentId,
      };

      const persistMetadata = {
        recruitmentId,
        publishingGateDecision: result.allowed ? 'ALLOWED' : 'BLOCKED',
        publishingGateState: result.state,
      };

      if (result.allowed) {
        return {
          success: true,
          output,
          persistMetadata,
          auditDetails: {
            decision: 'ALLOWED',
            state: result.state,
            validation_version: result.validation_version,
          },
        };
      }

      return {
        success: false,
        errorCode: 'PUBLISHING_GATE_BLOCKED',
        errorMessage: `Publishing Gate blocked recruitment: ${result.critical_failures.join(', ')}`,
        output,
        persistMetadata,
        auditDetails: {
          decision: 'BLOCKED',
          state: result.state,
          critical_failures: result.critical_failures,
          reasons: result.reasons,
        },
      };
    } catch (err) {
      return {
        success: false,
        errorCode: 'GATE_EVALUATION_ERROR',
        errorMessage: (err as Error).message,
      };
    }
  }
}
