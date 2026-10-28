import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth.store.js';
import { authApi } from './api/auth.api.js';
import { AppLayout } from './components/layout/AppLayout.js';
import { LoginPage } from './pages/LoginPage.js';
import { EndpointsPage } from './pages/EndpointsPage.js';
import { EventInspectorPage } from './pages/EventInspectorPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { LoadingSpinner } from './components/common/LoadingSpinner.js';

function ProtectedRoute({ children }: { children: JSX.Element }) {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return <LoadingSpinner fullScreen message="Restoring session..." />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

export function App() {
  const { setAuth, clearAuth, setLoading } = useAuthStore();

  // Check existing session via refresh / auth/me on initial app load
  useEffect(() => {
    let isMounted = true;

    async function checkSession() {
      try {
        const refreshRes = await authApi.refresh();
        if (refreshRes.accessToken) {
          useAuthStore.getState().setAccessToken(refreshRes.accessToken);
          const meRes = await authApi.getMe();
          if (isMounted) {
            setAuth(meRes.user, refreshRes.accessToken);
          }
        } else {
          if (isMounted) clearAuth();
        }
      } catch {
        if (isMounted) clearAuth();
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    checkSession();

    return () => {
      isMounted = false;
    };
  }, [setAuth, clearAuth, setLoading]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<LoginPage />} />

        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Navigate to="/endpoints" replace />} />
          <Route path="/endpoints" element={<EndpointsPage />} />
          <Route path="/events" element={<EventInspectorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/endpoints" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
