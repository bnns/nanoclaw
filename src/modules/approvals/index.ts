/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string.
 *
 * OneCLI credential approvals are removed in this deployment (credentials
 * come from exe.dev edge proxies; OneCLI was never configured).
 */
import { registerResponseHandler } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent } from './primitive.js';
export type { ApprovalHandler, ApprovalHandlerContext, RequestApprovalOptions } from './primitive.js';

registerResponseHandler(handleApprovalsResponse);
