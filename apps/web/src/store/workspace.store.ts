import { create } from 'zustand';
import type { WorkspaceResponse } from '@hookpilot/shared';

interface WorkspaceState {
  currentWorkspace: WorkspaceResponse | null;
  workspaces: WorkspaceResponse[];
  setCurrentWorkspace: (workspace: WorkspaceResponse | null) => void;
  setWorkspaces: (workspaces: WorkspaceResponse[]) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  currentWorkspace: null,
  workspaces: [],
  setCurrentWorkspace: (currentWorkspace) => set({ currentWorkspace }),
  setWorkspaces: (workspaces) =>
    set((state) => {
      // If current workspace is null or not in list, auto-select first workspace
      const currentExists = workspaces.some((w) => w.id === state.currentWorkspace?.id);
      return {
        workspaces,
        currentWorkspace: currentExists ? state.currentWorkspace : (workspaces[0] ?? null),
      };
    }),
}));
