import type { ApiResult, WorkspaceState } from "@ido/common/contracts/api";
export type {
  AdminState,
  ApiResult,
  ClientState,
  MeetingView,
  MessageView,
  PluginState,
  WorkspaceState,
} from "@ido/common/contracts/api";
export type Action = (
  path: string,
  input: Record<string, unknown>,
) => Promise<ApiResult>;
export type Invoke = (path: string, input: Record<string, unknown>) => void;
export interface WorkspaceProps {
  state: WorkspaceState;
  action: Action;
  invoke: Invoke;
  showPreview: (id: string) => void;
  readonly: boolean;
  activity: boolean;
  page: string;
  setPage: (page: string) => void;
}
