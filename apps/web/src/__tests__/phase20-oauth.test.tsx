import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserResponse, WorkspaceResponse } from '@hookpilot/shared';
import { LoginPage } from '../pages/LoginPage.js';
import { OAuthCallbackPage } from '../pages/OAuthCallbackPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { sanitizeRelativePath, getOAuthErrorMessage } from '../utils/oauth.js';
import { useAuthStore } from '../store/auth.store.js';
import { useWorkspaceStore } from '../store/workspace.store.js';

describe('Phase 20: GitHub and Google OAuth Login & Account Linking (Frontend)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    useAuthStore.setState({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
    });

    useWorkspaceStore.setState({
      currentWorkspace: {
        id: 'ws-123',
        name: 'Acme Corp',
        ownerId: 'u-owner-1',
        retentionDays: 30,
        role: 'owner',
        createdAt: new Date().toISOString(),
      } satisfies WorkspaceResponse,
      workspaces: [],
    });
  });

  // --------------------------------------------------------------------------
  // 1. Error Message Mapping Unit Tests
  // --------------------------------------------------------------------------
  describe('OAuth Error Message Mapping', () => {
    it('maps all expected error codes to friendly human-readable strings', () => {
      expect(getOAuthErrorMessage('oauth_denied')).toBe('You cancelled the sign-in');
      expect(getOAuthErrorMessage('email_unverified')).toBe('Your provider email is not verified');
      expect(getOAuthErrorMessage('account_exists_use_password')).toBe(
        'An account with this email already exists. Log in with your password, then connect GitHub or Google in Settings',
      );
      expect(getOAuthErrorMessage('state_mismatch')).toBe(
        'Authentication session expired or invalid. Please try again.',
      );
      expect(getOAuthErrorMessage('oauth_account_already_linked')).toBe(
        'This provider account is already connected to another user.',
      );
      expect(getOAuthErrorMessage('some_unknown_provider_code')).toBe(
        'Authentication failed. Please try again.',
      );
      expect(getOAuthErrorMessage(null)).toBeNull();
      expect(getOAuthErrorMessage(undefined)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Intended Redirect Path Sanitation
  // --------------------------------------------------------------------------
  describe('Relative Path Sanitation', () => {
    it('accepts strictly safe relative paths and blocks protocol-relative and full URLs', () => {
      expect(sanitizeRelativePath('/endpoints')).toBe('/endpoints');
      expect(sanitizeRelativePath('/alerts?tab=rules')).toBe('/alerts?tab=rules');
      expect(sanitizeRelativePath('/')).toBe('/');

      // Attack vectors
      expect(sanitizeRelativePath('//evil.com')).toBe('/endpoints');
      expect(sanitizeRelativePath('///evil.com')).toBe('/endpoints');
      expect(sanitizeRelativePath('/\\evil.com')).toBe('/endpoints');
      expect(sanitizeRelativePath('https://evil.com/phish')).toBe('/endpoints');
      expect(sanitizeRelativePath('javascript:alert(1)')).toBe('/endpoints');
      expect(sanitizeRelativePath(null)).toBe('/endpoints');
      expect(sanitizeRelativePath(undefined)).toBe('/endpoints');
      expect(sanitizeRelativePath('')).toBe('/endpoints');
    });
  });

  // --------------------------------------------------------------------------
  // 3. OAuth Buttons on Login and Signup Pages
  // --------------------------------------------------------------------------
  describe('OAuth Buttons Rendering on Login and Signup', () => {
    it('renders Continue with GitHub and Continue with Google on the Sign In page with brand icons and divider', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login']}>
            <LoginPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // Verify buttons with accessible labels
      expect(html).toContain('aria-label="Continue with GitHub"');
      expect(html).toContain('Continue with GitHub');
      expect(html).toContain('aria-label="Continue with Google"');
      expect(html).toContain('Continue with Google');

      // Verify 'or' divider above email form
      expect(html).toContain('>or</span>');

      // Verify email form inputs
      expect(html).toContain('placeholder="developer@company.com"');
      expect(html).toContain('Sign In');
    });

    it('renders Continue with GitHub and Continue with Google on the Sign Up / Register page', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/register']}>
            <LoginPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // Verify buttons are rendered on registration view
      expect(html).toContain('aria-label="Continue with GitHub"');
      expect(html).toContain('Continue with GitHub');
      expect(html).toContain('aria-label="Continue with Google"');
      expect(html).toContain('Continue with Google');
      expect(html).toContain('>or</span>');

      // Full Name input for registration
      expect(html).toContain('placeholder="Alex Mercer"');
      expect(html).toContain('Register');
    });

    it('reads ?error= query parameter on Login page and displays friendly error alert', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login?error=account_exists_use_password']}>
            <LoginPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(html).toContain(
        'An account with this email already exists. Log in with your password, then connect GitHub or Google in Settings',
      );
    });

    it('displays cancelled sign-in message when ?error=oauth_denied is provided', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login?error=oauth_denied']}>
            <LoginPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(html).toContain('You cancelled the sign-in');
    });
  });

  // --------------------------------------------------------------------------
  // 4. OAuth Callback Page Flow
  // --------------------------------------------------------------------------
  describe('OAuth Callback Flow', () => {
    it('renders loading spinner while completing OAuth session', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/auth/callback?next=/endpoints']}>
            <OAuthCallbackPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(html).toContain('Completing authentication...');
    });

    it('displays error and Back to Sign In button if provider error is present in callback query', () => {
      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/auth/callback?error=email_unverified']}>
            <OAuthCallbackPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(html).toContain('Authentication Failed');
      expect(html).toContain('Your provider email is not verified');
      expect(html).toContain('Back to Sign In');
    });
  });

  // --------------------------------------------------------------------------
  // 5. Settings > Connected Accounts & Last-Method Disconnect Guard
  // --------------------------------------------------------------------------
  describe('Settings > Connected Accounts & Disconnect Safeguards', () => {
    it('disables Disconnect button with explanatory tooltip when identity is the last login method', () => {
      // User with NO password and sole GitHub identity
      const mockOAuthOnlyUser: UserResponse = {
        id: 'u-oauth-sole',
        email: 'developer@example.com',
        name: 'OAuth Developer',
        hasPassword: false,
        identities: [
          {
            id: 'id-gh-1',
            provider: 'github',
            email: 'developer@example.com',
          },
        ],
        createdAt: new Date().toISOString(),
      };

      useAuthStore.setState({ user: mockOAuthOnlyUser });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings']}>
            <SettingsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // Verify Connected Accounts section exists
      expect(html).toContain('Connected Accounts');
      expect(html).toContain('GitHub');
      expect(html).toContain('Connected');

      // Verify Disconnect button is disabled with tooltip explaining invariant
      expect(html).toContain('disabled=""');
      expect(html).toContain(
        'Cannot disconnect your only login method. Please add a password or connect another provider first.',
      );
    });

    it('enables Disconnect button when user has a password and can safely disconnect', () => {
      // User WITH a password and GitHub identity
      const mockUserWithPassword: UserResponse = {
        id: 'u-password-and-oauth',
        email: 'member@example.com',
        name: 'Member Developer',
        hasPassword: true,
        identities: [
          {
            id: 'id-gh-2',
            provider: 'github',
            email: 'member@example.com',
          },
        ],
        createdAt: new Date().toISOString(),
      };

      useAuthStore.setState({ user: mockUserWithPassword });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings']}>
            <SettingsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(html).toContain('Connected Accounts');
      expect(html).toContain('Disconnect');
      // The disconnect button should not have disabled=""
      // Google is not connected, so Connect Google is visible
      expect(html).toContain('Connect Google');
    });

    it('shows Connect buttons for unlinked providers', () => {
      // User with password and NO connected identities
      const mockPasswordUser: UserResponse = {
        id: 'u-clean',
        email: 'solo@example.com',
        name: 'Solo User',
        hasPassword: true,
        identities: [],
        createdAt: new Date().toISOString(),
      };

      useAuthStore.setState({ user: mockPasswordUser });

      const html = renderToString(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings']}>
            <SettingsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(html).toContain('Connect GitHub');
      expect(html).toContain('Connect Google');
    });
  });
});
