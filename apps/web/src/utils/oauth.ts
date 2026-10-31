/**
 * OAuth utility helpers for sanitizing redirects and mapping error codes.
 */

/**
 * Sanitizes an intended redirect path to ensure it is strictly a safe, relative path.
 * Rejects protocol-relative URLs (//evil.com), backslash tricks (/\evil.com), and absolute URLs.
 */
export function sanitizeRelativePath(
  path: string | null | undefined,
  fallback = '/endpoints',
): string {
  if (!path || typeof path !== 'string') {
    return fallback;
  }

  const trimmed = path.trim();
  if (trimmed === '/' || /^\/[^/\\]/.test(trimmed)) {
    // Avoid javascript: or data: pseudo protocols
    if (trimmed.toLowerCase().includes('javascript:') || trimmed.toLowerCase().includes('data:')) {
      return fallback;
    }
    return trimmed;
  }

  return fallback;
}

/**
 * Maps query error codes to user-friendly messages for OAuth flows.
 */
export function getOAuthErrorMessage(errorCode: string | null | undefined): string | null {
  if (!errorCode) return null;

  switch (errorCode) {
    case 'oauth_denied':
      return 'You cancelled the sign-in';

    case 'email_unverified':
      return 'Your provider email is not verified';

    case 'account_exists_use_password':
      return 'An account with this email already exists. Log in with your password, then connect GitHub or Google in Settings';

    case 'state_mismatch':
    case 'cookie_state_mismatch':
    case 'invalid_or_expired_state':
      return 'Authentication session expired or invalid. Please try again.';

    case 'oauth_account_already_linked':
      return 'This provider account is already connected to another user.';

    case 'provider_disabled':
      return 'This login provider is currently not available.';

    case 'missing_callback_parameters':
      return 'Sign-in parameters were incomplete. Please try again.';

    default:
      return 'Authentication failed. Please try again.';
  }
}
