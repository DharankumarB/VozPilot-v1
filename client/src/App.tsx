import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { PublicOnly, RequireAuth } from './components/ProtectedRoute';
import { AppShell } from './layout/AppShell';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { OverviewPage } from './pages/OverviewPage';
import { CommandCenterPage } from './pages/CommandCenterPage';
import { AgentHubPage } from './pages/AgentHubPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { TaskManagerPage } from './pages/TaskManagerPage';
import { WorkflowManagerPage } from './pages/WorkflowManagerPage';
import { MemoryCenterPage } from './pages/MemoryCenterPage';
import { ActivityCenterPage } from './pages/ActivityCenterPage';
import { ApprovalCenterPage } from './pages/ApprovalCenterPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotFoundPage } from './pages/NotFoundPage';

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/login"
              element={
                <PublicOnly>
                  <LoginPage />
                </PublicOnly>
              }
            />
            <Route
              path="/register"
              element={
                <PublicOnly>
                  <RegisterPage />
                </PublicOnly>
              }
            />

            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route path="/" element={<OverviewPage />} />
              <Route path="/command-center" element={<CommandCenterPage />} />
              <Route path="/agents" element={<AgentHubPage />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/tasks" element={<TaskManagerPage />} />
              <Route path="/workflows" element={<WorkflowManagerPage />} />
              <Route path="/memories" element={<MemoryCenterPage />} />
              <Route path="/activity" element={<ActivityCenterPage />} />
              <Route path="/approvals" element={<ApprovalCenterPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
