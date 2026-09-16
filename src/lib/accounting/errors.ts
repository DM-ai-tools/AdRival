/** Shown in the main app when the signed-in person's allowance cannot cover a task. */
export const LOW_CREDIT_MESSAGE =
  "Your credit balance is too low to run this task. Please contact your administrator.";

/** Thrown when a paid step cannot be funded. Surfaced to the user verbatim. */
export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
  readonly requiredSubunits: number;
  readonly availableSubunits: number;

  constructor(requiredSubunits: number, availableSubunits: number) {
    super(LOW_CREDIT_MESSAGE);
    this.name = "InsufficientCreditsError";
    this.requiredSubunits = requiredSubunits;
    this.availableSubunits = availableSubunits;
  }
}

/**
 * Thrown when the account or project grant that authorized a run stopped being
 * valid while the run was in progress (suspension, deletion, revoked sharing).
 */
export class SpendAuthorizationRevokedError extends Error {
  readonly code = "spend_authorization_revoked";

  constructor(message = "Access was revoked while this task was running.") {
    super(message);
    this.name = "SpendAuthorizationRevokedError";
  }
}

/** Thrown when a provider/model is disabled globally or for this user. */
export class ProviderNotPermittedError extends Error {
  readonly code = "provider_not_permitted";

  constructor(message: string) {
    super(message);
    this.name = "ProviderNotPermittedError";
  }
}

/**
 * Thrown when a billable call has no conservative configured ceiling, so its
 * spend cannot be bounded before the provider is contacted.
 */
export class UnboundedOperationError extends Error {
  readonly code = "unbounded_operation";

  constructor(provider: string) {
    super(
      `No credit ceiling is configured for ${provider}. An administrator must ` +
        `set one in Admin → Settings before this task can run.`,
    );
    this.name = "UnboundedOperationError";
  }
}

/** Thrown when the shared provider account, not the user's allowance, is out of credits. */
export class ProviderCreditsExhaustedError extends Error {
  readonly code = "provider_credits_exhausted";
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = "ProviderCreditsExhaustedError";
    this.provider = provider;
  }
}

export const USER_PROVIDER_CREDIT_MESSAGE =
  "The provider for this task has insufficient credits. Please contact your administrator.";

export function looksLikeProviderCreditFailure(err: unknown): boolean {
  if (err instanceof InsufficientCreditsError) return false;
  if (err instanceof ProviderCreditsExhaustedError) return true;
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.toLowerCase();
  if (message.includes("did not include a numeric balance")) return false;
  if (message.includes("do not have enough credits to run this task")) return false;
  if (message.includes("credit balance is too low")) return false;
  return (
    /\b402\b/.test(message) ||
    /credits exhausted/.test(message) ||
    /insufficient credits/.test(message) ||
    /insufficient_quota/.test(message) ||
    /credit balance is too low/.test(message) ||
    /exceeded your current quota/.test(message) ||
    /out of credits/.test(message) ||
    /payment required/.test(message) ||
    (/billing/.test(message) && /credit|quota|limit/.test(message))
  );
}
export function redactProviderCreditText(
  message: string | null | undefined,
  isAdmin: boolean,
): string | null | undefined {
  if (!message || isAdmin) return message;
  if (!looksLikeProviderCreditFailure(new Error(message))) return message;
  return USER_PROVIDER_CREDIT_MESSAGE;
}

export function isCreditError(err: unknown): boolean {
  return (
    err instanceof InsufficientCreditsError ||
    err instanceof SpendAuthorizationRevokedError ||
    err instanceof ProviderNotPermittedError ||
    err instanceof UnboundedOperationError ||
    err instanceof ProviderCreditsExhaustedError
  );
}
