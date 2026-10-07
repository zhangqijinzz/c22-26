import type { ModuleId, RuleProject } from '../models/ruleModel';
import type { WorkspaceState } from './workspaceViewModel';

export interface WorkspacePort {
  getSnapshot(): WorkspaceState;
  commitProject(project: RuleProject, notice?: string, options?: { recheck?: boolean; undoKey?: string }): boolean;
  updateView(patch: Partial<WorkspaceState>): void;
  navigate(module: ModuleId): void;
  selectRule(ruleId?: string): void;
}
