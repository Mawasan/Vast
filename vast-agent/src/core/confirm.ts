import { config } from "./config.js";

/**
 * Approval seam for irreversible actions (instance destroy, template delete).
 * Callers must pass `confirm: true` explicitly; otherwise the action is not
 * performed and a preview describing what *would* happen is returned instead.
 * This keeps the decision to actually destroy/delete something in the hands
 * of whichever client (human-in-the-loop or an explicit flag) is calling us.
 */
export interface ConfirmationRequired {
  status: "confirmation_required";
  action: string;
  message: string;
  preview: Record<string, unknown>;
}

export function needsConfirmation(confirm: boolean | undefined): boolean {
  return config.requireConfirmation && confirm !== true;
}

export function confirmationRequired(
  action: string,
  preview: Record<string, unknown>
): ConfirmationRequired {
  return {
    status: "confirmation_required",
    action,
    message: `This action is irreversible. Re-call this tool with confirm: true to proceed with: ${action}.`,
    preview,
  };
}
