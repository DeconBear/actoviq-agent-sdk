import {
  UntrustedWorkflowRejectedError,
  WorkflowConfigurationError,
} from './errors.js';
import { TrustedCompatibilityWorkflowExecutor } from './trustedCompatibilityExecutor.js';
import type {
  WorkflowExecutionRequest,
  WorkflowExecutionResult,
  WorkflowExecutorRouterOptions,
} from './types.js';

/** Selects an executor strictly from the request's explicit trust tier. */
export class WorkflowExecutorRouter {
  private readonly trustedExecutor;
  private readonly sandboxExecutor;

  constructor(options: WorkflowExecutorRouterOptions = {}) {
    this.trustedExecutor = options.trustedExecutor
      ?? new TrustedCompatibilityWorkflowExecutor();
    this.sandboxExecutor = options.sandboxExecutor;
  }

  execute(request: WorkflowExecutionRequest): Promise<WorkflowExecutionResult> {
    if (request.trust === 'trusted') {
      return this.trustedExecutor.execute(request);
    }
    if (request.trust === 'untrusted') {
      if (!this.sandboxExecutor) {
        return Promise.reject(new UntrustedWorkflowRejectedError());
      }
      return this.sandboxExecutor.execute(request);
    }
    return Promise.reject(new WorkflowConfigurationError(
      `Unknown workflow trust tier: ${String((request as { trust?: unknown }).trust)}.`,
    ));
  }
}

export function executeWorkflow(
  request: WorkflowExecutionRequest,
  options: WorkflowExecutorRouterOptions = {},
): Promise<WorkflowExecutionResult> {
  return new WorkflowExecutorRouter(options).execute(request);
}
