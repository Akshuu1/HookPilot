import { io, type Socket } from 'socket.io-client';
import type { EventPubSubMessage } from '@hookpilot/shared';
import { API_URL } from '../api/client.js';
import { useAuthStore } from '../store/auth.store.js';
import { useWorkspaceStore } from '../store/workspace.store.js';

type RealtimeListener = (event: EventPubSubMessage) => void;

class RealtimeSocketManager {
  private socket: Socket | null = null;
  private currentWorkspaceId: string | null = null;
  private createdListeners: Set<RealtimeListener> = new Set();
  private updateListeners: Set<RealtimeListener> = new Set();
  private deliveryUpdateListeners: Set<RealtimeListener> = new Set();

  connect() {
    const token = useAuthStore.getState().accessToken;
    const workspaceId = useWorkspaceStore.getState().currentWorkspace?.id;

    if (!token) {
      this.disconnect();
      return;
    }

    if (this.socket && this.socket.connected) {
      if (workspaceId && workspaceId !== this.currentWorkspaceId) {
        this.joinWorkspace(workspaceId);
      }
      return;
    }

    this.currentWorkspaceId = workspaceId || null;

    this.socket = io(API_URL, {
      auth: {
        token,
        ...(workspaceId ? { workspaceId } : {}),
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on('connect', () => {
      if (this.currentWorkspaceId) {
        this.socket?.emit('join:workspace', { workspaceId: this.currentWorkspaceId });
      }
    });

    this.socket.on('event:created', (data: EventPubSubMessage) => {
      this.createdListeners.forEach((fn) => fn(data));
    });

    this.socket.on('event:update', (data: EventPubSubMessage) => {
      this.updateListeners.forEach((fn) => fn(data));
    });

    this.socket.on('delivery:update', (data: EventPubSubMessage) => {
      this.deliveryUpdateListeners.forEach((fn) => fn(data));
    });
  }

  joinWorkspace(workspaceId: string) {
    if (!this.socket || !this.socket.connected) {
      this.currentWorkspaceId = workspaceId;
      this.connect();
      return;
    }

    if (this.currentWorkspaceId && this.currentWorkspaceId !== workspaceId) {
      this.socket.emit('leave:workspace', { workspaceId: this.currentWorkspaceId });
    }

    this.currentWorkspaceId = workspaceId;
    this.socket.emit('join:workspace', { workspaceId });
  }

  onEventCreated(listener: RealtimeListener): () => void {
    this.createdListeners.add(listener);
    return () => {
      this.createdListeners.delete(listener);
    };
  }

  onEventUpdate(listener: RealtimeListener): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  onDeliveryUpdate(listener: RealtimeListener): () => void {
    this.deliveryUpdateListeners.add(listener);
    return () => {
      this.deliveryUpdateListeners.delete(listener);
    };
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.currentWorkspaceId = null;
  }
}

export const realtimeSocket = new RealtimeSocketManager();
